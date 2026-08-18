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
    $$select public.update_enquiry_details(%L::uuid, '{"_archive":true}'::jsonb)$$,
    (select r ->> 'enquiry_id' from archive_enquiry_fixture)
  ),
  '42501', null,
  'booking manager cannot archive an enquiry through the canonical edit RPC'
);
select throws_ok(
  format(
    $$select public.update_client_details(%L::uuid, '{"_archive":true}'::jsonb)$$,
    (select r ->> 'client_id' from archive_client_fixture)
  ),
  '42501', null,
  'booking manager cannot archive a client through the canonical edit RPC'
);

select pg_temp.claims('{"sub":"fa111111-1111-4111-8111-111111111111","role":"authenticated"}');
select is(
  public.update_enquiry_details(
    (select (r ->> 'enquiry_id')::uuid from archive_enquiry_fixture),
    '{"_archive":true}'::jsonb
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
  public.update_client_details(
    (select (r ->> 'client_id')::uuid from archive_client_fixture),
    '{"_archive":true}'::jsonb
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
  to_regprocedure('public.archive_enquiry(uuid)') is null
  and to_regprocedure('public.archive_client(uuid)') is null,
  'record cleanup does not expand the public callable RPC inventory'
);
select ok(
  has_function_privilege('authenticated', 'public.update_enquiry_details(uuid,jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.update_enquiry_details(uuid,jsonb)', 'execute')
  and not has_function_privilege('service_role', 'public.update_enquiry_details(uuid,jsonb)', 'execute'),
  'canonical enquiry edit RPC keeps its existing API-role ACL'
);
select ok(
  has_function_privilege('authenticated', 'public.update_client_details(uuid,jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.update_client_details(uuid,jsonb)', 'execute')
  and not has_function_privilege('service_role', 'public.update_client_details(uuid,jsonb)', 'execute'),
  'canonical client edit RPC keeps its existing API-role ACL'
);
select ok(
  not has_function_privilege('authenticated', 'crm_private.update_enquiry_details_core(uuid,jsonb)', 'execute')
  and not has_function_privilege('service_role', 'crm_private.update_enquiry_details_core(uuid,jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'crm_private.update_client_details_core(uuid,jsonb)', 'execute')
  and not has_function_privilege('service_role', 'crm_private.update_client_details_core(uuid,jsonb)', 'execute'),
  'preserved edit implementations stay closed behind the public wrappers'
);

select * from finish();
rollback;
