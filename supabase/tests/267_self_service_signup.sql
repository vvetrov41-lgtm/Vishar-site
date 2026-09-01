-- 267_self_service_signup.sql
--
-- Migration 0130: a stranger with a verified email address becomes a complete,
-- isolated tenant without an invitation - and becomes nothing else.
--
-- The scenarios this file is responsible for:
--
--   the door starts shut, and only the installation owner opens it
--   an unverified address creates nothing
--   one call creates the whole tenant, a second call creates none of it again
--   the new artist cannot see, reach or seat themselves on an existing artist
--   the new artist does not become an installation owner
--   an invited account is refused this path and keeps its own
--   the rolling window and the founder cap both refuse rather than absorb
--   0087's original refusal - administer nothing, found nothing - still holds

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Act 0. The cast
--
-- `a1111111-…` is the artist the migrations create. It stands in for an
-- incumbent production book: it already has an enquiry and a project, and the
-- point of most of this file is that the newcomer never touches either.
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('55011111-1111-4111-8111-111111111111', 'ss-owner@example.test', now()),
  ('55022222-2222-4222-8222-222222222222', 'ss-incumbent@example.test', now()),
  ('55033333-3333-4333-8333-333333333333', 'ss-newcomer@example.test', now()),
  ('55044444-4444-4444-8444-444444444444', 'ss-unverified@example.test', null),
  ('55055555-5555-4555-8555-555555555555', 'ss-second@example.test', now()),
  ('55066666-6666-4666-8666-666666666666', 'ss-third@example.test', now());

insert into public.profiles (id, email, display_name, role, is_active) values
  ('55011111-1111-4111-8111-111111111111', 'ss-owner@example.test',
   'Installation Owner', 'owner', true),
  ('55022222-2222-4222-8222-222222222222', 'ss-incumbent@example.test',
   'Incumbent Artist', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('55022222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111',
   'artist', true, true, true, true, true);

insert into public.clients (id, full_name, email) values
  ('55c11111-1111-4111-8111-111111111111', 'Incumbent Client', 'ss-incumbent-client@example.test');

insert into public.enquiries (
  id, client_id, reference_number, idempotency_key, intake_fingerprint,
  intake_state, submitted_full_name, submitted_email, idea, source,
  privacy_notice_version, privacy_acknowledged_at, artist_id
) values
  ('55e11111-1111-4111-8111-111111111111',
   '55c11111-1111-4111-8111-111111111111', 'placeholder',
   '55711111-1111-4111-8111-111111111111', repeat('5', 64),
   'complete', 'Incumbent Client', 'ss-incumbent-client@example.test',
   'Synthetic incumbent enquiry', 'pgtap', '2026-07-29', now(),
   'a1111111-1111-4111-8111-111111111111');

insert into public.projects (
  id, client_id, enquiry_id, status, title,
  hourly_rate, estimate_total, currency, artist_id
) values
  ('55b11111-1111-4111-8111-111111111111',
   '55c11111-1111-4111-8111-111111111111',
   '55e11111-1111-4111-8111-111111111111',
   'active', 'Incumbent Project', 150.00, 1200.00, 'GBP',
   'a1111111-1111-4111-8111-111111111111');

create function pg_temp.owner() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"55011111-1111-4111-8111-111111111111","role":"authenticated"}', true)::void;
$$;
create function pg_temp.incumbent() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"55022222-2222-4222-8222-222222222222","role":"authenticated"}', true)::void;
$$;
create function pg_temp.newcomer() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"55033333-3333-4333-8333-333333333333","role":"authenticated"}', true)::void;
$$;
create function pg_temp.unverified() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"55044444-4444-4444-8444-444444444444","role":"authenticated"}', true)::void;
$$;
create function pg_temp.second() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"55055555-5555-4555-8555-555555555555","role":"authenticated"}', true)::void;
$$;
create function pg_temp.third() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"55066666-6666-4666-8666-666666666666","role":"authenticated"}', true)::void;
$$;
create function pg_temp.backend() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', true)::void;
$$;
grant execute on function pg_temp.owner() to authenticated, service_role;
grant execute on function pg_temp.incumbent() to authenticated, service_role;
grant execute on function pg_temp.newcomer() to authenticated, service_role;
grant execute on function pg_temp.unverified() to authenticated, service_role;
grant execute on function pg_temp.second() to authenticated, service_role;
grant execute on function pg_temp.third() to authenticated, service_role;
grant execute on function pg_temp.backend() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Act 1. Applying the migration opens nothing
--
-- The most important assertion in the file, because it is the one that decides
-- whether a deployment is a behaviour change or not.
-- ---------------------------------------------------------------------------

select is(
  (select is_open from crm_private.self_service_settings where id),
  false,
  'public signup is closed by default, so applying 0130 changes no behaviour'
);

reset role;
select pg_temp.newcomer();
set local role authenticated;

select is(
  (select public.self_service_signup_policy() ->> 'is_open'),
  'false',
  'the policy read a signed-out login screen makes says the door is shut'
);

select throws_ok(
  $$select public.bootstrap_artist_account('Newcomer')$$,
  '42501', null,
  'the bootstrap refuses on its own authority while signup is closed'
);

select is(
  (select count(*)::int from public.profiles p
    where p.id = '55033333-3333-4333-8333-333333333333'),
  0,
  'a refused bootstrap leaves no profile behind'
);

-- ---------------------------------------------------------------------------
-- Act 2. Only the installation owner opens it
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select public.set_self_service_signup(true)$$,
  '42501', null,
  'a signed-in account that is not the installation owner cannot open signup'
);

reset role;
select pg_temp.incumbent();
set local role authenticated;

select throws_ok(
  $$select public.set_self_service_signup(true)$$,
  '42501', null,
  'an artist who owns their own organization still cannot open signup'
);

reset role;
select pg_temp.owner();
set local role authenticated;

select is(
  (select public.set_self_service_signup(true, 20, 3) ->> 'is_open'),
  'true',
  'the installation owner opens signup'
);

-- ---------------------------------------------------------------------------
-- Act 3. An unverified address creates nothing
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.unverified();
set local role authenticated;

select throws_ok(
  $$select public.bootstrap_artist_account('Unverified Person')$$,
  '42501', null,
  'an account whose email address is not confirmed cannot create a tenant'
);

select is(
  (select count(*)::int from public.profiles p
    where p.id = '55044444-4444-4444-8444-444444444444'),
  0,
  'the unverified account has no profile'
);

-- ---------------------------------------------------------------------------
-- Act 4. One call, the whole tenant
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.newcomer();
set local role authenticated;

select lives_ok(
  $$select public.bootstrap_artist_account('Nina Newcomer', 'Nina Ink', 'Europe/Berlin', 'EUR')$$,
  'a verified account with no invitation sets itself up'
);

reset role;

select is(
  (select p.role::text from public.profiles p
    where p.id = '55033333-3333-4333-8333-333333333333'),
  'booking_manager',
  'the new profile is a booking manager - public signup never mints an installation owner'
);

select is(
  (select w.workspace_type::text
     from crm_private.self_service_accounts s
     join public.workspaces w on w.id = s.workspace_id
    where s.profile_id = '55033333-3333-4333-8333-333333333333'),
  'solo',
  'the organization founded for them is solo'
);

select is(
  (select w.display_name
     from crm_private.self_service_accounts s
     join public.workspaces w on w.id = s.workspace_id
    where s.profile_id = '55033333-3333-4333-8333-333333333333'),
  'Nina Ink',
  'the studio name they typed names the organization'
);

select is(
  (select a.display_name || ' · ' || a.timezone || ' · ' || a.default_currency
     from crm_private.self_service_accounts s
     join public.artists a on a.id = s.artist_id
    where s.profile_id = '55033333-3333-4333-8333-333333333333'),
  'Nina Newcomer · Europe/Berlin · EUR',
  'the artist carries the name, timezone and currency they gave'
);

select is(
  (select m.access_level::text || ':' || m.can_view_finance::text || m.can_manage_finance::text
          || m.can_manage_sessions::text || m.can_manage_integrations::text
     from crm_private.self_service_accounts s
     join public.artist_memberships m
       on m.artist_id = s.artist_id and m.profile_id = s.profile_id
    where s.profile_id = '55033333-3333-4333-8333-333333333333'),
  'artist:truetruetruetrue',
  'they hold their own book at artist level with every capability'
);

select is(
  (select wm.workspace_role::text
     from crm_private.self_service_accounts s
     join public.workspace_memberships wm
       on wm.workspace_id = s.workspace_id and wm.profile_id = s.profile_id
    where s.profile_id = '55033333-3333-4333-8333-333333333333'),
  'owner',
  'they own the organization they just founded'
);

select is(
  (select count(*)::int from public.activity_log l
    where l.event_type = 'signup.tenant_created'
      and l.actor_profile_id = '55033333-3333-4333-8333-333333333333'),
  1,
  'the tenant creation is on the audit trail'
);

-- ---------------------------------------------------------------------------
-- Act 5. Idempotency
--
-- A double-tapped Continue, a retried request, a refreshed tab: all of them
-- return the first answer and none of them creates a second anything.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.newcomer();
set local role authenticated;

select is(
  (select public.bootstrap_artist_account('Someone Else Entirely', 'Other Studio') ->> 'created'),
  'false',
  'a repeated bootstrap reports that it created nothing'
);

-- Compared against what this session can actually see rather than against the
-- ledger: exactly one artist is visible to them, so "the same artist" and "the
-- only artist they hold" are the same statement.
select is(
  (select public.bootstrap_artist_account('Someone Else Entirely') ->> 'artist_id'),
  (select a.id::text from public.artists a),
  'a repeated bootstrap returns the tenant that already exists'
);

reset role;

select is(
  (select count(*)::int from public.profiles p
    where p.id = '55033333-3333-4333-8333-333333333333'),
  1,
  'still exactly one profile'
);
select is(
  (select count(*)::int from crm_private.self_service_accounts s
    where s.profile_id = '55033333-3333-4333-8333-333333333333'),
  1,
  'still exactly one self-service tenant'
);
select is(
  (select count(*)::int from public.artist_memberships m
    where m.profile_id = '55033333-3333-4333-8333-333333333333'),
  1,
  'still exactly one artist membership'
);
select is(
  (select count(*)::int from public.workspace_memberships wm
    where wm.profile_id = '55033333-3333-4333-8333-333333333333'),
  1,
  'still exactly one workspace membership'
);
select is(
  (select a.display_name
     from crm_private.self_service_accounts s
     join public.artists a on a.id = s.artist_id
    where s.profile_id = '55033333-3333-4333-8333-333333333333'),
  'Nina Newcomer',
  'a repeated call with different arguments does not rewrite the tenant'
);

-- ---------------------------------------------------------------------------
-- Act 6. The newcomer sees their own tenant and nothing else
--
-- This is the requirement the whole workstream stands or falls on.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.newcomer();
set local role authenticated;

select is(
  (select count(*)::int from public.enquiries e
    where e.id = '55e11111-1111-4111-8111-111111111111'),
  0,
  'the incumbent artist''s enquiry is not visible to the newcomer'
);
select is(
  (select count(*)::int from public.projects pr
    where pr.id = '55b11111-1111-4111-8111-111111111111'),
  0,
  'the incumbent artist''s project is not visible to the newcomer'
);
select is(
  (select count(*)::int from public.clients c
    where c.id = '55c11111-1111-4111-8111-111111111111'),
  0,
  'the incumbent artist''s client is not visible to the newcomer'
);
select is(
  (select count(*)::int from public.artists a
    where a.id = 'a1111111-1111-4111-8111-111111111111'),
  0,
  'the newcomer cannot even enumerate the incumbent artist'
);
select is(
  (select count(*)::int from public.artists a),
  1,
  'exactly one artist is visible to the newcomer: their own'
);
select is(
  (select count(*)::int from public.profiles p),
  1,
  'the newcomer sees only their own profile, not the CRM''s people'
);

select throws_ok(
  $$select public.artist_control_plane_context('a1111111-1111-4111-8111-111111111111')$$,
  '42501', null,
  'opening the incumbent artist''s administration screen is refused'
);

select throws_ok(
  $$select public.artist_onboarding_state('a1111111-1111-4111-8111-111111111111')$$,
  '42501', null,
  'reading the incumbent artist''s onboarding is refused'
);

select throws_ok(
  $$select public.seat_artist_owner(
      '55033333-3333-4333-8333-333333333333',
      'a1111111-1111-4111-8111-111111111111')$$,
  '42501', null,
  'the newcomer cannot seat themselves on an existing artist'
);

select throws_ok(
  $$select public.grant_workspace_artist_membership(
      '55033333-3333-4333-8333-333333333333',
      'a1111111-1111-4111-8111-111111111111',
      'artist', true, true, true, true)$$,
  '42501', null,
  'the newcomer cannot grant themselves access to an existing artist'
);

select throws_ok(
  $$select public.update_artist('a1111111-1111-4111-8111-111111111111', 'Renamed')$$,
  '42501', null,
  'the newcomer cannot administer an existing artist'
);

-- ---------------------------------------------------------------------------
-- Act 7. And is not an installation owner
-- ---------------------------------------------------------------------------

select is(public.is_owner(), false, 'the newcomer is not the installation owner');

select throws_ok(
  $$select public.set_self_service_signup(false)$$,
  '42501', null,
  'the newcomer cannot close the door behind themselves'
);

select throws_ok(
  $$select public.bootstrap_owner('55033333-3333-4333-8333-333333333333')$$,
  '42501', null,
  'owner bootstrap is not reachable from a self-service session'
);

-- No subquery: the table privilege is checked before RLS and before any
-- constraint, so this refuses for the reason being tested rather than for a
-- second permission failure inside the arguments.
select throws_ok(
  $$insert into public.artists (workspace_id, slug, display_name, booking_reference_prefix)
    values (gen_random_uuid(), 'direct-write', 'Direct Write', 'DWX')$$,
  '42501', null,
  'the browser role still holds no direct write on public.artists'
);

select throws_ok(
  $$select count(*) from crm_private.self_service_settings$$,
  '42501', null,
  'the signup switch is not readable from an API role'
);

-- ---------------------------------------------------------------------------
-- Act 8. The invitation flow keeps its own door
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.incumbent();
set local role authenticated;

select throws_ok(
  $$select public.bootstrap_artist_account('Incumbent Second Tenant')$$,
  '42501', null,
  'an account that already has a CRM profile cannot found a second tenant here'
);

select is(
  (select count(*)::int from public.artist_memberships m
    where m.profile_id = '55022222-2222-4222-8222-222222222222'),
  1,
  'the invited artist keeps exactly the access their invitation gave them'
);
select is(
  (select count(*)::int from public.enquiries e
    where e.id = '55e11111-1111-4111-8111-111111111111'),
  1,
  'and can still read their own work after the newcomer exists'
);

-- ---------------------------------------------------------------------------
-- Act 9. The rolling window refuses rather than absorbing
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.owner();
set local role authenticated;
select public.set_self_service_signup(true, 1, 3);

reset role;
select pg_temp.second();
set local role authenticated;

select throws_ok(
  $$select public.bootstrap_artist_account('Too Soon')$$,
  '53400', null,
  'the hourly cap refuses a further tenant instead of quietly creating one'
);

select is(
  (select count(*)::int from public.profiles p
    where p.id = '55055555-5555-4555-8555-555555555555'),
  0,
  'a rate-limited signup leaves nothing behind either'
);

reset role;
select pg_temp.owner();
set local role authenticated;
select public.set_self_service_signup(true, 20, 1);

reset role;
select pg_temp.second();
set local role authenticated;

select lives_ok(
  $$select public.bootstrap_artist_account('Second Newcomer')$$,
  'raising the cap admits the next artist'
);

-- ---------------------------------------------------------------------------
-- Act 10. A self-service founder may not found without limit
--
-- max_workspaces_per_founder is 1 now, and they already administer the solo
-- organization the bootstrap founded.
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select public.create_workspace('Endless Studio', 'studio')$$,
  '42501', null,
  'a self-service founder at their allowance cannot found another organization'
);

select is(
  (select (public.control_plane_access()).can_found_workspace),
  false,
  'and the interface is told so by the same predicate the database refuses with'
);

-- The cap is for self-service accounts. Nobody else is in the ledger, so
-- nobody else is affected - which is the whole reason it lives where it does.
reset role;
select pg_temp.incumbent();
set local role authenticated;

select is(
  (select (public.control_plane_access()).can_found_workspace),
  true,
  'an invited artist who owns their organization is not capped'
);
select lives_ok(
  $$select public.create_workspace('Invited Studio', 'studio')$$,
  'and can still found an organization exactly as before'
);

-- ---------------------------------------------------------------------------
-- Act 11. 0087's original refusal is untouched
--
-- pgTAP 235 pins this too. Repeated here because 0130 rewrote the function it
-- lives in, and a regression would be silent everywhere else.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.third();
set local role authenticated;

select throws_ok(
  $$select public.create_workspace('Squatter Studio', 'studio')$$,
  '42501', null,
  'an account that administers no organization still cannot found one'
);

-- ---------------------------------------------------------------------------
-- Act 12. Closing the door
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.owner();
set local role authenticated;
select public.set_self_service_signup(false);

reset role;
select pg_temp.third();
set local role authenticated;

select throws_ok(
  $$select public.bootstrap_artist_account('Late Arrival')$$,
  '42501', null,
  'closing signup stops new tenants immediately'
);

reset role;
select pg_temp.newcomer();
set local role authenticated;

select is(
  (select public.bootstrap_artist_account('Nina Newcomer') ->> 'created'),
  'false',
  'and does not strand somebody who already completed setup'
);

select * from finish();
rollback;
