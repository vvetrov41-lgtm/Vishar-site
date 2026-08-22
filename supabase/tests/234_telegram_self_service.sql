-- 234_telegram_self_service.sql
-- Phase F-G: private destinations, single-use linking and personal delivery.
--
-- Role rule for this test: API behaviour is exercised under authenticated or
-- service_role; direct crm_private state assertions always reset to the
-- migration-owner context first. The private-table ACL is part of what is being
-- tested and must never be bypassed by granting a test role extra access.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Nothing in 0086 guesses or seeds production chat ids.
select is((select count(*)::int from crm_private.telegram_destinations), 0,
  'migration seeds no Telegram destinations');
select is((select count(*)::int from crm_private.telegram_link_sessions), 0,
  'migration seeds no Telegram linking sessions');
select is((select count(*)::int from crm_private.telegram_notification_deliveries), 0,
  'migration seeds no personal Telegram deliveries');

select has_table('crm_private', 'telegram_destinations',
  'private Telegram destination registry exists');
select has_table('crm_private', 'telegram_link_sessions',
  'private Telegram link-session registry exists');
select has_table('crm_private', 'telegram_notification_deliveries',
  'private personal-delivery state exists');
select hasnt_column('crm_private', 'telegram_link_sessions', 'token',
  'raw Telegram link token has no storage column');
select has_column('crm_private', 'telegram_link_sessions', 'token_hash',
  'only a token hash column is persisted');

select ok(not has_table_privilege('anon', 'crm_private.telegram_destinations', 'SELECT'),
  'anon cannot read Telegram destinations');
select ok(not has_table_privilege('authenticated', 'crm_private.telegram_destinations', 'SELECT'),
  'browser cannot read Telegram destinations');
select ok(not has_table_privilege('service_role', 'crm_private.telegram_destinations', 'SELECT'),
  'backend reaches Telegram destinations only through narrow RPCs');
select ok(not has_table_privilege('authenticated', 'crm_private.telegram_link_sessions', 'SELECT'),
  'browser cannot inspect link-session hashes');
select ok(not has_table_privilege('service_role', 'crm_private.telegram_link_sessions', 'SELECT'),
  'backend cannot bypass link-completion RPC');
select ok(not has_table_privilege('authenticated', 'crm_private.telegram_notification_deliveries', 'SELECT'),
  'browser cannot inspect delivery state');
select ok(not has_table_privilege('service_role', 'crm_private.telegram_notification_deliveries', 'SELECT'),
  'backend cannot bypass delivery RPCs');

-- Explicit function ACLs.
select ok(has_function_privilege('authenticated',
  'public.get_telegram_connector_info()', 'EXECUTE'),
  'browser can read the public bot identity');
select ok(has_function_privilege('authenticated',
  'public.list_telegram_destinations()', 'EXECUTE'),
  'browser can read safe Telegram connection state');
select ok(has_function_privilege('authenticated',
  'public.begin_telegram_link(text,uuid)', 'EXECUTE'),
  'browser can begin a bounded Telegram link');
select ok(has_function_privilege('authenticated',
  'public.disconnect_telegram_destination(text,uuid)', 'EXECUTE'),
  'browser can disconnect a destination it controls');
select ok(not has_function_privilege('authenticated',
  'public.service_complete_telegram_link(text,text,text)', 'EXECUTE'),
  'browser cannot complete a Telegram link as the connector');
select ok(not has_function_privilege('authenticated',
  'public.service_resolve_telegram_destination(uuid,uuid)', 'EXECUTE'),
  'browser cannot resolve a private chat id');
select ok(not has_function_privilege('authenticated',
  'public.service_claim_telegram_notifications(text,integer,integer)', 'EXECUTE'),
  'browser cannot lease personal Telegram deliveries');
select ok(has_function_privilege('service_role',
  'public.service_complete_telegram_link(text,text,text)', 'EXECUTE'),
  'connector can complete a verified Telegram link');
select ok(has_function_privilege('service_role',
  'public.service_resolve_telegram_destination(uuid,uuid)', 'EXECUTE'),
  'connector can resolve a private destination');
select ok(has_function_privilege('service_role',
  'public.service_claim_telegram_notifications(text,integer,integer)', 'EXECUTE'),
  'connector can lease personal Telegram deliveries');
select ok(has_function_privilege('service_role',
  'public.service_record_telegram_notification_result(uuid,text,boolean,text)', 'EXECUTE'),
  'connector can acknowledge personal Telegram deliveries');
select ok(not has_function_privilege('service_role',
  'public.begin_telegram_link(text,uuid)', 'EXECUTE'),
  'service credential cannot mint a browser linking challenge');

-- Fixtures.
insert into auth.users (id, email) values
  ('f6010000-0000-4000-8000-000000000001', 'telegram-manager@example.test'),
  ('f6010000-0000-4000-8000-000000000002', 'telegram-reader@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('f6010000-0000-4000-8000-000000000001', 'telegram-manager@example.test', 'Telegram Manager', 'booking_manager', true),
  ('f6010000-0000-4000-8000-000000000002', 'telegram-reader@example.test', 'Telegram Reader', 'read_only', true);

insert into public.artists (id, slug, display_name, timezone, default_currency, is_active)
values ('f6a10000-0000-4000-8000-000000000001', 'telegram-test-artist', 'Telegram Test Artist', 'Europe/London', 'GBP', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance, can_manage_sessions,
  can_manage_integrations, is_active
) values
  ('f6010000-0000-4000-8000-000000000001', 'f6a10000-0000-4000-8000-000000000001',
   'manager', false, false, true, true, true),
  ('f6010000-0000-4000-8000-000000000002', 'f6a10000-0000-4000-8000-000000000001',
   'read_only', false, false, false, false, true);

create function pg_temp.telegram_claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.telegram_claims(text)
  to authenticated, service_role;

create temporary table telegram_tokens (
  name text primary key,
  token text not null
);
grant select, insert, update on telegram_tokens to authenticated, service_role;

-- Historical in-app notification. Linking later must not replay it externally.
insert into public.notifications (
  id, recipient_profile_id, notification_type, title, body,
  priority, status, dedupe_key, scheduled_at, delivered_at, created_at
) values (
  'f6b10000-0000-4000-8000-000000000001',
  'f6010000-0000-4000-8000-000000000001',
  'follow_up.due', 'Old in-app reminder', null,
  'normal', 'delivered', 'telegram-old-notification',
  now() - interval '2 hours', now() - interval '2 hours', now() - interval '2 hours'
);

-- ---------------------------------------------------------------------------
-- Personal linking: raw token once, hash at rest, private chat only.
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.telegram_claims('{"sub":"f6010000-0000-4000-8000-000000000001","role":"authenticated"}');
select lives_ok(
  $$insert into telegram_tokens(name, token)
    select 'personal-1', public.begin_telegram_link('profile', null)->>'link_token'$$,
  'an active profile may begin its own personal Telegram link');
select is(length((select token from telegram_tokens where name='personal-1')), 32,
  'link token is a compact 32-character Telegram start parameter');

reset role;
select is((select count(*)::int from crm_private.telegram_link_sessions), 1,
  'one private challenge row was created');
select isnt(
  (select token_hash from crm_private.telegram_link_sessions order by created_at desc limit 1),
  (select token from telegram_tokens where name='personal-1'),
  'raw link token is not persisted as the hash');
select is(
  (select token_hash from crm_private.telegram_link_sessions order by created_at desc limit 1),
  encode(extensions.digest((select token from telegram_tokens where name='personal-1'), 'sha256'), 'hex'),
  'stored challenge is exactly the SHA-256 digest of the returned token');

set local role authenticated;
select pg_temp.telegram_claims('{"sub":"f6010000-0000-4000-8000-000000000001","role":"authenticated"}');
select lives_ok(
  $$insert into telegram_tokens(name, token)
    select 'personal-2', public.begin_telegram_link('profile', null)->>'link_token'$$,
  'starting another personal link invalidates the prior challenge');
select throws_ok(
  $$select public.begin_telegram_link('profile', 'f6a10000-0000-4000-8000-000000000001')$$,
  '22023', null,
  'personal linking cannot smuggle an Artist id');
select throws_ok(
  $$select public.configure_telegram_connector_identity('SomeBot')$$,
  '42501', null,
  'a manager cannot configure the shared bot identity');

reset role;
select ok(
  (select invalidated_at is not null
   from crm_private.telegram_link_sessions
   where token_hash = encode(extensions.digest((select token from telegram_tokens where name='personal-1'), 'sha256'), 'hex')),
  'older personal challenge is invalidated');

set local role service_role;
select pg_temp.telegram_claims('{"role":"service_role"}');
select throws_ok(
  $$select public.service_complete_telegram_link(
      (select token from telegram_tokens where name='personal-1'), '100001', 'private')$$,
  '22023', null,
  'an invalidated challenge cannot be consumed');
select throws_ok(
  $$select public.service_complete_telegram_link(
      (select token from telegram_tokens where name='personal-2'), '-100100002', 'group')$$,
  '22023', null,
  'a personal destination refuses a group chat');
select lives_ok(
  $$select public.service_complete_telegram_link(
      (select token from telegram_tokens where name='personal-2'), '100002', 'private')$$,
  'backend completes a personal link from a private Telegram chat');
select throws_ok(
  $$select public.service_complete_telegram_link(
      (select token from telegram_tokens where name='personal-2'), '100002', 'private')$$,
  '22023', null,
  'a consumed challenge cannot be replayed');
select is(
  (select chat_id from public.service_resolve_telegram_destination(
    null, 'f6010000-0000-4000-8000-000000000001') limit 1),
  '100002',
  'trusted resolver returns the personal chat id to the connector');

reset role;
select is(
  (select count(*)::int from crm_private.telegram_destinations
   where destination_kind='profile'
     and profile_id='f6010000-0000-4000-8000-000000000001'
     and chat_id='100002' and is_active),
  1,
  'personal chat is stored only in the private destination registry');
select is(
  (select target_address from crm_private.profile_notification_targets
   where profile_id='f6010000-0000-4000-8000-000000000001' and channel='telegram'),
  '100002',
  'personal linking materialises the existing private notification target');

-- Browser status never exposes the chat id.
set local role authenticated;
select pg_temp.telegram_claims('{"sub":"f6010000-0000-4000-8000-000000000001","role":"authenticated"}');
select ok(
  exists(select 1 from public.list_telegram_destinations()
         where destination_kind='profile' and is_connected),
  'browser sees that its personal Telegram destination is connected');
select ok(
  row_to_json(x)::text not like '%100002%'
  from (select * from public.list_telegram_destinations()
        where destination_kind='profile' limit 1) x,
  'safe browser status does not contain the private chat id');
select lives_ok(
  $$select public.set_notification_preference('telegram', true)$$,
  'a linked profile may opt into personal Telegram delivery');

-- ---------------------------------------------------------------------------
-- Personal delivery: no old backlog, lease/ack idempotency, scope re-check.
-- ---------------------------------------------------------------------------

reset role;
insert into public.notifications (
  id, recipient_profile_id, notification_type, title, body,
  priority, status, dedupe_key, scheduled_at, delivered_at, created_at
) values (
  'f6b10000-0000-4000-8000-000000000002',
  'f6010000-0000-4000-8000-000000000001',
  'automation.triggered', 'New personal reminder', 'Safe reminder body',
  'normal', 'delivered', 'telegram-new-notification', now(), now(), now()
);

set local role service_role;
select pg_temp.telegram_claims('{"role":"service_role"}');
create temporary table claimed_personal as
select * from public.service_claim_telegram_notifications('telegram-test-worker', 20, 120);
grant select on claimed_personal to service_role;
select is((select count(*)::int from claimed_personal), 1,
  'exactly the post-link notification is leased for Telegram');
select is((select notification_id from claimed_personal),
  'f6b10000-0000-4000-8000-000000000002'::uuid,
  'pre-link in-app history is not replayed to Telegram');
select is((select chat_id from claimed_personal), '100002',
  'trusted lease carries the private chat id only to the connector');
select lives_ok(
  $$select public.service_record_telegram_notification_result(
      (select delivery_id from claimed_personal), 'telegram-test-worker', true, null)$$,
  'connector records a successful personal Telegram delivery');
select lives_ok(
  $$select public.service_record_telegram_notification_result(
      (select delivery_id from claimed_personal), 'telegram-test-worker', true, null)$$,
  'successful acknowledgement replay is idempotent');
select is(
  (select count(*)::int from public.service_claim_telegram_notifications('telegram-test-worker',20,120)),
  0,
  'successful personal delivery is never leased twice');

reset role;
select is(
  (select status from crm_private.telegram_notification_deliveries
   where notification_id='f6b10000-0000-4000-8000-000000000002'),
  'succeeded',
  'personal delivery reaches succeeded state');

-- Revoke Artist access after an Artist-scoped notification exists.
insert into public.notifications (
  id, recipient_profile_id, artist_id, notification_type, title,
  priority, status, dedupe_key, scheduled_at, delivered_at, created_at
) values (
  'f6b10000-0000-4000-8000-000000000003',
  'f6010000-0000-4000-8000-000000000001',
  'f6a10000-0000-4000-8000-000000000001',
  'automation.triggered', 'Artist-scoped reminder',
  'normal', 'delivered', 'telegram-revoked-notification', now(), now(), now()
);
update public.artist_memberships
set is_active=false
where profile_id='f6010000-0000-4000-8000-000000000001'
  and artist_id='f6a10000-0000-4000-8000-000000000001';

set local role service_role;
select pg_temp.telegram_claims('{"role":"service_role"}');
select is(
  (select count(*)::int from public.service_claim_telegram_notifications('telegram-test-worker',20,120)),
  0,
  'membership revocation blocks external delivery of an Artist-scoped notification');

reset role;
select is(
  (select count(*)::int from crm_private.telegram_notification_deliveries
   where notification_id='f6b10000-0000-4000-8000-000000000003'),
  0,
  'revoked notification is not materialised into the Telegram queue');

-- ---------------------------------------------------------------------------
-- Artist/shared linking: manage_integrations required at begin and completion.
-- ---------------------------------------------------------------------------

update public.artist_memberships
set is_active=true
where profile_id='f6010000-0000-4000-8000-000000000001'
  and artist_id='f6a10000-0000-4000-8000-000000000001';

set local role authenticated;
select pg_temp.telegram_claims('{"sub":"f6010000-0000-4000-8000-000000000002","role":"authenticated"}');
select throws_ok(
  $$select public.begin_telegram_link('artist','f6a10000-0000-4000-8000-000000000001')$$,
  '42501', null,
  'read-only member cannot link an Artist shared destination');

select pg_temp.telegram_claims('{"sub":"f6010000-0000-4000-8000-000000000001","role":"authenticated"}');
select lives_ok(
  $$insert into telegram_tokens(name, token)
    select 'artist-1', public.begin_telegram_link(
      'artist','f6a10000-0000-4000-8000-000000000001')->>'link_token'$$,
  'integration manager may begin an Artist shared-destination link');

reset role;
update public.artist_memberships
set is_active=false
where profile_id='f6010000-0000-4000-8000-000000000001'
  and artist_id='f6a10000-0000-4000-8000-000000000001';

set local role service_role;
select pg_temp.telegram_claims('{"role":"service_role"}');
select throws_ok(
  $$select public.service_complete_telegram_link(
      (select token from telegram_tokens where name='artist-1'), '-100200001','supergroup')$$,
  '42501', null,
  'revoked manager cannot complete an Artist link they started earlier');

reset role;
update public.artist_memberships
set is_active=true
where profile_id='f6010000-0000-4000-8000-000000000001'
  and artist_id='f6a10000-0000-4000-8000-000000000001';

set local role authenticated;
select pg_temp.telegram_claims('{"sub":"f6010000-0000-4000-8000-000000000001","role":"authenticated"}');
select lives_ok(
  $$insert into telegram_tokens(name, token)
    select 'artist-2', public.begin_telegram_link(
      'artist','f6a10000-0000-4000-8000-000000000001')->>'link_token'$$,
  'manager can restart Artist linking after access is restored');

reset role;
set local role service_role;
select pg_temp.telegram_claims('{"role":"service_role"}');
select throws_ok(
  $$select public.service_complete_telegram_link(
      (select token from telegram_tokens where name='artist-2'), '200002','private')$$,
  '22023', null,
  'Artist shared destination refuses a private chat');
select lives_ok(
  $$select public.service_complete_telegram_link(
      (select token from telegram_tokens where name='artist-2'), '-100200002','supergroup')$$,
  'Artist destination accepts a group or supergroup');
select is(
  (select chat_id from public.service_resolve_telegram_destination(
    'f6a10000-0000-4000-8000-000000000001', null) limit 1),
  '-100200002',
  'trusted resolver returns the Artist shared chat id');

reset role;
select is(
  (select chat_id from crm_private.telegram_destinations
   where destination_kind='artist'
     and artist_id='f6a10000-0000-4000-8000-000000000001'
     and is_active),
  '-100200002',
  'Artist group is stored in the private destination registry');

set local role authenticated;
select pg_temp.telegram_claims('{"sub":"f6010000-0000-4000-8000-000000000001","role":"authenticated"}');
select ok(
  row_to_json(x)::text not like '%100200002%'
  from (select * from public.list_telegram_destinations()
        where destination_kind='artist'
          and artist_id='f6a10000-0000-4000-8000-000000000001' limit 1) x,
  'Artist connection status also hides the group chat id');

-- Personal disconnect disables both the private target and preference.
select lives_ok(
  $$select public.disconnect_telegram_destination('profile', null)$$,
  'profile can disconnect its own personal Telegram destination');

reset role;
select ok(not (select is_active from crm_private.profile_notification_targets
               where profile_id='f6010000-0000-4000-8000-000000000001'
                 and channel='telegram'),
  'disconnect disables the private notification target');
select ok(not (select is_enabled from public.notification_preferences
               where profile_id='f6010000-0000-4000-8000-000000000001'
                 and channel='telegram'),
  'disconnect also opts the profile out of Telegram delivery');

set local role service_role;
select pg_temp.telegram_claims('{"role":"service_role"}');
select is(
  (select count(*)::int from public.service_resolve_telegram_destination(
    null, 'f6010000-0000-4000-8000-000000000001')),
  0,
  'disconnected personal destination no longer resolves');

select * from finish(true);
rollback;
