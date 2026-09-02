-- 273_enquiry_assignee_tenant_scope.sql
--
-- Public self-service tenants must not inherit the installation-wide enquiry
-- assignee directory. The picker and the write guard must agree: a solo artist
-- can assign to themself, a real teammate can be added, and unrelated platform
-- operators stay outside the tenant.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('57311111-1111-4111-8111-111111111111', 'assignee-owner@example.test', now()),
  ('57322222-2222-4222-8222-222222222222', 'assignee-incumbent@example.test', now()),
  ('57333333-3333-4333-8333-333333333333', 'assignee-founder@example.test', now()),
  ('57344444-4444-4444-8444-444444444444', 'assignee-colleague@example.test', now());

insert into public.profiles (id, email, display_name, role, is_active) values
  ('57311111-1111-4111-8111-111111111111', 'assignee-owner@example.test',
   'Assignee Installation Owner', 'owner', true),
  ('57322222-2222-4222-8222-222222222222', 'assignee-incumbent@example.test',
   'Unrelated Manager', 'booking_manager', true),
  ('57344444-4444-4444-8444-444444444444', 'assignee-colleague@example.test',
   'Tenant Colleague', 'booking_manager', true);

-- The incumbent belongs to a legacy/invite-only artist and is intentionally
-- unrelated to the self-service tenant created below.
insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('57322222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, false, true);

create function pg_temp.owner() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"57311111-1111-4111-8111-111111111111","role":"authenticated"}', true)::void;
$$;
create function pg_temp.incumbent() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"57322222-2222-4222-8222-222222222222","role":"authenticated"}', true)::void;
$$;
create function pg_temp.founder() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"57333333-3333-4333-8333-333333333333","role":"authenticated"}', true)::void;
$$;
grant execute on function pg_temp.owner() to authenticated, service_role;
grant execute on function pg_temp.incumbent() to authenticated, service_role;
grant execute on function pg_temp.founder() to authenticated, service_role;

reset role;
select pg_temp.owner();
set local role authenticated;
select public.set_self_service_signup(true, 20, 1);

reset role;
select pg_temp.founder();
set local role authenticated;
select public.bootstrap_artist_account('Assignee Founder', 'Assignee Studio');

-- ---------------------------------------------------------------------------
-- A solo self-service tenant sees only itself in the assignee picker.
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from public.list_assignable_profiles()),
  1,
  'a solo self-service tenant has exactly one assignable person'
);
select is(
  (select p.id from public.list_assignable_profiles() p),
  '57333333-3333-4333-8333-333333333333'::uuid,
  'the only assignable person is the self-service founder'
);
select is(
  (select count(*)::int from public.list_assignable_profiles() p
   where p.id = '57311111-1111-4111-8111-111111111111'),
  0,
  'the installation owner is not disclosed to the self-service tenant'
);
select is(
  (select count(*)::int from public.list_assignable_profiles() p
   where p.id = '57322222-2222-4222-8222-222222222222'),
  0,
  'an unrelated booking manager is not disclosed to the self-service tenant'
);
select is(
  (select count(*)::int from public.list_assignable_profiles() p
   where p.id = '57344444-4444-4444-8444-444444444444'),
  0,
  'an active profile is not enough: a person without tenant membership is absent'
);

-- ---------------------------------------------------------------------------
-- A genuine teammate appears once they share the artist.
-- ---------------------------------------------------------------------------

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
)
select '57344444-4444-4444-8444-444444444444', s.artist_id,
       'manager', false, false, true, false, true
from crm_private.self_service_accounts s
where s.profile_id = '57333333-3333-4333-8333-333333333333';

reset role;
select pg_temp.founder();
set local role authenticated;

select is(
  (select count(*)::int from public.list_assignable_profiles()),
  2,
  'a real teammate expands the tenant assignee picker to two people'
);
select is(
  (select count(*)::int from public.list_assignable_profiles() p
   where p.id = '57344444-4444-4444-8444-444444444444'),
  1,
  'the teammate who genuinely shares the artist is assignable'
);
select is(
  (select count(*)::int from public.list_assignable_profiles() p
   where p.id in ('57311111-1111-4111-8111-111111111111',
                  '57322222-2222-4222-8222-222222222222')),
  0,
  'the installation owner and unrelated manager remain absent'
);

-- ---------------------------------------------------------------------------
-- The write guard enforces the same boundary, not just the browser picker.
-- ---------------------------------------------------------------------------

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok(
  $$select crm_private.require_assignee_for_artist(
      '57311111-1111-4111-8111-111111111111',
      (select s.artist_id from crm_private.self_service_accounts s
       where s.profile_id = '57333333-3333-4333-8333-333333333333'))$$,
  '22023',
  'assignee must be an active owner/manager for the same artist',
  'the installation owner cannot be assigned through the direct write boundary'
);
select throws_ok(
  $$select crm_private.require_assignee_for_artist(
      '57322222-2222-4222-8222-222222222222',
      (select s.artist_id from crm_private.self_service_accounts s
       where s.profile_id = '57333333-3333-4333-8333-333333333333'))$$,
  '22023',
  'assignee must be an active owner/manager for the same artist',
  'an unrelated manager cannot be assigned to the self-service artist'
);
select lives_ok(
  $$select crm_private.require_assignee_for_artist(
      '57333333-3333-4333-8333-333333333333',
      (select s.artist_id from crm_private.self_service_accounts s
       where s.profile_id = '57333333-3333-4333-8333-333333333333'))$$,
  'the self-service founder remains assignable to their own artist'
);
select lives_ok(
  $$select crm_private.require_assignee_for_artist(
      '57344444-4444-4444-8444-444444444444',
      (select s.artist_id from crm_private.self_service_accounts s
       where s.profile_id = '57333333-3333-4333-8333-333333333333'))$$,
  'a genuine tenant teammate remains assignable'
);

-- Legacy behaviour remains intact outside public self-service tenants.
select lives_ok(
  $$select crm_private.require_assignee_for_artist(
      '57311111-1111-4111-8111-111111111111',
      'a1111111-1111-4111-8111-111111111111')$$,
  'the installation owner is still assignable on a legacy artist'
);

reset role;
select pg_temp.incumbent();
set local role authenticated;
select is(
  (select count(*)::int from public.list_assignable_profiles() p
   where p.id = '57311111-1111-4111-8111-111111111111'),
  1,
  'an invite-only manager keeps the legacy installation-wide picker behaviour'
);

select * from finish();
rollback;
