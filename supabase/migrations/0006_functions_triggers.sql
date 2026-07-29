-- 0006_functions_triggers.sql
--
-- Access-control helpers, timestamp triggers, the atomic intake RPC and the
-- narrow workflow RPCs that are the only way the CRM writes data.
--
-- Every SECURITY DEFINER function in this file:
--   * sets a fixed search_path;
--   * has EXECUTE revoked from PUBLIC and granted only where needed;
--   * validates the caller's role and its arguments;
--   * performs one narrow operation and never accepts SQL, a table name or a
--     dynamic filter from the caller;
--   * writes an activity_log row in the same transaction for state changes.
--
-- Forward-only.

-- ---------------------------------------------------------------------------
-- Access mirror
--
-- Access-control helpers must be callable from inside RLS policies, including
-- the policies on `profiles` itself. A helper that read `public.profiles`
-- directly would be evaluated while checking `public.profiles`, which
-- PostgreSQL rejects as infinite policy recursion, and FORCE ROW LEVEL
-- SECURITY means a SECURITY DEFINER owner does not escape that.
--
-- `crm_private.profile_access` is therefore a trigger-maintained mirror of the
-- two columns access control needs. It lives in the private schema, carries no
-- RLS, and is reachable only from SECURITY DEFINER helpers. A test asserts it
-- stays in step with `public.profiles`.
-- ---------------------------------------------------------------------------

create table if not exists crm_private.profile_access (
  profile_id uuid primary key,
  role       public.crm_role not null,
  is_active  boolean not null
);

revoke all on crm_private.profile_access from public;

create or replace function crm_private.sync_profile_access()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if tg_op = 'DELETE' then
    delete from crm_private.profile_access where profile_id = old.id;
    return old;
  end if;

  insert into crm_private.profile_access (profile_id, role, is_active)
  values (new.id, new.role, new.is_active)
  on conflict (profile_id) do update
    set role = excluded.role,
        is_active = excluded.is_active;

  return new;
end;
$$;

drop trigger if exists profiles_sync_access on public.profiles;
create trigger profiles_sync_access
  after insert or update or delete on public.profiles
  for each row execute function crm_private.sync_profile_access();

-- Backfill for any profile that already exists.
insert into crm_private.profile_access (profile_id, role, is_active)
select p.id, p.role, p.is_active from public.profiles p
on conflict (profile_id) do update
  set role = excluded.role, is_active = excluded.is_active;

-- ---------------------------------------------------------------------------
-- Role and active-user helpers
-- ---------------------------------------------------------------------------

create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1 from crm_private.profile_access a
    where a.profile_id = auth.uid() and a.is_active
  );
$$;

comment on function public.is_active_user() is
  'True only when the JWT subject has a profile row and that profile is active. Deactivation takes effect immediately.';

create or replace function public.current_crm_role()
returns public.crm_role
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select a.role from crm_private.profile_access a
  where a.profile_id = auth.uid() and a.is_active;
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1 from crm_private.profile_access a
    where a.profile_id = auth.uid() and a.is_active and a.role = 'owner'
  );
$$;

create or replace function public.can_manage_crm()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1 from crm_private.profile_access a
    where a.profile_id = auth.uid() and a.is_active
      and a.role in ('owner', 'booking_manager')
  );
$$;

comment on function public.can_manage_crm() is
  'Owner or booking_manager. read_only never returns true.';

revoke all on function public.is_active_user() from public;
revoke all on function public.current_crm_role() from public;
revoke all on function public.is_owner() from public;
revoke all on function public.can_manage_crm() from public;
grant execute on function public.is_active_user() to authenticated, service_role;
grant execute on function public.current_crm_role() to authenticated, service_role;
grant execute on function public.is_owner() to authenticated, service_role;
grant execute on function public.can_manage_crm() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Trusted backend identity
--
-- The Worker's intake RPCs run without an `auth.uid()`: there is no logged-in
-- staff member behind a public form submission. They are identified instead by
-- the verified JWT role, which is what Supabase already uses to distinguish a
-- service-role call from a browser session.
--
-- Reading the claim rather than `current_user` is deliberate: inside a
-- SECURITY DEFINER function `current_user` is the function owner, so it cannot
-- tell a Worker call apart from a staff call.
--
-- This is not the only barrier. `anon` and `authenticated` hold no INSERT,
-- UPDATE or DELETE grant on any CRM table (migration 0007), so the table
-- privilege check refuses a browser write before RLS is consulted at all.
-- ---------------------------------------------------------------------------

create or replace function crm_private.jwt_role()
returns text
language sql
stable
as $$
  select coalesce(
    (coalesce(nullif(pg_catalog.current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role'),
    nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    'anon'
  );
$$;

create or replace function crm_private.is_service_backend()
returns boolean
language sql
stable
as $$
  select crm_private.jwt_role() = 'service_role';
$$;

-- True only while the CRM has no active owner at all. This is what lets the
-- very first owner be promoted under RLS without any bypass, and it closes
-- itself permanently the moment that owner exists.
create or replace function crm_private.no_active_owner()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select not exists (
    select 1 from crm_private.profile_access a where a.is_active and a.role = 'owner'
  );
$$;

revoke all on function crm_private.jwt_role() from public;
revoke all on function crm_private.is_service_backend() from public;
revoke all on function crm_private.no_active_owner() from public;
grant execute on function crm_private.jwt_role() to authenticated, service_role;
grant execute on function crm_private.is_service_backend() to authenticated, service_role;
grant execute on function crm_private.no_active_owner() to authenticated, service_role;

-- These three helpers appear inside RLS policies, so the roles the policies
-- apply to must be able to resolve them — which needs USAGE on the schema.
--
-- USAGE is not access: every object in `crm_private` had its privileges revoked
-- when the schema was created, and only these three functions are granted back.
-- `crm_private.profile_access`, `require_role()` and `enqueue_outbox()` stay
-- unreachable from a browser session, and there are tests that say so.
grant usage on schema crm_private to authenticated, service_role;

-- Raises rather than returning false, so an RPC cannot accidentally continue
-- after a failed check.
create or replace function crm_private.require_role(variadic p_roles public.crm_role[])
returns public.crm_role
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_role public.crm_role;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select a.role into v_role
  from crm_private.profile_access a
  where a.profile_id = auth.uid() and a.is_active;

  if v_role is null then
    raise exception 'no active CRM profile for this account' using errcode = '42501';
  end if;

  if not (v_role = any (p_roles)) then
    raise exception 'role % is not permitted to perform this operation', v_role
      using errcode = '42501';
  end if;

  return v_role;
end;
$$;

-- ---------------------------------------------------------------------------
-- Timestamps
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function crm_private.touch_enquiry_last_action()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  new.updated_at := now();
  if new.status is distinct from old.status
     or new.assigned_to is distinct from old.assigned_to
     or new.intake_state is distinct from old.intake_state then
    new.last_action_at := now();
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'clients', 'projects', 'sessions',
    'internal_notes', 'email_messages', 'follow_ups', 'integration_outbox'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
      t || '_set_updated_at', t
    );
  end loop;
end $$;

drop trigger if exists enquiries_touch_last_action on public.enquiries;
create trigger enquiries_touch_last_action
  before update on public.enquiries
  for each row execute function crm_private.touch_enquiry_last_action();

-- ---------------------------------------------------------------------------
-- Activity helper
-- ---------------------------------------------------------------------------

create or replace function crm_private.log_activity(
  p_event_type      text,
  p_actor_kind      text default 'system',
  p_actor_profile_id uuid default null,
  p_client_id       uuid default null,
  p_enquiry_id      uuid default null,
  p_project_id      uuid default null,
  p_session_id      uuid default null,
  p_profile_id      uuid default null,
  p_enquiry_file_id uuid default null,
  p_project_file_id uuid default null,
  p_outbox_id       uuid default null,
  p_metadata        jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  -- The id is generated here rather than read back with RETURNING. PostgreSQL
  -- applies the table's SELECT policy to a RETURNING clause, and the activity
  -- log is deliberately not readable by every caller that must be able to
  -- append to it — the Worker, and the very first owner bootstrap, among them.
  v_id uuid := gen_random_uuid();
begin
  insert into public.activity_log (
    id, event_type, actor_kind, actor_profile_id,
    client_id, enquiry_id, project_id, session_id, profile_id,
    enquiry_file_id, project_file_id, outbox_id, metadata
  ) values (
    v_id, p_event_type, p_actor_kind, p_actor_profile_id,
    p_client_id, p_enquiry_id, p_project_id, p_session_id, p_profile_id,
    p_enquiry_file_id, p_project_file_id, p_outbox_id, coalesce(p_metadata, '{}'::jsonb)
  );

  return v_id;
end;
$$;

-- Narrow, staff-facing activity creation. The event type is restricted to an
-- allow-list so the audit trail cannot be filled with arbitrary claims.
create or replace function public.record_activity(
  p_event_type text,
  p_client_id  uuid default null,
  p_enquiry_id uuid default null,
  p_project_id uuid default null,
  p_session_id uuid default null,
  p_metadata   jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_role public.crm_role;
begin
  v_role := crm_private.require_role('owner', 'booking_manager');

  if p_event_type not in (
    'client.contacted', 'client.no_response', 'enquiry.reviewed',
    'enquiry.reference_requested', 'project.updated', 'session.updated'
  ) then
    raise exception 'event type % may not be recorded manually', p_event_type
      using errcode = '42501';
  end if;

  if num_nonnulls(p_client_id, p_enquiry_id, p_project_id, p_session_id) = 0 then
    raise exception 'an activity entry must reference at least one entity' using errcode = '22023';
  end if;

  return crm_private.log_activity(
    p_event_type,
    case when v_role = 'owner' then 'owner' else 'staff' end,
    auth.uid(),
    p_client_id, p_enquiry_id, p_project_id, p_session_id,
    null, null, null, null,
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.record_activity(text, uuid, uuid, uuid, uuid, jsonb) from public;
grant execute on function public.record_activity(text, uuid, uuid, uuid, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Outbox enqueue
--
-- `INSERT ... ON CONFLICT` is deliberately NOT used here. PostgreSQL applies
-- the table's SELECT policy when resolving a conflict, and `integration_outbox`
-- is readable only by the owner and the Worker — so a booking manager
-- scheduling a session would be refused. Catching the unique violation gives
-- exactly the same "an identical job is already queued" semantics without
-- requiring read access to the queue.
-- ---------------------------------------------------------------------------

create or replace function crm_private.enqueue_outbox(
  p_kind             public.outbox_kind,
  p_dedupe_key       text,
  p_payload          jsonb default '{}'::jsonb,
  p_client_id        uuid default null,
  p_enquiry_id       uuid default null,
  p_project_id       uuid default null,
  p_session_id       uuid default null,
  p_email_message_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into public.integration_outbox (
    id, kind, dedupe_key, payload, client_id, enquiry_id, project_id, session_id, email_message_id
  ) values (
    v_id, p_kind, p_dedupe_key, coalesce(p_payload, '{}'::jsonb),
    p_client_id, p_enquiry_id, p_project_id, p_session_id, p_email_message_id
  );
  return v_id;
exception when unique_violation then
  -- The same logical job is already queued. That is the dedupe key doing its
  -- job, not an error.
  return null;
end;
$$;

revoke all on function crm_private.enqueue_outbox(
  public.outbox_kind, text, jsonb, uuid, uuid, uuid, uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- Atomic enquiry intake
--
-- Called by the Cloudflare Worker with `service_role`. One transaction:
-- claim the idempotency key, find or create the client, create the enquiry,
-- create pending file manifests, write the creation activity, enqueue the
-- Telegram notification. A replay returns the original record untouched.
-- ---------------------------------------------------------------------------

create or replace function public.create_enquiry_intake(
  p_idempotency_key uuid,
  p_client          jsonb,
  p_enquiry         jsonb,
  p_files           jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_email_norm    text;
  v_phone_norm    text;
  v_full_name     text;
  v_client_id     uuid;
  v_email_client  uuid;
  v_phone_client  uuid;
  v_match_method  text := 'created';
  v_conflict      boolean := false;
  v_enquiry_id    uuid;
  v_reference     text;
  v_file          jsonb;
  v_file_id       uuid;
  v_file_count    integer;
  v_files_out     jsonb := '[]'::jsonb;
  v_existing      public.enquiries%rowtype;
  v_outbox_id     uuid;
begin
  if p_idempotency_key is null then
    raise exception 'idempotency key is required' using errcode = '22023';
  end if;

  -- Serialise concurrent retries of the same submission for this transaction.
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  -- ---- Replay -------------------------------------------------------------
  select * into v_existing from public.enquiries e where e.idempotency_key = p_idempotency_key;
  if found then
    select coalesce(
      jsonb_agg(jsonb_build_object(
        'file_id', f.id,
        'storage_path', f.storage_path,
        'upload_state', f.upload_state,
        'mime_type', f.mime_type,
        'safe_extension', f.safe_extension
      ) order by f.created_at),
      '[]'::jsonb
    ) into v_files_out
    from public.enquiry_files f where f.enquiry_id = v_existing.id;

    return jsonb_build_object(
      'enquiry_id', v_existing.id,
      'client_id', v_existing.client_id,
      'reference_number', v_existing.reference_number,
      'intake_state', v_existing.intake_state,
      'replayed', true,
      'client_conflict', false,
      'client_match_method', 'replay',
      'files', v_files_out
    );
  end if;

  -- ---- Validate -----------------------------------------------------------
  v_full_name := btrim(coalesce(p_client ->> 'full_name', ''));
  if v_full_name = '' then
    raise exception 'client full_name is required' using errcode = '22023';
  end if;

  v_email_norm := public.normalize_email(p_client ->> 'email');
  if v_email_norm is null then
    raise exception 'a valid client email is required' using errcode = '22023';
  end if;

  v_phone_norm := public.normalize_phone(p_client ->> 'phone');

  if p_files is null or jsonb_typeof(p_files) <> 'array' then
    raise exception 'file descriptors must be an array' using errcode = '22023';
  end if;

  v_file_count := jsonb_array_length(p_files);
  if v_file_count < 1 or v_file_count > 3 then
    raise exception 'between 1 and 3 reference files are required, received %', v_file_count
      using errcode = '22023';
  end if;

  -- ---- Client matching ----------------------------------------------------
  -- Email first. Phone only when it normalised to an international number.
  -- Names are never used to match: two different people share a name far more
  -- often than they share an address, and a wrong merge is unrecoverable.
  select c.id into v_email_client
  from public.clients c
  where c.email_normalized = v_email_norm and c.archived_at is null
  order by c.created_at
  limit 1;

  if v_phone_norm is not null then
    select c.id into v_phone_client
    from public.clients c
    where c.phone_normalized = v_phone_norm and c.archived_at is null
    order by c.created_at
    limit 1;
  end if;

  if v_email_client is not null and v_phone_client is not null
     and v_email_client <> v_phone_client then
    -- Two identifiers point at two different people. Do not merge. Attach to
    -- the email match (the stronger identifier) and raise a reviewable event.
    v_conflict := true;
    v_client_id := v_email_client;
    v_match_method := 'email_with_phone_conflict';
  elsif v_email_client is not null then
    v_client_id := v_email_client;
    v_match_method := 'email';
  elsif v_phone_client is not null then
    v_client_id := v_phone_client;
    v_match_method := 'phone';
  end if;

  if v_client_id is null then
    insert into public.clients (
      full_name, email, phone, instagram, preferred_contact, travelling_from
    ) values (
      left(v_full_name, 160),
      nullif(btrim(coalesce(p_client ->> 'email', '')), ''),
      nullif(btrim(coalesce(p_client ->> 'phone', '')), ''),
      nullif(btrim(coalesce(p_client ->> 'instagram', '')), ''),
      nullif(btrim(coalesce(p_client ->> 'preferred_contact', '')), ''),
      nullif(btrim(coalesce(p_client ->> 'travelling_from', '')), '')
    )
    returning id into v_client_id;

    perform crm_private.log_activity(
      'client.created', 'worker', null, v_client_id, null, null, null, null,
      null, null, null, jsonb_build_object('match_method', v_match_method)
    );
  else
    -- Fill gaps only. An existing non-null contact value is never overwritten
    -- by a new form submission.
    update public.clients c set
      phone = coalesce(c.phone, nullif(btrim(coalesce(p_client ->> 'phone', '')), '')),
      instagram = coalesce(c.instagram, nullif(btrim(coalesce(p_client ->> 'instagram', '')), '')),
      travelling_from = coalesce(c.travelling_from, nullif(btrim(coalesce(p_client ->> 'travelling_from', '')), '')),
      preferred_contact = coalesce(nullif(btrim(coalesce(p_client ->> 'preferred_contact', '')), ''), c.preferred_contact)
    where c.id = v_client_id;
  end if;

  -- ---- Enquiry ------------------------------------------------------------
  insert into public.enquiries (
    client_id, reference_number, idempotency_key, status, intake_state,
    project_type, placement, approximate_size, cover_up, preferred_timing, idea,
    source, landing_page, referrer,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term
  ) values (
    v_client_id, 'PENDING', p_idempotency_key, 'new', 'files_pending',
    left(nullif(btrim(coalesce(p_enquiry ->> 'project_type', '')), ''), 100),
    left(nullif(btrim(coalesce(p_enquiry ->> 'placement', '')), ''), 160),
    left(nullif(btrim(coalesce(p_enquiry ->> 'approximate_size', '')), ''), 120),
    left(nullif(btrim(coalesce(p_enquiry ->> 'cover_up', '')), ''), 40),
    left(nullif(btrim(coalesce(p_enquiry ->> 'preferred_timing', '')), ''), 160),
    left(nullif(btrim(coalesce(p_enquiry ->> 'idea', '')), ''), 4000),
    left(nullif(btrim(coalesce(p_enquiry ->> 'source', '')), ''), 200),
    left(nullif(btrim(coalesce(p_enquiry ->> 'landing_page', '')), ''), 500),
    left(nullif(btrim(coalesce(p_enquiry ->> 'referrer', '')), ''), 500),
    left(nullif(btrim(coalesce(p_enquiry ->> 'utm_source', '')), ''), 120),
    left(nullif(btrim(coalesce(p_enquiry ->> 'utm_medium', '')), ''), 120),
    left(nullif(btrim(coalesce(p_enquiry ->> 'utm_campaign', '')), ''), 160),
    left(nullif(btrim(coalesce(p_enquiry ->> 'utm_content', '')), ''), 160),
    left(nullif(btrim(coalesce(p_enquiry ->> 'utm_term', '')), ''), 160)
  )
  returning id, reference_number into v_enquiry_id, v_reference;

  -- ---- File manifests -----------------------------------------------------
  for v_file in select * from jsonb_array_elements(p_files) loop
    v_file_id := gen_random_uuid();

    insert into public.enquiry_files (
      id, enquiry_id, category, storage_path, original_filename,
      safe_extension, mime_type, byte_size, checksum, upload_state
    ) values (
      v_file_id,
      v_enquiry_id,
      'reference',
      public.enquiry_file_storage_path(v_client_id, v_enquiry_id, v_file_id, v_file ->> 'safe_extension'),
      left(nullif(btrim(coalesce(v_file ->> 'original_filename', '')), ''), 255),
      v_file ->> 'safe_extension',
      v_file ->> 'mime_type',
      (v_file ->> 'byte_size')::bigint,
      nullif(btrim(coalesce(v_file ->> 'checksum', '')), ''),
      'pending'
    );

    v_files_out := v_files_out || jsonb_build_object(
      'file_id', v_file_id,
      'storage_path', public.enquiry_file_storage_path(v_client_id, v_enquiry_id, v_file_id, v_file ->> 'safe_extension'),
      'upload_state', 'pending',
      'mime_type', v_file ->> 'mime_type',
      'safe_extension', v_file ->> 'safe_extension'
    );
  end loop;

  -- ---- Activity -----------------------------------------------------------
  perform crm_private.log_activity(
    'enquiry.created', 'worker', null, v_client_id, v_enquiry_id, null, null, null,
    null, null, null,
    jsonb_build_object(
      'reference_number', v_reference,
      'file_count', v_file_count,
      'client_match_method', v_match_method,
      'source', nullif(btrim(coalesce(p_enquiry ->> 'source', '')), ''),
      'utm_source', nullif(btrim(coalesce(p_enquiry ->> 'utm_source', '')), '')
    )
  );

  if v_conflict then
    perform crm_private.log_activity(
      'client.identifier_conflict', 'worker', null, v_client_id, v_enquiry_id,
      null, null, null, null, null, null,
      jsonb_build_object(
        'attached_to', 'email_match',
        'other_client_id', v_phone_client,
        'requires_review', true
      )
    );
  end if;

  -- ---- Outbox -------------------------------------------------------------
  -- Enqueued now, delivered after commit. Telegram is a notification, so a
  -- failure here can never invalidate the enquiry that was just committed.
  v_outbox_id := crm_private.enqueue_outbox(
    'telegram_notification',
    'telegram:enquiry_created:' || v_enquiry_id,
    jsonb_build_object('reference_number', v_reference, 'file_count', v_file_count),
    v_client_id,
    v_enquiry_id
  );

  return jsonb_build_object(
    'enquiry_id', v_enquiry_id,
    'client_id', v_client_id,
    'reference_number', v_reference,
    'intake_state', 'files_pending',
    'replayed', false,
    'client_conflict', v_conflict,
    'client_match_method', v_match_method,
    'outbox_id', v_outbox_id,
    'files', v_files_out
  );
end;
$$;

revoke all on function public.create_enquiry_intake(uuid, jsonb, jsonb, jsonb) from public;
grant execute on function public.create_enquiry_intake(uuid, jsonb, jsonb, jsonb) to service_role;

comment on function public.create_enquiry_intake(uuid, jsonb, jsonb, jsonb) is
  'Atomic enquiry intake for the trusted Worker. Replays return the original enquiry. Never matches clients by name.';

-- ---------------------------------------------------------------------------
-- Intake completion, failure and reconciliation
-- ---------------------------------------------------------------------------

create or replace function public.mark_enquiry_file_uploaded(
  p_file_id  uuid,
  p_checksum text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry_id uuid;
begin
  update public.enquiry_files f
  set upload_state = 'ready',
      uploaded_at = now(),
      checksum = coalesce(nullif(btrim(coalesce(p_checksum, '')), ''), f.checksum)
  where f.id = p_file_id
  returning f.enquiry_id into v_enquiry_id;

  if v_enquiry_id is null then
    raise exception 'file manifest % does not exist', p_file_id using errcode = '23503';
  end if;

  return jsonb_build_object('file_id', p_file_id, 'enquiry_id', v_enquiry_id, 'upload_state', 'ready');
end;
$$;

create or replace function public.finalize_enquiry_intake(p_enquiry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_pending integer;
  v_state   public.enquiry_intake_state;
  v_ref     text;
begin
  select count(*) into v_pending
  from public.enquiry_files f
  where f.enquiry_id = p_enquiry_id and f.upload_state <> 'ready';

  if v_pending > 0 then
    raise exception '% file manifests are not ready', v_pending using errcode = '22023';
  end if;

  update public.enquiries e
  set intake_state = 'complete', intake_error_code = null
  where e.id = p_enquiry_id
  returning e.intake_state, e.reference_number into v_state, v_ref;

  if v_state is null then
    raise exception 'enquiry % does not exist', p_enquiry_id using errcode = '23503';
  end if;

  perform crm_private.log_activity(
    'enquiry.intake_completed', 'worker', null, null, p_enquiry_id,
    null, null, null, null, null, null,
    jsonb_build_object('reference_number', v_ref)
  );

  return jsonb_build_object('enquiry_id', p_enquiry_id, 'intake_state', 'complete', 'reference_number', v_ref);
end;
$$;

create or replace function public.fail_enquiry_intake(
  p_enquiry_id uuid,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if p_error_code !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'intake error code must be a short machine code' using errcode = '22023';
  end if;

  update public.enquiry_files f
  set upload_state = 'failed'
  where f.enquiry_id = p_enquiry_id and f.upload_state <> 'ready';

  update public.enquiries e
  set intake_state = 'failed', intake_error_code = p_error_code
  where e.id = p_enquiry_id;

  if not found then
    raise exception 'enquiry % does not exist', p_enquiry_id using errcode = '23503';
  end if;

  perform crm_private.log_activity(
    'enquiry.intake_failed', 'worker', null, null, p_enquiry_id,
    null, null, null, null, null, null,
    jsonb_build_object('error_code', p_error_code)
  );

  return jsonb_build_object('enquiry_id', p_enquiry_id, 'intake_state', 'failed', 'error_code', p_error_code);
end;
$$;

-- Returns intakes that never completed, for the reconciliation sweep.
create or replace function public.list_incomplete_intakes(
  p_older_than_minutes integer default 15,
  p_limit integer default 50
)
returns table (
  enquiry_id uuid,
  client_id uuid,
  intake_state public.enquiry_intake_state,
  created_at timestamptz,
  pending_files bigint
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select e.id, e.client_id, e.intake_state, e.created_at,
         count(f.id) filter (where f.upload_state <> 'ready')
  from public.enquiries e
  left join public.enquiry_files f on f.enquiry_id = e.id
  where e.intake_state in ('pending', 'files_pending', 'failed')
    -- 0 means "every incomplete intake", which an operator needs when
    -- investigating; the default grace period keeps a sweep from racing an
    -- upload that is still in progress.
    and e.created_at <= now() - make_interval(mins => greatest(coalesce(p_older_than_minutes, 15), 0))
  group by e.id
  order by e.created_at
  limit least(greatest(p_limit, 1), 200);
$$;

revoke all on function public.mark_enquiry_file_uploaded(uuid, text) from public;
revoke all on function public.finalize_enquiry_intake(uuid) from public;
revoke all on function public.fail_enquiry_intake(uuid, text) from public;
revoke all on function public.list_incomplete_intakes(integer, integer) from public;
grant execute on function public.mark_enquiry_file_uploaded(uuid, text) to service_role;
grant execute on function public.finalize_enquiry_intake(uuid) to service_role;
grant execute on function public.fail_enquiry_intake(uuid, text) to service_role;
grant execute on function public.list_incomplete_intakes(integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Enquiry workflow
-- ---------------------------------------------------------------------------

create or replace function public.transition_enquiry_status(
  p_enquiry_id uuid,
  p_to_status  public.enquiry_status
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_role       public.crm_role;
  v_from       public.enquiry_status;
  v_owner_only boolean;
begin
  v_role := crm_private.require_role('owner', 'booking_manager');

  select e.status into v_from from public.enquiries e where e.id = p_enquiry_id;
  if v_from is null then
    raise exception 'enquiry % does not exist', p_enquiry_id using errcode = '23503';
  end if;

  select t.owner_only into v_owner_only
  from public.enquiry_status_transitions t
  where t.from_status = v_from and t.to_status = p_to_status;

  if v_owner_only is null then
    raise exception 'transition % -> % is not allowed', v_from, p_to_status
      using errcode = '42501';
  end if;

  if v_owner_only and v_role <> 'owner' then
    raise exception 'transition % -> % is owner only', v_from, p_to_status
      using errcode = '42501';
  end if;

  update public.enquiries e set status = p_to_status where e.id = p_enquiry_id;

  perform crm_private.log_activity(
    'enquiry.status_changed',
    case when v_role = 'owner' then 'owner' else 'staff' end,
    auth.uid(), null, p_enquiry_id, null, null, null, null, null, null,
    jsonb_build_object('from_status', v_from, 'to_status', p_to_status)
  );

  return jsonb_build_object('enquiry_id', p_enquiry_id, 'from_status', v_from, 'to_status', p_to_status);
end;
$$;

create or replace function public.assign_enquiry(
  p_enquiry_id uuid,
  p_profile_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_role     public.crm_role;
  v_previous uuid;
begin
  v_role := crm_private.require_role('owner', 'booking_manager');

  if p_profile_id is not null and not exists (
    select 1 from crm_private.profile_access a
    where a.profile_id = p_profile_id and a.is_active and a.role in ('owner', 'booking_manager')
  ) then
    raise exception 'enquiries may only be assigned to an active owner or booking manager'
      using errcode = '22023';
  end if;

  select e.assigned_to into v_previous from public.enquiries e where e.id = p_enquiry_id;
  if not found then
    raise exception 'enquiry % does not exist', p_enquiry_id using errcode = '23503';
  end if;

  update public.enquiries e set assigned_to = p_profile_id where e.id = p_enquiry_id;

  perform crm_private.log_activity(
    'enquiry.assigned',
    case when v_role = 'owner' then 'owner' else 'staff' end,
    auth.uid(), null, p_enquiry_id, null, null, p_profile_id, null, null, null,
    jsonb_build_object('previous_assignee', v_previous)
  );

  return jsonb_build_object('enquiry_id', p_enquiry_id, 'assigned_to', p_profile_id);
end;
$$;

create or replace function public.convert_enquiry_to_project(
  p_enquiry_id uuid,
  p_title      text,
  p_description text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_role      public.crm_role;
  v_client_id uuid;
  v_state     public.enquiry_intake_state;
  v_project_id uuid;
begin
  v_role := crm_private.require_role('owner', 'booking_manager');

  select e.client_id, e.intake_state into v_client_id, v_state
  from public.enquiries e where e.id = p_enquiry_id;

  if v_client_id is null then
    raise exception 'enquiry % does not exist', p_enquiry_id using errcode = '23503';
  end if;

  if v_state <> 'complete' then
    raise exception 'enquiry % has not completed intake', p_enquiry_id using errcode = '22023';
  end if;

  if exists (select 1 from public.projects p where p.enquiry_id = p_enquiry_id) then
    raise exception 'enquiry % has already been converted to a project', p_enquiry_id
      using errcode = '23505';
  end if;

  insert into public.projects (client_id, enquiry_id, status, title, description)
  values (v_client_id, p_enquiry_id, 'draft', left(btrim(p_title), 200), p_description)
  returning id into v_project_id;

  update public.enquiries e set status = 'converted' where e.id = p_enquiry_id;

  perform crm_private.log_activity(
    'enquiry.converted',
    case when v_role = 'owner' then 'owner' else 'staff' end,
    auth.uid(), v_client_id, p_enquiry_id, v_project_id, null, null, null, null, null,
    '{}'::jsonb
  );

  return jsonb_build_object('project_id', v_project_id, 'enquiry_id', p_enquiry_id, 'client_id', v_client_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------

create or replace function public.schedule_session(
  p_project_id uuid,
  p_start_at   timestamptz,
  p_end_at     timestamptz,
  p_status     public.session_status default 'proposed',
  p_notes      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_role       public.crm_role;
  v_session_id uuid;
  v_client_id  uuid;
begin
  v_role := crm_private.require_role('owner', 'booking_manager');

  if p_status not in ('draft', 'proposed', 'confirmed') then
    raise exception 'a session may only be created as draft, proposed or confirmed'
      using errcode = '22023';
  end if;

  select p.client_id into v_client_id from public.projects p where p.id = p_project_id;
  if v_client_id is null then
    raise exception 'project % does not exist', p_project_id using errcode = '23503';
  end if;

  insert into public.sessions (project_id, status, start_at, end_at, duration_hours, notes)
  values (
    p_project_id, p_status, p_start_at, p_end_at,
    round(extract(epoch from (p_end_at - p_start_at))::numeric / 3600, 2),
    p_notes
  )
  returning id into v_session_id;

  perform crm_private.log_activity(
    'session.scheduled',
    case when v_role = 'owner' then 'owner' else 'staff' end,
    auth.uid(), v_client_id, null, p_project_id, v_session_id, null, null, null, null,
    jsonb_build_object('status', p_status)
  );

  -- Calendar work is enqueued only for a confirmed session. Draft and proposed
  -- sessions never produce a calendar job, so a tentative date can never leak
  -- into the artist's calendar as a booking.
  if public.session_is_calendar_eligible(p_status) then
    perform crm_private.enqueue_outbox(
      'calendar_create',
      public.calendar_outbox_dedupe_key('create', v_session_id, 0),
      jsonb_build_object('session_id', v_session_id, 'calendar_version', 0),
      v_client_id, null, p_project_id, v_session_id
    );
  end if;

  return jsonb_build_object('session_id', v_session_id, 'project_id', p_project_id, 'status', p_status);
end;
$$;

create or replace function public.set_session_status(
  p_session_id uuid,
  p_status     public.session_status
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_role     public.crm_role;
  v_previous public.session_status;
  v_project  uuid;
  v_client   uuid;
  v_version  integer;
  v_event_id text;
begin
  v_role := crm_private.require_role('owner', 'booking_manager');

  select s.status, s.project_id, s.calendar_version, s.calendar_event_id, p.client_id
    into v_previous, v_project, v_version, v_event_id, v_client
  from public.sessions s join public.projects p on p.id = s.project_id
  where s.id = p_session_id;

  if v_previous is null then
    raise exception 'session % does not exist', p_session_id using errcode = '23503';
  end if;

  update public.sessions s
  set status = p_status,
      cancelled_at = case when p_status = 'cancelled' then now() else null end,
      calendar_version = s.calendar_version + 1
  where s.id = p_session_id;

  perform crm_private.log_activity(
    'session.status_changed',
    case when v_role = 'owner' then 'owner' else 'staff' end,
    auth.uid(), v_client, null, v_project, p_session_id, null, null, null, null,
    jsonb_build_object('from_status', v_previous, 'to_status', p_status)
  );

  if public.session_is_calendar_eligible(p_status) and v_event_id is null then
    perform crm_private.enqueue_outbox(
      'calendar_create', public.calendar_outbox_dedupe_key('create', p_session_id, v_version + 1),
      jsonb_build_object('session_id', p_session_id, 'calendar_version', v_version + 1),
      v_client, null, v_project, p_session_id
    );
  elsif p_status = 'cancelled' and v_event_id is not null then
    perform crm_private.enqueue_outbox(
      'calendar_cancel', public.calendar_outbox_dedupe_key('cancel', p_session_id, v_version + 1),
      jsonb_build_object('session_id', p_session_id, 'calendar_version', v_version + 1),
      v_client, null, v_project, p_session_id
    );
  elsif public.session_is_calendar_eligible(p_status) and v_event_id is not null then
    perform crm_private.enqueue_outbox(
      'calendar_update', public.calendar_outbox_dedupe_key('update', p_session_id, v_version + 1),
      jsonb_build_object('session_id', p_session_id, 'calendar_version', v_version + 1),
      v_client, null, v_project, p_session_id
    );
  end if;

  return jsonb_build_object('session_id', p_session_id, 'from_status', v_previous, 'to_status', p_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- Deposits (finance: owner only)
-- ---------------------------------------------------------------------------

create or replace function public.update_project_deposit(
  p_project_id     uuid,
  p_deposit_amount numeric,
  p_deposit_status public.deposit_status,
  p_currency       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_previous public.deposit_status;
  v_client   uuid;
begin
  perform crm_private.require_role('owner');

  if p_deposit_amount is not null and p_deposit_amount < 0 then
    raise exception 'deposit amount may not be negative' using errcode = '22023';
  end if;

  if p_currency is not null and p_currency !~ '^[A-Z]{3}$' then
    raise exception 'currency must be a three-letter ISO code' using errcode = '22023';
  end if;

  select p.deposit_status, p.client_id into v_previous, v_client
  from public.projects p where p.id = p_project_id;

  if v_client is null then
    raise exception 'project % does not exist', p_project_id using errcode = '23503';
  end if;

  update public.projects p
  set deposit_amount = p_deposit_amount,
      deposit_status = p_deposit_status,
      currency = coalesce(p_currency, p.currency)
  where p.id = p_project_id;

  -- The amount itself is finance data and is deliberately not copied into the
  -- audit trail; the state change and the actor are what the log records.
  perform crm_private.log_activity(
    'project.deposit_updated', 'owner', auth.uid(), v_client, null, p_project_id,
    null, null, null, null, null,
    jsonb_build_object('from_status', v_previous, 'to_status', p_deposit_status)
  );

  return jsonb_build_object('project_id', p_project_id, 'deposit_status', p_deposit_status);
end;
$$;

create or replace function public.update_project_estimate(
  p_project_id        uuid,
  p_hourly_rate       numeric default null,
  p_estimate_total    numeric default null,
  p_estimated_sessions integer default null,
  p_estimated_hours   numeric default null,
  p_currency          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client uuid;
begin
  perform crm_private.require_role('owner');

  if p_currency is not null and p_currency !~ '^[A-Z]{3}$' then
    raise exception 'currency must be a three-letter ISO code' using errcode = '22023';
  end if;

  select p.client_id into v_client from public.projects p where p.id = p_project_id;
  if v_client is null then
    raise exception 'project % does not exist', p_project_id using errcode = '23503';
  end if;

  update public.projects p
  set hourly_rate = coalesce(p_hourly_rate, p.hourly_rate),
      estimate_total = coalesce(p_estimate_total, p.estimate_total),
      estimated_sessions = coalesce(p_estimated_sessions, p.estimated_sessions),
      estimated_hours = coalesce(p_estimated_hours, p.estimated_hours),
      currency = coalesce(p_currency, p.currency)
  where p.id = p_project_id;

  perform crm_private.log_activity(
    'project.estimate_updated', 'owner', auth.uid(), v_client, null, p_project_id,
    null, null, null, null, null, '{}'::jsonb
  );

  return jsonb_build_object('project_id', p_project_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Notes and follow-ups
-- ---------------------------------------------------------------------------

create or replace function public.create_internal_note(
  p_body       text,
  p_client_id  uuid default null,
  p_enquiry_id uuid default null,
  p_project_id uuid default null,
  p_session_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid;
begin
  perform crm_private.require_role('owner', 'booking_manager');

  if num_nonnulls(p_client_id, p_enquiry_id, p_project_id, p_session_id) = 0 then
    raise exception 'a note must reference at least one entity' using errcode = '22023';
  end if;

  insert into public.internal_notes (author_profile_id, client_id, enquiry_id, project_id, session_id, body)
  values (auth.uid(), p_client_id, p_enquiry_id, p_project_id, p_session_id, p_body)
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.create_follow_up(
  p_subject    text,
  p_due_at     timestamptz,
  p_client_id  uuid default null,
  p_enquiry_id uuid default null,
  p_project_id uuid default null,
  p_assigned_to uuid default null,
  p_details    text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid;
begin
  perform crm_private.require_role('owner', 'booking_manager');

  if num_nonnulls(p_client_id, p_enquiry_id, p_project_id) = 0 then
    raise exception 'a follow-up must reference at least one entity' using errcode = '22023';
  end if;

  insert into public.follow_ups (subject, due_at, client_id, enquiry_id, project_id, assigned_to, created_by, details)
  values (p_subject, p_due_at, p_client_id, p_enquiry_id, p_project_id, p_assigned_to, auth.uid(), p_details)
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.complete_follow_up(p_follow_up_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_role('owner', 'booking_manager');

  update public.follow_ups f
  set status = 'done', completed_at = now(), cancelled_at = null
  where f.id = p_follow_up_id and f.status = 'open';

  if not found then
    raise exception 'follow-up % is not open', p_follow_up_id using errcode = '22023';
  end if;

  return jsonb_build_object('follow_up_id', p_follow_up_id, 'status', 'done');
end;
$$;

-- ---------------------------------------------------------------------------
-- Email drafts and approval
-- ---------------------------------------------------------------------------

create or replace function public.create_email_draft(
  p_to_email   text,
  p_subject    text,
  p_body       text,
  p_client_id  uuid default null,
  p_enquiry_id uuid default null,
  p_project_id uuid default null,
  p_created_by_kind text default 'human'
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_role public.crm_role;
  v_id   uuid;
begin
  v_role := crm_private.require_role('owner', 'booking_manager');

  if p_created_by_kind not in ('human', 'ai') then
    raise exception 'unsupported draft origin' using errcode = '22023';
  end if;

  -- A draft is always created as a draft, whatever the caller asks for. There
  -- is no argument on this function that can produce a sendable record.
  insert into public.email_messages (
    status, client_id, enquiry_id, project_id, to_email, subject, body,
    created_by, created_by_kind
  ) values (
    'draft', p_client_id, p_enquiry_id, p_project_id, p_to_email, p_subject, p_body,
    auth.uid(), p_created_by_kind
  )
  returning id into v_id;

  perform crm_private.log_activity(
    'email.draft_created',
    case when v_role = 'owner' then 'owner' else 'staff' end,
    auth.uid(), p_client_id, p_enquiry_id, p_project_id, null, null, null, null, null,
    jsonb_build_object('origin', p_created_by_kind, 'email_message_id', v_id)
  );

  return v_id;
end;
$$;

create or replace function public.approve_email_draft(p_email_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_status public.email_message_status;
  v_client uuid;
begin
  -- Approval is the human gate on anything personalised leaving the system.
  perform crm_private.require_role('owner');

  select m.status, m.client_id into v_status, v_client
  from public.email_messages m where m.id = p_email_message_id;

  if v_status is null then
    raise exception 'email message % does not exist', p_email_message_id using errcode = '23503';
  end if;
  if v_status <> 'draft' then
    raise exception 'only a draft may be approved (current status %)', v_status using errcode = '22023';
  end if;

  update public.email_messages m
  set status = 'approved', approved_by = auth.uid(), approved_at = now()
  where m.id = p_email_message_id;

  perform crm_private.enqueue_outbox(
    'approved_email', 'email:approved:' || p_email_message_id,
    jsonb_build_object('email_message_id', p_email_message_id),
    v_client, null, null, null, p_email_message_id
  );

  perform crm_private.log_activity(
    'email.approved', 'owner', auth.uid(), v_client, null, null, null, null, null, null, null,
    jsonb_build_object('email_message_id', p_email_message_id)
  );

  return jsonb_build_object('email_message_id', p_email_message_id, 'status', 'approved');
end;
$$;

-- ---------------------------------------------------------------------------
-- User management (owner only)
-- ---------------------------------------------------------------------------

create or replace function public.set_profile_active(
  p_profile_id uuid,
  p_is_active  boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_owner_count integer;
begin
  perform crm_private.require_role('owner');

  if p_profile_id = auth.uid() and not p_is_active then
    raise exception 'the acting owner cannot deactivate their own profile' using errcode = '22023';
  end if;

  update public.profiles p set is_active = p_is_active where p.id = p_profile_id;
  if not found then
    raise exception 'profile % does not exist', p_profile_id using errcode = '23503';
  end if;

  -- Counted from the access mirror, not from `public.profiles`. The acting
  -- owner may have just demoted themselves, in which case RLS would hide every
  -- other profile from them and this guard would fire on a perfectly safe
  -- change. The mirror carries no RLS and always sees the true count.
  select count(*) into v_owner_count
  from crm_private.profile_access a where a.role = 'owner' and a.is_active;
  if v_owner_count = 0 then
    raise exception 'at least one active owner must remain' using errcode = '22023';
  end if;

  perform crm_private.log_activity(
    case when p_is_active then 'profile.activated' else 'profile.deactivated' end,
    'owner', auth.uid(), null, null, null, null, p_profile_id, null, null, null, '{}'::jsonb
  );

  return jsonb_build_object('profile_id', p_profile_id, 'is_active', p_is_active);
end;
$$;

create or replace function public.set_profile_role(
  p_profile_id uuid,
  p_role       public.crm_role
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_previous    public.crm_role;
  v_owner_count integer;
begin
  perform crm_private.require_role('owner');

  select p.role into v_previous from public.profiles p where p.id = p_profile_id;
  if v_previous is null then
    raise exception 'profile % does not exist', p_profile_id using errcode = '23503';
  end if;

  update public.profiles p set role = p_role where p.id = p_profile_id;

  select count(*) into v_owner_count
  from crm_private.profile_access a where a.role = 'owner' and a.is_active;
  if v_owner_count = 0 then
    raise exception 'at least one active owner must remain' using errcode = '22023';
  end if;

  perform crm_private.log_activity(
    'profile.role_changed', 'owner', auth.uid(), null, null, null, null, p_profile_id,
    null, null, null,
    jsonb_build_object('from_role', v_previous, 'to_role', p_role)
  );

  return jsonb_build_object('profile_id', p_profile_id, 'role', p_role);
end;
$$;

-- ---------------------------------------------------------------------------
-- Function grants
--
-- PUBLIC execution is revoked everywhere. `anon` is granted nothing at all.
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.transition_enquiry_status(uuid, public.enquiry_status)',
    'public.assign_enquiry(uuid, uuid)',
    'public.convert_enquiry_to_project(uuid, text, text)',
    'public.schedule_session(uuid, timestamptz, timestamptz, public.session_status, text)',
    'public.set_session_status(uuid, public.session_status)',
    'public.update_project_deposit(uuid, numeric, public.deposit_status, text)',
    'public.update_project_estimate(uuid, numeric, numeric, integer, numeric, text)',
    'public.create_internal_note(text, uuid, uuid, uuid, uuid)',
    'public.create_follow_up(text, timestamptz, uuid, uuid, uuid, uuid, text)',
    'public.complete_follow_up(uuid)',
    'public.create_email_draft(text, text, text, uuid, uuid, uuid, text)',
    'public.approve_email_draft(uuid)',
    'public.set_profile_active(uuid, boolean)',
    'public.set_profile_role(uuid, public.crm_role)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Private schema lockdown
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so every
-- helper in `crm_private` is revoked wholesale here rather than one at a time —
-- a helper added later without its own REVOKE would otherwise be callable by
-- any authenticated session, and several of them are SECURITY DEFINER.
--
-- Only the three helpers that appear inside RLS policies are granted back.
-- Trigger functions do not need a runtime grant: PostgreSQL checks EXECUTE when
-- the trigger is created, not when it fires.
-- ---------------------------------------------------------------------------

do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'crm_private'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role',
                   fn.signature);
  end loop;
end $$;

grant execute on function crm_private.jwt_role() to authenticated, service_role;
grant execute on function crm_private.is_service_backend() to authenticated, service_role;
grant execute on function crm_private.no_active_owner() to authenticated, service_role;
