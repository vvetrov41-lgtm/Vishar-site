-- 206_gpt_client_list.sql
--
-- The full-management client list is artist-scoped and PII-minimised. Contact
-- email/phone/Instagram remain available only through single-record detail.

begin;
select no_plan();

select has_function('public', 'gpt_list_clients', array['integer'],
  'PII-minimised GPT client list RPC exists');
select ok(
  has_function_privilege('authenticated', 'public.gpt_list_clients(integer)', 'EXECUTE'),
  'authenticated OAuth callers may use client list after capability checks'
);
select ok(
  not has_function_privilege('anon', 'public.gpt_list_clients(integer)', 'EXECUTE'),
  'anon cannot list GPT clients'
);
select ok(
  not has_function_privilege('service_role', 'public.gpt_list_clients(integer)', 'EXECUTE'),
  'service role cannot use user OAuth client-list surface'
);
select is(
  (select pg_get_function_result(p.oid)
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='gpt_list_clients'
     and pg_get_function_identity_arguments(p.oid)='p_limit integer'),
  'TABLE(client_id uuid, client_name text, preferred_contact text, travelling_from text, updated_at timestamp with time zone)',
  'bulk client list result excludes email, phone, Instagram and internal notes'
);

insert into auth.users (id, email) values
  ('db061111-1111-4111-8111-111111111111', 'gpt-client-list-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('db061111-1111-4111-8111-111111111111',
   'gpt-client-list-owner@example.test', 'GPT Client List Owner', 'owner', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance, can_manage_sessions,
  can_manage_integrations, is_active
) values
  ('db061111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'owner', true, true, true, true, true),
  ('db061111-1111-4111-8111-111111111111',
   'a2222222-2222-4222-8222-222222222222',
   'owner', true, true, true, true, true);

create function pg_temp.gpt_client_list_claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.gpt_client_list_claims(text) to authenticated;

set local role authenticated;
select pg_temp.gpt_client_list_claims(
  '{"sub":"db061111-1111-4111-8111-111111111111","role":"authenticated"}'
);

select public.configure_gpt_action_client('vladimir-gpt-actions','oauth-vladimir-client-list-test',true,true);
select public.configure_gpt_action_client('kristina-gpt-actions','oauth-kristina-client-list-test',true,true);
select public.configure_gpt_full_management('vladimir-gpt-actions',true,false,false);
select public.configure_gpt_full_management('kristina-gpt-actions',true,false,false);

create temporary table v_client_list_enquiry as
select public.create_manual_enquiry(
  'db061111-1111-4111-8111-222222222222',
  'a1111111-1111-4111-8111-111111111111',
  jsonb_build_object(
    'full_name','Vladimir Client List Fixture',
    'email','vladimir-list@example.test',
    'phone','+447700900601',
    'instagram','@vladimir_list',
    'preferred_contact','Email',
    'travelling_from','York'
  ),
  jsonb_build_object('project_type','Portrait','placement','Forearm','idea','Synthetic client list fixture'),
  true
) as result;
grant select on v_client_list_enquiry to authenticated;

create temporary table k_client_list_enquiry as
select public.create_manual_enquiry(
  'db062222-2222-4222-8222-222222222222',
  'a2222222-2222-4222-8222-222222222222',
  jsonb_build_object(
    'full_name','Kristina Client List Fixture',
    'email','kristina-list@example.test',
    'phone','+447700900602',
    'instagram','@kristina_list',
    'preferred_contact','Instagram',
    'travelling_from','Bath'
  ),
  jsonb_build_object('project_type','Watercolour','placement','Upper arm','idea','Synthetic client list fixture'),
  true
) as result;
grant select on k_client_list_enquiry to authenticated;

select pg_temp.gpt_client_list_claims(
  '{"sub":"db061111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-vladimir-client-list-test"}'
);

select is(
  (select count(*)::int from public.gpt_list_clients(50)
   where client_id=(select (result ->> 'client_id')::uuid from v_client_list_enquiry)),
  1,
  'Vladimir bulk client list includes its own linked client'
);
select is(
  (select count(*)::int from public.gpt_list_clients(50)
   where client_id=(select (result ->> 'client_id')::uuid from k_client_list_enquiry)),
  0,
  'Vladimir bulk client list excludes Kristina linked client'
);
select is(
  (select preferred_contact from public.gpt_list_clients(50)
   where client_id=(select (result ->> 'client_id')::uuid from v_client_list_enquiry)),
  'Email',
  'PII-minimised list retains operational preferred-contact label'
);

select pg_temp.gpt_client_list_claims(
  '{"sub":"db061111-1111-4111-8111-111111111111","role":"authenticated"}'
);
select throws_ok(
  $$select * from public.gpt_list_clients(25)$$,
  '42501', null,
  'normal CRM token cannot use GPT full-management client list'
);

select * from finish();
rollback;
