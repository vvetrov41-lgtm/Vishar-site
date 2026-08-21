-- 222_capability_registry.sql
--
-- Migration 0074: the canonical capability registry.
--
-- The point of this file is not that the new capability names exist. It is
-- that adding them changed nothing about what the six legacy names decide.
-- Those six are embedded in live RLS policies and in RPC bodies that are
-- deployed right now, so every combination of (global role x access level x
-- capability flag) is pinned here explicitly rather than sampled.
--
-- Everything is synthetic and rolled back.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Shape and ACL
-- ---------------------------------------------------------------------------

select has_table('public', 'capability_registry', 'the capability registry exists');

select ok(
  not has_table_privilege('anon', 'public.capability_registry', 'SELECT'),
  'the registry is not readable by anon'
);
select ok(
  has_table_privilege('authenticated', 'public.capability_registry', 'SELECT'),
  'a signed-in CRM session may enumerate the vocabulary'
);
select ok(
  not has_table_privilege('authenticated', 'public.capability_registry', 'INSERT')
  and not has_table_privilege('authenticated', 'public.capability_registry', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.capability_registry', 'DELETE'),
  'no browser session can add, edit or remove a capability'
);
select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_class where oid = 'public.capability_registry'::regclass),
  'row level security is enabled and forced on the registry'
);

select ok(
  not has_function_privilege('anon', 'public.list_capabilities(uuid)', 'EXECUTE'),
  'anon cannot enumerate capabilities'
);
select ok(
  not has_function_privilege('service_role', 'public.list_capabilities(uuid)', 'EXECUTE'),
  'the Worker credential has no use for a browser capability list and is not granted it'
);

-- Every capability the resolver can answer for is registered, and every
-- registered capability is one the resolver knows. A name in one list and not
-- the other is how a permission system starts to drift.
select is(
  (select count(*)::int from public.capability_registry
   where capability in ('view', 'manage', 'view_finance', 'manage_finance',
                        'manage_sessions', 'manage_integrations')),
  6,
  'the six legacy capability names are registered'
);
select is(
  (select count(*)::int from public.capability_registry where domain = 'legacy'),
  2,
  'only view and manage are marked legacy; the finance/session/integration names stay canonical'
);

-- ---------------------------------------------------------------------------
-- Fixtures
--
-- Two artists so that every assertion below can also prove the negative.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('c1000000-0000-4000-8000-000000000001', 'cap.owner@example.test'),
  ('c1000000-0000-4000-8000-000000000002', 'cap.artist@example.test'),
  ('c1000000-0000-4000-8000-000000000003', 'cap.manager@example.test'),
  ('c1000000-0000-4000-8000-000000000004', 'cap.readonly@example.test'),
  ('c1000000-0000-4000-8000-000000000005', 'cap.stranger@example.test');

insert into public.profiles (id, email, role, is_active) values
  ('c1000000-0000-4000-8000-000000000001', 'cap.owner@example.test', 'owner', true),
  ('c1000000-0000-4000-8000-000000000002', 'cap.artist@example.test', 'booking_manager', true),
  ('c1000000-0000-4000-8000-000000000003', 'cap.manager@example.test', 'booking_manager', true),
  ('c1000000-0000-4000-8000-000000000004', 'cap.readonly@example.test', 'read_only', true),
  ('c1000000-0000-4000-8000-000000000005', 'cap.stranger@example.test', 'booking_manager', true);

insert into public.artists (id, slug, display_name, is_active) values
  ('ca000000-0000-4000-8000-00000000000a', 'cap-alpha', 'Cap Alpha', true),
  ('ca000000-0000-4000-8000-00000000000b', 'cap-beta', 'Cap Beta', true);

-- The artist runs their own scope. The manager has sessions but no finance and
-- no integrations. The read-only account can look and nothing else. The
-- stranger holds no membership on either artist at all.
insert into public.artist_memberships
  (profile_id, artist_id, access_level, can_view_finance, can_manage_finance,
   can_manage_sessions, can_manage_integrations, is_active)
values
  ('c1000000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-00000000000a',
   'artist', true, true, true, true, true),
  ('c1000000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-00000000000a',
   'manager', false, false, true, false, true),
  ('c1000000-0000-4000-8000-000000000004', 'ca000000-0000-4000-8000-00000000000a',
   'read_only', false, false, false, false, true);

create function pg_temp.as_profile(p uuid) returns void language sql as
  $$select set_config('request.jwt.claims',
      json_build_object('sub', p, 'role', 'authenticated')::text, true)::void$$;
grant execute on function pg_temp.as_profile(uuid) to authenticated;

create function pg_temp.cap(p uuid, a uuid, c text) returns boolean
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p, 'role', 'authenticated')::text, true);
  return crm_private.has_artist_capability(a, c);
end;
$$;

-- ---------------------------------------------------------------------------
-- The legacy six, pinned
-- ---------------------------------------------------------------------------

select ok(pg_temp.cap('c1000000-0000-4000-8000-000000000002',
                      'ca000000-0000-4000-8000-00000000000a', 'view'),
          'legacy view: an artist-level membership can read its own scope');
select ok(pg_temp.cap('c1000000-0000-4000-8000-000000000004',
                      'ca000000-0000-4000-8000-00000000000a', 'view'),
          'legacy view: a read-only membership can still read');
select ok(not pg_temp.cap('c1000000-0000-4000-8000-000000000005',
                          'ca000000-0000-4000-8000-00000000000a', 'view'),
          'legacy view: no membership means no read, whatever the global role says');

select ok(pg_temp.cap('c1000000-0000-4000-8000-000000000003',
                      'ca000000-0000-4000-8000-00000000000a', 'manage'),
          'legacy manage: a manager membership can write');
select ok(not pg_temp.cap('c1000000-0000-4000-8000-000000000004',
                          'ca000000-0000-4000-8000-00000000000a', 'manage'),
          'legacy manage: a read_only access level cannot write');

select ok(pg_temp.cap('c1000000-0000-4000-8000-000000000002',
                      'ca000000-0000-4000-8000-00000000000a', 'view_finance'),
          'legacy view_finance: honoured through the membership flag');
select ok(not pg_temp.cap('c1000000-0000-4000-8000-000000000003',
                          'ca000000-0000-4000-8000-00000000000a', 'view_finance'),
          'legacy view_finance: a manager without the flag sees no finance');
select ok(not pg_temp.cap('c1000000-0000-4000-8000-000000000003',
                          'ca000000-0000-4000-8000-00000000000a', 'manage_finance'),
          'legacy manage_finance: a manager without the flag cannot move money');
select ok(pg_temp.cap('c1000000-0000-4000-8000-000000000003',
                      'ca000000-0000-4000-8000-00000000000a', 'manage_sessions'),
          'legacy manage_sessions: honoured through the membership flag');
select ok(not pg_temp.cap('c1000000-0000-4000-8000-000000000003',
                          'ca000000-0000-4000-8000-00000000000a', 'manage_integrations'),
          'legacy manage_integrations: a manager without the flag cannot touch providers');
select ok(pg_temp.cap('c1000000-0000-4000-8000-000000000002',
                      'ca000000-0000-4000-8000-00000000000a', 'manage_integrations'),
          'legacy manage_integrations: honoured through the membership flag');

-- ---------------------------------------------------------------------------
-- The new names decide from the same facts
-- ---------------------------------------------------------------------------

select ok(pg_temp.cap('c1000000-0000-4000-8000-000000000004',
                      'ca000000-0000-4000-8000-00000000000a', 'view_enquiries'),
          'a read-only membership can read enquiries');
select ok(not pg_temp.cap('c1000000-0000-4000-8000-000000000004',
                          'ca000000-0000-4000-8000-00000000000a', 'manage_enquiries'),
          'a read-only membership cannot edit enquiries');
select ok(pg_temp.cap('c1000000-0000-4000-8000-000000000003',
                      'ca000000-0000-4000-8000-00000000000a', 'send_communications'),
          'a manager may reply to a client');
select ok(not pg_temp.cap('c1000000-0000-4000-8000-000000000004',
                          'ca000000-0000-4000-8000-00000000000a', 'send_communications'),
          'a read-only membership may not reply to a client');

-- Booking sources and automations decide the outside world, so they follow the
-- integrations right rather than the general write right.
select ok(not pg_temp.cap('c1000000-0000-4000-8000-000000000003',
                          'ca000000-0000-4000-8000-00000000000a', 'manage_booking_sources'),
          'a manager who cannot manage integrations cannot create a booking form');
select ok(not pg_temp.cap('c1000000-0000-4000-8000-000000000003',
                          'ca000000-0000-4000-8000-00000000000a', 'manage_automations'),
          'a manager who cannot manage integrations cannot write an automation');
select ok(pg_temp.cap('c1000000-0000-4000-8000-000000000002',
                      'ca000000-0000-4000-8000-00000000000a', 'manage_booking_sources'),
          'the artist can create their own booking form');

-- Inviting people is the artist's own right and is not implied by managing
-- integrations, sessions or finance.
select ok(pg_temp.cap('c1000000-0000-4000-8000-000000000002',
                      'ca000000-0000-4000-8000-00000000000a', 'manage_team'),
          'an artist-level membership may build its own team');
select ok(not pg_temp.cap('c1000000-0000-4000-8000-000000000003',
                          'ca000000-0000-4000-8000-00000000000a', 'manage_team'),
          'a manager membership cannot invite further managers');

-- ---------------------------------------------------------------------------
-- Cross-artist denial (brief section 71)
-- ---------------------------------------------------------------------------

select ok(
  (select bool_and(not pg_temp.cap('c1000000-0000-4000-8000-000000000002',
                                   'ca000000-0000-4000-8000-00000000000b', r.capability))
   from public.capability_registry r),
  'an artist with a full membership on Alpha holds no capability at all on Beta'
);
select ok(
  (select bool_and(not pg_temp.cap('c1000000-0000-4000-8000-000000000005',
                                   'ca000000-0000-4000-8000-00000000000a', r.capability))
   from public.capability_registry r),
  'a booking_manager with no membership holds no capability on either artist'
);

-- ---------------------------------------------------------------------------
-- Unknown capabilities are a programming error, not a quiet denial
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select crm_private.require_artist_access(
      'ca000000-0000-4000-8000-00000000000a', 'invent_a_capability')$$,
  '22023', null,
  'an unregistered capability name is rejected rather than treated as denied'
);
select throws_ok(
  $$select crm_private.require_artist_access(null, 'view')$$,
  '22023', null,
  'a null artist is rejected'
);
select throws_ok(
  $$select crm_private.require_artist_access(
      'ca000000-0000-4000-8000-00000000000b', 'view')$$,
  '42501', null,
  'an artist the caller has no membership on is refused'
);

-- ---------------------------------------------------------------------------
-- The shared read surface reports the caller and nobody else
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.as_profile('c1000000-0000-4000-8000-000000000003');

select ok(
  not exists (
    select 1 from public.list_capabilities()
    where artist_id = 'ca000000-0000-4000-8000-00000000000b'
  ),
  'list_capabilities never reports an artist the caller cannot reach'
);
select ok(
  exists (
    select 1 from public.list_capabilities('ca000000-0000-4000-8000-00000000000a')
    where capability = 'manage_sessions'
  ),
  'list_capabilities reports a capability the caller actually holds'
);
select ok(
  not exists (
    select 1 from public.list_capabilities('ca000000-0000-4000-8000-00000000000a')
    where capability in ('manage_finance', 'manage_integrations', 'manage_team')
  ),
  'list_capabilities does not report finance, integrations or team to a plain manager'
);
select ok(
  not exists (select 1 from public.list_capabilities() where capability in ('view', 'manage')),
  'the legacy vocabulary is not published to product surfaces'
);

reset role;

-- ---------------------------------------------------------------------------
-- Membership provenance
-- ---------------------------------------------------------------------------

select ok(
  (select bool_and(grant_source = 'owner_sync')
   from public.artist_memberships
   where profile_id = 'c1000000-0000-4000-8000-000000000001'),
  'memberships synthesised for a global owner are marked owner_sync, not explicit'
);
select is(
  (select grant_source from public.artist_memberships
   where profile_id = 'c1000000-0000-4000-8000-000000000003'
     and artist_id = 'ca000000-0000-4000-8000-00000000000a'),
  'explicit',
  'a deliberately created membership stays marked explicit'
);

select * from finish(true);
rollback;
