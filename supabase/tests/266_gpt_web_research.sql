-- 266_gpt_web_research.sql
begin;
select no_plan();

select ok(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'crm_private'
      and table_name = 'gpt_action_clients'
      and column_name = 'can_use_web_research'
      and is_nullable = 'NO'
      and column_default = 'false'
  ),
  'web research capability is a non-null fail-closed GPT client ceiling'
);

select ok(
  has_function_privilege('authenticated', 'public.gpt_authorize_web_research()', 'EXECUTE'),
  'authenticated OAuth sessions may call the web research authorizer'
);
select ok(
  not has_function_privilege('anon', 'public.gpt_authorize_web_research()', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.gpt_authorize_web_research()', 'EXECUTE'),
  'anonymous and service roles cannot call the web research authorizer'
);
select ok(
  (select p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=%'
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'gpt_authorize_web_research'),
  'web research authorization is SECURITY DEFINER with a pinned search_path'
);
select is(
  (select can_use_web_research from crm_private.gpt_action_clients
   where integration_key = 'vishar-unified-gpt'),
  false,
  'the dormant unified GPT remains fail-closed for web research'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('e5661111-1111-4111-8111-111111111111', 'web-research-manager@example.test'),
  ('e5662222-2222-4222-8222-222222222222', 'web-research-owner@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('e5661111-1111-4111-8111-111111111111', 'web-research-manager@example.test', 'Web Research Manager', 'booking_manager', true),
  ('e5662222-2222-4222-8222-222222222222', 'web-research-owner@example.test', 'Web Research Owner', 'owner', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values (
  'e5661111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'read_only', false, false, false, false, true
);

update crm_private.gpt_action_clients
set oauth_client_id = 'oauth-web-research-test',
    is_active = true,
    can_use_web_research = false
where integration_key = 'vladimir-gpt-actions';

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated;

set local role authenticated;
select pg_temp.claims(
  '{"sub":"e5661111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-web-research-test"}'
);

select throws_ok(
  $$select public.gpt_authorize_web_research()$$,
  '42501', null,
  'registered GPT is denied before its web research ceiling is enabled'
);

reset role;
update crm_private.gpt_action_clients
set can_use_web_research = true
where integration_key = 'vladimir-gpt-actions';
set local role authenticated;

select is(
  public.gpt_authorize_web_research() ->> 'allowed',
  'true',
  'enabled GPT plus current Artist view membership authorizes web research'
);

select pg_temp.claims(
  '{"sub":"e5661111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-not-registered"}'
);
select throws_ok(
  $$select public.gpt_authorize_web_research()$$,
  '42501', null,
  'unregistered OAuth client is denied before web research'
);

select pg_temp.claims(
  '{"sub":"e5661111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-web-research-test"}'
);
reset role;
update public.artist_memberships
set is_active = false
where profile_id = 'e5661111-1111-4111-8111-111111111111'
  and artist_id = 'a1111111-1111-4111-8111-111111111111';
set local role authenticated;
select throws_ok(
  $$select public.gpt_authorize_web_research()$$,
  '42501', null,
  'revoked Artist membership denies web research even when the GPT ceiling is enabled'
);

select pg_temp.claims(
  '{"sub":"e5661111-1111-4111-8111-111111111111","role":"authenticated"}'
);
select throws_ok(
  $$select public.configure_gpt_web_research_access('vladimir-gpt-actions', false)$$,
  '42501', null,
  'non-owner cannot configure the web research capability'
);

select pg_temp.claims(
  '{"sub":"e5662222-2222-4222-8222-222222222222","role":"authenticated"}'
);
select is(
  public.configure_gpt_web_research_access('vladimir-gpt-actions', false) ->> 'can_use_web_research',
  'false',
  'owner can disable the web research capability through the reviewed RPC'
);

select is(
  (select can_use_web_research from crm_private.gpt_action_clients
   where integration_key = 'vladimir-gpt-actions'),
  false,
  'owner configuration persists the requested web research ceiling'
);

select ok(
  exists (
    select 1 from public.activity_log
    where event_type = 'gpt.client_configured'
      and actor_profile_id = 'e5662222-2222-4222-8222-222222222222'
      and metadata ->> 'integration' = 'vladimir-gpt-actions'
      and metadata ->> 'web_research_access' = 'false'
  ),
  'owner web research configuration is audited without provider secrets'
);

select * from finish();
rollback;
