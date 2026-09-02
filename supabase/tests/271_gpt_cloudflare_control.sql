-- 271_gpt_cloudflare_control.sql
begin;
select no_plan();

select ok(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'crm_private'
      and table_name = 'gpt_action_clients'
      and column_name = 'can_use_cloudflare_control'
      and is_nullable = 'NO'
      and column_default = 'false'
  ),
  'Cloudflare control capability is a non-null fail-closed GPT client ceiling'
);

select ok(
  has_function_privilege('authenticated', 'public.gpt_authorize_cloudflare_control()', 'EXECUTE'),
  'authenticated OAuth sessions may call the Cloudflare control authorizer'
);
select ok(
  not has_function_privilege('anon', 'public.gpt_authorize_cloudflare_control()', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.gpt_authorize_cloudflare_control()', 'EXECUTE'),
  'anonymous and service roles cannot call the Cloudflare control authorizer'
);
select ok(
  (select p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=%'
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'gpt_authorize_cloudflare_control'),
  'Cloudflare control authorization is SECURITY DEFINER with a pinned search_path'
);

select is(
  (select can_use_cloudflare_control from crm_private.gpt_action_clients
   where integration_key = 'vladimir-gpt-actions'),
  false,
  'legacy Vladimir GPT remains fail-closed until production activation'
);
select is(
  (select can_use_cloudflare_control from crm_private.gpt_action_clients
   where integration_key = 'vishar-unified-gpt'),
  false,
  'dormant unified GPT remains fail-closed until production activation'
);
select is(
  (select can_use_cloudflare_control from crm_private.gpt_action_clients
   where integration_key = 'kristina-gpt-actions'),
  false,
  'Kristina GPT remains fail-closed for account-wide Cloudflare control'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('e5671111-1111-4111-8111-111111111111', 'cloudflare-manager@example.test'),
  ('e5672222-2222-4222-8222-222222222222', 'cloudflare-owner@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('e5671111-1111-4111-8111-111111111111', 'cloudflare-manager@example.test', 'Cloudflare Manager', 'booking_manager', true),
  ('e5672222-2222-4222-8222-222222222222', 'cloudflare-owner@example.test', 'Cloudflare Owner', 'owner', true);

-- Creating an owner profile already provisions its active Artist membership.
-- Only the non-owner fixture needs an explicit membership row here.
insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values (
  'e5671111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'manager', false, false, true, true, true
);

update crm_private.gpt_action_clients
set oauth_client_id = 'oauth-cloudflare-test',
    is_active = true,
    can_use_cloudflare_control = false
where integration_key = 'vladimir-gpt-actions';

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated;

set local role authenticated;
select pg_temp.claims(
  '{"sub":"e5672222-2222-4222-8222-222222222222","role":"authenticated","client_id":"oauth-cloudflare-test"}'
);
select throws_ok(
  $$select public.gpt_authorize_cloudflare_control()$$,
  '42501', null,
  'owner GPT is denied before its Cloudflare control ceiling is enabled'
);

reset role;
update crm_private.gpt_action_clients
set can_use_cloudflare_control = true
where integration_key = 'vladimir-gpt-actions';
set local role authenticated;

select is(
  public.gpt_authorize_cloudflare_control() ->> 'allowed',
  'true',
  'owner plus reviewed enabled GPT authorizes Cloudflare control'
);

select pg_temp.claims(
  '{"sub":"e5671111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-cloudflare-test"}'
);
select throws_ok(
  $$select public.gpt_authorize_cloudflare_control()$$,
  '42501', null,
  'non-owner is denied account-wide Cloudflare control despite GPT ceiling and Artist access'
);

select pg_temp.claims(
  '{"sub":"e5672222-2222-4222-8222-222222222222","role":"authenticated","client_id":"oauth-not-registered"}'
);
select throws_ok(
  $$select public.gpt_authorize_cloudflare_control()$$,
  '42501', null,
  'unregistered OAuth client is denied before Cloudflare control'
);

select pg_temp.claims(
  '{"sub":"e5671111-1111-4111-8111-111111111111","role":"authenticated"}'
);
select throws_ok(
  $$select public.configure_gpt_cloudflare_control_access('vladimir-gpt-actions', false)$$,
  '42501', null,
  'non-owner cannot configure Cloudflare control capability'
);

select pg_temp.claims(
  '{"sub":"e5672222-2222-4222-8222-222222222222","role":"authenticated"}'
);
select is(
  public.configure_gpt_cloudflare_control_access('vladimir-gpt-actions', false) ->> 'can_use_cloudflare_control',
  'false',
  'owner can disable legacy owner GPT Cloudflare capability through the audited RPC'
);

reset role;
update crm_private.gpt_action_clients
set oauth_client_id = 'oauth-unified-cloudflare-test',
    is_active = true
where integration_key = 'vishar-unified-gpt';
set local role authenticated;
select pg_temp.claims(
  '{"sub":"e5672222-2222-4222-8222-222222222222","role":"authenticated"}'
);
select is(
  public.configure_gpt_cloudflare_control_access('vishar-unified-gpt', true) ->> 'can_use_cloudflare_control',
  'true',
  'owner may enable the reviewed Unified GPT v2 identity after it is active'
);
select is(
  public.configure_gpt_cloudflare_control_access('vishar-unified-gpt', false) ->> 'can_use_cloudflare_control',
  'false',
  'owner may roll Unified GPT v2 Cloudflare capability back off'
);
select throws_ok(
  $$select public.configure_gpt_cloudflare_control_access('kristina-gpt-actions', true)$$,
  '42501', null,
  'owner cannot enable account-wide Cloudflare control for an unreviewed GPT integration'
);

reset role;
select is(
  (select can_use_cloudflare_control from crm_private.gpt_action_clients
   where integration_key = 'vladimir-gpt-actions'),
  false,
  'legacy owner GPT configuration persists the requested disabled ceiling'
);
select is(
  (select can_use_cloudflare_control from crm_private.gpt_action_clients
   where integration_key = 'vishar-unified-gpt'),
  false,
  'Unified GPT configuration persists the requested disabled rollback state'
);

select ok(
  exists (
    select 1 from public.activity_log
    where event_type = 'gpt.client_configured'
      and actor_profile_id = 'e5672222-2222-4222-8222-222222222222'
      and metadata ->> 'integration' = 'vishar-unified-gpt'
      and metadata ->> 'cloudflare_control_access' = 'false'
  ),
  'owner Cloudflare configuration is audited without provider credentials'
);

select * from finish();
rollback;
