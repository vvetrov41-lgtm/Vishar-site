-- 200_whatsapp_inbound_ingestion.sql
--
-- Migration 0049: backend-only ingestion of Meta webhook deliveries.
--
-- Everything is synthetic. The suite proves that the artist is resolved from
-- the enabled integration key rather than from anything a payload could carry,
-- that repeated Meta deliveries are idempotent, and that a coexistence echo of
-- a CRM-sent message collapses onto the original row instead of duplicating
-- the conversation timeline.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- ACLs
-- ---------------------------------------------------------------------------

select ok(
  not has_function_privilege('anon', 'public.' || sig, 'EXECUTE'),
  'anon cannot reach ' || sig
) from unnest(array[
  'record_whatsapp_inbound_message(text,text,text,text,text,timestamptz,text)',
  'record_whatsapp_echo_message(text,text,text,text,text,timestamptz)',
  'record_whatsapp_status_update(text,text,text,timestamptz,text)'
]) as sig;

select ok(
  not has_function_privilege('authenticated', 'public.' || sig, 'EXECUTE'),
  'a CRM browser session cannot reach ' || sig
) from unnest(array[
  'record_whatsapp_inbound_message(text,text,text,text,text,timestamptz,text)',
  'record_whatsapp_echo_message(text,text,text,text,text,timestamptz)',
  'record_whatsapp_status_update(text,text,text,timestamptz,text)'
]) as sig;

select ok(
  has_function_privilege('service_role', 'public.' || sig, 'EXECUTE'),
  'the trusted backend may call ' || sig
) from unnest(array[
  'record_whatsapp_inbound_message(text,text,text,text,text,timestamptz,text)',
  'record_whatsapp_echo_message(text,text,text,text,text,timestamptz)',
  'record_whatsapp_status_update(text,text,text,timestamptz,text)'
]) as sig;

select ok(
  (select 'search_path=pg_catalog, public, crm_private' = any(p.proconfig)
   from pg_catalog.pg_proc p
   where p.oid = 'public.record_whatsapp_inbound_message(text,text,text,text,text,timestamptz,text)'::regprocedure),
  'inbound ingestion has a fixed search_path'
);

-- The private resolver is reachable from nowhere but the SECURITY DEFINER
-- entry points above.
select ok(
  not has_function_privilege('service_role',
    'crm_private.resolve_whatsapp_conversation(text,text,text)', 'EXECUTE'),
  'even the backend cannot call the private conversation resolver directly'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into public.artist_integrations (
  id, artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
) values
('db111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
 'whatsapp', 'meta_cloud_api', 'vladimir-production',
 'Synthetic Vladimir WhatsApp', '{"coexistence":true}'::jsonb, true),
('db222222-2222-4222-8222-222222222222', 'a2222222-2222-4222-8222-222222222222',
 'whatsapp', 'meta_cloud_api', 'kristina-production',
 'Synthetic Kristina WhatsApp', '{"coexistence":true}'::jsonb, true);

-- ---------------------------------------------------------------------------
-- Backend-only
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok(
  $$select public.record_whatsapp_inbound_message(
      'vladimir-production', '447700900031', 'wamid.INBOUND00001', 'text',
      'hello', now(), null)$$,
  '42501', 'WhatsApp ingestion is backend-only',
  'a CRM session cannot inject an inbound WhatsApp message'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- Server-side artist resolution
-- ---------------------------------------------------------------------------

-- The ingestion call is materialised first. Calling it inside a WHERE clause
-- against an initially-empty table would never execute it.
create temporary table wa_ingest_vladimir as
select public.record_whatsapp_inbound_message(
  'vladimir-production', '447700900031', 'wamid.INBOUND00001', 'text',
  'Hello from a new client', now(), 'New Client') as result;

create temporary table wa_ingest_kristina as
select public.record_whatsapp_inbound_message(
  'kristina-production', '447700900032', 'wamid.INBOUND00002', 'text',
  'Hello Kristina', now(), null) as result;

select is(
  (select c.artist_id
   from public.whatsapp_conversations c
   join wa_ingest_vladimir v on c.id = (v.result ->> 'conversation_id')::uuid),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'the integration key resolves Vladimir server-side'
);
select is(
  (select c.artist_id
   from public.whatsapp_conversations c
   join wa_ingest_kristina k on c.id = (k.result ->> 'conversation_id')::uuid),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'the integration key resolves Kristina server-side'
);

select throws_ok(
  $$select public.record_whatsapp_inbound_message(
      'unknown-integration', '447700900033', 'wamid.INBOUND00003', 'text',
      'hello', now(), null)$$,
  '23503', null,
  'an unknown integration key fails closed'
);

update public.artist_integrations
set is_enabled = false
where id = 'db222222-2222-4222-8222-222222222222';
select throws_ok(
  $$select public.record_whatsapp_inbound_message(
      'kristina-production', '447700900034', 'wamid.INBOUND00004', 'text',
      'hello', now(), null)$$,
  '23503', null,
  'a disabled integration cannot receive messages'
);
update public.artist_integrations
set is_enabled = true
where id = 'db222222-2222-4222-8222-222222222222';

-- The two artists never share a conversation, even for the same contact.
select is(
  (select count(distinct artist_id)::int from public.whatsapp_conversations
   where contact_wa_id in ('447700900031', '447700900032')),
  2,
  'each artist owns their own conversation with their own contact'
);

select lives_ok(
  $$select public.record_whatsapp_inbound_message(
      'kristina-production', '447700900031', 'wamid.INBOUND00005', 'text',
      'Same number, different artist', now(), null)$$,
  'the same WhatsApp contact may hold a separate conversation with each artist'
);
select is(
  (select count(*)::int from public.whatsapp_conversations
   where contact_wa_id = '447700900031'),
  2,
  'one contact writing to both artists produces two isolated conversations'
);

-- ---------------------------------------------------------------------------
-- Idempotency
-- ---------------------------------------------------------------------------

create temporary table wa_ingest_replay as
select public.record_whatsapp_inbound_message(
  'vladimir-production', '447700900031', 'wamid.INBOUND00001', 'text',
  'Hello from a new client', now(), null) as result;

select is(
  (select (result ->> 'replayed')::boolean from wa_ingest_replay),
  true,
  'a repeated Meta delivery is idempotent'
);
select is(
  (select count(*)::int from public.whatsapp_messages
   where provider_message_id = 'wamid.INBOUND00001'),
  1,
  'a repeated delivery never duplicates the timeline'
);

select throws_ok(
  $$select public.record_whatsapp_inbound_message(
      'vladimir-production', 'not-a-number', 'wamid.INBOUND00009', 'text',
      'hello', now(), null)$$,
  '22023', null, 'a malformed contact id is refused'
);
select throws_ok(
  $$select public.record_whatsapp_inbound_message(
      'vladimir-production', '447700900031', 'short', 'text',
      'hello', now(), null)$$,
  '22023', null, 'a malformed provider message id is refused'
);

-- ---------------------------------------------------------------------------
-- Coexistence
-- ---------------------------------------------------------------------------

-- A message the artist typed in the WhatsApp Business App.
select is(
  (public.record_whatsapp_echo_message(
     'vladimir-production', '447700900031', 'wamid.ECHO00000001', 'text',
     'Replying from my phone', now()) ->> 'origin'),
  'business_app',
  'a Business App message is stored and attributed to the app'
);
select is(
  (select direction::text from public.whatsapp_messages
   where provider_message_id = 'wamid.ECHO00000001'),
  'outbound',
  'a Business App message is outbound'
);
select is(
  (select status::text from public.whatsapp_messages
   where provider_message_id = 'wamid.ECHO00000001'),
  'sent',
  'a Business App message is already sent by the time the CRM learns of it'
);

-- The decisive case: Meta echoes CRM-sent messages too. An echo of a message
-- this CRM sent must collapse onto the existing row.
insert into public.clients (id, full_name, email)
values ('ce999999-9999-4999-8999-999999999999', 'Echo Client', 'echo@example.test');

insert into public.whatsapp_messages (
  id, conversation_id, artist_id, direction, origin, status,
  message_type, body, provider_message_id
)
select
  'cf111111-1111-4111-8111-111111111111',
  c.id,
  c.artist_id,
  'outbound'::public.whatsapp_message_direction,
  'crm'::public.whatsapp_message_origin,
  'sent'::public.whatsapp_message_status,
  'text',
  'Sent through the CRM',
  'wamid.CRMSENT0000001'
from public.whatsapp_conversations c
where c.artist_id = 'a1111111-1111-4111-8111-111111111111'
  and c.contact_wa_id = '447700900031';

select is(
  (public.record_whatsapp_echo_message(
     'vladimir-production', '447700900031', 'wamid.CRMSENT0000001', 'text',
     'Sent through the CRM', now()) ->> 'replayed')::boolean,
  true,
  'an echo of a CRM-sent message deduplicates against the original row'
);
select is(
  (select count(*)::int from public.whatsapp_messages
   where provider_message_id = 'wamid.CRMSENT0000001'),
  1,
  'the CRM timeline shows one message, not the CRM send plus its echo'
);
select is(
  (select origin::text from public.whatsapp_messages
   where provider_message_id = 'wamid.CRMSENT0000001'),
  'crm',
  'the surviving row keeps its CRM attribution rather than becoming app-sent'
);

-- ---------------------------------------------------------------------------
-- Delivery status is monotonic
-- ---------------------------------------------------------------------------

select is(
  (public.record_whatsapp_status_update(
     'vladimir-production', 'wamid.CRMSENT0000001', 'delivered', now(), null) ->> 'changed')::boolean,
  true,
  'a delivered callback advances the message'
);
select is(
  (select status::text from public.whatsapp_messages
   where provider_message_id = 'wamid.CRMSENT0000001'),
  'delivered', 'the message is delivered'
);
select is(
  (public.record_whatsapp_status_update(
     'vladimir-production', 'wamid.CRMSENT0000001', 'read', now(), null) ->> 'changed')::boolean,
  true,
  'a read callback advances the message further'
);

-- Meta callbacks can arrive out of order and must never move backwards.
select is(
  (public.record_whatsapp_status_update(
     'vladimir-production', 'wamid.CRMSENT0000001', 'sent', now(), null) ->> 'changed')::boolean,
  false,
  'a late sent callback does not undo a recorded read'
);
select is(
  (select status::text from public.whatsapp_messages
   where provider_message_id = 'wamid.CRMSENT0000001'),
  'read', 'the message stays read'
);

select is(
  (public.record_whatsapp_status_update(
     'vladimir-production', 'wamid.NEVERSEEN0001', 'delivered', now(), null) ->> 'matched')::boolean,
  false,
  'a status for an unknown message is acknowledged without error'
);
select throws_ok(
  $$select public.record_whatsapp_status_update(
      'vladimir-production', 'wamid.CRMSENT0000001', 'invented', now(), null)$$,
  '22023', null, 'an unknown delivery status is refused'
);
select throws_ok(
  $$select public.record_whatsapp_status_update(
      'vladimir-production', 'wamid.CRMSENT0000001', 'failed', now(), 'Bad Code')$$,
  '22023', null, 'a failed status requires a safe machine error code'
);

-- A status callback cannot reach another artist's message.
select is(
  (public.record_whatsapp_status_update(
     'kristina-production', 'wamid.CRMSENT0000001', 'read', now(), null) ->> 'matched')::boolean,
  false,
  'Kristina''s integration cannot update Vladimir''s message status'
);

select * from finish(true);
rollback;
