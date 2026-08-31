-- 263_vladimir_whatsapp_connected_state.sql
-- Migration 0121: connected state is a bounded authenticated operation for
-- Vladimir's exact prepared WhatsApp route. Direct table UPDATE stays closed.

begin;
select no_plan();

select ok(
  not has_function_privilege('anon', 'public.complete_vladimir_whatsapp_connection()', 'EXECUTE'),
  'anon cannot complete Vladimir WhatsApp provisioning'
);
select ok(
  has_function_privilege('authenticated', 'public.complete_vladimir_whatsapp_connection()', 'EXECUTE'),
  'authenticated CRM operators may reach the bounded completion RPC'
);
select ok(
  not has_function_privilege('service_role', 'public.complete_vladimir_whatsapp_connection()', 'EXECUTE'),
  'service_role is not an alternate caller for the operator completion RPC'
);

insert into auth.users (id, email) values
  ('6d111111-1111-4111-8111-111111111111', 'wa.connected.owner@example.test'),
  ('6d222222-2222-4222-8222-222222222222', 'wa.connected.kristina@example.test');

insert into public.profiles (id, email, role, is_active) values
  ('6d111111-1111-4111-8111-111111111111', 'wa.connected.owner@example.test', 'owner', true),
  ('6d222222-2222-4222-8222-222222222222', 'wa.connected.kristina@example.test', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values (
  '6d222222-2222-4222-8222-222222222222',
  'a2222222-2222-4222-8222-222222222222',
  'manager', false, false, true, true, true
);

insert into public.artist_integrations (
  artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled, connected_at
) values (
  'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'meta_cloud_api', 'vladimir-production',
  'Vladimir WhatsApp', '{}'::jsonb, true, null
);

create function pg_temp.wa_connected_claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.wa_connected_claims(text) to authenticated;

set local role authenticated;
select pg_temp.wa_connected_claims(
  '{"sub":"6d222222-2222-4222-8222-222222222222","role":"authenticated"}'
);
select throws_ok(
  $$select public.complete_vladimir_whatsapp_connection()$$,
  '42501', null,
  'a manager scoped only to Kristina cannot complete Vladimir provisioning'
);
reset role;

update public.artist_integrations
set is_enabled = false
where artist_id = 'a1111111-1111-4111-8111-111111111111'
  and integration_type = 'whatsapp';

set local role authenticated;
select pg_temp.wa_connected_claims(
  '{"sub":"6d111111-1111-4111-8111-111111111111","role":"authenticated"}'
);
select throws_ok(
  $$select public.complete_vladimir_whatsapp_connection()$$,
  '55000', null,
  'even the owner cannot mark a disabled route connected'
);
reset role;

update public.artist_integrations
set is_enabled = true
where artist_id = 'a1111111-1111-4111-8111-111111111111'
  and integration_type = 'whatsapp';

set local role authenticated;
select pg_temp.wa_connected_claims(
  '{"sub":"6d111111-1111-4111-8111-111111111111","role":"authenticated"}'
);

create temporary table wa_connected_result as
select public.complete_vladimir_whatsapp_connection() as value;
grant select on wa_connected_result to authenticated;

select is(
  (select value ->> 'artist_id' from wa_connected_result),
  'a1111111-1111-4111-8111-111111111111',
  'the completion RPC returns only Vladimir identity'
);
select is(
  (select value ->> 'integration_key' from wa_connected_result),
  'vladimir-production',
  'the completion RPC returns the fixed production selector'
);
select ok(
  (select nullif(value ->> 'connected_at', '') is not null from wa_connected_result),
  'the completion RPC returns a server-generated connected timestamp'
);
select throws_ok(
  $$update public.artist_integrations
      set connected_at = clock_timestamp()
    where artist_id = 'a1111111-1111-4111-8111-111111111111'$$,
  '42501', null,
  'authenticated operators still have no direct artist_integrations UPDATE privilege'
);
reset role;

select ok(
  (select connected_at is not null
   from public.artist_integrations
   where artist_id = 'a1111111-1111-4111-8111-111111111111'
     and integration_type = 'whatsapp'),
  'the exact Vladimir WhatsApp row is marked connected'
);
select is(
  (select configuration
   from public.artist_integrations
   where artist_id = 'a1111111-1111-4111-8111-111111111111'
     and integration_type = 'whatsapp'),
  '{}'::jsonb,
  'connected-state completion does not persist provider credentials or metadata'
);

select * from finish();
rollback;
