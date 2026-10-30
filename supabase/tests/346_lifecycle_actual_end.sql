-- Synthetic, rollback-only coverage of evidence-backed end times.
begin;
select no_plan();

insert into public.clients(id,full_name,email) values
  ('f9591111-1111-4111-8111-111111111111','Actual end test','actual-end@example.test');
insert into public.projects(id,client_id,artist_id,title) values
  ('f9592222-2222-4222-8222-222222222222',
   'f9591111-1111-4111-8111-111111111111',
   (select id from public.artists where slug='vladimir'),'Actual end test');
insert into public.sessions(id,artist_id,client_id,project_id,appointment_type,status,start_at,end_at)
values (
  'f9593333-3333-4333-8333-333333333333',
  (select id from public.artists where slug='vladimir'),
  'f9591111-1111-4111-8111-111111111111',
  'f9592222-2222-4222-8222-222222222222',
  'tattoo_session','confirmed',
  date_trunc('hour',now())+interval '30 days',
  date_trunc('hour',now())+interval '30 days 4 hours'
);
select is((select actual_end_at from public.sessions
 where id='f9593333-3333-4333-8333-333333333333'),null::timestamptz,
 'actual end is absent until evidenced');

select is(crm_private.enrol_booked_session_in_lifecycle(
 'f9593333-3333-4333-8333-333333333333','actual_end_test'),'enrolled',
 'real booked session is enrolled before any timing changes');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,
 'lifecycle jobs are materialized');
reset role;
select is((select j.scheduled_at from public.automation_jobs j
 where j.session_id='f9593333-3333-4333-8333-333333333333'
 and j.message_purpose='post_session_checkin'),
 (select s.end_at+interval '24 hours' from public.sessions s
  where s.id='f9593333-3333-4333-8333-333333333333'),
 'without evidence, check-in uses scheduled end');

select ok(not has_function_privilege('authenticated',
 'public.service_record_session_actual_end(uuid,timestamptz)','execute')
 and not has_function_privilege('anon',
 'public.service_record_session_actual_end(uuid,timestamptz)','execute'),
 'customers cannot call the actual end capture API');

-- Simulate an earlier finish that is already legitimately completed.
update public.sessions set
 status='completed',
 start_at=date_trunc('hour',now())-interval '6 hours',
 end_at=date_trunc('hour',now())-interval '1 hour'
where id='f9593333-3333-4333-8333-333333333333';

set local role service_role;
select lives_ok($$select public.service_record_session_actual_end(
 'f9593333-3333-4333-8333-333333333333',
 date_trunc('hour',now())-interval '2 hours')$$,
 'backend stores evidenced finish earlier than the booked end');
select is((public.service_record_session_actual_end(
 'f9593333-3333-4333-8333-333333333333',
 date_trunc('hour',now())-interval '2 hours')->>'changed')::boolean,false,
 'idempotent replay of the same actual time is unchanged');
select throws_ok($$select public.service_record_session_actual_end(
 'f9593333-3333-4333-8333-333333333333',
 date_trunc('hour',now())-interval '3 hours')$$,
 '23514',null,'conflicting finish time fails closed');
select lives_ok($$select * from public.service_run_automation_tick(500)$$,
 'scheduler reconciles the recorded actual finish');
reset role;

select is((select j.scheduled_at from public.automation_jobs j
 where j.session_id='f9593333-3333-4333-8333-333333333333'
 and j.message_purpose='post_session_aftercare'),
 (select s.actual_end_at from public.sessions s
  where s.id='f9593333-3333-4333-8333-333333333333'),
 'aftercare follows actual finish');
select is((select j.scheduled_at from public.automation_jobs j
 where j.session_id='f9593333-3333-4333-8333-333333333333'
 and j.message_purpose='post_session_checkin'),
 (select s.actual_end_at+interval '24 hours' from public.sessions s
  where s.id='f9593333-3333-4333-8333-333333333333'),
 'check-in follows actual finish plus 24 hours');
-- Consecutive-day block: the final day's evidenced finish is the only
-- anchor for the following day's wellbeing check, not the first day's end.
insert into public.sessions(id,artist_id,client_id,project_id,appointment_type,status,start_at,end_at)
select v.id,(select id from public.artists where slug='vladimir'),
 'f9591111-1111-4111-8111-111111111111','f9592222-2222-4222-8222-222222222222',
 'tattoo_session','confirmed',v.start_at,v.start_at+interval '4 hours'
from (values
 ('f9594444-4444-4444-8444-444444444444'::uuid,date_trunc('day',now())+interval '40 days 10 hours'),
 ('f9595555-5555-4555-8555-555555555555'::uuid,date_trunc('day',now())+interval '41 days 10 hours')
) v(id,start_at);
select is(crm_private.enrol_booked_session_in_lifecycle(
 'f9594444-4444-4444-8444-444444444444','actual_end_test'),'enrolled',
 'first consecutive day enrolled');
select is(crm_private.enrol_booked_session_in_lifecycle(
 'f9595555-5555-4555-8555-555555555555','actual_end_test'),'enrolled',
 'last consecutive day enrolled');
set local role service_role;
select lives_ok($select * from public.service_run_automation_tick(500)$,
 'consecutive-day jobs materialize');
reset role;
update public.sessions set
 status='completed',
 start_at=date_trunc('day',now())-interval '3 days'+interval '10 hours',
 end_at=date_trunc('day',now())-interval '3 days'+interval '14 hours'
where id='f9594444-4444-4444-8444-444444444444';
update public.sessions set
 status='completed',
 start_at=date_trunc('day',now())-interval '2 days'+interval '10 hours',
 end_at=date_trunc('day',now())-interval '2 days'+interval '14 hours'
where id='f9595555-5555-4555-8555-555555555555';
set local role service_role;
select lives_ok($select public.service_record_session_actual_end(
 'f9595555-5555-4555-8555-555555555555',
 date_trunc('day',now())-interval '2 days'+interval '13 hours')$,
 'last day records its actual finish separately');
select lives_ok($select * from public.service_run_automation_tick(500)$,
 'check-in reconciles last-day actual finish');
reset role;
select is((select j.scheduled_at from public.automation_jobs j
 where j.session_id='f9595555-5555-4555-8555-555555555555'
   and j.message_purpose='post_session_checkin'),
 (select s.actual_end_at+interval '24 hours' from public.sessions s
  where s.id='f9595555-5555-4555-8555-555555555555'),
 'final-day check-in is 24 hours after evidenced finish');
select is((select count(*)::int from public.email_messages m
 join public.automation_jobs j on j.id=m.automation_job_id
 where j.session_id in ('f9594444-4444-4444-8444-444444444444',
                        'f9595555-5555-4555-8555-555555555555')
 and j.message_purpose='post_session_checkin'),1,
 'two consecutive days prepare only one wellbeing check');
select * from finish();
rollback;
