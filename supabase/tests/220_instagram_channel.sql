-- 220_instagram_channel.sql
--
-- Migration 0071: artist-scoped Instagram Professional messaging.
--
-- Every identifier here is synthetic. No Meta endpoint is contacted, no access
-- token exists anywhere in this suite, and nothing is delivered.
--
-- The property this file exists to prove is that a webhook body cannot choose a
-- CRM artist. A single Meta app serves both artists, so the signature that the
-- Worker verifies proves only that Meta sent the payload. Artist resolution is
-- a separate backend-owned lookup, and it must fail closed for an account the
-- CRM does not know.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Function ACL and hardening
-- ---------------------------------------------------------------------------

select has_function('public', 'service_resolve_instagram_route', array['text'],
                    'the backend Instagram route resolver exists');
select has_function('public', 'service_set_instagram_integration',
                    array['uuid', 'text', 'text', 'text', 'text[]'],
                    'the backend Instagram connection binder exists');
select has_function('public', 'service_authorize_instagram_connection',
                    array['uuid', 'uuid'],
                    'the backend Instagram operator authorizer exists');

select ok(
  not has_function_privilege('anon', 'public.service_resolve_instagram_route(text)', 'EXECUTE'),
  'anon cannot resolve an Instagram route'
);
select ok(
  not has_function_privilege('authenticated', 'public.service_resolve_instagram_route(text)', 'EXECUTE'),
  'a browser session cannot resolve an Instagram route'
);
select ok(
  has_function_privilege('service_role', 'public.service_resolve_instagram_route(text)', 'EXECUTE'),
  'only the trusted connector resolves an Instagram route'
);
select ok(
  not has_function_privilege('anon', 'public.service_authorize_instagram_connection(uuid,uuid)', 'EXECUTE'),
  'anon cannot authorize an Instagram operator'
);
select ok(
  not has_function_privilege('authenticated', 'public.service_authorize_instagram_connection(uuid,uuid)', 'EXECUTE'),
  'a browser session cannot call the backend Instagram operator authorizer'
);
select ok(
  has_function_privilege('service_role', 'public.service_authorize_instagram_connection(uuid,uuid)', 'EXECUTE'),
  'only the trusted connector can call the backend Instagram operator authorizer'
);
select ok(
  not has_function_privilege('authenticated', 'public.service_set_instagram_integration(uuid,text,text,text,text[])', 'EXECUTE'),
  'a browser session cannot bind an Instagram account to an artist'
);
select ok(
  not has_function_privilege('authenticated', 'public.record_communication_outbound_echo(uuid,text,text,text,text,timestamptz,text,text,jsonb)', 'EXECUTE'),
  'a browser session cannot fabricate a provider echo'
);
select ok(
  not has_function_privilege('authenticated', 'public.record_communication_read_receipt(uuid,text,text,text,text,timestamptz)', 'EXECUTE'),
  'a browser session cannot fabricate a read receipt'
);

select ok(
  (select bool_and(
     p.prosecdef
     and 'search_path=pg_catalog, public, crm_private' = any (p.proconfig)
   )
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'service_authorize_instagram_connection',
       'service_set_instagram_integration',
       'service_disable_instagram_integration',
       'service_resolve_instagram_route',
       'record_communication_read_receipt',
       'record_communication_outbound_echo',
       'service_update_communication_participant'
     )),
  'every Instagram RPC is SECURITY DEFINER with a fixed search_path'
);

-- ---------------------------------------------------------------------------
-- Connection binding
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);


select is(
  (select integration_key
   from public.service_authorize_instagram_connection(
     (select profile_id from crm_private.profile_access where role = 'owner' and is_active limit 1),
     'a1111111-1111-4111-8111-111111111111'
   )),
  'vladimir-instagram',
  'the trusted connector can authorize an active owner membership without a browser-supplied profile id'
);

select throws_ok(
  $$select * from public.service_authorize_instagram_connection(
      'c9999999-9999-4999-8999-999999999999',
      'a1111111-1111-4111-8111-111111111111')$$,
  '42501', null,
  'an unknown profile fails closed even when the backend calls the RPC'
);

select is(
  (public.service_set_instagram_integration(
    'a1111111-1111-4111-8111-111111111111',
    'vladimir-instagram',
    '17841400000000001',
    'vladimir.synthetic',
    array['instagram_business_basic', 'instagram_business_manage_messages']
  ) ->> 'is_enabled')::boolean,
  true,
  'the connector can bind Vladimir Instagram account after verifying it server-side'
);

select is(
  (public.service_set_instagram_integration(
    'a2222222-2222-4222-8222-222222222222',
    'kristina-instagram',
    '17841400000000002',
    'kristina.synthetic',
    array['instagram_business_basic', 'instagram_business_manage_messages']
  ) ->> 'is_enabled')::boolean,
  true,
  'the connector can bind Kristina own Instagram account'
);

-- No token, refresh token or app secret may ever reach the database.
select ok(
  (select not (configuration::text ~* '(token|secret|password|bearer)')
   from public.artist_integrations
   where integration_key = 'vladimir-instagram'),
  'the stored Instagram configuration holds no credential-shaped value'
);

select throws_ok(
  $$select public.service_set_instagram_integration(
      'a1111111-1111-4111-8111-111111111111', 'vladimir-instagram-2',
      '17841400000000003', 'vladimir.two', array['instagram_business_basic'])$$,
  '22023', null,
  'a connection that did not grant messaging permission is refused'
);

-- One Instagram account belongs to one artist. Reassignment must be an
-- explicit disconnect, never a side effect of reconnecting.
select throws_ok(
  $$select public.service_set_instagram_integration(
      'a2222222-2222-4222-8222-222222222222', 'kristina-instagram-alt',
      '17841400000000001', 'vladimir.synthetic',
      array['instagram_business_basic', 'instagram_business_manage_messages'])$$,
  '23514', null,
  'one artist cannot claim an Instagram account already connected to another'
);

-- The selector deterministically becomes an encrypted binding name, so it must
-- stay inside the owning artist's slug namespace.
select throws_ok(
  $$insert into public.artist_integrations
      (artist_id, integration_type, provider, integration_key, configuration, is_enabled)
    values ('a1111111-1111-4111-8111-111111111111', 'instagram', 'instagram_login',
            'kristina-borrowed', '{"instagram_user_id":"17841400000000009"}'::jsonb, true)$$,
  '23514', null,
  'a Vladimir Instagram integration cannot use a Kristina-namespaced selector'
);

-- An enabled route with no account could never resolve a webhook.
select throws_ok(
  $$insert into public.artist_integrations
      (artist_id, integration_type, provider, integration_key, configuration, is_enabled)
    values ('a1111111-1111-4111-8111-111111111111', 'instagram', 'instagram_login',
            'vladimir-empty', '{}'::jsonb, true)$$,
  '23514', null,
  'an enabled Instagram route must record the account it belongs to'
);

-- ---------------------------------------------------------------------------
-- Server-authoritative routing
-- ---------------------------------------------------------------------------

select is(
  (select artist_id from public.service_resolve_instagram_route('17841400000000001')),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'a known account resolves to exactly the artist that connected it'
);
select is(
  (select artist_id from public.service_resolve_instagram_route('17841400000000002')),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'the second artist resolves to their own account, with no fallback'
);
select throws_ok(
  $$select * from public.service_resolve_instagram_route('17841499999999999')$$,
  '23503', null,
  'an unknown Instagram account fails closed instead of choosing a default artist'
);

select is(
  (public.service_disable_instagram_integration(
    'a2222222-2222-4222-8222-222222222222', 'kristina-instagram', 'operator_disconnect'
  ) ->> 'changed')::boolean,
  true,
  'the connector can disconnect an artist Instagram route'
);
select throws_ok(
  $$select * from public.service_resolve_instagram_route('17841400000000002')$$,
  '23503', null,
  'a disconnected account stops resolving immediately'
);

-- ---------------------------------------------------------------------------
-- Inbound ingestion
-- ---------------------------------------------------------------------------

select is(
  (public.record_communication_inbound_message(
    'a1111111-1111-4111-8111-111111111111', 'instagram', 'vladimir-instagram',
    '9876543210001', 'ig_mid_SYNTHETIC000001',
    '2026-08-17 10:00:00+00', 'text', 'Hi, do you do cover ups?'
  ) ->> 'changed')::boolean,
  true,
  'a routed Instagram direct message is persisted'
);

select is(
  (select count(*)::int from public.communication_messages
   where channel = 'instagram' and provider_message_id = 'ig_mid_SYNTHETIC000001'),
  1,
  'one webhook message produces exactly one normalised message'
);

select is(
  (select artist_id from public.communication_conversations
   where channel = 'instagram' and external_contact_id = '9876543210001'),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'the conversation belongs to the artist the account resolved to'
);

-- An unknown sender is a conversation, not an enquiry. Creating a tattoo
-- enquiry from every direct message would fill the pipeline with greetings,
-- reactions and spam.
select is(
  (select link_state::text from public.communication_conversations
   where channel = 'instagram' and external_contact_id = '9876543210001'),
  'unmatched',
  'an unknown Instagram sender stays unmatched rather than becoming a client'
);
select is(
  (select count(*)::int from public.enquiries
   where created_from_communication),
  0,
  'no enquiry is created from an inbound direct message'
);

select is(
  (public.record_communication_inbound_message(
    'a1111111-1111-4111-8111-111111111111', 'instagram', 'vladimir-instagram',
    '9876543210001', 'ig_mid_SYNTHETIC000001',
    '2026-08-17 10:00:00+00', 'text', 'Hi, do you do cover ups?'
  ) ->> 'changed')::boolean,
  false,
  'a redelivered webhook is idempotent'
);
select is(
  (select count(*)::int from public.communication_messages
   where channel = 'instagram' and provider_message_id = 'ig_mid_SYNTHETIC000001'),
  1,
  'the duplicate webhook did not duplicate the message'
);

-- Instagram media arrives on short-lived signed CDN URLs. The CRM records what
-- arrived without persisting an expiring URL.
select lives_ok(
  $$select public.record_communication_inbound_message(
      'a1111111-1111-4111-8111-111111111111', 'instagram', 'vladimir-instagram',
      '9876543210001', 'ig_mid_SYNTHETIC000002',
      '2026-08-17 10:05:00+00', 'image', null,
      '[{"type":"image"}]'::jsonb)$$,
  'a non-text Instagram message is represented by its shape'
);
select is(
  (select coalesce(body, 'NULL') || ':' || message_type || ':' || media_state
   from public.communication_messages
   where provider_message_id = 'ig_mid_SYNTHETIC000002'),
  'NULL:image:not_ingested',
  'an image message carries no invented body and no ingested media yet'
);
select throws_ok(
  $$select public.record_communication_inbound_message(
      'a1111111-1111-4111-8111-111111111111', 'instagram', 'vladimir-instagram',
      '9876543210001', 'ig_mid_SYNTHETIC000003',
      '2026-08-17 10:06:00+00', 'image', 'invented caption')$$,
  '22023', null,
  'a non-text message cannot smuggle body text into the timeline'
);

-- The artist argument is not free: the integration must actually belong to it.
select throws_ok(
  $$select public.record_communication_inbound_message(
      'a2222222-2222-4222-8222-222222222222', 'instagram', 'vladimir-instagram',
      '9876543210002', 'ig_mid_SYNTHETIC000004',
      '2026-08-17 10:07:00+00', 'text', 'cross-artist attempt')$$,
  '23503', null,
  'Vladimir Instagram route cannot create a Kristina conversation'
);

-- ---------------------------------------------------------------------------
-- Provider echoes and read receipts
-- ---------------------------------------------------------------------------

insert into public.communication_messages
  (id, conversation_id, artist_id, channel, direction, origin, status,
   message_type, body, provider_message_id, provider_timestamp, sent_at, created_at)
select
  '69111111-1111-4111-8111-111111111111', c.id,
  'a1111111-1111-4111-8111-111111111111', 'instagram', 'outbound', 'crm', 'sent',
  'text', 'We do, send a reference photo.', 'ig_mid_SYNTHETICOUT001',
  '2026-08-17 10:10:00+00', '2026-08-17 10:10:00+00', '2026-08-17 10:10:00+00'
from public.communication_conversations c
where c.channel = 'instagram' and c.external_contact_id = '9876543210001';

-- Instagram publishes a read watermark rather than a per-message receipt.
select is(
  (public.record_communication_read_receipt(
    'a1111111-1111-4111-8111-111111111111', 'instagram', 'vladimir-instagram',
    '9876543210001', 'ig_mid_SYNTHETICOUT001', '2026-08-17 10:12:00+00'
  ) ->> 'messages')::int,
  1,
  'a read watermark marks the outbound messages it covers as read'
);
select is(
  (select status::text from public.communication_messages
   where id = '69111111-1111-4111-8111-111111111111'),
  'read',
  'the covered outbound message is read'
);
select is(
  (public.record_communication_read_receipt(
    'a1111111-1111-4111-8111-111111111111', 'instagram', 'vladimir-instagram',
    '9876543210001', 'ig_mid_UNKNOWNWATERMARK', '2026-08-17 10:13:00+00'
  ) ->> 'changed')::boolean,
  false,
  'a watermark naming a message the CRM never stored is a safe no-op'
);

-- A reply the artist typed in the Instagram app must appear in the CRM
-- timeline, attributed as an app send rather than a CRM send.
select is(
  (public.record_communication_outbound_echo(
    'a1111111-1111-4111-8111-111111111111', 'instagram', 'vladimir-instagram',
    '9876543210001', 'ig_mid_SYNTHETICECHO01', '2026-08-17 10:20:00+00',
    'text', 'Typed in the Instagram app'
  ) ->> 'changed')::boolean,
  true,
  'a provider echo is recorded'
);
select is(
  (select origin::text from public.communication_messages
   where provider_message_id = 'ig_mid_SYNTHETICECHO01'),
  'provider_app',
  'the echo is attributed to the provider app, not to the CRM'
);
select is(
  (public.record_communication_outbound_echo(
    'a1111111-1111-4111-8111-111111111111', 'instagram', 'vladimir-instagram',
    '9876543210001', 'ig_mid_SYNTHETICECHO01', '2026-08-17 10:20:00+00',
    'text', 'Typed in the Instagram app'
  ) ->> 'changed')::boolean,
  false,
  'a redelivered echo does not duplicate the message'
);
-- An echo is an outbound-only event. Opening a conversation from one would
-- invent a contact the CRM never actually heard from.
select is(
  (public.record_communication_outbound_echo(
    'a1111111-1111-4111-8111-111111111111', 'instagram', 'vladimir-instagram',
    '9876543219999', 'ig_mid_SYNTHETICECHO02', '2026-08-17 10:21:00+00',
    'text', 'echo for an unknown participant'
  ) ->> 'changed')::boolean,
  false,
  'an echo never creates a conversation'
);

-- ---------------------------------------------------------------------------
-- Participant enrichment stays outside the webhook path
-- ---------------------------------------------------------------------------

select is(
  (public.service_update_communication_participant(
    'a1111111-1111-4111-8111-111111111111', 'instagram', '9876543210001',
    'synthetic.sender', 'Synthetic Sender'
  ) ->> 'changed')::boolean,
  true,
  'the connector can attach a display handle learned outside the webhook'
);
select is(
  (select external_username from public.communication_conversations
   where channel = 'instagram' and external_contact_id = '9876543210001'),
  'synthetic.sender',
  'the handle is stored for operator recognition'
);
select is(
  (select client_id from public.communication_conversations
   where channel = 'instagram' and external_contact_id = '9876543210001'),
  null::uuid,
  'enrichment never links a client on its own'
);

select * from finish();
rollback;
