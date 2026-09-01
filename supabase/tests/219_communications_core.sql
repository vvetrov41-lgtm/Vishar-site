-- 219_communications_core.sql
--
-- Migrations 0068-0070: the provider-neutral communications domain, the
-- WhatsApp move into it, and the shared outbound engine.
--
-- Everything here is synthetic. No Meta endpoint is contacted, no provider
-- credential exists, and no message is delivered.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

select has_type('public', 'communication_channel', 'communication_channel exists');
select enum_has_labels(
  'public', 'communication_channel',
  array['whatsapp', 'instagram'],
  'the core knows exactly the channels that are implemented'
);
select enum_has_labels(
  'public', 'communication_origin',
  array['contact', 'crm', 'provider_app', 'automation'],
  'origin is provider-neutral and still distinguishes an app-sent message'
);
select enum_has_labels(
  'public', 'communication_status',
  array['received', 'queued', 'sent', 'delivered', 'read', 'failed'],
  'status is the union of the delivery states any implemented provider reports'
);
select enum_has_labels(
  'public', 'communication_link_state',
  array['unmatched', 'linked'],
  'a conversation is either matched to a client or explicitly not'
);

select has_table('public', 'communication_conversations', 'the neutral conversation store exists');
select has_table('public', 'communication_messages', 'the neutral message store exists');

select has_column('public', 'communication_conversations', c,
                  'communication_conversations.' || c || ' exists')
from unnest(array[
  'id', 'artist_id', 'channel', 'integration_key', 'external_contact_id',
  'external_username', 'external_display_label', 'client_id', 'enquiry_id',
  'link_state', 'state', 'last_message_at', 'last_inbound_at',
  'last_outbound_at', 'operator_read_at', 'provider_referral',
  'created_at', 'updated_at'
]) as c;

select has_column('public', 'communication_messages', c,
                  'communication_messages.' || c || ' exists')
from unnest(array[
  'id', 'conversation_id', 'artist_id', 'channel', 'direction', 'origin',
  'status', 'message_type', 'body', 'attachments', 'media_state',
  'provider_message_id', 'provider_timestamp', 'sent_at', 'delivered_at',
  'read_at', 'failed_at', 'error_code', 'created_by', 'created_at', 'updated_at'
]) as c;

-- A non-text message legitimately has no text. A NOT NULL body would have
-- forced a fabricated placeholder for every image, share or story reply.
select col_is_null('public', 'communication_messages', 'body',
                   'a message body is nullable so non-text messages stay honest');

select col_is_unique(
  'public', 'communication_conversations',
  array['artist_id', 'channel', 'external_contact_id'],
  'one artist has at most one conversation per participant per channel'
);
select col_is_unique(
  'public', 'communication_messages',
  array['artist_id', 'channel', 'provider_message_id'],
  'a provider message id deduplicates within one artist and channel'
);

-- ---------------------------------------------------------------------------
-- Table privileges and row level security
-- ---------------------------------------------------------------------------

select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_class where oid = 'public.communication_conversations'::regclass),
  'row level security is enabled and forced on conversations'
);
select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_class where oid = 'public.communication_messages'::regclass),
  'row level security is enabled and forced on messages'
);

select ok(
  not has_table_privilege('anon', 'public.communication_conversations', 'SELECT'),
  'anon cannot read conversations'
);
select ok(
  not has_table_privilege('anon', 'public.communication_messages', 'SELECT'),
  'anon cannot read messages'
);
select ok(
  has_table_privilege('authenticated', 'public.communication_conversations', 'SELECT'),
  'authenticated CRM sessions may read conversations, subject to RLS'
);
select ok(
  not has_table_privilege('authenticated', 'public.communication_conversations', 'INSERT'),
  'a browser session has no direct write grant on conversations'
);
select ok(
  not has_table_privilege('authenticated', 'public.communication_messages', 'UPDATE'),
  'a browser session cannot rewrite message history or delivery state'
);

-- ---------------------------------------------------------------------------
-- Neutral engine function ACL and hardening
-- ---------------------------------------------------------------------------

select ok(
  not has_function_privilege('anon', 'public.queue_communication_message(uuid,text,uuid)', 'EXECUTE'),
  'anon cannot queue a reply'
);
select ok(
  has_function_privilege('authenticated', 'public.queue_communication_message(uuid,text,uuid)', 'EXECUTE'),
  'an authenticated CRM session may queue a reply'
);
select ok(
  not has_function_privilege('service_role', 'public.queue_communication_message(uuid,text,uuid)', 'EXECUTE'),
  'the public Worker credential cannot impersonate a CRM reply'
);

select ok(
  not has_function_privilege('authenticated', 'public.claim_communication_outbox(text,text,integer,integer)', 'EXECUTE'),
  'a browser session cannot claim outbound jobs'
);
select ok(
  has_function_privilege('service_role', 'public.claim_communication_outbox(text,text,integer,integer)', 'EXECUTE'),
  'only the trusted backend claims outbound jobs'
);
select ok(
  not has_function_privilege('authenticated', 'public.record_communication_outbox_result(uuid,text,boolean,text,text)', 'EXECUTE'),
  'a browser session cannot acknowledge an outbound job'
);
select ok(
  not has_function_privilege('authenticated', 'public.record_communication_inbound_message(uuid,text,text,text,text,timestamptz,text,text,jsonb,jsonb)', 'EXECUTE'),
  'a browser session cannot fabricate an inbound message'
);
select ok(
  not has_function_privilege('anon', 'public.record_communication_inbound_message(uuid,text,text,text,text,timestamptz,text,text,jsonb,jsonb)', 'EXECUTE'),
  'anon cannot fabricate an inbound message'
);

-- Every SECURITY DEFINER surface added by this work pins its search_path.
select ok(
  (select bool_and(
     p.prosecdef
     and 'search_path=pg_catalog, public, crm_private' = any (p.proconfig)
   )
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'queue_communication_message',
       'claim_communication_outbox',
       'claim_communication_outbox_by_id',
       'record_communication_outbox_result',
       'record_communication_inbound_message',
       'record_communication_message_status'
     )),
  'every communications RPC is SECURITY DEFINER with a fixed search_path'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.artist_integrations
  (id, artist_id, integration_type, provider, integration_key, configuration, is_enabled)
values
  ('f9111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'whatsapp', 'meta_cloud_api', 'vladimir-production', '{}'::jsonb, true),
  ('f9222222-2222-4222-8222-222222222222', 'a2222222-2222-4222-8222-222222222222',
   'whatsapp', 'meta_cloud_api', 'kristina-production', '{}'::jsonb, true);

insert into public.clients (id, full_name, email, phone) values
  ('19111111-1111-4111-8111-111111111111', 'Core Vladimir Client', 'core.v@example.test', '+44 7700 901111'),
  ('19222222-2222-4222-8222-222222222222', 'Core Kristina Client', 'core.k@example.test', '+44 7700 902222');

insert into public.communication_conversations
  (id, artist_id, channel, client_id, link_state, integration_key, external_contact_id)
values
  ('29111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'whatsapp', '19111111-1111-4111-8111-111111111111', 'linked',
   'vladimir-production', '447700901111'),
  ('29222222-2222-4222-8222-222222222222', 'a2222222-2222-4222-8222-222222222222',
   'whatsapp', '19222222-2222-4222-8222-222222222222', 'linked',
   'kristina-production', '447700902222');

insert into auth.users (id, email) values
  ('39111111-1111-4111-8111-111111111111', 'core.owner@example.test'),
  ('39222222-2222-4222-8222-222222222222', 'core.manager@example.test');
insert into public.profiles (id, email, role, is_active) values
  ('39111111-1111-4111-8111-111111111111', 'core.owner@example.test', 'owner', true),
  ('39222222-2222-4222-8222-222222222222', 'core.manager@example.test', 'booking_manager', true);
insert into public.artist_memberships
  (profile_id, artist_id, access_level, can_manage_sessions, can_manage_integrations, is_active)
values
  ('39222222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111',
   'manager', true, true, true);

create function pg_temp.core_claims(p text) returns void language sql as
  $$select set_config('request.jwt.claims', p, true)::void$$;
grant execute on function pg_temp.core_claims(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Structural invariants
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.communication_conversations
    (artist_id, channel, link_state, integration_key, external_contact_id)
    values ('a1111111-1111-4111-8111-111111111111', 'whatsapp', 'linked',
            'vladimir-production', '447700909999')$$,
  '23514', null,
  'a conversation cannot claim to be linked without naming a client'
);
select throws_ok(
  $$insert into public.communication_conversations
    (artist_id, channel, client_id, link_state, integration_key, external_contact_id)
    values ('a1111111-1111-4111-8111-111111111111', 'whatsapp',
            '19111111-1111-4111-8111-111111111111', 'unmatched',
            'vladimir-production', '447700909998')$$,
  '23514', null,
  'a conversation that names a client cannot claim to be unmatched'
);
-- An Instagram-scoped id is not a phone number, and a WhatsApp id is not free
-- text. The shape check is channel-aware rather than lowest-common-denominator.
select throws_ok(
  $$insert into public.communication_conversations
    (artist_id, channel, link_state, integration_key, external_contact_id)
    values ('a1111111-1111-4111-8111-111111111111', 'whatsapp', 'unmatched',
            'vladimir-production', 'not-a-phone-number')$$,
  '23514', null,
  'a WhatsApp participant id must still be digits'
);

-- ---------------------------------------------------------------------------
-- Queueing a reply resolves everything from the stored conversation
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.core_claims('{"sub":"39222222-2222-4222-8222-222222222222","role":"authenticated"}');

select is(
  public.queue_communication_message(
    '29111111-1111-4111-8111-111111111111',
    'Neutral engine reply',
    '49111111-1111-4111-8111-111111111111'
  ) ->> 'status',
  'queued',
  'a manager can queue a reply on their own artist conversation'
);
select is(
  (public.queue_communication_message(
    '29111111-1111-4111-8111-111111111111',
    'Neutral engine reply',
    '49111111-1111-4111-8111-111111111111'
  ) ->> 'replayed')::boolean,
  true,
  'the same request id replays instead of sending a duplicate'
);
select throws_ok(
  $$select public.queue_communication_message(
      '29222222-2222-4222-8222-222222222222',
      'cross-artist attempt',
      '49222222-2222-4222-8222-222222222222')$$,
  '42501', null,
  'a Vladimir manager cannot queue a reply into a Kristina conversation'
);
reset role;

select is(
  (select count(*)::int from public.integration_outbox
   where dedupe_key = 'whatsapp:send:49111111-1111-4111-8111-111111111111'),
  1,
  'exactly one durable job exists for the replayed request id'
);
select is(
  (select kind::text from public.integration_outbox
   where dedupe_key = 'whatsapp:send:49111111-1111-4111-8111-111111111111'),
  'whatsapp_message',
  'the neutral queue still uses the channel-specific outbox kind'
);
select ok(
  (select payload = jsonb_build_object(
     'communication_message_id', payload ->> 'communication_message_id')
   from public.integration_outbox
   where dedupe_key = 'whatsapp:send:49111111-1111-4111-8111-111111111111'),
  'the durable job payload carries only the message identifier'
);
-- The audit trail must not carry the participant or the message text.
select ok(
  (select not (metadata::text like '%447700901111%')
      and not (metadata::text like '%Neutral engine reply%')
   from public.activity_log
   where event_type = 'whatsapp.queued'
   order by occurred_at desc limit 1),
  'the activity trail records no participant identifier and no message body'
);

-- ---------------------------------------------------------------------------
-- Delivery state is monotonic and replay safe
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.communication_messages
  (id, conversation_id, artist_id, channel, direction, origin, status,
   message_type, body, provider_message_id, provider_timestamp)
values
  ('59111111-1111-4111-8111-111111111111', '29111111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'outbound', 'crm', 'sent',
   'text', 'status probe', 'wamid.SYNTHETICCORE0001', '2026-08-16 09:00:00+00');

select is(
  public.record_communication_message_status(
    'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'vladimir-production',
    'wamid.SYNTHETICCORE0001', 'delivered', '2026-08-16 09:01:00+00'
  ) ->> 'status',
  'delivered',
  'a later provider status advances the message'
);
select is(
  (public.record_communication_message_status(
    'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'vladimir-production',
    'wamid.SYNTHETICCORE0001', 'sent', '2026-08-16 09:02:00+00'
  ) ->> 'changed')::boolean,
  false,
  'an out-of-order status cannot move a message backwards'
);
select is(
  (select status::text from public.communication_messages
   where id = '59111111-1111-4111-8111-111111111111'),
  'delivered',
  'the message stays at its furthest reached state'
);
select is(
  (public.record_communication_message_status(
    'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'vladimir-production',
    'wamid.SYNTHETICCORE0001', 'failed', '2026-08-16 09:03:00+00'
  ) ->> 'changed')::boolean,
  false,
  'a provider cannot fail a message it already reported as delivered'
);
select is(
  (public.record_communication_message_status(
    'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'vladimir-production',
    'wamid.UNKNOWNMESSAGE001', 'delivered', '2026-08-16 09:04:00+00'
  ) ->> 'changed')::boolean,
  false,
  'a status for an unknown message is a safe no-op rather than an error'
);
select throws_ok(
  $$select public.record_communication_message_status(
      'a2222222-2222-4222-8222-222222222222', 'whatsapp', 'vladimir-production',
      'wamid.SYNTHETICCORE0001', 'read', '2026-08-16 09:05:00+00')$$,
  '23503', null,
  'a status cannot be applied through another artist route'
);

select * from finish();
rollback;
