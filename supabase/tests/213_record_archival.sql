-- 213_record_archival.sql
-- Synthetic-only validation for owner-only CRM cleanup.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('fa111111-1111-4111-8111-111111111111', 'archive-owner@example.test'),
  ('fa222222-2222-4222-8222-222222222222', 'archive-manager@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('fa111111-1111-4111-8111-111111111111', 'archive-owner@example.test', 'Archive Owner', 'owner', true),
  ('fa222222-2222-4222-8222-222222222222', 'archive-manager@example.test', 'Archive Manager', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values (
  'fa222222-2222-4222-8222-222222222222',
  'a1111111-1111-4111-8111-111111111111',
  'manager', false, false, true, false, true
);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated, service_role;

set local role authenticated;
select pg_temp.claims('{"sub":"fa111111-1111-4111-8111-111111111111","role":"authenticated"}');

create temporary table archive_enquiry_fixture as
select public.create_manual_enquiry(
  'fa300000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  '{"full_name":"Archive Enquiry Client","email":"archive-enquiry@example.test"}'::jsonb,
  '{"project_type":"Test","idea":"Erroneous enquiry"}'::jsonb,
  true
) as r;
grant select on archive_enquiry_fixture to authenticated, service_role;

create temporary table archive_client_fixture as
select public.create_manual_enquiry(
  'fa300000-0000-4000-8000-000000000002',
  'a1111111-1111-4111-8111-111111111111',
  '{"full_name":"Archive Client","email":"archive-client@example.test"}'::jsonb,
  '{"project_type":"Test","idea":"Erroneous client"}'::jsonb,
  true
) as r;
grant select on archive_client_fixture to authenticated, service_role;

select pg_temp.claims('{"sub":"fa222222-2222-4222-8222-222222222222","role":"authenticated"}');
select throws_ok(
  format(
    $$select public.archive_enquiry(%L::uuid)$$,
    (select r ->> 'enquiry_id' from archive_enquiry_fixture)
  ),
  '42501', null,
  'booking manager cannot archive an enquiry'
);
select throws_ok(
  format(
    $$select public.archive_client(%L::uuid)$$,
    (select r ->> 'client_id' from archive_client_fixture)
  ),
  '42501', null,
  'booking manager cannot archive a client'
);

select pg_temp.claims('{"sub":"fa111111-1111-4111-8111-111111111111","role":"authenticated"}');
select is(
  public.archive_enquiry(
    (select (r ->> 'enquiry_id')::uuid from archive_enquiry_fixture)
  ) ->> 'changed',
  'true',
  'owner can archive an erroneous enquiry'
);
select ok(
  (select archived_at is not null
   from public.enquiries
   where id = (select (r ->> 'enquiry_id')::uuid from archive_enquiry_fixture)),
  'archived enquiry is retained with archived_at set'
);
select is(
  (select count(*)::int
   from public.activity_log
   where enquiry_id = (select (r ->> 'enquiry_id')::uuid from archive_enquiry_fixture)
     and event_type = 'enquiry.archived'),
  1,
  'enquiry archival appends one audit event'
);

select is(
  public.archive_client(
    (select (r ->> 'client_id')::uuid from archive_client_fixture)
  ) ->> 'archived_enquiries',
  '1',
  'owner client cleanup also archives its unconverted enquiry'
);
select ok(
  (select archived_at is not null
   from public.clients
   where id = (select (r ->> 'client_id')::uuid from archive_client_fixture)),
  'archived client is retained with archived_at set'
);
select ok(
  (select archived_at is not null
   from public.enquiries
   where id = (select (r ->> 'enquiry_id')::uuid from archive_client_fixture)),
  'client cleanup retains and archives its enquiry'
);
select is(
  (select count(*)::int
   from public.activity_log
   where client_id = (select (r ->> 'client_id')::uuid from archive_client_fixture)
     and event_type = 'client.archived'),
  1,
  'client archival appends one audit event'
);

reset role;
select ok(
  has_function_privilege('authenticated', 'public.archive_enquiry(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.archive_enquiry(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.archive_enquiry(uuid)', 'execute'),
  'enquiry archival RPC is exposed only to authenticated human CRM callers'
);
select ok(
  has_function_privilege('authenticated', 'public.archive_client(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.archive_client(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.archive_client(uuid)', 'execute'),
  'client archival RPC is exposed only to authenticated human CRM callers'
);

select * from finish();
rollback;
