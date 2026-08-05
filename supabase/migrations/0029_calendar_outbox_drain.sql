-- 0029_calendar_outbox_drain.sql
--
-- Backend-only leasing and acknowledgement for the artist-routed Google
-- Calendar outbox. Supabase appointments remain authoritative. The Worker gets
-- only the minimum event projection fields; OAuth refresh tokens remain in
-- encrypted Cloudflare KV and never enter this database.
--
-- Forward-only. No cron trigger, OAuth connection or live provider call is
-- enabled by this migration.

create index if not exists integration_outbox_calendar_ready_idx
  on public.integration_outbox (next_attempt_at, created_at, id)
  where kind in ('calendar_create', 'calendar_update', 'calendar_cancel')
    and status in ('pending', 'failed', 'leased');

create or replace function public.claim_calendar_outbox(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  outbox_id uuid,
  artist_id uuid,
  kind public.outbox_kind,
  session_id uuid,
  calendar_version integer,
  current_calendar_version integer,
  attempt_count integer,
  max_attempts integer,
  appointment_type public.appointment_type,
  appointment_status public.session_status,
  start_at timestamptz,
  end_at timestamptz,
  calendar_event_id text,
  client_display_name text,
  job_valid boolean,
  obsolete boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'calendar outbox leasing is backend-only'
      using errcode = '42501';
  end if;

  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'calendar worker id is invalid'
      using errcode = '22023';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'calendar claim limit must be between 1 and 20'
      using errcode = '22023';
  end if;

  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'calendar lease must be between 30 and 600 seconds'
      using errcode = '22023';
  end if;

  return query
  with candidates as (
    select o.id
    from public.integration_outbox o
    where o.kind in ('calendar_create', 'calendar_update', 'calendar_cancel')
      and (
        (o.status in ('pending', 'failed') and o.next_attempt_at <= now())
        or (o.status = 'leased' and o.lease_expires_at <= now())
      )
    order by o.next_attempt_at, o.created_at, o.id
    for update of o skip locked
    limit p_limit
  ),
  leased as (
    update public.integration_outbox o
    set status = 'leased',
        leased_by = p_worker_id,
        leased_at = now(),
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        updated_at = now()
    from candidates c
    where o.id = c.id
    returning o.*
  ),
  parsed as (
    select
      l.*,
      s.id as session_row_id,
      s.calendar_version as session_calendar_version,
      s.appointment_type as session_appointment_type,
      s.status as session_status,
      s.start_at as session_start_at,
      s.end_at as session_end_at,
      s.calendar_event_id as session_calendar_event_id,
      s.artist_id as session_artist_id,
      c.full_name as client_name,
      case
        when coalesce(l.payload ->> 'calendar_version', '') ~ '^[0-9]{1,9}$'
          then (l.payload ->> 'calendar_version')::integer
        else null
      end as payload_calendar_version
    from leased l
    left join public.sessions s on s.id = l.session_id
    left join public.clients c on c.id = s.client_id
  ),
  marked_retrying as (
    update public.sessions s
    set calendar_sync_status = 'retrying',
        calendar_last_error_code = null,
        updated_at = now()
    from parsed p
    where s.id = p.session_row_id
      and p.payload_calendar_version = p.session_calendar_version
      and p.payload ->> 'session_id' = p.session_row_id::text
      and p.payload ->> 'appointment_type' = p.session_appointment_type::text
      and p.artist_id = p.session_artist_id
      and (
        (p.kind = 'calendar_create'
          and p.session_status = 'confirmed'
          and p.session_calendar_event_id is null)
        or (p.kind = 'calendar_update'
          and p.session_status = 'confirmed'
          and p.session_calendar_event_id is not null)
        or (p.kind = 'calendar_cancel'
          and p.session_status = 'cancelled'
          and p.session_calendar_event_id is not null)
      )
    returning s.id
  )
  select
    p.id,
    p.artist_id,
    p.kind,
    p.session_id,
    p.payload_calendar_version,
    p.session_calendar_version,
    p.attempt_count,
    p.max_attempts,
    p.session_appointment_type,
    p.session_status,
    p.session_start_at,
    p.session_end_at,
    p.session_calendar_event_id,
    p.client_name,
    (
      p.session_row_id is not null
      and p.payload_calendar_version is not null
      and p.payload ->> 'session_id' = p.session_row_id::text
      and p.payload ->> 'appointment_type' = p.session_appointment_type::text
      and p.artist_id = p.session_artist_id
      and (
        p.payload_calendar_version < p.session_calendar_version
        or (
          p.payload_calendar_version = p.session_calendar_version
          and (
            (p.kind = 'calendar_create'
              and p.session_status = 'confirmed'
              and p.session_calendar_event_id is null)
            or (p.kind = 'calendar_update'
              and p.session_status = 'confirmed'
              and p.session_calendar_event_id is not null)
            or (p.kind = 'calendar_cancel'
              and p.session_status = 'cancelled'
              and p.session_calendar_event_id is not null)
          )
        )
      )
    ) as job_valid,
    (
      p.payload_calendar_version is not null
      and p.session_calendar_version is not null
      and p.payload_calendar_version < p.session_calendar_version
    ) as obsolete
  from parsed p
  left join marked_retrying mr on mr.id = p.session_row_id
  order by p.next_attempt_at, p.created_at, p.id;
end;
$$;

revoke all on function public.claim_calendar_outbox(text,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_calendar_outbox(text,integer,integer)
  to service_role;

comment on function public.claim_calendar_outbox(text,integer,integer) is
  'Backend-only SKIP LOCKED lease for due artist-scoped calendar jobs. Returns event projection fields but no provider credential or private note.';

create or replace function crm_private.dead_letter_calendar_outbox(
  p_outbox_id uuid,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.integration_outbox%rowtype;
  v_attempt_count integer;
begin
  select o.* into v_job
  from public.integration_outbox o
  where o.id = p_outbox_id
  for update;

  if not found then
    raise exception 'calendar outbox job is unavailable'
      using errcode = '22023';
  end if;

  v_attempt_count := v_job.attempt_count + 1;

  update public.integration_outbox o
  set status = 'dead',
      attempt_count = v_attempt_count,
      leased_by = null,
      leased_at = null,
      lease_expires_at = null,
      last_error_code = left(coalesce(nullif(btrim(p_error_code), ''), 'calendar_job_invalid'), 100),
      updated_at = now()
  where o.id = p_outbox_id;

  perform crm_private.log_activity(
    'outbox.failed', 'worker', null,
    v_job.client_id, v_job.enquiry_id, v_job.project_id, v_job.session_id,
    null, null, null, p_outbox_id,
    jsonb_build_object(
      'attempt_count', v_attempt_count,
      'error_code', left(coalesce(nullif(btrim(p_error_code), ''), 'calendar_job_invalid'), 100),
      'dead_letter', true
    )
  );

  return jsonb_build_object(
    'outbox_id', p_outbox_id,
    'status', 'dead',
    'attempt_count', v_attempt_count,
    'changed', true,
    'invalid', true
  );
end;
$$;

revoke all on function crm_private.dead_letter_calendar_outbox(uuid,text)
  from public, anon, authenticated, service_role;

create or replace function public.record_calendar_outbox_result(
  p_outbox_id uuid,
  p_worker_id text,
  p_calendar_version integer,
  p_succeeded boolean,
  p_event_id text default null,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.integration_outbox%rowtype;
  v_session public.sessions%rowtype;
  v_job_version integer;
  v_attempt_count integer;
  v_status public.outbox_status;
  v_sync_result jsonb;
begin
  if not crm_private.is_service_backend() then
    raise exception 'calendar outbox acknowledgement is backend-only'
      using errcode = '42501';
  end if;

  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'calendar worker id is invalid'
      using errcode = '22023';
  end if;

  if p_succeeded is null then
    raise exception 'calendar outbox result is required'
      using errcode = '22023';
  end if;

  if not p_succeeded
     and coalesce(p_error_code, '') !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'failed calendar result requires a safe machine error code'
      using errcode = '22023';
  end if;

  select o.* into v_job
  from public.integration_outbox o
  where o.id = p_outbox_id
    and o.kind in ('calendar_create', 'calendar_update', 'calendar_cancel')
  for update;

  if not found then
    raise exception 'calendar outbox job is unavailable'
      using errcode = '22023';
  end if;

  if v_job.status = 'succeeded' then
    return jsonb_build_object(
      'outbox_id', p_outbox_id,
      'status', 'succeeded',
      'attempt_count', v_job.attempt_count,
      'changed', false
    );
  end if;

  if v_job.status <> 'leased' or v_job.leased_by is distinct from p_worker_id then
    raise exception 'calendar outbox lease is not owned by this worker'
      using errcode = '42501';
  end if;

  if coalesce(v_job.payload ->> 'calendar_version', '') !~ '^[0-9]{1,9}$' then
    if p_succeeded then
      raise exception 'calendar outbox version is invalid'
        using errcode = '22023';
    end if;
    return crm_private.dead_letter_calendar_outbox(p_outbox_id, p_error_code);
  end if;
  v_job_version := (v_job.payload ->> 'calendar_version')::integer;

  if p_calendar_version is distinct from v_job_version then
    if p_succeeded then
      raise exception 'calendar result version does not match the leased job'
        using errcode = '22023';
    end if;
    return crm_private.dead_letter_calendar_outbox(p_outbox_id, p_error_code);
  end if;

  select s.* into v_session
  from public.sessions s
  where s.id = v_job.session_id
  for update;

  if not found
     or v_job.artist_id is distinct from v_session.artist_id
     or v_job.payload ->> 'session_id' is distinct from v_session.id::text
     or v_job.payload ->> 'appointment_type' is distinct from v_session.appointment_type::text then
    if p_succeeded then
      raise exception 'calendar outbox job does not match its appointment'
        using errcode = '23514';
    end if;
    return crm_private.dead_letter_calendar_outbox(p_outbox_id, p_error_code);
  end if;

  if v_job_version > v_session.calendar_version then
    if p_succeeded then
      raise exception 'calendar result version is ahead of the appointment version'
        using errcode = '22023';
    end if;
    return crm_private.dead_letter_calendar_outbox(p_outbox_id, p_error_code);
  end if;

  v_attempt_count := v_job.attempt_count + 1;

  -- A newer appointment version is authoritative. The old operation is
  -- retired without touching the current projection state. A newer durable job
  -- will converge Google Calendar to the current appointment.
  if v_job_version < v_session.calendar_version then
    update public.integration_outbox o
    set status = 'succeeded',
        attempt_count = v_attempt_count,
        leased_by = null,
        leased_at = null,
        lease_expires_at = null,
        last_error_code = null,
        updated_at = now()
    where o.id = p_outbox_id;

    perform crm_private.log_activity(
      'outbox.succeeded', 'worker', null,
      v_job.client_id, v_job.enquiry_id, v_job.project_id, v_job.session_id,
      null, null, null, p_outbox_id,
      jsonb_build_object(
        'attempt_count', v_attempt_count,
        'calendar_version', v_job_version,
        'obsolete', true
      )
    );

    return jsonb_build_object(
      'outbox_id', p_outbox_id,
      'status', 'succeeded',
      'attempt_count', v_attempt_count,
      'changed', true,
      'stale', true,
      'calendar_version', v_session.calendar_version
    );
  end if;

  if p_succeeded then
    if v_job.kind in ('calendar_create', 'calendar_update') then
      if nullif(btrim(p_event_id), '') is null then
        raise exception 'successful calendar create/update requires an event id'
          using errcode = '22023';
      end if;

      v_sync_result := public.record_calendar_sync_result(
        v_session.id,
        v_job_version,
        true,
        'google',
        p_event_id,
        null
      );
    else
      if v_session.status <> 'cancelled' or v_session.calendar_event_id is null then
        raise exception 'calendar cancellation result does not match appointment state'
          using errcode = '23514';
      end if;

      update public.sessions s
      set calendar_provider = 'none',
          calendar_event_id = null,
          calendar_sync_status = 'not_connected',
          calendar_last_synced_version = v_job_version,
          calendar_last_synced_at = now(),
          calendar_last_error_code = null,
          updated_at = now()
      where s.id = v_session.id;

      v_sync_result := jsonb_build_object(
        'appointment_id', v_session.id,
        'applied', true,
        'stale', false,
        'calendar_version', v_job_version,
        'sync_status', 'not_connected'
      );
    end if;

    v_status := 'succeeded';
  else
    v_sync_result := public.record_calendar_sync_result(
      v_session.id,
      v_job_version,
      false,
      'google',
      null,
      p_error_code
    );

    v_status := case
      when v_attempt_count >= v_job.max_attempts then 'dead'::public.outbox_status
      else 'failed'::public.outbox_status
    end;
  end if;

  update public.integration_outbox o
  set status = v_status,
      attempt_count = v_attempt_count,
      next_attempt_at = case
        when p_succeeded then o.next_attempt_at
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
      'calendar_version', v_job_version,
      'error_code', case when p_succeeded then null else p_error_code end
    )
  );

  return jsonb_build_object(
    'outbox_id', p_outbox_id,
    'status', v_status,
    'attempt_count', v_attempt_count,
    'changed', true,
    'stale', false,
    'calendar_version', v_job_version,
    'sync_result', v_sync_result
  );
end;
$$;

revoke all on function public.record_calendar_outbox_result(uuid,text,integer,boolean,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_calendar_outbox_result(uuid,text,integer,boolean,text,text)
  to service_role;

comment on function public.record_calendar_outbox_result(uuid,text,integer,boolean,text,text) is
  'Backend-only durable calendar result wrapper. Verifies lease ownership, applies current provider acknowledgements, retires stale versions and records bounded retries.';
