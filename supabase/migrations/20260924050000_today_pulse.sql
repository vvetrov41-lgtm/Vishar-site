-- 20260924050000_today_pulse.sql
--
-- Phase 4 of the CRM AI architecture: one server-side answer to "what needs
-- me today".
--
-- CRM Today computed its list in the browser (admin/src/lib/today-workspace.ts)
-- while Telegram /today read AI next actions: two truths for one question.
-- `crm_private.pulse_items` is now the single source. The CRM calls
-- `get_today_pulse` under the operator's own capabilities; Telegram calls
-- `service_telegram_today_pulse` for the linked operator profile. For the same
-- artist both return the same non-financial items in the same order.
--
-- The operational rows port the browser rules one for one (same kinds, same
-- keys, same acknowledgement references), so switching Today to the server is
-- a change of engine and not of meaning. On top of them the Phase 2
-- deterministic attention layer adds what the browser could not see:
-- contradictory facts, clients who went quiet, and unknown senders.
--
-- Every item says WHY it is there (`reason`, a rule code). An open AI next
-- action can ride along as a labelled `ai_suggestion`; it is never the reason
-- an item exists. Nothing here writes: acknowledging and resolving keep using
-- `acknowledge_attention_item` and `resolve_client_ai_next_action`.
--
-- Whether CRM Today renders these items is `crm_agent_config.today_pulse`
-- (default false). Telegram /today switches with the Worker variable
-- CRM_TODAY_PULSE_ENABLED. Both default to the existing behaviour.

alter table crm_private.crm_agent_config
  add column today_pulse boolean not null default false;

comment on column crm_private.crm_agent_config.today_pulse is
  'When true, CRM Today renders the server-side pulse (get_today_pulse) instead of computing its list in the browser.';

create function crm_private.pulse_rank(p_kind text)
returns integer
language sql
immutable
set search_path = pg_catalog
as $$
  select case p_kind
    when 'reschedule_requested' then 10
    when 'reply' then 20
    when 'email_send_failed' then 30
    when 'email_draft_to_approve' then 35
    when 'conflict' then 40
    when 'payment_to_confirm' then 45
    when 'unconfirmed_appointment' then 50
    when 'deposit_outstanding' then 55
    when 'new_enquiry' then 60
    when 'unmatched_inbound' then 65
    when 'overdue_follow_up' then 70
    when 'client_follow_up_due' then 75
    when 'client_cold' then 80
    when 'integration_failure' then 95
    else 99
  end;
$$;

create function crm_private.pulse_section(p_kind text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when p_kind = 'unmatched_inbound' then 'inbox'
    when p_kind = 'conflict' then 'conflicts'
    when p_kind in ('client_follow_up_due', 'client_cold') then 'waiting_on_clients'
    when p_kind = 'integration_failure' then 'system'
    else 'waiting_for_you'
  end;
$$;

-- Clients with anything live for this artist: the population attention runs on.
create function crm_private.pulse_active_clients(p_artist_id uuid)
returns table (client_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select distinct x.client_id from (
    select e.client_id from public.enquiries e
    where e.artist_id = p_artist_id and e.archived_at is null
      and e.status not in ('declined', 'closed')
    union all
    select p.client_id from public.projects p
    where p.artist_id = p_artist_id and p.archived_at is null and p.status in ('draft', 'active', 'on_hold')
    union all
    select s.client_id from public.sessions s
    where s.artist_id = p_artist_id and s.cancelled_at is null and s.end_at >= clock_timestamp() - interval '60 days'
    union all
    select c.client_id from public.communication_conversations c
    where c.artist_id = p_artist_id and c.client_id is not null and c.state = 'open'
  ) x
  join public.clients cl on cl.id = x.client_id and cl.archived_at is null
  where x.client_id is not null;
$$;

create function crm_private.pulse_items(
  p_artist_id uuid,
  p_include_finance boolean,
  p_include_integrations boolean,
  p_now timestamptz default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with now_ as (select coalesce(p_now, clock_timestamp()) as t),
  acks as (
    select a.item_kind, a.entity_id, a.observed_at
    from public.attention_acknowledgements a where a.artist_id = p_artist_id
  ),
  att as (
    select ac.client_id, crm_private.client_attention(p_artist_id, ac.client_id, (select t from now_)) as a
    from crm_private.pulse_active_clients(p_artist_id) ac
  ),
  live_sessions as (
    select s.* from public.sessions s
    where s.artist_id = p_artist_id and s.cancelled_at is null
      and s.status in ('draft', 'proposed', 'confirmed')
  ),
  conv as (
    select c.*, latest.direction as latest_direction
    from public.communication_conversations c
    left join lateral (
      select m.direction from public.communication_messages m
      where m.conversation_id = c.id
      order by m.created_at desc, m.id desc limit 1
    ) latest on true
    where c.artist_id = p_artist_id
  ),
  -- Email grouped the way the Inbox groups it: one row per real conversation.
  email_threads as (
    select
      case when m.enquiry_id is not null then 'enquiry-' || m.enquiry_id
           when m.client_id is not null then 'client-' || m.client_id
           else 'message-' || m.id end as thread_key,
      m.*
    from public.email_messages m
    where m.artist_id = p_artist_id
  ),
  email_thread_state as (
    select t.thread_key,
      bool_or(t.status = 'failed') as send_failed,
      bool_or(t.status = 'draft' and t.created_by_kind = 'human') as awaiting_approval,
      max(t.created_at) as last_activity_at,
      (array_agg(t.subject order by t.created_at desc, t.id desc))[1] as subject,
      (array_agg(t.client_id order by t.created_at desc, t.id desc))[1] as client_id,
      (array_agg(t.to_email order by t.created_at desc, t.id desc))[1] as to_email
    from email_threads t
    where t.thread_key not like 'message-%'
    group by t.thread_key
  ),
  raw as (
    -- A client asking to move a booked time.
    select 'reschedule_requested'::text as kind, 'reschedule-' || s.id as key, s.client_id,
           null::text as subject, '/appointments/' || s.id as href, s.start_at as at, null::text as detail,
           'client_asked_to_reschedule'::text as reason, null::jsonb as ack
    from live_sessions s
    where s.client_response = 'reschedule_requested' and s.start_at >= (select t from now_)

    union all
    -- Linked conversation whose newest message is the client's.
    select 'reply', 'reply-' || c.id, c.client_id,
           coalesce(c.external_display_label, c.external_username),
           '/inbox/' || c.id, coalesce(c.last_inbound_at, c.last_message_at), c.channel::text,
           'client_message_unanswered',
           case when c.last_inbound_at is not null then
             jsonb_build_object('kind', 'conversation_reply', 'entity_id', c.id, 'observed_at', c.last_inbound_at)
           end
    from conv c
    where c.state = 'open' and c.latest_direction = 'inbound'
      and (c.client_id is not null or c.enquiry_id is not null)

    union all
    -- A known client whose newest Gmail message is inbound.
    select 'reply', 'gmail-' || g.client_id, g.client_id, null,
           '/inbox/email/client-' || g.client_id, g.last_message_at, left(g.subject, 120),
           'client_email_unanswered',
           case when g.last_message_at is not null then
             jsonb_build_object('kind', 'gmail_reply', 'entity_id', g.client_id, 'observed_at', g.last_message_at)
           end
    from public.gmail_client_metadata_snapshots g
    where g.artist_id = p_artist_id and g.direction = 'inbound'

    union all
    -- Email the CRM failed to send or a person drafted and nobody approved.
    select case when e.send_failed then 'email_send_failed' else 'email_draft_to_approve' end,
           'email-' || e.thread_key, e.client_id, left(e.to_email, 120),
           '/inbox/email/' || e.thread_key, e.last_activity_at, left(e.subject, 120),
           case when e.send_failed then 'email_not_delivered' else 'email_awaiting_approval' end, null
    from email_thread_state e
    where e.send_failed or e.awaiting_approval

    union all
    -- Contradictory authoritative facts (Phase 2 detectors).
    select 'conflict', 'conflict-' || at.client_id || '-' || code, at.client_id, null,
           '/clients/' || at.client_id, null, code, code, null
    from att at, jsonb_array_elements_text(at.a -> 'conflicts') code
    where code <> 'ai_brief_stale'

    union all
    -- Money that landed and only needs agreeing with.
    select 'payment_to_confirm', 'payment-' || r.id, pr.client_id, null, '/payments', r.occurred_at,
           r.amount::text || ' ' || r.currency, 'payment_received_unconfirmed', null
    from public.payment_reconciliation_candidates r
    join public.payment_requests pr
      on pr.id = coalesce(r.matched_payment_request_id, r.suggested_payment_request_id)
    where p_include_finance and r.artist_id = p_artist_id
      and r.provider = 'monzo_easy_bank_transfer'
      and r.status in ('matched', 'candidate')
      and not exists (select 1 from public.payment_transactions t
                      where t.provider = r.provider and t.provider_transaction_id = r.provider_transaction_id
                        and t.status = 'succeeded')

    union all
    -- A proposed appointment nobody confirmed.
    select 'unconfirmed_appointment', 'unconfirmed-' || s.id, s.client_id, null, '/appointments/' || s.id,
           s.start_at, null, 'appointment_not_confirmed', null
    from live_sessions s
    where s.status in ('draft', 'proposed') and s.start_at >= (select t from now_)

    union all
    -- A booked session whose deposit is outstanding. A merely requested
    -- deposit waits until the session is within the week ahead.
    select 'deposit_outstanding', 'deposit-' || p.id, p.client_id, null, '/projects/' || p.id, nxt.start_at,
           p.deposit_status::text, 'deposit_not_received_for_booking',
           jsonb_build_object('kind', 'deposit_outstanding', 'entity_id', p.id, 'observed_at', p.updated_at)
    from public.projects p
    join lateral (
      select min(s.start_at) as start_at from live_sessions s
      where s.project_id = p.id and s.start_at >= (select t from now_)
    ) nxt on nxt.start_at is not null
    where p.artist_id = p_artist_id
      and p.deposit_status not in ('paid', 'not_required')
      and (p.deposit_status <> 'requested' or nxt.start_at < (select t from now_) + interval '8 days')

    union all
    -- A new enquiry nobody has engaged with yet.
    select 'new_enquiry', 'enquiry-' || e.id, e.client_id, null, '/enquiries/' || e.id, e.created_at,
           e.project_type, 'new_enquiry_untouched',
           jsonb_build_object('kind', 'new_enquiry', 'entity_id', e.id, 'observed_at', e.created_at)
    from public.enquiries e
    where e.artist_id = p_artist_id and e.archived_at is null and e.status = 'new'
      and e.intake_state = 'complete'
      and not exists (select 1 from public.projects p where p.enquiry_id = e.id)
      and not exists (select 1 from public.sessions s where s.enquiry_id = e.id)
      and not exists (select 1 from conv c
                      where (c.enquiry_id = e.id or c.client_id = e.client_id)
                        and c.last_message_at >= e.created_at)
      and not exists (select 1 from public.gmail_client_metadata_snapshots g
                      where g.artist_id = p_artist_id and g.client_id = e.client_id
                        and g.last_message_at >= e.created_at)
      and not exists (select 1 from email_thread_state ts
                      where ts.thread_key in ('enquiry-' || e.id, 'client-' || e.client_id)
                        and ts.last_activity_at >= e.created_at
                        and exists (select 1 from email_threads m
                                    where m.thread_key = ts.thread_key
                                      and (m.created_by_kind = 'human'
                                           or m.status in ('approved', 'queued', 'sent', 'failed'))))

    union all
    -- Messages from somebody the CRM cannot name yet, as one row. Deciding
    -- who they are is Inbox work (Phase 5); Today only says it is waiting.
    select 'unmatched_inbound', 'unmatched-inbound', null, null, '/inbox?view=unmatched',
           max(c.last_inbound_at), count(*)::text, 'unknown_sender_unanswered', null
    from conv c
    where c.state = 'open' and c.client_id is null and c.enquiry_id is null
      and c.latest_direction = 'inbound'
    having count(*) > 0

    union all
    -- Operator follow-ups past due.
    select 'overdue_follow_up', 'follow-up-' || f.id, f.client_id, left(f.subject, 120),
           case when f.enquiry_id is not null then '/enquiries/' || f.enquiry_id
                when f.project_id is not null then '/projects/' || f.project_id
                when f.client_id is not null then '/clients/' || f.client_id end,
           f.due_at, null, 'follow_up_overdue', null
    from public.follow_ups f
    where f.artist_id = p_artist_id and f.status = 'open' and f.due_at < (select t from now_)

    union all
    -- The studio spoke last and the client went quiet (Phase 2 SLA).
    select case when at.a ->> 'sla_state' = 'cold' then 'client_cold' else 'client_follow_up_due' end,
           'silent-' || at.client_id, at.client_id, null, '/clients/' || at.client_id,
           (at.a ->> 'last_outbound_at')::timestamptz, at.a ->> 'workflow_stage', at.a ->> 'sla_reason', null
    from att at
    where at.a ->> 'sla_reason' in ('client_follow_up_due', 'client_silent')

    union all
    -- Integration failures, grouped: the detail belongs on the integrations screen.
    select 'integration_failure', 'integration-failures', null, null, '/integrations', null,
           count(*)::text, 'integration_jobs_failed', null
    from public.integration_outbox o
    where p_include_integrations and o.artist_id = p_artist_id and o.status in ('failed', 'dead')
    having count(*) > 0
  ),
  visible as (
    select r.* from raw r
    where r.ack is null
       or not exists (select 1 from acks k
                      where k.item_kind = r.ack ->> 'kind'
                        and k.entity_id = (r.ack ->> 'entity_id')::uuid
                        and k.observed_at >= (r.ack ->> 'observed_at')::timestamptz)
  ),
  ranked as (
    select r.*, crm_private.pulse_rank(r.kind) as rank,
      -- Consequence: a booked or paying client's delay outranks a lead's.
      case when (at.a ->> 'workflow_stage') in ('booked', 'scheduling', 'deposit_pending') then 0 else 1 end as tier,
      (select jsonb_build_object('id', n.id, 'action_type', n.action_type, 'reason', left(n.reason, 300))
       from public.client_ai_next_actions n
       where n.artist_id = p_artist_id and n.client_id = r.client_id and n.status = 'open'
       order by n.created_at desc limit 1) as ai_suggestion,
      at.a ->> 'sla_state' as sla_state
    from visible r
    left join att at on at.client_id = r.client_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', r.key, 'kind', r.kind, 'section', crm_private.pulse_section(r.kind), 'reason', r.reason,
    'artist_id', p_artist_id, 'client_id', r.client_id,
    'subject', coalesce(left(c.full_name, 80), r.subject),
    'href', r.href, 'at', r.at, 'detail', r.detail, 'sla_state', r.sla_state,
    'ai_suggestion', r.ai_suggestion, 'acknowledgement', r.ack,
    'rank', r.rank, 'tier', r.tier,
    'urgent', r.rank <= 35 or r.sla_state = 'overdue'
  ) order by r.rank, r.tier, r.at nulls last, r.key), '[]'::jsonb)
  from ranked r
  left join public.clients c on c.id = r.client_id;
$$;

-- "What changed since yesterday", the two speed numbers, and which sources
-- could be read. An unavailable source is reported, never shown as zero.
create function crm_private.pulse_summary(p_artist_id uuid, p_now timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with t as (select coalesce(p_now, clock_timestamp()) as now_,
                    coalesce(p_now, clock_timestamp()) - interval '24 hours' as since),
  recent_enquiries as (
    select e.id, e.client_id, e.created_at from public.enquiries e, t
    where e.artist_id = p_artist_id and e.archived_at is null and e.intake_state = 'complete'
      and e.created_at >= t.now_ - interval '30 days'
  ),
  first_reply as (
    select re.id, re.created_at, least(
      (select min(coalesce(m.provider_timestamp, m.created_at))
       from public.communication_messages m
       join public.communication_conversations c on c.id = m.conversation_id
       where m.direction = 'outbound' and c.artist_id = p_artist_id
         and (c.enquiry_id = re.id or c.client_id = re.client_id)
         and coalesce(m.provider_timestamp, m.created_at) >= re.created_at),
      (select min(em.sent_at) from public.email_messages em
       where em.artist_id = p_artist_id and (em.enquiry_id = re.id or em.client_id = re.client_id)
         and em.sent_at >= re.created_at)
    ) as replied_at
    from recent_enquiries re
  ),
  snap as (
    select max(g.refreshed_at) as refreshed_at from public.gmail_client_metadata_snapshots g
    where g.artist_id = p_artist_id
  )
  select jsonb_build_object(
    'changes', jsonb_build_object(
      'new_enquiries', (select count(*) from public.enquiries e, t
                        where e.artist_id = p_artist_id and e.created_at >= t.since
                          and e.archived_at is null and e.intake_state = 'complete'),
      'inbound_messages', (select count(*) from public.communication_messages m, t
                           where m.artist_id = p_artist_id and m.direction = 'inbound'
                             and coalesce(m.provider_timestamp, m.created_at) >= t.since),
      'sessions_booked', (select count(*) from public.sessions s, t
                          where s.artist_id = p_artist_id and s.created_at >= t.since and s.cancelled_at is null),
      'payments_received', (select count(*) from public.payment_transactions pt, t
                            where pt.artist_id = p_artist_id and pt.status = 'succeeded'
                              and pt.direction = 'credit' and pt.occurred_at >= t.since)
    ),
    'median_first_reply_hours', (
      select round((percentile_cont(0.5) within group (
        order by extract(epoch from fr.replied_at - fr.created_at)) / 3600)::numeric, 1)
      from first_reply fr where fr.replied_at is not null),
    'enquiries_without_reply_30d', (select count(*) from first_reply fr where fr.replied_at is null),
    'sources', jsonb_build_object(
      'gmail_snapshot', case
        when (select refreshed_at from snap) is null then 'unavailable'
        when (select refreshed_at from snap) < (select now_ from t) - interval '24 hours' then 'stale'
        else 'fresh' end,
      'gmail_refreshed_at', (select refreshed_at from snap)
    )
  );
$$;

-- Items from several artists are merged into one consequence order.
create function crm_private.pulse_merge(p_items jsonb)
returns jsonb
language sql
immutable
set search_path = pg_catalog
as $$
  select coalesce(jsonb_agg(i order by (i ->> 'rank')::integer, (i ->> 'tier')::integer,
                            (i ->> 'at')::timestamptz nulls last, i ->> 'key', i ->> 'artist_id'), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) i;
$$;

revoke all on function crm_private.pulse_rank(text) from public, anon, authenticated, service_role;
revoke all on function crm_private.pulse_section(text) from public, anon, authenticated, service_role;
revoke all on function crm_private.pulse_active_clients(uuid) from public, anon, authenticated, service_role;
revoke all on function crm_private.pulse_items(uuid, boolean, boolean, timestamptz) from public, anon, authenticated, service_role;
revoke all on function crm_private.pulse_summary(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function crm_private.pulse_merge(jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- CRM: the operator's own capabilities decide what they see.
-- ---------------------------------------------------------------------------

create function public.get_today_pulse(p_artist_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_items jsonb := '[]'::jsonb;
  v_artists jsonb := '[]'::jsonb;
  v_artist record;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_artist_id is not null then
    perform crm_private.require_artist_access(p_artist_id, 'view_clients');
  end if;

  for v_artist in
    select a.id, left(a.display_name, 80) as name from public.artists a
    where a.is_active and (p_artist_id is null or a.id = p_artist_id)
      and crm_private.has_artist_capability(a.id, 'view_clients')
    order by a.display_name, a.id
  loop
    v_items := v_items || crm_private.pulse_items(
      v_artist.id,
      crm_private.has_artist_capability(v_artist.id, 'manage_finance'),
      crm_private.has_artist_capability(v_artist.id, 'view_integrations'));
    v_artists := v_artists || jsonb_build_array(
      jsonb_build_object('artist_id', v_artist.id, 'artist_name', v_artist.name)
      || crm_private.pulse_summary(v_artist.id));
  end loop;

  return jsonb_build_object(
    'generated_at', clock_timestamp(),
    'enabled', coalesce((select c.today_pulse from crm_private.crm_agent_config c where c.singleton), false),
    'items', crm_private.pulse_merge(v_items),
    'artists', v_artists
  );
end;
$$;

revoke all on function public.get_today_pulse(uuid) from public, anon, service_role;
grant execute on function public.get_today_pulse(uuid) to authenticated;

comment on function public.get_today_pulse(uuid) is
  'Read-only Today pulse for the signed-in operator: items ranked by consequence, each with a rule reason, plus per-artist changes, reply speed and source availability.';

-- ---------------------------------------------------------------------------
-- Telegram: the same items for the operator linked to this chat. Read-only.
-- ---------------------------------------------------------------------------

create function public.service_telegram_today_pulse(p_chat_id text, p_limit integer default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_profile uuid;
  v_items jsonb := '[]'::jsonb;
  v_artist record;
  v_total integer;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;
  if p_chat_id is null or p_chat_id !~ '^-?[0-9]{1,20}$' then
    raise exception 'invalid Telegram chat id' using errcode = '22023';
  end if;

  select d.profile_id into v_profile
  from crm_private.telegram_destinations d
  join public.profiles p on p.id = d.profile_id and p.is_active
  join public.notification_preferences pref
    on pref.profile_id = d.profile_id and pref.channel = 'telegram' and pref.is_enabled
  where d.chat_id = p_chat_id and d.destination_kind = 'profile' and d.is_active;

  if not found then
    return jsonb_build_object('status', 'empty', 'items', '[]'::jsonb, 'total', 0);
  end if;

  for v_artist in
    select a.id from public.artists a
    where a.is_active
      and crm_private.profile_can_receive_notification(v_profile, a.id, a.workspace_id)
      and exists (select 1 from public.artist_memberships am
                  where am.artist_id = a.id and am.profile_id = v_profile and am.is_active)
    order by a.display_name, a.id
  loop
    -- Telegram never shows money or integration internals: a chat id is a
    -- weaker factor than a signed-in CRM session.
    v_items := v_items || crm_private.pulse_items(v_artist.id, false, false);
  end loop;

  v_items := crm_private.pulse_merge(v_items);
  v_total := jsonb_array_length(v_items);
  return jsonb_build_object(
    'status', case when v_total = 0 then 'empty' else 'ok' end,
    'total', v_total,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', i ->> 'key', 'kind', i ->> 'kind', 'section', i ->> 'section', 'reason', i ->> 'reason',
        'subject', i ->> 'subject', 'detail', i ->> 'detail', 'at', i -> 'at',
        'urgent', i -> 'urgent', 'sla_state', i ->> 'sla_state') order by o)
      from jsonb_array_elements(v_items) with ordinality e(i, o)
      where o <= least(greatest(coalesce(p_limit, 10), 1), 20)
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.service_telegram_today_pulse(text, integer) from public, anon, authenticated;
grant execute on function public.service_telegram_today_pulse(text, integer) to service_role;

comment on function public.service_telegram_today_pulse(text, integer) is
  'Backend-only Telegram /today: the pulse items for the linked operator, without finance or integration rows and without AI suggestions.';
