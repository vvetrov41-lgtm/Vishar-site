-- 0120_artist_scheduling_policy.sql
--
-- Artist scheduling preferences, per-day overrides, and an explicit
-- booking-type conflict policy enforced in the authoritative booking path.
--
-- WHY THIS EXISTS
--
-- Two defects, both verified against production before this was written.
--
-- 1. Nothing stopped two tattoo sessions overlapping. schedule_appointment,
--    reschedule_appointment and set_appointment_status all asserted artist
--    time off (0039) and nothing else. Overlap was advisory only: the browser
--    called list_appointment_conflicts and offered an acknowledgement
--    checkbox. A second client could be double-booked into the same seven
--    hours by any path that did not go through that form.
--
-- 2. Where overlap *was* checked, it was checked generically, which is wrong
--    for this studio. A consultation may legitimately happen while a tattoo
--    session is in progress - before it, between other work, or during it.
--    Treating every appointment as mutually exclusive would make the calendar
--    read as full when it is not.
--
-- So the rule cannot be "appointments do not overlap". It has to be a policy
-- that knows what kind of work each appointment is:
--
--     tattoo       vs tattoo       -> BLOCK
--     tattoo       vs consultation -> ALLOW  (subject to preference)
--     consultation vs tattoo       -> ALLOW  (subject to preference)
--     consultation vs consultation -> BLOCK  beyond the concurrency cap
--     time off     vs anything     -> BLOCK
--
-- touch_up is tattoo work and joins the tattoo family. video_consultation and
-- in_person_consultation both occupy the artist, so they share one
-- consultation family and one concurrency cap.
--
-- The policy is a function, not a scattering of conditionals, so the advisory
-- read the interface uses and the assertion the write path uses cannot drift
-- apart: both call it.

-- ---------------------------------------------------------------------------
-- 1. Booking families and the type-pair policy
-- ---------------------------------------------------------------------------

create or replace function crm_private.appointment_family(
  p_type public.appointment_type
)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case p_type
    when 'tattoo_session' then 'tattoo'
    when 'touch_up' then 'tattoo'
    else 'consultation'
  end;
$$;

comment on function crm_private.appointment_family(public.appointment_type) is
  'Booking family for conflict purposes. Touch-ups are tattoo work; both consultation kinds share one family because both occupy the artist.';

-- ---------------------------------------------------------------------------
-- 2. Artist scheduling preferences
--
-- Deliberately NOT an opening-hours table. A tattoo day is flexible: the same
-- artist may work 09:00-16:00, 10:00-15:00 or 11:00-18:00 depending on the
-- piece. What is stable is the boundary - the earliest a session normally
-- starts and the latest one normally finishes - plus the start times that are
-- habitual. The duration chosen for a booking stays authoritative; these
-- values only decide which starts are offered.
-- ---------------------------------------------------------------------------

create table if not exists public.artist_scheduling_preferences (
  artist_id                    uuid primary key
                                 references public.artists(id) on delete cascade,
  tattoo_earliest_start        time not null default '09:00',
  tattoo_latest_finish         time not null default '18:00',
  -- Habitual starts, offered first. Not a closed set: any start inside the
  -- boundary that fits the duration is still valid and still offered.
  tattoo_preferred_starts      time[] not null default array['09:00','10:00','11:00']::time[],
  consultation_earliest_start  time not null default '09:00',
  consultation_latest_finish   time not null default '20:00',
  -- The product rule that makes this studio different from a salon.
  consultation_during_tattoo   boolean not null default true,
  -- Stops pathological stacking. 1 means a second overlapping consultation is
  -- refused, which is the "normally BLOCK" half of the policy.
  max_concurrent_consultations smallint not null default 1,
  updated_by                   uuid references public.profiles(id) on delete set null,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),

  constraint artist_scheduling_tattoo_window
    check (tattoo_latest_finish > tattoo_earliest_start),
  constraint artist_scheduling_consultation_window
    check (consultation_latest_finish > consultation_earliest_start),
  constraint artist_scheduling_preferred_starts_bounded
    check (array_length(tattoo_preferred_starts, 1) between 1 and 12),
  constraint artist_scheduling_concurrency_bounded
    check (max_concurrent_consultations between 1 and 4)
);

comment on table public.artist_scheduling_preferences is
  'Practical booking boundaries for one artist. Not opening hours: a tattoo day is flexible, so this stores the earliest normal start, the latest normal finish, habitual start times, and the consultation overlap policy.';

alter table public.artist_scheduling_preferences enable row level security;
alter table public.artist_scheduling_preferences force row level security;
revoke all on public.artist_scheduling_preferences from public, anon, authenticated, service_role;

drop trigger if exists artist_scheduling_preferences_set_updated_at
  on public.artist_scheduling_preferences;
create trigger artist_scheduling_preferences_set_updated_at
  before update on public.artist_scheduling_preferences
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Per-day overrides
--
-- "This Tuesday I can start at 08:00" and "this Friday I stop at 15:00" are
-- not time off, and modelling them as time off would be a lie that also
-- blocks consultations. A day that is entirely unavailable is still time off:
-- artist_availability_blocks already says that correctly, and this table
-- deliberately has no "unavailable" column so the two cannot disagree.
-- ---------------------------------------------------------------------------

create table if not exists public.artist_schedule_overrides (
  id                    uuid primary key default gen_random_uuid(),
  artist_id             uuid not null references public.artists(id) on delete cascade,
  on_date               date not null,
  -- Null means "inherit the standing preference for that boundary".
  tattoo_earliest_start time,
  tattoo_latest_finish  time,
  note                  text,
  created_by            uuid references public.profiles(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (artist_id, on_date),
  constraint artist_schedule_override_window
    check (
      tattoo_earliest_start is null
      or tattoo_latest_finish is null
      or tattoo_latest_finish > tattoo_earliest_start
    ),
  constraint artist_schedule_override_says_something
    check (tattoo_earliest_start is not null or tattoo_latest_finish is not null),
  constraint artist_schedule_override_note_length
    check (note is null or char_length(note) <= 500)
);

comment on table public.artist_schedule_overrides is
  'Per-day exceptions to the standing tattoo window. A fully unavailable day is time off (artist_availability_blocks), not an override, so this table has no unavailable flag.';

create index if not exists artist_schedule_overrides_lookup_idx
  on public.artist_schedule_overrides (artist_id, on_date);

alter table public.artist_schedule_overrides enable row level security;
alter table public.artist_schedule_overrides force row level security;
revoke all on public.artist_schedule_overrides from public, anon, authenticated, service_role;

drop trigger if exists artist_schedule_overrides_set_updated_at
  on public.artist_schedule_overrides;
create trigger artist_schedule_overrides_set_updated_at
  before update on public.artist_schedule_overrides
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Effective preferences, with defaults for an artist who has no row yet
-- ---------------------------------------------------------------------------

create or replace function crm_private.effective_scheduling_preferences(p_artist_id uuid)
returns public.artist_scheduling_preferences
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_row public.artist_scheduling_preferences;
begin
  select * into v_row
  from public.artist_scheduling_preferences
  where artist_id = p_artist_id;

  if found then
    return v_row;
  end if;

  -- An artist with no stored row behaves exactly as the column defaults say,
  -- so booking never depends on somebody having visited a settings screen.
  v_row.artist_id := p_artist_id;
  v_row.tattoo_earliest_start := '09:00';
  v_row.tattoo_latest_finish := '18:00';
  v_row.tattoo_preferred_starts := array['09:00','10:00','11:00']::time[];
  v_row.consultation_earliest_start := '09:00';
  v_row.consultation_latest_finish := '20:00';
  v_row.consultation_during_tattoo := true;
  v_row.max_concurrent_consultations := 1;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The authoritative conflict assertion
--
-- Called inside the same transaction as the insert/update, after
-- lock_artist_schedule, so two concurrent bookings cannot both pass.
-- ---------------------------------------------------------------------------

create or replace function crm_private.assert_booking_slot_free(
  p_artist_id uuid,
  p_type public.appointment_type,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_exclude_appointment_id uuid default null
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_family text := crm_private.appointment_family(p_type);
  v_prefs public.artist_scheduling_preferences;
  v_overlapping integer;
begin
  -- Time off blocks every kind of booking. A day the artist is not there is
  -- not a day a consultation can happen either.
  perform crm_private.assert_artist_available(p_artist_id, p_start_at, p_end_at);

  v_prefs := crm_private.effective_scheduling_preferences(p_artist_id);

  if v_family = 'tattoo' then
    -- Tattoo vs tattoo: block. Consultations in the same window are ignored
    -- on purpose - a consultation running alongside does not stop the piece.
    if exists (
      select 1
      from public.sessions s
      where s.artist_id = p_artist_id
        and s.status in ('proposed', 'confirmed')
        and s.id is distinct from p_exclude_appointment_id
        and crm_private.appointment_family(s.appointment_type) = 'tattoo'
        and tstzrange(s.start_at, s.end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
    ) then
      raise exception 'another tattoo session already occupies this time'
        using errcode = '22023';
    end if;
    return;
  end if;

  -- Consultation family from here.
  if not v_prefs.consultation_during_tattoo then
    if exists (
      select 1
      from public.sessions s
      where s.artist_id = p_artist_id
        and s.status in ('proposed', 'confirmed')
        and s.id is distinct from p_exclude_appointment_id
        and crm_private.appointment_family(s.appointment_type) = 'tattoo'
        and tstzrange(s.start_at, s.end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
    ) then
      raise exception 'this artist does not take consultations during a tattoo session'
        using errcode = '22023';
    end if;
  end if;

  -- Consultation vs consultation: allowed only up to the artist's cap, which
  -- defaults to one. This is what stops unlimited stacking.
  select count(*) into v_overlapping
  from public.sessions s
  where s.artist_id = p_artist_id
    and s.status in ('proposed', 'confirmed')
    and s.id is distinct from p_exclude_appointment_id
    and crm_private.appointment_family(s.appointment_type) = 'consultation'
    and tstzrange(s.start_at, s.end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)');

  if v_overlapping >= v_prefs.max_concurrent_consultations then
    raise exception 'another consultation already occupies this time'
      using errcode = '22023';
  end if;
end;
$$;

comment on function crm_private.assert_booking_slot_free(uuid, public.appointment_type, timestamptz, timestamptz, uuid) is
  'Authoritative booking-type conflict policy. Tattoo work is mutually exclusive; consultations may run alongside tattoo work but not stack beyond the artist cap; time off blocks everything.';

-- ---------------------------------------------------------------------------
-- 6. The advisory read the interface warns from, using the same policy
-- ---------------------------------------------------------------------------

create or replace function public.list_booking_conflicts(
  p_artist_id uuid,
  p_appointment_type public.appointment_type,
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
  project_id uuid,
  blocks boolean
)
language plpgsql
stable
-- SECURITY DEFINER because it reads the artist's stored policy, which lives
-- behind crm_private. Scope is re-established explicitly below, exactly as
-- list_artist_availability_blocks does (0039).
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_family text := crm_private.appointment_family(p_appointment_type);
  v_allow_during_tattoo boolean;
begin
  perform crm_private.require_artist_access(p_artist_id, 'view');

  select p.consultation_during_tattoo into v_allow_during_tattoo
  from crm_private.effective_scheduling_preferences(p_artist_id) p;

  return query
  select s.id, s.appointment_type, s.status, s.start_at, s.end_at,
         s.client_id, s.enquiry_id, s.project_id,
         -- Whether this overlap would actually refuse the booking, so the
         -- interface can show "also happening then" without crying wolf.
         case
           when v_family = 'tattoo'
             then crm_private.appointment_family(s.appointment_type) = 'tattoo'
           when crm_private.appointment_family(s.appointment_type) = 'consultation'
             then true
           else not v_allow_during_tattoo
         end as blocks
  from public.sessions s
  where s.artist_id = p_artist_id
    and s.status in ('proposed', 'confirmed')
    and s.id is distinct from p_exclude_appointment_id
    and tstzrange(s.start_at, s.end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
  order by s.start_at, s.id;
end;
$$;

comment on function public.list_booking_conflicts(uuid, public.appointment_type, timestamptz, timestamptz, uuid) is
  'Advisory overlap read that applies the same booking-type policy the write path enforces. `blocks` says whether the overlap would actually refuse the booking.';

-- ---------------------------------------------------------------------------
-- 7. Reading and writing preferences
-- ---------------------------------------------------------------------------

create or replace function public.get_artist_scheduling_preferences(p_artist_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_prefs public.artist_scheduling_preferences;
begin
  perform crm_private.require_artist_access(p_artist_id, 'view');
  v_prefs := crm_private.effective_scheduling_preferences(p_artist_id);

  return jsonb_build_object(
    'artist_id', p_artist_id,
    'tattoo_earliest_start', to_char(v_prefs.tattoo_earliest_start, 'HH24:MI'),
    'tattoo_latest_finish', to_char(v_prefs.tattoo_latest_finish, 'HH24:MI'),
    'tattoo_preferred_starts', (
      select coalesce(jsonb_agg(to_char(t, 'HH24:MI') order by t), '[]'::jsonb)
      from unnest(v_prefs.tattoo_preferred_starts) as t
    ),
    'consultation_earliest_start', to_char(v_prefs.consultation_earliest_start, 'HH24:MI'),
    'consultation_latest_finish', to_char(v_prefs.consultation_latest_finish, 'HH24:MI'),
    'consultation_during_tattoo', v_prefs.consultation_during_tattoo,
    'max_concurrent_consultations', v_prefs.max_concurrent_consultations,
    'is_stored', exists (
      select 1 from public.artist_scheduling_preferences p where p.artist_id = p_artist_id
    )
  );
end;
$$;

create or replace function public.set_artist_scheduling_preferences(
  p_artist_id uuid,
  p_tattoo_earliest_start text,
  p_tattoo_latest_finish text,
  p_tattoo_preferred_starts text[],
  p_consultation_earliest_start text,
  p_consultation_latest_finish text,
  p_consultation_during_tattoo boolean,
  p_max_concurrent_consultations integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_starts time[];
begin
  -- Scheduling preferences decide what the whole studio may be booked into,
  -- so they need the same authority as changing the schedule itself.
  perform crm_private.require_artist_access(p_artist_id, 'manage_sessions');
  perform crm_private.require_active_artist(p_artist_id);

  if p_tattoo_preferred_starts is null or array_length(p_tattoo_preferred_starts, 1) is null then
    raise exception 'at least one preferred start time is required' using errcode = '22023';
  end if;

  select array_agg(distinct t::time order by t::time) into v_starts
  from unnest(p_tattoo_preferred_starts) as t;

  insert into public.artist_scheduling_preferences as p (
    artist_id, tattoo_earliest_start, tattoo_latest_finish, tattoo_preferred_starts,
    consultation_earliest_start, consultation_latest_finish,
    consultation_during_tattoo, max_concurrent_consultations, updated_by
  ) values (
    p_artist_id,
    p_tattoo_earliest_start::time,
    p_tattoo_latest_finish::time,
    v_starts,
    p_consultation_earliest_start::time,
    p_consultation_latest_finish::time,
    coalesce(p_consultation_during_tattoo, true),
    coalesce(p_max_concurrent_consultations, 1)::smallint,
    auth.uid()
  )
  on conflict (artist_id) do update set
    tattoo_earliest_start = excluded.tattoo_earliest_start,
    tattoo_latest_finish = excluded.tattoo_latest_finish,
    tattoo_preferred_starts = excluded.tattoo_preferred_starts,
    consultation_earliest_start = excluded.consultation_earliest_start,
    consultation_latest_finish = excluded.consultation_latest_finish,
    consultation_during_tattoo = excluded.consultation_during_tattoo,
    max_concurrent_consultations = excluded.max_concurrent_consultations,
    updated_by = excluded.updated_by,
    updated_at = now();

  return public.get_artist_scheduling_preferences(p_artist_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Per-day overrides: read and write
-- ---------------------------------------------------------------------------

create or replace function public.list_artist_schedule_overrides(
  p_artist_id uuid,
  p_from date,
  p_to date
)
returns table (
  override_id uuid,
  artist_id uuid,
  on_date date,
  tattoo_earliest_start text,
  tattoo_latest_finish text,
  note text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'override range end must not be before its start' using errcode = '22023';
  end if;
  if p_to - p_from > 400 then
    raise exception 'override range may not exceed 400 days' using errcode = '22023';
  end if;

  perform crm_private.require_artist_access(p_artist_id, 'view');

  return query
  select o.id, o.artist_id, o.on_date,
         to_char(o.tattoo_earliest_start, 'HH24:MI'),
         to_char(o.tattoo_latest_finish, 'HH24:MI'),
         o.note
  from public.artist_schedule_overrides o
  where o.artist_id = p_artist_id
    and o.on_date between p_from and p_to
  order by o.on_date;
end;
$$;

create or replace function public.set_artist_schedule_override(
  p_artist_id uuid,
  p_on_date date,
  p_tattoo_earliest_start text default null,
  p_tattoo_latest_finish text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_sessions');
  perform crm_private.require_active_artist(p_artist_id);

  if p_on_date is null then
    raise exception 'an override needs a date' using errcode = '22023';
  end if;

  -- Clearing both boundaries removes the override rather than storing a row
  -- that says nothing, which the table constraint would refuse anyway.
  if p_tattoo_earliest_start is null and p_tattoo_latest_finish is null then
    delete from public.artist_schedule_overrides
    where artist_id = p_artist_id and on_date = p_on_date;
    return jsonb_build_object('artist_id', p_artist_id, 'on_date', p_on_date, 'cleared', true);
  end if;

  insert into public.artist_schedule_overrides as o (
    artist_id, on_date, tattoo_earliest_start, tattoo_latest_finish, note, created_by
  ) values (
    p_artist_id, p_on_date,
    nullif(btrim(coalesce(p_tattoo_earliest_start, '')), '')::time,
    nullif(btrim(coalesce(p_tattoo_latest_finish, '')), '')::time,
    nullif(btrim(coalesce(p_note, '')), ''),
    auth.uid()
  )
  on conflict (artist_id, on_date) do update set
    tattoo_earliest_start = excluded.tattoo_earliest_start,
    tattoo_latest_finish = excluded.tattoo_latest_finish,
    note = excluded.note,
    updated_at = now()
  returning o.id into v_id;

  return jsonb_build_object(
    'override_id', v_id,
    'artist_id', p_artist_id,
    'on_date', p_on_date,
    'cleared', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Grants. Direct table access stays closed; everything goes through RPCs.
-- ---------------------------------------------------------------------------

revoke all on function crm_private.appointment_family(public.appointment_type)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.effective_scheduling_preferences(uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.assert_booking_slot_free(uuid, public.appointment_type, timestamptz, timestamptz, uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.list_booking_conflicts(uuid, public.appointment_type, timestamptz, timestamptz, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_booking_conflicts(uuid, public.appointment_type, timestamptz, timestamptz, uuid)
  to authenticated;

revoke all on function public.get_artist_scheduling_preferences(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_artist_scheduling_preferences(uuid) to authenticated;

revoke all on function public.set_artist_scheduling_preferences(uuid, text, text, text[], text, text, boolean, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.set_artist_scheduling_preferences(uuid, text, text, text[], text, text, boolean, integer)
  to authenticated;

revoke all on function public.list_artist_schedule_overrides(uuid, date, date)
  from public, anon, authenticated, service_role;
grant execute on function public.list_artist_schedule_overrides(uuid, date, date) to authenticated;

revoke all on function public.set_artist_schedule_override(uuid, date, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.set_artist_schedule_override(uuid, date, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. Seed the current artists with the studio's stated defaults.
--
-- Idempotent and non-destructive: an artist who already has a row keeps it.
-- ---------------------------------------------------------------------------

insert into public.artist_scheduling_preferences (artist_id)
select a.id from public.artists a
on conflict (artist_id) do nothing;

-- ---------------------------------------------------------------------------
-- 11. Every authoritative write path now applies the policy.
--
-- These five are re-created verbatim from 0039 with one line changed each:
-- assert_artist_available (time off only) becomes assert_booking_slot_free,
-- which asserts time off AND the booking-type conflict rule. The advisory
-- overlap read the interface used was never enforcement; from here the
-- database is what refuses a double-booked tattoo session.
--
-- The lock ordering is unchanged: lock_artist_schedule still comes first, so
-- two concurrent bookings serialise on the same artist before either checks.
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
    perform crm_private.assert_booking_slot_free(
      p_artist_id, p_appointment_type, p_start_at, p_end_at, null
    );
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
    perform crm_private.assert_booking_slot_free(
      v_artist, v_type, p_start_at, p_end_at, p_appointment_id
    );
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
    perform crm_private.assert_booking_slot_free(
      v_artist, v_type, v_start_at, v_end_at, p_appointment_id
    );
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
    -- The legacy project path only ever creates tattoo work.
    perform crm_private.assert_booking_slot_free(
      v_artist_id, 'tattoo_session'::public.appointment_type, p_start_at, p_end_at, null
    );
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
  v_type public.appointment_type;
begin
  select s.artist_id, s.start_at, s.end_at, s.appointment_type
    into v_artist_id, v_start_at, v_end_at, v_type
  from public.sessions s
  where s.id = p_session_id
  for update;
  if not found then
    raise exception 'session % does not exist', p_session_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_artist_id, 'manage_sessions');
  if p_status in ('proposed', 'confirmed') then
    perform crm_private.lock_artist_schedule(v_artist_id);
    perform crm_private.assert_booking_slot_free(
      v_artist_id, v_type, v_start_at, v_end_at, p_session_id
    );
  end if;

  return crm_private.legacy_set_session_status(p_session_id, p_status);
end;
$$;
