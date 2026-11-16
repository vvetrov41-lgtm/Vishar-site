-- 394_today_next_session_missing.sql
-- Today shows an open tattoo project whose latest past session left work to
-- do and has nothing booked next. Every row is synthetic and rolled back.
begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table t_ns_artist as
select a.id from public.artists a
join crm_private.artist_state st on st.artist_id = a.id and st.is_active
where a.slug = 'vladimir';

-- Outcome cards cover visits from 3 days ago onward; older visits rely on
-- the stored outcome (or its absence) alone.
update crm_private.visit_outcome_rollout set enabled_from = now() - interval '3 days';

insert into public.clients (id, full_name, email) values
  ('e3940000-0000-4000-8000-0000000000c1', 'NS Next needed', 'ns-1@example.test'),
  ('e3940000-0000-4000-8000-0000000000c2', 'NS Touch-up', 'ns-2@example.test'),
  ('e3940000-0000-4000-8000-0000000000c3', 'NS Complete', 'ns-3@example.test'),
  ('e3940000-0000-4000-8000-0000000000c4', 'NS Booked', 'ns-4@example.test'),
  ('e3940000-0000-4000-8000-0000000000c5', 'NS No outcome old', 'ns-5@example.test'),
  ('e3940000-0000-4000-8000-0000000000c6', 'NS Outcome card', 'ns-6@example.test'),
  ('e3940000-0000-4000-8000-0000000000c7', 'NS On hold', 'ns-7@example.test'),
  ('e3940000-0000-4000-8000-0000000000c8', 'NS Follow-up', 'ns-8@example.test'),
  ('e3940000-0000-4000-8000-0000000000c9', 'NS No sessions', 'ns-9@example.test'),
  ('e3940000-0000-4000-8000-0000000000ca', 'NS Deferred', 'ns-a@example.test');

insert into public.projects (id, client_id, artist_id, status, title, hourly_rate, currency)
select ('e3941000-0000-4000-8000-0000000000' || v.n)::uuid,
       ('e3940000-0000-4000-8000-0000000000' || v.n)::uuid,
       (select id from t_ns_artist), v.status::public.project_status, 'NS project ' || v.n, 140, 'GBP'
from (values ('c1', 'active'), ('c2', 'active'), ('c3', 'active'), ('c4', 'active'),
             ('c5', 'draft'), ('c6', 'active'), ('c7', 'on_hold'), ('c8', 'active'),
             ('c9', 'active'), ('ca', 'active')) v(n, status);

-- One past session per project; c4 also has a future booking.
insert into public.sessions
  (id, artist_id, client_id, project_id, appointment_type, status, start_at, end_at,
   duration_hours, payment_status, currency, created_at)
select v.id, (select id from t_ns_artist), v.client_id, v.project_id,
       'tattoo_session', v.status::public.session_status,
       date_trunc('hour', now()) + v.start_offset,
       date_trunc('hour', now()) + v.start_offset + interval '4 hours',
       4, 'unpaid', 'GBP', now() - interval '40 days'
from (values
  ('e3942000-0000-4000-8000-0000000000c1'::uuid, 'e3940000-0000-4000-8000-0000000000c1'::uuid, 'e3941000-0000-4000-8000-0000000000c1'::uuid, 'completed', interval '-10 days'),
  ('e3942000-0000-4000-8000-0000000000c2'::uuid, 'e3940000-0000-4000-8000-0000000000c2'::uuid, 'e3941000-0000-4000-8000-0000000000c2'::uuid, 'completed', interval '-10 days'),
  ('e3942000-0000-4000-8000-0000000000c3'::uuid, 'e3940000-0000-4000-8000-0000000000c3'::uuid, 'e3941000-0000-4000-8000-0000000000c3'::uuid, 'completed', interval '-10 days'),
  ('e3942000-0000-4000-8000-0000000000c4'::uuid, 'e3940000-0000-4000-8000-0000000000c4'::uuid, 'e3941000-0000-4000-8000-0000000000c4'::uuid, 'completed', interval '-10 days'),
  ('e3942000-0000-4000-8000-0000000000d4'::uuid, 'e3940000-0000-4000-8000-0000000000c4'::uuid, 'e3941000-0000-4000-8000-0000000000c4'::uuid, 'confirmed', interval '20 days'),
  ('e3942000-0000-4000-8000-0000000000c5'::uuid, 'e3940000-0000-4000-8000-0000000000c5'::uuid, 'e3941000-0000-4000-8000-0000000000c5'::uuid, 'completed', interval '-10 days'),
  ('e3942000-0000-4000-8000-0000000000c6'::uuid, 'e3940000-0000-4000-8000-0000000000c6'::uuid, 'e3941000-0000-4000-8000-0000000000c6'::uuid, 'completed', interval '-1 day'),
  ('e3942000-0000-4000-8000-0000000000c7'::uuid, 'e3940000-0000-4000-8000-0000000000c7'::uuid, 'e3941000-0000-4000-8000-0000000000c7'::uuid, 'completed', interval '-10 days'),
  ('e3942000-0000-4000-8000-0000000000c8'::uuid, 'e3940000-0000-4000-8000-0000000000c8'::uuid, 'e3941000-0000-4000-8000-0000000000c8'::uuid, 'completed', interval '-10 days'),
  ('e3942000-0000-4000-8000-0000000000ca'::uuid, 'e3940000-0000-4000-8000-0000000000ca'::uuid, 'e3941000-0000-4000-8000-0000000000ca'::uuid, 'completed', interval '-1 day')
) v(id, client_id, project_id, status, start_offset);

insert into public.visit_outcomes
  (session_id, artist_id, client_id, appointment_type, state, outcome, work_result,
   worked_minutes, confirmed_at)
select ('e3942000-0000-4000-8000-0000000000' || v.n)::uuid, (select id from t_ns_artist),
       ('e3940000-0000-4000-8000-0000000000' || v.n)::uuid, 'tattoo_session', 'confirmed',
       'attended', v.work_result, 240, now() - interval '9 days'
from (values ('c1', 'next_session_needed'), ('c2', 'touch_up_needed'), ('c3', 'work_complete'),
             ('c4', 'next_session_needed'), ('c7', 'next_session_needed'),
             ('c8', 'next_session_needed')) v(n, work_result);

-- "Later" on the outcome card of a recent visit.
insert into public.visit_outcomes
  (session_id, artist_id, client_id, appointment_type, state, deferred_until)
values ('e3942000-0000-4000-8000-0000000000ca', (select id from t_ns_artist),
        'e3940000-0000-4000-8000-0000000000ca', 'tattoo_session', 'deferred', now() + interval '1 day');

insert into public.follow_ups (artist_id, subject, due_at, client_id)
values ((select id from t_ns_artist), 'Book the next session', now() + interval '5 days',
        'e3940000-0000-4000-8000-0000000000c8');

create temp table pulse_394 on commit drop as
select x ->> 'key' as key, x ->> 'kind' as kind, x ->> 'reason' as reason,
       x ->> 'section' as section, x ->> 'href' as href, x ->> 'detail' as detail,
       (x ->> 'urgent')::boolean as urgent
from jsonb_array_elements(crm_private.pulse_items((select id from t_ns_artist), false, false, now())) x;

select is((select reason from pulse_394 where key = 'next-session-e3941000-0000-4000-8000-0000000000c1'),
  'next_session_not_booked', '"Next session needed" with nothing booked shows');
select is((select reason from pulse_394 where key = 'next-session-e3941000-0000-4000-8000-0000000000c2'),
  'touch_up_not_booked', '"Touch-up needed" with nothing booked shows');
select is((select reason from pulse_394 where key = 'next-session-e3941000-0000-4000-8000-0000000000c5'),
  'last_session_result_unknown', 'an old visit with no recorded result shows');

select ok(not exists (select 1 from pulse_394 where key = 'next-session-e3941000-0000-4000-8000-0000000000c3'),
  '"Work complete" never shows');
select ok(not exists (select 1 from pulse_394 where key = 'next-session-e3941000-0000-4000-8000-0000000000c4'),
  'a project with a future booking does not show');
select ok(not exists (select 1 from pulse_394 where key = 'next-session-e3941000-0000-4000-8000-0000000000c6'),
  'a visit still on its outcome card is not doubled');
select ok(exists (select 1 from pulse_394 where key = 'visit-outcome-e3942000-0000-4000-8000-0000000000c6'),
  'that visit keeps its own outcome card');
select ok(not exists (select 1 from pulse_394 where key = 'next-session-e3941000-0000-4000-8000-0000000000c7'),
  'a project on hold does not show');
select ok(not exists (select 1 from pulse_394 where key = 'next-session-e3941000-0000-4000-8000-0000000000c8'),
  'an open follow-up for the client covers it');
select ok(not exists (select 1 from pulse_394 where key = 'next-session-e3941000-0000-4000-8000-0000000000c9'),
  'a project that never had a session does not show');
select ok(not exists (select 1 from pulse_394 where key = 'next-session-e3941000-0000-4000-8000-0000000000ca'),
  '"Later" on the outcome card is respected');

select is((select section || '|' || href || '|' || detail || '|' || urgent::text from pulse_394
           where key = 'next-session-e3941000-0000-4000-8000-0000000000c1'),
  'waiting_for_you|/projects/e3941000-0000-4000-8000-0000000000c1|NS project c1|false',
  'row opens the project, names it and is not urgent');

-- Booking the next session clears the row.
insert into public.sessions
  (id, artist_id, client_id, project_id, appointment_type, status, start_at, end_at,
   duration_hours, payment_status, currency)
values ('e3942000-0000-4000-8000-0000000000e1', (select id from t_ns_artist),
        'e3940000-0000-4000-8000-0000000000c1', 'e3941000-0000-4000-8000-0000000000c1',
        'tattoo_session', 'proposed', date_trunc('hour', now()) + interval '14 days',
        date_trunc('hour', now()) + interval '14 days 4 hours', 4, 'unpaid', 'GBP');
select ok(not exists (
  select 1 from jsonb_array_elements(crm_private.pulse_items((select id from t_ns_artist), false, false, now())) x
  where x ->> 'key' = 'next-session-e3941000-0000-4000-8000-0000000000c1'),
  'booking the next session removes the row');

select is(crm_private.pulse_rank('next_session_missing'), 68, 'ranked after triage, before overdue follow-ups');
select ok(not has_function_privilege('anon', 'crm_private.pulse_items(uuid,boolean,boolean,timestamptz)', 'execute')
   and not has_function_privilege('authenticated', 'crm_private.pulse_items(uuid,boolean,boolean,timestamptz)', 'execute'),
  'private pulse helper stays unavailable to public API roles');

select * from finish(true);
rollback;
