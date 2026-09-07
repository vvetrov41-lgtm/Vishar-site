-- 276_enquiry_auto_project_booking.sql
--
-- Booking tattoo work from an enquiry that has no project.
--
-- The database has always required a project for a tattoo_session or a
-- touch_up (`sessions_project_required_for_work`), and the CRM offered the
-- booking anyway. The refusal then reached the operator as "the schedule
-- changed", which it had not. These tests pin both halves of the fix: the
-- project is created and reused where it should be, and every refusal says
-- which one it is.

begin;
select no_plan();

-- Keep all generated test slots on a five-minute boundary regardless of the
-- second at which CI starts the suite. The production trigger correctly rejects
-- arbitrary seconds; a test fixture must not depend on wall-clock seconds.
create function pg_temp.booking_base() returns timestamptz language sql stable as $$
  select date_trunc('day', now()) + interval '9 hours'
$$;
grant execute on function pg_temp.booking_base() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('ab111111-1111-4111-8111-111111111111', 'auto-owner@example.test'),
  ('ab222222-2222-4222-8222-222222222222', 'auto-manager@example.test'),
  ('ab333333-3333-4333-8333-333333333333', 'auto-reader@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('ab111111-1111-4111-8111-111111111111', 'auto-owner@example.test', 'Auto Owner', 'owner', true),
  ('ab222222-2222-4222-8222-222222222222', 'auto-manager@example.test', 'Auto Manager', 'booking_manager', true),
  ('ab333333-3333-4333-8333-333333333333', 'auto-reader@example.test', 'Auto Reader', 'read_only', true);

-- The manager runs Vladimir's diary and projects. Kristina is deliberately
-- outside that membership, so "another artist" is a real boundary here.
insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('ab222222-2222-4222-8222-222222222222',
   'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, false, true),
  ('ab333333-3333-4333-8333-333333333333',
   'a1111111-1111-4111-8111-111111111111',
   'read_only', false, false, false, false, true);

create function pg_temp.act_as(p uuid) returns void language plpgsql as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p, 'role', 'authenticated')::text,
    true
  );
end;
$$;
grant execute on function pg_temp.act_as(uuid) to authenticated, service_role;

create function pg_temp.act_as_worker() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end;
$$;
grant execute on function pg_temp.act_as_worker() to service_role;

-- The machine-readable half of a refusal. throws_ok checks SQLSTATE, which
-- several different refusals share; the HINT is what the CRM actually reads,
-- so it is what these tests assert on.
create function pg_temp.refusal_hint(p_sql text) returns text language plpgsql as $$
declare
  v_hint text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics v_hint = pg_exception_hint;
  return coalesce(v_hint, '');
end;
$$;
grant execute on function pg_temp.refusal_hint(text) to authenticated, service_role;

-- Returns the intake result rather than reading `public.enquiries` back: the
-- fixture runs as the Worker role, which writes enquiries through the intake
-- RPC and is not granted a direct read of the table.
create function pg_temp.new_enquiry(p_key uuid, p_email text, p_idea text)
returns jsonb language plpgsql as $$
declare
  v_result jsonb;
  v_enquiry uuid;
begin
  v_result := public.create_enquiry_intake(
    p_key,
    jsonb_build_object('full_name', 'Auto Client ' || p_email, 'email', p_email),
    jsonb_build_object(
      'idea', p_idea,
      'project_type', 'Black and grey realism',
      'placement', 'Forearm',
      'approximate_size', '20cm',
      'source', '/booking/',
      'privacy_acknowledged', true,
      'privacy_notice_version', '2026-07-29'
    ),
    jsonb_build_array(jsonb_build_object(
      'mime_type', 'image/png', 'safe_extension', 'png', 'byte_size', 4096
    ))
  );
  v_enquiry := (v_result ->> 'enquiry_id')::uuid;

  -- Intake is only complete once its reference images have landed, so the
  -- fixture walks the same path a real submission does.
  perform public.mark_enquiry_file_uploaded((manifest ->> 'file_id')::uuid)
  from jsonb_array_elements(v_result -> 'files') as manifests(manifest);

  perform public.finalize_enquiry_intake(v_enquiry);
  return jsonb_build_object(
    'enquiry_id', v_enquiry,
    'client_id', (v_result ->> 'client_id')::uuid
  );
end;
$$;
grant execute on function pg_temp.new_enquiry(uuid, text, text) to service_role;

set local role service_role;
select pg_temp.act_as_worker();

create temporary table intake as
select
  pg_temp.new_enquiry('ab000000-0000-4000-8000-000000000001', 'first@example.test', 'A raven')  as a,
  pg_temp.new_enquiry('ab000000-0000-4000-8000-000000000002', 'second@example.test', 'A snake') as b,
  pg_temp.new_enquiry('ab000000-0000-4000-8000-000000000003', 'third@example.test', 'A wolf')   as c,
  pg_temp.new_enquiry('ab000000-0000-4000-8000-000000000004', 'fourth@example.test', 'A moth')  as d;

create temporary table fixtures as
select
  (a ->> 'enquiry_id')::uuid as enquiry_a,
  (b ->> 'enquiry_id')::uuid as enquiry_b,
  (c ->> 'enquiry_id')::uuid as enquiry_c,
  (d ->> 'enquiry_id')::uuid as enquiry_d
from intake;
grant select on fixtures to authenticated, service_role;

create temporary table clients as
select
  (a ->> 'client_id')::uuid as client_a,
  (b ->> 'client_id')::uuid as client_b,
  (c ->> 'client_id')::uuid as client_c,
  (d ->> 'client_id')::uuid as client_d
from intake;
grant select on clients to authenticated, service_role;

reset role;
set local role authenticated;
select pg_temp.act_as('ab222222-2222-4222-8222-222222222222');

-- ---------------------------------------------------------------------------
-- A. A new enquiry with no project books a tattoo session, and gets one
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from public.projects
   where enquiry_id = (select enquiry_a from fixtures)),
  0,
  'the enquiry starts with no project, which is the case that used to fail'
);

select is(
  (select status::text from public.enquiries where id = (select enquiry_a from fixtures)),
  'new',
  'and it starts as a new enquiry'
);

create temporary table booking_a as
select public.schedule_appointment(
  'a1111111-1111-4111-8111-111111111111',
  (select client_a from clients),
  'tattoo_session',
  pg_temp.booking_base() + interval '10 days',
  pg_temp.booking_base() + interval '10 days 7 hours',
  'confirmed',
  (select enquiry_a from fixtures),
  null,
  null
) as result;
grant select on booking_a to authenticated, service_role;

select ok(
  (select (result ->> 'project_created')::boolean from booking_a),
  'booking tattoo work on a project-less enquiry creates the project'
);

select is(
  (select count(*)::int from public.projects
   where enquiry_id = (select enquiry_a from fixtures)),
  1,
  'exactly one project exists for that enquiry'
);

select is(
  (select s.project_id from public.sessions s
   where s.id = (select (result ->> 'session_id')::uuid from booking_a)),
  (select p.id from public.projects p where p.enquiry_id = (select enquiry_a from fixtures)),
  'the session is linked to the project that was just created'
);

select is(
  (select p.artist_id from public.projects p where p.enquiry_id = (select enquiry_a from fixtures)),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'the project inherits the enquiry artist'
);

select is(
  (select p.description from public.projects p where p.enquiry_id = (select enquiry_a from fixtures)),
  'A raven',
  'the project carries the idea the client actually wrote'
);

-- J. The enquiry has moved on. It cannot still behave like an untouched one.
select is(
  (select status::text from public.enquiries where id = (select enquiry_a from fixtures)),
  'converted',
  'the enquiry is no longer new once real work is booked'
);

select is(
  (select count(*)::int from public.activity_log
   where event_type = 'enquiry.converted'
     and enquiry_id = (select enquiry_a from fixtures)),
  1,
  'the automatic conversion is recorded once in the activity log'
);

select ok(
  (select (metadata ->> 'automatic')::boolean from public.activity_log
   where event_type = 'enquiry.converted'
     and enquiry_id = (select enquiry_a from fixtures)),
  'and it is marked as automatic, not as something a person did by hand'
);

-- ---------------------------------------------------------------------------
-- K. The calendar job exists only because the session does
-- ---------------------------------------------------------------------------

select pg_temp.act_as('ab111111-1111-4111-8111-111111111111');
select is(
  (select count(*)::int from public.integration_outbox
   where kind = 'calendar_create'
     and session_id = (select (result ->> 'session_id')::uuid from booking_a)),
  1,
  'a confirmed booking queues exactly one calendar job, after the session exists'
);
select pg_temp.act_as('ab222222-2222-4222-8222-222222222222');

-- ---------------------------------------------------------------------------
-- B. A second tattoo session reuses the project
-- ---------------------------------------------------------------------------

create temporary table booking_a2 as
select public.schedule_appointment(
  'a1111111-1111-4111-8111-111111111111',
  (select client_a from clients),
  'tattoo_session',
  pg_temp.booking_base() + interval '20 days',
  pg_temp.booking_base() + interval '20 days 7 hours',
  'proposed',
  (select enquiry_a from fixtures),
  null,
  null
) as result;

select ok(
  not (select (result ->> 'project_created')::boolean from booking_a2),
  'a second tattoo session does not create a second project'
);

select is(
  (select (result ->> 'project_id')::uuid from booking_a2),
  (select (result ->> 'project_id')::uuid from booking_a),
  'it reuses the project the first booking created'
);

select is(
  (select count(*)::int from public.projects
   where enquiry_id = (select enquiry_a from fixtures)),
  1,
  'still exactly one project for the enquiry'
);

-- ---------------------------------------------------------------------------
-- C. A consultation needs no project, and does not invent one
-- ---------------------------------------------------------------------------

create temporary table booking_b as
select public.schedule_appointment(
  'a1111111-1111-4111-8111-111111111111',
  (select client_b from clients),
  'in_person_consultation',
  pg_temp.booking_base() + interval '11 days',
  pg_temp.booking_base() + interval '11 days 30 minutes',
  'confirmed',
  (select enquiry_b from fixtures),
  null,
  null
) as result;

select ok(
  (select (result ->> 'session_id') is not null from booking_b),
  'a consultation books without a project'
);

select is(
  (select count(*)::int from public.projects
   where enquiry_id = (select enquiry_b from fixtures)),
  0,
  'and no project is created just because a consultation exists'
);

select is(
  (select status::text from public.enquiries where id = (select enquiry_b from fixtures)),
  'new',
  'a consultation does not convert the enquiry into tattoo work'
);

-- ---------------------------------------------------------------------------
-- D. Two identical requests - a double tap - book once
-- ---------------------------------------------------------------------------

create temporary table booking_b_again as
select public.schedule_appointment(
  'a1111111-1111-4111-8111-111111111111',
  (select client_b from clients),
  'in_person_consultation',
  pg_temp.booking_base() + interval '11 days',
  pg_temp.booking_base() + interval '11 days 30 minutes',
  'confirmed',
  (select enquiry_b from fixtures),
  null,
  null
) as result;

select ok(
  (select (result ->> 'replayed')::boolean from booking_b_again),
  'an identical repeat request is reported as a replay'
);

select is(
  (select (result ->> 'session_id')::uuid from booking_b_again),
  (select (result ->> 'session_id')::uuid from booking_b),
  'and returns the appointment that already exists'
);

select is(
  (select count(*)::int from public.sessions
   where enquiry_id = (select enquiry_b from fixtures)),
  1,
  'no duplicate session is written'
);

-- The same for tattoo work, where a duplicate would also mean a duplicate
-- project attempt.
create temporary table booking_a2_again as
select public.schedule_appointment(
  'a1111111-1111-4111-8111-111111111111',
  (select client_a from clients),
  'tattoo_session',
  pg_temp.booking_base() + interval '20 days',
  pg_temp.booking_base() + interval '20 days 7 hours',
  'proposed',
  (select enquiry_a from fixtures),
  null,
  null
) as result;

select ok(
  (select (result ->> 'replayed')::boolean from booking_a2_again),
  'a repeated tattoo booking is replayed rather than booked twice'
);
select is(
  (select count(*)::int from public.projects
   where enquiry_id = (select enquiry_a from fixtures)),
  1,
  'and still leaves exactly one project'
);

-- ---------------------------------------------------------------------------
-- E and F. A real slot conflict is reported as one, and leaves nothing behind
-- ---------------------------------------------------------------------------

select is(
  pg_temp.refusal_hint(format(
    $$select public.schedule_appointment(
        'a1111111-1111-4111-8111-111111111111', %L, 'tattoo_session',
        pg_temp.booking_base() + interval '10 days 2 hours', pg_temp.booking_base() + interval '10 days 6 hours',
        'confirmed', %L, null, null)$$,
    (select client_c from clients), (select enquiry_c from fixtures))),
  'SLOT_NO_LONGER_AVAILABLE',
  'a booking over an existing tattoo session is refused as a slot conflict'
);

select is(
  (select count(*)::int from public.projects
   where enquiry_id = (select enquiry_c from fixtures)),
  0,
  'and the project prepared for it is rolled back with the booking, not orphaned'
);

select is(
  (select status::text from public.enquiries where id = (select enquiry_c from fixtures)),
  'new',
  'the refused enquiry keeps its status too'
);

select is(
  (select count(*)::int from public.sessions
   where enquiry_id = (select enquiry_c from fixtures)),
  0,
  'and no session was written'
);

-- ---------------------------------------------------------------------------
-- G. A missing project is not dressed up as a slot conflict
-- ---------------------------------------------------------------------------

select is(
  pg_temp.refusal_hint(format(
    $$select public.schedule_appointment(
        'a1111111-1111-4111-8111-111111111111', %L, 'tattoo_session',
        pg_temp.booking_base() + interval '40 days', pg_temp.booking_base() + interval '40 days 7 hours',
        'confirmed', null, null, null)$$,
    (select client_c from clients))),
  'PROJECT_REQUIRED',
  'tattoo work with neither a project nor an enquiry says exactly that'
);

-- ---------------------------------------------------------------------------
-- I. A touch-up uses the project of the piece being touched up, or fails
-- ---------------------------------------------------------------------------

select is(
  pg_temp.refusal_hint(format(
    $$select public.schedule_appointment(
        'a1111111-1111-4111-8111-111111111111', %L, 'touch_up',
        pg_temp.booking_base() + interval '41 days', pg_temp.booking_base() + interval '41 days 2 hours',
        'confirmed', %L, null, null)$$,
    (select client_d from clients), (select enquiry_d from fixtures))),
  'TOUCH_UP_PROJECT_REQUIRED',
  'a touch-up on an enquiry with no project is refused rather than given a new one'
);

select is(
  (select count(*)::int from public.projects
   where enquiry_id = (select enquiry_d from fixtures)),
  0,
  'and no project is invented for it'
);

create temporary table touch_up as
select public.schedule_appointment(
  'a1111111-1111-4111-8111-111111111111',
  (select client_a from clients),
  'touch_up',
  pg_temp.booking_base() + interval '50 days',
  pg_temp.booking_base() + interval '50 days 2 hours',
  'proposed',
  (select enquiry_a from fixtures),
  null,
  null
) as result;

select is(
  (select (result ->> 'project_id')::uuid from touch_up),
  (select (result ->> 'project_id')::uuid from booking_a),
  'a touch-up on an enquiry that has a project joins that project'
);
select ok(
  not (select (result ->> 'project_created')::boolean from touch_up),
  'and creates no second project for the same tattoo'
);

-- ---------------------------------------------------------------------------
-- H. Scope: another artist, and another client's enquiry
-- ---------------------------------------------------------------------------

-- A permission denial keeps its long-standing SQLSTATE and carries no booking
-- hint: it is raised by the shared authorization helpers, not by the booking
-- path, and the CRM reads it from the SQLSTATE for exactly that reason.
select throws_ok(
  format(
    $$select public.schedule_appointment(
        'a2222222-2222-4222-8222-222222222222', %L, 'in_person_consultation',
        pg_temp.booking_base() + interval '60 days', pg_temp.booking_base() + interval '60 days 30 minutes',
        'confirmed', null, null, null)$$,
    (select client_a from clients)),
  '42501', null,
  'an operator cannot book for an artist they have no membership on'
);

select is(
  pg_temp.refusal_hint(format(
    $$select public.schedule_appointment(
        'a1111111-1111-4111-8111-111111111111', %L, 'tattoo_session',
        pg_temp.booking_base() + interval '61 days', pg_temp.booking_base() + interval '61 days 7 hours',
        'confirmed', %L, null, null)$$,
    (select client_b from clients), (select enquiry_a from fixtures))),
  'ENQUIRY_LINK_MISMATCH',
  'an enquiry cannot be attached to a booking for a different client'
);

select is(
  (select count(*)::int from public.sessions
   where client_id = (select client_b from clients)),
  1,
  'and that mismatch writes nothing'
);

select pg_temp.act_as('ab333333-3333-4333-8333-333333333333');
select throws_ok(
  format(
    $$select public.schedule_appointment(
        'a1111111-1111-4111-8111-111111111111', %L, 'in_person_consultation',
        pg_temp.booking_base() + interval '62 days', pg_temp.booking_base() + interval '62 days 30 minutes',
        'confirmed', null, null, null)$$,
    (select client_a from clients)),
  '42501', null,
  'a read-only account may not book at all'
);

select * from finish();
rollback;