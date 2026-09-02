-- 268_self_service_directory_and_cap.sql
--
-- The two holes migration 0131 closes, each pinned from the side that could
-- actually exploit it.
--
-- Both existed because 0130 changed a premise without changing what rested on
-- it. `can_browse_directory()` and the founder cap were both written for a
-- world where every artist membership came from an invitation.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('56011111-1111-4111-8111-111111111111', 'dir-owner@example.test', now()),
  ('56022222-2222-4222-8222-222222222222', 'dir-incumbent@example.test', now()),
  ('56033333-3333-4333-8333-333333333333', 'dir-stranger@example.test', now()),
  ('56044444-4444-4444-8444-444444444444', 'dir-colleague@example.test', now());

insert into public.profiles (id, email, display_name, role, is_active) values
  ('56011111-1111-4111-8111-111111111111', 'dir-owner@example.test',
   'Installation Owner', 'owner', true),
  ('56022222-2222-4222-8222-222222222222', 'dir-incumbent@example.test',
   'Incumbent Artist', 'booking_manager', true),
  ('56044444-4444-4444-8444-444444444444', 'dir-colleague@example.test',
   'Invited Colleague', 'booking_manager', true);

-- The incumbent runs the artist the migrations create, by invitation.
insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('56022222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111',
   'artist', true, true, true, true, true);

create function pg_temp.owner() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"56011111-1111-4111-8111-111111111111","role":"authenticated"}', true)::void;
$$;
create function pg_temp.incumbent() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"56022222-2222-4222-8222-222222222222","role":"authenticated"}', true)::void;
$$;
create function pg_temp.stranger() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"56033333-3333-4333-8333-333333333333","role":"authenticated"}', true)::void;
$$;
grant execute on function pg_temp.owner() to authenticated, service_role;
grant execute on function pg_temp.incumbent() to authenticated, service_role;
grant execute on function pg_temp.stranger() to authenticated, service_role;

reset role;
select pg_temp.owner();
set local role authenticated;
select public.set_self_service_signup(true, 20, 1);

reset role;
select pg_temp.stranger();
set local role authenticated;
select public.bootstrap_artist_account('Directory Stranger', 'Stranger Studio');

-- ---------------------------------------------------------------------------
-- Act 1. The address book stops at the tenant boundary
--
-- The regression this file exists for. Before 0131 this returned every active
-- profile in the installation - name, email address and role - to somebody who
-- had done nothing but confirm an email address.
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from public.list_directory_profiles()),
  1,
  'a self-service account sees exactly one person in the directory: itself'
);

select is(
  (select d.display_name from public.list_directory_profiles() d),
  'Directory Stranger',
  'and that person is them'
);

select is(
  (select count(*)::int from public.list_directory_profiles() d
    where d.id in ('56011111-1111-4111-8111-111111111111',
                   '56022222-2222-4222-8222-222222222222',
                   '56044444-4444-4444-8444-444444444444')),
  0,
  'the installation owner, the incumbent artist and an invited colleague are all absent'
);

-- ---------------------------------------------------------------------------
-- Act 2. Somebody actually on their artist does appear
--
-- Scoped, not closed. The picker still works for the people a self-service
-- tenant legitimately has.
-- ---------------------------------------------------------------------------

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
)
select '56044444-4444-4444-8444-444444444444', s.artist_id,
       'manager', false, false, true, false, true
from crm_private.self_service_accounts s
where s.profile_id = '56033333-3333-4333-8333-333333333333';

reset role;
select pg_temp.stranger();
set local role authenticated;

select is(
  (select count(*)::int from public.list_directory_profiles()),
  2,
  'once somebody is on their artist, that person appears in their directory'
);
select is(
  (select count(*)::int from public.list_directory_profiles() d
    where d.id = '56044444-4444-4444-8444-444444444444'),
  1,
  'and it is the colleague who is actually on it'
);
select is(
  (select count(*)::int from public.list_directory_profiles() d
    where d.id = '56022222-2222-4222-8222-222222222222'),
  0,
  'the incumbent artist, who shares nothing with them, still is not'
);

-- ---------------------------------------------------------------------------
-- Act 3. An invited account's directory is untouched
--
-- The scoping applies to the ledger and to nothing else. 0089's behaviour for
-- everybody who arrived by invitation has to be exactly what it was.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.incumbent();
set local role authenticated;

-- Four active people exist by now: the owner, the incumbent, the invited
-- colleague and the self-service stranger. Counted literally rather than from
-- public.profiles, because that table is itself RLS-scoped to the reader - the
-- incumbent can only see their own row - and comparing one scoped read against
-- another would prove nothing.
select is(
  (select count(*)::int from public.list_directory_profiles()),
  4,
  'an invited artist still sees every active person, as before 0130'
);
select is(
  (select count(*)::int from public.list_directory_profiles() d
    where d.id = '56033333-3333-4333-8333-333333333333'),
  1,
  'including the self-service account, which is not hidden from anybody'
);

reset role;
select pg_temp.owner();
set local role authenticated;

select is(
  (select count(*)::int from public.list_directory_profiles()),
  4,
  'and so does the installation owner'
);

-- ---------------------------------------------------------------------------
-- Act 4. Deactivating your own organization does not reclaim the allowance
--
-- The cap is 1, and they hold one. Before 0131, switching it off made the
-- count zero while leaving the owner membership row - which 0089 refuses to
-- write over - fully intact, so the cap bounded nothing at all.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.stranger();
set local role authenticated;

select throws_ok(
  $$select public.create_workspace('Second Studio', 'studio')$$,
  '42501', null,
  'at the allowance, a self-service founder cannot found another organization'
);

-- Both are theirs to switch off, and both succeed. That is not the bug; the
-- bug was what switching them off did to the count.
--
-- The ids come from what this session can itself read - exactly one artist and
-- one organization are visible to it - rather than from the ledger, which is
-- unreadable from an API role and rightly so.
select lives_ok(
  $$select public.update_artist(
      (select a.id from public.artists a), null, null, null, false)$$,
  'they may deactivate their own artist'
);
select lives_ok(
  $$select public.update_workspace(
      (select w.id from public.workspaces w), null, null, null, false)$$,
  'and their own organization'
);

select throws_ok(
  $$select public.create_workspace('Second Studio After Deactivation', 'studio')$$,
  '42501', null,
  'and still cannot found another: the allowance counts organizations, not live ones'
);

select is(
  (select (public.control_plane_access()).can_found_workspace),
  false,
  'the interface is told the same thing by the same predicate'
);

-- ---------------------------------------------------------------------------
-- Act 5. Raising the allowance is what admits the next one
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.owner();
set local role authenticated;
select public.set_self_service_signup(true, 20, 2);

reset role;
select pg_temp.stranger();
set local role authenticated;

select lives_ok(
  $$select public.create_workspace('Second Studio Allowed', 'studio')$$,
  'raising the allowance admits the next organization'
);

select * from finish();
rollback;
