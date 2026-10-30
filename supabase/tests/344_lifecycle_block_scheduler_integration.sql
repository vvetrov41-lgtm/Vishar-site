-- Scheduler integration: non-anchor jobs remain pending and do not enqueue an email.
begin;
select no_plan();
create temporary table block_artist as select a.id from public.artists a join crm_private.artist_state s on s.artist_id=a.id and s.is_active where a.slug='vladimir';
insert into public.clients (id,full_name,email) values ('f9511111-1111-4111-8111-111111111111','Lifecycle block test','lifecycle-block@example.test');
insert into public.projects (id,client_id,artist_id,title) values ('f9522222-2222-4222-8222-222222222222','f9511111-1111-4111-8111-111111111111',(select id from block_artist),'Lifecycle block test');
insert into public.sessions (id,artist_id,client_id,project_id,appointment_type,status,start_at,end_at)
select v.id,(select id from block_artist),'f9511111-1111-4111-8111-111111111111','f9522222-2222-4222-8222-222222222222','tattoo_session','confirmed',v.at,v.at+interval '4 hours'
from (values
 ('f9500000-0000-4000-8000-000000000001'::uuid, date_trunc('day',now())+interval '30 days 12 hours'),
 ('f9500000-0000-4000-8000-000000000002'::uuid, date_trunc('day',now())+interval '31 days 12 hours')
) v(id,at);
select is(crm_private.enrol_booked_session_in_lifecycle('f9500000-0000-4000-8000-000000000001','block_test'),'enrolled','first booked day enrolled');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,'jobs materialise');
reset role;
select is((select count(*)::int from public.automation_events where entity_id='f9500000-0000-4000-8000-000000000002' and event_type='appointment.scheduled'),1,'missing future appointment is enrolled exactly once');


-- Make both 72-hour reminders due while preserving consecutive local days.
update public.sessions set start_at=start_at-interval '29 days', end_at=end_at-interval '29 days'
where project_id='f9522222-2222-4222-8222-222222222222';
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select lives_ok($$select * from public.service_run_automation_tick(500)$$,'due jobs are processed');
select is((select status::text from public.automation_jobs where session_id='f9500000-0000-4000-8000-000000000002' and message_purpose='session_reminder_72h'),'pending','non-anchor reminder is kept for potential later split');
select is((select count(*)::int from public.email_messages m join public.automation_jobs j on j.id=m.automation_job_id where j.session_id='f9500000-0000-4000-8000-000000000002' and j.message_purpose='session_reminder_72h'),0,'second-day reminder does not queue an email');
select is(crm_private.execute_client_lifecycle_job((select id from public.automation_jobs where session_id='f9500000-0000-4000-8000-000000000002' and message_purpose='session_reminder_72h')),'pending','executor independently rejects a non-anchor even when called directly');
-- Moving the second day out of the block makes it the anchor of a new
-- block, but the old due timestamp must not trigger an early message.
update public.sessions set start_at=start_at+interval '10 days',end_at=end_at+interval '10 days'
where id='f9500000-0000-4000-8000-000000000002';
select is((select crm_private.lifecycle_block_disposition(id) from public.automation_jobs where session_id='f9500000-0000-4000-8000-000000000002' and message_purpose='session_reminder_72h'),'eligible','moved session is a new block anchor');
select is(crm_private.execute_client_lifecycle_job((select id from public.automation_jobs where session_id='f9500000-0000-4000-8000-000000000002' and message_purpose='session_reminder_72h')),'pending','executor refuses obsolete due time after move');
select * from finish();
rollback;
