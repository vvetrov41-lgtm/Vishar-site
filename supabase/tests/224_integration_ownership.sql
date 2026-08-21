-- 224_integration_ownership.sql
--
-- Migration 0076: workspace-owned integrations, explicit assignment, and the
-- personal-vs-studio route choice.
--
-- The properties worth proving are the ones a shared provider account puts at
-- risk. A studio Gmail that everybody can quietly use is how one artist ends
-- up replying from another artist's inbox, so:
--
--   * an assignment is a row somebody wrote, never an organization-wide rule;
--   * an account cannot cross a workspace boundary even if both ids are named;
--   * choosing a studio route requires an assignment, not just workspace power;
--   * withdrawing an assignment takes the route with it;
--   * changing one artist's route changes nothing for the artist beside them.
--
-- Everything is synthetic and rolled back.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- ACL and hardening
-- ---------------------------------------------------------------------------

select ok(
  not has_table_privilege('authenticated', 'public.workspace_integrations', 'SELECT')
  and not has_table_privilege('authenticated', 'public.integration_assignments', 'SELECT')
  and not has_table_privilege('authenticated', 'public.artist_integration_routes', 'SELECT'),
  'a browser session reads integrations through the status function, never the tables'
);
select ok(
  not has_table_privilege('anon', 'public.workspace_integrations', 'SELECT'),
  'anon cannot see workspace integrations'
);
select ok(
  (select bool_and(relrowsecurity and relforcerowsecurity)
   from pg_class where oid in ('public.workspace_integrations'::regclass,
                               'public.integration_assignments'::regclass,
                               'public.artist_integration_routes'::regclass)),
  'row level security is enabled and forced on all three new tables'
);
select ok(
  not has_function_privilege('service_role', 'public.assign_workspace_integration(uuid,uuid,text,boolean)', 'EXECUTE'),
  'the Worker credential cannot assign a studio account to an artist'
);
select ok(
  (select bool_and(p.prosecdef and 'search_path=pg_catalog, public, crm_private' = any (p.proconfig))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('configure_workspace_integration', 'assign_workspace_integration',
                       'select_artist_integration_route', 'list_integration_status')),
  'every new entry point is SECURITY DEFINER with a pinned search_path'
);

-- The status contract must not publish a configuration blob. Even with the
-- credential guard on the column, the column that is never returned is the one
-- that can never leak.
select ok(
  not exists (
    select 1
    from unnest(string_to_array(
      pg_get_function_result('public.list_integration_status()'::regprocedure), ',')) col
    where col ilike '%configuration%'
  ),
  'list_integration_status returns no configuration column'
);

-- ---------------------------------------------------------------------------
-- Fixtures: Example Studio with Alice and Bob, plus a rival workspace
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('e1000000-0000-4000-8000-000000000001', 'ig.admin@example.test'),
  ('e1000000-0000-4000-8000-000000000002', 'ig.alice@example.test'),
  ('e1000000-0000-4000-8000-000000000003', 'ig.bob@example.test'),
  ('e1000000-0000-4000-8000-000000000004', 'ig.rival@example.test');

insert into public.profiles (id, email, role, is_active) values
  ('e1000000-0000-4000-8000-000000000001', 'ig.admin@example.test', 'booking_manager', true),
  ('e1000000-0000-4000-8000-000000000002', 'ig.alice@example.test', 'booking_manager', true),
  ('e1000000-0000-4000-8000-000000000003', 'ig.bob@example.test', 'booking_manager', true),
  ('e1000000-0000-4000-8000-000000000004', 'ig.rival@example.test', 'booking_manager', true);

insert into public.workspaces (id, slug, display_name, workspace_type) values
  ('e2000000-0000-4000-8000-000000000001', 'ig-studio', 'Example Studio', 'studio'),
  ('e2000000-0000-4000-8000-000000000002', 'ig-rival', 'Rival Studio', 'studio');

insert into public.artists (id, slug, display_name, workspace_id, is_active) values
  ('e3000000-0000-4000-8000-00000000000a', 'ig-alice', 'Alice',
   'e2000000-0000-4000-8000-000000000001', true),
  ('e3000000-0000-4000-8000-00000000000b', 'ig-bob', 'Bob',
   'e2000000-0000-4000-8000-000000000001', true),
  ('e3000000-0000-4000-8000-00000000000c', 'ig-carol', 'Carol',
   'e2000000-0000-4000-8000-000000000002', true);

insert into public.workspace_memberships
  (profile_id, workspace_id, workspace_role, can_manage_workspace,
   can_manage_team, can_manage_integrations, is_active)
values
  ('e1000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001',
   'admin', true, true, true, true),
  ('e1000000-0000-4000-8000-000000000004', 'e2000000-0000-4000-8000-000000000002',
   'admin', true, true, true, true);

-- Alice and Bob each run their own scope, including their own integrations.
-- The admin also holds artist memberships so that the *assignment* right can
-- be tested separately from the *access* right.
insert into public.artist_memberships
  (profile_id, artist_id, access_level, can_manage_sessions,
   can_manage_integrations, is_active)
values
  ('e1000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-00000000000a',
   'artist', true, true, true),
  ('e1000000-0000-4000-8000-000000000003', 'e3000000-0000-4000-8000-00000000000b',
   'artist', true, true, true),
  ('e1000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-00000000000a',
   'manager', true, true, true),
  ('e1000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-00000000000b',
   'manager', true, true, true);

-- Personal Gmail accounts, created through the existing artist-owned path.
-- The studio Gmail is seeded with a known id. A browser session cannot select
-- from workspace_integrations at all - that is the design - so the tests below
-- reference the id directly rather than through a sub-select that would
-- silently resolve to NULL under RLS.
insert into public.workspace_integrations
  (id, workspace_id, integration_type, provider, integration_key,
   external_account_label, is_enabled)
values
  ('e5000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001',
   'email', 'google', 'ig-studio-gmail', 'studio@example.test', true);

insert into public.artist_integrations
  (id, artist_id, integration_type, provider, integration_key, is_enabled)
values
  ('e4000000-0000-4000-8000-00000000000a', 'e3000000-0000-4000-8000-00000000000a',
   'email', 'google', 'ig-alice-gmail', true),
  ('e4000000-0000-4000-8000-00000000000b', 'e3000000-0000-4000-8000-00000000000b',
   'email', 'google', 'ig-bob-gmail', true);

create function pg_temp.ig_as(p uuid) returns void language sql as
  $$select set_config('request.jwt.claims',
      json_build_object('sub', p, 'role', 'authenticated')::text, true)::void$$;
grant execute on function pg_temp.ig_as(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Credentials still cannot be stored
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.workspace_integrations
      (workspace_id, integration_type, provider, integration_key, configuration)
    values ('e2000000-0000-4000-8000-000000000001', 'email', 'google',
            'ig-studio-gmail-bad',
            '{"refresh_token":"1//0abcdefghijklmnopqrstuvwxyz"}'::jsonb)$$,
  '23514', null,
  'a workspace integration cannot store a credential key, exactly like an artist one'
);
select throws_ok(
  $$insert into public.workspace_integrations
      (workspace_id, integration_type, provider, integration_key)
    values ('e2000000-0000-4000-8000-000000000001', 'email', 'google',
            'ig-rival-gmail')$$,
  '23514', null,
  'a workspace integration key must sit inside its own workspace namespace'
);

-- ---------------------------------------------------------------------------
-- The studio connects a shared Gmail
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.ig_as('e1000000-0000-4000-8000-000000000001');

select lives_ok(
  $$select public.configure_workspace_integration(
      'e2000000-0000-4000-8000-000000000001'::uuid,
      'calendar'::public.artist_integration_type,
      'google', 'ig-studio-calendar', 'studio@example.test', '{}'::jsonb, true)$$,
  'a workspace admin with integration management may connect a studio account'
);
reset role;

set local role authenticated;
select pg_temp.ig_as('e1000000-0000-4000-8000-000000000002');
select throws_ok(
  $$select public.configure_workspace_integration(
      'e2000000-0000-4000-8000-000000000001'::uuid,
      'whatsapp'::public.artist_integration_type,
      'meta_cloud_api', 'ig-studio-whatsapp', null, '{}'::jsonb, true)$$,
  '42501', null,
  'an artist who is not a workspace admin cannot connect a studio account'
);
reset role;

-- ---------------------------------------------------------------------------
-- Assignment is explicit, and only inside the workspace
-- ---------------------------------------------------------------------------

select ok(
  not exists (select 1 from public.integration_assignments),
  'connecting a studio account assigns it to nobody'
);

set local role authenticated;
select pg_temp.ig_as('e1000000-0000-4000-8000-000000000001');
select lives_ok(
  $$select public.assign_workspace_integration(
      'e5000000-0000-4000-8000-000000000001'::uuid,
      'e3000000-0000-4000-8000-00000000000a'::uuid)$$,
  'the studio account can be assigned to Alice'
);
select throws_ok(
  $$select public.assign_workspace_integration(
      'e5000000-0000-4000-8000-000000000001'::uuid,
      'e3000000-0000-4000-8000-00000000000c'::uuid)$$,
  '42501', null,
  'the studio account cannot be assigned to an artist in another workspace'
);
reset role;

-- The trigger is the real boundary: even a direct insert that names both ids
-- cannot cross a workspace.
select throws_ok(
  $$insert into public.integration_assignments (workspace_integration_id, artist_id)
    values ('e5000000-0000-4000-8000-000000000001',
            'e3000000-0000-4000-8000-00000000000c')$$,
  '23514', null,
  'a cross-workspace assignment is refused at the table, not only at the RPC'
);

set local role authenticated;
select pg_temp.ig_as('e1000000-0000-4000-8000-000000000004');
select throws_ok(
  $$select public.assign_workspace_integration(
      'e5000000-0000-4000-8000-000000000001'::uuid,
      'e3000000-0000-4000-8000-00000000000a'::uuid)$$,
  '42501', null,
  'the rival studio admin cannot assign an account it does not own'
);
reset role;

-- ---------------------------------------------------------------------------
-- Route selection: personal for Bob, studio for Alice (brief section 80)
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.ig_as('e1000000-0000-4000-8000-000000000002');
select lives_ok(
  $$select public.select_artist_integration_route(
      'e3000000-0000-4000-8000-00000000000a'::uuid,
      'email'::public.artist_integration_type,
      'workspace'::public.integration_route_kind,
      null,
      'e5000000-0000-4000-8000-000000000001'::uuid)$$,
  'Alice routes her email through the assigned studio account'
);
reset role;

set local role authenticated;
select pg_temp.ig_as('e1000000-0000-4000-8000-000000000003');
select throws_ok(
  $$select public.select_artist_integration_route(
      'e3000000-0000-4000-8000-00000000000b'::uuid,
      'email'::public.artist_integration_type,
      'workspace'::public.integration_route_kind,
      null,
      'e5000000-0000-4000-8000-000000000001'::uuid)$$,
  '23514', null,
  'Bob cannot route through the studio account, because nobody assigned it to him'
);
select lives_ok(
  $$select public.select_artist_integration_route(
      'e3000000-0000-4000-8000-00000000000b'::uuid,
      'email'::public.artist_integration_type,
      'artist'::public.integration_route_kind,
      'e4000000-0000-4000-8000-00000000000b'::uuid,
      null)$$,
  'Bob routes his email through his own Gmail'
);
select throws_ok(
  $$select public.select_artist_integration_route(
      'e3000000-0000-4000-8000-00000000000b'::uuid,
      'email'::public.artist_integration_type,
      'artist'::public.integration_route_kind,
      'e4000000-0000-4000-8000-00000000000a'::uuid,
      null)$$,
  '23514', null,
  'Bob cannot point his route at Alice''s personal Gmail'
);
select throws_ok(
  $$select public.select_artist_integration_route(
      'e3000000-0000-4000-8000-00000000000b'::uuid,
      'telegram'::public.artist_integration_type,
      'artist'::public.integration_route_kind,
      'e4000000-0000-4000-8000-00000000000b'::uuid,
      null)$$,
  '23514', null,
  'a route cannot claim a channel the integration does not serve'
);
reset role;

select is(
  (select route_kind::text from public.artist_integration_routes
   where artist_id = 'e3000000-0000-4000-8000-00000000000a'),
  'workspace',
  'Alice''s email still goes through the studio after Bob chose his own'
);
select is(
  (select route_kind::text from public.artist_integration_routes
   where artist_id = 'e3000000-0000-4000-8000-00000000000b'),
  'artist',
  'Bob''s email still goes through his own account'
);

-- A route names exactly one connection; a half-specified row is not something
-- the delivery path should ever have to interpret.
select throws_ok(
  $$insert into public.artist_integration_routes
      (artist_id, integration_type, route_kind, artist_integration_id, workspace_integration_id)
    values ('e3000000-0000-4000-8000-00000000000b', 'email', 'artist',
            'e4000000-0000-4000-8000-00000000000b',
            'e5000000-0000-4000-8000-000000000001')$$,
  '23514', null,
  'a route cannot name both a personal and a studio connection'
);

-- ---------------------------------------------------------------------------
-- Withdrawing an assignment withdraws the route
-- ---------------------------------------------------------------------------

update public.integration_assignments set is_active = false
where artist_id = 'e3000000-0000-4000-8000-00000000000a';

select ok(
  not exists (
    select 1 from public.artist_integration_routes
    where artist_id = 'e3000000-0000-4000-8000-00000000000a'
  ),
  'deactivating the assignment removes Alice''s studio route rather than leaving it dangling'
);
select is(
  (select count(*)::int from public.artist_integration_routes
   where artist_id = 'e3000000-0000-4000-8000-00000000000b'),
  1,
  'Bob''s unrelated personal route is untouched'
);

-- ---------------------------------------------------------------------------
-- The dashboard read is scoped, and carries no secret
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.ig_as('e1000000-0000-4000-8000-000000000003');
select ok(
  not exists (
    select 1 from public.list_integration_status()
    where owner_kind = 'artist' and owner_id = 'e3000000-0000-4000-8000-00000000000a'
  ),
  'Bob does not see Alice''s personal integration'
);
select ok(
  not exists (select 1 from public.list_integration_status() where owner_kind = 'workspace'),
  'Bob, who is in no workspace, sees no studio integration at all'
);
select ok(
  exists (
    select 1 from public.list_integration_status()
    where owner_kind = 'artist' and owner_id = 'e3000000-0000-4000-8000-00000000000b'
      and integration_type = 'email' and is_selected_route
  ),
  'Bob sees his own account and that it is the selected route'
);
reset role;

set local role authenticated;
select pg_temp.ig_as('e1000000-0000-4000-8000-000000000004');
select ok(
  not exists (
    select 1 from public.list_integration_status()
    where owner_id = 'e2000000-0000-4000-8000-000000000001'
  ),
  'the rival studio admin sees nothing belonging to Example Studio'
);
reset role;

select * from finish(true);
rollback;
