-- 0091_telegram_artist_delivery_observability.sql
--
-- Narrow server-only evidence for shared-bot Artist delivery. The existing
-- telegram_destinations.last_success_at / last_error_at columns already carry
-- personal delivery health, but Phase G Artist sends did not update them. That
-- made a successful legacy binding fallback indistinguishable from a successful
-- DB-registry send in production.
--
-- Keep the existing service RPC signature and privilege boundary. When its UUID
-- is a personal notification delivery it behaves exactly as before. When the
-- UUID is an active Artist destination it records registry health only while
-- this Worker owns a leased Telegram outbox row for the same Artist. No chat id
-- is returned and no browser/GPT/MCP surface is added.

create or replace function public.service_record_telegram_notification_result(
  p_delivery_id uuid,
  p_worker_id text,
  p_succeeded boolean,
  p_error_code text default null
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
    -- Artist delivery uses the destination UUID as the acknowledgement handle.
    -- A legacy fallback never calls this branch, so last_success_at becomes
    -- direct evidence that the shared-bot registry path was actually used.
    select d.* into v_destination
    from crm_private.telegram_destinations d
    where d.id = p_delivery_id
      and d.destination_kind = 'artist'
      and d.is_active
    for update;

    if not found then
      raise exception 'Telegram notification delivery is unavailable' using errcode = '22023';
    end if;

    if not exists (
      select 1
      from public.integration_outbox o
      where o.kind = 'telegram_notification'
        and o.artist_id = v_destination.artist_id
        and o.status = 'leased'
        and o.leased_by = p_worker_id
    ) then
      raise exception 'Telegram Artist delivery has no matching worker lease'
        using errcode = '42501';
    end if;

    update crm_private.telegram_destinations d
    set last_success_at = case when p_succeeded then now() else d.last_success_at end,
        last_error_at = case when p_succeeded then d.last_error_at else now() end,
        updated_at = now()
    where d.id = v_destination.id;

    return jsonb_build_object(
      'delivery_id', v_destination.id,
      'delivery_kind', 'artist_registry',
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

revoke all on function public.service_record_telegram_notification_result(uuid,text,boolean,text)
  from public, anon, authenticated, service_role;
grant execute on function public.service_record_telegram_notification_result(uuid,text,boolean,text)
  to service_role;

comment on function public.service_record_telegram_notification_result(uuid,text,boolean,text) is
  'Backend-only Telegram acknowledgement for personal notification deliveries and active shared-bot Artist registry destinations; Artist evidence requires a matching leased outbox row for the same Worker.';
