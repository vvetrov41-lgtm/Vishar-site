-- Archived Gmail snapshots remain stored but must disappear from the Today
-- server pulse. All fixtures are synthetic; transaction is rolled back.
begin;
select no_plan();
select set_config('request.jwt.claims','{"role":"service_role"}', true);

insert into public.clients (id,workspace_id,full_name,email) values
 ('c3870000-0000-4000-8000-000000000001',
   (select workspace_id from public.artists where id='a1111111-1111-4111-8111-111111111111'),
   'Active Gmail fixture', 'active-gmail-387@example.test'),
 ('c3870000-0000-4000-8000-000000000002',
   (select workspace_id from public.artists where id='a1111111-1111-4111-8111-111111111111'),
   'Archived Gmail fixture', 'archived-gmail-387@example.test');

insert into public.gmail_client_metadata_snapshots
  (artist_id,client_id,subject,last_message_at,direction)
values
 ('a1111111-1111-4111-8111-111111111111',
  'c3870000-0000-4000-8000-000000000001','Active fixture',now()-interval '1 minute','inbound'),
 ('a1111111-1111-4111-8111-111111111111',
  'c3870000-0000-4000-8000-000000000002','Archived fixture',now()-interval '1 minute','inbound');

update public.clients set archived_at=now()
where id='c3870000-0000-4000-8000-000000000002';

create temp table pulse_387 on commit drop as
select x->>'key' as key from
jsonb_array_elements(crm_private.pulse_items('a1111111-1111-4111-8111-111111111111',false,false,now())) x;

select ok(exists(select 1 from pulse_387
  where key='gmail-c3870000-0000-4000-8000-000000000001'),
  'unarchived inbound Gmail client remains visible in server pulse');

select ok(not exists(select 1 from pulse_387
  where key='gmail-c3870000-0000-4000-8000-000000000002'),
  'archived inbound Gmail client never resurfaces through SECURITY DEFINER pulse');

select is((select count(*)::int from public.gmail_client_metadata_snapshots
  where client_id='c3870000-0000-4000-8000-000000000002'),1,
  'archived provider snapshot stays stored for audit/history');

select ok(not has_function_privilege('anon','crm_private.pulse_items(uuid,boolean,boolean,timestamptz)','execute')
   and not has_function_privilege('authenticated','crm_private.pulse_items(uuid,boolean,boolean,timestamptz)','execute'),
   'private pulse helper remains unavailable to public API roles');

select * from finish(true);
rollback;
