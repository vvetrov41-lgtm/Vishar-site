-- Durable Meta conversion outbox leasing and acknowledgement.

create index if not exists integration_outbox_meta_ready_idx
  on public.integration_outbox (next_attempt_at, created_at, id)
  where kind = 'meta_conversion'
    and status in ('pending', 'failed', 'leased');

create or replace function public.claim_meta_conversion_outbox(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  outbox_id uuid,
  artist_id uuid,
  enquiry_id uuid,
  project_id uuid,
  attempt_count integer,
  max_attempts integer,
  event_name text,
  event_id text,
  event_time bigint,
  integration_key text,
  dataset_id text,
  graph_api_version text,
  event_source_url text,
  fbp text,
  fbc text,
  email text,
  phone text,
  job_valid boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Meta outbox leasing is backend-only'
      using errcode = '42501';
  end if;

  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'Meta worker id is invalid'
      using errcode = '22023';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'Meta claim limit must be between 1 and 20'
      using errcode = '22023';
  end if;

  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'Meta lease must be between 30 and 600 seconds'
      using errcode = '22023';
  end if;

  return query
  with candidates as (
    select o.id
    from public.integration_outbox o
    join public.artist_integrations i
      on i.artist_id = o.artist_id
     and i.integration_type = 'meta_ads'
     and i.provider = 'meta'
     and i.is_enabled
    where o.kind = 'meta_conversion'
      and o.attempt_count < o.max_attempts
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
  )
  select
    l.id,
    l.artist_id,
    l.enquiry_id,
    l.project_id,
    l.attempt_count,
    l.max_attempts,
    l.payload ->> 'event_name',
    l.payload ->> 'event_id',
    case
      when (l.payload ->> 'event_time') ~ '^[0-9]{10,13}$'
        then (l.payload ->> 'event_time')::bigint
      else null
    end,
    i.integration_key,
    i.configuration ->> 'dataset_id',
    i.configuration ->> 'graph_api_version',
    m.event_source_url,
    m.fbp,
    m.fbc,
    e.submitted_email,
    e.submitted_phone,
    (
      e.id is not null
      and m.enquiry_id = e.id
      and m.artist_id = e.artist_id
      and l.artist_id = e.artist_id
      and l.client_id = e.client_id
      and i.artist_id = e.artist_id
      and (i.configuration ->> 'dataset_id') ~ '^[0-9]{5,30}$'
      and (i.configuration ->> 'graph_api_version') ~ '^v[0-9]+\.0$'
      and (l.payload ->> 'event_name') in ('Lead', 'QualifiedLead', 'BookedClient')
      and (l.payload ->> 'event_id') = crm_private.meta_event_id(
        l.payload ->> 'event_name',
        e.id,
        m.lead_event_id
      )
      and (l.payload ->> 'event_time') ~ '^[0-9]{10,13}$'
      and e.intake_state = 'complete'
    ) as job_valid
  from leased l
  left join public.enquiries e on e.id = l.enquiry_id
  left join crm_private.enquiry_meta_attribution m on m.enquiry_id = l.enquiry_id
  left join public.artist_integrations i
    on i.artist_id = l.artist_id
   and i.integration_type = 'meta_ads'
   and i.provider = 'meta'
   and i.is_enabled
  order by l.next_attempt_at, l.created_at, l.id;
end;
$$;

revoke all on function public.claim_meta_conversion_outbox(text,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_meta_conversion_outbox(text,integer,integer)
  to service_role;

create or replace function public.record_meta_conversion_outbox_result(
  p_outbox_id uuid,
  p_worker_id text,
  p_succeeded boolean,
  p_retryable boolean default true,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.integration_outbox%rowtype;
  v_attempt_count integer;
  v_status public.outbox_status;
  v_event_name text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Meta outbox acknowledgement is backend-only'
      using errcode = '42501';
  end if;

  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'Meta worker id is invalid'
      using errcode = '22023';
  end if;

  if p_succeeded is null or p_retryable is null then
    raise exception 'Meta outbox result is incomplete'
      using errcode = '22023';
  end if;

  if not p_succeeded
     and coalesce(p_error_code, '') !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'failed Meta result requires a safe machine error code'
      using errcode = '22023';
  end if;

  select o.* into v_job
  from public.integration_outbox o
  where o.id = p_outbox_id
    and o.kind = 'meta_conversion'
  for update;

  if not found then
    raise exception 'Meta outbox job is unavailable'
      using errcode = '22023';
  end if;

  if v_job.status = 'succeeded' and p_succeeded then
    return jsonb_build_object(
      'outbox_id', p_outbox_id,
      'status', 'succeeded',
      'attempt_count', v_job.attempt_count,
      'changed', false
    );
  end if;

  if v_job.status <> 'leased' or v_job.leased_by is distinct from p_worker_id then
    raise exception 'Meta outbox lease is not owned by this worker'
      using errcode = '42501';
  end if;

  v_event_name := v_job.payload ->> 'event_name';
  v_attempt_count := v_job.attempt_count + 1;
  v_status := case
    when p_succeeded then 'succeeded'::public.outbox_status
    when not p_retryable then 'dead'::public.outbox_status
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
      'dead_letter', v_status = 'dead',
      'retryable', case when p_succeeded then null else p_retryable end,
      'event_name', v_event_name
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

revoke all on function public.record_meta_conversion_outbox_result(uuid,text,boolean,boolean,text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_meta_conversion_outbox_result(uuid,text,boolean,boolean,text)
  to service_role;
