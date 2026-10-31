-- Rebuilding blocks on cancellation, adding a day, and moving the last day.
-- Synthetic data, no transport send, full rollback.
begin;
select no_plan();
create temporary table recompute_artist as
select a.id from public.artists a
join crm_private.artist_state st on st.artist_id=a.id and st.is_active
where a.slug='vladimir';
grant select on recompute_artist to public;
insert into public.clients(id,full_name,email) values
('f9611111-1111-4111-8111-111111111111','Recompute test','recompute@example.test');
insert into public.projects(id,client_id,artist_id,title) values
('f9612222-2222-4222-8222-222222222222',
 'f9611111-1111-4111-8111-111111111111',(select id from recompute_artist),
 'Recompute test');
insert into public.sessions(id,artist_id,client_id,project_id,appointment_type,status,start_at,end_at)
select v.id,(select id from recompute_artist),
'f9611111-1111-4111-8111-111111111111','f9612222-2222-4222-8222-222222222222',
'tattoo_session','confirmed',v.start_at,v.start_at+interval '4 hours'
from (values
 ('f9610000-0000-4000-8000-000000000001'::uuid,date_trunc('day',now())+interval '30 days 12 hours'),
 ('f9610000-0000-4000-8000-000000000002'::uuid,date_trunc('day',now())+interval '31 days 12 hours'),
 ('f9610000-0000-4000-8000-000000000003'::uuid,date_trunc('day',now())+interval '32 days 12 hours')
) v(id,start_at);
select is(crm_private.enrol_booked_session_in_lifecycle(
 'f9610000-0000-4000-8000-000000000001','recompute'),'enrolled',
 'first day enrolled');
select is(crm_private.enrol_booked_session_in_lifecycle(
 'f9610000-0000-4000-8000-000000000002','recompute'),'enrolled',
 'middle day enrolled');
select is(crm_private.enrol_booked_session_in_lifecycle(
 'f9610000-0000-4000-8000-000000000003','recompute'),'enrolled',
 'third day enrolled');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,
 'initial block jobs are materialized');
reset role;
select is((select count(*)::int from crm_private.session_lifecycle_block(
 'f9610000-0000-4000-8000-000000000001')),3,'initial three-day block');
select is((select count(*)::int from public.automation_jobs
 where session_id in ('f9610000-0000-4000-8000-000000000001',
                      'f9610000-0000-4000-8000-000000000002',
                      'f9610000-0000-4000-8000-000000000003')
 and status='pending'),12,'three days have four pending rules each');
select is(crm_private.lifecycle_block_disposition(
 (select id from public.automation_jobs
  where session_id='f9610000-0000-4000-8000-000000000003'
  and message_purpose='session_reminder_72h')),'defer',
 'third day does not remind separately');

-- Removing middle day must split the block into two independent islands.
update public.sessions
set status='cancelled',cancelled_at=now(),calendar_version=calendar_version+1
where id='f9610000-0000-4000-8000-000000000002';
select is((select count(*)::int from crm_private.session_lifecycle_block(
 'f9610000-0000-4000-8000-000000000001')),1,'first day stands alone');
select is((select count(*)::int from crm_private.session_lifecycle_block(
 'f9610000-0000-4000-8000-000000000003')),1,'third day stands alone');
select is(crm_private.lifecycle_block_disposition(
 (select id from public.automation_jobs
  where session_id='f9610000-0000-4000-8000-000000000003'
  and message_purpose='session_reminder_72h')),'eligible',
 'new independent block gains reminder anchor');
set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,
 'cancelled day is withdrawn from pending work');
reset role;
select is((select count(*)::int from public.automation_jobs where
 session_id='f9610000-0000-4000-8000-000000000002'
 and status='cancelled'),4,'all cancelled-day jobs are withdrawn');

-- Booking a replacement middle day rejoins the island without resurrecting
-- the cancelled session or reusing any accepted message.
insert into public.sessions(id,artist_id,client_id,project_id,appointment_type,status,start_at,end_at)
values('f9610000-0000-4000-8000-000000000004',
 (select id from recompute_artist),
 'f9611111-1111-4111-8111-111111111111',
 'f9612222-2222-4222-8222-222222222222',
 'tattoo_session','confirmed',
 date_trunc('day',now())+interval '31 days 12 hours',
 date_trunc('day',now())+interval '31 days 16 hours');
select is(crm_private.enrol_booked_session_in_lifecycle(
 'f9610000-0000-4000-8000-000000000004','recompute'),'enrolled',
 'replacement day enrolled');
set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,
 'new middle day receives its own pending lifecycle jobs');
reset role;
select is((select count(*)::int from crm_private.session_lifecycle_block(
 'f9610000-0000-4000-8000-000000000001')),3,
 'adding a new middle day restores three-day block');
select is(crm_private.lifecycle_block_disposition(
 (select id from public.automation_jobs
  where session_id='f9610000-0000-4000-8000-000000000003'
  and message_purpose='session_reminder_72h')),'defer',
 'third-day reminder is suppressed again after rejoining');

-- A move of the final day makes the two earliest dates one block and moved
-- day a separate block. Its 24h check-in must not remain on the old block.
update public.sessions
set start_at=start_at+interval '8 days',end_at=end_at+interval '8 days'
where id='f9610000-0000-4000-8000-000000000003';
set local role service_role;
select lives_ok($$select * from public.service_run_automation_tick(500)$$,
 'pending job times follow last-day reschedule');
reset role;
select is((select count(*)::int from crm_private.session_lifecycle_block(
 'f9610000-0000-4000-8000-000000000001')),2,
 'first two days remain a block');
select is((select count(*)::int from crm_private.session_lifecycle_block(
 'f9610000-0000-4000-8000-000000000003')),1,
 'moved last day starts a new block');
select is(crm_private.lifecycle_block_disposition(
 (select id from public.automation_jobs
  where session_id='f9610000-0000-4000-8000-000000000003'
  and message_purpose='session_reminder_72h')),'eligible',
 'rescheduled last day becomes independent reminder anchor');
select is((select j.scheduled_at from public.automation_jobs j
 where j.session_id='f9610000-0000-4000-8000-000000000003'
 and j.message_purpose='post_session_checkin'),
 (select s.end_at+interval '24 hours' from public.sessions s
  where s.id='f9610000-0000-4000-8000-000000000003'),
 'new check-in follows moved last day');

select * from finish();
rollback;
