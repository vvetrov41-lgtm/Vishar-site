-- 0035_telegram_outbox_exact_id_drain.sql
--
-- Exact-ID leasing and acknowledgement for one artist-routed Telegram job.
-- This deliberately does not add a queue scan, a LIMIT selector or a cron.
-- The immediate post-finalisation record_outbox_attempt path remains intact.
--
-- Forward-only. No provider call or hosted runtime is enabled here.

create or replace function public.claim_telegram_outbox_by_id(
  p_outbox_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 120
)
returns table (
  outbox_id uuid,
  artist_id uuid,
  kind public.outbox_kind,
  enquiry_id uuid,
  attempt_count integer,
  max_attempts integer,
  reference_number text,
  file_count integer,
  client_conflict boolean,
  job_valid boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Telegram outbox leasing is backend-only'
      using errcode = '42501';
  end if;

  if p_outbox_id is null then
    raise exception 'Telegram outbox id is required'
      using errcode = '22023';
  end if;

  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'Telegram worker id is invalid'
      using errcode = '22023';
  end if;

  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'Telegram lease must be between 30 and 600 seconds'
      using errcode = '22023';
  end if;

  return query
  with leased as (
    update public.integration_outbox o
    set status = 'leased',
        leased_by = p_worker_id,
        leased_at = now(),
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        updated_at = now()
    where o.id = p_outbox_id
      and o.kind = 'telegram_notification'
      and (
        (o.status in ('pending', 'failed') and o.next_attempt_at <= now())
        or (o.status = 'leased' and o.lease_expires_at <= now())
      )
    returning o.*
  ),
  projected as (
    select
      l.id,
      l.artist_id,
      l.kind,
      l.enquiry_id,
      l.client_id,
      l.attempt_count,
      l.max_attempts,
      e.id as enquiry_row_id,
      e.artist_id as enquiry_artist_id,
      e.client_id as enquiry_client_id,
      e.reference_number,
      e.client_identifier_conflict,
      e.intake_state,
      count(f.id)::integer as authoritative_file_count,
      count(f.id) filter (where f.upload_state <> 'ready')::integer as unready_file_count
    from leased l
    left join public.enquiries e on e.id = l.enquiry_id
    left join public.enquiry_files f on f.enquiry_id = e.id
    group by
      l.id, l.artist_id, l.kind, l.enquiry_id, l.client_id,
      l.attempt_count, l.max_attempts,
      e.id, e.artist_id, e.client_id, e.reference_number,
      e.client_identifier_conflict, e.intake_state
  )
  select
    p.id,
    p.artist_id,
    p.kind,
    p.enquiry_id,
    p.attempt_count,
    p.max_attempts,
    p.reference_number,
    p.authoritative_file_count,
    p.client_identifier_conflict,
    (
      p.enquiry_row_id is not null
      and p.enquiry_id = p.enquiry_row_id
      and p.artist_id = p.enquiry_artist_id
      and p.client_id = p.enquiry_client_id
      and p.intake_state = 'complete'
      and p.authoritative_file_count > 0
      and p.unready_file_count = 0
    ) as job_valid
  from projected p;
end;
$$;

revoke all on function public.claim_telegram_outbox_by_id(uuid,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_telegram_outbox_by_id(uuid,text,integer)
  to service_role;

comment on function public.claim_telegram_outbox_by_id(uuid,text,integer) is
  'Backend-only atomic lease for one explicit due Telegram UUID. Returns authoritative enquiry notification fields and no client contact or provider credential.';

create or replace function public.record_telegram_outbox_result(
  p_outbox_id uuid,
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
  v_job public.integration_outbox%rowtype;
  v_relationship_valid boolean;
  v_attempt_count integer;
  v_status public.outbox_status;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Telegram outbox acknowledgement is backend-only'
      using errcode = '42501';
  end if;

  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'Telegram worker id is invalid'
      using errcode = '22023';
  end if;

  if p_succeeded is null then
    raise exception 'Telegram outbox result is required'
      using errcode = '22023';
  end if;

  if not p_succeeded
     and coalesce(p_error_code, '') !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'failed Telegram result requires a safe machine error code'
      using errcode = '22023';
  end if;

  select o.* into v_job
  from public.integration_outbox o
  where o.id = p_outbox_id
    and o.kind = 'telegram_notification'
  for update;

  if not found then
    raise exception 'Telegram outbox job is unavailable'
      using errcode = '22023';
  end if;

  -- A successful acknowledgement replay is idempotent. The claim RPC will
  -- never lease this row again, so this path cannot trigger a second send.
  if v_job.status = 'succeeded' and p_succeeded then
    if not exists (
      select 1
      from public.activity_log a
      where a.outbox_id = p_outbox_id
        and a.event_type = 'outbox.succeeded'
        and a.metadata ->> 'worker_id' = p_worker_id
    ) then
      raise exception 'Telegram outbox lease is not owned by this worker'
        using errcode = '42501';
    end if;

    return jsonb_build_object(
      'outbox_id', p_outbox_id,
      'status', 'succeeded',
      'attempt_count', v_job.attempt_count,
      'changed', false
    );
  end if;

  if v_job.status <> 'leased' or v_job.leased_by is distinct from p_worker_id then
    raise exception 'Telegram outbox lease is not owned by this worker'
      using errcode = '42501';
  end if;

  select (
    e.id is not null
    and v_job.enquiry_id = e.id
    and v_job.artist_id = e.artist_id
    and v_job.client_id = e.client_id
    and e.intake_state = 'complete'
    and count(f.id) > 0
    and count(f.id) filter (where f.upload_state <> 'ready') = 0
  )
  into v_relationship_valid
  from public.enquiries e
  left join public.enquiry_files f on f.enquiry_id = e.id
  where e.id = v_job.enquiry_id
  group by e.id, e.artist_id, e.client_id, e.intake_state;

  v_relationship_valid := coalesce(v_relationship_valid, false);

  if p_succeeded and not v_relationship_valid then
    raise exception 'Telegram outbox job does not match its enquiry'
      using errcode = '23514';
  end if;

  v_attempt_count := v_job.attempt_count + 1;
  v_status := case
    when p_succeeded then 'succeeded'::public.outbox_status
    when v_attempt_count >= v_job.max_attempts then 'dead'::public.outbox_status
    else 'failed'::public.outbox_status
  end;

  update public.integration_outbox o
  set status = v_status,
      attempt_count = v_attempt_count,
      next_attempt_at = case
        when p_succeeded or v_status = 'dead' then o.next_attempt_at
        else now() + make_interval(
          secs => least((power(2, least(v_job.attempt_count, 7)) * 30)::integer, 3600)
        )
      end,
      leased_by = null,
      leased_at = null,
      lease_expires_at = null,
      last_error_code = case when p_succeeded then null else p_error_code end,
      updated_at = now()
  where o.id = p_outbox_id;

  perform crm_private.log_activity(
    case when p_succeeded then 'outbox.succeeded' else 'outbox.failed' end,
    'worker', null,
    v_job.client_id, v_job.enquiry_id, v_job.project_id, v_job.session_id,
    null, null, null, p_outbox_id,
    jsonb_build_object(
      'attempt_count', v_attempt_count,
      'error_code', case when p_succeeded then null else p_error_code end,
      'worker_id', p_worker_id,
      'lease_aware', true,
      'dead_letter', v_status = 'dead'
    )
  );

  return jsonb_build_object(
    'outbox_id', p_outbox_id,
    'status', v_status,
    'attempt_count', v_attempt_count,
    'changed', true
  );
end;
$$;

revoke all on function public.record_telegram_outbox_result(uuid,text,boolean,text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_telegram_outbox_result(uuid,text,boolean,text)
  to service_role;

comment on function public.record_telegram_outbox_result(uuid,text,boolean,text) is
  'Backend-only lease-owned Telegram acknowledgement with one attempt increment, bounded retry/dead-letter handling and safe Activity Log evidence.';
