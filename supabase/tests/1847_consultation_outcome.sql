-- 1847_consultation_outcome.sql
--
-- Consultations (20261015180000): a past date never makes a consultation
-- "held". It is held when the operator says so, or when a tattoo booking for
-- the same client made after it began proves the client came.

begin;
select no_plan();

select ok(
  (select bool_and(not has_function_privilege(role, p.oid, 'EXECUTE'))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   cross join unnest(array['anon', 'authenticated', 'service_role']) role
   where n.nspname = 'crm_private' and p.proname = 'resolve_evidenced_consultations'),
  'evidence resolution is not callable by any API role'
);
select ok(
  pg_get_functiondef('crm_private.auto_complete_due_tattoo_sessions(integer)'::regprocedure)
    like '%crm_private.resolve_evidenced_consultations(p_limit)%',
  'the automation tick step resolves evidenced consultations'
);
select ok(
  pg_get_functiondef('public.service_run_automation_tick(integer)'::regprocedure)
    like '%crm_private.auto_complete_due_tattoo_sessions(%',
  'and the tick still runs that step'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.artists (id, slug, display_name, workspace_id, timezone, default_currency)
select '5e000001-0000-4000-8000-000000000001'::uuid, 'outcome-artist', 'Outcome artist', a.workspace_id, 'Europe/London', 'GBP'
from public.artists a where a.id = 'a1111111-1111-4111-8111-111111111111';

insert into public.clients (id, full_name, workspace_id)
select v.id::uuid, v.name, a.workspace_id
from (values
  ('5e100001-0000-4000-8000-000000000001', 'Came and booked'),
  ('5e100002-0000-4000-8000-000000000002', 'Booked before'),
  ('5e100003-0000-4000-8000-000000000003', 'No booking'),
  ('5e100004-0000-4000-8000-000000000004', 'Cancelled'),
  ('5e100005-0000-4000-8000-000000000005', 'Upcoming'),
  ('5e100006-0000-4000-8000-000000000006', 'Booking cancelled')
) v(id, name)
cross join public.artists a where a.id = 'a1111111-1111-4111-8111-111111111111';

insert into public.projects (id, client_id, status, title, artist_id)
select ('5e3' || substr(c.id::text, 4))::uuid, c.id, 'active', 'Outcome project', '5e000001-0000-4000-8000-000000000001'
from public.clients c where c.id::text like '5e1000%';

-- C1 ended; the client booked a tattoo after it  -> completed by evidence
-- C2 ended; the tattoo was booked before it      -> stays unverified
-- C3 ended; nothing booked                       -> stays unverified
-- C4 cancelled                                   -> stays cancelled
-- C5 tomorrow                                    -> stays confirmed, not unverified
-- C6 ended; the later booking was cancelled      -> stays unverified
insert into public.sessions (id, project_id, client_id, status, appointment_type, start_at, end_at, duration_hours, artist_id, cancelled_at)
select v.id::uuid, ('5e3' || substr(v.client, 4))::uuid, v.client::uuid, v.status::public.session_status,
       'in_person_consultation', date_trunc('hour', now()) + v.offset_, date_trunc('hour', now()) + v.offset_ + interval '30 minutes',
       0.5, '5e000001-0000-4000-8000-000000000001', case when v.status = 'cancelled' then now() end
from (values
  ('5e400001-0000-4000-8000-000000000001', '5e100001-0000-4000-8000-000000000001', 'confirmed', interval '-3 days'),
  ('5e400002-0000-4000-8000-000000000002', '5e100002-0000-4000-8000-000000000002', 'confirmed', interval '-3 days'),
  ('5e400003-0000-4000-8000-000000000003', '5e100003-0000-4000-8000-000000000003', 'confirmed', interval '-3 days'),
  ('5e400004-0000-4000-8000-000000000004', '5e100004-0000-4000-8000-000000000004', 'cancelled', interval '-3 days'),
  ('5e400005-0000-4000-8000-000000000005', '5e100005-0000-4000-8000-000000000005', 'confirmed', interval '1 day'),
  ('5e400006-0000-4000-8000-000000000006', '5e100006-0000-4000-8000-000000000006', 'confirmed', interval '-3 days')
) v(id, client, status, offset_);

insert into public.sessions (id, project_id, client_id, status, appointment_type, start_at, end_at, duration_hours, artist_id, cancelled_at, created_at)
select v.id::uuid, ('5e3' || substr(v.client, 4))::uuid, v.client::uuid, v.status::public.session_status,
       'tattoo_session', date_trunc('hour', now()) + interval '30 days', date_trunc('hour', now()) + interval '30 days 6 hours',
       6, '5e000001-0000-4000-8000-000000000001', case when v.status = 'cancelled' then now() end, now() + v.created
from (values
  ('5e500001-0000-4000-8000-000000000001', '5e100001-0000-4000-8000-000000000001', 'confirmed', interval '-2 days'),
  ('5e500002-0000-4000-8000-000000000002', '5e100002-0000-4000-8000-000000000002', 'confirmed', interval '-10 days'),
  ('5e500006-0000-4000-8000-000000000006', '5e100006-0000-4000-8000-000000000006', 'cancelled', interval '-2 days')
) v(id, client, status, created);

create temporary table before_resolve on commit drop as
select crm_private.statistics_core('5e000001-0000-4000-8000-000000000001', now() - interval '30 days', now() + interval '2 days', now(), false) as r;

select is((select (r -> 'sessions' ->> 'consultations_held')::int from before_resolve), 0,
  'an ended consultation is not held because of its date');
select is((select (r -> 'sessions' ->> 'consultations_unverified')::int from before_resolve), 4,
  'ended, confirmed consultations are awaiting their outcome (C1, C2, C3, C6)');
select is((select (r ->> 'consultations_awaiting_outcome')::int from before_resolve), 4,
  'the to-do count matches');
select is((select (r -> 'sessions' ->> 'consultations_cancelled')::int from before_resolve), 1,
  'a cancelled consultation stays cancelled and apart');

-- ------------------------------------------------------------ evidence

select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok(
  $$select crm_private.resolve_evidenced_consultations(100)$$,
  '42501', null, 'evidence resolution refuses a non-backend caller');

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(crm_private.resolve_evidenced_consultations(100) >= 1, true, 'the backend resolves evidenced consultations');

select is((select status::text from public.sessions where id = '5e400001-0000-4000-8000-000000000001'), 'completed',
  'a tattoo booked after the consultation proves it took place');
select is(
  (select metadata ->> 'completion_source' || ':' || (metadata ->> 'evidence_session_id')
   from public.activity_log
   where session_id = '5e400001-0000-4000-8000-000000000001' and event_type = 'appointment.status_changed'
   order by occurred_at desc limit 1),
  'follow_on_booking:5e500001-0000-4000-8000-000000000001',
  'the completion is audited with its evidence');
select is((select status::text from public.sessions where id = '5e400002-0000-4000-8000-000000000002'), 'confirmed',
  'a tattoo booked before the consultation is no evidence');
select is((select status::text from public.sessions where id = '5e400003-0000-4000-8000-000000000003'), 'confirmed',
  'no booking, no outcome: the clock alone completes nothing');
select is((select status::text from public.sessions where id = '5e400004-0000-4000-8000-000000000004'), 'cancelled',
  'a cancelled consultation keeps its status');
select is((select status::text from public.sessions where id = '5e400005-0000-4000-8000-000000000005'), 'confirmed',
  'an upcoming consultation is untouched');
select is((select status::text from public.sessions where id = '5e400006-0000-4000-8000-000000000006'), 'confirmed',
  'a cancelled tattoo booking is no evidence');

-- --------------------------------------------- the operator records outcome

-- The existing status path: "took place" and "client did not come".
update public.sessions set status = 'no_show' where id = '5e400003-0000-4000-8000-000000000003';

create temporary table after_resolve on commit drop as
select crm_private.statistics_core('5e000001-0000-4000-8000-000000000001', now() - interval '30 days', now() + interval '2 days', now(), false) as r;

select is((select (r -> 'sessions' ->> 'consultations_held')::int from after_resolve), 1, 'held: only the completed one');
select is((select (r -> 'sessions' ->> 'consultations_no_show')::int from after_resolve), 1, 'the no-show is its own figure');
select is((select (r -> 'sessions' ->> 'consultations_unverified')::int from after_resolve), 2, 'two still await their outcome');

select * from finish();
rollback;
