-- Consent-gated Meta Ads / Conversions API pipeline.
--
-- - first-touch Meta attribution is private and immutable
-- - provider credentials never enter Postgres
-- - every server event is a durable, deduplicated outbox job
-- - Vladimir is configured but intentionally disabled until the backend token
--   exists; activation is a separate production action
-- - Kristina/other artists are not configured or activated here

-- ---------------------------------------------------------------------------
-- Artist integration metadata
-- ---------------------------------------------------------------------------

create unique index if not exists artist_integrations_one_enabled_meta_ads_idx
  on public.artist_integrations (artist_id)
  where integration_type = 'meta_ads' and is_enabled;

insert into public.artist_integrations (
  artist_id,
  integration_type,
  provider,
  integration_key,
  external_account_label,
  configuration,
  is_enabled
)
select
  a.id,
  'meta_ads'::public.artist_integration_type,
  'meta',
  'meta_ads_vladimir',
  'Vishar Tattoo Web',
  jsonb_build_object(
    'dataset_id', '1729215778134902',
    'graph_api_version', 'v26.0',
    'optimization_event', 'Lead'
  ),
  false
from public.artists a
where a.slug = 'vladimir'
on conflict (artist_id, integration_type, integration_key) do update
set provider = excluded.provider,
    external_account_label = excluded.external_account_label,
    configuration = excluded.configuration,
    updated_at = now();

-- ---------------------------------------------------------------------------
-- Private first-touch Meta attribution
-- ---------------------------------------------------------------------------

create table if not exists crm_private.enquiry_meta_attribution (
  enquiry_id         uuid primary key references public.enquiries(id) on delete cascade,
  artist_id          uuid not null references public.artists(id) on delete restrict,
  lead_event_id      text not null unique,
  fbp                text,
  fbc                text,
  event_source_url   text not null,
  consent_granted_at timestamptz not null default now(),
  created_at         timestamptz not null default now(),

  constraint enquiry_meta_lead_event_id_uuid
    check (lead_event_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  constraint enquiry_meta_fbp_shape
    check (fbp is null or (char_length(fbp) <= 255 and fbp ~ '^fb\.[0-9]+\.[0-9]{10,13}\.[^[:space:]]{1,220}$')),
  constraint enquiry_meta_fbc_shape
    check (fbc is null or (char_length(fbc) <= 255 and fbc ~ '^fb\.[0-9]+\.[0-9]{10,13}\.[^[:space:]]{1,220}$')),
  constraint enquiry_meta_source_url_https
    check (char_length(event_source_url) <= 2048 and event_source_url ~ '^https://[^[:space:]]+$')
);

alter table crm_private.enquiry_meta_attribution enable row level security;
revoke all on table crm_private.enquiry_meta_attribution
  from public, anon, authenticated, service_role;

comment on table crm_private.enquiry_meta_attribution is
  'Private, consent-gated first-touch Meta advertising measurement context. No tattoo content, files, notes or provider credentials are stored here.';

create index if not exists enquiry_meta_attribution_artist_idx
  on crm_private.enquiry_meta_attribution (artist_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Event helpers
-- ---------------------------------------------------------------------------

create or replace function crm_private.meta_event_id(
  p_event_name text,
  p_enquiry_id uuid,
  p_lead_event_id text
)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select case p_event_name
    when 'Lead' then p_lead_event_id
    when 'QualifiedLead' then 'qualified:' || p_enquiry_id::text
    when 'BookedClient' then 'booked:' || p_enquiry_id::text
    else null
  end;
$$;

revoke all on function crm_private.meta_event_id(text,uuid,text)
  from public, anon, authenticated, service_role;

create or replace function crm_private.enqueue_meta_event(
  p_enquiry_id uuid,
  p_event_name text,
  p_event_time timestamptz,
  p_project_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry public.enquiries%rowtype;
  v_attr crm_private.enquiry_meta_attribution%rowtype;
  v_event_id text;
  v_dedupe_key text;
  v_outbox_id uuid;
begin
  if p_event_name not in ('Lead', 'QualifiedLead', 'BookedClient') then
    raise exception 'Unsupported Meta conversion event'
      using errcode = '22023';
  end if;

  select e.* into v_enquiry
  from public.enquiries e
  where e.id = p_enquiry_id;
  if not found then return null; end if;

  select m.* into v_attr
  from crm_private.enquiry_meta_attribution m
  where m.enquiry_id = p_enquiry_id
    and m.artist_id = v_enquiry.artist_id;
  if not found then return null; end if;

  if not exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = v_enquiry.artist_id
      and i.integration_type = 'meta_ads'
      and i.provider = 'meta'
      and i.is_enabled
  ) then
    return null;
  end if;

  v_event_id := crm_private.meta_event_id(
    p_event_name,
    p_enquiry_id,
    v_attr.lead_event_id
  );
  if v_event_id is null then return null; end if;

  v_dedupe_key := 'meta:' || lower(p_event_name) || ':' || p_enquiry_id::text;

  insert into public.integration_outbox (
    kind,
    dedupe_key,
    status,
    payload,
    artist_id,
    client_id,
    enquiry_id,
    project_id,
    max_attempts,
    next_attempt_at
  ) values (
    'meta_conversion'::public.outbox_kind,
    v_dedupe_key,
    'pending'::public.outbox_status,
    jsonb_build_object(
      'schema_version', 1,
      'event_name', p_event_name,
      'event_id', v_event_id,
      'event_time', extract(epoch from coalesce(p_event_time, statement_timestamp()))::bigint
    ),
    v_enquiry.artist_id,
    v_enquiry.client_id,
    v_enquiry.id,
    p_project_id,
    8,
    now()
  )
  on conflict (dedupe_key) do nothing
  returning id into v_outbox_id;

  if v_outbox_id is null then
    select o.id into v_outbox_id
    from public.integration_outbox o
    where o.dedupe_key = v_dedupe_key
      and o.kind = 'meta_conversion';
  end if;

  return v_outbox_id;
end;
$$;

revoke all on function crm_private.enqueue_meta_event(uuid,text,timestamptz,uuid)
  from public, anon, authenticated, service_role;

create or replace function crm_private.enqueue_meta_state_if_due(p_enquiry_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry public.enquiries%rowtype;
  v_project_id uuid;
  v_paid_at timestamptz;
begin
  select e.* into v_enquiry
  from public.enquiries e
  where e.id = p_enquiry_id;
  if not found then return; end if;

  if v_enquiry.intake_state = 'complete' then
    perform crm_private.enqueue_meta_event(
      v_enquiry.id,
      'Lead',
      v_enquiry.updated_at,
      null
    );
  end if;

  if v_enquiry.status in ('accepted', 'quote_sent', 'deposit_requested', 'deposit_paid', 'converted') then
    perform crm_private.enqueue_meta_event(
      v_enquiry.id,
      'QualifiedLead',
      v_enquiry.updated_at,
      null
    );
  end if;

  select p.id, p.updated_at
  into v_project_id, v_paid_at
  from public.projects p
  where p.enquiry_id = v_enquiry.id
    and p.artist_id = v_enquiry.artist_id
    and p.deposit_status = 'paid'
  order by p.updated_at, p.id
  limit 1;

  if v_project_id is not null then
    perform crm_private.enqueue_meta_event(
      v_enquiry.id,
      'BookedClient',
      v_paid_at,
      v_project_id
    );
  end if;
end;
$$;

revoke all on function crm_private.enqueue_meta_state_if_due(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Backend-only attribution write
-- ---------------------------------------------------------------------------

create or replace function public.service_record_meta_attribution(
  p_enquiry_id uuid,
  p_lead_event_id text,
  p_consent_granted boolean,
  p_fbp text default null,
  p_fbc text default null,
  p_event_source_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry public.enquiries%rowtype;
  v_inserted boolean := false;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Meta attribution recording is backend-only'
      using errcode = '42501';
  end if;

  if p_consent_granted is distinct from true then
    raise exception 'Meta advertising measurement requires explicit consent'
      using errcode = '22023';
  end if;

  select e.* into v_enquiry
  from public.enquiries e
  where e.id = p_enquiry_id;
  if not found then
    raise exception 'Enquiry is unavailable'
      using errcode = '22023';
  end if;

  if p_lead_event_id is distinct from v_enquiry.idempotency_key::text then
    raise exception 'Meta Lead event id must match enquiry idempotency key'
      using errcode = '23514';
  end if;

  if p_event_source_url is null
     or char_length(p_event_source_url) > 2048
     or p_event_source_url !~ '^https://[^[:space:]]+$' then
    raise exception 'Meta event source URL is invalid'
      using errcode = '22023';
  end if;

  insert into crm_private.enquiry_meta_attribution (
    enquiry_id,
    artist_id,
    lead_event_id,
    fbp,
    fbc,
    event_source_url,
    consent_granted_at
  ) values (
    v_enquiry.id,
    v_enquiry.artist_id,
    p_lead_event_id,
    nullif(btrim(p_fbp), ''),
    nullif(btrim(p_fbc), ''),
    p_event_source_url,
    statement_timestamp()
  )
  on conflict (enquiry_id) do nothing;

  get diagnostics v_inserted = row_count;

  perform crm_private.enqueue_meta_state_if_due(v_enquiry.id);

  return jsonb_build_object(
    'enquiry_id', v_enquiry.id,
    'recorded', v_inserted,
    'first_touch_preserved', not v_inserted
  );
end;
$$;

revoke all on function public.service_record_meta_attribution(uuid,text,boolean,text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.service_record_meta_attribution(uuid,text,boolean,text,text,text)
  to service_role;

comment on function public.service_record_meta_attribution(uuid,text,boolean,text,text,text) is
  'Backend-only, explicit-consent first-touch Meta attribution write. The Lead event id is forced to equal the enquiry idempotency UUID.';

-- ---------------------------------------------------------------------------
-- Lifecycle triggers
-- ---------------------------------------------------------------------------

create or replace function crm_private.enqueue_meta_on_enquiry_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.intake_state = 'complete'
     and old.intake_state is distinct from 'complete' then
    perform crm_private.enqueue_meta_event(new.id, 'Lead', new.updated_at, null);
  end if;

  if new.status = 'accepted'
     and old.status is distinct from 'accepted' then
    perform crm_private.enqueue_meta_event(new.id, 'QualifiedLead', new.updated_at, null);
  end if;

  return new;
end;
$$;

revoke all on function crm_private.enqueue_meta_on_enquiry_change()
  from public, anon, authenticated, service_role;

drop trigger if exists enquiries_meta_conversion_events on public.enquiries;
create trigger enquiries_meta_conversion_events
  after update of intake_state, status on public.enquiries
  for each row execute function crm_private.enqueue_meta_on_enquiry_change();

create or replace function crm_private.enqueue_meta_on_project_deposit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.enquiry_id is null or new.deposit_status <> 'paid' then
    return new;
  end if;

  if tg_op = 'INSERT'
     or old.deposit_status is distinct from 'paid' then
    perform crm_private.enqueue_meta_event(
      new.enquiry_id,
      'BookedClient',
      new.updated_at,
      new.id
    );
  end if;

  return new;
end;
$$;

revoke all on function crm_private.enqueue_meta_on_project_deposit()
  from public, anon, authenticated, service_role;

drop trigger if exists projects_meta_booked_client on public.projects;
create trigger projects_meta_booked_client
  after insert or update of deposit_status on public.projects
  for each row execute function crm_private.enqueue_meta_on_project_deposit();

-- ---------------------------------------------------------------------------
-- Durable Meta outbox drain RPCs
-- ---------------------------------------------------------------------------

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

comment on function public.claim_meta_conversion_outbox(text,integer,integer) is
  'Backend-only bounded Meta conversion lease. Returns only provider-required attribution/contact fields; tattoo content and private notes are excluded.';

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

comment on function public.record_meta_conversion_outbox_result(uuid,text,boolean,boolean,text) is
  'Backend-only lease-owned Meta acknowledgement with bounded retry and immediate dead-letter for deterministic provider/config failures.';
