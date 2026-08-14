-- 0033_gpt_appointment_actions_hardening.sql
--
-- Harden the inactive GPT appointment action foundation before any OAuth client
-- or endpoint can be enabled. This migration adds a fixed-artist client lookup,
-- rejects cross-artist scheduling, upgrades idempotency hashes to SHA-256 and
-- records accurate replay/version results.

-- ---------------------------------------------------------------------------
-- Strong idempotency hashes
-- ---------------------------------------------------------------------------

alter table crm_private.gpt_action_receipts
  drop constraint gpt_action_receipts_hash_shape;

alter table crm_private.gpt_action_receipts
  add constraint gpt_action_receipts_hash_shape
  check (request_hash ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------------
-- Fixed-artist client scope
-- ---------------------------------------------------------------------------

create or replace function crm_private.gpt_client_in_artist_scope(
  p_client_id uuid,
  p_artist_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1
    from public.clients c
    where c.id = p_client_id
      and (
        exists (
          select 1
          from public.enquiries e
          where e.client_id = c.id
            and e.artist_id = p_artist_id
        )
        or exists (
          select 1
          from public.projects p
          where p.client_id = c.id
            and p.artist_id = p_artist_id
        )
        or exists (
          select 1
          from public.sessions s
          where s.client_id = c.id
            and s.artist_id = p_artist_id
        )
      )
  );
$$;

revoke all on function crm_private.gpt_client_in_artist_scope(uuid,uuid)
  from public, anon, authenticated, service_role;

create or replace function public.gpt_search_clients(
  p_query text,
  p_limit integer default 10
)
returns table (
  client_id uuid,
  client_name text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_query text;
  v_limit integer;
begin
  v_query := nullif(btrim(p_query), '');
  if v_query is null or char_length(v_query) < 2 then
    raise exception 'client search requires at least two characters'
      using errcode = '22023';
  end if;
  if char_length(v_query) > 100 then
    raise exception 'client search may not exceed 100 characters'
      using errcode = '22023';
  end if;

  select c.artist_id into v_artist_id
  from crm_private.require_gpt_action_context(false) c;
  v_limit := least(greatest(coalesce(p_limit, 10), 1), 20);

  return query
  select c.id, c.full_name
  from public.clients c
  where strpos(lower(c.full_name), lower(v_query)) > 0
    and crm_private.gpt_client_in_artist_scope(c.id, v_artist_id)
  order by lower(c.full_name), c.id
  limit v_limit;
end;
$$;

revoke all on function public.gpt_search_clients(text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.gpt_search_clients(text,integer)
  to authenticated;

comment on function public.gpt_search_clients(text,integer) is
  'Searches client names only inside the OAuth client fixed artist scope. Contact details are never returned.';

-- ---------------------------------------------------------------------------
-- Owner configuration audit retains artist scope
-- ---------------------------------------------------------------------------

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
    event_type, actor_profile_id, actor_kind, artist_id, metadata
  ) values (
    'gpt.client_configured',
    auth.uid(),
    'owner',
    v_client.artist_id,
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

-- ---------------------------------------------------------------------------
-- Idempotent, fixed-artist writes
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
set search_path = pg_catalog, public, crm_private, extensions
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

  if not crm_private.gpt_client_in_artist_scope(
    p_client_id,
    v_context.artist_id
  ) then
    raise exception 'client does not exist in this GPT artist scope'
      using errcode = '42501';
  end if;

  v_hash := encode(digest(jsonb_build_object(
    'client', p_client_id,
    'appointment_type', p_appointment_type,
    'start_at', p_start_at,
    'end_at', p_end_at,
    'status', p_status,
    'enquiry', p_enquiry_id,
    'project', p_project_id,
    'notes', p_notes
  )::text, 'sha256'), 'hex');

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
    return v_existing.response || jsonb_build_object('idempotent_replay', true);
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
    event_type, actor_profile_id, actor_kind, artist_id, session_id, metadata
  ) values (
    'appointment.ai_scheduled', auth.uid(), 'ai', v_context.artist_id,
    v_appointment_id,
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
set search_path = pg_catalog, public, crm_private, extensions
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

  v_hash := encode(digest(jsonb_build_object(
    'appointment', p_appointment_id,
    'expected_calendar_version', p_expected_calendar_version,
    'start_at', p_start_at,
    'end_at', p_end_at
  )::text, 'sha256'), 'hex');

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
    return v_existing.response || jsonb_build_object('idempotent_replay', true);
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
    event_type, actor_profile_id, actor_kind, artist_id, session_id, metadata
  ) values (
    'appointment.ai_rescheduled', auth.uid(), 'ai', v_context.artist_id,
    p_appointment_id,
    jsonb_build_object(
      'integration', v_context.integration_key,
      'operation', 'reschedule_appointment',
      'changed', coalesce((v_result ->> 'changed')::boolean, false)
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
set search_path = pg_catalog, public, crm_private, extensions
as $$
declare
  v_context record;
  v_hash text;
  v_existing crm_private.gpt_action_receipts%rowtype;
  v_current_artist uuid;
  v_current_version integer;
  v_after_version integer;
  v_after_sync public.calendar_sync_status;
  v_result jsonb;
begin
  if p_request_id is null then
    raise exception 'request_id is required' using errcode = '22023';
  end if;

  select * into v_context
  from crm_private.require_gpt_action_context(true);

  v_hash := encode(digest(jsonb_build_object(
    'appointment', p_appointment_id,
    'expected_calendar_version', p_expected_calendar_version
  )::text, 'sha256'), 'hex');

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
    return v_existing.response || jsonb_build_object('idempotent_replay', true);
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
  );

  select s.calendar_version, s.calendar_sync_status
    into v_after_version, v_after_sync
  from public.sessions s
  where s.id = p_appointment_id;

  v_result := v_result || jsonb_build_object(
    'calendar_version', v_after_version,
    'calendar_sync_status', v_after_sync,
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
    event_type, actor_profile_id, actor_kind, artist_id, session_id, metadata
  ) values (
    'appointment.ai_cancelled', auth.uid(), 'ai', v_context.artist_id,
    p_appointment_id,
    jsonb_build_object(
      'integration', v_context.integration_key,
      'operation', 'cancel_appointment',
      'changed', coalesce((v_result ->> 'changed')::boolean, false)
    )
  );

  return v_result;
end;
$$;

revoke all on function public.gpt_schedule_appointment(uuid,uuid,public.appointment_type,timestamptz,timestamptz,public.session_status,uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_reschedule_appointment(uuid,uuid,integer,timestamptz,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_cancel_appointment(uuid,uuid,integer)
  from public, anon, authenticated, service_role;

grant execute on function public.gpt_schedule_appointment(uuid,uuid,public.appointment_type,timestamptz,timestamptz,public.session_status,uuid,uuid,text)
  to authenticated;
grant execute on function public.gpt_reschedule_appointment(uuid,uuid,integer,timestamptz,timestamptz)
  to authenticated;
grant execute on function public.gpt_cancel_appointment(uuid,uuid,integer)
  to authenticated;
