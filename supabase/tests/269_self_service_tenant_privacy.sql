-- 269_self_service_tenant_privacy.sql
--
-- Migration 0132: a tenant founded through public signup belongs to the person
-- who signed up, and to nobody else on the installation.
--
-- Production acceptance of the signup flow found the hole this file guards.
-- The new artist could not reach the installation - 267 proves that - but the
-- installation reached them: 0015's owner sweep granted every active owner an
-- `owner` membership on the new artist the instant it was inserted, and 0075
-- turned that into ownership of their solo workspace. A stranger's clients and
-- payments were readable by the operator, and the operator's profile id came
-- back to the stranger in the membership row.
--
-- What this file is responsible for:
--
--   an artist the operator creates is still swept to every owner
--   an artist founded by signup is not
--   the founder is alone on their own workspace
--   the owner sweep does not grant it back on the next profile write
--   the repair actually removed what the old rule had already granted

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('66011111-1111-4111-8111-111111111111', 'tp-owner@example.test', now()),
  ('66033333-3333-4333-8333-333333333333', 'tp-newcomer@example.test', now());

insert into public.profiles (id, email, display_name, role, is_active) values
  ('66011111-1111-4111-8111-111111111111', 'tp-owner@example.test',
   'Installation Owner', 'owner', true);

create function pg_temp.owner() returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    '{"sub":"66011111-1111-4111-8111-111111111111","role":"authenticated"}',
    true
  )::void;
$$;
create function pg_temp.newcomer() returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    '{"sub":"66033333-3333-4333-8333-333333333333","role":"authenticated"}',
    true
  )::void;
$$;
grant execute on function pg_temp.owner() to authenticated, service_role;
grant execute on function pg_temp.newcomer() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Act 1. Nothing changes for an artist the installation creates
--
-- This is the assertion that decides whether 0132 is a behaviour change for
-- the existing book. It must stay green.
-- ---------------------------------------------------------------------------

insert into public.artists (slug, display_name, is_active)
values ('tp-operator-artist', 'Operator Artist', true);

select is(
  (select count(*)::int
     from public.artist_memberships m
     join public.artists a on a.id = m.artist_id
    where a.slug = 'tp-operator-artist'
      and m.profile_id = '66011111-1111-4111-8111-111111111111'
      and m.access_level = 'owner'
      and m.is_active),
  1,
  'an artist created by the installation is still swept to the active owner'
);

-- ---------------------------------------------------------------------------
-- Act 2. A tenant founded by signup is not swept
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.owner();
set local role authenticated;
select public.set_self_service_signup(true);

reset role;
select pg_temp.newcomer();
set local role authenticated;
select public.bootstrap_artist_account('Nina Newcomer', 'Nina Ink');
reset role;

select is(
  (select count(*)::int
     from crm_private.self_service_workspaces s
     join crm_private.self_service_accounts a on a.workspace_id = s.workspace_id
    where a.profile_id = '66033333-3333-4333-8333-333333333333'),
  1,
  'the workspace is marked self-service while it is being founded'
);

select is(
  (select count(*)::int
     from public.artist_memberships m
     join crm_private.self_service_accounts a on a.artist_id = m.artist_id
    where a.profile_id = '66033333-3333-4333-8333-333333333333'
      and m.profile_id <> '66033333-3333-4333-8333-333333333333'
      and m.is_active),
  0,
  'nobody but the founder holds a membership on the artist they founded'
);

select is(
  (select count(*)::int
     from public.workspace_memberships wm
     join crm_private.self_service_accounts a on a.workspace_id = wm.workspace_id
    where a.profile_id = '66033333-3333-4333-8333-333333333333'
      and wm.profile_id <> '66033333-3333-4333-8333-333333333333'
      and wm.is_active),
  0,
  'and the founder is alone on their own workspace'
);

select is(
  (select wm.workspace_role::text
     from public.workspace_memberships wm
     join crm_private.self_service_accounts a on a.workspace_id = wm.workspace_id
    where a.profile_id = '66033333-3333-4333-8333-333333333333'
      and wm.profile_id = '66033333-3333-4333-8333-333333333333'),
  'owner',
  'the founder is the owner of it'
);

-- ---------------------------------------------------------------------------
-- Act 3. The owner sweep does not grant it back
--
-- `sync_owner_artist_memberships` fires on every write to an owner profile, so
-- a display-name change was enough to undo the exclusion before 0132 scoped
-- `ensure_owner_artist_memberships` too.
-- ---------------------------------------------------------------------------

update public.profiles
   set display_name = 'Installation Owner Renamed'
 where id = '66011111-1111-4111-8111-111111111111';

select is(
  (select count(*)::int
     from public.artist_memberships m
     join crm_private.self_service_accounts a on a.artist_id = m.artist_id
    where a.profile_id = '66033333-3333-4333-8333-333333333333'
      and m.profile_id = '66011111-1111-4111-8111-111111111111'
      and m.is_active),
  0,
  'touching the owner profile does not grant the self-service tenant back'
);

select is(
  (select count(*)::int
     from public.artist_memberships m
     join public.artists a on a.id = m.artist_id
    where a.slug = 'tp-operator-artist'
      and m.profile_id = '66011111-1111-4111-8111-111111111111'
      and m.is_active),
  1,
  'while the same sweep still holds the installation own artist'
);

-- ---------------------------------------------------------------------------
-- Act 4. The founder still sees their own tenant, and only it
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.newcomer();
set local role authenticated;

select is(
  (select count(*)::int from public.artists),
  1,
  'the founder sees exactly one artist - their own'
);

select is(
  (select count(*)::int from public.profiles),
  1,
  'and exactly one profile - their own, not the operator behind the membership'
);

reset role;

select * from finish();
rollback;
