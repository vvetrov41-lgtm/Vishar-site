-- 235_control_plane.sql
--
-- The control plane from migrations 0087 and 0088, tested against the thing it
-- is actually claimed to do: let somebody add an artist, staff them, and see
-- what is left - without ever letting an organizational right turn into access
-- to an artist's work.
--
-- Every scenario from the brief that this file is responsible for:
--
--   solo and studio workspaces side by side
--   a studio administrator who cannot read one of their own artists' finance
--   a manager who serves two artists and not a third
--   a workspace administrator who cannot hand out a right they do not hold
--   an artist leaving a studio
--   a membership revoked mid-session
--
-- The composed end-to-end path for a brand-new artist lives in 236.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Act 0. The cast
--
-- Nobody here is an installation owner. That is deliberate: the whole point is
-- that the control plane works for people who are not the legacy global owner,
-- because `owner` is the thing this platform is transitioning off.
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('c0011111-1111-4111-8111-111111111111', 'cp-founder@example.test'),
  ('c0022222-2222-4222-8222-222222222222', 'cp-artist-a@example.test'),
  ('c0033333-3333-4333-8333-333333333333', 'cp-artist-b@example.test'),
  ('c0044444-4444-4444-8444-444444444444', 'cp-manager@example.test'),
  ('c0055555-5555-4555-8555-555555555555', 'cp-stranger@example.test'),
  ('c0066666-6666-4666-8666-666666666666', 'cp-reader@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('c0011111-1111-4111-8111-111111111111', 'cp-founder@example.test',
   'Studio Founder', 'booking_manager', true),
  ('c0022222-2222-4222-8222-222222222222', 'cp-artist-a@example.test',
   'Artist A', 'booking_manager', true),
  ('c0033333-3333-4333-8333-333333333333', 'cp-artist-b@example.test',
   'Artist B', 'booking_manager', true),
  ('c0044444-4444-4444-8444-444444444444', 'cp-manager@example.test',
   'Booking Manager', 'booking_manager', true),
  ('c0055555-5555-4555-8555-555555555555', 'cp-stranger@example.test',
   'Stranger', 'booking_manager', true),
  ('c0066666-6666-4666-8666-666666666666', 'cp-reader@example.test',
   'Reader', 'read_only', true);

create function pg_temp.founder() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"c0011111-1111-4111-8111-111111111111","role":"authenticated"}', true)::void;
$$;
create function pg_temp.artist_a() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"c0022222-2222-4222-8222-222222222222","role":"authenticated"}', true)::void;
$$;
create function pg_temp.manager() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"c0044444-4444-4444-8444-444444444444","role":"authenticated"}', true)::void;
$$;
create function pg_temp.stranger() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"c0055555-5555-4555-8555-555555555555","role":"authenticated"}', true)::void;
$$;
create function pg_temp.backend() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', true)::void;
$$;
grant execute on function pg_temp.founder() to authenticated, service_role;
grant execute on function pg_temp.artist_a() to authenticated, service_role;
grant execute on function pg_temp.manager() to authenticated, service_role;
grant execute on function pg_temp.stranger() to authenticated, service_role;
grant execute on function pg_temp.backend() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Act 1. Founding an organization is gated, not open
--
-- There is no self-signup in this CRM. Somebody who holds nothing may not
-- bring an organization into being, or the platform would have an unbounded
-- write surface reachable by any signed-in account.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.stranger();
set local role authenticated;

select throws_ok(
  $$select public.create_workspace('Squatter Studio', 'studio')$$,
  '42501', null,
  'a profile that administers no workspace cannot found one'
);

-- The founder is given organization ownership the way the installation owner
-- would give it. From here on they act entirely through the named RPCs.
reset role;
select pg_temp.backend();
insert into public.workspace_memberships (
  profile_id, workspace_id, workspace_role,
  can_manage_workspace, can_manage_team, can_manage_integrations, is_active
)
select 'c0011111-1111-4111-8111-111111111111', a.workspace_id,
       'owner', true, true, true, true
from public.artists a where a.slug = 'vladimir';

reset role;
select pg_temp.founder();
set local role authenticated;

create temporary table t_ws as
select public.create_workspace('Control Plane Studio', 'studio') as id;
grant select on t_ws to public;

select isnt((select id from t_ws), null, 'a workspace administrator can found a studio');

select is(
  (select w.workspace_type::text from public.workspaces w where w.id = (select id from t_ws)),
  'studio',
  'and it is a studio, not a solo workspace'
);

select is(
  (select count(*)::int from public.workspace_memberships m
   where m.workspace_id = (select id from t_ws)
     and m.profile_id = 'c0011111-1111-4111-8111-111111111111'
     and m.workspace_role = 'owner' and m.is_active),
  1,
  'the founder owns the organization they created'
);

-- ---------------------------------------------------------------------------
-- Act 2. Adding artists, and the invariant that makes the whole design work
--
-- create_artist grants the creator nothing on the artist. This is the single
-- assertion the platform's isolation claim rests on: if founding an
-- organization silently produced artist access, "workspace membership never
-- grants artist access" would be false on the very first artist.
-- ---------------------------------------------------------------------------

create temporary table t_a as
select public.create_artist((select id from t_ws), 'Artist A') as id;
create temporary table t_b as
select public.create_artist((select id from t_ws), 'Artist B') as id;
create temporary table t_c as
select public.create_artist((select id from t_ws), 'Artist C') as id;
grant select on t_a, t_b, t_c to public;

select is(
  (select count(*)::int from public.artist_memberships m
   where m.artist_id = (select id from t_a)),
  0,
  'creating an artist grants its creator no membership on it'
);

select ok(
  not public.can_access_artist((select id from t_a)),
  'so the founder, who administers the organization, cannot open the artist'
);

select is(
  (select count(*)::int from public.list_accessible_artists() la
   where la.id in (select id from t_a union all select id from t_b)),
  0,
  'and the new artists do not appear in their working scope'
);

-- The roster is the surface that makes that liveable: organizational shape,
-- visible to an organizational role, with no operational content at all.
select is(
  (select count(*)::int from public.list_workspace_artists((select id from t_ws))),
  3,
  'the roster shows all three artists to the organization administrator'
);

select ok(
  (select bool_and(not r.viewer_has_membership)
   from public.list_workspace_artists((select id from t_ws)) r),
  'each row says plainly that the reader cannot open that artist'
);

-- Slugs and booking prefixes are derived, not demanded. Nobody adding an
-- artist from a phone should have to invent a URL-safe identifier.
select ok(
  (select bool_and(r.slug ~ '^[a-z][a-z0-9-]{1,62}$')
   from public.list_workspace_artists((select id from t_ws)) r),
  'every derived slug satisfies the addressing constraint'
);

-- Read privileged: the founder holds no membership on these artists, so the
-- artists_select policy correctly hides the rows from them. That the roster
-- RPC above is the only way they see this is the point of the design.
reset role;
select is(
  (select count(distinct a.booking_reference_prefix)::int
   from public.artists a
   where a.id in (select id from t_a union all select id from t_b union all select id from t_c)),
  3,
  'and three artists created from similar names get three distinct booking prefixes'
);
select pg_temp.founder();
set local role authenticated;

-- ---------------------------------------------------------------------------
-- Act 3. A solo workspace stays solo
--
-- 0075's sync_solo_workspace_owner turns an artist membership on a solo
-- workspace's artist into ownership of that workspace. That is safe precisely
-- because a solo workspace has one artist. A second artist in one would make
-- that trigger into a way to reach somebody else's records.
-- ---------------------------------------------------------------------------

create temporary table t_solo as
select public.create_workspace('Solo Book', 'solo') as id;
grant select on t_solo to public;

select isnt(
  (select public.create_artist((select id from t_solo), 'Solo Artist')),
  null,
  'a solo workspace accepts its one artist'
);

select throws_ok(
  format($$select public.create_artist(%L, 'Second Solo Artist')$$, (select id from t_solo)),
  '23514', null,
  'and refuses a second, rather than quietly widening the solo owner trigger'
);

-- ---------------------------------------------------------------------------
-- Act 4. Staffing, and the two rights that never travel together
--
-- Scenario: a booking manager serves A and B, and must not reach C.
-- ---------------------------------------------------------------------------

-- The bootstrap. Without it the organization administrator could never give a
-- brand-new artist finance access to their own book, because the no-self-
-- elevation rule means you cannot pass on a right you do not hold, and on a
-- one-second-old artist nobody holds any.
select throws_ok(
  format(
    $$select public.grant_workspace_artist_membership(
        'c0022222-2222-4222-8222-222222222222', %L, 'artist', true, true, true, true, true)$$,
    (select id from t_a)),
  '42501', null,
  'the ordinary grant path cannot mint finance access on a new artist, by design'
);

select isnt(
  public.seat_artist_owner('c0022222-2222-4222-8222-222222222222', (select id from t_a)),
  null,
  'so the one-shot bootstrap seats the artist on their own book instead'
);

reset role;
select ok(
  (select m.can_manage_finance and m.can_manage_integrations and m.access_level = 'artist'
   from public.artist_memberships m
   where m.artist_id = (select id from t_a)
     and m.profile_id = 'c0022222-2222-4222-8222-222222222222'),
  'with full rights over their own work'
);
select pg_temp.founder();
set local role authenticated;

-- And then it is shut. This is the assertion that keeps the bootstrap from
-- being a way into an artist that already has a team.
select throws_ok(
  format(
    $$select public.seat_artist_owner('c0011111-1111-4111-8111-111111111111', %L)$$,
    (select id from t_a)),
  '23505', null,
  'the bootstrap refuses once the artist has any membership at all'
);

select isnt(
  public.grant_workspace_artist_membership(
    'c0044444-4444-4444-8444-444444444444', (select id from t_a),
    'manager', false, false, true, false, true),
  null,
  'and a manager on artist A'
);
select isnt(
  public.grant_workspace_artist_membership(
    'c0044444-4444-4444-8444-444444444444', (select id from t_b),
    'manager', false, false, true, false, true),
  null,
  'and on artist B'
);

reset role;
select pg_temp.manager();
set local role authenticated;

select is(
  (select count(*)::int from public.list_accessible_artists() la
   where la.id in (select id from t_a union all select id from t_b)),
  2,
  'the manager works on the two artists they were seated on'
);
select ok(
  not public.can_access_artist((select id from t_c)),
  'and cannot reach the third artist in the same studio'
);
-- Asked through public.list_capabilities, the shared read surface the CRM, MCP
-- and GPT all use. crm_private.has_artist_capability is deliberately callable
-- by no API role, so this is also the only way a client could ask.
select ok(
  not exists (
    select 1 from public.list_capabilities((select id from t_a)) c
    where c.capability = 'view_finance'
  ),
  'a manager seated without finance cannot view finance on an artist they do serve'
);
select ok(
  exists (
    select 1 from public.list_capabilities((select id from t_a)) c
    where c.capability = 'manage_sessions'
  ),
  'but does hold the sessions right they were given'
);
select ok(
  not exists (
    select 1 from public.list_capabilities((select id from t_a)) c
    where c.capability = 'manage_team'
  ),
  'and cannot invite further people onto that artist'
);

-- ---------------------------------------------------------------------------
-- Act 5. The organization administrator's ceiling
--
-- Scenario: a studio owner administers the organization but holds no finance
-- access on a given artist - and therefore cannot grant it either. This is
-- what stops "I can staff my studio" from becoming "I can give myself
-- anything".
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.founder();
set local role authenticated;

select throws_ok(
  format(
    $$select public.grant_workspace_artist_membership(
        'c0044444-4444-4444-8444-444444444444', %L, 'manager', true, true, true, false, true)$$,
    (select id from t_a)),
  '42501', null,
  'a workspace administrator cannot hand out finance access they do not hold'
);

select throws_ok(
  format(
    $$select public.grant_workspace_artist_membership(
        'c0011111-1111-4111-8111-111111111111', %L, 'manager', false, false, true, true, true)$$,
    (select id from t_a)),
  '42501', null,
  'nor integration management, not even to themselves'
);

-- The plain seat is allowed: staffing an artist with ordinary operational
-- access is exactly the power a studio administrator is meant to have.
select isnt(
  public.grant_workspace_artist_membership(
    'c0011111-1111-4111-8111-111111111111', (select id from t_c),
    'manager', false, false, false, false, true),
  null,
  'an ordinary seat, carrying neither finance nor integrations, is permitted'
);

-- ---------------------------------------------------------------------------
-- Act 6. The capability editor cannot disagree with the database
--
-- preview_membership_capabilities answers through the same
-- crm_private.capability_from_grant that decides the real thing. If these two
-- could differ, the CRM would be able to offer a right the database refuses -
-- which is the second permission system this platform exists to avoid.
-- ---------------------------------------------------------------------------

-- Captured as `authenticated`, compared as the privileged role, so the
-- comparison can reach crm_private.capability_from_grant that no API role may
-- call. If these two ever diverged, the CRM could offer a right the database
-- refuses.
create temporary table t_preview as
select p.capability, p.granted
from public.preview_membership_capabilities(
  (select id from t_a), 'c0044444-4444-4444-8444-444444444444',
  'manager', false, false, true, false) p;
grant select on t_preview to public;

reset role;

select ok(
  (select bool_and(
     v.granted = crm_private.capability_from_grant(
       'booking_manager', 'manager', false, false, true, false, v.capability))
   from t_preview v),
  'the preview agrees with the authoritative derivation for every capability'
);

select is(
  (select v.granted from t_preview v where v.capability = 'manage_sessions'),
  true,
  'a right this shape grants is previewed as granted'
);

select is(
  (select v.granted from t_preview v where v.capability = 'manage_finance'),
  false,
  'and one it does not is previewed as withheld'
);

select pg_temp.founder();
set local role authenticated;

-- A read_only profile is the case a browser-side copy of the rules would get
-- wrong: every grant flag is switched on, and the legacy global role still
-- says no to every write. An editor that only looked at the checkboxes would
-- promise this person rights the database refuses.
select ok(
  (select not bool_or(p.granted)
   from public.preview_membership_capabilities(
     (select id from t_a), 'c0066666-6666-4666-8666-666666666666',
     'manager', true, true, true, true) p
   where p.is_write),
  'no write capability is previewed for a profile whose global role forbids writes'
);
select ok(
  (select bool_and(p.granted)
   from public.preview_membership_capabilities(
     (select id from t_a), 'c0066666-6666-4666-8666-666666666666',
     'manager', true, true, true, true) p
   where not p.is_write and p.domain <> 'finance'),
  'though the ordinary reads such a membership does produce are still shown'
);

select ok(
  not exists (
    select 1 from public.preview_membership_capabilities(
      (select id from t_a), 'c0044444-4444-4444-8444-444444444444',
      'manager', false, false, false, false) p
    where p.domain in ('legacy', 'workspace')
  ),
  'the editor is never offered the legacy vocabulary or a workspace right to hand out'
);

reset role;
select pg_temp.stranger();
set local role authenticated;

select throws_ok(
  format(
    $$select * from public.preview_membership_capabilities(%L, %L, 'manager', true, true, true, true)$$,
    (select id from t_a), 'c0044444-4444-4444-8444-444444444444'),
  '42501', null,
  'and somebody who could not make the grant cannot ask what it would mean'
);

-- ---------------------------------------------------------------------------
-- Act 7. Organizational reads refuse outsiders
-- ---------------------------------------------------------------------------

select throws_ok(
  format($$select * from public.list_workspace_artists(%L)$$, (select id from t_ws)),
  '42501', null,
  'the roster of an organization you do not belong to is refused'
);
select throws_ok(
  format($$select * from public.list_workspace_team(%L)$$, (select id from t_ws)),
  '42501', null,
  'so is its staff list'
);
select throws_ok(
  format($$select * from public.artist_onboarding_state(%L)$$, (select id from t_a)),
  '42501', null,
  'and the onboarding state of an artist you can neither administer nor open'
);

reset role;
select pg_temp.manager();
set local role authenticated;

select throws_ok(
  format($$select * from public.list_workspace_team(%L)$$, (select id from t_ws)),
  '42501', null,
  'an ordinary member of the organization does not get the staff directory'
);

-- ---------------------------------------------------------------------------
-- Act 8. Lifecycle, and what deactivation actually closes
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.manager();
set local role authenticated;

select throws_ok(
  format($$select public.update_artist(%L, 'Renamed By A Manager')$$, (select id from t_a)),
  '42501', null,
  'an artist-scoped manage right does not rename or retire the artist'
);

reset role;
select pg_temp.founder();
set local role authenticated;

-- A live booking source on the artist about to be deactivated, so the claim
-- that the public door shuts can be tested rather than asserted.
reset role;
select pg_temp.artist_a();
set local role authenticated;

create temporary table t_src as
select public.create_booking_source(
  (select id from t_a), 'hosted', 'Artist A enquiries', null, 'tattoo-enquiry', true) as id;
grant select on t_src to public;

create temporary table t_public as
select b.public_source_id from public.booking_sources b where b.id = (select id from t_src);
grant select on t_public to public;

reset role;
select pg_temp.backend();
set local role service_role;

select isnt(
  (select r.artist_id from public.resolve_hosted_booking_source(
     (select public_source_id from t_public)) r),
  null,
  'the hosted form resolves while the artist is active'
);

reset role;
select pg_temp.founder();
set local role authenticated;

select ok(
  public.update_artist((select id from t_a), null, null, null, false),
  'the organization administrator deactivates the artist'
);

reset role;
select pg_temp.backend();
set local role service_role;

-- The important half: no cascade wrote to booking_sources, and the public door
-- is shut anyway, because the resolver joins the artist state mirror. Read
-- privileged, because no API role holds SELECT on the table itself.
reset role;
select is(
  (select b.is_active from public.booking_sources b where b.id = (select id from t_src)),
  true,
  'the booking source row was not touched by deactivation'
);

select pg_temp.backend();
set local role service_role;

select throws_ok(
  format($$select * from public.resolve_hosted_booking_source(%L)$$,
    (select public_source_id from t_public)),
  '42501', null,
  'yet the public form refuses, because the artist is no longer active'
);

reset role;
select pg_temp.manager();
set local role authenticated;

select ok(
  not public.can_access_artist((select id from t_a)),
  'and a deactivated artist leaves every membership holder''s scope at once'
);

reset role;
select pg_temp.founder();
set local role authenticated;

select ok(
  public.update_artist((select id from t_a), null, null, null, true),
  'reactivation is available'
);

reset role;
select pg_temp.backend();
set local role service_role;

select isnt(
  (select r.artist_id from public.resolve_hosted_booking_source(
     (select public_source_id from t_public)) r),
  null,
  'and restores the form its owner had left switched on'
);

-- ---------------------------------------------------------------------------
-- Act 9. Revocation is immediate
--
-- The scenario is a membership withdrawn while somebody is mid-session. There
-- is no cache to invalidate and no token to expire: the mirror follows the
-- membership row inside the same transaction.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.founder();
set local role authenticated;

select isnt(
  public.grant_workspace_artist_membership(
    'c0044444-4444-4444-8444-444444444444', (select id from t_b),
    'manager', false, false, true, false, false),
  null,
  'the manager''s seat on artist B is set inactive'
);

reset role;
select pg_temp.manager();
set local role authenticated;

select ok(
  not public.can_access_artist((select id from t_b)),
  'access to artist B is gone immediately'
);
select ok(
  public.can_access_artist((select id from t_a)),
  'and their other artist is untouched'
);
select throws_ok(
  format($$select * from public.list_booking_sources(%L)$$, (select id from t_b)),
  '42501', null,
  'a revoked scope is refused outright, not answered with an empty list'
);

-- ---------------------------------------------------------------------------
-- Act 10. An organization cannot be abandoned with live artists in it
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.founder();
set local role authenticated;

select throws_ok(
  format($$select public.update_workspace(%L, null, null, null, false)$$, (select id from t_ws)),
  '23514', null,
  'deactivating an organization that still runs active artists is refused'
);

select ok(
  public.update_workspace((select id from t_ws), 'Control Plane Studio Renamed'),
  'renaming it is not'
);

-- ---------------------------------------------------------------------------
-- Act 11. The control plane discloses no secret and no credential
-- ---------------------------------------------------------------------------

select ok(
  not exists (
    select 1 from public.list_workspace_artists((select id from t_ws)) r
    where r::text ~* '(token|secret|api[_-]?key|chat_id|bearer|sb_secret)'
  ),
  'the artist roster carries no credential-shaped field'
);
select ok(
  not exists (
    select 1 from public.list_workspace_team((select id from t_ws)) r
    where r::text ~* '(token|secret|api[_-]?key|chat_id|bearer|sb_secret)'
  ),
  'neither does the organization''s staff list'
);
select ok(
  not exists (
    select 1 from public.artist_onboarding_state((select id from t_c)) r
    where r::text ~* '(token|secret|api[_-]?key|chat_id|bearer|sb_secret)'
  ),
  'and neither does the onboarding checklist'
);

-- ---------------------------------------------------------------------------
-- Act 12. Direct table access stays shut
--
-- The RPCs are SECURITY DEFINER, so the browser role must not be able to reach
-- the same tables itself.
-- ---------------------------------------------------------------------------

reset role;

select ok(
  not has_table_privilege('authenticated', 'public.artists', 'INSERT'),
  'authenticated cannot insert an artist directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.artists', 'UPDATE'),
  'nor update one'
);
select ok(
  not has_table_privilege('authenticated', 'public.workspaces', 'INSERT'),
  'nor create a workspace directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.workspaces', 'UPDATE'),
  'nor change one'
);
select ok(
  (select bool_and(not has_table_privilege(r, 'public.artists', 'DELETE'))
   from unnest(array['anon', 'authenticated']) r),
  'and no API role may delete an artist: deactivation is the only retirement'
);

select ok(
  (select bool_and(not has_function_privilege('anon', f, 'EXECUTE'))
   from unnest(array[
     'public.create_artist(uuid,text,text,text,text,text)',
     'public.update_artist(uuid,text,text,text,boolean)',
     'public.create_workspace(text,public.workspace_type,text,text,text)',
     'public.update_workspace(uuid,text,text,text,boolean)',
     'public.list_workspace_artists(uuid)',
     'public.list_workspace_team(uuid)',
     'public.list_artist_memberships(uuid)',
     'public.artist_onboarding_state(uuid)',
     'public.preview_membership_capabilities(uuid,uuid,public.artist_access_level,boolean,boolean,boolean,boolean)'
   ]) f),
  'the entire control plane is closed to anon'
);

-- crm_private helpers are reachable only through the definer boundary.
select ok(
  (select bool_and(not has_function_privilege(r, f, 'EXECUTE'))
   from unnest(array['anon', 'authenticated', 'service_role']) r
   cross join unnest(array[
     'crm_private.capability_from_grant(public.crm_role,public.artist_access_level,boolean,boolean,boolean,boolean,text)',
     'crm_private.can_administer_workspace(uuid)',
     'crm_private.can_found_workspace()',
     'crm_private.log_lifecycle_event(text,uuid,jsonb)',
     'crm_private.slugify(text)'
   ]) f),
  'and no API role can call the private helpers behind it'
);

select * from finish(true);
rollback;
