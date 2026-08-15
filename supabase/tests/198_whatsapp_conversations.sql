-- 198_whatsapp_conversations.sql
--
-- Migrations 0046/0047: WhatsApp artist integration type, durable conversation
-- and message model, artist-scoped routing and the CRM send RPC.
--
-- Everything here is synthetic. No Meta endpoint is contacted, no provider
-- credential exists, and no message is delivered. The point of the suite is to
-- prove that Vladimir and Kristina remain completely isolated and that a
-- missing route fails closed rather than borrowing the other artist's.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

select has_type('public', 'whatsapp_message_direction',
                'whatsapp_message_direction exists');
select enum_has_labels(
  'public', 'whatsapp_message_direction',
  array['inbound', 'outbound'],
  'a WhatsApp message is inbound or outbound'
);
select has_type('public', 'whatsapp_message_origin', 'whatsapp_message_origin exists');
select enum_has_labels(
  'public', 'whatsapp_message_origin',
  array['contact', 'crm', 'business_app', 'automation'],
  'coexistence needs an explicit origin for Business App sends'
);
select has_type('public', 'whatsapp_message_status', 'whatsapp_message_status exists');
select enum_has_labels(
  'public', 'whatsapp_message_status',
  array['received', 'queued', 'sent', 'delivered', 'read', 'failed'],
  'whatsapp_message_status covers the Meta delivery lifecycle'
);

select has_table('public', 'whatsapp_conversations', 'whatsapp_conversations exists');
select has_table('public', 'whatsapp_messages', 'whatsapp_messages exists');

select has_column('public', 'whatsapp_conversations', c,
                  'whatsapp_conversations.' || c || ' exists')
from unnest(array[
  'id', 'artist_id', 'client_id', 'integration_key', 'contact_wa_id',
  'contact_label', 'last_message_at', 'last_inbound_at', 'created_at', 'updated_at'
]) as c;

select has_column('public', 'whatsapp_messages', c,
                  'whatsapp_messages.' || c || ' exists')
from unnest(array[
  'id', 'conversation_id', 'artist_id', 'direction', 'origin', 'status',
  'message_type', 'body', 'provider_message_id', 'provider_timestamp',
  'delivered_at', 'read_at', 'failed_at', 'error_code', 'created_by',
  'created_at', 'updated_at'
]) as c;

select col_is_unique(
  'public', 'whatsapp_conversations', array['artist_id', 'contact_wa_id'],
  'one artist has at most one conversation per WhatsApp contact'
);
select col_is_unique(
  'public', 'whatsapp_messages', array['artist_id', 'provider_message_id'],
  'a provider message id maps to one row per artist, so a coexistence echo deduplicates'
);

select has_column('public', 'integration_outbox', 'whatsapp_message_id',
                  'the outbox links a WhatsApp job to its message');

-- ---------------------------------------------------------------------------
-- No credential may be stored in CRM-readable integration metadata
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.artist_integrations
    (artist_id, integration_type, provider, integration_key, configuration, is_enabled)
    values ('a1111111-1111-4111-8111-111111111111', 'whatsapp', 'meta_cloud_api',
            'vladimir-whatsapp-token-leak',
            '{"access_token":"unit-test-value"}'::jsonb, false)$$,
  '23514', null,
  'a Meta access token is refused in artist integration configuration'
);
select throws_ok(
  $$insert into public.artist_integrations
    (artist_id, integration_type, provider, integration_key, configuration, is_enabled)
    values ('a1111111-1111-4111-8111-111111111111', 'whatsapp', 'meta_cloud_api',
            'vladimir-whatsapp-secret-leak',
            '{"nested":{"app_secret":"unit-test-value"}}'::jsonb, false)$$,
  '23514', null,
  'a nested Meta app secret is refused in artist integration configuration'
);

-- ---------------------------------------------------------------------------
-- Two independent artist integrations
-- ---------------------------------------------------------------------------

insert into public.artist_integrations (
  id, artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
) values
('d9111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
 'whatsapp', 'meta_cloud_api', 'vladimir-whatsapp',
 'Synthetic Vladimir WhatsApp', '{"coexistence":true}'::jsonb, true),
('d9222222-2222-4222-8222-222222222222', 'a2222222-2222-4222-8222-222222222222',
 'whatsapp', 'meta_cloud_api', 'kristina-whatsapp',
 'Synthetic Kristina WhatsApp', '{"coexistence":true}'::jsonb, true);

select throws_ok(
  $$insert into public.artist_integrations
    (artist_id, integration_type, provider, integration_key, configuration, is_enabled)
    values ('a1111111-1111-4111-8111-111111111111', 'whatsapp', 'meta_cloud_api',
            'vladimir-whatsapp-second', '{}'::jsonb, true)$$,
  '23505', null,
  'one artist cannot hold two enabled WhatsApp routes at once'
);

insert into public.clients (id, full_name, email) values
  ('c9111111-1111-4111-8111-111111111111', 'Vladimir WhatsApp Client', 'wa.vladimir@example.test'),
  ('c9222222-2222-4222-8222-222222222222', 'Kristina WhatsApp Client', 'wa.kristina@example.test');

insert into public.whatsapp_conversations (
  id, artist_id, client_id, integration_key, contact_wa_id, contact_label
) values
('9c111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
 'c9111111-1111-4111-8111-111111111111', 'vladimir-whatsapp', '447700900001', 'Vladimir contact'),
('9c222222-2222-4222-8222-222222222222', 'a2222222-2222-4222-8222-222222222222',
 'c9222222-2222-4222-8222-222222222222', 'kristina-whatsapp', '447700900002', 'Kristina contact');

select throws_ok(
  $$insert into public.whatsapp_conversations
    (artist_id, client_id, integration_key, contact_wa_id)
    values ('a1111111-1111-4111-8111-111111111111',
            'c9111111-1111-4111-8111-111111111111', 'vladimir-whatsapp', '447700900001')$$,
  '23505', null,
  'a second conversation for the same artist and contact is rejected'
);

-- A conversation row cannot claim a message that belongs to another artist.
select throws_ok(
  $$insert into public.whatsapp_messages
    (conversation_id, artist_id, direction, origin, status, body)
    values ('9c111111-1111-4111-8111-111111111111',
            'a2222222-2222-4222-8222-222222222222',
            'outbound', 'crm', 'queued', 'cross-artist attempt')$$,
  '23503', null,
  'a message cannot attach to a conversation owned by a different artist'
);

-- Coexistence invariants.
select throws_ok(
  $$insert into public.whatsapp_messages
    (conversation_id, artist_id, direction, origin, status, body)
    values ('9c111111-1111-4111-8111-111111111111',
            'a1111111-1111-4111-8111-111111111111',
            'inbound', 'crm', 'received', 'inbound cannot be CRM-originated')$$,
  '23514', null,
  'an inbound message must originate from the contact'
);
select throws_ok(
  $$insert into public.whatsapp_messages
    (conversation_id, artist_id, direction, origin, status, body)
    values ('9c111111-1111-4111-8111-111111111111',
            'a1111111-1111-4111-8111-111111111111',
            'outbound', 'business_app', 'queued', 'app sends are never queued here')$$,
  '23514', null,
  'a WhatsApp Business App message can never sit in the CRM send queue'
);
select lives_ok(
  $$insert into public.whatsapp_messages
    (conversation_id, artist_id, direction, origin, status, body,
     provider_message_id, provider_timestamp)
    values ('9c111111-1111-4111-8111-111111111111',
            'a1111111-1111-4111-8111-111111111111',
            'outbound', 'business_app', 'sent', 'Sent by hand from the Business App',
            'wamid.SYNTHETICECHO0001', now())$$,
  'a coexistence echo of a Business App message is storable and attributable'
);

-- ---------------------------------------------------------------------------
-- Backend-only routing
-- ---------------------------------------------------------------------------

insert into public.whatsapp_messages (
  id, conversation_id, artist_id, direction, origin, status, body
) values
('9d111111-1111-4111-8111-111111111111', '9c111111-1111-4111-8111-111111111111',
 'a1111111-1111-4111-8111-111111111111', 'outbound', 'crm', 'queued', 'Vladimir route probe'),
('9d222222-2222-4222-8222-222222222222', '9c222222-2222-4222-8222-222222222222',
 'a2222222-2222-4222-8222-222222222222', 'outbound', 'crm', 'queued', 'Kristina route probe');

insert into public.integration_outbox (
  id, artist_id, kind, dedupe_key, payload, whatsapp_message_id
) values
('9e111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
 'whatsapp_message', 'whatsapp:route-test:vladimir',
 '{"whatsapp_message_id":"9d111111-1111-4111-8111-111111111111"}'::jsonb,
 '9d111111-1111-4111-8111-111111111111'),
('9e222222-2222-4222-8222-222222222222', 'a2222222-2222-4222-8222-222222222222',
 'whatsapp_message', 'whatsapp:route-test:kristina',
 '{"whatsapp_message_id":"9d222222-2222-4222-8222-222222222222"}'::jsonb,
 '9d222222-2222-4222-8222-222222222222');

-- The outbox payload may not carry the message text or the contact number.
select throws_ok(
  $$insert into public.integration_outbox (artist_id, kind, dedupe_key, payload)
    values ('a1111111-1111-4111-8111-111111111111', 'reconciliation',
            'reconciliation:whatsapp:leak', '{"body":"leaked message text"}'::jsonb)$$,
  '23514', null,
  'an outbox payload may not carry a WhatsApp message body'
);
select throws_ok(
  $$insert into public.integration_outbox (artist_id, kind, dedupe_key, payload)
    values ('a1111111-1111-4111-8111-111111111111', 'reconciliation',
            'reconciliation:whatsapp:leak2', '{"whatsapp":"447700900001"}'::jsonb)$$,
  '23514', null,
  'an outbox payload may not carry a WhatsApp contact number'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  (select integration_type::text
   from public.resolve_outbox_route('9e111111-1111-4111-8111-111111111111')),
  'whatsapp', 'a whatsapp_message job resolves to the whatsapp integration type'
);
select is(
  (select integration_key
   from public.resolve_outbox_route('9e111111-1111-4111-8111-111111111111')),
  'vladimir-whatsapp', 'Vladimir resolves to his own WhatsApp binding'
);
select is(
  (select integration_key
   from public.resolve_outbox_route('9e222222-2222-4222-8222-222222222222')),
  'kristina-whatsapp', 'Kristina resolves to her own WhatsApp binding'
);
select isnt(
  (select integration_key
   from public.resolve_outbox_route('9e222222-2222-4222-8222-222222222222')),
  'vladimir-whatsapp', 'there is no cross-artist WhatsApp fallback'
);
select is(
  (select artist_id
   from public.resolve_outbox_route('9e111111-1111-4111-8111-111111111111')),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'the route keeps the event-time artist'
);

-- The route projection carries safe metadata only.
select ok(
  not (
    pg_get_function_result('public.resolve_outbox_route(uuid)'::regprocedure)
      ilike any(array['%token%', '%secret%', '%phone%', '%body%', '%credential%'])
  ),
  'the route projection exposes no token, secret, phone number or message body'
);

reset role;

-- Disabling Vladimir's integration must fail his delivery closed, and must not
-- silently promote Kristina's binding.
update public.artist_integrations
set is_enabled = false
where id = 'd9111111-1111-4111-8111-111111111111';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select * from public.resolve_outbox_route('9e111111-1111-4111-8111-111111111111')$$,
  '22023', null,
  'a missing Vladimir WhatsApp route fails closed instead of using Kristina'
);
select is(
  (select integration_key
   from public.resolve_outbox_route('9e222222-2222-4222-8222-222222222222')),
  'kristina-whatsapp',
  'Kristina keeps delivering while Vladimir is unrouted'
);
reset role;

update public.artist_integrations
set is_enabled = true
where id = 'd9111111-1111-4111-8111-111111111111';

-- ---------------------------------------------------------------------------
-- Privileged RPC ACLs
-- ---------------------------------------------------------------------------

select has_function('public', 'queue_whatsapp_message',
                    array['uuid', 'text', 'uuid'], 'the CRM send RPC exists');

select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc p
    cross join lateral pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) a
    where p.oid = 'public.queue_whatsapp_message(uuid,text,uuid)'::regprocedure
      and a.grantee = 0
      and a.privilege_type = 'EXECUTE'
  ),
  'PUBLIC has no direct EXECUTE grant on the WhatsApp send RPC'
);
select ok(
  not has_function_privilege('anon', 'public.queue_whatsapp_message(uuid,text,uuid)', 'EXECUTE'),
  'anon cannot queue a WhatsApp message'
);
select ok(
  has_function_privilege('authenticated', 'public.queue_whatsapp_message(uuid,text,uuid)', 'EXECUTE'),
  'an authenticated CRM session may queue a WhatsApp message'
);
select ok(
  not has_function_privilege('service_role', 'public.queue_whatsapp_message(uuid,text,uuid)', 'EXECUTE'),
  'the public Worker credential cannot queue CRM WhatsApp messages'
);
select ok(
  (select p.prosecdef
   from pg_catalog.pg_proc p
   where p.oid = 'public.queue_whatsapp_message(uuid,text,uuid)'::regprocedure),
  'the WhatsApp send RPC is SECURITY DEFINER'
);
select ok(
  (select 'search_path=pg_catalog, public, crm_private' = any(p.proconfig)
   from pg_catalog.pg_proc p
   where p.oid = 'public.queue_whatsapp_message(uuid,text,uuid)'::regprocedure),
  'the WhatsApp send RPC has a fixed search_path'
);

-- ---------------------------------------------------------------------------
-- Authorization and artist isolation
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('69111111-1111-4111-8111-111111111111', 'wa.owner@example.test'),
  ('69222222-2222-4222-8222-222222222222', 'wa.vladimir.manager@example.test'),
  ('69333333-3333-4333-8333-333333333333', 'wa.reader@example.test'),
  ('69444444-4444-4444-8444-444444444444', 'wa.inactive.profile@example.test'),
  ('69555555-5555-4555-8555-555555555555', 'wa.inactive.membership@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('69111111-1111-4111-8111-111111111111', 'wa.owner@example.test', 'WA Owner', 'owner', true),
  ('69222222-2222-4222-8222-222222222222', 'wa.vladimir.manager@example.test', 'WA Manager', 'booking_manager', true),
  ('69333333-3333-4333-8333-333333333333', 'wa.reader@example.test', 'WA Reader', 'read_only', true),
  ('69444444-4444-4444-8444-444444444444', 'wa.inactive.profile@example.test', 'WA Inactive', 'booking_manager', false),
  ('69555555-5555-4555-8555-555555555555', 'wa.inactive.membership@example.test', 'WA Lapsed', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  -- Vladimir only. Kristina is deliberately absent.
  ('69222222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, true, true),
  ('69333333-3333-4333-8333-333333333333', 'a1111111-1111-4111-8111-111111111111',
   'read_only', false, false, false, false, true),
  ('69444444-4444-4444-8444-444444444444', 'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, true, true),
  ('69555555-5555-4555-8555-555555555555', 'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, true, false);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated;

-- Owner: full access to both artists.
set local role authenticated;
select pg_temp.claims('{"sub":"69111111-1111-4111-8111-111111111111","role":"authenticated"}');
select is(
  (select count(*)::int from public.whatsapp_conversations), 2,
  'the owner sees both artists'' WhatsApp conversations'
);
select lives_ok(
  $$select public.queue_whatsapp_message(
      '9c111111-1111-4111-8111-111111111111', 'Owner reply', gen_random_uuid())$$,
  'the owner may queue a WhatsApp message for Vladimir'
);
select lives_ok(
  $$select public.queue_whatsapp_message(
      '9c222222-2222-4222-8222-222222222222', 'Owner reply', gen_random_uuid())$$,
  'the owner may queue a WhatsApp message for Kristina'
);
reset role;

-- Scoped manager: Vladimir yes, Kristina no.
set local role authenticated;
select pg_temp.claims('{"sub":"69222222-2222-4222-8222-222222222222","role":"authenticated"}');
select is(
  (select count(*)::int from public.whatsapp_conversations), 1,
  'a Vladimir-only manager sees exactly one conversation'
);
select is(
  (select artist_id from public.whatsapp_conversations),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'the visible conversation belongs to Vladimir'
);
select lives_ok(
  $$select public.queue_whatsapp_message(
      '9c111111-1111-4111-8111-111111111111', 'Manager reply', gen_random_uuid())$$,
  'a scoped manager may reply on the artist they belong to'
);
select throws_ok(
  $$select public.queue_whatsapp_message(
      '9c222222-2222-4222-8222-222222222222', 'Manager reply', gen_random_uuid())$$,
  '42501', 'artist access is not permitted',
  'a Vladimir manager cannot send from Kristina''s WhatsApp account'
);
reset role;

-- Read-only membership may not send.
set local role authenticated;
select pg_temp.claims('{"sub":"69333333-3333-4333-8333-333333333333","role":"authenticated"}');
select throws_ok(
  $$select public.queue_whatsapp_message(
      '9c111111-1111-4111-8111-111111111111', 'Read-only reply', gen_random_uuid())$$,
  '42501', 'artist access is not permitted',
  'a read-only member cannot send a WhatsApp message'
);
reset role;

-- A deactivated profile may not send even with a live membership row.
set local role authenticated;
select pg_temp.claims('{"sub":"69444444-4444-4444-8444-444444444444","role":"authenticated"}');
select throws_ok(
  $$select public.queue_whatsapp_message(
      '9c111111-1111-4111-8111-111111111111', 'Inactive profile reply', gen_random_uuid())$$,
  '42501', 'artist access is not permitted',
  'a deactivated profile cannot send a WhatsApp message'
);
select is(
  (select count(*)::int from public.whatsapp_conversations), 0,
  'a deactivated profile sees no WhatsApp conversations'
);
reset role;

-- An inactive membership may not send either.
set local role authenticated;
select pg_temp.claims('{"sub":"69555555-5555-4555-8555-555555555555","role":"authenticated"}');
select throws_ok(
  $$select public.queue_whatsapp_message(
      '9c111111-1111-4111-8111-111111111111', 'Lapsed membership reply', gen_random_uuid())$$,
  '42501', 'artist access is not permitted',
  'an inactive membership cannot send a WhatsApp message'
);
reset role;

-- ---------------------------------------------------------------------------
-- Send semantics
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"69222222-2222-4222-8222-222222222222","role":"authenticated"}');

select throws_ok(
  $$select public.queue_whatsapp_message(
      '9c111111-1111-4111-8111-111111111111', '   ', gen_random_uuid())$$,
  '22023', null,
  'an empty WhatsApp message body is rejected'
);
select throws_ok(
  $$select public.queue_whatsapp_message(
      '9c111111-1111-4111-8111-111111111111', repeat('x', 4097), gen_random_uuid())$$,
  '22023', null,
  'an oversized WhatsApp message body is rejected'
);
select throws_ok(
  $$select public.queue_whatsapp_message(
      '99999999-9999-4999-8999-999999999999', 'Unknown conversation', gen_random_uuid())$$,
  '23503', null,
  'an unknown conversation reveals nothing'
);

-- Idempotency: the same request id returns the original message.
create temporary table wa_send_probe as
select public.queue_whatsapp_message(
  '9c111111-1111-4111-8111-111111111111',
  'Idempotent reply',
  '7a111111-1111-4111-8111-111111111111'
) as first_result;

select is(
  (select (first_result ->> 'replayed')::boolean from wa_send_probe), false,
  'the first send is not a replay'
);
select is(
  (select (public.queue_whatsapp_message(
     '9c111111-1111-4111-8111-111111111111',
     'Idempotent reply',
     '7a111111-1111-4111-8111-111111111111') ->> 'replayed')::boolean),
  true,
  'the same request id replays instead of queueing a second message'
);
select is(
  (select public.queue_whatsapp_message(
     '9c111111-1111-4111-8111-111111111111',
     'Idempotent reply',
     '7a111111-1111-4111-8111-111111111111') ->> 'message_id'),
  (select first_result ->> 'message_id' from wa_send_probe),
  'the replay returns the original message id'
);

reset role;

-- The queued job is durable, artist-scoped and carries an identifier only.
select is(
  (select count(*)::int from public.integration_outbox
   where dedupe_key = 'whatsapp:send:7a111111-1111-4111-8111-111111111111'), 1,
  'exactly one durable job exists for the replayed request id'
);
select is(
  (select artist_id from public.integration_outbox
   where dedupe_key = 'whatsapp:send:7a111111-1111-4111-8111-111111111111'),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'the queued job is owned by the conversation''s artist'
);
select ok(
  (select payload = jsonb_build_object(
     'whatsapp_message_id', payload ->> 'whatsapp_message_id')
   from public.integration_outbox
   where dedupe_key = 'whatsapp:send:7a111111-1111-4111-8111-111111111111'),
  'the durable job payload carries only the message identifier'
);
select is(
  (select m.status::text from public.whatsapp_messages m
   join public.integration_outbox o on o.whatsapp_message_id = m.id
   where o.dedupe_key = 'whatsapp:send:7a111111-1111-4111-8111-111111111111'),
  'queued',
  'the stored message is queued before any provider call'
);

-- The audit trail records the send without copying the contact or the body.
select ok(
  (select count(*) from public.activity_log
   where event_type = 'whatsapp.queued') > 0,
  'queueing a WhatsApp message writes an audit event'
);
select ok(
  not exists (
    select 1 from public.activity_log
    where event_type = 'whatsapp.queued'
      and (metadata::text like '%447700900001%'
           or metadata::text ilike '%Idempotent reply%')
  ),
  'the audit trail records no WhatsApp contact number or message body'
);

-- A queued send requires the artist's own enabled integration.
update public.artist_integrations
set is_enabled = false
where id = 'd9111111-1111-4111-8111-111111111111';

set local role authenticated;
select pg_temp.claims('{"sub":"69222222-2222-4222-8222-222222222222","role":"authenticated"}');
select throws_ok(
  $$select public.queue_whatsapp_message(
      '9c111111-1111-4111-8111-111111111111', 'No route', gen_random_uuid())$$,
  '23503', null,
  'a send fails closed when the artist has no enabled WhatsApp integration'
);
reset role;

select * from finish(true);
rollback;
