-- Keep the Telegram digest convergent after a stale request_information action
-- has already been auto-closed by an authoritative booking/reference fact.
-- Closed actions stay hidden. A stale derived client state with no current open
-- recommendation is counted only as "refreshing" and schedules one deduped
-- refresh keyed by the live watermark.

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
  v_state_stale integer := 0;
  v_state_requeue jsonb := '[]'::jsonb;
  v_row record;
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
    on pref.profile_id = d.profile_id
   and pref.channel = 'telegram'
   and pref.is_enabled
  where d.chat_id = p_chat_id
    and d.destination_kind = 'profile'
    and d.is_active;

  if not found then
    return jsonb_build_object(
      'status', 'empty', 'items', '[]'::jsonb, 'total', 0, 'refreshing', 0
    );
  end if;

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
      and crm_private.profile_can_receive_notification(
        v_profile, a.artist_id, ar.workspace_id
      )
      and exists (
        select 1
        from public.artist_memberships am
        where am.artist_id = a.artist_id
          and am.profile_id = v_profile
          and am.is_active
      )
      and crm_private.client_ai_scope(a.artist_id, a.client_id) is not null
    order by
      case a.priority when 'high' then 0 when 'normal' then 1 else 2 end,
      a.created_at desc
    limit least(greatest(coalesce(p_limit, 10), 1), 20)
  ), measured as (
    select k.*,
           crm_private.client_ai_watermark(k.artist_id, k.client_id) as current_watermark
    from candidates k
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'client_name', m.client_name,
      'artist_name', m.artist_name,
      'action_type', m.action_type,
      'reason', m.reason,
      'priority', m.priority,
      'created_at', m.created_at
    ) order by
      case m.priority when 'high' then 0 when 'normal' then 1 else 2 end,
      m.created_at desc) filter (
        where m.current_watermark is not distinct from m.source_watermark
      ), '[]'::jsonb),
    count(*) filter (
      where m.current_watermark is not distinct from m.source_watermark
    )::integer,
    count(*) filter (
      where m.current_watermark is distinct from m.source_watermark
    )::integer,
    coalesce(jsonb_agg(jsonb_build_array(
      m.artist_id, m.client_id, m.current_watermark
    )) filter (
      where m.current_watermark is distinct from m.source_watermark
    ), '[]'::jsonb)
  into v_items, v_total, v_stale, v_requeue
  from measured m;

  -- An authoritative booking/reference mutation may have already superseded
  -- the old request_information before this read. The action must remain hidden,
  -- but its stale client state still needs the same bounded self-heal path.
  with state_candidates as (
    select st.artist_id, st.client_id, st.source_watermark,
           st.refreshed_at, ar.workspace_id
    from public.client_ai_state st
    join public.artists ar on ar.id = st.artist_id and ar.is_active
    join public.clients c on c.id = st.client_id and c.archived_at is null
    where crm_private.profile_can_receive_notification(
        v_profile, st.artist_id, ar.workspace_id
      )
      and exists (
        select 1
        from public.artist_memberships am
        where am.artist_id = st.artist_id
          and am.profile_id = v_profile
          and am.is_active
      )
      and crm_private.client_ai_scope(st.artist_id, st.client_id) is not null
      and not exists (
        select 1
        from public.client_ai_next_actions a
        where a.artist_id = st.artist_id
          and a.client_id = st.client_id
          and a.status = 'open'
          and a.action_type not in ('no_action', 'await_client')
      )
    order by st.refreshed_at desc
    limit least(greatest(coalesce(p_limit, 10), 1), 20)
  ), measured_states as (
    select s.*,
           crm_private.client_ai_watermark(s.artist_id, s.client_id) as current_watermark
    from state_candidates s
  )
  select
    count(*)::integer,
    coalesce(jsonb_agg(jsonb_build_array(
      s.artist_id, s.client_id, s.current_watermark
    )), '[]'::jsonb)
  into v_state_stale, v_state_requeue
  from measured_states s
  where s.current_watermark is distinct from s.source_watermark;

  v_stale := v_stale + coalesce(v_state_stale, 0);
  v_requeue := v_requeue || coalesce(v_state_requeue, '[]'::jsonb);

  for v_row in select * from jsonb_array_elements(v_requeue) loop
    begin
      perform crm_private.schedule_client_ai_refresh(
        (v_row.value->>0)::uuid,
        (v_row.value->>1)::uuid,
        'stale:' || left(v_row.value->>2, 32)
      );
    exception when others then null;
    end;
  end loop;

  return jsonb_build_object(
    'status', case when v_total = 0 then 'empty' else 'ready' end,
    'items', v_items,
    'total', v_total,
    'refreshing', v_stale
  );
end;
$$;

comment on function public.service_telegram_client_ai_digest(text,integer) is
  'Read-only Telegram needs-me digest. Hides stale/closed recommendations and self-heals both stale open actions and stale derived client state after authoritative booking/reference guards close an action.';
