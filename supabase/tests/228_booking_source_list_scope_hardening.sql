-- 228_booking_source_list_scope_hardening.sql
--
-- Migration 0080: the optional Artist argument must not become an authorization
-- bypass. Booking-source rows contain Origin -> Artist routing configuration,
-- so a read-only membership may not enumerate them through the no-argument RPC.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  has_function_privilege('authenticated', 'public.list_booking_sources(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.list_booking_sources(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.list_booking_sources(uuid)', 'EXECUTE'),
  'booking-source listing remains an authenticated CRM RPC only'
);

insert into auth.users (id, email) values
  ('98111111-1111-4111-8111-111111111111', 'booking-read-only@example.test'),
  ('98222222-2222-4222-8222-222222222222', 'booking-manager-scope@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('98111111-1111-4111-8111-111111111111',
   'booking-read-only@example.test', 'Booking Source Read Only', 'booking_manager', true),
  ('98222222-2222-4222-8222-222222222222',
   'booking-manager-scope@example.test', 'Booking Source Manager', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  (
    '98111111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111',
    'read_only', false, false, false, false, true
  ),
  (
    '98222222-2222-4222-8222-222222222222',
    'a1111111-1111-4111-8111-111111111111',
    'manager', false, false, true, true, true
  );

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated;

set local role authenticated;
select pg_temp.claims(
  '{"sub":"98111111-1111-4111-8111-111111111111","role":"authenticated"}'
);

select throws_ok(
  $$select * from public.list_booking_sources(
      'a1111111-1111-4111-8111-111111111111'::uuid
    )$$,
  '42501', null,
  'a read-only membership cannot explicitly list Artist routing configuration'
);

select is(
  (select count(*)::int from public.list_booking_sources()),
  0,
  'the no-argument list cannot bypass manage_booking_sources for read-only memberships'
);

reset role;
set local role authenticated;
select pg_temp.claims(
  '{"sub":"98222222-2222-4222-8222-222222222222","role":"authenticated"}'
);

select ok(
  exists (
    select 1
    from public.list_booking_sources()
    where artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid
  ),
  'a manager with manage-integrations authority can list their Artist sources without an explicit Artist argument'
);

reset role;
select * from finish();
rollback;
