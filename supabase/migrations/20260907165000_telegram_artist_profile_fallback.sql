-- Unify artist lead delivery with the single profile Telegram connection.
-- Keep the existing artist-destination path first for backwards compatibility,
-- but fall back to the sole active profile destination owned by an active
-- artist membership. Ambiguity fails closed.

create or replace function public.service_resolve_telegram_destination(
  p_artist_id uuid default null,
  p_profile_id uuid default null
)
returns table(destination_id uuid, destination_kind text, chat_id text)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_candidate_count integer;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Telegram destination resolution is backend-only' using errcode = '42501';
  end if;

  if (p_artist_id is null) = (p_profile_id is null) then
    raise exception 'exactly one Telegram destination target is required'
      using errcode = '22023';
  end if;

  if p_artist_id is not null then
    return query
    select d.id, d.destination_kind, d.chat_id
    from crm_private.telegram_destinations d
    join public.artists a on a.id = d.artist_id
    where d.destination_kind = 'artist'
      and d.artist_id = p_artist_id
      and d.is_active
      and a.is_active;

    if found then
      return;
    end if;

    select count(*)::integer
      into v_candidate_count
    from crm_private.telegram_destinations d
    join public.artist_memberships m
      on m.profile_id = d.profile_id
     and m.artist_id = p_artist_id
     and m.is_active
     and m.access_level::text = 'artist'
    join public.artists a
      on a.id = m.artist_id
     and a.is_active
    where d.destination_kind = 'profile'
      and d.is_active;

    if v_candidate_count > 1 then
      raise exception 'Telegram artist profile destination is ambiguous'
        using errcode = '23514';
    end if;

    if v_candidate_count = 1 then
      -- The Worker contract intentionally remains artist-shaped. The returned
      -- UUID is still the real profile destination, so acknowledgements update
      -- the same single Telegram connection and its last_success_at evidence.
      return query
      select d.id, 'artist'::text, d.chat_id
      from crm_private.telegram_destinations d
      join public.artist_memberships m
        on m.profile_id = d.profile_id
       and m.artist_id = p_artist_id
       and m.is_active
       and m.access_level::text = 'artist'
      join public.artists a
        on a.id = m.artist_id
       and a.is_active
      where d.destination_kind = 'profile'
        and d.is_active;
    end if;

    return;
  end if;

  return query
  select d.id, d.destination_kind, d.chat_id
  from crm_private.telegram_destinations d
  join crm_private.profile_access p on p.profile_id = d.profile_id
  where d.destination_kind = 'profile'
    and d.profile_id = p_profile_id
    and d.is_active
    and p.is_active;
end;
$$;

create or replace function public.service_record_telegram_notification_result(
  p_delivery_id uuid,
  p_worker_id text,
  p_succeeded boolean,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_delivery crm_private.telegram_notification_deliveries%rowtype;
  v_destination crm_private.telegram_destinations%rowtype;
  v_attempt integer;
  v_status text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Telegram notification acknowledgement is backend-only'
      using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'Telegram worker id is invalid' using errcode = '22023';
  end if;
  if p_succeeded is null then
    raise exception 'Telegram notification result is required' using errcode = '22023';
  end if;
  if not p_succeeded and coalesce(p_error_code, '') !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'failed Telegram result requires a safe machine error code'
      using errcode = '22023';
  end if;

  select x.* into v_delivery
  from crm_private.telegram_notification_deliveries x
  where x.id = p_delivery_id
  for update;

  if not found then
    select d.* into v_destination
    from crm_private.telegram_destinations d
    where d.id = p_delivery_id
      and d.is_active
      and (
        (
          d.destination_kind = 'artist'
          and exists (
            select 1
            from public.integration_outbox o
            where o.kind = 'telegram_notification'
              and o.artist_id = d.artist_id
              and o.status = 'leased'
              and o.leased_by = p_worker_id
          )
        )
        or
        (
          d.destination_kind = 'profile'
          and exists (
            select 1
            from public.integration_outbox o
            join public.artist_memberships m
              on m.artist_id = o.artist_id
             and m.profile_id = d.profile_id
             and m.is_active
             and m.access_level::text = 'artist'
            where o.kind = 'telegram_notification'
              and o.status = 'leased'
              and o.leased_by = p_worker_id
          )
        )
      )
    for update;

    if not found then
      raise exception 'Telegram notification delivery is unavailable' using errcode = '22023';
    end if;

    update crm_private.telegram_destinations d
    set last_success_at = case when p_succeeded then now() else d.last_success_at end,
        last_error_at = case when p_succeeded then d.last_error_at else now() end,
        updated_at = now()
    where d.id = v_destination.id;

    if v_destination.destination_kind = 'profile' then
      update crm_private.profile_notification_targets t
      set last_success_at = case when p_succeeded then now() else t.last_success_at end,
          last_error_at = case when p_succeeded then t.last_error_at else now() end
      where t.profile_id = v_destination.profile_id
        and t.channel = 'telegram';
    end if;

    return jsonb_build_object(
      'delivery_id', v_destination.id,
      'delivery_kind', case
        when v_destination.destination_kind = 'profile' then 'artist_profile_registry'
        else 'artist_registry'
      end,
      'status', case when p_succeeded then 'succeeded' else 'failed' end,
      'changed', true
    );
  end if;

  if v_delivery.status = 'succeeded' and p_succeeded then
    return jsonb_build_object(
      'delivery_id', v_delivery.id,
      'status', 'succeeded',
      'attempt_count', v_delivery.attempt_count,
      'changed', false
    );
  end if;

  if v_delivery.status <> 'leased' or v_delivery.leased_by is distinct from p_worker_id then
    raise exception 'Telegram notification lease is not owned by this worker'
      using errcode = '42501';
  end if;

  v_attempt := v_delivery.attempt_count + 1;
  v_status := case
    when p_succeeded then 'succeeded'
    when v_attempt >= v_delivery.max_attempts then 'dead'
    else 'failed'
  end;

  update crm_private.telegram_notification_deliveries x
  set status = v_status,
      attempt_count = v_attempt,
      next_attempt_at = case
        when p_succeeded or v_status = 'dead' then x.next_attempt_at
        else now() + make_interval(
          secs => least((power(2, least(v_delivery.attempt_count, 7)) * 30)::integer, 3600)
        )
      end,
      leased_by = null,
      leased_at = null,
      lease_expires_at = null,
      last_error_code = case when p_succeeded then null else p_error_code end,
      updated_at = now()
  where x.id = v_delivery.id;

  update crm_private.telegram_destinations d
  set last_success_at = case when p_succeeded then now() else d.last_success_at end,
      last_error_at = case when p_succeeded then d.last_error_at else now() end,
      updated_at = now()
  where d.id = v_delivery.destination_id;

  update crm_private.profile_notification_targets t
  set last_success_at = case when p_succeeded then now() else t.last_success_at end,
      last_error_at = case when p_succeeded then t.last_error_at else now() end
  where t.profile_id = v_delivery.profile_id
    and t.channel = 'telegram';

  return jsonb_build_object(
    'delivery_id', v_delivery.id,
    'status', v_status,
    'attempt_count', v_attempt,
    'changed', true
  );
end;
$$;

revoke all on function public.service_resolve_telegram_destination(uuid, uuid) from public, anon, authenticated;
grant execute on function public.service_resolve_telegram_destination(uuid, uuid) to service_role;

revoke all on function public.service_record_telegram_notification_result(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.service_record_telegram_notification_result(uuid, text, boolean, text) to service_role;
