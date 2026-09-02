-- 270_tenant_scoped_invitation.sql
--
-- Migration 0133: an artist who manages their own artist can bring one person
-- onto it, and can reach nothing else in doing so.
--
-- This file is written around the ways the door could be pushed open rather
-- than the way it is meant to be used. What it is responsible for:
--
--   the switch starts closed, and only the installation owner moves it
--   an unconfirmed inviter sends nothing
--   manage_team on the named artist is the whole authorization
--   naming somebody else's artist is refused, and refused the same way as
--     naming one that does not exist
--   the grant cannot exceed what the caller holds on that artist
--   the invited profile is a booking_manager on exactly one artist
--   an address that already exists produces the same answer as a fresh invite
--   the windows refuse rather than absorb
--   expiry and replay
--   the owner path is untouched
--
-- Every identity and address here is synthetic.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('88011111-1111-4111-8111-111111111111', 'ti-owner@example.test', now()),
  ('88022222-2222-4222-8222-222222222222', 'ti-founder@example.test', now()),
  ('88033333-3333-4333-8333-333333333333', 'ti-other-founder@example.test', now()),
  ('88044444-4444-4444-8444-444444444444', 'ti-unconfirmed@example.test', null),
  ('88055555-5555-4555-8555-555555555555', 'ti-existing@example.test', now()),
  -- The Auth identities the Worker would have minted before finalize runs.
  ('88066666-6666-4666-8666-666666666666', 'ti-invitee@example.test', now()),
  ('88077777-7777-4777-8777-777777777777', 'ti-invitee-two@example.test', now());

insert into public.profiles (id, email, display_name, role, is_active) values
  ('88011111-1111-4111-8111-111111111111', 'ti-owner@example.test',
   'Installation Owner', 'owner', true),
  ('88055555-5555-4555-8555-555555555555', 'ti-existing@example.test',
   'Already Here', 'booking_manager', true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to anon, authenticated, service_role;

create function pg_temp.owner() returns void language sql as $$
  select pg_temp.claims('{"sub":"88011111-1111-4111-8111-111111111111","role":"authenticated"}');
$$;
create function pg_temp.founder() returns void language sql as $$
  select pg_temp.claims('{"sub":"88022222-2222-4222-8222-222222222222","role":"authenticated"}');
$$;
create function pg_temp.other() returns void language sql as $$
  select pg_temp.claims('{"sub":"88033333-3333-4333-8333-333333333333","role":"authenticated"}');
$$;
create function pg_temp.unconfirmed() returns void language sql as $$
  select pg_temp.claims('{"sub":"88044444-4444-4444-8444-444444444444","role":"authenticated"}');
$$;
grant execute on function pg_temp.owner() to authenticated, service_role;
grant execute on function pg_temp.founder() to authenticated, service_role;
grant execute on function pg_temp.other() to authenticated, service_role;
grant execute on function pg_temp.unconfirmed() to authenticated, service_role;

create temporary table ti_result (label text not null, r jsonb not null);
grant select, insert on ti_result to authenticated;

-- ---------------------------------------------------------------------------
-- The cast
--
-- Two self-service tenants founded the ordinary way, so the artists, the
-- workspaces and the memberships are exactly what signup produces rather than
-- something this file arranged to suit itself.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.owner();
set local role authenticated;
select public.set_self_service_signup(true);
reset role;

select pg_temp.founder();
set local role authenticated;
select public.bootstrap_artist_account('Founder One', 'Studio One');
reset role;

select pg_temp.other();
set local role authenticated;
select public.bootstrap_artist_account('Founder Two', 'Studio Two');
reset role;

-- security definer because the test calls it while acting as an artist, and an
-- artist cannot read the private ledger. It resolves a fixture id, nothing more.
create function pg_temp.artist_of(p_profile uuid) returns uuid
language sql stable security definer as $$
  select a.artist_id from crm_private.self_service_accounts a where a.profile_id = p_profile;
$$;
grant execute on function pg_temp.artist_of(uuid) to authenticated, service_role;

-- The unconfirmed account is seated on the founder's artist by hand: it has to
-- hold manage_team so that the only thing left refusing it is its own
-- unverified address.
insert into public.profiles (id, email, display_name, role, is_active) values
  ('88044444-4444-4444-8444-444444444444', 'ti-unconfirmed@example.test',
   'Unconfirmed Helper', 'booking_manager', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values (
  '88044444-4444-4444-8444-444444444444',
  pg_temp.artist_of('88022222-2222-4222-8222-222222222222'),
  'manager', false, false, true, false, true
);

-- ---------------------------------------------------------------------------
-- Act 1. The ACL, and a switch that starts closed
-- ---------------------------------------------------------------------------

select is(
  (select tenant_invites_open from crm_private.self_service_settings where id),
  false,
  'tenant invitations are closed by default, so applying 0133 changes no behaviour'
);

select ok(
  has_function_privilege('authenticated', 'public.begin_artist_invite(uuid,text,text,uuid,jsonb)', 'EXECUTE'),
  'a signed-in artist may reach the begin RPC whose body decides whether they may'
);
select ok(
  not has_function_privilege('anon', 'public.begin_artist_invite(uuid,text,text,uuid,jsonb)', 'EXECUTE'),
  'an anonymous visitor cannot start an invitation'
);
select ok(
  not has_function_privilege('service_role', 'public.begin_artist_invite(uuid,text,text,uuid,jsonb)', 'EXECUTE'),
  'and the backend secret cannot bypass the caller JWT through it'
);
select ok(
  not has_function_privilege('anon', 'public.finalize_artist_invite(uuid)', 'EXECUTE'),
  'nor finish one'
);
select ok(
  has_function_privilege('authenticated', 'public.tenant_invite_policy(uuid)', 'EXECUTE'),
  'a signed-in artist may ask whether the button is offered'
);
select ok(
  not has_function_privilege('anon', 'public.tenant_invite_policy(uuid)', 'EXECUTE'),
  'and is not an anonymous read, unlike the signup policy'
);

reset role;
select pg_temp.founder();
set local role authenticated;
select throws_ok(
  format(
    $$select public.begin_artist_invite('99000000-0000-4000-8000-000000000001', 'ti-invitee@example.test', 'Helper', %L)$$,
    pg_temp.artist_of('88022222-2222-4222-8222-222222222222')
  ),
  '42501', null,
  'the door refuses on its own authority while the switch is closed'
);
reset role;

-- ---------------------------------------------------------------------------
-- Act 2. Only the installation owner moves the switch
-- ---------------------------------------------------------------------------

select pg_temp.founder();
set local role authenticated;
select throws_ok(
  $$select public.set_tenant_invites(true)$$,
  '42501', null,
  'an artist who owns their own organization cannot open invitations installation-wide'
);
reset role;

select pg_temp.owner();
set local role authenticated;
select is(
  (select public.set_tenant_invites(true, 3, 5, 10) ->> 'is_open'),
  'true',
  'the installation owner opens them'
);
reset role;

select is(
  (select count(*)::int from public.activity_log
    where event_type = 'invite.tenant_availability_changed'),
  1,
  'and that decision is on the record'
);

-- ---------------------------------------------------------------------------
-- Act 3. Who may invite, and to what
--
-- The interesting cases are the refusals. Each one is a different way somebody
-- could try to reach past their own tenant.
-- ---------------------------------------------------------------------------

select pg_temp.unconfirmed();
set local role authenticated;
select throws_ok(
  format(
    $$select public.begin_artist_invite('99000000-0000-4000-8000-000000000002', 'ti-invitee@example.test', 'Helper', %L)$$,
    pg_temp.artist_of('88022222-2222-4222-8222-222222222222')
  ),
  '42501', null,
  'an inviter who has not confirmed their own address sends nothing, even holding manage_team'
);
reset role;

select pg_temp.founder();
set local role authenticated;

select throws_ok(
  format(
    $$select public.begin_artist_invite('99000000-0000-4000-8000-000000000003', 'ti-invitee@example.test', 'Helper', %L)$$,
    pg_temp.artist_of('88033333-3333-4333-8333-333333333333')
  ),
  '42501', null,
  'naming the other tenant artist is refused'
);

select throws_ok(
  $$select public.begin_artist_invite('99000000-0000-4000-8000-000000000004', 'ti-invitee@example.test', 'Helper', 'aaaaaaaa-0000-4000-8000-000000000000')$$,
  '42501', null,
  'and an artist that does not exist is refused identically, so the id space is not a probe'
);

select throws_ok(
  format(
    $$select public.begin_artist_invite('99000000-0000-4000-8000-000000000005', 'ti-invitee@example.test', 'Helper', %L, '{"access_level":"owner"}')$$,
    pg_temp.artist_of('88022222-2222-4222-8222-222222222222')
  ),
  '22023', null,
  'an owner-level grant is not reachable from this door at all'
);

select throws_ok(
  format(
    $$select public.begin_artist_invite('99000000-0000-4000-8000-000000000007', 'ti-invitee@example.test', 'Helper', %L, '{"can_manage_finance":true}')$$,
    pg_temp.artist_of('88022222-2222-4222-8222-222222222222')
  ),
  '22023', null,
  'managing finance without viewing it is incoherent and refused'
);

select throws_ok(
  format(
    $$select public.begin_artist_invite('99000000-0000-4000-8000-000000000008', 'ti-invitee@example.test', 'Helper', %L, '{"access_level":"read_only","can_manage_sessions":true}')$$,
    pg_temp.artist_of('88022222-2222-4222-8222-222222222222')
  ),
  '22023', null,
  'a read-only teammate carrying a management capability is refused'
);

select throws_ok(
  format(
    $$select public.begin_artist_invite('99000000-0000-4000-8000-000000000009', 'not-an-address', 'Helper', %L)$$,
    pg_temp.artist_of('88022222-2222-4222-8222-222222222222')
  ),
  '22023', null,
  'and so is an address that is not one'
);
reset role;

-- The founder's own membership carries finance, so the ceiling has to be shown
-- with somebody who does not hold it. Their manager may invite, but may not
-- hand out what they themselves lack.
insert into auth.users (id, email, email_confirmed_at)
values ('88088888-8888-4888-8888-888888888888', 'ti-plain-manager@example.test', now());
insert into public.profiles (id, email, display_name, role, is_active) values
  ('88088888-8888-4888-8888-888888888888', 'ti-plain-manager@example.test',
   'Plain Manager', 'booking_manager', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values (
  '88088888-8888-4888-8888-888888888888',
  pg_temp.artist_of('88022222-2222-4222-8222-222222222222'),
  'manager', false, false, true, false, true
);

select pg_temp.claims('{"sub":"88088888-8888-4888-8888-888888888888","role":"authenticated"}');
set local role authenticated;
select throws_ok(
  format(
    $$select public.begin_artist_invite('99000000-0000-4000-8000-000000000010', 'ti-invitee@example.test', 'Helper', %L, '{"can_view_finance":true}')$$,
    pg_temp.artist_of('88022222-2222-4222-8222-222222222222')
  ),
  '42501', null,
  'a manager without finance access cannot hand finance access to somebody else'
);
select throws_ok(
  format(
    $$select public.begin_artist_invite('99000000-0000-4000-8000-000000000011', 'ti-invitee@example.test', 'Helper', %L, '{"can_manage_integrations":true}')$$,
    pg_temp.artist_of('88022222-2222-4222-8222-222222222222')
  ),
  '42501', null,
  'nor integration management they do not hold'
);
reset role;

-- ---------------------------------------------------------------------------
-- Act 4. The invitation that works
-- ---------------------------------------------------------------------------

select pg_temp.founder();
set local role authenticated;
insert into ti_result (label, r)
select 'begin', public.begin_artist_invite(
  '99000000-0000-4000-8000-000000000020',
  'ti-invitee@example.test',
  'New Teammate',
  pg_temp.artist_of('88022222-2222-4222-8222-222222222222'),
  '{"access_level":"manager","can_manage_sessions":true}'
);
reset role;

select is(
  (select r ->> 'status' from ti_result where label = 'begin'),
  'pending',
  'the invitation is prepared'
);

-- Replaying the same key returns the same answer and creates no second row.
select pg_temp.founder();
set local role authenticated;
insert into ti_result (label, r)
select 'begin_replay', public.begin_artist_invite(
  '99000000-0000-4000-8000-000000000020',
  'ti-invitee@example.test',
  'New Teammate',
  pg_temp.artist_of('88022222-2222-4222-8222-222222222222'),
  '{"access_level":"manager","can_manage_sessions":true}'
);

select throws_ok(
  format(
    $$select public.begin_artist_invite('99000000-0000-4000-8000-000000000020', 'somebody-else@example.test', 'Different', %L)$$,
    pg_temp.artist_of('88022222-2222-4222-8222-222222222222')
  ),
  '22023', null,
  'and the same key cannot be turned into a different invitation'
);
reset role;

select is(
  (select r ->> 'idempotent_replay' from ti_result where label = 'begin_replay'),
  'true',
  'a repeated call is recognised as a replay'
);
select is(
  (select count(*)::int from crm_private.staff_invites
    where origin = 'tenant' and email_normalized = 'ti-invitee@example.test'),
  1,
  'and wrote no second invitation'
);

select pg_temp.founder();
set local role authenticated;
insert into ti_result (label, r)
select 'finalize', public.finalize_artist_invite(
  (select (r ->> 'invite_request_id')::uuid from ti_result where label = 'begin')
);
reset role;

select is(
  (select r ->> 'status' from ti_result where label = 'finalize'),
  'provisioned',
  'and finishing it provisions the teammate'
);

select is(
  (select p.role::text from public.profiles p where p.id = '88066666-6666-4666-8666-666666666666'),
  'booking_manager',
  'the new teammate is a booking manager - this door never mints an installation owner'
);

select is(
  (select count(*)::int from public.artist_memberships m
    where m.profile_id = '88066666-6666-4666-8666-666666666666' and m.is_active),
  1,
  'seated on exactly one artist'
);

select is(
  (select m.artist_id from public.artist_memberships m
    where m.profile_id = '88066666-6666-4666-8666-666666666666'),
  pg_temp.artist_of('88022222-2222-4222-8222-222222222222'),
  'and it is the artist the invitation named'
);

select is(
  (select count(*)::int from public.workspace_memberships wm
    where wm.profile_id = '88066666-6666-4666-8666-666666666666'),
  0,
  'the teammate is seated on the artist, not handed the organization'
);

select ok(
  (select bool_and(not m.can_view_finance and not m.can_manage_finance
                   and m.can_manage_sessions and not m.can_manage_integrations)
     from public.artist_memberships m
    where m.profile_id = '88066666-6666-4666-8666-666666666666'),
  'carrying exactly the capabilities the invitation asked for'
);

select is(
  (select count(*)::int from public.activity_log
    where event_type in ('invite.tenant_requested', 'invite.tenant_provisioned')),
  2,
  'both halves are on the record, artist-scoped'
);

-- ---------------------------------------------------------------------------
-- Act 5. What the teammate can reach
--
-- The point of the whole feature: somebody new is inside one tenant and cannot
-- see the installation around it.
-- ---------------------------------------------------------------------------

select pg_temp.claims('{"sub":"88066666-6666-4666-8666-666666666666","role":"authenticated"}');
set local role authenticated;

select is(
  (select count(*)::int from public.artists),
  1,
  'the teammate sees one artist'
);
select is(
  (select count(*)::int from public.clients),
  0,
  'no clients belonging to anybody else'
);
select is(
  (select count(*)::int from public.enquiries),
  0,
  'no enquiries either'
);
select ok(
  not exists (
    select 1 from public.profiles p where p.email = 'ti-other-founder@example.test'
  ),
  'and cannot see the other tenant founder'
);
select throws_ok(
  format(
    $$select public.begin_artist_invite('99000000-0000-4000-8000-000000000030', 'ti-invitee-two@example.test', 'Chain', %L)$$,
    pg_temp.artist_of('88033333-3333-4333-8333-333333333333')
  ),
  '42501', null,
  'and cannot use their own new access to invite into the other tenant'
);
reset role;

-- ---------------------------------------------------------------------------
-- Act 6. The address that already belongs to somebody
--
-- The response must be indistinguishable from a live invitation, or completing
-- signup hands anybody a membership-enumeration tool over the installation.
-- ---------------------------------------------------------------------------

select pg_temp.founder();
set local role authenticated;
insert into ti_result (label, r)
select 'existing', public.begin_artist_invite(
  '99000000-0000-4000-8000-000000000040',
  'ti-existing@example.test',
  'Already Here',
  pg_temp.artist_of('88022222-2222-4222-8222-222222222222')
);
reset role;

select ok(
  (select r ? 'status' and r ? 'email_normalized' and r ? 'idempotent_replay'
     from ti_result where label = 'existing'),
  'inviting an address that already has a profile answers in the same shape'
);
select is(
  (select r ->> 'invite_request_id' from ti_result where label = 'existing'),
  null,
  'with nothing for the caller to finalise'
);
select is(
  (select count(*)::int from public.artist_memberships m
    where m.profile_id = '88055555-5555-4555-8555-555555555555'),
  0,
  'and the account that already existed gains no membership anywhere'
);
select is(
  (select status from crm_private.staff_invites
    where email_normalized = 'ti-existing@example.test' and origin = 'tenant'),
  'suppressed',
  'the refusal is recorded rather than silently dropped'
);

-- ---------------------------------------------------------------------------
-- Act 7. Volume
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.owner();
set local role authenticated;
select public.set_tenant_invites(true, 1, 5, 10);
reset role;

select pg_temp.founder();
set local role authenticated;
select lives_ok(
  format(
    $$select public.begin_artist_invite('99000000-0000-4000-8000-000000000050', 'ti-invitee-two@example.test', 'Second', %L)$$,
    pg_temp.artist_of('88022222-2222-4222-8222-222222222222')
  ),
  'one invitation fits inside a pending window of one'
);
select throws_ok(
  format(
    $$select public.begin_artist_invite('99000000-0000-4000-8000-000000000051', 'ti-third@example.test', 'Third', %L)$$,
    pg_temp.artist_of('88022222-2222-4222-8222-222222222222')
  ),
  '53400', null,
  'and the next one is refused rather than absorbed'
);
reset role;

select pg_temp.owner();
set local role authenticated;
select public.set_tenant_invites(true, 3, 5, 0);
reset role;

select pg_temp.founder();
set local role authenticated;
select throws_ok(
  format(
    $$select public.begin_artist_invite('99000000-0000-4000-8000-000000000052', 'ti-fourth@example.test', 'Fourth', %L)$$,
    pg_temp.artist_of('88022222-2222-4222-8222-222222222222')
  ),
  '53400', null,
  'the installation-wide hourly cap refuses independently of the per-artist ones'
);
reset role;

select pg_temp.owner();
set local role authenticated;
select public.set_tenant_invites(true, 3, 5, 10);
reset role;

-- ---------------------------------------------------------------------------
-- Act 8. Expiry and replay
-- ---------------------------------------------------------------------------

update crm_private.staff_invites
   set expires_at = now() - interval '1 minute'
 where idempotency_key = '99000000-0000-4000-8000-000000000050';

-- Resolved before the role switch: an artist cannot read the private invite
-- table, which is the point, so the test must not either while acting as one.
insert into ti_result (label, r)
select 'expired_id', jsonb_build_object('id', i.id)
from crm_private.staff_invites i
where i.idempotency_key = '99000000-0000-4000-8000-000000000050';

select pg_temp.founder();
set local role authenticated;
select throws_ok(
  format(
    $$select public.finalize_artist_invite(%L)$$,
    (select (r ->> 'id')::uuid from ti_result where label = 'expired_id')
  ),
  '22023', null,
  'an expired invitation cannot be finished'
);

-- Finishing an already-provisioned invitation a second time creates nothing.
insert into ti_result (label, r)
select 'finalize_replay', public.finalize_artist_invite(
  (select (r ->> 'invite_request_id')::uuid from ti_result where label = 'begin')
);
reset role;

select is(
  (select r ->> 'idempotent_replay' from ti_result where label = 'finalize_replay'),
  'true',
  'finishing a completed invitation twice is a replay, not a second teammate'
);
select is(
  (select count(*)::int from public.artist_memberships m
    where m.profile_id = '88066666-6666-4666-8666-666666666666'),
  1,
  'and leaves exactly one membership'
);

-- Somebody else's invitation is not finishable, and says only that it does not
-- exist.
select pg_temp.other();
set local role authenticated;
select throws_ok(
  format(
    $$select public.finalize_artist_invite(%L)$$,
    (select (r ->> 'invite_request_id')::uuid from ti_result where label = 'begin')
  ),
  '23503', null,
  'a different tenant cannot finish an invitation that is not theirs'
);
reset role;

-- ---------------------------------------------------------------------------
-- Act 9. The owner path is untouched
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from crm_private.staff_invites where origin = 'owner'),
  0,
  'nothing in this feature wrote an owner-origin invitation'
);

select pg_temp.owner();
set local role authenticated;
select lives_ok(
  format(
    $$select public.begin_staff_invite('99000000-0000-4000-8000-000000000060', 'ti-owner-invited@example.test', 'Owner Invited', 'booking_manager', %L)$$,
    jsonb_build_array(jsonb_build_object(
      'artist_id', 'a1111111-1111-4111-8111-111111111111',
      'access_level', 'manager',
      'can_view_finance', false,
      'can_manage_finance', false,
      'can_manage_sessions', true,
      'can_manage_integrations', false
    ))
  ),
  'the owner invitation still works exactly as before, with its membership array'
);
reset role;

select is(
  (select origin from crm_private.staff_invites
    where email_normalized = 'ti-owner-invited@example.test'),
  'owner',
  'and is recorded as an owner invitation with no single artist'
);
select is(
  (select artist_id from crm_private.staff_invites
    where email_normalized = 'ti-owner-invited@example.test'),
  null,
  'because its reach lives in the membership list, not in one artist id'
);

select pg_temp.founder();
set local role authenticated;
select throws_ok(
  format(
    $$select public.begin_staff_invite('99000000-0000-4000-8000-000000000061', 'ti-escalate@example.test', 'Escalation', 'booking_manager', %L)$$,
    jsonb_build_array(jsonb_build_object(
      'artist_id', 'a1111111-1111-4111-8111-111111111111',
      'access_level', 'manager',
      'can_view_finance', true,
      'can_manage_finance', true,
      'can_manage_sessions', true,
      'can_manage_integrations', true
    ))
  ),
  '42501', null,
  'and a tenant founder still cannot reach the owner door to stage a wider invitation'
);
reset role;

select * from finish();
rollback;
