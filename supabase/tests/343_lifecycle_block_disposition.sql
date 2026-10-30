-- Disposition is advisory; it never sends a message.
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
select is(crm_private.enrol_booked_session_in_lifecycle('f9500000-0000-4000-8000-000000000002','block_test'),'enrolled','second booked day enrolled');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,'jobs materialise');
reset role;
select is((select crm_private.lifecycle_block_disposition(id) from public.automation_jobs where session_id='f9500000-0000-4000-8000-000000000001' and message_purpose='session_reminder_72h'),'eligible','first day is reminder anchor');
select is((select crm_private.lifecycle_block_disposition(id) from public.automation_jobs where session_id='f9500000-0000-4000-8000-000000000002' and message_purpose='session_reminder_72h'),'defer','second day does not send another reminder');
update public.sessions set status='completed' where id='f9500000-0000-4000-8000-000000000001';
select is((select crm_private.lifecycle_block_disposition(id) from public.automation_jobs where session_id='f9500000-0000-4000-8000-000000000001' and message_purpose='post_session_aftercare'),'eligible','first completed day receives aftercare');
select is((select crm_private.lifecycle_block_disposition(id) from public.automation_jobs where session_id='f9500000-0000-4000-8000-000000000001' and message_purpose='post_session_checkin'),'defer','checkin waits for the later day');
update public.sessions set status='completed' where id='f9500000-0000-4000-8000-000000000002';
select is((select crm_private.lifecycle_block_disposition(id) from public.automation_jobs where session_id='f9500000-0000-4000-8000-000000000002' and message_purpose='post_session_checkin'),'eligible','checkin follows the last day');
update public.automation_jobs set status='completed',completed_at=now() where session_id='f9500000-0000-4000-8000-000000000001' and message_purpose='post_session_aftercare';
select is((select crm_private.lifecycle_block_disposition(id) from public.automation_jobs where session_id='f9500000-0000-4000-8000-000000000002' and message_purpose='post_session_aftercare'),'already_queued','queued aftercare prevents duplicate');
select ok(not has_function_privilege('authenticated','crm_private.lifecycle_block_disposition(uuid)','execute') and not has_function_privilege('service_role','crm_private.lifecycle_block_disposition(uuid)','execute'),'private helper cannot be invoked directly by API roles');
select * from finish();
rollback;
