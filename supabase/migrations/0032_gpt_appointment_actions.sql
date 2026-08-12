-- 0032_gpt_appointment_actions.sql
--
-- Add a closed, artist-bound action surface for private GPTs. Supabase OAuth
-- access tokens preserve auth.uid() and add an OAuth client_id claim. That
-- client_id selects exactly one artist; no RPC accepts artist_id from the GPT.
--
-- Both logical clients are disabled by default. No OAuth client, secret,
-- endpoint or deployment is created by this migration.

-- ---------------------------------------------------------------------------
-- Private OAuth-client to artist binding
-- ---------------------------------------------------------------------------

create table if not exists crm_private.gpt_action_clients (
  id                      uuid primary key,
  artist_id               uuid not null references public.artists(id) on delete restrict,
  integration_key         text not null unique,
  display_name            text not null,
  oauth_client_id         text unique,
  can_read_appointments   boolean not null default true,
  can_manage_appointments boolean not null default false,
  is_active               boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint gpt_action_clients_integration_key_shape
    check (integration_key ~ '^[a-z][a-z0-9_-]{2,79}$'),
  constraint gpt_action_clients_display_name_not_blank
    check (btrim(display_name) <> ''),
  constraint gpt_action_clients_display_name_length
    check (char_length(display_name) <= 120),
  constraint gpt_action_clients_oauth_client_id_shape
    check (
      oauth_client_id is null
      or (
        btrim(oauth_client_id) = oauth_client_id
        and char_length(oauth_client_id) between 8 and 200
        and oauth_client_id ~ '^[A-Za-z0-9._:-]+$'
      )
    ),
  constraint gpt_action_clients_active_requires_client
    check (not is_active or oauth_client_id is not null),
  constraint gpt_action_clients_manage_requires_read
    check (not can_manage_appointments or can_read_appointments)
);

revoke all on crm_private.gpt_action_clients
  from public, anon, authenticated, service_role;

comment on table crm_private.gpt_action_clients is
  'Private allow-list binding one Supabase OAuth client_id to one artist-scoped GPT action surface.';
comment on column crm_private.gpt_action_clients.oauth_client_id is
  'Non-secret OAuth client identifier. OAuth client secrets remain only in Supabase Auth and ChatGPT configuration.';

create trigger gpt_action_clients_set_updated_at
  before update on crm_private.gpt_action_clients
  for each row execute function public.set_updated_at();

insert into crm_private.gpt_action_clients (
  id, artist_id, integration_key, display_name,
  can_read_appointments, can_manage_appointments, is_active
) values
  (
    'c1111111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111',
    'vladimir-gpt-actions',
    'Vladimir GPT appointment actions',
    true, true, false
  ),
  (
    'c2222222-2222-4222-8222-222222222222',
    'a2222222-2222-4222-8222-222222222222',
    'kristina-gpt-actions',
    'Kristina GPT appointment actions',
    true, true, false
  )
on conflict (integration_key) do nothing;

insert into public.artist_integrations (
  artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
) values
  (
    'a1111111-1111-4111-8111-111111111111',
    'gpt', 'openai_gpt_actions', 'vladimir-gpt-actions',
    'Vladimir private GPT',
    '{"capability":"appointments","authentication":"supabase_oauth_2_1"}'::jsonb,
    false
  ),
  (
    'a2222222-2222-4222-8222-222222222222',
    'gpt', 'openai_gpt_actions', 'kristina-gpt-actions',
    'Kristina private GPT',
    '{"capability":"appointments","authentication":"supabase_oauth_2_1"}'::jsonb,
    false
  )
on conflict (artist_id, integration_type, integration_key) do nothing;

-- ---------------------------------------------------------------------------
-- Idempotent write receipts
--
-- Only hashes and safe responses are retained. Raw notes, client data and
-- credentials are never copied here.
-- ---------------------------------------------------------------------------

create table if not exists crm_private.gpt_action_receipts (
  gpt_client_id    uuid not null references crm_private.gpt_action_clients(id) on delete restrict,
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  request_id       uuid not null,
  operation        text not null,
  request_hash     text not null,
  appointment_id   uuid references public.sessions(id) on delete set null,
  response         jsonb not null,
  created_at       timestamptz not null default now(),

  primary key (gpt_client_id, actor_profile_id, request_id),
  constraint gpt_action_receipts_operation_shape
    check (operation ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint gpt_action_receipts_hash_shape
    check (request_hash ~ '^[0-9a-f]{32}$'),
  constraint gpt_action_receipts_response_object
    check (jsonb_typeof(response) = 'object'),
  constraint gpt_action_receipts_response_size
    check (pg_column_size(response) <= 4096)
);

revoke all on crm_private.gpt_action_receipts
  from public, anon, authenticated, service_role;

create index if not exists gpt_action_receipts_created_idx
  on crm_private.gpt_action_receipts (created_at desc);

-- ---------------------------------------------------------------------------
-- OAuth context resolution
-- ---------------------------------------------------------------------------

create or replace function crm_private.require_gpt_action_context(p_write boolean)
returns table (
  gpt_client_id uuid,
  artist_id uuid,
  integration_key text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_oauth_client_id text;
  v_client crm_private.gpt_action_clients%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authenticated GPT OAuth user is required'
      using errcode = '42501';
  end if;

  v_oauth_client_id := nullif(btrim(auth.jwt() ->> 'client_id'), '');
  if v_oauth_client_id is null then
    raise exception 'a Supabase OAuth client token is required'
      using errcode = '42501';
  end if;

  select c.* into v_client
  from crm_private.gpt_action_clients c
  where c.oauth_client_id = v_oauth_client_id
    and c.is_active;

  if not found then
    raise exception 'this GPT OAuth client is not enabled'
      using errcode = '42501';
  end if;

  perform crm_private.require_active_artist(v_client.artist_id);

  if p_write then
    if not v_client.can_manage_appointments then
      raise exception 'this GPT client is read-only'
        using errcode = '42501';
    end if;
    perform crm_private.require_artist_access(v_client.artist_id, 'manage_sessions');
  else
    if not v_client.can_read_appointments then
      raise exception 'this GPT client cannot read appointments'
        using errcode = '42501';
    end if;
    perform crm_private.require_artist_access(v_client.artist_id, 'view');
  end if;

  return query
  select v_client.id, v_client.artist_id, v_client.integration_key;
end;
$$;

revoke all on function crm_private.require_gpt_action_context(boolean)
  from public, anon, authenticated, service_role;

-- Owner-only metadata configuration after the OAuth client has been created in
-- Supabase Auth. The client secret is never accepted or stored here.
create or replace function public.configure_gpt_action_client(
  p_integration_key text,
  p_oauth_client_id text,
  p_is_active boolean,
  p_can_manage_appointments boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client crm_private.gpt_action_clients%rowtype;
  v_oauth_client_id text;
begin
  if not public.is_owner() then
    raise exception 'only the owner may configure GPT action clients'
      using errcode = '42501';
  end if;

  v_oauth_client_id := nullif(btrim(p_oauth_client_id), '');
  if p_is_active and v_oauth_client_id is null then
    raise exception 'an OAuth client id is required before activation'
      using errcode = '22023';
  end if;

  select c.* into v_client
  from crm_private.gpt_action_clients c
  where c.integration_key = p_integration_key
  for update;

  if not found then
    raise exception 'unknown GPT action integration %', p_integration_key
      using errcode = '22023';
  end if;

  if p_is_active then
    perform crm_private.require_active_artist(v_client.artist_id);
  end if;

  update crm_private.gpt_action_clients c
  set oauth_client_id = v_oauth_client_id,
      can_manage_appointments = p_can_manage_appointments,
      can_read_appointments = true,
      is_active = p_is_active
  where c.id = v_client.id;

  update public.artist_integrations i
  set is_enabled = p_is_active,
      external_account_label = v_client.display_name
  where i.artist_id = v_client.artist_id
    and i.integration_type = 'gpt'
    and i.integration_key = v_client.integration_key;

  insert into public.activity_log (
    event_type, actor_profile_id, actor_kind, metadata
  ) values (
    'gpt.client_configured',
    auth.uid(),
    'owner',
    jsonb_build_object(
      'integration', v_client.integration_key,
      'enabled', p_is_active,
      'write_access', p_can_manage_appointments
    )
  );

  return jsonb_build_object(
    'integration_key', v_client.integration_key,
    'artist_id', v_client.artist_id,
    'enabled', p_is_active,
    'can_read_appointments', true,
    'can_manage_appointments', p_can_manage_appointments
  );
end;
$$;

revoke all on function public.configure_gpt_action_client(text,text,boolean,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.configure_gpt_action_client(text,text,boolean,boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Safe read surface
-- ---------------------------------------------------------------------------

create or replace function public.gpt_list_appointments(
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer default 20
)
returns table (
  appointment_id uuid,
  appointment_type public.appointment_type,
  status public.session_status,
  start_at timestamptz,
  end_at timestamptz,
  calendar_version integer,
  calendar_sync_status public.calendar_sync_status,
  client_id uuid,
  client_name text,
  enquiry_id uuid,
  project_id uuid
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_limit integer;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'appointment range end must be after its start'
      using errcode = '22023';
  end if;
  if p_to - p_from > interval '366 days' then
    raise exception 'appointment range may not exceed 366 days'
      using errcode = '22023';
  end if;

  select c.artist_id into v_artist_id
  from crm_private.require_gpt_action_context(false) c;
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 25);

  return query
  select s.id, s.appointment_type, s.status, s.start_at, s.end_at,
         s.calendar_version, s.calendar_sync_status,
         s.client_id, cl.full_name, s.enquiry_id, s.project_id
  from public.sessions s
  join public.clients cl on cl.id = s.client_id
  where s.artist_id = v_artist_id
    and s.start_at < p_to
    and s.end_at > p_from
  order by s.start_at, s.id
  limit v_limit;
end;
$$;

create or replace function public.gpt_get_appointment(p_appointment_id uuid)
returns table (
  appointment_id uuid,
  appointment_type public.appointment_type,
  status public.session_status,
  start_at timestamptz,
  end_at timestamptz,
  calendar_version integer,
  calendar_sync_status public.calendar_sync_status,
  client_id uuid,
  client_name text,
  enquiry_id uuid,
  project_id uuid
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_action_context(false) c;

  return query
  select s.id, s.appointment_type, s.status, s.start_at, s.end_at,
         s.calendar_version, s.calendar_sync_status,
         s.client_id, cl.full_name, s.enquiry_id, s.project_id
  from public.sessions s
  join public.clients cl on cl.id = s.client_id
  where s.id = p_appointment_id
    and s.artist_id = v_artist_id;
end;
$$;

create or replace function public.gpt_list_appointment_conflicts(
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_exclude_appointment_id uuid default null
)
returns table (
  appointment_id uuid,
  appointment_type public.appointment_type,
  status public.session_status,
  start_at timestamptz,
  end_at timestamptz,
  client_name text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at then
    raise exception 'conflict range end must be after its start'
      using errcode = '22023';
  end if;

  select c.artist_id into v_artist_id
  from crm_private.require_gpt_action_context(false) c;

  return query
  select s.id, s.appointment_type, s.status, s.start_at, s.end_at,
         cl.full_name
  from public.sessions s
  join public.clients cl on cl.id = s.client_id
  where s.artist_id = v_artist_id
    and s.status in ('proposed', 'confirmed')
    and s.id is distinct from p_exclude_appointment_id
    and tstzrange(s.start_at, s.end_at, '[)')
        && tstzrange(p_start_at, p_end_at, '[)')
  order by s.start_at, s.id
  limit 25;
end;
$$;

-- ---------------------------------------------------------------------------
-- Idempotent write surface
-- ---------------------------------------------------------------------------

create or replace function public.gpt_schedule_appointment(
  p_request_id uuid,
  p_client_id uuid,
  p_appointment_type public.appointment_type,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_status public.session_status default 'proposed',
  p_enquiry_id uuid default null,
  p_project_id uuid default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_context record;
  v_hash text;
  v_existing crm_private.gpt_action_receipts%rowtype;
  v_result jsonb;
  v_appointment_id uuid;
begin
  if p_request_id is null then
    raise exception 'request_id is required' using errcode = '22023';
  end if;

  select * into v_context
  from crm_private.require_gpt_action_context(true);

  v_hash := md5(jsonb_build_object(
    'client', p_client_id,
    'appointment_type', p_appointment_type,
    'start_at', p_start_at,
    'end_at', p_end_at,
    'status', p_status,
    'enquiry', p_enquiry_id,
    'project', p_project_id,
    'notes', p_notes
  )::text);

  perform pg_advisory_xact_lock(hashtextextended(
    v_context.gpt_client_id::text || ':' || auth.uid()::text || ':' || p_request_id::text,
    0
  ));

  select r.* into v_existing
  from crm_private.gpt_action_receipts r
  where r.gpt_client_id = v_context.gpt_client_id
    and r.actor_profile_id = auth.uid()
    and r.request_id = p_request_id;

  if found then
    if v_existing.operation <> 'schedule_appointment'
       or v_existing.request_hash <> v_hash then
      raise exception 'request_id was already used for a different GPT action'
        using errcode = '22023';
    end if;
    return v_existing.response;
  end if;

  v_result := public.schedule_appointment(
    v_context.artist_id,
    p_client_id,
    p_appointment_type,
    p_start_at,
    p_end_at,
    p_status,
    p_enquiry_id,
    p_project_id,
    p_notes
  );
  v_appointment_id := (v_result ->> 'appointment_id')::uuid;

  select v_result || jsonb_build_object(
    'calendar_version', s.calendar_version,
    'calendar_sync_status', s.calendar_sync_status,
    'idempotent_replay', false
  ) into v_result
  from public.sessions s
  where s.id = v_appointment_id;

  insert into crm_private.gpt_action_receipts (
    gpt_client_id, actor_profile_id, request_id, operation,
    request_hash, appointment_id, response
  ) values (
    v_context.gpt_client_id, auth.uid(), p_request_id,
    'schedule_appointment', v_hash, v_appointment_id, v_result
  );

  insert into public.activity_log (
    event_type, actor_profile_id, actor_kind, session_id, metadata
  ) values (
    'appointment.ai_scheduled', auth.uid(), 'ai', v_appointment_id,
    jsonb_build_object(
      'integration', v_context.integration_key,
      'operation', 'schedule_appointment'
    )
  );

  return v_result;
end;
$$;

create or replace function public.gpt_reschedule_appointment(
  p_request_id uuid,
  p_appointment_id uuid,
  p_expected_calendar_version integer,
  p_start_at timestamptz,
  p_end_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_context record;
  v_hash text;
  v_existing crm_private.gpt_action_receipts%rowtype;
  v_current_artist uuid;
  v_current_version integer;
  v_result jsonb;
begin
  if p_request_id is null then
    raise exception 'request_id is required' using errcode = '22023';
  end if;

  select * into v_context
  from crm_private.require_gpt_action_context(true);

  v_hash := md5(jsonb_build_object(
    'appointment', p_appointment_id,
    'expected_calendar_version', p_expected_calendar_version,
    'start_at', p_start_at,
    'end_at', p_end_at
  )::text);

  perform pg_advisory_xact_lock(hashtextextended(
    v_context.gpt_client_id::text || ':' || auth.uid()::text || ':' || p_request_id::text,
    0
  ));

  select r.* into v_existing
  from crm_private.gpt_action_receipts r
  where r.gpt_client_id = v_context.gpt_client_id
    and r.actor_profile_id = auth.uid()
    and r.request_id = p_request_id;

  if found then
    if v_existing.operation <> 'reschedule_appointment'
       or v_existing.request_hash <> v_hash then
      raise exception 'request_id was already used for a different GPT action'
        using errcode = '22023';
    end if;
    return v_existing.response;
  end if;

  select s.artist_id, s.calendar_version
    into v_current_artist, v_current_version
  from public.sessions s
  where s.id = p_appointment_id
  for update;

  if not found or v_current_artist <> v_context.artist_id then
    raise exception 'appointment does not exist in this GPT artist scope'
      using errcode = '42501';
  end if;
  if p_expected_calendar_version is null
     or p_expected_calendar_version <> v_current_version then
    raise exception 'appointment changed since it was read; refresh before rescheduling'
      using errcode = '40001';
  end if;

  v_result := public.reschedule_appointment(
    p_appointment_id, p_start_at, p_end_at
  ) || jsonb_build_object('idempotent_replay', false);

  insert into crm_private.gpt_action_receipts (
    gpt_client_id, actor_profile_id, request_id, operation,
    request_hash, appointment_id, response
  ) values (
    v_context.gpt_client_id, auth.uid(), p_request_id,
    'reschedule_appointment', v_hash, p_appointment_id, v_result
  );

  insert into public.activity_log (
    event_type, actor_profile_id, actor_kind, session_id, metadata
  ) values (
    'appointment.ai_rescheduled', auth.uid(), 'ai', p_appointment_id,
    jsonb_build_object(
      'integration', v_context.integration_key,
      'operation', 'reschedule_appointment'
    )
  );

  return v_result;
end;
$$;

create or replace function public.gpt_cancel_appointment(
  p_request_id uuid,
  p_appointment_id uuid,
  p_expected_calendar_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_context record;
  v_hash text;
  v_existing crm_private.gpt_action_receipts%rowtype;
  v_current_artist uuid;
  v_current_version integer;
  v_result jsonb;
begin
  if p_request_id is null then
    raise exception 'request_id is required' using errcode = '22023';
  end if;

  select * into v_context
  from crm_private.require_gpt_action_context(true);

  v_hash := md5(jsonb_build_object(
    'appointment', p_appointment_id,
    'expected_calendar_version', p_expected_calendar_version
  )::text);

  perform pg_advisory_xact_lock(hashtextextended(
    v_context.gpt_client_id::text || ':' || auth.uid()::text || ':' || p_request_id::text,
    0
  ));

  select r.* into v_existing
  from crm_private.gpt_action_receipts r
  where r.gpt_client_id = v_context.gpt_client_id
    and r.actor_profile_id = auth.uid()
    and r.request_id = p_request_id;

  if found then
    if v_existing.operation <> 'cancel_appointment'
       or v_existing.request_hash <> v_hash then
      raise exception 'request_id was already used for a different GPT action'
        using errcode = '22023';
    end if;
    return v_existing.response;
  end if;

  select s.artist_id, s.calendar_version
    into v_current_artist, v_current_version
  from public.sessions s
  where s.id = p_appointment_id
  for update;

  if not found or v_current_artist <> v_context.artist_id then
    raise exception 'appointment does not exist in this GPT artist scope'
      using errcode = '42501';
  end if;
  if p_expected_calendar_version is null
     or p_expected_calendar_version <> v_current_version then
    raise exception 'appointment changed since it was read; refresh before cancelling'
      using errcode = '40001';
  end if;

  v_result := public.set_appointment_status(
    p_appointment_id, 'cancelled'
  ) || jsonb_build_object(
    'calendar_version', v_current_version + 1,
    'idempotent_replay', false
  );

  insert into crm_private.gpt_action_receipts (
    gpt_client_id, actor_profile_id, request_id, operation,
    request_hash, appointment_id, response
  ) values (
    v_context.gpt_client_id, auth.uid(), p_request_id,
    'cancel_appointment', v_hash, p_appointment_id, v_result
  );

  insert into public.activity_log (
    event_type, actor_profile_id, actor_kind, session_id, metadata
  ) values (
    'appointment.ai_cancelled', auth.uid(), 'ai', p_appointment_id,
    jsonb_build_object(
      'integration', v_context.integration_key,
      'operation', 'cancel_appointment'
    )
  );

  return v_result;
end;
$$;

-- Closed object privileges: only the seven named RPCs are callable with an
-- authenticated Supabase OAuth access token. Direct table access remains closed.
revoke all on function public.gpt_list_appointments(timestamptz,timestamptz,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_get_appointment(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_list_appointment_conflicts(timestamptz,timestamptz,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_schedule_appointment(uuid,uuid,public.appointment_type,timestamptz,timestamptz,public.session_status,uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_reschedule_appointment(uuid,uuid,integer,timestamptz,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_cancel_appointment(uuid,uuid,integer)
  from public, anon, authenticated, service_role;

grant execute on function public.gpt_list_appointments(timestamptz,timestamptz,integer)
  to authenticated;
grant execute on function public.gpt_get_appointment(uuid)
  to authenticated;
grant execute on function public.gpt_list_appointment_conflicts(timestamptz,timestamptz,uuid)
  to authenticated;
grant execute on function public.gpt_schedule_appointment(uuid,uuid,public.appointment_type,timestamptz,timestamptz,public.session_status,uuid,uuid,text)
  to authenticated;
grant execute on function public.gpt_reschedule_appointment(uuid,uuid,integer,timestamptz,timestamptz)
  to authenticated;
grant execute on function public.gpt_cancel_appointment(uuid,uuid,integer)
  to authenticated;

comment on function public.gpt_list_appointments(timestamptz,timestamptz,integer) is
  'OAuth-client-bound appointment listing. Artist scope is derived from auth.jwt().client_id, never from GPT input.';
comment on function public.gpt_schedule_appointment(uuid,uuid,public.appointment_type,timestamptz,timestamptz,public.session_status,uuid,uuid,text) is
  'Idempotent AI-assisted appointment creation executed with the authenticated human identity and fixed OAuth-client artist scope.';
comment on function public.gpt_reschedule_appointment(uuid,uuid,integer,timestamptz,timestamptz) is
  'Idempotent AI-assisted reschedule with fixed artist scope and optimistic calendar_version protection.';
comment on function public.gpt_cancel_appointment(uuid,uuid,integer) is
  'Idempotent AI-assisted cancellation with fixed artist scope and optimistic calendar_version protection.';
