-- 080_artists_memberships.sql
--
-- Artist identities, owner membership materialisation, capability narrowing,
-- RLS and ACL checks for migration 0015.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Schema and initial identities
-- ---------------------------------------------------------------------------

select has_type('public', 'artist_access_level', 'artist_access_level exists');
select enum_has_labels(
  'public', 'artist_access_level',
  array['owner', 'artist', 'manager', 'read_only'],
  'artist_access_level has the four intended membership levels'
);

select has_table('public', 'artists', 'artists exists');
select has_table('public', 'artist_memberships', 'artist_memberships exists');

select has_column('public', 'artists', c, 'artists.' || c || ' exists')
from unnest(array[
  'id', 'slug', 'display_name', 'legal_name', 'timezone',
  'default_currency', 'booking_reference_prefix', 'is_active',
  'created_at', 'updated_at'
]) as c;

select has_column('public', 'artist_memberships', c, 'artist_memberships.' || c || ' exists')
from unnest(array[
  'id', 'profile_id', 'artist_id', 'access_level',
  'can_view_finance', 'can_manage_finance', 'can_manage_sessions',
  'can_manage_integrations', 'is_active', 'created_at', 'updated_at'
]) as c;

select col_is_unique('public', 'artists', 'slug', 'artist slug is unique');
select col_is_unique(
  'public', 'artist_memberships', array['profile_id', 'artist_id'],
  'one profile has at most one membership per artist'
);
select col_not_null('public', 'artists', 'slug', 'artist slug is required');
select col_not_null('public', 'artist_memberships', 'profile_id', 'membership profile is required');
select col_not_null('public', 'artist_memberships', 'artist_id', 'membership artist is required');

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is((select count(*)::int from public.artists), 2,
          'exactly the two initial artist identities exist');
select is((select id from public.artists where slug = 'vladimir'),
          'a1111111-1111-4111-8111-111111111111'::uuid,
          'Vladimir has the stable migration id');
select is((select id from public.artists where slug = 'kristina'),
          'a2222222-2222-4222-8222-222222222222'::uuid,
          'Kristina has the stable migration id');
select is((select display_name from public.artists where slug = 'vladimir'),
          'Vladimir', 'Vladimir display name is seeded');
select is((select display_name from public.artists where slug = 'kristina'),
          'Kristina', 'Kristina display name is seeded');
select ok((select bool_and(timezone = 'Europe/London') from public.artists),
          'both artists use the explicit Europe/London timezone');
select ok((select bool_and(default_currency = 'GBP') from public.artists),
          'both artists use explicit GBP currency');
select ok((select bool_and(is_active) from public.artists),
          'both initial artists are active');
select is((select count(*)::int from crm_private.artist_state), 2,
          'the private artist-state mirror contains both artists');

select throws_ok(
  $$insert into public.artists (slug, display_name) values ('Vladimir', 'Bad slug')$$,
  '23514', null,
  'an invalid mixed-case artist slug is rejected'
);
select throws_ok(
  $$insert into public.artists (slug, display_name, default_currency)
    values ('bad-currency', 'Bad currency', 'gbp')$$,
  '23514', null,
  'a non-ISO-shaped artist currency is rejected'
);
select throws_ok(
  $$insert into public.artists (slug, display_name)
    values ('vladimir', 'Duplicate')$$,
  '23505', null,
  'a duplicate artist slug is rejected'
);

-- ---------------------------------------------------------------------------
-- Profiles and membership fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'artist-owner@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'artist-manager@example.test'),
  ('33333333-3333-4333-8333-333333333333', 'artist-reader@example.test'),
  ('44444444-4444-4444-8444-444444444444', 'artist-disabled@example.test'),
  ('55555555-5555-4555-8555-555555555555', 'artist-nonstaff@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('11111111-1111-4111-8111-111111111111', 'artist-owner@example.test', 'Artist Owner', 'owner', true),
  ('22222222-2222-4222-8222-222222222222', 'artist-manager@example.test', 'Artist Manager', 'booking_manager', true),
  ('33333333-3333-4333-8333-333333333333', 'artist-reader@example.test', 'Artist Reader', 'read_only', true),
  ('44444444-4444-4444-8444-444444444444', 'artist-disabled@example.test', 'Disabled Manager', 'booking_manager', false);
-- 55555555 deliberately has an auth user but no CRM profile.

select is(
  (select count(*)::int from public.artist_memberships
   where profile_id = '11111111-1111-4111-8111-111111111111'),
  2,
  'inserting an active owner materialises membership for both artists'
);
select ok(
  (select bool_and(
     access_level = 'owner'
     and can_view_finance
     and can_manage_finance
     and can_manage_sessions
     and can_manage_integrations
     and is_active
   )
   from public.artist_memberships
   where profile_id = '11111111-1111-4111-8111-111111111111'),
  'owner memberships contain every owner capability'
);
select is(
  (select count(*)::int from crm_private.artist_access
   where profile_id = '11111111-1111-4111-8111-111111111111' and is_active),
  2,
  'owner memberships are mirrored into private access state'
);

select throws_ok(
  $$insert into public.artist_memberships (
      profile_id, artist_id, access_level,
      can_view_finance, can_manage_finance
    ) values (
      '22222222-2222-4222-8222-222222222222',
      'a1111111-1111-4111-8111-111111111111',
      'manager', false, true
    )$$,
  '23514', null,
  'finance management cannot be granted without finance visibility'
);

select throws_ok(
  $$insert into public.artist_memberships (
      profile_id, artist_id, access_level
    ) values (
      '22222222-2222-4222-8222-222222222222',
      'a1111111-1111-4111-8111-111111111111',
      'owner'
    )$$,
  '23514', null,
  'an owner-level membership must contain every owner capability'
);

select throws_ok(
  $$insert into public.artist_memberships (
      profile_id, artist_id, access_level, can_manage_sessions
    ) values (
      '33333333-3333-4333-8333-333333333333',
      'a2222222-2222-4222-8222-222222222222',
      'read_only', true
    )$$,
  '23514', null,
  'read-only membership cannot carry a management capability'
);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  (
    '22222222-2222-4222-8222-222222222222',
    'a2222222-2222-4222-8222-222222222222',
    'manager', false, false, true, false, true
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    'a1111111-1111-4111-8111-111111111111',
    'read_only', false, false, false, false, true
  ),
  (
    '44444444-4444-4444-8444-444444444444',
    'a2222222-2222-4222-8222-222222222222',
    'manager', true, false, true, false, true
  );

select throws_ok(
  $$insert into public.artist_memberships (
      profile_id, artist_id, access_level
    ) values (
      '22222222-2222-4222-8222-222222222222',
      'a2222222-2222-4222-8222-222222222222',
      'manager'
    )$$,
  '23505', null,
  'a duplicate profile/artist membership is rejected'
);

select throws_ok(
  $$update public.artist_memberships
    set artist_id = 'a1111111-1111-4111-8111-111111111111'
    where profile_id = '22222222-2222-4222-8222-222222222222'
      and artist_id = 'a2222222-2222-4222-8222-222222222222'$$,
  '23514', null,
  'membership identity cannot be reassigned by update'
);

select is(
  (select count(*)::int from crm_private.artist_access
   where profile_id in (
     '22222222-2222-4222-8222-222222222222',
     '33333333-3333-4333-8333-333333333333',
     '44444444-4444-4444-8444-444444444444'
   )),
  3,
  'every non-owner fixture membership is mirrored'
);

-- ---------------------------------------------------------------------------
-- RLS, ACL and helper exposure
-- ---------------------------------------------------------------------------

select ok(
  (select c.relrowsecurity and c.relforcerowsecurity
   from pg_class c where c.oid = 'public.artists'::regclass),
  'artists has enabled and forced RLS'
);
select ok(
  (select c.relrowsecurity and c.relforcerowsecurity
   from pg_class c where c.oid = 'public.artist_memberships'::regclass),
  'artist_memberships has enabled and forced RLS'
);

select ok(has_table_privilege('authenticated', 'public.artists', 'SELECT'),
          'authenticated may select artist identities through RLS');
select ok(not has_table_privilege('authenticated', 'public.artists', 'INSERT'),
          'authenticated cannot directly insert an artist');
select ok(not has_table_privilege('authenticated', 'public.artists', 'UPDATE'),
          'authenticated cannot directly update an artist');
select ok(has_table_privilege('authenticated', 'public.artist_memberships', 'SELECT'),
          'authenticated may select permitted memberships through RLS');
select ok(not has_table_privilege('authenticated', 'public.artist_memberships', 'INSERT'),
          'authenticated cannot directly insert a membership');
select ok(not has_table_privilege('authenticated', 'public.artist_memberships', 'UPDATE'),
          'authenticated cannot directly update a membership');
select ok(not has_table_privilege('anon', 'public.artists', 'SELECT'),
          'anon has no artist-table read privilege');

select ok(has_function_privilege('authenticated', 'public.can_access_artist(uuid)', 'EXECUTE'),
          'authenticated may call the narrow artist-access helper');
select ok(has_function_privilege('authenticated', 'public.list_accessible_artists()', 'EXECUTE'),
          'authenticated may list only accessible artist identities');
select ok(not has_function_privilege('anon', 'public.can_access_artist(uuid)', 'EXECUTE'),
          'anon cannot call the artist-access helper');
select ok(not has_function_privilege(
            'authenticated', 'crm_private.require_artist_access(uuid,text)', 'EXECUTE'),
          'the private assertion helper is not a browser RPC');

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Anonymous and unprofiled accounts
-- ---------------------------------------------------------------------------

set local role anon;
select pg_temp.claims('{"role":"anon"}');
select throws_ok($$select count(*) from public.artists$$, '42501', null,
  'anon cannot enumerate artists');
select throws_ok($$select * from public.list_accessible_artists()$$, '42501', null,
  'anon cannot call the accessible-artist RPC');
reset role;

set local role authenticated;
select pg_temp.claims('{"sub":"55555555-5555-4555-8555-555555555555","role":"authenticated"}');
select is((select count(*)::int from public.artists), 0,
          'an auth user without a CRM profile sees no artists');
select is((select count(*)::int from public.artist_memberships), 0,
          'an auth user without a CRM profile sees no memberships');
select is((select count(*)::int from public.list_accessible_artists()), 0,
          'an auth user without a profile has no accessible artist scope');
reset role;

-- ---------------------------------------------------------------------------
-- Owner scope
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}');
select is((select count(*)::int from public.artists), 2,
          'owner sees both artist identities');
select is((select count(*)::int from public.list_accessible_artists()), 2,
          'owner accessible-artist list contains both artists');
select is((select count(*)::int from public.artist_memberships), 5,
          'owner may inspect all current memberships');
select ok(public.can_access_artist('a1111111-1111-4111-8111-111111111111'),
          'owner can access Vladimir scope');
select ok(public.can_access_artist('a2222222-2222-4222-8222-222222222222'),
          'owner can access Kristina scope');
select ok(public.can_manage_artist_finance('a1111111-1111-4111-8111-111111111111'),
          'owner can manage Vladimir finance');
select ok(public.can_manage_artist_integrations('a2222222-2222-4222-8222-222222222222'),
          'owner can manage Kristina integrations');
select throws_ok(
  $$insert into public.artist_memberships (
      profile_id, artist_id, access_level
    ) values (
      '55555555-5555-4555-8555-555555555555',
      'a1111111-1111-4111-8111-111111111111',
      'read_only'
    )$$,
  '42501', null,
  'even owner has no direct browser insert privilege on memberships'
);
reset role;

-- ---------------------------------------------------------------------------
-- Assigned manager scope
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}');
select is((select count(*)::int from public.artists), 1,
          'manager sees only the assigned artist');
select is((select slug from public.list_accessible_artists()), 'kristina',
          'manager accessible-artist list is Kristina only');
select is((select count(*)::int from public.artist_memberships), 1,
          'manager sees only their own membership row');
select ok(public.can_access_artist('a2222222-2222-4222-8222-222222222222'),
          'manager can access assigned Kristina scope');
select ok(not public.can_access_artist('a1111111-1111-4111-8111-111111111111'),
          'manager cannot access unassigned Vladimir scope');
select ok(public.can_manage_artist('a2222222-2222-4222-8222-222222222222'),
          'manager membership permits operational management');
select ok(public.can_manage_artist_sessions('a2222222-2222-4222-8222-222222222222'),
          'manager membership permits Kristina session management');
select ok(not public.can_view_artist_finance('a2222222-2222-4222-8222-222222222222'),
          'manager cannot see finance without the explicit flag');
select ok(not public.can_manage_artist_integrations('a2222222-2222-4222-8222-222222222222'),
          'manager cannot manage integrations without the explicit flag');
select throws_ok(
  $$update public.artist_memberships set can_view_finance = true$$,
  '42501', null,
  'manager cannot alter membership capabilities directly');
reset role;

-- ---------------------------------------------------------------------------
-- Read-only and disabled profiles
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}');
select is((select count(*)::int from public.artists), 1,
          'read-only profile sees its assigned artist');
select is((select slug from public.list_accessible_artists()), 'vladimir',
          'read-only accessible-artist list is Vladimir only');
select ok(public.can_access_artist('a1111111-1111-4111-8111-111111111111'),
          'read-only membership grants viewing');
select ok(not public.can_manage_artist('a1111111-1111-4111-8111-111111111111'),
          'read-only global role cannot manage the artist');
select ok(not public.can_view_artist_finance('a1111111-1111-4111-8111-111111111111'),
          'read-only profile cannot view artist finance');
reset role;

set local role authenticated;
select pg_temp.claims('{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated"}');
select is((select count(*)::int from public.artists), 0,
          'disabled profile sees no artists despite an active membership row');
select is((select count(*)::int from public.artist_memberships), 0,
          'disabled profile cannot read even its membership');
select ok(not public.can_access_artist('a2222222-2222-4222-8222-222222222222'),
          'disabled profile has no effective artist access');
reset role;

-- ---------------------------------------------------------------------------
-- Mirror follows membership state
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.artist_memberships
set is_active = false
where profile_id = '22222222-2222-4222-8222-222222222222'
  and artist_id = 'a2222222-2222-4222-8222-222222222222';

select is(
  (select is_active from crm_private.artist_access
   where profile_id = '22222222-2222-4222-8222-222222222222'
     and artist_id = 'a2222222-2222-4222-8222-222222222222'),
  false,
  'deactivating a membership immediately updates the private mirror'
);

set local role authenticated;
select pg_temp.claims('{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}');
select is((select count(*)::int from public.list_accessible_artists()), 0,
          'a deactivated membership immediately removes artist access');
select ok(not public.can_manage_artist_sessions('a2222222-2222-4222-8222-222222222222'),
          'a deactivated membership removes its session capability');
reset role;

select * from finish(true);
rollback;
