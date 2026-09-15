-- Consent-gated Meta Ads attribution and CRM conversion event enqueueing.
-- Credentials stay in backend secret storage; Postgres contains only safe
-- artist-scoped provider metadata and consented measurement context.

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
  'Private first-touch Meta measurement context recorded only after explicit Meta advertising consent.';

create index if not exists enquiry_meta_attribution_artist_idx
  on crm_private.enquiry_meta_attribution (artist_id, created_at desc);

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

  v_event_id := crm_private.meta_event_id(p_event_name, p_enquiry_id, v_attr.lead_event_id);
  if v_event_id is null then return null; end if;

  v_dedupe_key := 'meta:' || lower(p_event_name) || ':' || p_enquiry_id::text;

  insert into public.integration_outbox (
    kind, dedupe_key, status, payload,
    artist_id, client_id, enquiry_id, project_id,
    max_attempts, next_attempt_at
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
    perform crm_private.enqueue_meta_event(v_enquiry.id, 'Lead', v_enquiry.updated_at, null);
  end if;

  if v_enquiry.status in ('accepted', 'quote_sent', 'deposit_requested', 'deposit_paid', 'converted') then
    perform crm_private.enqueue_meta_event(v_enquiry.id, 'QualifiedLead', v_enquiry.updated_at, null);
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
    perform crm_private.enqueue_meta_event(v_enquiry.id, 'BookedClient', v_paid_at, v_project_id);
  end if;
end;
$$;

revoke all on function crm_private.enqueue_meta_state_if_due(uuid)
  from public, anon, authenticated, service_role;

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
  v_row_count integer := 0;
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
    enquiry_id, artist_id, lead_event_id, fbp, fbc, event_source_url, consent_granted_at
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

  get diagnostics v_row_count = row_count;
  v_inserted := v_row_count > 0;

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
