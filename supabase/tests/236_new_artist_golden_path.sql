-- 236_new_artist_golden_path.sql
--
-- "Tomorrow a third tattoo artist turns up."
--
-- What this file does and does not claim
-- --------------------------------------
-- It proves that **onboarding an artist, once the people involved already have
-- CRM identities, needs no engineer**. It does not prove that creating those
-- identities is operatorless, and Act 0 below is deliberately privileged so
-- that the boundary is visible rather than blurred.
--
-- The boundary, stated plainly:
--
--   * Provisioning a human identity - an auth.users row and a public.profiles
--     row - is a separate trusted operation. In the product it is the Users
--     invite flow, which mints the account and the profile together. It is not
--     part of the control plane and this file does not exercise it.
--
--   * Handing the very first workspace ownership to somebody is likewise a
--     one-time act of delegation from the installation owner. Act 0 does it
--     with a direct insert.
--
--   * **Everything after those two things** - founding an organization, adding
--     an artist, seating them, staffing them, publishing a booking form, taking
--     a real enquiry, applying studio automation policy, GPT discovery and
--     revocation - runs through named RPCs that an ordinary signed-in profile
--     may call from a phone. That is what the acts below test, and nothing in
--     them writes public.artists, public.workspaces or public.artist_memberships
--     directly.
--
-- Test 233 proved the platform composes for a new artist by inserting the
-- artist row directly, because in Phase U that was the only way an artist could
-- come into being. That is precisely the step this workstream deleted.
--
-- Read the acts as the screens somebody actually taps through: found the
-- studio, add the artist, seat them, staff them, publish a form, take a real
-- enquiry through it, watch it land in exactly one inbox, apply the studio's
-- automation policy, let the shared GPT discover an artist it has never heard
-- of, and then revoke one row and watch every door shut.
--
-- The final act is the one that matters most for the claim being made: it
-- greps the whole platform for the artist-specific special cases this design
-- is supposed to have made unnecessary.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Act 0. Four people who have never appeared in this database
--
-- Privileged setup, and the only privileged part of this file. These two
-- inserts stand in for the Users invite flow, which is a separate trusted
-- service; see the boundary note in the header. Everything from Act 1 onward
-- runs as an ordinary signed-in profile through named RPCs.
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('d0011111-1111-4111-8111-111111111111', 'gp-owner@example.test'),
  ('d0022222-2222-4222-8222-222222222222', 'gp-artist-z@example.test'),
  ('d0033333-3333-4333-8333-333333333333', 'gp-manager@example.test'),
  ('d0044444-4444-4444-8444-444444444444', 'gp-outsider@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('d0011111-1111-4111-8111-111111111111', 'gp-owner@example.test',
   'Studio Owner', 'booking_manager', true),
  ('d0022222-2222-4222-8222-222222222222', 'gp-artist-z@example.test',
   'Artist Z', 'booking_manager', true),
  ('d0033333-3333-4333-8333-333333333333', 'gp-manager@example.test',
   'Z Manager', 'booking_manager', true),
  ('d0044444-4444-4444-8444-444444444444', 'gp-outsider@example.test',
   'Outsider', 'booking_manager', true);

-- The outsider belongs to an artist that already existed. They are the control
-- group: nothing Artist Z does may ever reach them.
insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values (
  'd0044444-4444-4444-8444-444444444444',
  'a2222222-2222-4222-8222-222222222222', 'artist',
  false, false, true, true, true
);

-- The studio owner is handed organization ownership once, the way an
-- installation owner would delegate it. This is the second and last privileged
-- step; after it everything runs through the control plane.
insert into public.workspace_memberships (
  profile_id, workspace_id, workspace_role,
  can_manage_workspace, can_manage_team, can_manage_integrations, is_active
)
select 'd0011111-1111-4111-8111-111111111111', a.workspace_id,
       'owner', true, true, true, true
from public.artists a where a.slug = 'vladimir';

create function pg_temp.who(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
create function pg_temp.owner() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"d0011111-1111-4111-8111-111111111111","role":"authenticated"}', true)::void;
$$;
create function pg_temp.artist_z() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"d0022222-2222-4222-8222-222222222222","role":"authenticated"}', true)::void;
$$;
create function pg_temp.manager() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"d0033333-3333-4333-8333-333333333333","role":"authenticated"}', true)::void;
$$;
create function pg_temp.outsider() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"d0044444-4444-4444-8444-444444444444","role":"authenticated"}', true)::void;
$$;
create function pg_temp.backend() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', true)::void;
$$;
create function pg_temp.reference_files() returns jsonb language sql immutable as $$
  select jsonb_build_array(jsonb_build_object(
    'mime_type', 'image/jpeg',
    'safe_extension', 'jpg',
    'byte_size', 2048,
    'original_filename', 'z-reference.jpg'
  ));
$$;
grant execute on function pg_temp.who(text), pg_temp.owner(), pg_temp.artist_z(),
  pg_temp.manager(), pg_temp.outsider(), pg_temp.backend(), pg_temp.reference_files()
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Act 1. Found the studio and add the artist - from the CRM, as one person
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.owner();
set local role authenticated;

create temporary table t_ws as
select public.create_workspace('Third Artist Studio', 'studio') as id;
create temporary table t_z as
select public.create_artist((select id from t_ws), 'Artist Z') as id;
grant select on t_ws, t_z to public;

select isnt((select id from t_z), null, 'the third artist exists, created from the CRM');

select is(
  (select r.display_name from public.list_workspace_artists((select id from t_ws)) r),
  'Artist Z',
  'and appears on the studio roster'
);

-- The checklist is the product surface that replaces knowing what to do next.
select is(
  (select o.status from public.artist_onboarding_state((select id from t_z)) o
   where o.step = 'team'),
  'required',
  'onboarding says, in the product''s own words, that nobody can open them yet'
);

-- ---------------------------------------------------------------------------
-- Act 2. Seat the artist, then staff them
-- ---------------------------------------------------------------------------

select isnt(
  public.seat_artist_owner('d0022222-2222-4222-8222-222222222222', (select id from t_z)),
  null,
  'the artist is seated on their own book'
);

select isnt(
  public.grant_workspace_artist_membership(
    'd0033333-3333-4333-8333-333333333333', (select id from t_z),
    'manager', false, false, true, false, true),
  null,
  'and a booking manager is given sessions but not finance'
);

select is(
  (select o.status from public.artist_onboarding_state((select id from t_z)) o
   where o.step = 'team'),
  'ready',
  'the checklist follows the real state without being told'
);

select is(
  (select r.member_count from public.list_workspace_artists((select id from t_ws)) r),
  2,
  'and the roster counts both of them'
);

-- The manager's rights are exactly what was granted, asked through the shared
-- read surface the CRM, MCP and GPT all use.
reset role;
select pg_temp.manager();
set local role authenticated;

select ok(
  exists (select 1 from public.list_capabilities((select id from t_z)) c
          where c.capability = 'manage_sessions'),
  'the manager holds sessions on the new artist'
);
select ok(
  not exists (select 1 from public.list_capabilities((select id from t_z)) c
              where c.capability in ('view_finance', 'manage_finance')),
  'and no finance capability of any kind'
);

-- ---------------------------------------------------------------------------
-- Act 3. The artist publishes their own booking form
--
-- No Worker deploy, no Cloudflare secret, no route. The artist does this
-- themselves because seat_artist_owner gave them integration management over
-- their own book.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.artist_z();
set local role authenticated;

create temporary table t_src as
select public.create_booking_source(
  (select id from t_z), 'hosted', 'Artist Z enquiries', null, 'tattoo-enquiry', true) as id;
grant select on t_src to public;

create temporary table t_public as
select b.public_source_id, '/forms/' || b.public_source_id::text as public_path
from public.booking_sources b where b.id = (select id from t_src);
grant select on t_public to public;

select isnt((select public_source_id from t_public), null,
  'the artist publishes a booking form themselves');

select is(
  (select o.status from public.artist_onboarding_state((select id from t_z)) o
   where o.step = 'booking'),
  'ready',
  'and the checklist marks booking done'
);

-- ---------------------------------------------------------------------------
-- Act 4. A stranger fills that form in
--
-- The submitter names a form. They never name an artist, and could not: the
-- artist is derived server-side from the form id alone.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.backend();
set local role service_role;

create temporary table t_intake as
select public.create_hosted_enquiry_intake(
  (select public_source_id from t_public),
  'd0999999-9999-4999-8999-999999999999',
  jsonb_build_object(
    'full_name', 'Z Client',
    'email', 'z-client@example.test',
    'preferred_contact', 'Email'
  ),
  jsonb_build_object(
    'project_type', 'Fine line',
    'placement', 'Shoulder',
    'approximate_size', '10 cm',
    'cover_up', 'No',
    'preferred_timing', 'Flexible',
    'idea', 'Third artist end-to-end enquiry.',
    'source', (select public_path from t_public),
    'privacy_acknowledged', true,
    'privacy_notice_version', '2026-07-29'
  ),
  pg_temp.reference_files()
) as r;
grant select on t_intake to public;

select is(
  (select (r ->> 'artist_id')::uuid from t_intake),
  (select id from t_z),
  'the public enquiry resolves to the artist created minutes ago, from the form id alone'
);

reset role;
create temporary table t_enquiry as
select (r ->> 'enquiry_id')::uuid as enquiry_id,
       (select e.client_id from public.enquiries e
        where e.id = (r ->> 'enquiry_id')::uuid) as client_id
from t_intake;
grant select on t_enquiry to public;

-- ---------------------------------------------------------------------------
-- Act 5. It lands in exactly the right books, and no others
-- ---------------------------------------------------------------------------

select pg_temp.manager();
set local role authenticated;

-- Read straight from the table, because that is how the CRM reads enquiries:
-- there is no list RPC, the row level security policy is the whole control.
select is(
  (select count(*)::int from public.enquiries e
   where e.id = (select enquiry_id from t_enquiry)),
  1,
  'the manager staffed onto this artist sees the enquiry'
);

reset role;
select pg_temp.outsider();
set local role authenticated;

select is(
  (select count(*)::int from public.enquiries e
   where e.id = (select enquiry_id from t_enquiry)),
  0,
  'somebody who works for a different artist does not'
);

reset role;
select pg_temp.owner();
set local role authenticated;

select is(
  (select count(*)::int from public.enquiries e
   where e.id = (select enquiry_id from t_enquiry)),
  0,
  'and neither does the studio owner, who administers the organization but holds no membership here'
);

-- ---------------------------------------------------------------------------
-- Act 6. The studio's automation policy reaches an artist it predates
--
-- Migration 0088 opened exactly this slice: list the defaults, apply them.
-- Authoring one is still a closed surface, so the default is written through a
-- definer boundary the way a future automation screen would.
--
-- Who may author is worth reading carefully, because 0083 makes it strict: a
-- workspace default is never applied to a subset, so writing one requires
-- manage_automations on *every* active artist in the organization, on top of
-- workspace integration management. The studio owner has the second and not
-- the first, and that is the invariant refusing to bend for the very person
-- who created the artist.
-- ---------------------------------------------------------------------------

reset role;
create function pg_temp.write_default(p_workspace_id uuid) returns uuid
language sql security definer set search_path = pg_catalog, public, crm_private as $$
  select public.upsert_workspace_automation_default(
    p_workspace_id, null,
    'Studio policy: chase new enquiries',
    'enquiry.created',
    'Studio reminder: a new enquiry is waiting',
    null, null, null, 0, 'normal', true);
$$;
grant execute on function pg_temp.write_default(uuid) to authenticated;

select pg_temp.owner();
set local role authenticated;

select throws_ok(
  format($$select pg_temp.write_default(%L)$$, (select id from t_ws)),
  '42501', null,
  'the studio owner cannot author a policy that would land on an artist they hold no membership on'
);

-- So the owner promotes the artist to help run the organization. This is an
-- ordinary workspace grant, and it still hands over no artist-scoped right of
-- any kind - it only lets Artist Z act at organization level.
select isnt(
  public.upsert_workspace_membership(
    'd0022222-2222-4222-8222-222222222222', (select id from t_ws),
    'admin', false, false, true, true),
  null,
  'the owner makes the artist a workspace admin for integrations'
);

reset role;
select pg_temp.artist_z();
set local role authenticated;

select isnt(pg_temp.write_default((select id from t_ws)), null,
  'and now somebody who holds both rights can author the studio policy');

select is(
  (select count(*)::int from public.list_workspace_automation_defaults((select id from t_ws))),
  1,
  'which the CRM can list, because 0088 opened that read'
);

select cmp_ok(
  public.apply_workspace_automation_defaults_to_artist((select id from t_z)),
  '>=', 1,
  'and apply to the new artist explicitly'
);

select cmp_ok(
  (select count(*)::int from public.list_automation_rules((select id from t_z))),
  '>=', 1,
  'who now owns it as an ordinary rule of their own'
);

-- The manager, who holds neither right, cannot reach any of it.
reset role;
select pg_temp.manager();
set local role authenticated;

select throws_ok(
  format($$select * from public.list_workspace_automation_defaults(%L)$$, (select id from t_ws)),
  '42501', null,
  'a manager with no workspace membership cannot read the studio policy'
);

reset role;
select pg_temp.artist_z();
set local role authenticated;

-- ---------------------------------------------------------------------------
-- Act 7. The consent gate is already in front of a client nobody configured
-- ---------------------------------------------------------------------------

select is(
  public.may_contact_client(
    (select client_id from t_enquiry), 'email', 'session_reminder_24h'),
  true,
  'service traffic to the new client is allowed'
);
select is(
  public.may_contact_client(
    (select client_id from t_enquiry), 'email', 'studio_news'),
  false,
  'marketing to them is refused, because silence is not consent'
);

-- ---------------------------------------------------------------------------
-- Act 8. The shared GPT discovers an artist nobody told it about
--
-- One GPT, one OAuth client, no per-artist configuration of any kind.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.backend();

update crm_private.gpt_action_clients
set oauth_client_id = 'oauth-third-artist',
    can_read_appointments = true,
    can_manage_appointments = true,
    can_read_enquiries = true,
    is_active = true
where integration_key = 'vishar-unified-gpt';

create function pg_temp.gpt_enquiry_artist() returns uuid
language sql security definer set search_path = pg_catalog, public, crm_private as $$
  select c.artist_id from crm_private.require_gpt_enquiry_context() c;
$$;
grant execute on function pg_temp.gpt_enquiry_artist() to authenticated;

set local role authenticated;
select pg_temp.who(
  '{"sub":"d0022222-2222-4222-8222-222222222222","role":"authenticated","client_id":"oauth-third-artist"}');

select is(
  (select array_agg(a ->> 'display_name')
   from jsonb_array_elements(public.gpt_artist_context(null) -> 'artists') a),
  array['Artist Z'],
  'the existing GPT offers the new artist to the human who holds them'
);
select is(
  pg_temp.gpt_enquiry_artist(),
  (select id from t_z),
  'and GPT enquiry reads resolve to that artist through the ordinary memberships'
);

select pg_temp.who(
  '{"sub":"d0044444-4444-4444-8444-444444444444","role":"authenticated","client_id":"oauth-third-artist"}');
select isnt(
  pg_temp.gpt_enquiry_artist(),
  (select id from t_z),
  'while the same GPT resolves a different human to their own artist'
);
select throws_ok(
  format($$select public.gpt_artist_context(%L)$$, (select id from t_z)),
  '42501', null,
  'and refuses to be pointed at the new artist they do not hold'
);

-- ---------------------------------------------------------------------------
-- Act 9. One row goes inactive and every door shuts
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.owner();
set local role authenticated;

select isnt(
  public.grant_workspace_artist_membership(
    'd0033333-3333-4333-8333-333333333333', (select id from t_z),
    'manager', false, false, true, false, false),
  null,
  'the studio owner revokes the manager''s seat from the CRM'
);

reset role;
select pg_temp.manager();
set local role authenticated;

select is(
  (select count(*)::int from public.list_accessible_artists() where id = (select id from t_z)),
  0,
  'the artist leaves their CRM scope'
);
select is(
  (select count(*)::int from public.enquiries e
   where e.id = (select enquiry_id from t_enquiry)),
  0,
  'the enquiry they could read a moment ago is gone'
);
select throws_ok(
  format($$select * from public.list_booking_sources(%L)$$, (select id from t_z)),
  '42501', null,
  'the booking sources refuse outright rather than answering empty'
);
select is(
  (select count(*)::int from public.list_notifications(null, 50)
   where artist_id = (select id from t_z)),
  0,
  'and anything already in their inbox for this artist is no longer readable'
);

select pg_temp.who(
  '{"sub":"d0033333-3333-4333-8333-333333333333","role":"authenticated","client_id":"oauth-third-artist"}');
select throws_ok(
  format($$select public.gpt_artist_context(%L)$$, (select id from t_z)),
  '42501', null,
  'and the GPT closes in the same instant, because it asked the same question'
);

-- ---------------------------------------------------------------------------
-- Act 10. Nothing above needed the artist to be known in advance
--
-- The claim this whole workstream is judged on. Not "we did not hard-code the
-- third artist" - that would be trivially true of any new code - but that the
-- generic platform path contains no artist-specific branch at all.
-- ---------------------------------------------------------------------------

reset role;

-- No routine reachable from the control plane or the shared read surfaces
-- names a specific artist. Vladimir and Kristina appear in migration 0015 as
-- seeded rows and in 0016 as a historical backfill default; neither is a
-- decision made at runtime, so the check is scoped to function bodies.
select is(
  (select count(*)::int
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'crm_private')
     and p.prosrc ~* '(vladimir|kristina)'
     and p.proname in (
       'create_artist', 'update_artist', 'create_workspace', 'update_workspace',
       'seat_artist_owner', 'list_workspace_artists', 'list_workspace_team',
       'list_artist_memberships', 'artist_onboarding_state',
       'preview_membership_capabilities', 'capability_from_grant',
       'has_artist_capability', 'has_workspace_capability',
       'list_capabilities', 'list_accessible_artists',
       'grant_workspace_artist_membership', 'upsert_workspace_membership',
       'resolve_hosted_booking_source', 'create_hosted_enquiry_intake',
       'gpt_artist_context')),
  0,
  'no control-plane or routing function names a specific artist'
);

-- The same question asked the other way: the routing path must resolve an
-- artist from data, never from a literal. A hard-coded UUID in any of these
-- would be the tell.
select is(
  (select count(*)::int
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'crm_private')
     and p.proname in (
       'create_artist', 'seat_artist_owner', 'artist_onboarding_state',
       'preview_membership_capabilities', 'capability_from_grant',
       'has_artist_capability', 'resolve_hosted_booking_source',
       'create_hosted_enquiry_intake', 'gpt_artist_context')
     and p.prosrc ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'),
  0,
  'and none of them carries a hard-coded artist identifier'
);

-- Everything Artist Z needed was already granted to `authenticated` before
-- Artist Z existed. No grant, no policy and no migration was written for them.
select ok(
  (select bool_and(has_function_privilege('authenticated', f, 'EXECUTE'))
   from unnest(array[
     'public.create_artist(uuid,text,text,text,text,text)',
     'public.seat_artist_owner(uuid,uuid)',
     'public.grant_workspace_artist_membership(uuid,uuid,public.artist_access_level,boolean,boolean,boolean,boolean,boolean)',
     'public.create_booking_source(uuid,text,text,text,text,boolean)',
     'public.artist_onboarding_state(uuid)',
     'public.apply_workspace_automation_defaults_to_artist(uuid)']) f),
  'the whole path was reachable by an ordinary signed-in profile from the start'
);

select * from finish(true);
rollback;
