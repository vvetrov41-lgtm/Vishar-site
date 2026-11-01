-- Isolated grouping tests; all fixtures roll back and no job is dispatched.
begin;
select no_plan();
create temporary table t_block_artist as select id from public.artists where slug='vladimir';
insert into public.clients (id,full_name,email) values ('f9411111-1111-4111-8111-111111111111','Block test','block-test@example.test');
insert into public.projects (id,client_id,artist_id,title) values ('f9422222-2222-4222-8222-222222222222','f9411111-1111-4111-8111-111111111111',(select id from t_block_artist),'Block test');
insert into public.sessions (id,artist_id,client_id,project_id,appointment_type,status,start_at,end_at,cancelled_at)
select v.id,(select id from t_block_artist),'f9411111-1111-4111-8111-111111111111','f9422222-2222-4222-8222-222222222222','tattoo_session',v.status::public.session_status,v.start_at,v.start_at+interval '4 hours',case when v.status='cancelled' then now() else null end
from (values
 ('f9400000-0000-4000-8000-000000000001'::uuid,'confirmed','2040-11-14 11:00+00'::timestamptz),
 ('f9400000-0000-4000-8000-000000000002'::uuid,'confirmed','2040-11-15 11:00+00'::timestamptz),
 ('f9400000-0000-4000-8000-000000000003'::uuid,'confirmed','2040-11-28 11:00+00'::timestamptz),
 ('f9400000-0000-4000-8000-000000000004'::uuid,'confirmed','2040-11-29 11:00+00'::timestamptz),
 ('f9400000-0000-4000-8000-000000000005'::uuid,'cancelled','2040-11-16 11:00+00'::timestamptz)
) v(id,status,start_at);
select is((select count(*)::int from crm_private.session_lifecycle_block('f9400000-0000-4000-8000-000000000001')),2,'first two consecutive days form a block');
select is((select count(*)::int from crm_private.session_lifecycle_block('f9400000-0000-4000-8000-000000000003')),2,'two days after a gap form a separate block');
select is((select count(*)::int from crm_private.session_lifecycle_block('f9400000-0000-4000-8000-000000000005')),0,'cancelled target cannot produce a block');
update public.sessions set start_at='2040-11-21 11:00+00',end_at='2040-11-21 15:00+00' where id='f9400000-0000-4000-8000-000000000002';
select is((select count(*)::int from crm_private.session_lifecycle_block('f9400000-0000-4000-8000-000000000001')),1,'rescheduling splits the block');
select ok(not has_function_privilege('service_role','crm_private.session_lifecycle_block(uuid)','execute') and not has_function_privilege('authenticated','crm_private.session_lifecycle_block(uuid)','execute') and not has_function_privilege('anon','crm_private.session_lifecycle_block(uuid)','execute'),'API roles cannot execute private helper');
select * from finish();
rollback;
