-- 237_control_plane_governance.sql
--
-- The corrections in migration 0089, tested against the failures that prompted
-- them. Each act below corresponds to a defect an independent review found in
-- the first control-plane pass — defects that shipped green, because the tests
-- written alongside that work asked whether the happy path worked and not
-- whether the wrong person could reach it or the right person was locked out.
--
-- The cast contains no installation owner anywhere. That is the whole point:
-- every one of these paths has to work for a studio administrator who is not
-- the legacy global owner, and several of them did not.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Act 0. A studio, its owner, an admin, a manager, a read-only person, and a
-- stranger from a different organization.
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('f0011111-1111-4111-8111-111111111111', 'gov-owner@example.test'),
  ('f0022222-2222-4222-8222-222222222222', 'gov-admin@example.test'),
  ('f0033333-3333-4333-8333-333333333333', 'gov-artist@example.test'),
  ('f0044444-4444-4444-8444-444444444444', 'gov-reader@example.test'),
  ('f0055555-5555-4555-8555-555555555555', 'gov-stranger@example.test'),
  ('f0066666-6666-4666-8666-666666666666', 'gov-member@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('f0011111-1111-4111-8111-111111111111', 'gov-owner@example.test',
   'Gov Owner', 'booking_manager', true),
  ('f0022222-2222-4222-8222-222222222222', 'gov-admin@example.test',
   'Gov Admin', 'booking_manager', true),
  ('f0033333-3333-4333-8333-333333333333', 'gov-artist@example.test',
   'Gov Artist', 'booking_manager', true),
  ('f0044444-4444-4444-8444-444444444444', 'gov-reader@example.test',
   'Gov Reader', 'read_only', true),
  ('f0055555-5555-4555-8555-555555555555', 'gov-stranger@example.test',
   'Gov Stranger', 'booking_manager', true),
  -- An ordinary organization member, kept separate from the artist so the
  -- artist stays genuinely workspace-less for Act 6.
  ('f0066666-6666-4666-8666-666666666666', 'gov-member@example.test',
   'Gov Member', 'booking_manager', true);

create function pg_temp.owner() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"f0011111-1111-4111-8111-111111111111","role":"authenticated"}', true)::void;
$$;
create function pg_temp.admin() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"f0022222-2222-4222-8222-222222222222","role":"authenticated"}', true)::void;
$$;
create function pg_temp.artist_z() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"f0033333-3333-4333-8333-333333333333","role":"authenticated"}', true)::void;
$$;
create function pg_temp.reader() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"f0044444-4444-4444-8444-444444444444","role":"authenticated"}', true)::void;
$$;
create function pg_temp.stranger() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"f0055555-5555-4555-8555-555555555555","role":"authenticated"}', true)::void;
$$;
grant execute on function pg_temp.owner(), pg_temp.admin(), pg_temp.artist_z(),
  pg_temp.reader(), pg_temp.stranger() to authenticated, service_role;

-- Organization ownership is handed over once, the way an installation owner
-- would hand it over. Everything after this runs through the named RPCs.
insert into public.workspace_memberships (
  profile_id, workspace_id, workspace_role,
  can_manage_workspace, can_manage_team, can_manage_integrations, is_active
)
select 'f0011111-1111-4111-8111-111111111111', a.workspace_id,
       'owner', true, true, true, true
from public.artists a where a.slug = 'vladimir';

reset role;
select pg_temp.owner();
set local role authenticated;

create temporary table t_ws as
select public.create_workspace('Governance Studio', 'studio') as id;
create temporary table t_z as
select public.create_artist((select id from t_ws), 'Artist Z') as id;
grant select on t_ws, t_z to public;

select isnt(
  public.upsert_workspace_membership(
    'f0022222-2222-4222-8222-222222222222', (select id from t_ws),
    'admin', true, true, true, true),
  null,
  'the founder staffs an administrator'
);

-- ---------------------------------------------------------------------------
-- Act 1. The people directory
--
-- The defect: the new screens called public.list_profiles(), which requires
-- the legacy installation-wide owner role. A studio administrator - the exact
-- person the control plane was written for - got a permission error, which the
-- interface rendered as an empty dropdown. Onboarding could not be completed.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.admin();
set local role authenticated;

select throws_ok(
  $$select * from public.list_profiles()$$,
  '42501', null,
  'the legacy directory still refuses somebody who is not the installation owner'
);

select cmp_ok(
  (select count(*)::int from public.list_directory_profiles()),
  '>=', 5,
  'while the scoped directory answers a workspace administrator'
);

-- The eligibility flag exists so the interface can warn before it spends the
-- one-shot artist seat. It is computed from the authoritative derivation.
select is(
  (select d.can_hold_artist_writes from public.list_directory_profiles() d
   where d.id = 'f0044444-4444-4444-8444-444444444444'),
  false,
  'a read-only profile is flagged as unable to hold artist writes'
);
select is(
  (select d.can_hold_artist_writes from public.list_directory_profiles() d
   where d.id = 'f0033333-3333-4333-8333-333333333333'),
  true,
  'and an ordinary CRM user is flagged as able to'
);

select ok(
  not exists (
    select 1 from public.list_directory_profiles() d
    where d::text ~* '(token|secret|api[_-]?key|chat_id|bearer|sb_secret)'
  ),
  'the directory carries no credential-shaped field'
);

-- Somebody who administers nothing may not browse it. This is the bound that
-- keeps a scoped directory from being an installation-wide staff export.
reset role;
select pg_temp.stranger();
set local role authenticated;

select throws_ok(
  $$select * from public.list_directory_profiles()$$,
  '42501', null,
  'a profile that manages no team and holds no artist cannot browse the directory'
);

-- ---------------------------------------------------------------------------
-- Act 2. Workspace owner invariants
--
-- The defect: upsert_workspace_membership guarded *granting* the owner role
-- but not the row it wrote over. Its ON CONFLICT DO UPDATE rewrote
-- workspace_role and is_active for whatever already existed, so anybody with
-- manage_team could demote the sitting owner or switch them off, and the
-- organization would be left with nobody able to administer it.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.admin();
set local role authenticated;

select throws_ok(
  format(
    $$select public.upsert_workspace_membership(
        'f0011111-1111-4111-8111-111111111111', %L, 'read_only', false, false, false, true)$$,
    (select id from t_ws)),
  '42501', null,
  'an administrator cannot demote the workspace owner'
);

select throws_ok(
  format(
    $$select public.upsert_workspace_membership(
        'f0011111-1111-4111-8111-111111111111', %L, 'owner', true, true, true, false)$$,
    (select id from t_ws)),
  '42501', null,
  'nor deactivate them'
);

select throws_ok(
  format(
    $$select public.upsert_workspace_membership(
        'f0022222-2222-4222-8222-222222222222', %L, 'owner', true, true, true, true)$$,
    (select id from t_ws)),
  '42501', null,
  'nor promote themselves into a second ownership'
);

-- The owner is untouched by all three attempts.
reset role;
select is(
  (select wm.workspace_role::text || ':' || wm.is_active::text
   from public.workspace_memberships wm
   where wm.workspace_id = (select id from t_ws)
     and wm.profile_id = 'f0011111-1111-4111-8111-111111111111'),
  'owner:true',
  'the owner row is exactly as it was'
);

-- Ordinary members are still editable, so the guard did not freeze the screen.
select pg_temp.admin();
set local role authenticated;
select isnt(
  public.upsert_workspace_membership(
    'f0066666-6666-4666-8666-666666666666', (select id from t_ws),
    'booking_manager', false, false, false, true),
  null,
  'an ordinary member is still managed normally'
);

-- ---------------------------------------------------------------------------
-- Act 3. The last owner cannot be removed, by any path
--
-- The RPC guard above lives in one function. This invariant is enforced at the
-- table, so it holds for a repair script or a future RPC nobody has written.
-- ---------------------------------------------------------------------------

reset role;

select throws_ok(
  format(
    $$update public.workspace_memberships set is_active = false
      where workspace_id = %L and workspace_role = 'owner'$$,
    (select id from t_ws)),
  '23514', null,
  'deactivating the last active owner is refused at the table'
);

select throws_ok(
  format(
    $$update public.workspace_memberships set workspace_role = 'admin'
      where workspace_id = %L and workspace_role = 'owner'$$,
    (select id from t_ws)),
  '23514', null,
  'and so is demoting them'
);

select throws_ok(
  format(
    $$delete from public.workspace_memberships
      where workspace_id = %L and workspace_role = 'owner'$$,
    (select id from t_ws)),
  '23514', null,
  'and so is deleting the row outright'
);

-- ---------------------------------------------------------------------------
-- Act 4. Ownership transfer is the one deliberate path
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.admin();
set local role authenticated;

select throws_ok(
  format($$select public.transfer_workspace_ownership(%L, 'f0022222-2222-4222-8222-222222222222')$$,
    (select id from t_ws)),
  '42501', null,
  'an administrator cannot hand themselves ownership'
);

reset role;
select pg_temp.owner();
set local role authenticated;

select throws_ok(
  format($$select public.transfer_workspace_ownership(%L, 'f0055555-5555-4555-8555-555555555555')$$,
    (select id from t_ws)),
  '22023', null,
  'ownership cannot be pushed onto somebody outside the organization'
);

select ok(
  public.transfer_workspace_ownership(
    (select id from t_ws), 'f0022222-2222-4222-8222-222222222222'),
  'the sitting owner hands ownership to a colleague'
);

reset role;
select is(
  (select count(*)::int from public.workspace_memberships wm
   where wm.workspace_id = (select id from t_ws)
     and wm.workspace_role = 'owner' and wm.is_active),
  1,
  'the organization has exactly one active owner throughout'
);
select is(
  (select wm.workspace_role::text from public.workspace_memberships wm
   where wm.workspace_id = (select id from t_ws)
     and wm.profile_id = 'f0011111-1111-4111-8111-111111111111'),
  'admin',
  'and the outgoing owner keeps administrative access rather than being removed'
);

-- Ownership having moved, the invariant follows it: the new owner is now the
-- one the ordinary upsert refuses to touch.
select pg_temp.owner();
set local role authenticated;
select throws_ok(
  format(
    $$select public.upsert_workspace_membership(
        'f0022222-2222-4222-8222-222222222222', %L, 'read_only', false, false, false, true)$$,
    (select id from t_ws)),
  '42501', null,
  'the new owner is protected by the same rule the old one was'
);

-- ---------------------------------------------------------------------------
-- Act 5. The one-shot artist seat refuses an ineligible target
--
-- The defect: seat_artist_owner created the membership and spent the one-shot
-- without asking whether the person could use it. crm_private.capability_from_grant
-- still consults the legacy profiles.role, so seating a read_only profile left
-- an artist whose owner could not edit an enquiry, move an appointment, take a
-- payment or publish a form - and the bootstrap was gone for good.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.admin();
set local role authenticated;

select throws_ok(
  format($$select public.seat_artist_owner('f0044444-4444-4444-8444-444444444444', %L)$$,
    (select id from t_z)),
  '42501', null,
  'seating a read-only profile as the artist owner is refused'
);

reset role;
select is(
  (select count(*)::int from public.artist_memberships m
   where m.artist_id = (select id from t_z)),
  0,
  'and the refusal leaves the one-shot unspent, so the mistake is recoverable'
);

select pg_temp.admin();
set local role authenticated;
select isnt(
  public.seat_artist_owner('f0033333-3333-4333-8333-333333333333', (select id from t_z)),
  null,
  'an eligible person can still be seated afterwards'
);

select throws_ok(
  format($$select public.seat_artist_owner('f0022222-2222-4222-8222-222222222222', %L)$$,
    (select id from t_z)),
  '23505', null,
  'and only once'
);

-- ---------------------------------------------------------------------------
-- Act 6. The artist can open their own onboarding page
--
-- The defect was semantic, not a permission one. seat_artist_owner grants an
-- artist membership and no workspace membership, deliberately, because
-- workspace authority is not artist authority. In a studio that leaves the
-- newly seated artist with no workspace at all - and the screen resolved the
-- artist by walking the viewer's workspaces, so it told them they had no
-- access to their own onboarding.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.artist_z();
set local role authenticated;

select is(
  (select count(*)::int from public.list_workspaces()),
  0,
  'the seated artist belongs to no workspace, which is the architecture working'
);

select is(
  (select c.artist_display_name
   from public.artist_control_plane_context((select id from t_z)) c),
  'Artist Z',
  'yet they can resolve their own artist context'
);

select is(
  (select c.workspace_display_name
   from public.artist_control_plane_context((select id from t_z)) c),
  'Governance Studio',
  'and learn the name of the organization they work in'
);

select is(
  (select c.viewer_can_administer
   from public.artist_control_plane_context((select id from t_z)) c),
  false,
  'without that read granting them any workspace authority'
);
select is(
  (select c.viewer_has_artist_membership
   from public.artist_control_plane_context((select id from t_z)) c),
  true,
  'the context reports the membership they do hold'
);

select throws_ok(
  format($$select * from public.list_workspace_artists(%L)$$, (select id from t_ws)),
  '42501', null,
  'and the workspace roster stays refused to them'
);

select cmp_ok(
  (select count(*)::int from public.artist_onboarding_state((select id from t_z))),
  '>=', 7,
  'the onboarding checklist opens for the artist themselves'
);

-- An administrator sees the same artist through the other door.
reset role;
select pg_temp.admin();
set local role authenticated;
select is(
  (select c.viewer_can_administer
   from public.artist_control_plane_context((select id from t_z)) c),
  true,
  'an organization administrator resolves the same context as an administrator'
);

-- And somebody with neither door is refused.
reset role;
select pg_temp.stranger();
set local role authenticated;
select throws_ok(
  format($$select * from public.artist_control_plane_context(%L)$$, (select id from t_z)),
  '42501', null,
  'somebody holding neither the artist nor its organization is refused'
);

-- ---------------------------------------------------------------------------
-- Act 7. Control-plane visibility comes from the server
--
-- The browser was deriving this from the legacy CrmRole and getting both
-- directions wrong: a read_only profile holding real workspace administration
-- was locked out, and a booking_manager in no organization was shown a nav
-- entry to an empty page. Neither is a security failure - RLS decides the data
-- either way - but the first is a genuine lockout.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.reader();
set local role authenticated;

select is(
  (select a.workspace_count from public.control_plane_access() a),
  0,
  'a profile in no organization is told so, whatever its legacy role'
);

-- The read_only profile is now given genuine workspace administration. Under
-- the old browser-side model this person was refused the control plane
-- outright; the server says otherwise, and the server is right.
reset role;
select pg_temp.owner();
set local role authenticated;
select isnt(
  public.upsert_workspace_membership(
    'f0044444-4444-4444-8444-444444444444', (select id from t_ws),
    'admin', true, true, true, true),
  null,
  'a read-only CRM user is made a workspace administrator'
);

reset role;
select pg_temp.reader();
set local role authenticated;

select is(
  (select a.workspace_count from public.control_plane_access() a),
  1,
  'and the server now reports them as belonging to an organization'
);
select is(
  (select a.administers_any from public.control_plane_access() a),
  true,
  'and as administering one, which their legacy role could never express'
);
select is(
  (select a.can_browse_directory from public.control_plane_access() a),
  true,
  'so they may browse the directory to staff it'
);
select cmp_ok(
  (select count(*)::int from public.list_workspace_artists((select id from t_ws))),
  '>=', 1,
  'and the roster opens to them'
);

-- The other direction. A booking_manager belonging to nothing gets no
-- workspace, which is what the nav should be reading rather than the role.
reset role;
select pg_temp.stranger();
set local role authenticated;
select is(
  (select a.workspace_count from public.control_plane_access() a),
  0,
  'a booking_manager in no organization is reported as belonging to none'
);
select is(
  (select a.can_found_workspace from public.control_plane_access() a),
  false,
  'and may not found one'
);

-- ---------------------------------------------------------------------------
-- Act 8. Artist membership does not require workspace membership
--
-- Stated here as a test rather than left ambiguous, because the reverse rule -
-- workspace membership never granting artist access - is enforced everywhere
-- and it is reasonable to assume the symmetry holds. It does not, and that is
-- deliberate: production runs an artist today who holds an explicit artist
-- membership on her own book and belongs to no workspace record at all.
-- Requiring workspace membership would invalidate a live relationship.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.admin();
set local role authenticated;

select isnt(
  public.grant_workspace_artist_membership(
    'f0055555-5555-4555-8555-555555555555', (select id from t_z),
    'manager', false, false, true, false, true),
  null,
  'somebody outside the organization can be given artist-scoped access'
);

reset role;
select pg_temp.stranger();
set local role authenticated;

select is(
  (select count(*)::int from public.list_workspaces()),
  0,
  'and that grant gives them no workspace membership'
);
select ok(
  public.can_access_artist((select id from t_z)),
  'while the artist scope itself opens to them'
);
select throws_ok(
  format($$select * from public.list_workspace_team(%L)$$, (select id from t_ws)),
  '42501', null,
  'the organization stays closed: artist access is not workspace access'
);

-- ---------------------------------------------------------------------------
-- Act 9. Revocation still closes the artist scope at once
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.admin();
set local role authenticated;
select isnt(
  public.grant_workspace_artist_membership(
    'f0055555-5555-4555-8555-555555555555', (select id from t_z),
    'manager', false, false, true, false, false),
  null,
  'the grant is withdrawn'
);

reset role;
select pg_temp.stranger();
set local role authenticated;
select ok(
  not public.can_access_artist((select id from t_z)),
  'access is gone immediately'
);
select throws_ok(
  format($$select * from public.artist_control_plane_context(%L)$$, (select id from t_z)),
  '42501', null,
  'and the artist context closes with it'
);

-- ---------------------------------------------------------------------------
-- Act 10. The new surfaces stay closed to anon and to direct table access
-- ---------------------------------------------------------------------------

reset role;

select ok(
  (select bool_and(not has_function_privilege('anon', f, 'EXECUTE'))
   from unnest(array[
     'public.list_directory_profiles()',
     'public.control_plane_access()',
     'public.artist_control_plane_context(uuid)',
     'public.transfer_workspace_ownership(uuid,uuid)']) f),
  'every function added by 0089 is closed to anon'
);

select ok(
  (select bool_and(not has_function_privilege(r, f, 'EXECUTE'))
   from unnest(array['anon', 'authenticated', 'service_role']) r
   cross join unnest(array[
     'crm_private.can_browse_directory()',
     'crm_private.can_be_seated_as_artist_owner(uuid)',
     'crm_private.protect_last_workspace_owner()']) f),
  'and their private helpers are reachable by no API role'
);

select ok(
  not has_table_privilege('authenticated', 'public.workspace_memberships', 'UPDATE'),
  'the browser still cannot write a workspace membership directly'
);

select * from finish(true);
rollback;
