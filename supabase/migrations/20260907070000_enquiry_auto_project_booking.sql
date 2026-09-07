-- 20260907070000_enquiry_auto_project_booking.sql
--
-- Booking a tattoo session from an enquiry no longer requires the operator to
-- create the project first.
--
-- The database invariant is unchanged and deliberately kept:
-- `sessions_project_required_for_work` still refuses a tattoo_session or a
-- touch_up without a project. What changes is who satisfies it. Before this,
-- the CRM offered "Book tattoo session" on an enquiry with no project, sent
-- project_id => null, and the insert failed on the check constraint - which
-- the browser then reported as a schedule conflict, because every booking
-- failure was reported that way. ENQ-2026-0020 is that case in production:
-- status `new`, intake `complete`, zero projects.
--
-- Three things are added here.
--
-- 1. crm_private.ensure_enquiry_project: the enquiry's project, created once
--    if it does not exist yet. `projects_one_per_enquiry_idx` is the
--    uniqueness authority, and the enquiry row is locked first, so two taps
--    or two concurrent bookings converge on one project rather than racing.
--
-- 2. Machine-readable failure codes. Every deliberate refusal on the booking
--    path now carries a stable code in the exception HINT. SQLSTATE and
--    message are unchanged, so existing callers keep working; the CRM reads
--    the hint and says what actually went wrong instead of blaming the
--    schedule. The codes are the contract - see BOOKING_ERROR_CODES in
--    admin/src/lib/booking-errors.ts.
--
-- 3. An idempotent replay. An identical live appointment for the same artist,
--    client, type and exact times is returned rather than attempted again, so
--    a double tap cannot produce two sessions.
--
-- A consultation is untouched by all of this: it needs no project, and
-- booking one must not convert an enquiry into tattoo work. A touch-up is
-- also untouched - it belongs to the tattoo project that is being touched up,
-- so it reuses an existing project and otherwise fails with a specific code
-- rather than inventing a second project for the same piece.
--
-- Forward-only. No constraint is relaxed and no policy is widened.

-- ---------------------------------------------------------------------------
-- Coded refusals
-- ---------------------------------------------------------------------------

create or replace function crm_private.booking_error(
  p_code text,
  p_message text,
  p_sqlstate text default '22023'
)
returns void
language plpgsql
stable
set search_path = pg_catalog, public, crm_private
as $$
begin
  -- The hint is the machine-readable half. Keeping the message human means an
  -- operator who somehow sees the raw text still learns something.
  raise exception using
    errcode = p_sqlstate,
    message = p_message,
    hint = p_code;
end;
$$;

revoke all on function crm_private.booking_error(text, text, text)
  from public, anon, authenticated, service_role;

comment on function crm_private.booking_error(text, text, text) is
  'Raise a booking refusal carrying a stable machine-readable code in HINT. SQLSTATE and message stay human-compatible with existing callers.';

-- ---------------------------------------------------------------------------
-- The two availability guards, now coded
--
-- Bodies are unchanged apart from carrying a code. They are shared with
-- reschedule_appointment and set_session_status, which get the same benefit.
-- ---------------------------------------------------------------------------

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
    perform crm_private.booking_error(
      'ARTIST_UNAVAILABLE',
      'artist availability blocks this time'
    );
  end if;
end;
$$;

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
      perform crm_private.booking_error(
        'SLOT_NO_LONGER_AVAILABLE',
        'another tattoo session already occupies this time'
      );
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
      perform crm_private.booking_error(
        'CONSULTATION_DURING_TATTOO_BLOCKED',
        'this artist does not take consultations during a tattoo session'
      );
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
    perform crm_private.booking_error(
      'SLOT_NO_LONGER_AVAILABLE',
      'another consultation already occupies this time'
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The enquiry's project, created once
--
-- Reuse is the normal path: `projects_one_per_enquiry_idx` means an enquiry
-- has at most one project, so a second tattoo session on the same enquiry
-- finds the first one rather than making another. Creation only happens when
-- the enquiry genuinely has none.
--
-- Authorisation is the tenant-aware capability, not a global role. An
-- operator who may book for this artist AND may manage this artist's projects
-- may have the project created for them; anyone else books onto a project
-- that already exists, or is refused. That is narrower than the legacy
-- owner/booking_manager role check on convert_enquiry_to_project, and cannot
-- widen anybody's reach.
--
-- The status move to `converted` is written directly rather than through
-- enquiry_status_transitions. That table describes what an operator may do to
-- an enquiry by hand; this is the CRM recording a fact - real work has been
-- booked, so the enquiry is no longer an untouched `new` one. `declined` and
-- `closed` are still refused, because those are decisions, not stages.
-- ---------------------------------------------------------------------------

create or replace function crm_private.ensure_enquiry_project(
  p_enquiry_id uuid,
  p_artist_id uuid,
  p_client_id uuid,
  p_appointment_type public.appointment_type
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry       public.enquiries;
  v_project_id    uuid;
  v_client_name   text;
  v_title         text;
  v_actor_kind    text;
  v_status_before public.enquiry_status;
begin
  select e.* into v_enquiry
  from public.enquiries e
  where e.id = p_enquiry_id
  for update;

  if not found then
    perform crm_private.booking_error(
      'ENQUIRY_NOT_FOUND',
      format('enquiry %s does not exist', p_enquiry_id),
      '23503'
    );
  end if;

  if v_enquiry.artist_id is distinct from p_artist_id
     or v_enquiry.client_id is distinct from p_client_id then
    perform crm_private.booking_error(
      'ENQUIRY_LINK_MISMATCH',
      'this enquiry belongs to a different artist or client',
      '23514'
    );
  end if;

  -- Reuse. Never a second project for the same enquiry.
  select p.id into v_project_id
  from public.projects p
  where p.enquiry_id = p_enquiry_id;

  if found then
    return jsonb_build_object('project_id', v_project_id, 'created', false);
  end if;

  -- A touch-up touches up an existing piece. Creating a fresh project for one
  -- would split the same tattoo across two projects and hide the original
  -- estimate, deposit and session history, so it is refused with a code the
  -- CRM can explain instead.
  if p_appointment_type = 'touch_up' then
    perform crm_private.booking_error(
      'TOUCH_UP_PROJECT_REQUIRED',
      'a touch-up belongs to the project of the tattoo being touched up; name it explicitly'
    );
  end if;

  perform crm_private.require_artist_access(p_artist_id, 'manage_projects');

  if v_enquiry.intake_state <> 'complete' then
    perform crm_private.booking_error(
      'ENQUIRY_INTAKE_INCOMPLETE',
      format('enquiry %s has not completed intake', p_enquiry_id)
    );
  end if;

  if v_enquiry.status in ('declined', 'closed') then
    perform crm_private.booking_error(
      'ENQUIRY_NOT_BOOKABLE',
      format('enquiry %s is %s and cannot start tattoo work', p_enquiry_id, v_enquiry.status)
    );
  end if;

  select c.full_name into v_client_name
  from public.clients c where c.id = v_enquiry.client_id;

  -- The same title the Convert button composes, so a project created either
  -- way reads identically in the project list.
  v_title := left(
    btrim(
      coalesce(nullif(btrim(v_enquiry.project_type), ''), 'Tattoo project')
      || ' — '
      || coalesce(
           nullif(btrim(v_enquiry.submitted_full_name), ''),
           nullif(btrim(v_client_name), ''),
           v_enquiry.reference_number
         )
    ),
    200
  );

  -- Placement, size, cover-up and the reference images are not copied. They
  -- live on the enquiry, and `projects.enquiry_id` is the link that keeps them
  -- reachable; duplicating them would create a second version to disagree
  -- with the first.
  insert into public.projects (client_id, enquiry_id, artist_id, status, title, description)
  values (
    v_enquiry.client_id,
    p_enquiry_id,
    p_artist_id,
    'draft',
    v_title,
    nullif(btrim(coalesce(v_enquiry.idea, '')), '')
  )
  returning id into v_project_id;

  v_status_before := v_enquiry.status;

  if v_enquiry.status <> 'converted' then
    update public.enquiries e
    set status = 'converted'
    where e.id = p_enquiry_id;
  end if;

  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;

  perform crm_private.log_artist_activity(
    p_artist_id,
    'enquiry.converted',
    v_actor_kind,
    auth.uid(),
    v_enquiry.client_id,
    p_enquiry_id,
    v_project_id,
    null,
    null,
    jsonb_build_object(
      'automatic', true,
      'reason', 'tattoo_session_booked',
      'status_before', v_status_before
    )
  );

  return jsonb_build_object('project_id', v_project_id, 'created', true);
end;
$$;

revoke all on function crm_private.ensure_enquiry_project(uuid, uuid, uuid, public.appointment_type)
  from public, anon, authenticated, service_role;

comment on function crm_private.ensure_enquiry_project(uuid, uuid, uuid, public.appointment_type) is
  'Return the enquiry''s project, creating it once when tattoo work is first booked. Reuses an existing project, never creates a second one, and refuses a touch-up that names no project.';

-- ---------------------------------------------------------------------------
-- The booking itself
--
-- Order matters, and it is:
--
--   1. authorise, then validate the arguments;
--   2. take the artist's schedule lock, so two concurrent bookings for the
--      same artist serialise before either decides anything;
--   3. replay an identical live appointment instead of creating a second one;
--   4. resolve the project - reusing, creating, or refusing with a code;
--   5. re-check the slot;
--   6. insert, log, and queue the calendar job.
--
-- The project is resolved before the slot re-check on purpose. If the slot has
-- gone in the meantime the whole statement rolls back, project included, so a
-- refused booking cannot leave an orphan project behind. There is no state in
-- which the project exists and the session does not.
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
  v_appointment_id  uuid;
  v_actor_kind      text;
  v_family          text;
  v_project_id      uuid := p_project_id;
  v_project_created boolean := false;
  v_project         public.projects;
  v_enquiry_artist  uuid;
  v_enquiry_client  uuid;
  v_existing        public.sessions;
  v_resolved        jsonb;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_sessions');
  perform crm_private.require_active_artist(p_artist_id);

  if p_appointment_type is null then
    perform crm_private.booking_error(
      'INVALID_APPOINTMENT_TYPE',
      'an appointment type is required'
    );
  end if;

  if p_status not in ('draft', 'proposed', 'confirmed') then
    perform crm_private.booking_error(
      'INVALID_APPOINTMENT_STATUS',
      'an appointment may only be created as draft, proposed or confirmed'
    );
  end if;

  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at then
    perform crm_private.booking_error(
      'INVALID_APPOINTMENT_WINDOW',
      'appointment end must be after its start'
    );
  end if;

  if not exists (select 1 from public.clients c where c.id = p_client_id) then
    perform crm_private.booking_error(
      'CLIENT_NOT_FOUND',
      format('client %s does not exist', p_client_id),
      '23503'
    );
  end if;

  if p_enquiry_id is not null then
    select e.artist_id, e.client_id into v_enquiry_artist, v_enquiry_client
    from public.enquiries e where e.id = p_enquiry_id;

    if not found then
      perform crm_private.booking_error(
        'ENQUIRY_NOT_FOUND',
        format('enquiry %s does not exist', p_enquiry_id),
        '23503'
      );
    end if;

    if v_enquiry_artist is distinct from p_artist_id
       or v_enquiry_client is distinct from p_client_id then
      perform crm_private.booking_error(
        'ENQUIRY_LINK_MISMATCH',
        'this enquiry belongs to a different artist or client'
      );
    end if;
  end if;

  v_family := crm_private.appointment_family(p_appointment_type);

  perform crm_private.lock_artist_schedule(p_artist_id);

  -- A second tap on the same button, or a retried request, must not book the
  -- same appointment twice. Same artist, client, kind and exact window, still
  -- live: that is the booking the caller already has.
  select s.* into v_existing
  from public.sessions s
  where s.artist_id = p_artist_id
    and s.client_id = p_client_id
    and s.appointment_type = p_appointment_type
    and s.start_at = p_start_at
    and s.end_at = p_end_at
    and s.status in ('draft', 'proposed', 'confirmed')
    and (p_enquiry_id is null or s.enquiry_id is not distinct from p_enquiry_id)
    and (p_project_id is null or s.project_id is not distinct from p_project_id)
  order by s.created_at
  limit 1;

  if found then
    return jsonb_build_object(
      'appointment_id', v_existing.id,
      'session_id', v_existing.id,
      'appointment_type', v_existing.appointment_type,
      'artist_id', v_existing.artist_id,
      'client_id', v_existing.client_id,
      'enquiry_id', v_existing.enquiry_id,
      'project_id', v_existing.project_id,
      'status', v_existing.status,
      'project_created', false,
      'replayed', true
    );
  end if;

  if v_family = 'tattoo' then
    if v_project_id is not null then
      select p.* into v_project from public.projects p where p.id = v_project_id;
      if not found then
        perform crm_private.booking_error(
          'PROJECT_NOT_FOUND',
          format('project %s does not exist', v_project_id),
          '23503'
        );
      end if;
      if v_project.artist_id is distinct from p_artist_id
         or v_project.client_id is distinct from p_client_id then
        perform crm_private.booking_error(
          'PROJECT_LINK_MISMATCH',
          'that project belongs to a different artist or client',
          '23514'
        );
      end if;
      if p_enquiry_id is not null
         and v_project.enquiry_id is not null
         and v_project.enquiry_id <> p_enquiry_id then
        perform crm_private.booking_error(
          'PROJECT_LINK_MISMATCH',
          'that project belongs to a different enquiry',
          '23514'
        );
      end if;
    elsif p_enquiry_id is not null then
      v_resolved := crm_private.ensure_enquiry_project(
        p_enquiry_id, p_artist_id, p_client_id, p_appointment_type
      );
      v_project_id := (v_resolved ->> 'project_id')::uuid;
      v_project_created := (v_resolved ->> 'created')::boolean;
    else
      perform crm_private.booking_error(
        'PROJECT_REQUIRED',
        'tattoo work belongs to a project; name the project or the enquiry it came from'
      );
    end if;
  end if;

  if p_status in ('proposed', 'confirmed') then
    perform crm_private.assert_booking_slot_free(
      p_artist_id, p_appointment_type, p_start_at, p_end_at, null
    );
  end if;

  insert into public.sessions (
    artist_id, client_id, enquiry_id, project_id, appointment_type,
    status, start_at, end_at, duration_hours, notes
  ) values (
    p_artist_id, p_client_id, p_enquiry_id, v_project_id, p_appointment_type,
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
    v_project_id,
    v_appointment_id,
    null,
    jsonb_build_object(
      'appointment_type', p_appointment_type,
      'status', p_status,
      'project_created', v_project_created
    )
  );

  -- Only after the session exists. The outbox row is written in the same
  -- transaction, so a rolled-back booking never leaves a calendar job behind.
  if public.session_is_calendar_eligible(p_status) then
    perform crm_private.enqueue_outbox(
      'calendar_create',
      public.calendar_outbox_dedupe_key('create', v_appointment_id, 0),
      jsonb_build_object(
        'session_id', v_appointment_id,
        'appointment_type', p_appointment_type,
        'calendar_version', 0
      ),
      p_client_id, p_enquiry_id, v_project_id, v_appointment_id, null
    );
  end if;

  return jsonb_build_object(
    'appointment_id', v_appointment_id,
    'session_id', v_appointment_id,
    'appointment_type', p_appointment_type,
    'artist_id', p_artist_id,
    'client_id', p_client_id,
    'enquiry_id', p_enquiry_id,
    'project_id', v_project_id,
    'status', p_status,
    'project_created', v_project_created,
    'replayed', false
  );
end;
$$;

comment on function public.schedule_appointment(uuid, uuid, public.appointment_type, timestamptz, timestamptz, public.session_status, uuid, uuid, text) is
  'Book an appointment. Tattoo work creates the enquiry''s project on first booking and reuses it afterwards; consultations never create one. Refusals carry a machine-readable code in the exception HINT.';
