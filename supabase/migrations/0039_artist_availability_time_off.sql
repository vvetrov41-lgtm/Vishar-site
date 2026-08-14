-- 0039_artist_availability_time_off.sql
--
-- CRM-authoritative artist availability blocks. Time off is artist-scoped and
-- enforced by the database across both current appointment RPCs and the legacy
-- session compatibility surface. Google Calendar remains a downstream
-- projection and is intentionally not changed by this migration.

do $$ begin
  create type public.availability_block_kind as enum (
    'day_off', 'holiday', 'personal', 'other'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.artist_availability_blocks (
  id            uuid primary key default gen_random_uuid(),
  artist_id     uuid not null references public.artists(id) on delete restrict,
  block_kind    public.availability_block_kind not null,
  start_at      timestamptz not null,
  end_at        timestamptz not null,
  is_all_day    boolean not null default false,
  note          text,
  created_by    uuid not null references public.profiles(id) on delete restrict,
  updated_by    uuid not null references public.profiles(id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  cancelled_at  timestamptz,

  constraint artist_availability_blocks_time_order
    check (end_at > start_at),
  constraint artist_availability_blocks_duration_bound
    check (end_at - start_at <= interval '366 days'),
  constraint artist_availability_blocks_note_length
    check (note is null or char_length(note) <= 500)
);

create index if not exists artist_availability_blocks_active_range_idx
  on public.artist_availability_blocks (artist_id, start_at, end_at)
  where cancelled_at is null;

alter table public.artist_availability_blocks enable row level security;
alter table public.artist_availability_blocks force row level security;
revoke all on public.artist_availability_blocks
  from public, anon, authenticated, service_role;

comment on table public.artist_availability_blocks is
  'CRM-authoritative artist time-off intervals. Direct table access is closed; reads and writes use artist-scoped RPCs.';
comment on column public.artist_availability_blocks.cancelled_at is
  'Soft-cancel marker. Cancelled blocks no longer prevent appointments but remain auditable.';

create trigger artist_availability_blocks_set_updated_at
  before update on public.artist_availability_blocks
  for each row execute function public.set_updated_at();

-- All schedule-changing operations for one artist share the same transaction
-- lock. This prevents a concurrent appointment and time-off block from both
-- passing their overlap checks before either transaction commits.
create or replace function crm_private.lock_artist_schedule(p_artist_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if p_artist_id is null then
    raise exception 'artist is required for schedule locking' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('crm:artist-schedule:' || p_artist_id::text, 0)
  );
end;
$$;

create or replace function crm_private.assert_artist_available(
  p_artist_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if exists (
    select 1
    from public.artist_availability_blocks b
    where b.artist_id = p_artist_id
      and b.cancelled_at is null
      and tstzrange(b.start_at, b.end_at, '[)')
          && tstzrange(p_start_at, p_end_at, '[)')
  ) then
    raise exception 'artist availability blocks this time' using errcode = '22023';
  end if;
end;
$$;

create or replace function crm_private.assert_block_has_no_active_appointments(
  p_artist_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if exists (
    select 1
    from public.sessions s
    where s.artist_id = p_artist_id
      and s.status in ('proposed', 'confirmed')
      and tstzrange(s.start_at, s.end_at, '[)')
          && tstzrange(p_start_at, p_end_at, '[)')
  ) then
    raise exception 'time off overlaps an active appointment' using errcode = '22023';
  end if;
end;
$$;

create or replace function crm_private.assert_no_other_availability_block(
  p_artist_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_exclude_block_id uuid default null
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if exists (
    select 1
    from public.artist_availability_blocks b
    where b.artist_id = p_artist_id
      and b.cancelled_at is null
      and b.id is distinct from p_exclude_block_id
      and tstzrange(b.start_at, b.end_at, '[)')
          && tstzrange(p_start_at, p_end_at, '[)')
  ) then
    raise exception 'time off overlaps another active availability block' using errcode = '22023';
  end if;
end;
$$;

revoke all on function crm_private.lock_artist_schedule(uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.assert_artist_available(uuid,timestamptz,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.assert_block_has_no_active_appointments(uuid,timestamptz,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.assert_no_other_availability_block(uuid,timestamptz,timestamptz,uuid)
  from public, anon, authenticated, service_role;

create or replace function public.list_artist_availability_blocks(
  p_artist_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_include_cancelled boolean default false
)
returns table (
  block_id uuid,
  artist_id uuid,
  block_kind public.availability_block_kind,
  start_at timestamptz,
  end_at timestamptz,
  is_all_day boolean,
  note text,
  cancelled_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'availability range end must be after its start' using errcode = '22023';
  end if;
  if p_to - p_from > interval '400 days' then
    raise exception 'availability range may not exceed 400 days' using errcode = '22023';
  end if;

  perform crm_private.require_artist_access(p_artist_id, 'view');

  return query
  select b.id, b.artist_id, b.block_kind, b.start_at, b.end_at,
         b.is_all_day, b.note, b.cancelled_at, b.created_at, b.updated_at
  from public.artist_availability_blocks b
  where b.artist_id = p_artist_id
    and b.start_at < p_to
    and b.end_at > p_from
    and (p_include_cancelled or b.cancelled_at is null)
  order by b.start_at, b.id;
end;
$$;

create or replace function public.create_artist_availability_block(
  p_artist_id uuid,
  p_block_kind public.availability_block_kind,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_is_all_day boolean default false,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid;
  v_note text;
  v_actor_kind text;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_sessions');
  perform crm_private.require_active_artist(p_artist_id);

  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at then
    raise exception 'time off end must be after its start' using errcode = '22023';
  end if;
  if p_end_at - p_start_at > interval '366 days' then
    raise exception 'one time off block may not exceed 366 days' using errcode = '22023';
  end if;

  v_note := nullif(btrim(p_note), '');
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'time off note may not exceed 500 characters' using errcode = '22023';
  end if;

  perform crm_private.lock_artist_schedule(p_artist_id);
  perform crm_private.assert_block_has_no_active_appointments(p_artist_id, p_start_at, p_end_at);
  perform crm_private.assert_no_other_availability_block(p_artist_id, p_start_at, p_end_at, null);

  insert into public.artist_availability_blocks (
    artist_id, block_kind, start_at, end_at, is_all_day, note,
    created_by, updated_by
  ) values (
    p_artist_id, p_block_kind, p_start_at, p_end_at, coalesce(p_is_all_day, false), v_note,
    auth.uid(), auth.uid()
  ) returning id into v_id;

  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;
  perform crm_private.log_artist_activity(
    p_artist_id,
    'availability.block_created',
    v_actor_kind,
    auth.uid(),
    null, null, null, null, null,
    jsonb_build_object(
      'availability_block_id', v_id,
      'block_kind', p_block_kind,
      'start_at', p_start_at,
      'end_at', p_end_at,
      'is_all_day', coalesce(p_is_all_day, false)
    )
  );

  return jsonb_build_object(
    'availability_block_id', v_id,
    'artist_id', p_artist_id,
    'block_kind', p_block_kind,
    'start_at', p_start_at,
    'end_at', p_end_at,
    'is_all_day', coalesce(p_is_all_day, false),
    'changed', true
  );
end;
$$;

create or replace function public.update_artist_availability_block(
  p_block_id uuid,
  p_block_kind public.availability_block_kind,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_is_all_day boolean default false,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_block public.artist_availability_blocks%rowtype;
  v_note text;
  v_actor_kind text;
begin
  select b.* into v_block
  from public.artist_availability_blocks b
  where b.id = p_block_id
  for update;

  if not found then
    raise exception 'availability block % does not exist', p_block_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_block.artist_id, 'manage_sessions');
  perform crm_private.require_active_artist(v_block.artist_id);

  if v_block.cancelled_at is not null then
    raise exception 'a cancelled availability block cannot be edited' using errcode = '42501';
  end if;
  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at then
    raise exception 'time off end must be after its start' using errcode = '22023';
  end if;
  if p_end_at - p_start_at > interval '366 days' then
    raise exception 'one time off block may not exceed 366 days' using errcode = '22023';
  end if;

  v_note := nullif(btrim(p_note), '');
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'time off note may not exceed 500 characters' using errcode = '22023';
  end if;

  perform crm_private.lock_artist_schedule(v_block.artist_id);
  perform crm_private.assert_block_has_no_active_appointments(v_block.artist_id, p_start_at, p_end_at);
  perform crm_private.assert_no_other_availability_block(
    v_block.artist_id, p_start_at, p_end_at, p_block_id
  );

  if v_block.block_kind = p_block_kind
     and v_block.start_at = p_start_at
     and v_block.end_at = p_end_at
     and v_block.is_all_day = coalesce(p_is_all_day, false)
     and v_block.note is not distinct from v_note then
    return jsonb_build_object(
      'availability_block_id', p_block_id,
      'artist_id', v_block.artist_id,
      'changed', false
    );
  end if;

  update public.artist_availability_blocks b
  set block_kind = p_block_kind,
      start_at = p_start_at,
      end_at = p_end_at,
      is_all_day = coalesce(p_is_all_day, false),
      note = v_note,
      updated_by = auth.uid()
  where b.id = p_block_id;

  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;
  perform crm_private.log_artist_activity(
    v_block.artist_id,
    'availability.block_updated',
    v_actor_kind,
    auth.uid(),
    null, null, null, null, null,
    jsonb_build_object(
      'availability_block_id', p_block_id,
      'from_block_kind', v_block.block_kind,
      'from_start_at', v_block.start_at,
      'from_end_at', v_block.end_at,
      'to_block_kind', p_block_kind,
      'to_start_at', p_start_at,
      'to_end_at', p_end_at,
      'is_all_day', coalesce(p_is_all_day, false)
    )
  );

  return jsonb_build_object(
    'availability_block_id', p_block_id,
    'artist_id', v_block.artist_id,
    'block_kind', p_block_kind,
    'start_at', p_start_at,
    'end_at', p_end_at,
    'is_all_day', coalesce(p_is_all_day, false),
    'changed', true
  );
end;
$$;

create or replace function public.cancel_artist_availability_block(p_block_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_block public.artist_availability_blocks%rowtype;
  v_actor_kind text;
begin
  select b.* into v_block
  from public.artist_availability_blocks b
  where b.id = p_block_id
  for update;

  if not found then
    raise exception 'availability block % does not exist', p_block_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_block.artist_id, 'manage_sessions');
  perform crm_private.lock_artist_schedule(v_block.artist_id);

  if v_block.cancelled_at is not null then
    return jsonb_build_object(
      'availability_block_id', p_block_id,
      'artist_id', v_block.artist_id,
      'changed', false
    );
  end if;

  update public.artist_availability_blocks b
  set cancelled_at = now(),
      updated_by = auth.uid()
  where b.id = p_block_id;

  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;
  perform crm_private.log_artist_activity(
    v_block.artist_id,
    'availability.block_cancelled',
    v_actor_kind,
    auth.uid(),
    null, null, null, null, null,
    jsonb_build_object(
      'availability_block_id', p_block_id,
      'block_kind', v_block.block_kind,
      'start_at', v_block.start_at,
      'end_at', v_block.end_at
    )
  );

  return jsonb_build_object(
    'availability_block_id', p_block_id,
    'artist_id', v_block.artist_id,
    'changed', true
  );
end;
$$;

revoke all on function public.list_artist_availability_blocks(uuid,timestamptz,timestamptz,boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.create_artist_availability_block(uuid,public.availability_block_kind,timestamptz,timestamptz,boolean,text)
  from public, anon, authenticated, service_role;
revoke all on function public.update_artist_availability_block(uuid,public.availability_block_kind,timestamptz,timestamptz,boolean,text)
  from public, anon, authenticated, service_role;
revoke all on function public.cancel_artist_availability_block(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.list_artist_availability_blocks(uuid,timestamptz,timestamptz,boolean)
  to authenticated;
grant execute on function public.create_artist_availability_block(uuid,public.availability_block_kind,timestamptz,timestamptz,boolean,text)
  to authenticated;
grant execute on function public.update_artist_availability_block(uuid,public.availability_block_kind,timestamptz,timestamptz,boolean,text)
  to authenticated;
grant execute on function public.cancel_artist_availability_block(uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Canonical appointment enforcement
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

  if p_status in ('proposed', 'confirmed') then
    perform crm_private.lock_artist_schedule(p_artist_id);
    perform crm_private.assert_artist_available(p_artist_id, p_start_at, p_end_at);
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

create or replace function public.reschedule_appointment(
  p_appointment_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist uuid;
  v_client uuid;
  v_enquiry uuid;
  v_project uuid;
  v_type public.appointment_type;
  v_status public.session_status;
  v_previous_start timestamptz;
  v_previous_end timestamptz;
  v_event_id text;
  v_version integer;
  v_next_version integer;
  v_outbox_kind public.outbox_kind;
  v_actor_kind text;
begin
  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at then
    raise exception 'appointment end must be after its start' using errcode = '22023';
  end if;

  select s.artist_id, s.client_id, s.enquiry_id, s.project_id,
         s.appointment_type, s.status, s.start_at, s.end_at,
         s.calendar_event_id, s.calendar_version
    into v_artist, v_client, v_enquiry, v_project,
         v_type, v_status, v_previous_start, v_previous_end,
         v_event_id, v_version
  from public.sessions s
  where s.id = p_appointment_id
  for update;

  if not found then
    raise exception 'appointment % does not exist', p_appointment_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_artist, 'manage_sessions');
  perform crm_private.require_active_artist(v_artist);

  if v_status in ('completed', 'cancelled', 'no_show') then
    raise exception 'a terminal appointment cannot be rescheduled' using errcode = '42501';
  end if;

  if v_previous_start = p_start_at and v_previous_end = p_end_at then
    return jsonb_build_object('appointment_id', p_appointment_id, 'changed', false, 'calendar_version', v_version);
  end if;

  if v_status in ('proposed', 'confirmed') then
    perform crm_private.lock_artist_schedule(v_artist);
    perform crm_private.assert_artist_available(v_artist, p_start_at, p_end_at);
  end if;

  v_next_version := v_version + 1;

  update public.sessions
  set start_at = p_start_at,
      end_at = p_end_at,
      duration_hours = round(extract(epoch from (p_end_at - p_start_at))::numeric / 3600, 2),
      calendar_version = v_next_version,
      calendar_sync_status = case
        when public.session_is_calendar_eligible(v_status) then 'queued'::public.calendar_sync_status
        else 'not_connected'::public.calendar_sync_status
      end,
      calendar_last_error_code = null,
      updated_at = now()
  where id = p_appointment_id;

  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;

  perform crm_private.log_artist_activity(
    v_artist, 'appointment.rescheduled', v_actor_kind, auth.uid(),
    v_client, v_enquiry, v_project, p_appointment_id, null,
    jsonb_build_object(
      'appointment_type', v_type,
      'from_start_at', v_previous_start,
      'from_end_at', v_previous_end,
      'to_start_at', p_start_at,
      'to_end_at', p_end_at,
      'calendar_version', v_next_version
    )
  );

  if public.session_is_calendar_eligible(v_status) then
    v_outbox_kind := case
      when v_event_id is null then 'calendar_create'::public.outbox_kind
      else 'calendar_update'::public.outbox_kind
    end;

    perform crm_private.enqueue_outbox(
      v_outbox_kind,
      public.calendar_outbox_dedupe_key(
        case when v_event_id is null then 'create' else 'update' end,
        p_appointment_id,
        v_next_version
      ),
      jsonb_build_object(
        'session_id', p_appointment_id,
        'appointment_type', v_type,
        'calendar_version', v_next_version
      ),
      v_client, v_enquiry, v_project, p_appointment_id, null
    );
  end if;

  return jsonb_build_object(
    'appointment_id', p_appointment_id,
    'changed', true,
    'start_at', p_start_at,
    'end_at', p_end_at,
    'calendar_version', v_next_version,
    'calendar_operation', case
      when not public.session_is_calendar_eligible(v_status) then null
      when v_event_id is null then 'create'
      else 'update'
    end
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
  v_start_at timestamptz;
  v_end_at timestamptz;
  v_version integer;
  v_event_id text;
  v_actor_kind text;
begin
  select s.status, s.artist_id, s.client_id, s.enquiry_id, s.project_id,
         s.appointment_type, s.start_at, s.end_at,
         s.calendar_version, s.calendar_event_id
    into v_previous, v_artist, v_client, v_enquiry, v_project,
         v_type, v_start_at, v_end_at, v_version, v_event_id
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

  if p_status in ('proposed', 'confirmed') then
    perform crm_private.lock_artist_schedule(v_artist);
    perform crm_private.assert_artist_available(v_artist, v_start_at, v_end_at);
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

-- Compatibility RPCs are still callable by existing screens, so they must use
-- the same availability lock and hard-block boundary.
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
  if p_status in ('proposed', 'confirmed') then
    perform crm_private.lock_artist_schedule(v_artist_id);
    perform crm_private.assert_artist_available(v_artist_id, p_start_at, p_end_at);
  end if;

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
  v_start_at timestamptz;
  v_end_at timestamptz;
begin
  select s.artist_id, s.start_at, s.end_at
    into v_artist_id, v_start_at, v_end_at
  from public.sessions s
  where s.id = p_session_id
  for update;
  if not found then
    raise exception 'session % does not exist', p_session_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_artist_id, 'manage_sessions');
  if p_status in ('proposed', 'confirmed') then
    perform crm_private.lock_artist_schedule(v_artist_id);
    perform crm_private.assert_artist_available(v_artist_id, v_start_at, v_end_at);
  end if;

  return crm_private.legacy_set_session_status(p_session_id, p_status);
end;
$$;

-- Preserve the existing public RPC ACLs explicitly after replacement.
revoke all on function public.schedule_appointment(uuid,uuid,public.appointment_type,timestamptz,timestamptz,public.session_status,uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.reschedule_appointment(uuid,timestamptz,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.set_appointment_status(uuid,public.session_status)
  from public, anon, authenticated, service_role;
revoke all on function public.schedule_session(uuid,timestamptz,timestamptz,public.session_status,text)
  from public, anon, authenticated, service_role;
revoke all on function public.set_session_status(uuid,public.session_status)
  from public, anon, authenticated, service_role;

grant execute on function public.schedule_appointment(uuid,uuid,public.appointment_type,timestamptz,timestamptz,public.session_status,uuid,uuid,text)
  to authenticated;
grant execute on function public.reschedule_appointment(uuid,timestamptz,timestamptz)
  to authenticated;
grant execute on function public.set_appointment_status(uuid,public.session_status)
  to authenticated;
grant execute on function public.schedule_session(uuid,timestamptz,timestamptz,public.session_status,text)
  to authenticated;
grant execute on function public.set_session_status(uuid,public.session_status)
  to authenticated;

comment on function public.list_artist_availability_blocks(uuid,timestamptz,timestamptz,boolean) is
  'Lists artist-scoped CRM-authoritative availability blocks without granting direct table access.';
comment on function public.create_artist_availability_block(uuid,public.availability_block_kind,timestamptz,timestamptz,boolean,text) is
  'Creates one artist-scoped time-off block after serialised active-appointment conflict checks.';
comment on function public.update_artist_availability_block(uuid,public.availability_block_kind,timestamptz,timestamptz,boolean,text) is
  'Edits an active artist time-off block after serialised conflict checks.';
comment on function public.cancel_artist_availability_block(uuid) is
  'Soft-cancels one artist time-off block while preserving audit history.';
comment on function public.schedule_appointment(uuid,uuid,public.appointment_type,timestamptz,timestamptz,public.session_status,uuid,uuid,text) is
  'Schedules one artist-scoped appointment and hard-rejects active appointments that overlap CRM availability blocks.';
comment on function public.reschedule_appointment(uuid,timestamptz,timestamptz) is
  'Authorised atomic appointment reschedule with calendar versioning and CRM availability enforcement.';