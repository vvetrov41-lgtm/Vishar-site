-- 20260910210000_crm_agent_stale_actions.sql
--
-- A stale recommendation must never be presented as current work.
--
-- THE GAP THIS CLOSES
--
-- `get_client_ai_state` already reported staleness, so the CRM read was
-- honest. The Telegram digest was not: it listed every open recommendation,
-- and a `request_deposit` written before the deposit was paid would still be
-- shown as the artist's next step. On a phone, with no brief beside it, that
-- reads as instruction rather than as a suggestion from an earlier state.
--
-- Two separate paths needed hardening, because they fail at different moments:
--
--   * the PULL path (/needsme, /today) can be stale at read time;
--   * the PUSH path can be stale at DELIVERY time, because a notification is
--     queued when a recommendation is written and delivered by a later cron
--     tick. Nothing between those two points re-checked the CRM.
--
-- WHY HIDING RATHER THAN LABELLING
--
-- A stale item marked "may be out of date" still occupies the top of a short
-- list on a phone and still has to be judged. Hiding it and queueing the
-- refresh that replaces it means the artist sees the recommendation once, in
-- its correct form, a tick later. The recommendation is not deleted: the CRM
-- read still shows it with its staleness flag, which is the surface where the
-- full context is visible.
--
-- COST
--
-- Recomputing the watermark per row would make a read scale with the digest,
-- so the digest caps its candidate set first and computes the watermark only
-- for those rows. Requeueing is bounded the same way it is everywhere else:
-- the source event is the CURRENT watermark, so a stale row that is read fifty
-- times in a minute queues one job, not fifty, and the claim then collapses
-- any backlog behind it.

create or replace function public.service_telegram_client_ai_digest(
  p_chat_id text,
  p_limit integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_profile uuid;
  v_items jsonb;
  v_total integer := 0;
  v_stale integer := 0;
  v_requeue jsonb := '[]'::jsonb;
  v_row record;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;
  if p_chat_id is null or p_chat_id !~ '^-?[0-9]{1,20}$' then
    raise exception 'invalid Telegram chat id' using errcode = '22023';
  end if;

  -- Only an active, profile-scoped destination whose owner still has the
  -- Telegram channel enabled. An artist-kind destination is a shared group
  -- chat and must never resolve to one person's CRM scope.
  select d.profile_id into v_profile
  from crm_private.telegram_destinations d
  join public.profiles p on p.id = d.profile_id and p.is_active
  join public.notification_preferences pref
    on pref.profile_id = d.profile_id and pref.channel = 'telegram' and pref.is_enabled
  where d.chat_id = p_chat_id
    and d.destination_kind = 'profile'
    and d.is_active;

  -- An unknown chat gets the same answer as a known one with nothing to do.
  -- Whether a chat is linked is not something an unauthenticated sender may
  -- probe by messaging the bot.
  if not found then
    return jsonb_build_object('status', 'empty', 'items', '[]'::jsonb, 'total', 0, 'refreshing', 0);
  end if;

  -- One pass. The candidate set is bounded FIRST, so the cost of this read
  -- does not grow with the number of open recommendations, and the watermark
  -- is computed once per candidate rather than once per comparison.
  --
  -- A temporary table is deliberately not used here: creating one inside a
  -- SECURITY DEFINER function puts it in the caller's temp schema, which is
  -- not in this function's fixed search_path and is not state a read should
  -- own. A CTE is bounded by the same limit and carries no such baggage.
  with candidates as (
    select a.id, a.artist_id, a.client_id, a.action_type, a.priority,
           a.created_at, a.source_watermark,
           left(c.full_name, 80) as client_name,
           left(ar.display_name, 80) as artist_name,
           left(a.reason, 300) as reason
    from public.client_ai_next_actions a
    join public.artists ar on ar.id = a.artist_id and ar.is_active
    join public.clients c on c.id = a.client_id and c.archived_at is null
    where a.status = 'open'
      and a.action_type not in ('no_action', 'await_client')
      -- The profile's real access decides visibility, not the membership label
      -- and not the fact that a chat is linked.
      and crm_private.profile_can_receive_notification(v_profile, a.artist_id, ar.workspace_id)
      and exists (
        select 1 from public.artist_memberships am
        where am.artist_id = a.artist_id and am.profile_id = v_profile and am.is_active
      )
      and crm_private.client_ai_scope(a.artist_id, a.client_id) is not null
    order by
      case a.priority when 'high' then 0 when 'normal' then 1 else 2 end,
      a.created_at desc
    limit least(greatest(coalesce(p_limit, 10), 1), 20)
  ),
  measured as (
    select k.*,
           crm_private.client_ai_watermark(k.artist_id, k.client_id) as current_watermark
    from candidates k
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'client_name', m.client_name,
      'artist_name', m.artist_name,
      'action_type', m.action_type,
      -- A reason is model-written text. It is bounded here and the Worker
      -- renders it as plain text, never as Telegram markup.
      'reason', m.reason,
      'priority', m.priority,
      'created_at', m.created_at
    ) order by
      case m.priority when 'high' then 0 when 'normal' then 1 else 2 end,
      m.created_at desc) filter (where m.current_watermark is not distinct from m.source_watermark),
      '[]'::jsonb),
    count(*) filter (where m.current_watermark is not distinct from m.source_watermark)::integer,
    count(*) filter (where m.current_watermark is distinct from m.source_watermark)::integer,
    coalesce(jsonb_agg(jsonb_build_array(m.artist_id, m.client_id, m.current_watermark))
      filter (where m.current_watermark is distinct from m.source_watermark), '[]'::jsonb)
  into v_items, v_total, v_stale, v_requeue
  from measured m;

  -- A stale row is withheld and its replacement queued, so the artist sees the
  -- recommendation once, correct, on a later tick. Keyed on the CURRENT
  -- watermark, so reading the same stale row fifty times queues one job.
  for v_row in select * from jsonb_array_elements(v_requeue) loop
    begin
      perform crm_private.schedule_client_ai_refresh(
        (v_row.value->>0)::uuid,
        (v_row.value->>1)::uuid,
        'stale:' || left(v_row.value->>2, 32));
    exception when others then null;
    end;
  end loop;

  -- No client id, no next-action id, no chat id and no draft text. This is a
  -- list to read on a phone, not a handle to act with. `refreshing` lets the
  -- Worker say that something is being recomputed rather than implying the
  -- artist has nothing waiting.
  return jsonb_build_object(
    'status', case when v_total = 0 then 'empty' else 'ready' end,
    'items', v_items,
    'total', v_total,
    'refreshing', v_stale
  );
end;
$$;

comment on function public.service_telegram_client_ai_digest(text,integer) is
  'Read-only "what needs me" digest for one linked Telegram chat. Withholds recommendations whose watermark no longer matches the CRM and queues their replacement, so a stale suggestion is never shown as current work.';

-- ---------------------------------------------------------------------------
-- The push path
--
-- A notification is queued when a recommendation is written and delivered by a
-- later scheduler tick. The CRM can move between those two moments, and until
-- now nothing re-checked it: a deposit paid in that window still produced a
-- "request a deposit" push.
--
-- The fix is to withdraw the push when its recommendation stops being current.
-- `crm_private.profile_can_receive_notification` is deliberately NOT the place
-- for this: it is the shared access predicate for every notification type in
-- the CRM, and teaching it about one feature's staleness would change delivery
-- for follow-ups, lifecycle alerts and enquiries too.
--
-- A notification is withdrawn only while it is still undeliverable-from: once
-- the connector has created a delivery row the message is in flight or already
-- sent, and deleting it would rewrite delivery history rather than prevent a
-- delivery. That is the same rule the enquiry outbox recovery path applies.
-- ---------------------------------------------------------------------------

create function crm_private.withdraw_client_ai_notifications(p_next_action_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_count integer := 0;
begin
  delete from public.notifications n
  where n.notification_type = 'client_ai.next_action'
    and n.dedupe_key like 'client_ai_next_action:' || p_next_action_id::text || ':%'
    and n.status = 'pending'
    and n.delivered_at is null
    -- Nothing has been handed to the connector yet. If a delivery row exists,
    -- the push is in flight or already sent and its record must stand.
    and not exists (
      select 1 from crm_private.telegram_notification_deliveries d
      where d.notification_id = n.id
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function crm_private.withdraw_client_ai_notifications(uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.withdraw_client_ai_notifications(uuid) is
  'Withdraws an undelivered push for a recommendation that is no longer current. Leaves anything the Telegram connector has already claimed alone, so delivery history is never rewritten.';

-- Supersede and resolve both route through here, so a recommendation can never
-- leave `open` while a push for it is still waiting to be sent.
create function crm_private.withdraw_superseded_client_ai_notifications()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if old.status = 'open' and new.status <> 'open' then
    perform crm_private.withdraw_client_ai_notifications(new.id);
  end if;
  return null;
end;
$$;

revoke all on function crm_private.withdraw_superseded_client_ai_notifications()
  from public, anon, authenticated, service_role;

create trigger client_ai_next_actions_withdraw_notifications
  after update of status on public.client_ai_next_actions
  for each row execute function crm_private.withdraw_superseded_client_ai_notifications();
