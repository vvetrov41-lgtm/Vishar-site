-- 1010_enrol_booked_sessions.sql
--
-- Audit H-2: an already-booked confirmed session is enrolled into lifecycle
-- email through the normal appointment.scheduled event, exactly once, and never
-- close enough to start that a reminder would fall due immediately.
-- Everything is synthetic and rolled back.

begin;
select no_plan();

create temporary table t_artist as
select a.id
from public.artists a
join crm_private.artist_state s on s.artist_id = a.id and s.is_active
where a.slug = 'vladimir';

insert into public.clients (id, full_name, email) values
  ('fb111111-1111-4111-8111-111111111111', 'H2 Client', 'h2-client@example.test');
insert into public.projects (id, client_id, artist_id, title, description) values
  ('fb222222-2222-4222-8222-222222222222', 'fb111111-1111-4111-8111-111111111111',
   (select id from t_artist), 'H2 project', 'Rollback-only project for lifecycle enrolment');

insert into public.sessions (id, artist_id, client_id, project_id, appointment_type, status, start_at, end_at, duration_hours)
select v.id, (select id from t_artist), 'fb111111-1111-4111-8111-111111111111',
       'fb222222-2222-4222-8222-222222222222',
       'tattoo_session', v.status::public.session_status,
       date_trunc('hour', now()) + v.lead, date_trunc('hour', now()) + v.lead + interval '4 hours', 4
from (values
  ('fb000000-0000-4000-8000-000000000001'::uuid, 'confirmed', interval '30 days'),
  ('fb000000-0000-4000-8000-000000000002'::uuid, 'confirmed', interval '48 hours'),
  ('fb000000-0000-4000-8000-000000000003'::uuid, 'proposed',  interval '30 days')
) as v(id, status, lead);

select is(
  (select count(*)::int from public.automation_events e
   where e.entity_id = 'fb000000-0000-4000-8000-000000000001'),
  0, 'a directly inserted booking starts outside the lifecycle, like the pre-0097 sessions');

select is(crm_private.enrol_booked_session_in_lifecycle('fb000000-0000-4000-8000-000000000001', 'audit_h2_test'),
  'enrolled', 'a future confirmed session is enrolled');
select is(crm_private.enrol_booked_session_in_lifecycle('fb000000-0000-4000-8000-000000000001', 'audit_h2_test'),
  'already_enrolled', 'a second enrolment is refused');
select is(crm_private.enrol_booked_session_in_lifecycle('fb000000-0000-4000-8000-000000000002', 'audit_h2_test'),
  'too_close', 'a session within 72 hours is refused, so nothing falls due at once');
select is(crm_private.enrol_booked_session_in_lifecycle('fb000000-0000-4000-8000-000000000003', 'audit_h2_test'),
  'not_confirmed', 'an unconfirmed session is refused');
select is(crm_private.enrol_booked_session_in_lifecycle('fb000000-0000-4000-8000-0000000000ff', 'audit_h2_test'),
  'not_found', 'an unknown session is refused');
select throws_ok(
  $$select crm_private.enrol_booked_session_in_lifecycle('fb000000-0000-4000-8000-000000000001', 'Bad Reason')$$,
  '22023', null, 'a reason code is required');

select is(
  (select count(*)::int from public.activity_log l
   where l.session_id = 'fb000000-0000-4000-8000-000000000001'
     and l.event_type = 'appointment.scheduled'
     and l.actor_kind = 'system'
     and l.metadata ->> 'lifecycle_enrolment' = 'audit_h2_test'),
  1, 'exactly one audited appointment.scheduled activity row is written');
select is(
  (select count(*)::int from public.automation_events e
   where e.entity_id = 'fb000000-0000-4000-8000-000000000001'
     and e.event_type = 'appointment.scheduled'),
  1, 'the existing projection trigger turns it into one automation event');

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(200)$$, 'first tick');
select lives_ok($$select * from public.service_run_automation_tick(200)$$, 'second tick');
reset role;

select set_eq(
  $$select j.message_purpose, j.status::text, j.scheduled_at
    from public.automation_jobs j
    where j.session_id = 'fb000000-0000-4000-8000-000000000001'$$,
  $$select v.purpose, 'pending', v.at
    from public.sessions s
    cross join lateral (values
      ('session_reminder_72h', s.start_at - interval '72 hours'),
      ('session_reminder_24h', s.start_at - interval '24 hours'),
      ('post_session_checkin', s.end_at + interval '24 hours'),
      ('post_session_aftercare', s.end_at)
    ) as v(purpose, at)
    where s.id = 'fb000000-0000-4000-8000-000000000001'$$,
  'the normal lifecycle jobs materialise once, pending, anchored to the session');

select is(
  (select count(*)::int from public.email_messages m
   where m.client_id = 'fb111111-1111-4111-8111-111111111111'),
  0, 'enrolment sends nothing');

select ok(
  not has_function_privilege('service_role', 'crm_private.enrol_booked_session_in_lifecycle(uuid,text)', 'execute')
  and not has_function_privilege('authenticated', 'crm_private.enrol_booked_session_in_lifecycle(uuid,text)', 'execute')
  and not has_function_privilege('anon', 'crm_private.enrol_booked_session_in_lifecycle(uuid,text)', 'execute'),
  'no API role can call the enrolment helper');

select * from finish();
rollback;
