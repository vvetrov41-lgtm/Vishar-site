-- 0026_appointment_types.sql
--
-- Expand the existing project-owned session model into a compatible appointment
-- model without renaming or replacing public.sessions. Existing rows and RPC
-- clients remain valid; consultations may exist before project conversion.
--
-- Forward-only. No provider is connected by this migration.

-- ---------------------------------------------------------------------------
-- Closed appointment type vocabulary
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.appointment_type as enum (
    'tattoo_session',
    'in_person_consultation',
    'video_consultation',
    'touch_up'
  );
exception when duplicate_object then null; end $$;

alter table public.sessions
  add column if not exists appointment_type public.appointment_type
  not null default 'tattoo_session';

alter table public.sessions
  add column if not exists client_id uuid;

alter table public.sessions
  add column if not exists enquiry_id uuid;

-- Existing sessions are project-owned. Preserve their identity and derive the
-- two new relationship columns from the already-authoritative project row.
update public.sessions s
set client_id = p.client_id,
    enquiry_id = p.enquiry_id,
    appointment_type = 'tattoo_session'
from public.projects p
where p.id = s.project_id
  and (s.client_id is null
       or s.enquiry_id is distinct from p.enquiry_id
       or s.appointment_type is distinct from 'tattoo_session');

do $$ begin
  if exists (select 1 from public.sessions where client_id is null) then
    raise exception 'appointment backfill left a session without a client'
      using errcode = '23514';
  end if;
end $$;

alter table public.sessions alter column client_id set not null;
alter table public.sessions alter column project_id drop not null;

-- ---------------------------------------------------------------------------
-- Declarative relationship consistency
-- ---------------------------------------------------------------------------

create unique index if not exists enquiries_id_client_key
  on public.enquiries (id, client_id);
create unique index if not exists projects_id_client_key
  on public.projects (id, client_id);

alter table public.sessions
  add constraint sessions_client_id_fkey
  foreign key (client_id)
  references public.clients(id)
  on delete restrict;

alter table public.sessions
  add constraint sessions_enquiry_client_fkey
  foreign key (enquiry_id, client_id)
  references public.enquiries(id, client_id)
  on delete restrict
  deferrable initially deferred;

alter table public.sessions
  add constraint sessions_project_client_fkey
  foreign key (project_id, client_id)
  references public.projects(id, client_id)
  on delete restrict
  deferrable initially deferred;

alter table public.sessions
  add constraint sessions_project_required_for_work
  check (
    appointment_type not in ('tattoo_session', 'touch_up')
    or project_id is not null
  );

create or replace function crm_private.validate_appointment_links()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_project_client uuid;
  v_project_artist uuid;
  v_project_enquiry uuid;
  v_enquiry_client uuid;
  v_enquiry_artist uuid;
begin
  if new.project_id is not null then
    select p.client_id, p.artist_id, p.enquiry_id
      into v_project_client, v_project_artist, v_project_enquiry
    from public.projects p
    where p.id = new.project_id;

    if not found then
      raise exception 'project % does not exist', new.project_id
        using errcode = '23503';
    end if;

    if new.client_id is null then
      new.client_id := v_project_client;
    elsif new.client_id <> v_project_client then
      raise exception 'appointment client must match the linked project client'
        using errcode = '23514';
    end if;

    if new.artist_id is null then
      new.artist_id := v_project_artist;
    elsif new.artist_id <> v_project_artist then
      raise exception 'appointment artist must match the linked project artist'
        using errcode = '23514';
    end if;

    if new.enquiry_id is null then
      new.enquiry_id := v_project_enquiry;
    elsif new.enquiry_id is distinct from v_project_enquiry then
      raise exception 'appointment enquiry must match the linked project enquiry'
        using errcode = '23514';
    end if;
  end if;

  if new.enquiry_id is not null then
    select e.client_id, e.artist_id
      into v_enquiry_client, v_enquiry_artist
    from public.enquiries e
    where e.id = new.enquiry_id;

    if not found then
      raise exception 'enquiry % does not exist', new.enquiry_id
        using errcode = '23503';
    end if;

    if new.client_id is null then
      new.client_id := v_enquiry_client;
    elsif new.client_id <> v_enquiry_client then
      raise exception 'appointment client must match the linked enquiry client'
        using errcode = '23514';
    end if;

    -- A project may have been explicitly transferred to another artist while
    -- the originating enquiry keeps its historical artist. In that case the
    -- current project artist is authoritative. Only a projectless appointment
    -- must match the enquiry artist directly.
    if new.project_id is null then
      if new.artist_id is null then
        new.artist_id := v_enquiry_artist;
      elsif new.artist_id <> v_enquiry_artist then
        raise exception 'projectless appointment artist must match the linked enquiry artist'
          using errcode = '23514';
      end if;
    end if;
  end if;

  if new.client_id is null then
    raise exception 'appointment client is required' using errcode = '22023';
  end if;

  if new.artist_id is null then
    raise exception 'appointment artist is required' using errcode = '22023';
  end if;

  if new.appointment_type in ('tattoo_session', 'touch_up')
     and new.project_id is null then
    raise exception '% requires a project', new.appointment_type
      using errcode = '22023';
  end if;

  return new;
end;
$$;

revoke all on function crm_private.validate_appointment_links()
  from public, anon, authenticated, service_role;

drop trigger if exists sessions_validate_appointment_links on public.sessions;
create trigger sessions_validate_appointment_links
  before insert or update of appointment_type, client_id, enquiry_id, project_id, artist_id
  on public.sessions
  for each row execute function crm_private.validate_appointment_links();

create index if not exists sessions_artist_type_start_idx
  on public.sessions (artist_id, appointment_type, start_at);
create index if not exists sessions_client_start_idx
  on public.sessions (client_id, start_at desc);
create index if not exists sessions_enquiry_start_idx
  on public.sessions (enquiry_id, start_at desc)
  where enquiry_id is not null;

-- Existing table policies remain artist-scoped. Only the new operational
-- columns are added to the authenticated read surface; finance stays separate.
grant select (appointment_type, client_id, enquiry_id)
  on public.sessions to authenticated;

comment on table public.sessions is
  'Authoritative appointment records. The historical table name is retained for compatibility; Google Calendar remains a projection and no provider is connected.';
comment on column public.sessions.appointment_type is
  'Closed operational type: tattoo session, in-person consultation, video consultation or touch-up.';
comment on column public.sessions.client_id is
  'Shared client linked to the appointment. Must agree with any enquiry or project link.';
comment on column public.sessions.enquiry_id is
  'Optional enquiry link. Consultations may exist before project conversion.';
comment on column public.sessions.project_id is
  'Optional for consultations; mandatory for tattoo sessions and touch-ups.';

-- ---------------------------------------------------------------------------
-- One database-owned active-overlap query
-- ---------------------------------------------------------------------------

create or replace function public.list_appointment_conflicts(
  p_artist_id uuid,
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
  client_id uuid,
  enquiry_id uuid,
  project_id uuid
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select s.id, s.appointment_type, s.status, s.start_at, s.end_at,
         s.client_id, s.enquiry_id, s.project_id
  from public.sessions s
  where s.artist_id = p_artist_id
    and s.status in ('proposed', 'confirmed')
    and s.id is distinct from p_exclude_appointment_id
    and tstzrange(s.start_at, s.end_at, '[)')
        && tstzrange(p_start_at, p_end_at, '[)')
  order by s.start_at, s.id;
$$;

revoke all on function public.list_appointment_conflicts(uuid,timestamptz,timestamptz,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_appointment_conflicts(uuid,timestamptz,timestamptz,uuid)
  to authenticated;

comment on function public.list_appointment_conflicts(uuid,timestamptz,timestamptz,uuid) is
  'RLS-filtered advisory overlap query across every active appointment type for one artist.';

-- ---------------------------------------------------------------------------
-- Appointment workflow RPCs
-- ---------------------------------------------------------------------------

create or replace function public.schedule_appointment(
  p_artist_id uuid,
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
  v_appointment_id uuid;
  v_actor_kind text;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_sessions');
  perform crm_private.require_active_artist(p_artist_id);

  if p_status not in ('draft', 'proposed', 'confirmed') then
    raise exception 'an appointment may only be created as draft, proposed or confirmed'
      using errcode = '22023';
  end if;

  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at then
    raise exception 'appointment end must be after its start'
      using errcode = '22023';
  end if;

  if not exists (select 1 from public.clients c where c.id = p_client_id) then
    raise exception 'client % does not exist', p_client_id
      using errcode = '23503';
  end if;

  insert into public.sessions (
    artist_id, client_id, enquiry_id, project_id, appointment_type,
    status, start_at, end_at, duration_hours, notes
  ) values (
    p_artist_id, p_client_id, p_enquiry_id, p_project_id, p_appointment_type,
    p_status, p_start_at, p_end_at,
    round(extract(epoch from (p_end_at - p_start_at))::numeric / 3600, 2),
    p_notes
  )
  returning id into v_appointment_id;

  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;

  perform crm_private.log_artist_activity(
    p_artist_id,
    'appointment.scheduled',
    v_actor_kind,
    auth.uid(),
    p_client_id,
    p_enquiry_id,
    p_project_id,
    v_appointment_id,
    null,
    jsonb_build_object(
      'appointment_type', p_appointment_type,
      'status', p_status
    )
  );

  if public.session_is_calendar_eligible(p_status) then
    perform crm_private.enqueue_outbox(
      'calendar_create',
      public.calendar_outbox_dedupe_key('create', v_appointment_id, 0),
      jsonb_build_object(
        'session_id', v_appointment_id,
        'appointment_type', p_appointment_type,
        'calendar_version', 0
      ),
      p_client_id, p_enquiry_id, p_project_id, v_appointment_id, null
    );
  end if;

  return jsonb_build_object(
    'appointment_id', v_appointment_id,
    'session_id', v_appointment_id,
    'appointment_type', p_appointment_type,
    'artist_id', p_artist_id,
    'client_id', p_client_id,
    'enquiry_id', p_enquiry_id,
    'project_id', p_project_id,
    'status', p_status
  );
end;
$$;

create or replace function public.set_appointment_status(
  p_appointment_id uuid,
  p_status public.session_status
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_previous public.session_status;
  v_artist uuid;
  v_client uuid;
  v_enquiry uuid;
  v_project uuid;
  v_type public.appointment_type;
  v_version integer;
  v_event_id text;
  v_actor_kind text;
begin
  select s.status, s.artist_id, s.client_id, s.enquiry_id, s.project_id,
         s.appointment_type, s.calendar_version, s.calendar_event_id
    into v_previous, v_artist, v_client, v_enquiry, v_project,
         v_type, v_version, v_event_id
  from public.sessions s
  where s.id = p_appointment_id
  for update;

  if not found then
    raise exception 'appointment % does not exist', p_appointment_id
      using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_artist, 'manage_sessions');

  if v_previous = p_status then
    return jsonb_build_object(
      'appointment_id', p_appointment_id,
      'session_id', p_appointment_id,
      'from_status', v_previous,
      'to_status', p_status,
      'changed', false
    );
  end if;

  if not (
    (v_previous = 'draft' and p_status in ('proposed', 'confirmed', 'cancelled'))
    or (v_previous = 'proposed' and p_status in ('draft', 'confirmed', 'cancelled'))
    or (v_previous = 'confirmed' and p_status in ('completed', 'cancelled', 'no_show'))
  ) then
    raise exception 'appointment transition % -> % is not allowed', v_previous, p_status
      using errcode = '42501';
  end if;

  update public.sessions s
  set status = p_status,
      cancelled_at = case when p_status = 'cancelled' then now() else null end,
      calendar_version = s.calendar_version + 1
  where s.id = p_appointment_id;

  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;

  perform crm_private.log_artist_activity(
    v_artist,
    'appointment.status_changed',
    v_actor_kind,
    auth.uid(),
    v_client,
    v_enquiry,
    v_project,
    p_appointment_id,
    null,
    jsonb_build_object(
      'appointment_type', v_type,
      'from_status', v_previous,
      'to_status', p_status
    )
  );

  if public.session_is_calendar_eligible(p_status) and v_event_id is null then
    perform crm_private.enqueue_outbox(
      'calendar_create',
      public.calendar_outbox_dedupe_key('create', p_appointment_id, v_version + 1),
      jsonb_build_object(
        'session_id', p_appointment_id,
        'appointment_type', v_type,
        'calendar_version', v_version + 1
      ),
      v_client, v_enquiry, v_project, p_appointment_id, null
    );
  elsif p_status = 'cancelled' and v_event_id is not null then
    perform crm_private.enqueue_outbox(
      'calendar_cancel',
      public.calendar_outbox_dedupe_key('cancel', p_appointment_id, v_version + 1),
      jsonb_build_object(
        'session_id', p_appointment_id,
        'appointment_type', v_type,
        'calendar_version', v_version + 1
      ),
      v_client, v_enquiry, v_project, p_appointment_id, null
    );
  elsif public.session_is_calendar_eligible(p_status) and v_event_id is not null then
    perform crm_private.enqueue_outbox(
      'calendar_update',
      public.calendar_outbox_dedupe_key('update', p_appointment_id, v_version + 1),
      jsonb_build_object(
        'session_id', p_appointment_id,
        'appointment_type', v_type,
        'calendar_version', v_version + 1
      ),
      v_client, v_enquiry, v_project, p_appointment_id, null
    );
  end if;

  return jsonb_build_object(
    'appointment_id', p_appointment_id,
    'session_id', p_appointment_id,
    'appointment_type', v_type,
    'from_status', v_previous,
    'to_status', p_status,
    'changed', true
  );
end;
$$;

revoke all on function public.schedule_appointment(uuid,uuid,public.appointment_type,timestamptz,timestamptz,public.session_status,uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.set_appointment_status(uuid,public.session_status)
  from public, anon, authenticated, service_role;
grant execute on function public.schedule_appointment(uuid,uuid,public.appointment_type,timestamptz,timestamptz,public.session_status,uuid,uuid,text)
  to authenticated;
grant execute on function public.set_appointment_status(uuid,public.session_status)
  to authenticated;

comment on function public.schedule_appointment(uuid,uuid,public.appointment_type,timestamptz,timestamptz,public.session_status,uuid,uuid,text) is
  'Schedules one artist-scoped appointment. Relationship consistency and manage_sessions capability are enforced by the database.';
comment on function public.set_appointment_status(uuid,public.session_status) is
  'Changes one appointment lifecycle state, including projectless consultations.';

-- Existing public.schedule_session and public.set_session_status functions are
-- intentionally left unchanged. They remain the tested compatibility boundary
-- for project-owned tattoo sessions while the new appointment RPCs support all
-- four types and projectless consultations.
