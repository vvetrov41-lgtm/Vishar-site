-- 192_team_access_management.sql
--
-- Team invitation, atomic CRM provisioning, artist capability management and
-- fail-closed role/isolation behavior. Every identity and email is synthetic.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'team-owner@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'team-manager@example.test'),
  ('33333333-3333-4333-8333-333333333333', 'team-reader@example.test'),
  ('44444444-4444-4444-8444-444444444444', 'kristina-only@example.test'),
  ('55555555-5555-4555-8555-555555555555', 'profile-no-membership@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('11111111-1111-4111-8111-111111111111', 'team-owner@example.test', 'Team Owner', 'owner', true),
  ('22222222-2222-4222-8222-222222222222', 'team-manager@example.test', 'Team Manager', 'booking_manager', true),
  ('33333333-3333-4333-8333-333333333333', 'team-reader@example.test', 'Team Reader', 'read_only', true),
  ('44444444-4444-4444-8444-444444444444', 'kristina-only@example.test', 'Kristina Only', 'booking_manager', true),
  ('55555555-5555-4555-8555-555555555555', 'profile-no-membership@example.test', 'No Membership', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('22222222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, false, true),
  ('44444444-4444-4444-8444-444444444444', 'a2222222-2222-4222-8222-222222222222',
   'artist', false, false, true, false, true),
  ('33333333-3333-4333-8333-333333333333', 'a1111111-1111-4111-8111-111111111111',
   'read_only', false, false, false, false, true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to anon, authenticated, service_role;

create temporary table invite_result (r jsonb not null);
grant select, insert on invite_result to authenticated;

select ok(not has_table_privilege('authenticated', 'crm_private.staff_invites', 'SELECT'),
  'the browser cannot read private invitation state');
select ok(not has_table_privilege('service_role', 'crm_private.staff_invites', 'SELECT'),
  'the backend secret has no generic invitation-table read path');
select ok(has_function_privilege('authenticated', 'public.begin_staff_invite(uuid,text,text,public.crm_role,jsonb)', 'EXECUTE'),
  'authenticated may reach the named begin RPC whose body checks owner role');
select ok(not has_function_privilege('service_role', 'public.begin_staff_invite(uuid,text,text,public.crm_role,jsonb)', 'EXECUTE'),
  'service_role cannot bypass the owner JWT through begin_staff_invite');
select ok(not has_function_privilege('anon', 'public.finalize_staff_invite(uuid)', 'EXECUTE'),
  'anonymous callers cannot finalise staff access');

-- Manager and read-only denial, including self-escalation attempts.
set local role authenticated;
select pg_temp.claims('{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}');
select throws_ok(
  $$select * from public.list_team_memberships()$$,
  '42501', null, 'booking_manager cannot list the team access graph'
);
select throws_ok(
  $$select public.begin_staff_invite(
      '20000000-0000-4000-8000-000000000001', 'blocked@example.test', null,
      'booking_manager',
      '[{"artist_id":"a1111111-1111-4111-8111-111111111111","access_level":"manager"}]'
    )$$,
  '42501', null, 'booking_manager cannot invite staff'
);
select throws_ok(
  $$select public.set_profile_role('22222222-2222-4222-8222-222222222222', 'owner')$$,
  '42501', null, 'a manager cannot promote themselves'
);
select throws_ok(
  $$select public.upsert_artist_membership(
      '22222222-2222-4222-8222-222222222222',
      'a2222222-2222-4222-8222-222222222222',
      'manager', false, false, true, true, true
    )$$,
  '42501', null, 'a manager cannot widen their own artist memberships'
);
reset role;

set local role authenticated;
select pg_temp.claims('{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}');
select throws_ok(
  $$select public.begin_staff_invite(
      '30000000-0000-4000-8000-000000000001', 'blocked-reader@example.test', null,
      'read_only',
      '[{"artist_id":"a1111111-1111-4111-8111-111111111111","access_level":"read_only"}]'
    )$$,
  '42501', null, 'read_only cannot invite staff'
);
reset role;

-- Existing effective isolation remains membership-authoritative.
set local role authenticated;
select pg_temp.claims('{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated"}');
select is((select slug from public.list_accessible_artists()), 'kristina',
  'Kristina-only profile sees only Kristina');
select ok(not public.can_access_artist('a1111111-1111-4111-8111-111111111111'),
  'Kristina-only profile cannot access Vladimir scope');
select ok(public.can_manage_artist_sessions('a2222222-2222-4222-8222-222222222222'),
  'Kristina artist membership can manage Kristina appointments');
select ok(not public.can_view_artist_finance('a2222222-2222-4222-8222-222222222222'),
  'Kristina finance remains disabled without the explicit flag');
select ok(not public.can_manage_artist_integrations('a2222222-2222-4222-8222-222222222222'),
  'Kristina integrations remain disabled without the explicit flag');
reset role;

set local role authenticated;
select pg_temp.claims('{"sub":"55555555-5555-4555-8555-555555555555","role":"authenticated"}');
select is((select count(*)::int from public.list_accessible_artists()), 0,
  'an active profile without membership has no artist access');
reset role;

-- Owner-only validation rejects second-owner invites and invalid capability combinations.
set local role authenticated;
select pg_temp.claims('{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}');
select is((select count(*)::int from public.list_team_memberships()), 5,
  'the owner sees the complete current team access graph');
select throws_ok(
  $$select public.begin_staff_invite(
      '10000000-0000-4000-8000-000000000001', 'second-owner@example.test', null,
      'owner',
      '[{"artist_id":"a1111111-1111-4111-8111-111111111111","access_level":"owner"}]'
    )$$,
  '22023', null, 'invite flow cannot create a second owner'
);
select throws_ok(
  $$select public.begin_staff_invite(
      '10000000-0000-4000-8000-000000000002', 'bad-reader@example.test', null,
      'read_only',
      '[{"artist_id":"a1111111-1111-4111-8111-111111111111","access_level":"manager","can_manage_sessions":true}]'
    )$$,
  '22023', null, 'read_only invitation cannot receive management capabilities'
);
select throws_ok(
  $$select public.begin_staff_invite(
      '10000000-0000-4000-8000-000000000003', 'null-access@example.test', null,
      'booking_manager',
      '[{"artist_id":"a1111111-1111-4111-8111-111111111111","access_level":null}]'
    )$$,
  '22023', null, 'null artist access fails before any pending invitation is created'
);

insert into invite_result (r)
select public.begin_staff_invite(
  '88888888-8888-4888-8888-888888888888',
  '  NEW.MANAGER@EXAMPLE.TEST ',
  'Synthetic New Manager',
  'booking_manager',
  '[
    {"artist_id":"a2222222-2222-4222-8222-222222222222","access_level":"manager","can_manage_sessions":true},
    {"artist_id":"a1111111-1111-4111-8111-111111111111","access_level":"manager","can_manage_sessions":true}
  ]'
);

select is((select r ->> 'email_normalized' from invite_result), 'new.manager@example.test',
  'invite email is trimmed and lowercased before Auth Admin receives it');
select is((select r ->> 'status' from invite_result), 'pending',
  'database preparation starts in a pending state');
select is((select count(*)::int from public.profiles where email = 'new.manager@example.test'), 0,
  'no active or inactive profile is created before the Auth account exists');
select is((select count(*)::int from public.activity_log where event_type = 'profile.invite_requested'), 1,
  'invite preparation is audited once');
reset role;

-- A bearer identity with no profile remains fully closed while the external
-- Auth invitation/finalisation boundary is incomplete.
set local role authenticated;
select pg_temp.claims('{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated"}');
select is((select count(*)::int from public.list_accessible_artists()), 0,
  'an Auth identity without an active profile receives no CRM artist access');
reset role;

-- Simulate only the trusted Auth Admin result. No password or invite token is
-- created or stored in this database test.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into auth.users (id, email)
values ('99999999-9999-4999-8999-999999999999', 'new.manager@example.test');

set local role authenticated;
select pg_temp.claims('{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}');
select is(
  (public.finalize_staff_invite((select (r ->> 'invite_request_id')::uuid from invite_result)) ->> 'status'),
  'provisioned',
  'owner finalises the prepared invitation after Auth user creation'
);
select is((select count(*)::int from public.profiles where id = '99999999-9999-4999-8999-999999999999' and is_active), 1,
  'profile becomes active only after complete provisioning');
select is((select count(*)::int from public.artist_memberships where profile_id = '99999999-9999-4999-8999-999999999999' and is_active), 2,
  'manager receives exactly the two prepared memberships');
select ok((select bool_and(can_manage_sessions and not can_view_finance and not can_manage_finance and not can_manage_integrations)
           from public.artist_memberships where profile_id = '99999999-9999-4999-8999-999999999999'),
  'manager defaults allow appointments while finance and integrations remain disabled');
select is((select count(*)::int from public.activity_log where event_type = 'profile.provisioned'), 1,
  'profile provisioning is audited once');
select is((select count(*)::int from public.activity_log where event_type = 'membership.updated'
           and profile_id = '99999999-9999-4999-8999-999999999999'), 2,
  'each provisioned artist membership is audited');

select is(
  (public.begin_staff_invite(
    '88888888-8888-4888-8888-888888888888',
    'new.manager@example.test',
    'Synthetic New Manager',
    'booking_manager',
    '[
      {"artist_id":"a1111111-1111-4111-8111-111111111111","access_level":"manager","can_manage_sessions":true},
      {"artist_id":"a2222222-2222-4222-8222-222222222222","access_level":"manager","can_manage_sessions":true}
    ]'
  ) ->> 'status'),
  'provisioned',
  'replaying the same invite returns the existing provisioned state'
);
select ok(
  (public.finalize_staff_invite((select (r ->> 'invite_request_id')::uuid from invite_result)) ->> 'idempotent_replay')::boolean,
  'finalisation replay is explicitly marked idempotent'
);
select is((select count(*)::int from public.profiles where email = 'new.manager@example.test'), 1,
  'invite replay creates no duplicate profile');
select is((select count(*)::int from public.artist_memberships where profile_id = '99999999-9999-4999-8999-999999999999'), 2,
  'invite replay creates no duplicate memberships');
select is((select count(*)::int from public.activity_log where event_type = 'profile.provisioned'), 1,
  'invite replay creates no duplicate provisioning audit event');
select throws_ok(
  $$select public.begin_staff_invite(
      '88888888-8888-4888-8888-888888888888',
      'different@example.test', null, 'booking_manager',
      '[{"artist_id":"a1111111-1111-4111-8111-111111111111","access_level":"manager","can_manage_sessions":true}]'
    )$$,
  '22023', null, 'an idempotency key cannot be reused for a different invitation'
);

select throws_ok(
  $$select public.set_profile_active('11111111-1111-4111-8111-111111111111', false)$$,
  '22023', null, 'minimum active owner invariant remains enforced'
);

-- Role narrowing clears stored flags, not merely effective helper results.
select public.set_profile_role('22222222-2222-4222-8222-222222222222', 'read_only');
select ok((select bool_and(
             access_level = 'read_only'
             and not can_view_finance
             and not can_manage_finance
             and not can_manage_sessions
             and not can_manage_integrations
           ) from public.artist_memberships where profile_id = '22222222-2222-4222-8222-222222222222'),
  'demotion to read_only clears all stored management capabilities');
reset role;

-- The newly provisioned shared manager sees both artist scopes but no implicit
-- finance/integration capability in either scope.
set local role authenticated;
select pg_temp.claims('{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated"}');
select is((select count(*)::int from public.list_accessible_artists()), 2,
  'manager with two memberships sees both permitted artist scopes');
select ok(public.can_manage_artist_sessions('a1111111-1111-4111-8111-111111111111')
          and public.can_manage_artist_sessions('a2222222-2222-4222-8222-222222222222'),
  'manager may manage sessions in both explicit scopes');
select ok(not public.can_view_artist_finance('a1111111-1111-4111-8111-111111111111')
          and not public.can_manage_artist_finance('a2222222-2222-4222-8222-222222222222')
          and not public.can_manage_artist_integrations('a1111111-1111-4111-8111-111111111111'),
  'manager receives no finance or integration authority without explicit flags');
reset role;

-- Named responses and audit metadata contain no credential-bearing fields.
select ok(not exists (
  select 1 from jsonb_object_keys((select r from invite_result)) as keys(key_name)
  where key_name in ('password', 'token', 'access_token', 'refresh_token', 'secret', 'service_role_key')
), 'invite RPC response contains no credential field');
select ok(not exists (
  select 1
  from public.activity_log a,
       lateral jsonb_object_keys(a.metadata) as keys(key_name)
  where a.event_type in ('profile.invite_requested', 'profile.provisioned', 'membership.updated')
    and key_name in ('password', 'token', 'access_token', 'refresh_token', 'secret', 'service_role_key')
), 'team audit metadata contains no credential field');

select * from finish(true);
rollback;
