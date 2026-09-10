-- 20260910170000_crm_agent_telegram_digest.sql
--
-- The read half of the mobile control surface.
--
-- Push already works: a material recommendation becomes a `notifications` row
-- and the existing connector delivers it. What is missing is pull. The artist
-- works from a phone, and "what needs me right now" should be answerable
-- without waiting for something to happen.
--
-- This is deliberately READ ONLY. There is no command here that sends a
-- message, offers a date, requests a deposit or confirms a booking, because a
-- Telegram chat id is a weaker authentication factor than a CRM session and
-- must not carry a client-facing or financial capability. Acting on a
-- recommendation stays in the CRM, where the artist is actually signed in.
--
-- A chat id identifies a destination, never a permission. It is resolved to a
-- profile here, and the profile's real CRM access decides what comes back.

create function public.service_telegram_client_ai_digest(
  p_chat_id text,
  p_limit integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_profile uuid;
  v_items jsonb;
  v_total integer;
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
    return jsonb_build_object('status', 'empty', 'items', '[]'::jsonb, 'total', 0);
  end if;

  with visible as (
    select a.*, c.full_name, ar.display_name as artist_name
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
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'client_name', left(v.full_name, 80),
      'artist_name', left(v.artist_name, 80),
      'action_type', v.action_type,
      -- A reason is model-written text. It is bounded here and the Worker
      -- renders it as plain text, never as Telegram markup.
      'reason', left(v.reason, 300),
      'priority', v.priority,
      'created_at', v.created_at
    ) order by
      case v.priority when 'high' then 0 when 'normal' then 1 else 2 end,
      v.created_at desc), '[]'::jsonb),
    count(*)::integer
  into v_items, v_total
  from visible v;

  -- No client id, no next-action id, no chat id and no draft text. This is a
  -- list to read on a phone, not a handle to act with.
  return jsonb_build_object(
    'status', case when v_total = 0 then 'empty' else 'ready' end,
    'items', v_items,
    'total', v_total
  );
end;
$$;

revoke all on function public.service_telegram_client_ai_digest(text,integer)
  from public, anon, authenticated;
grant execute on function public.service_telegram_client_ai_digest(text,integer) to service_role;

comment on function public.service_telegram_client_ai_digest(text,integer) is
  'Read-only "what needs me" digest for one linked Telegram chat. Resolves the chat to a profile and applies that profile''s real CRM access; returns no identifier that could be used to act.';
