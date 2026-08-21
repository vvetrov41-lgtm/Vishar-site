-- 223_workspaces.sql
--
-- Migration 0075: the organization layer.
--
-- One rule is worth more than the rest of this file put together:
--
--     a workspace membership never, on its own, produces an artist capability.
--
-- A studio admin can administer the organization without being able to read a
-- single client, enquiry, payment or provider status belonging to an artist it
-- was not deliberately given. Most of what follows exists to prove that from
-- several directions, including the direction where somebody with real
-- workspace power tries to hand themselves artist power.
--
-- Everything is synthetic and rolled back.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Backfill invariants on whatever the migration history produced
-- ---------------------------------------------------------------------------

select ok(
  not exists (select 1 from public.artists where workspace_id is null),
  'every artist created by the migration history belongs to a workspace'
);
select ok(
  (select bool_and(w.workspace_type = 'solo')
   from public.artists a join public.workspaces w on w.id = a.workspace_id),
  'the backfill produced solo workspaces, never a studio nobody asked for'
);
select ok(
  (select bool_and(c = 1)
   from (select count(*) as c from public.artists group by workspace_id) t),
  'a backfilled solo workspace contains exactly one artist'
);

-- ---------------------------------------------------------------------------
-- ACL
-- ---------------------------------------------------------------------------

select ok(
  not has_table_privilege('anon', 'public.workspaces', 'SELECT')
  and not has_table_privilege('anon', 'public.workspace_memberships', 'SELECT'),
  'anon can see neither workspaces nor who belongs to them'
);
select ok(
  not has_table_privilege('authenticated', 'public.workspaces', 'INSERT')
  and not has_table_privilege('authenticated', 'public.workspace_memberships', 'INSERT'),
  'a browser session cannot write the workspace tables directly'
);
select ok(
  (select bool_and(relrowsecurity and relforcerowsecurity)
   from pg_class where oid in ('public.workspaces'::regclass,
                               'public.workspace_memberships'::regclass)),
  'row level security is enabled and forced on both workspace tables'
);
select ok(
  (select bool_and(p.prosecdef and 'search_path=pg_catalog, public, crm_private' = any (p.proconfig))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('list_workspaces', 'upsert_workspace_membership',
                       'grant_workspace_artist_membership',
                       'can_access_workspace', 'can_manage_workspace')),
  'every workspace entry point is SECURITY DEFINER with a pinned search_path'
);
select ok(
  not has_function_privilege('service_role', 'public.grant_workspace_artist_membership(uuid,uuid,public.artist_access_level,boolean,boolean,boolean,boolean,boolean)', 'EXECUTE'),
  'the Worker credential cannot mint artist memberships'
);

-- ---------------------------------------------------------------------------
-- Fixtures: one studio with two artists, plus an unrelated workspace
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('d1000000-0000-4000-8000-000000000001', 'ws.admin@example.test'),
  ('d1000000-0000-4000-8000-000000000002', 'ws.alice@example.test'),
  ('d1000000-0000-4000-8000-000000000003', 'ws.manager@example.test'),
  ('d1000000-0000-4000-8000-000000000004', 'ws.outsider@example.test');

insert into public.profiles (id, email, role, is_active) values
  ('d1000000-0000-4000-8000-000000000001', 'ws.admin@example.test', 'booking_manager', true),
  ('d1000000-0000-4000-8000-000000000002', 'ws.alice@example.test', 'booking_manager', true),
  ('d1000000-0000-4000-8000-000000000003', 'ws.manager@example.test', 'booking_manager', true),
  ('d1000000-0000-4000-8000-000000000004', 'ws.outsider@example.test', 'booking_manager', true);

insert into public.workspaces (id, slug, display_name, workspace_type) values
  ('d2000000-0000-4000-8000-000000000001', 'ws-studio', 'Example Studio', 'studio'),
  ('d2000000-0000-4000-8000-000000000002', 'ws-rival', 'Rival Studio', 'studio');

insert into public.artists (id, slug, display_name, workspace_id, is_active) values
  ('d3000000-0000-4000-8000-00000000000a', 'ws-alice', 'Alice',
   'd2000000-0000-4000-8000-000000000001', true),
  ('d3000000-0000-4000-8000-00000000000b', 'ws-bob', 'Bob',
   'd2000000-0000-4000-8000-000000000001', true),
  ('d3000000-0000-4000-8000-00000000000c', 'ws-carol', 'Carol',
   'd2000000-0000-4000-8000-000000000002', true);

-- The admin runs Example Studio and has no artist membership anywhere.
insert into public.workspace_memberships
  (profile_id, workspace_id, workspace_role, can_manage_workspace,
   can_manage_team, can_manage_integrations, is_active)
values
  ('d1000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001',
   'admin', true, true, true, true),
  ('d1000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000002',
   'admin', true, true, true, true);

-- Alice works in the studio and runs her own scope.
insert into public.artist_memberships
  (profile_id, artist_id, access_level, can_view_finance, can_manage_finance,
   can_manage_sessions, can_manage_integrations, is_active)
values
  ('d1000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-00000000000a',
   'artist', true, true, true, true, true);

create function pg_temp.ws_as(p uuid) returns void language sql as
  $$select set_config('request.jwt.claims',
      json_build_object('sub', p, 'role', 'authenticated')::text, true)::void$$;
grant execute on function pg_temp.ws_as(uuid) to authenticated;

create function pg_temp.ws_cap(p uuid, a uuid, c text) returns boolean
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p, 'role', 'authenticated')::text, true);
  return crm_private.has_artist_capability(a, c);
end;
$$;

create function pg_temp.ws_wcap(p uuid, w uuid, c text) returns boolean
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p, 'role', 'authenticated')::text, true);
  return crm_private.has_workspace_capability(w, c);
end;
$$;

-- ---------------------------------------------------------------------------
-- Auto-provisioning
-- ---------------------------------------------------------------------------

insert into public.artists (id, slug, display_name, is_active) values
  ('d3000000-0000-4000-8000-00000000000d', 'ws-dana', 'Dana', true);

select ok(
  (select w.workspace_type = 'solo' and w.slug = 'ws-dana'
   from public.artists a join public.workspaces w on w.id = a.workspace_id
   where a.id = 'd3000000-0000-4000-8000-00000000000d'),
  'an artist created without a workspace gets its own solo workspace automatically'
);

-- The provisioning trigger must never pre-empt the artist''s own constraints,
-- or a caller handling 23514 would start seeing an error from a table it never
-- named.
select throws_ok(
  $$insert into public.artists (slug, display_name) values ('Bad-Slug', 'Bad')$$,
  '23514', null,
  'a malformed artist slug is still rejected by the artist constraint'
);
select throws_ok(
  $$insert into public.artists (slug, display_name, default_currency)
    values ('ws-badcurrency', 'Bad', 'pounds')$$,
  '23514', null,
  'a malformed artist currency is still rejected by the artist constraint'
);
select throws_ok(
  $$insert into public.artists (slug, display_name) values ('ws-alice', 'Duplicate')$$,
  '23505', null,
  'a duplicate artist slug is still a unique violation on artists'
);

-- ---------------------------------------------------------------------------
-- The rule: workspace power is not artist power (brief section 72)
-- ---------------------------------------------------------------------------

select ok(
  pg_temp.ws_wcap('d1000000-0000-4000-8000-000000000001',
                  'd2000000-0000-4000-8000-000000000001', 'manage_workspace'),
  'the studio admin really does administer its own workspace'
);
select ok(
  (select bool_and(not pg_temp.ws_cap('d1000000-0000-4000-8000-000000000001',
                                      'd3000000-0000-4000-8000-00000000000a',
                                      r.capability))
   from public.capability_registry r where r.capability <> 'manage_workspace'),
  'the studio admin holds no artist capability over Alice despite running her studio'
);
select ok(
  (select bool_and(not pg_temp.ws_cap('d1000000-0000-4000-8000-000000000001',
                                      'd3000000-0000-4000-8000-00000000000b',
                                      r.capability))
   from public.capability_registry r where r.capability <> 'manage_workspace'),
  'the same is true of Bob, who has no membership of any kind'
);

-- ---------------------------------------------------------------------------
-- Cross-workspace denial
-- ---------------------------------------------------------------------------

select ok(
  not pg_temp.ws_wcap('d1000000-0000-4000-8000-000000000001',
                      'd2000000-0000-4000-8000-000000000002', 'view'),
  'a Workspace A admin cannot even see Workspace B'
);
select ok(
  not pg_temp.ws_wcap('d1000000-0000-4000-8000-000000000004',
                      'd2000000-0000-4000-8000-000000000001', 'manage_workspace'),
  'the rival studio admin cannot administer Example Studio'
);
select ok(
  (select bool_and(not pg_temp.ws_cap('d1000000-0000-4000-8000-000000000004',
                                      'd3000000-0000-4000-8000-00000000000a',
                                      r.capability))
   from public.capability_registry r),
  'the rival studio admin holds nothing over an artist in Example Studio'
);

set local role authenticated;
select pg_temp.ws_as('d1000000-0000-4000-8000-000000000001');
select is(
  (select count(*)::int from public.list_workspaces()),
  1,
  'list_workspaces reports only the workspace the caller belongs to'
);
reset role;

-- ---------------------------------------------------------------------------
-- Granting artist access from a workspace role
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.ws_as('d1000000-0000-4000-8000-000000000001');

-- The studio admin may staff its own artists. This is a write-time expansion
-- into a real artist membership, not an inheritance rule.
select lives_ok(
  $$select public.grant_workspace_artist_membership(
      'd1000000-0000-4000-8000-000000000003'::uuid,
      'd3000000-0000-4000-8000-00000000000a'::uuid,
      'manager'::public.artist_access_level,
      false, false, true, false, true)$$,
  'a studio admin with team management may assign a manager to its own artist'
);

-- ... but never finance or integrations it does not itself hold on that artist.
select throws_ok(
  $$select public.grant_workspace_artist_membership(
      'd1000000-0000-4000-8000-000000000003'::uuid,
      'd3000000-0000-4000-8000-00000000000b'::uuid,
      'manager'::public.artist_access_level,
      true, true, false, false, true)$$,
  '42501', null,
  'a studio admin cannot hand out finance access it does not hold on that artist'
);
select throws_ok(
  $$select public.grant_workspace_artist_membership(
      'd1000000-0000-4000-8000-000000000003'::uuid,
      'd3000000-0000-4000-8000-00000000000b'::uuid,
      'manager'::public.artist_access_level,
      false, false, false, true, true)$$,
  '42501', null,
  'a studio admin cannot hand out integration management it does not hold on that artist'
);
select throws_ok(
  $$select public.grant_workspace_artist_membership(
      'd1000000-0000-4000-8000-000000000003'::uuid,
      'd3000000-0000-4000-8000-00000000000c'::uuid,
      'manager'::public.artist_access_level,
      false, false, false, false, true)$$,
  '42501', null,
  'a studio admin cannot assign anyone to an artist in another workspace'
);
select throws_ok(
  $$select public.grant_workspace_artist_membership(
      'd1000000-0000-4000-8000-000000000003'::uuid,
      'd3000000-0000-4000-8000-00000000000a'::uuid,
      'owner'::public.artist_access_level,
      false, false, false, false, true)$$,
  '42501', null,
  'an owner-level artist membership is not something a studio admin can grant'
);

reset role;

select is(
  (select grant_source from public.artist_memberships
   where profile_id = 'd1000000-0000-4000-8000-000000000003'
     and artist_id = 'd3000000-0000-4000-8000-00000000000a'),
  'workspace_grant',
  'a membership created through a workspace role is recorded as such'
);

-- The manager who was just assigned to Alice gets Alice and nothing else.
select ok(
  pg_temp.ws_cap('d1000000-0000-4000-8000-000000000003',
                 'd3000000-0000-4000-8000-00000000000a', 'manage_sessions'),
  'the assigned manager can work on Alice'
);
select ok(
  (select bool_and(not pg_temp.ws_cap('d1000000-0000-4000-8000-000000000003',
                                      'd3000000-0000-4000-8000-00000000000b',
                                      r.capability))
   from public.capability_registry r),
  'the assigned manager gets nothing on Bob, who is in the same studio'
);
select ok(
  not pg_temp.ws_cap('d1000000-0000-4000-8000-000000000003',
                     'd3000000-0000-4000-8000-00000000000a', 'view_finance'),
  'the assigned manager still has no finance access on Alice'
);
select ok(
  not pg_temp.ws_wcap('d1000000-0000-4000-8000-000000000003',
                      'd2000000-0000-4000-8000-000000000001', 'view'),
  'being assigned to an artist does not make the manager a member of the workspace'
);

-- ---------------------------------------------------------------------------
-- The artist''s own team management path
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.ws_as('d1000000-0000-4000-8000-000000000002');
select lives_ok(
  $$select public.grant_workspace_artist_membership(
      'd1000000-0000-4000-8000-000000000004'::uuid,
      'd3000000-0000-4000-8000-00000000000a'::uuid,
      'manager'::public.artist_access_level,
      true, true, true, true, true)$$,
  'the artist may invite a manager to her own scope, including her own finance rights'
);
select throws_ok(
  $$select public.grant_workspace_artist_membership(
      'd1000000-0000-4000-8000-000000000004'::uuid,
      'd3000000-0000-4000-8000-00000000000b'::uuid,
      'manager'::public.artist_access_level,
      false, false, false, false, true)$$,
  '42501', null,
  'the artist cannot staff a colleague she does not run'
);
reset role;

-- ---------------------------------------------------------------------------
-- Workspace membership writes
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.ws_as('d1000000-0000-4000-8000-000000000002');
select throws_ok(
  $$select public.upsert_workspace_membership(
      'd1000000-0000-4000-8000-000000000003'::uuid,
      'd2000000-0000-4000-8000-000000000001'::uuid,
      'admin'::public.workspace_role, true, true, true, true)$$,
  '42501', null,
  'an artist who is not a workspace admin cannot add workspace members'
);
reset role;

set local role authenticated;
select pg_temp.ws_as('d1000000-0000-4000-8000-000000000001');
select lives_ok(
  $$select public.upsert_workspace_membership(
      'd1000000-0000-4000-8000-000000000003'::uuid,
      'd2000000-0000-4000-8000-000000000001'::uuid,
      'booking_manager'::public.workspace_role, false, false, false, true)$$,
  'a workspace admin with team management may add a booking manager'
);
select throws_ok(
  $$select public.upsert_workspace_membership(
      'd1000000-0000-4000-8000-000000000003'::uuid,
      'd2000000-0000-4000-8000-000000000001'::uuid,
      'owner'::public.workspace_role, false, false, false, true)$$,
  '42501', null,
  'workspace ownership is transferred deliberately, not granted by an admin'
);
select throws_ok(
  $$select public.upsert_workspace_membership(
      'd1000000-0000-4000-8000-000000000003'::uuid,
      'd2000000-0000-4000-8000-000000000002'::uuid,
      'booking_manager'::public.workspace_role, false, false, false, true)$$,
  '42501', null,
  'a workspace admin cannot add members to a workspace it does not administer'
);
reset role;

-- Even after joining the workspace, the booking manager gains no artist access.
select ok(
  (select bool_and(not pg_temp.ws_cap('d1000000-0000-4000-8000-000000000003',
                                      'd3000000-0000-4000-8000-00000000000b',
                                      r.capability))
   from public.capability_registry r),
  'a new workspace booking manager still holds nothing over Bob'
);

-- ---------------------------------------------------------------------------
-- Solo workspaces stay owned by the person who runs the artist
-- ---------------------------------------------------------------------------

insert into public.artists (id, slug, display_name, is_active) values
  ('d3000000-0000-4000-8000-00000000000e', 'ws-erin', 'Erin', true);
insert into public.artist_memberships
  (profile_id, artist_id, access_level, is_active)
values
  ('d1000000-0000-4000-8000-000000000004', 'd3000000-0000-4000-8000-00000000000e',
   'artist', true);

select ok(
  pg_temp.ws_wcap('d1000000-0000-4000-8000-000000000004',
                  (select workspace_id from public.artists
                   where id = 'd3000000-0000-4000-8000-00000000000e'),
                  'manage_workspace'),
  'an artist-level membership owns the solo workspace it implies'
);
select ok(
  not exists (
    select 1
    from public.workspace_memberships m
    join public.workspaces w on w.id = m.workspace_id
    where m.profile_id = 'd1000000-0000-4000-8000-000000000003'
      and w.workspace_type = 'solo'
  ),
  'a manager-level artist membership never mints a solo workspace ownership'
);

select * from finish(true);
rollback;
