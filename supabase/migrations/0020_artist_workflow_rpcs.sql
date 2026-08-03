-- 0020_artist_workflow_rpcs.sql
--
-- Artist-scoped workflow entrypoints, trusted booking-source intake,
-- membership/integration administration and immutable-ledger payment RPCs.
--
-- Every payment request resolves its destination from exactly one enabled
-- payments integration owned by the same artist. The caller cannot submit a
-- provider or account selector. This keeps Vladimir and Kristina on separate
-- business-account routes for both deposits and session payments.
--
-- No provider credential, bank detail, OAuth token or webhook secret is stored
-- here. `integration_key` / `provider_account_key` are non-secret selectors for
-- encrypted server-side bindings.
--
-- Forward-only.

-- ---------------------------------------------------------------------------
-- Trusted booking-source identity on enquiries
-- ---------------------------------------------------------------------------

alter table public.enquiries
  add column if not exists booking_source_id uuid;

alter table public.enquiries
  add constraint enquiries_booking_source_id_fkey
  foreign key (booking_source_id)
  references public.booking_sources(id)
  on delete restrict;

create index if not exists enquiries_booking_source_idx
  on public.enquiries (booking_source_id, created_at desc)
  where booking_source_id is not null;

grant select (booking_source_id) on public.enquiries to authenticated;

comment on column public.enquiries.booking_source_id is
  'Trusted server-resolved source. Browser form fields cannot select this value or artist ownership.';

create or replace function crm_private.protect_enquiry_booking_source()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  if tg_op = 'UPDATE'
     and old.booking_source_id is not null
     and new.booking_source_id is distinct from old.booking_source_id then
    raise exception 'enquiry booking source is immutable once assigned'
      using errcode = '23514';
  end if;

  if new.booking_source_id is not null then
    select s.artist_id into v_artist_id
    from public.booking_sources s
    where s.id = new.booking_source_id;

    if not found then
      raise exception 'booking source % does not exist', new.booking_source_id
        using errcode = '23503';
    end if;

    if new.artist_id <> v_artist_id then
      raise exception 'booking source artist must match enquiry artist'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function crm_private.protect_enquiry_booking_source()
  from public, anon, authenticated, service_role;

drop trigger if exists enquiries_protect_booking_source on public.enquiries;
create trigger enquiries_protect_booking_source
  before insert or update of booking_source_id, artist_id on public.enquiries
  for each row execute function crm_private.protect_enquiry_booking_source();

-- A transaction-local source id is set only by create_trusted_enquiry_intake.
-- The legacy intake continues to resolve to Vladimir when no trusted source is
-- present, so the current isolated staging Worker is not broken before its own
-- later source-routing change.
create or replace function crm_private.legacy_default_artist_id()
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_source_setting text;
  v_source_id uuid;
  v_artist_id uuid;
begin
  v_source_setting := nullif(
    pg_catalog.current_setting('crm.trusted_booking_source_id', true),
    ''
  );

  if v_source_setting is not null then
    if not crm_private.is_service_backend() then
      raise exception 'trusted booking source context is backend-only'
        using errcode = '42501';
    end if;

    begin
      v_source_id := v_source_setting::uuid;
    exception when invalid_text_representation then
      raise exception 'trusted booking source context is invalid'
        using errcode = '22023';
    end;

    select s.artist_id into v_artist_id
    from public.booking_sources s
    join crm_private.artist_state a on a.artist_id = s.artist_id
    where s.id = v_source_id
      and s.is_active
      and a.is_active;

    if not found then
      raise exception 'trusted booking source is inactive or unavailable'
        using errcode = '42501';
    end if;

    return v_artist_id;
  end if;

  return 'a1111111-1111-4111-8111-111111111111'::uuid;
end;
$$;

revoke all on function crm_private.legacy_default_artist_id()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Shared workflow helpers
-- ---------------------------------------------------------------------------

create or replace function crm_private.log_artist_activity(
  p_artist_id uuid,
  p_event_type text,
  p_actor_kind text,
  p_actor_profile_id uuid default null,
  p_client_id uuid default null,
  p_enquiry_id uuid default null,
  p_project_id uuid default null,
  p_session_id uuid default null,
  p_profile_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  perform crm_private.require_active_artist(p_artist_id);

  insert into public.activity_log (
    id, artist_id, event_type, actor_kind, actor_profile_id,
    client_id, enquiry_id, project_id, session_id, profile_id, metadata
  ) values (
    v_id, p_artist_id, p_event_type, p_actor_kind, p_actor_profile_id,
    p_client_id, p_enquiry_id, p_project_id, p_session_id, p_profile_id,
    coalesce(p_metadata, '{}'::jsonb)
  );

  return v_id;
end;
$$;

create or replace function crm_private.workflow_artist_from_links(
  p_client_id uuid default null,
  p_enquiry_id uuid default null,
  p_project_id uuid default null,
  p_session_id uuid default null
)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_artist_count integer;
begin
  perform crm_private.assert_consistent_entity_links(
    p_client_id, p_enquiry_id, p_project_id, p_session_id
  );

  v_artist_id := crm_private.resolve_artist_from_links(
    p_enquiry_id, p_project_id, p_session_id
  );

  if v_artist_id is not null then
    return v_artist_id;
  end if;

  if p_client_id is null then
    raise exception 'an artist-scoped workflow requires an enquiry, project, session or client'
      using errcode = '22023';
  end if;

  select count(distinct x.artist_id), min(x.artist_id)
    into v_artist_count, v_artist_id
  from (
    select e.artist_id
    from public.enquiries e
    where e.client_id = p_client_id
    union all
    select p.artist_id
    from public.projects p
    where p.client_id = p_client_id
  ) x;

  if v_artist_count = 0 then
    raise exception 'client has no artist-scoped record; provide a linked enquiry or project'
      using errcode = '22023';
  elsif v_artist_count > 1 then
    raise exception 'client belongs to multiple artist scopes; provide an enquiry, project or session'
      using errcode = '22023';
  end if;

  return v_artist_id;
end;
$$;

create or replace function crm_private.require_assignee_for_artist(
  p_profile_id uuid,
  p_artist_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if p_profile_id is null then
    return;
  end if;

  if not exists (
    select 1
    from crm_private.profile_access p
    join crm_private.artist_access a on a.profile_id = p.profile_id
    where p.profile_id = p_profile_id
      and p.is_active
      and p.role in ('owner', 'booking_manager')
      and a.artist_id = p_artist_id
      and a.is_active
      and a.access_level <> 'read_only'
  ) then
    raise exception 'assignee must be an active owner/manager for the same artist'
      using errcode = '22023';
  end if;
end;
$$;

revoke all on function crm_private.log_artist_activity(uuid,text,text,uuid,uuid,uuid,uuid,uuid,uuid,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.workflow_artist_from_links(uuid,uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.require_assignee_for_artist(uuid,uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Trusted artist-aware public intake
-- ---------------------------------------------------------------------------

create or replace function public.create_trusted_enquiry_intake(
  p_source_key text,
  p_origin text,
  p_form_version text,
  p_idempotency_key uuid,
  p_client jsonb,
  p_enquiry jsonb,
  p_files jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_source record;
  v_result jsonb;
  v_enquiry_id uuid;
  v_previous_context text;
  v_changed integer;
begin
  if not crm_private.is_service_backend() then
    raise exception 'trusted enquiry intake is backend-only'
      using errcode = '42501';
  end if;

  select * into v_source
  from public.resolve_booking_source(p_source_key, p_origin, p_form_version);

  v_previous_context := pg_catalog.current_setting(
    'crm.trusted_booking_source_id', true
  );

  perform set_config(
    'crm.trusted_booking_source_id',
    v_source.booking_source_id::text,
    true
  );

  begin
    v_result := public.create_enquiry_intake(
      p_idempotency_key,
      p_client,
      coalesce(p_enquiry, '{}'::jsonb) || jsonb_build_object(
        '_trusted_booking_source_id', v_source.booking_source_id,
        '_trusted_artist_id', v_source.artist_id
      ),
      p_files
    );
  exception when others then
    perform set_config(
      'crm.trusted_booking_source_id',
      coalesce(v_previous_context, ''),
      true
    );
    raise;
  end;

  perform set_config(
    'crm.trusted_booking_source_id',
    coalesce(v_previous_context, ''),
    true
  );

  v_enquiry_id := (v_result ->> 'enquiry_id')::uuid;

  update public.enquiries e
  set booking_source_id = v_source.booking_source_id
  where e.id = v_enquiry_id
    and e.artist_id = v_source.artist_id
    and e.booking_source_id is null;
  get diagnostics v_changed = row_count;

  if not exists (
    select 1
    from public.enquiries e
    where e.id = v_enquiry_id
      and e.artist_id = v_source.artist_id
      and e.booking_source_id = v_source.booking_source_id
  ) then
    raise exception 'intake replay does not match the trusted booking source'
      using errcode = '23514';
  end if;

  if v_changed = 1 then
    perform crm_private.log_artist_activity(
      v_source.artist_id,
      'enquiry.source_resolved',
      'worker',
      null,
      (v_result ->> 'client_id')::uuid,
      v_enquiry_id,
      null,
      null,
      null,
      jsonb_build_object(
        'source_key', v_source.source_key,
        'form_version', v_source.form_version
      )
    );
  end if;

  return v_result || jsonb_build_object(
    'artist_id', v_source.artist_id,
    'booking_source_id', v_source.booking_source_id,
    'trusted_source_key', v_source.source_key
  );
end;
$$;

revoke all on function public.create_trusted_enquiry_intake(text,text,text,uuid,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_trusted_enquiry_intake(text,text,text,uuid,jsonb,jsonb,jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Wrap legacy operational RPCs with artist capability checks
-- ---------------------------------------------------------------------------

alter function public.transition_enquiry_status(uuid, public.enquiry_status)
  rename to legacy_transition_enquiry_status;
alter function public.legacy_transition_enquiry_status(uuid, public.enquiry_status)
  set schema crm_private;

alter function public.assign_enquiry(uuid, uuid)
  rename to legacy_assign_enquiry;
alter function public.legacy_assign_enquiry(uuid, uuid)
  set schema crm_private;

alter function public.convert_enquiry_to_project(uuid, text, text)
  rename to legacy_convert_enquiry_to_project;
alter function public.legacy_convert_enquiry_to_project(uuid, text, text)
  set schema crm_private;

alter function public.schedule_session(uuid, timestamptz, timestamptz, public.session_status, text)
  rename to legacy_schedule_session;
alter function public.legacy_schedule_session(uuid, timestamptz, timestamptz, public.session_status, text)
  set schema crm_private;

alter function public.set_session_status(uuid, public.session_status)
  rename to legacy_set_session_status;
alter function public.legacy_set_session_status(uuid, public.session_status)
  set schema crm_private;

alter function public.create_internal_note(text, uuid, uuid, uuid, uuid)
  rename to legacy_create_internal_note;
alter function public.legacy_create_internal_note(text, uuid, uuid, uuid, uuid)
  set schema crm_private;

alter function public.create_follow_up(text, timestamptz, uuid, uuid, uuid, uuid, text)
  rename to legacy_create_follow_up;
alter function public.legacy_create_follow_up(text, timestamptz, uuid, uuid, uuid, uuid, text)
  set schema crm_private;

alter function public.complete_follow_up(uuid)
  rename to legacy_complete_follow_up;
alter function public.legacy_complete_follow_up(uuid)
  set schema crm_private;

alter function public.create_email_draft(text, text, text, uuid, uuid, uuid, text)
  rename to legacy_create_email_draft;
alter function public.legacy_create_email_draft(text, text, text, uuid, uuid, uuid, text)
  set schema crm_private;

alter function public.approve_email_draft(uuid)
  rename to legacy_approve_email_draft;
alter function public.legacy_approve_email_draft(uuid)
  set schema crm_private;

alter function public.record_activity(text, uuid, uuid, uuid, uuid, jsonb)
  rename to legacy_record_activity;
alter function public.legacy_record_activity(text, uuid, uuid, uuid, uuid, jsonb)
  set schema crm_private;

revoke all on function crm_private.legacy_transition_enquiry_status(uuid,public.enquiry_status)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.legacy_assign_enquiry(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.legacy_convert_enquiry_to_project(uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.legacy_schedule_session(uuid,timestamptz,timestamptz,public.session_status,text)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.legacy_set_session_status(uuid,public.session_status)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.legacy_create_internal_note(text,uuid,uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.legacy_create_follow_up(text,timestamptz,uuid,uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.legacy_complete_follow_up(uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.legacy_create_email_draft(text,text,text,uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.legacy_approve_email_draft(uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.legacy_record_activity(text,uuid,uuid,uuid,uuid,jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.transition_enquiry_status(
  p_enquiry_id uuid,
  p_to_status public.enquiry_status
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  select e.artist_id into v_artist_id
  from public.enquiries e where e.id = p_enquiry_id;
  if not found then
    raise exception 'enquiry % does not exist', p_enquiry_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_artist_id, 'manage');

  if p_to_status = 'deposit_paid' and not exists (
    select 1
    from public.projects p
    join public.payment_requests r on r.project_id = p.id
    where p.enquiry_id = p_enquiry_id
      and r.artist_id = v_artist_id
      and r.purpose = 'deposit'
      and r.status = 'paid'
  ) then
    raise exception 'deposit_paid requires a settled deposit ledger request'
      using errcode = '42501';
  end if;

  return crm_private.legacy_transition_enquiry_status(p_enquiry_id, p_to_status);
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
  v_artist_id uuid;
begin
  select e.artist_id into v_artist_id
  from public.enquiries e where e.id = p_enquiry_id;
  if not found then
    raise exception 'enquiry % does not exist', p_enquiry_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_artist_id, 'manage');
  perform crm_private.require_assignee_for_artist(p_profile_id, v_artist_id);

  return crm_private.legacy_assign_enquiry(p_enquiry_id, p_profile_id);
end;
$$;

create or replace function public.convert_enquiry_to_project(
  p_enquiry_id uuid,
  p_title text,
  p_description text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  select e.artist_id into v_artist_id
  from public.enquiries e where e.id = p_enquiry_id;
  if not found then
    raise exception 'enquiry % does not exist', p_enquiry_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_artist_id, 'manage');
  return crm_private.legacy_convert_enquiry_to_project(
    p_enquiry_id, p_title, p_description
  );
end;
$$;

create or replace function public.schedule_session(
  p_project_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_status public.session_status default 'proposed',
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  select p.artist_id into v_artist_id
  from public.projects p where p.id = p_project_id;
  if not found then
    raise exception 'project % does not exist', p_project_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_artist_id, 'manage_sessions');
  return crm_private.legacy_schedule_session(
    p_project_id, p_start_at, p_end_at, p_status, p_notes
  );
end;
$$;

create or replace function public.set_session_status(
  p_session_id uuid,
  p_status public.session_status
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  select s.artist_id into v_artist_id
  from public.sessions s where s.id = p_session_id;
  if not found then
    raise exception 'session % does not exist', p_session_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_artist_id, 'manage_sessions');
  return crm_private.legacy_set_session_status(p_session_id, p_status);
end;
$$;

create or replace function public.create_internal_note(
  p_body text,
  p_client_id uuid default null,
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
  v_artist_id uuid;
begin
  perform crm_private.require_role('owner', 'booking_manager');
  v_artist_id := crm_private.workflow_artist_from_links(
    p_client_id, p_enquiry_id, p_project_id, p_session_id
  );
  perform crm_private.require_artist_access(v_artist_id, 'manage');

  return crm_private.legacy_create_internal_note(
    p_body, p_client_id, p_enquiry_id, p_project_id, p_session_id
  );
end;
$$;

create or replace function public.create_follow_up(
  p_subject text,
  p_due_at timestamptz,
  p_client_id uuid default null,
  p_enquiry_id uuid default null,
  p_project_id uuid default null,
  p_assigned_to uuid default null,
  p_details text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  perform crm_private.require_role('owner', 'booking_manager');
  v_artist_id := crm_private.workflow_artist_from_links(
    p_client_id, p_enquiry_id, p_project_id, null
  );
  perform crm_private.require_artist_access(v_artist_id, 'manage');
  perform crm_private.require_assignee_for_artist(p_assigned_to, v_artist_id);

  return crm_private.legacy_create_follow_up(
    p_subject, p_due_at, p_client_id, p_enquiry_id, p_project_id,
    p_assigned_to, p_details
  );
end;
$$;

create or replace function public.complete_follow_up(p_follow_up_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  select f.artist_id into v_artist_id
  from public.follow_ups f where f.id = p_follow_up_id;
  if not found then
    raise exception 'follow-up % does not exist', p_follow_up_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_artist_id, 'manage');
  return crm_private.legacy_complete_follow_up(p_follow_up_id);
end;
$$;

create or replace function public.create_email_draft(
  p_to_email text,
  p_subject text,
  p_body text,
  p_client_id uuid default null,
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
  v_artist_id uuid;
begin
  perform crm_private.require_role('owner', 'booking_manager');
  v_artist_id := crm_private.workflow_artist_from_links(
    p_client_id, p_enquiry_id, p_project_id, null
  );
  perform crm_private.require_artist_access(v_artist_id, 'manage');

  return crm_private.legacy_create_email_draft(
    p_to_email, p_subject, p_body, p_client_id, p_enquiry_id,
    p_project_id, p_created_by_kind
  );
end;
$$;

create or replace function public.approve_email_draft(p_email_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  select m.artist_id into v_artist_id
  from public.email_messages m where m.id = p_email_message_id;
  if not found then
    raise exception 'email message % does not exist', p_email_message_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_artist_id, 'manage');
  return crm_private.legacy_approve_email_draft(p_email_message_id);
end;
$$;

create or replace function public.record_activity(
  p_event_type text,
  p_client_id uuid default null,
  p_enquiry_id uuid default null,
  p_project_id uuid default null,
  p_session_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  perform crm_private.require_role('owner', 'booking_manager');
  v_artist_id := crm_private.workflow_artist_from_links(
    p_client_id, p_enquiry_id, p_project_id, p_session_id
  );
  perform crm_private.require_artist_access(v_artist_id, 'manage');

  return crm_private.legacy_record_activity(
    p_event_type, p_client_id, p_enquiry_id, p_project_id,
    p_session_id, p_metadata
  );
end;
$$;

revoke all on function public.transition_enquiry_status(uuid,public.enquiry_status)
  from public, anon, authenticated, service_role;
revoke all on function public.assign_enquiry(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.convert_enquiry_to_project(uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.schedule_session(uuid,timestamptz,timestamptz,public.session_status,text)
  from public, anon, authenticated, service_role;
revoke all on function public.set_session_status(uuid,public.session_status)
  from public, anon, authenticated, service_role;
revoke all on function public.create_internal_note(text,uuid,uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.create_follow_up(text,timestamptz,uuid,uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.complete_follow_up(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.create_email_draft(text,text,text,uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.approve_email_draft(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.record_activity(text,uuid,uuid,uuid,uuid,jsonb)
  from public, anon, authenticated, service_role;

grant execute on function public.transition_enquiry_status(uuid,public.enquiry_status) to authenticated;
grant execute on function public.assign_enquiry(uuid,uuid) to authenticated;
grant execute on function public.convert_enquiry_to_project(uuid,text,text) to authenticated;
grant execute on function public.schedule_session(uuid,timestamptz,timestamptz,public.session_status,text) to authenticated;
grant execute on function public.set_session_status(uuid,public.session_status) to authenticated;
grant execute on function public.create_internal_note(text,uuid,uuid,uuid,uuid) to authenticated;
grant execute on function public.create_follow_up(text,timestamptz,uuid,uuid,uuid,uuid,text) to authenticated;
grant execute on function public.complete_follow_up(uuid) to authenticated;
grant execute on function public.create_email_draft(text,text,text,uuid,uuid,uuid,text) to authenticated;
grant execute on function public.approve_email_draft(uuid) to authenticated;
grant execute on function public.record_activity(text,uuid,uuid,uuid,uuid,jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Protected membership and integration administration
-- ---------------------------------------------------------------------------

create or replace function public.upsert_artist_membership(
  p_profile_id uuid,
  p_artist_id uuid,
  p_access_level public.artist_access_level,
  p_can_view_finance boolean default false,
  p_can_manage_finance boolean default false,
  p_can_manage_sessions boolean default false,
  p_can_manage_integrations boolean default false,
  p_is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_role public.crm_role;
  v_membership_id uuid;
begin
  perform crm_private.require_role('owner');
  perform crm_private.require_active_artist(p_artist_id);

  select p.role into v_role
  from crm_private.profile_access p
  where p.profile_id = p_profile_id;

  if v_role is null then
    raise exception 'profile % does not exist', p_profile_id using errcode = '23503';
  end if;

  if v_role = 'owner' then
    raise exception 'owner artist memberships are managed automatically'
      using errcode = '22023';
  end if;

  if v_role = 'read_only' and (
    p_access_level <> 'read_only'
    or p_can_view_finance
    or p_can_manage_finance
    or p_can_manage_sessions
    or p_can_manage_integrations
  ) then
    raise exception 'a global read_only profile cannot receive management capabilities'
      using errcode = '22023';
  end if;

  if p_access_level = 'owner' then
    raise exception 'only a global owner may hold owner artist access'
      using errcode = '22023';
  end if;

  insert into public.artist_memberships (
    profile_id, artist_id, access_level,
    can_view_finance, can_manage_finance,
    can_manage_sessions, can_manage_integrations, is_active
  ) values (
    p_profile_id, p_artist_id, p_access_level,
    p_can_view_finance, p_can_manage_finance,
    p_can_manage_sessions, p_can_manage_integrations, p_is_active
  )
  on conflict (profile_id, artist_id) do update
    set access_level = excluded.access_level,
        can_view_finance = excluded.can_view_finance,
        can_manage_finance = excluded.can_manage_finance,
        can_manage_sessions = excluded.can_manage_sessions,
        can_manage_integrations = excluded.can_manage_integrations,
        is_active = excluded.is_active
  returning id into v_membership_id;

  perform crm_private.log_artist_activity(
    p_artist_id,
    'membership.updated',
    'owner',
    auth.uid(),
    null, null, null, null,
    p_profile_id,
    jsonb_build_object(
      'access_level', p_access_level,
      'is_active', p_is_active,
      'can_view_finance', p_can_view_finance,
      'can_manage_finance', p_can_manage_finance,
      'can_manage_sessions', p_can_manage_sessions,
      'can_manage_integrations', p_can_manage_integrations
    )
  );

  return jsonb_build_object(
    'membership_id', v_membership_id,
    'profile_id', p_profile_id,
    'artist_id', p_artist_id,
    'is_active', p_is_active
  );
end;
$$;

create unique index if not exists artist_integrations_payment_route_key
  on public.artist_integrations (provider, integration_key)
  where integration_type = 'payments';

create unique index if not exists artist_integrations_one_enabled_payment_idx
  on public.artist_integrations (artist_id)
  where integration_type = 'payments' and is_enabled;

create or replace function public.configure_artist_integration(
  p_artist_id uuid,
  p_integration_type public.artist_integration_type,
  p_provider text,
  p_integration_key text,
  p_external_account_label text default null,
  p_configuration jsonb default '{}'::jsonb,
  p_is_enabled boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid;
  v_capability text;
begin
  v_capability := case
    when p_integration_type = 'payments' then 'manage_finance'
    else 'manage_integrations'
  end;

  perform crm_private.require_artist_access(p_artist_id, v_capability);
  perform crm_private.require_active_artist(p_artist_id);

  if p_is_enabled
     and p_integration_type = 'payments'
     and lower(p_provider) = 'unconfigured' then
    raise exception 'an unconfigured payment route cannot be enabled'
      using errcode = '22023';
  end if;

  insert into public.artist_integrations (
    artist_id, integration_type, provider, integration_key,
    external_account_label, configuration, is_enabled
  ) values (
    p_artist_id, p_integration_type, lower(p_provider), p_integration_key,
    p_external_account_label, coalesce(p_configuration, '{}'::jsonb), p_is_enabled
  )
  on conflict (artist_id, integration_type, integration_key) do update
    set provider = excluded.provider,
        external_account_label = excluded.external_account_label,
        configuration = excluded.configuration,
        is_enabled = excluded.is_enabled
  returning id into v_id;

  perform crm_private.log_artist_activity(
    p_artist_id,
    'integration.configured',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    null, null, null, null, null,
    jsonb_build_object(
      'integration_type', p_integration_type,
      'provider', lower(p_provider),
      'is_enabled', p_is_enabled
    )
  );

  return jsonb_build_object(
    'integration_id', v_id,
    'artist_id', p_artist_id,
    'integration_type', p_integration_type,
    'provider', lower(p_provider),
    'integration_key', p_integration_key,
    'is_enabled', p_is_enabled
  );
end;
$$;

revoke all on function public.upsert_artist_membership(uuid,uuid,public.artist_access_level,boolean,boolean,boolean,boolean,boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.configure_artist_integration(uuid,public.artist_integration_type,text,text,text,jsonb,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.upsert_artist_membership(uuid,uuid,public.artist_access_level,boolean,boolean,boolean,boolean,boolean)
  to authenticated;
grant execute on function public.configure_artist_integration(uuid,public.artist_integration_type,text,text,text,jsonb,boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Artist payment routes and policies
-- ---------------------------------------------------------------------------

create or replace function crm_private.resolve_enabled_payment_route(p_artist_id uuid)
returns table (
  provider text,
  provider_account_key text,
  integration_id uuid
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  return query
  select i.provider, i.integration_key, i.id
  from public.artist_integrations i
  where i.artist_id = p_artist_id
    and i.integration_type = 'payments'
    and i.is_enabled;

  if not found then
    raise exception 'artist has no enabled payment destination'
      using errcode = '22023';
  end if;
end;
$$;

create or replace function crm_private.resolve_payment_route_owner(
  p_provider text,
  p_provider_account_key text
)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  select i.artist_id into v_artist_id
  from public.artist_integrations i
  join crm_private.artist_state a on a.artist_id = i.artist_id
  where i.integration_type = 'payments'
    and i.provider = lower(p_provider)
    and i.integration_key = p_provider_account_key
    and i.is_enabled
    and a.is_active;

  if not found then
    raise exception 'payment provider/account route is not enabled'
      using errcode = '42501';
  end if;

  return v_artist_id;
end;
$$;

revoke all on function crm_private.resolve_enabled_payment_route(uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.resolve_payment_route_owner(text,text)
  from public, anon, authenticated, service_role;

create or replace function public.create_artist_payment_policy(
  p_artist_id uuid,
  p_version integer,
  p_deposit_mode public.payment_policy_mode,
  p_fixed_amount numeric default null,
  p_percentage numeric default null,
  p_payment_deadline_hours integer default 72,
  p_transfer_allowed boolean default true,
  p_refund_policy_version text default 'v1',
  p_effective_from timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_policy_id uuid;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_finance');
  perform crm_private.require_active_artist(p_artist_id);

  update public.artist_payment_policies p
  set is_active = false,
      effective_until = coalesce(p.effective_until, p_effective_from)
  where p.artist_id = p_artist_id
    and p.is_active;

  insert into public.artist_payment_policies (
    artist_id, version, deposit_mode, fixed_amount, percentage,
    payment_deadline_hours, transfer_allowed, refund_policy_version,
    effective_from, is_active, created_by
  ) values (
    p_artist_id, p_version, p_deposit_mode, p_fixed_amount, p_percentage,
    p_payment_deadline_hours, p_transfer_allowed, p_refund_policy_version,
    p_effective_from, true, auth.uid()
  )
  returning id into v_policy_id;

  perform crm_private.log_artist_activity(
    p_artist_id,
    'payment.policy_created',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    null, null, null, null, null,
    jsonb_build_object(
      'version', p_version,
      'deposit_mode', p_deposit_mode,
      'refund_policy_version', p_refund_policy_version
    )
  );

  return jsonb_build_object(
    'policy_id', v_policy_id,
    'artist_id', p_artist_id,
    'version', p_version,
    'is_active', true
  );
end;
$$;

create or replace function public.create_payment_request(
  p_idempotency_key uuid,
  p_artist_id uuid,
  p_client_id uuid,
  p_purpose public.payment_request_purpose,
  p_amount numeric,
  p_project_id uuid default null,
  p_session_id uuid default null,
  p_currency text default null,
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_existing public.payment_requests%rowtype;
  v_route record;
  v_policy public.artist_payment_policies%rowtype;
  v_currency text;
  v_expires_at timestamptz;
  v_request_id uuid;
  v_policy_snapshot jsonb := '{}'::jsonb;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_finance');

  if p_idempotency_key is null then
    raise exception 'payment request idempotency key is required'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('payment-request:' || p_idempotency_key::text, 0));

  select * into v_existing
  from public.payment_requests r
  where r.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.artist_id <> p_artist_id
       or v_existing.client_id <> p_client_id
       or v_existing.project_id is distinct from p_project_id
       or v_existing.session_id is distinct from p_session_id
       or v_existing.purpose <> p_purpose
       or v_existing.amount <> p_amount
       or v_existing.currency <> coalesce(p_currency, v_existing.currency)
       or v_existing.expires_at is distinct from p_expires_at then
      raise exception 'payment request idempotency key was reused with different terms'
        using errcode = '22023';
    end if;

    return jsonb_build_object(
      'payment_request_id', v_existing.id,
      'artist_id', v_existing.artist_id,
      'status', v_existing.status,
      'provider', v_existing.provider,
      'provider_account_key', v_existing.provider_account_key,
      'replayed', true
    );
  end if;

  select a.default_currency into v_currency
  from public.artists a
  where a.id = p_artist_id and a.is_active;
  if not found then
    raise exception 'artist is inactive or unavailable' using errcode = '23503';
  end if;

  v_currency := coalesce(p_currency, v_currency);
  if v_currency <> (select a.default_currency from public.artists a where a.id = p_artist_id) then
    raise exception 'payment request currency must match the artist default currency'
      using errcode = '22023';
  end if;

  select * into v_route
  from crm_private.resolve_enabled_payment_route(p_artist_id);

  if p_purpose = 'deposit' then
    select * into v_policy
    from public.artist_payment_policies p
    where p.artist_id = p_artist_id
      and p.is_active
      and p.effective_from <= now()
      and (p.effective_until is null or p.effective_until > now())
    order by p.version desc
    limit 1;

    if not found then
      raise exception 'artist has no active deposit policy'
        using errcode = '22023';
    end if;

    v_policy_snapshot := jsonb_build_object(
      'version', v_policy.version,
      'deposit_mode', v_policy.deposit_mode,
      'payment_deadline_hours', v_policy.payment_deadline_hours,
      'transfer_allowed', v_policy.transfer_allowed,
      'refund_policy_version', v_policy.refund_policy_version
    );
    v_expires_at := coalesce(
      p_expires_at,
      now() + make_interval(hours => v_policy.payment_deadline_hours)
    );
  else
    v_expires_at := p_expires_at;
  end if;

  insert into public.payment_requests (
    idempotency_key, artist_id, client_id, project_id, session_id,
    purpose, amount, currency, provider, provider_account_key,
    policy_id, policy_version, policy_snapshot, expires_at, created_by
  ) values (
    p_idempotency_key, p_artist_id, p_client_id, p_project_id, p_session_id,
    p_purpose, p_amount, v_currency, v_route.provider,
    v_route.provider_account_key,
    case when p_purpose = 'deposit' then v_policy.id else null end,
    case when p_purpose = 'deposit' then v_policy.version else null end,
    v_policy_snapshot, v_expires_at, auth.uid()
  )
  returning id into v_request_id;

  perform crm_private.log_artist_activity(
    p_artist_id,
    'payment.request_created',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    p_client_id, null, p_project_id, p_session_id, null,
    jsonb_build_object(
      'purpose', p_purpose,
      'currency', v_currency,
      'provider', v_route.provider
    )
  );

  return jsonb_build_object(
    'payment_request_id', v_request_id,
    'artist_id', p_artist_id,
    'status', 'pending',
    'provider', v_route.provider,
    'provider_account_key', v_route.provider_account_key,
    'replayed', false
  );
end;
$$;

create or replace function public.record_manual_payment(
  p_payment_request_id uuid,
  p_idempotency_key uuid,
  p_amount numeric,
  p_occurred_at timestamptz default now(),
  p_safe_note_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_request public.payment_requests%rowtype;
  v_existing public.payment_transactions%rowtype;
  v_transaction_id uuid;
begin
  select * into v_request
  from public.payment_requests r
  where r.id = p_payment_request_id;
  if not found then
    raise exception 'payment request % does not exist', p_payment_request_id
      using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_request.artist_id, 'manage_finance');
  perform pg_advisory_xact_lock(hashtextextended('payment-transaction:' || p_idempotency_key::text, 0));

  select * into v_existing
  from public.payment_transactions t
  where t.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.payment_request_id <> p_payment_request_id
       or v_existing.transaction_type <> 'manual_payment'
       or v_existing.amount <> p_amount
       or v_existing.occurred_at <> p_occurred_at
       or v_existing.safe_note_code is distinct from p_safe_note_code then
      raise exception 'payment transaction idempotency key was reused with different terms'
        using errcode = '22023';
    end if;

    return jsonb_build_object(
      'payment_transaction_id', v_existing.id,
      'payment_request_id', p_payment_request_id,
      'replayed', true
    );
  end if;

  insert into public.payment_transactions (
    idempotency_key, payment_request_id, artist_id,
    transaction_type, direction, amount, currency, status,
    occurred_at, recorded_by, recorded_by_kind, safe_note_code
  ) values (
    p_idempotency_key, p_payment_request_id, v_request.artist_id,
    'manual_payment', 'credit', p_amount, v_request.currency, 'succeeded',
    p_occurred_at, auth.uid(), 'human', p_safe_note_code
  )
  returning id into v_transaction_id;

  perform crm_private.log_artist_activity(
    v_request.artist_id,
    'payment.manual_recorded',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_request.client_id, null, v_request.project_id, v_request.session_id, null,
    jsonb_build_object('currency', v_request.currency)
  );

  return jsonb_build_object(
    'payment_transaction_id', v_transaction_id,
    'payment_request_id', p_payment_request_id,
    'replayed', false
  );
end;
$$;

create or replace function public.record_manual_refund(
  p_payment_request_id uuid,
  p_idempotency_key uuid,
  p_amount numeric,
  p_full_refund boolean default false,
  p_occurred_at timestamptz default now(),
  p_safe_note_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_request public.payment_requests%rowtype;
  v_existing public.payment_transactions%rowtype;
  v_transaction_id uuid;
  v_type public.payment_transaction_type;
begin
  select * into v_request
  from public.payment_requests r
  where r.id = p_payment_request_id;
  if not found then
    raise exception 'payment request % does not exist', p_payment_request_id
      using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_request.artist_id, 'manage_finance');
  v_type := case when p_full_refund then 'refund' else 'partial_refund' end;
  perform pg_advisory_xact_lock(hashtextextended('payment-transaction:' || p_idempotency_key::text, 0));

  select * into v_existing
  from public.payment_transactions t
  where t.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.payment_request_id <> p_payment_request_id
       or v_existing.transaction_type <> v_type
       or v_existing.amount <> p_amount
       or v_existing.occurred_at <> p_occurred_at
       or v_existing.safe_note_code is distinct from p_safe_note_code then
      raise exception 'refund idempotency key was reused with different terms'
        using errcode = '22023';
    end if;

    return jsonb_build_object(
      'payment_transaction_id', v_existing.id,
      'payment_request_id', p_payment_request_id,
      'replayed', true
    );
  end if;

  insert into public.payment_transactions (
    idempotency_key, payment_request_id, artist_id,
    transaction_type, direction, amount, currency, status,
    occurred_at, recorded_by, recorded_by_kind, safe_note_code
  ) values (
    p_idempotency_key, p_payment_request_id, v_request.artist_id,
    v_type, 'debit', p_amount, v_request.currency, 'succeeded',
    p_occurred_at, auth.uid(), 'human', p_safe_note_code
  )
  returning id into v_transaction_id;

  perform crm_private.log_artist_activity(
    v_request.artist_id,
    'payment.refund_recorded',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_request.client_id, null, v_request.project_id, v_request.session_id, null,
    jsonb_build_object(
      'refund_type', v_type,
      'currency', v_request.currency
    )
  );

  return jsonb_build_object(
    'payment_transaction_id', v_transaction_id,
    'payment_request_id', p_payment_request_id,
    'replayed', false
  );
end;
$$;

create or replace function public.cancel_payment_request(p_payment_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_request public.payment_requests%rowtype;
begin
  select * into v_request
  from public.payment_requests r
  where r.id = p_payment_request_id
  for update;
  if not found then
    raise exception 'payment request % does not exist', p_payment_request_id
      using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_request.artist_id, 'manage_finance');

  if v_request.status = 'cancelled' then
    return jsonb_build_object(
      'payment_request_id', v_request.id,
      'status', 'cancelled',
      'changed', false
    );
  end if;

  update public.payment_requests
  set status = 'cancelled'
  where id = p_payment_request_id;

  perform crm_private.log_artist_activity(
    v_request.artist_id,
    'payment.request_cancelled',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_request.client_id, null, v_request.project_id, v_request.session_id, null,
    jsonb_build_object('purpose', v_request.purpose)
  );

  return jsonb_build_object(
    'payment_request_id', v_request.id,
    'status', 'cancelled',
    'changed', true
  );
end;
$$;

-- Backend webhook routing starts from the non-secret account selector and
-- derives artist ownership. A webhook caller cannot submit artist_id.
create or replace function public.register_payment_webhook_event(
  p_provider text,
  p_provider_account_key text,
  p_provider_event_id text,
  p_payload_sha256 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_event public.payment_webhook_events%rowtype;
begin
  if not crm_private.is_service_backend() then
    raise exception 'payment webhook registration is backend-only'
      using errcode = '42501';
  end if;

  v_artist_id := crm_private.resolve_payment_route_owner(
    lower(p_provider), p_provider_account_key
  );

  insert into public.payment_webhook_events (
    artist_id, provider, provider_account_key,
    provider_event_id, payload_sha256
  ) values (
    v_artist_id, lower(p_provider), p_provider_account_key,
    p_provider_event_id, p_payload_sha256
  )
  on conflict (provider, provider_event_id) do nothing;

  select * into v_event
  from public.payment_webhook_events e
  where e.provider = lower(p_provider)
    and e.provider_event_id = p_provider_event_id;

  if v_event.artist_id <> v_artist_id
     or v_event.provider_account_key <> p_provider_account_key
     or v_event.payload_sha256 is distinct from p_payload_sha256 then
    raise exception 'provider event id was reused with different routing metadata'
      using errcode = '23514';
  end if;

  return jsonb_build_object(
    'payment_webhook_event_id', v_event.id,
    'artist_id', v_event.artist_id,
    'processing_status', v_event.processing_status
  );
end;
$$;

create or replace function public.record_provider_payment(
  p_payment_webhook_event_id uuid,
  p_payment_request_id uuid,
  p_idempotency_key uuid,
  p_provider_transaction_id text,
  p_amount numeric,
  p_succeeded boolean,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_event public.payment_webhook_events%rowtype;
  v_request public.payment_requests%rowtype;
  v_existing public.payment_transactions%rowtype;
  v_transaction_id uuid;
  v_status public.payment_transaction_status;
begin
  if not crm_private.is_service_backend() then
    raise exception 'provider payment recording is backend-only'
      using errcode = '42501';
  end if;

  select * into v_event
  from public.payment_webhook_events e
  where e.id = p_payment_webhook_event_id
  for update;
  if not found then
    raise exception 'payment webhook event % does not exist', p_payment_webhook_event_id
      using errcode = '23503';
  end if;

  select * into v_request
  from public.payment_requests r
  where r.id = p_payment_request_id;
  if not found then
    raise exception 'payment request % does not exist', p_payment_request_id
      using errcode = '23503';
  end if;

  if v_event.artist_id <> v_request.artist_id
     or v_event.provider <> v_request.provider
     or v_event.provider_account_key <> v_request.provider_account_key then
    raise exception 'webhook event and payment request belong to different payment routes'
      using errcode = '23514';
  end if;

  v_status := case when p_succeeded then 'succeeded' else 'failed' end;
  perform pg_advisory_xact_lock(hashtextextended('payment-transaction:' || p_idempotency_key::text, 0));

  select * into v_existing
  from public.payment_transactions t
  where t.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.payment_request_id <> p_payment_request_id
       or v_existing.webhook_event_id <> p_payment_webhook_event_id
       or v_existing.provider_transaction_id <> p_provider_transaction_id
       or v_existing.amount <> p_amount
       or v_existing.status <> v_status
       or v_existing.occurred_at <> p_occurred_at then
      raise exception 'provider transaction idempotency key was reused with different terms'
        using errcode = '22023';
    end if;

    return jsonb_build_object(
      'payment_transaction_id', v_existing.id,
      'payment_request_id', p_payment_request_id,
      'replayed', true
    );
  end if;

  insert into public.payment_transactions (
    idempotency_key, payment_request_id, artist_id,
    transaction_type, direction, amount, currency, status,
    provider, provider_transaction_id, webhook_event_id,
    occurred_at, recorded_by, recorded_by_kind
  ) values (
    p_idempotency_key, p_payment_request_id, v_request.artist_id,
    'payment', 'credit', p_amount, v_request.currency, v_status,
    v_event.provider, p_provider_transaction_id, v_event.id,
    p_occurred_at, null, 'webhook'
  )
  returning id into v_transaction_id;

  update public.payment_webhook_events
  set processing_status = case when p_succeeded then 'succeeded' else 'failed' end,
      processed_at = now(),
      safe_error_code = case when p_succeeded then null else 'provider_payment_failed' end
  where id = v_event.id;

  perform crm_private.log_artist_activity(
    v_request.artist_id,
    case when p_succeeded then 'payment.provider_recorded' else 'payment.provider_failed' end,
    'worker',
    null,
    v_request.client_id, null, v_request.project_id, v_request.session_id, null,
    jsonb_build_object(
      'provider', v_event.provider,
      'currency', v_request.currency
    )
  );

  return jsonb_build_object(
    'payment_transaction_id', v_transaction_id,
    'payment_request_id', p_payment_request_id,
    'replayed', false
  );
end;
$$;

revoke all on function public.create_artist_payment_policy(uuid,integer,public.payment_policy_mode,numeric,numeric,integer,boolean,text,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.create_payment_request(uuid,uuid,uuid,public.payment_request_purpose,numeric,uuid,uuid,text,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.record_manual_payment(uuid,uuid,numeric,timestamptz,text)
  from public, anon, authenticated, service_role;
revoke all on function public.record_manual_refund(uuid,uuid,numeric,boolean,timestamptz,text)
  from public, anon, authenticated, service_role;
revoke all on function public.cancel_payment_request(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.register_payment_webhook_event(text,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.record_provider_payment(uuid,uuid,uuid,text,numeric,boolean,timestamptz)
  from public, anon, authenticated, service_role;

grant execute on function public.create_artist_payment_policy(uuid,integer,public.payment_policy_mode,numeric,numeric,integer,boolean,text,timestamptz)
  to authenticated;
grant execute on function public.create_payment_request(uuid,uuid,uuid,public.payment_request_purpose,numeric,uuid,uuid,text,timestamptz)
  to authenticated;
grant execute on function public.record_manual_payment(uuid,uuid,numeric,timestamptz,text)
  to authenticated;
grant execute on function public.record_manual_refund(uuid,uuid,numeric,boolean,timestamptz,text)
  to authenticated;
grant execute on function public.cancel_payment_request(uuid)
  to authenticated;
grant execute on function public.register_payment_webhook_event(text,text,text,text)
  to service_role;
grant execute on function public.record_provider_payment(uuid,uuid,uuid,text,numeric,boolean,timestamptz)
  to service_role;

comment on function public.create_payment_request(uuid,uuid,uuid,public.payment_request_purpose,numeric,uuid,uuid,text,timestamptz) is
  'Creates an artist-scoped payment request whose provider/account destination is resolved by the database from that artist enabled payment integration.';
comment on function public.register_payment_webhook_event(text,text,text,text) is
  'Backend-only webhook idempotency. Artist identity is resolved from the provider/account route; artist_id is not accepted.';
