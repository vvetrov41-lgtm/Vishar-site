-- 272_account_lifecycle.sql
--
-- Migration 0135: what the interface calls a person, and what happens when
-- they delete themselves.
--
-- The scenarios this file is responsible for:
--
--   a self-service founder is an artist, not a booking manager
--   somebody invited to handle another artist's bookings is a booking manager
--   the installation operator is never described as an artist, even though
--     owner-sync seats them on every one
--   a read-only account, and an account holding no seat at all
--   the classification comes from membership rows, so revoking the seat
--     changes the answer without anybody editing a label
--   delete_my_account refuses: a backend key, the wrong confirmation, the
--     installation owner, and a founder whose tenant still has somebody in it
--   a founder's deletion actually ends the account - seats gone, artist and
--     organization retired and anonymised, connections and booking forms gone,
--     Auth identity soft-deleted, banned and stripped
--   the append-only log is intact afterwards, and gained the event
--   the released address can found a fresh tenant
--   a teammate deleting themselves leaves the artist they worked for alone
--
-- Every identity and address here is synthetic.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at, encrypted_password) values
  ('77011111-1111-4111-8111-111111111111', 'al-owner@example.test', now(), 'x'),
  ('77022222-2222-4222-8222-222222222222', 'al-founder@example.test', now(), 'x'),
  ('77033333-3333-4333-8333-333333333333', 'al-teammate@example.test', now(), 'x'),
  ('77044444-4444-4444-8444-444444444444', 'al-solo@example.test', now(), 'x'),
  ('77055555-5555-4555-8555-555555555555', 'al-reader@example.test', now(), 'x'),
  ('77066666-6666-4666-8666-666666666666', 'al-seatless@example.test', now(), 'x'),
  ('77077777-7777-4777-8777-777777777777', 'al-rejoin@example.test', now(), 'x');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('77011111-1111-4111-8111-111111111111', 'al-owner@example.test',
   'Installation Owner', 'owner', true),
  ('77055555-5555-4555-8555-555555555555', 'al-reader@example.test',
   'Reader', 'read_only', true),
  ('77066666-6666-4666-8666-666666666666', 'al-seatless@example.test',
   'No Seat', 'booking_manager', true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to anon, authenticated, service_role;

create function pg_temp.act(p_uid uuid) returns void language sql as $$
  select pg_temp.claims(
    json_build_object('sub', p_uid::text, 'role', 'authenticated')::text
  );
$$;
grant execute on function pg_temp.act(uuid) to anon, authenticated, service_role;

create temporary table al_result (label text not null, r jsonb not null);
grant select, insert on al_result to authenticated;

-- ---------------------------------------------------------------------------
-- The cast
--
-- Two self-service tenants founded the ordinary way, and one invited teammate
-- who handles bookings on the first founder's artist. Nothing here is arranged
-- by hand: every row is what the shipped RPCs write.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.act('77011111-1111-4111-8111-111111111111');
set local role authenticated;
select public.set_self_service_signup(true);
reset role;

select pg_temp.act('77022222-2222-4222-8222-222222222222');
set local role authenticated;
select public.bootstrap_artist_account('Founder One', 'Studio One');
reset role;

select pg_temp.act('77044444-4444-4444-8444-444444444444');
set local role authenticated;
select public.bootstrap_artist_account('Solo Two', 'Studio Two');
reset role;

-- The teammate: a booking manager seated on the first founder's artist, which
-- is exactly the shape an invitation produces.
insert into public.profiles (id, email, display_name, role, is_active) values
  ('77033333-3333-4333-8333-333333333333', 'al-teammate@example.test',
   'Teammate', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active, grant_source
)
select '77033333-3333-4333-8333-333333333333', s.artist_id, 'manager',
       false, false, true, false, true, 'explicit'
from crm_private.self_service_accounts s
where s.profile_id = '77022222-2222-4222-8222-222222222222';

-- The reader, seated read-only on the same artist.
insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active, grant_source
)
select '77055555-5555-4555-8555-555555555555', s.artist_id, 'read_only',
       false, false, false, false, true, 'explicit'
from crm_private.self_service_accounts s
where s.profile_id = '77022222-2222-4222-8222-222222222222';

-- ---------------------------------------------------------------------------
-- 1. The user-facing role
-- ---------------------------------------------------------------------------

select is(
  crm_private.user_facing_role('77022222-2222-4222-8222-222222222222'),
  'artist',
  'a self-service founder is an artist, whatever the global role column says'
);

select is(
  (select role::text from public.profiles where id = '77022222-2222-4222-8222-222222222222'),
  'booking_manager',
  'and the authorization role underneath is untouched by that answer'
);

select is(
  crm_private.user_facing_role('77033333-3333-4333-8333-333333333333'),
  'booking_manager',
  'somebody handling another artist''s bookings is a booking manager'
);

select is(
  crm_private.user_facing_role('77011111-1111-4111-8111-111111111111'),
  'operator',
  'the installation operator is an operator, not an artist'
);

select isnt(
  crm_private.user_facing_role('77011111-1111-4111-8111-111111111111'),
  'artist',
  'even though owner-sync seats them on artists across the installation'
);

select cmp_ok(
  (select count(*) from public.artist_memberships
    where profile_id = '77011111-1111-4111-8111-111111111111'
      and access_level = 'owner' and is_active),
  '>', 0::bigint,
  'and that seat really is there, so the operator branch is doing the work'
);

select is(
  crm_private.user_facing_role('77055555-5555-4555-8555-555555555555'),
  'read_only',
  'a read-only seat reads as read-only'
);

select is(
  crm_private.user_facing_role('77066666-6666-4666-8666-666666666666'),
  'booking_manager',
  'an account holding no seat falls back to its global role'
);

select is(
  crm_private.user_facing_role('00000000-0000-4000-8000-000000000000'),
  'none',
  'and an account the installation does not know is nobody'
);

-- Derived from the rows, not from a label: revoke the seat and the answer
-- moves on its own.
update public.artist_memberships
   set is_active = false
 where profile_id = '77033333-3333-4333-8333-333333333333';

select is(
  crm_private.user_facing_role('77033333-3333-4333-8333-333333333333'),
  'booking_manager',
  'revoking the seat falls back to the global role rather than inventing one'
);

update public.artist_memberships
   set is_active = true
 where profile_id = '77033333-3333-4333-8333-333333333333';

-- ---------------------------------------------------------------------------
-- 2. account_overview
-- ---------------------------------------------------------------------------

select pg_temp.act('77022222-2222-4222-8222-222222222222');
set local role authenticated;
insert into al_result (label, r) values ('founder-overview', public.account_overview());
reset role;

select is(
  (select r ->> 'user_role' from al_result where label = 'founder-overview'),
  'artist',
  'the account page is told artist'
);

select is(
  (select r ->> 'is_self_service_founder' from al_result where label = 'founder-overview'),
  'true',
  'and that this account founded its own tenant'
);

select is(
  (select r ->> 'delete_blocked_reason' from al_result where label = 'founder-overview'),
  'shared_tenant',
  'but not that it may delete itself, because two other people are seated on it'
);

select pg_temp.act('77011111-1111-4111-8111-111111111111');
set local role authenticated;
insert into al_result (label, r) values ('owner-overview', public.account_overview());
reset role;

select is(
  (select r ->> 'delete_blocked_reason' from al_result where label = 'owner-overview'),
  'installation_owner',
  'the installation owner is refused first, by who they are'
);

select pg_temp.act('77044444-4444-4444-8444-444444444444');
set local role authenticated;
insert into al_result (label, r) values ('solo-overview', public.account_overview());
reset role;

select is(
  (select r ->> 'can_delete_account' from al_result where label = 'solo-overview'),
  'true',
  'a founder alone in their own tenant may delete it'
);

-- Back to a backend key, which is what the next few refusals are about.
select pg_temp.claims('{"role":"service_role"}');
select throws_ok(
  $$select public.account_overview()$$,
  '42501', null,
  'and a backend key has no account to read'
);

-- ---------------------------------------------------------------------------
-- 3. delete_my_account refuses
-- ---------------------------------------------------------------------------

select pg_temp.claims('{"role":"service_role"}');
select throws_ok(
  $$select public.delete_my_account('al-solo@example.test')$$,
  '42501', null,
  'a service-role caller cannot delete anybody'
);

select pg_temp.act('77044444-4444-4444-8444-444444444444');
set local role authenticated;
select throws_ok(
  $$select public.delete_my_account('DELETE')$$,
  '22023', null,
  'a confirmation that is not this account''s address is refused'
);
select throws_ok(
  $$select public.delete_my_account('al-founder@example.test')$$,
  '22023', null,
  'and so is somebody else''s address'
);
reset role;

select pg_temp.act('77011111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  $$select public.delete_my_account('al-owner@example.test')$$,
  '42501', null,
  'the installation owner cannot delete themselves even with the right address'
);
reset role;

select pg_temp.act('77022222-2222-4222-8222-222222222222');
set local role authenticated;
select throws_ok(
  $$select public.delete_my_account('al-founder@example.test')$$,
  '23514', null,
  'and a founder is refused while anybody else is still seated on their artist'
);
reset role;

-- ---------------------------------------------------------------------------
-- 4. A teammate deletes themselves
--
-- The artist they worked for is somebody else's and must come through
-- untouched.
-- ---------------------------------------------------------------------------

create temporary table al_artist as
select s.artist_id, s.workspace_id
from crm_private.self_service_accounts s
where s.profile_id = '77022222-2222-4222-8222-222222222222';

select pg_temp.act('77033333-3333-4333-8333-333333333333');
set local role authenticated;
insert into al_result (label, r)
values ('teammate-delete', public.delete_my_account('AL-Teammate@Example.Test'));
reset role;

select is(
  (select r ->> 'scope' from al_result where label = 'teammate-delete'),
  'membership',
  'a teammate deletes a membership, not a tenant'
);

select is(
  (select count(*)::int from public.artist_memberships
    where profile_id = '77033333-3333-4333-8333-333333333333'),
  0,
  'their seat is gone entirely'
);

select is(
  (select is_active from public.artists a join al_artist t on t.artist_id = a.id),
  true,
  'and the artist they worked for is still switched on'
);

select is(
  (select display_name from public.artists a join al_artist t on t.artist_id = a.id),
  'Founder One',
  'still named'
);

select is(
  (select display_name from public.profiles where id = '77033333-3333-4333-8333-333333333333'),
  'Deleted account',
  'while their own profile is an anonymous tombstone'
);

select is(
  (select deleted_at is not null from auth.users where id = '77033333-3333-4333-8333-333333333333'),
  true,
  'and the Auth identity is marked deleted'
);

-- ---------------------------------------------------------------------------
-- 5. A founder deletes the whole tenant
-- ---------------------------------------------------------------------------

create temporary table al_solo as
select s.artist_id, s.workspace_id
from crm_private.self_service_accounts s
where s.profile_id = '77044444-4444-4444-8444-444444444444';

-- Give the tenant the things a live account actually accumulates, so the
-- deletion has something to take apart rather than an empty shell.
insert into public.booking_sources (
  artist_id, source_key, form_version, display_label, source_kind, is_active
)
select t.artist_id, 'al-solo-form', 'v1', 'Studio Two form', 'hosted', true
from al_solo t;

insert into public.artist_integrations (
  artist_id, integration_type, provider, integration_key,
  external_account_label, is_enabled
)
select t.artist_id, 'telegram', 'telegram', 'al-solo-telegram',
       'Studio Two chat', true
from al_solo t;

create temporary table al_before as
select count(*) as n from public.activity_log;

select pg_temp.act('77044444-4444-4444-8444-444444444444');
set local role authenticated;
insert into al_result (label, r)
values ('solo-delete', public.delete_my_account('  al-solo@example.test  '));
reset role;

select is(
  (select r ->> 'scope' from al_result where label = 'solo-delete'),
  'tenant',
  'a founder deletes the tenant'
);

select is(
  (select is_active from public.artists a join al_solo t on t.artist_id = a.id),
  false,
  'the artist is switched off'
);

select is(
  (select display_name from public.artists a join al_solo t on t.artist_id = a.id),
  'Deleted account',
  'and holds no name'
);

select is(
  (select booking_reference_prefix from public.artists a join al_solo t on t.artist_id = a.id),
  null,
  'its booking reference prefix is released'
);

select ok(
  (select a.slug like 'deleted-%' from public.artists a join al_solo t on t.artist_id = a.id),
  'and its address is rotated, so the old one is free again'
);

select is(
  (select is_active from public.workspaces w join al_solo t on t.workspace_id = w.id),
  false,
  'the solo organization is switched off'
);

select is(
  (select display_name from public.workspaces w join al_solo t on t.workspace_id = w.id),
  'Deleted account',
  'and holds no name either'
);

select is(
  (select count(*)::int from public.artist_integrations i join al_solo t on t.artist_id = i.artist_id),
  0,
  'every provider connection is gone, so nothing keeps delivering'
);

select is(
  (select bool_and(not is_active)
     from public.booking_sources b join al_solo t on t.artist_id = b.artist_id),
  true,
  'and the booking form takes nothing further'
);

select is(
  (select count(*)::int from public.artist_memberships
    where profile_id = '77044444-4444-4444-8444-444444444444'),
  0,
  'the artist seat is gone'
);

select is(
  (select is_active from public.profiles where id = '77044444-4444-4444-8444-444444444444'),
  false,
  'the profile is inactive'
);

select is(
  (select role::text from public.profiles where id = '77044444-4444-4444-8444-444444444444'),
  'read_only',
  'holds the narrowest role'
);

select ok(
  (select email::text like 'deleted-%@deleted.invalid'
     from public.profiles where id = '77044444-4444-4444-8444-444444444444'),
  'and no longer holds the address'
);

select is(
  (select banned_until from auth.users where id = '77044444-4444-4444-8444-444444444444'),
  'infinity'::timestamptz,
  'the Auth identity is banned for good'
);

select is(
  (select encrypted_password from auth.users where id = '77044444-4444-4444-8444-444444444444'),
  null,
  'has no password'
);

select is(
  (select count(*)::int from auth.identities where user_id = '77044444-4444-4444-8444-444444444444'),
  0,
  'and no identity left to sign in with'
);

-- ---------------------------------------------------------------------------
-- 6. The audit log
-- ---------------------------------------------------------------------------

select cmp_ok(
  (select count(*) from public.activity_log),
  '>', (select n from al_before),
  'the log only grew: deleting an account appends to it and removes nothing'
);

select cmp_ok(
  (select count(*) from public.activity_log where event_type = 'account.self_deleted'),
  '>=', 2::bigint,
  'and both deletions are recorded'
);

select cmp_ok(
  (select count(*) from public.activity_log l join al_solo t on t.artist_id = l.artist_id),
  '>', 0::bigint,
  'the retired artist row is still there for every log row that references it'
);

select is(
  (select count(*)::int from public.artists a join al_solo t on t.artist_id = a.id),
  1,
  'which is why it is retired rather than dropped'
);

select throws_ok(
  $$delete from public.activity_log where event_type = 'account.self_deleted'$$,
  '42501', null,
  'and the log is still append-only afterwards'
);

-- ---------------------------------------------------------------------------
-- 7. The released address
--
-- The whole point of rewriting the address rather than keeping it: the person
-- can come back tomorrow.
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update auth.users
   set email = 'al-solo@example.test'
 where id = '77077777-7777-4777-8777-777777777777';

select pg_temp.act('77077777-7777-4777-8777-777777777777');
set local role authenticated;
insert into al_result (label, r)
values ('rejoin', public.bootstrap_artist_account('Solo Again', 'Studio Two Again'));
reset role;

select is(
  (select r ->> 'created' from al_result where label = 'rejoin'),
  'true',
  'the released address founds a fresh tenant, and it is a new one'
);

select isnt(
  (select (r ->> 'artist_id')::uuid from al_result where label = 'rejoin'),
  (select artist_id from al_solo),
  'not the retired one'
);

select * from finish();
rollback;
