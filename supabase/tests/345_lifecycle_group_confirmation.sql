-- Scheduler integration: non-anchor jobs remain pending and do not enqueue an email.
begin;
select no_plan();
create temporary table block_artist as select a.id from public.artists a join crm_private.artist_state s on s.artist_id=a.id and s.is_active where a.slug='vladimir';
grant select on block_artist to public;
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
select lives_ok($$select public.service_set_gmail_integration(
 (select id from block_artist),'google_gmail_block_test','block-artist@example.test',
 array['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']::text[]
)$$,'synthetic Gmail route');
select lives_ok($$select * from public.service_run_automation_tick(500)$$,'jobs materialise');
reset role;
select is((select count(*)::int from public.automation_events where entity_id='f9500000-0000-4000-8000-000000000002' and event_type='appointment.scheduled'),1,'missing future appointment is enrolled exactly once');



-- Place the first appointment within 24 hours; the next is the following day.
update public.sessions set start_at=date_trunc('hour',now())+interval '20 hours',end_at=date_trunc('hour',now())+interval '24 hours' where id='f9500000-0000-4000-8000-000000000001';
update public.sessions set start_at=date_trunc('hour',now())+interval '44 hours',end_at=date_trunc('hour',now())+interval '48 hours' where id='f9500000-0000-4000-8000-000000000002';
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,'24-hour grouped reminder is queued');
reset role;
create temporary table lifecycle_token as select substring(m.body from '/appointments/respond/([0-9a-f]{64})') raw_token
from public.email_messages m join public.automation_jobs j on j.id=m.automation_job_id
where j.session_id='f9500000-0000-4000-8000-000000000001' and j.message_purpose='session_reminder_24h';
grant select on lifecycle_token to public;
select is((select count(*)::int from lifecycle_token where raw_token is not null),1,'one confirmation capability is available');
update public.sessions set start_at=start_at+interval '10 days',end_at=end_at+interval '10 days' where id='f9500000-0000-4000-8000-000000000002';
set local role service_role;
select throws_ok($$select * from public.service_resolve_appointment_client_action((select raw_token from lifecycle_token))$$,'42501',null,'changed block makes confirmation unavailable');
reset role;
update public.sessions set start_at=start_at-interval '10 days',end_at=end_at-interval '10 days' where id='f9500000-0000-4000-8000-000000000002';
set local role service_role;
select lives_ok($$select public.service_apply_appointment_client_action((select raw_token from lifecycle_token))$$,'one confirmation applies to the full unchanged block');
reset role;
select is((select count(*)::int from public.sessions where project_id='f9522222-2222-4222-8222-222222222222' and client_response='attendance_confirmed'),2,'both individual sessions are confirmed');
select * from finish();
rollback;
