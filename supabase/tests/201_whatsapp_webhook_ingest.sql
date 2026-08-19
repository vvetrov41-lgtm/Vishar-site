-- 201_whatsapp_webhook_ingest.sql
--
-- Migration 0050: signed Meta webhook persistence and delivery-status updates.
-- All provider identifiers and message content are synthetic.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select has_function(
  'public', 'record_whatsapp_inbound_message',
  array['uuid', 'text', 'text', 'text', 'timestamp with time zone', 'text', 'text'],
  'backend inbound WhatsApp RPC exists'
);
select has_function(
  'public', 'record_whatsapp_message_status',
  array['uuid', 'text', 'text', 'text', 'timestamp with time zone'],
  'backend WhatsApp status RPC exists'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.record_whatsapp_inbound_message(uuid,text,text,text,timestamptz,text,text)',
    'EXECUTE'
  ),
  'anon cannot ingest WhatsApp messages'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.record_whatsapp_inbound_message(uuid,text,text,text,timestamptz,text,text)',
    'EXECUTE'
  ),
  'authenticated browser sessions cannot ingest WhatsApp messages'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.record_whatsapp_inbound_message(uuid,text,text,text,timestamptz,text,text)',
    'EXECUTE'
  ),
  'only the backend service role can ingest WhatsApp messages'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.record_whatsapp_message_status(uuid,text,text,text,timestamptz)',
    'EXECUTE'
  ),
  'anon cannot apply WhatsApp provider statuses'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.record_whatsapp_message_status(uuid,text,text,text,timestamptz)',
    'EXECUTE'
  ),
  'authenticated browser sessions cannot apply WhatsApp provider statuses'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.record_whatsapp_message_status(uuid,text,text,text,timestamptz)',
    'EXECUTE'
  ),
  'the backend service role can apply WhatsApp provider statuses'
);

insert into public.artist_integrations (
  id, artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
) values
(
  'da111111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'meta_cloud_api', 'vladimir-production',
  'Synthetic Vladimir webhook', '{"coexistence":true}'::jsonb, true
),
(
  'da222222-2222-4222-8222-222222222222',
  'a2222222-2222-4222-8222-222222222222',
  'whatsapp', 'meta_cloud_api', 'kristina-production',
  'Synthetic Kristina webhook', '{"coexistence":true}'::jsonb, true
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select lives_ok(
  $$select public.record_whatsapp_inbound_message(
      'a1111111-1111-4111-8111-111111111111',
      'vladimir-production',
      '447700910001',
      'wamid.SYNTHETICWEBHOOK0001',
      '2026-08-15 07:00:00+00'::timestamptz,
      'text',
      'Synthetic inbound text'
    )$$,
  'a signed Vladimir inbound message is persisted through the backend RPC'
);

select is(
  (select artist_id from public.whatsapp_conversations where contact_wa_id = '447700910001'),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'the inbound conversation is owned by Vladimir'
);
select is(
  (select integration_key from public.whatsapp_conversations where contact_wa_id = '447700910001'),
  'vladimir-production',
  'the inbound conversation keeps the trusted Vladimir integration key'
);
select is(
  (select direction::text from public.whatsapp_messages where provider_message_id = 'wamid.SYNTHETICWEBHOOK0001'),
  'inbound',
  'the webhook creates an inbound message'
);
select is(
  (select origin::text from public.whatsapp_messages where provider_message_id = 'wamid.SYNTHETICWEBHOOK0001'),
  'contact',
  'official inbound messages are attributed to the contact, not Business App echo'
);
select is(
  (select body from public.whatsapp_messages where provider_message_id = 'wamid.SYNTHETICWEBHOOK0001'),
  'Synthetic inbound text',
  'text body is stored only in the protected message row'
);

select is(
  (public.record_whatsapp_inbound_message(
      'a1111111-1111-4111-8111-111111111111',
      'vladimir-production',
      '447700910001',
      'wamid.SYNTHETICWEBHOOK0001',
      '2026-08-15 07:00:00+00'::timestamptz,
      'text',
      'Synthetic inbound text'
    ) ->> 'changed')::boolean,
  false,
  'a duplicate Meta provider message id is idempotent'
);
select is(
  (select count(*)::integer from public.whatsapp_messages where provider_message_id = 'wamid.SYNTHETICWEBHOOK0001'),
  1,
  'duplicate delivery leaves one durable message row'
);

select lives_ok(
  $$select public.record_whatsapp_inbound_message(
      'a2222222-2222-4222-8222-222222222222',
      'kristina-production',
      '447700910002',
      'wamid.SYNTHETICWEBHOOK0001',
      '2026-08-15 07:01:00+00'::timestamptz,
      'image',
      null
    )$$,
  'Kristina may receive the same provider id in her independent artist scope'
);
select is(
  (select count(*)::integer from public.whatsapp_messages where provider_message_id = 'wamid.SYNTHETICWEBHOOK0001'),
  2,
  'provider message id uniqueness is artist-scoped'
);

select throws_ok(
  $$select public.record_whatsapp_inbound_message(
      'a1111111-1111-4111-8111-111111111111',
      'kristina-production',
      '447700910003',
      'wamid.SYNTHETICWEBHOOK0003',
      '2026-08-15 07:02:00+00'::timestamptz,
      'text',
      'Cross-artist attempt'
    )$$,
  '23503', null,
  'Vladimir cannot be ingested through Kristina integration metadata'
);

select throws_ok(
  $$select public.record_whatsapp_inbound_message(
      'a1111111-1111-4111-8111-111111111111',
      'vladimir-production',
      '447700910004',
      'wamid.SYNTHETICWEBHOOK0004',
      '2026-08-15 07:03:00+00'::timestamptz,
      'image',
      'provider caption must not cross this boundary'
    )$$,
  '22023', null,
  'non-text webhook payload content is not copied into the message body'
);

-- Synthetic outbound row for status lifecycle testing.
-- Seeded in the neutral core since migration 0070; every assertion below still
-- reads the WhatsApp compatibility views and calls the WhatsApp webhook RPCs.
insert into public.communication_conversations (
  id, artist_id, channel, integration_key, external_contact_id
) values (
  '9c501111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'whatsapp',
  'vladimir-production',
  '447700919999'
);
insert into public.communication_messages (
  id, conversation_id, artist_id, channel, direction, origin, status,
  message_type, body, provider_message_id
) values (
  '9d501111-1111-4111-8111-111111111111',
  '9c501111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'whatsapp',
  'outbound', 'crm', 'sent', 'text', 'Synthetic outbound text',
  'wamid.SYNTHETICSTATUS0001'
);

select is(
  (public.record_whatsapp_message_status(
      'a1111111-1111-4111-8111-111111111111',
      'vladimir-production',
      'wamid.SYNTHETICSTATUS0001',
      'delivered',
      '2026-08-15 07:10:00+00'::timestamptz
    ) ->> 'status'),
  'delivered',
  'delivered status advances a sent outbound message'
);
select is(
  (select status::text from public.whatsapp_messages where id = '9d501111-1111-4111-8111-111111111111'),
  'delivered',
  'the durable message now shows delivered'
);
select ok(
  (select delivered_at is not null from public.whatsapp_messages where id = '9d501111-1111-4111-8111-111111111111'),
  'delivered status records its provider timestamp'
);

select is(
  (public.record_whatsapp_message_status(
      'a1111111-1111-4111-8111-111111111111',
      'vladimir-production',
      'wamid.SYNTHETICSTATUS0001',
      'read',
      '2026-08-15 07:11:00+00'::timestamptz
    ) ->> 'status'),
  'read',
  'read status advances delivered'
);
select ok(
  (select read_at is not null from public.whatsapp_messages where id = '9d501111-1111-4111-8111-111111111111'),
  'read timestamp is persisted'
);

select is(
  (public.record_whatsapp_message_status(
      'a1111111-1111-4111-8111-111111111111',
      'vladimir-production',
      'wamid.SYNTHETICSTATUS0001',
      'sent',
      '2026-08-15 07:09:00+00'::timestamptz
    ) ->> 'changed')::boolean,
  false,
  'an older out-of-order sent status cannot downgrade read'
);
select is(
  (select status::text from public.whatsapp_messages where id = '9d501111-1111-4111-8111-111111111111'),
  'read',
  'out-of-order status leaves the most advanced state intact'
);

select is(
  (public.record_whatsapp_message_status(
      'a1111111-1111-4111-8111-111111111111',
      'vladimir-production',
      'wamid.SYNTHETICSTATUS0001',
      'failed',
      '2026-08-15 07:12:00+00'::timestamptz
    ) ->> 'changed')::boolean,
  false,
  'a later failed callback cannot overwrite delivered/read evidence'
);

select is(
  (public.record_whatsapp_message_status(
      'a2222222-2222-4222-8222-222222222222',
      'kristina-production',
      'wamid.SYNTHETICSTATUS0001',
      'read',
      '2026-08-15 07:12:00+00'::timestamptz
    ) ->> 'changed')::boolean,
  false,
  'Kristina cannot mutate Vladimir message state by provider id'
);

select is(
  (public.record_whatsapp_message_status(
      'a1111111-1111-4111-8111-111111111111',
      'vladimir-production',
      'wamid.SYNTHETICUNKNOWN0001',
      'delivered',
      '2026-08-15 07:12:00+00'::timestamptz
    ) ->> 'changed')::boolean,
  false,
  'unknown provider message ids are safe no-ops'
);


update public.artist_integrations
set is_enabled = false
where artist_id = 'a1111111-1111-4111-8111-111111111111'
  and integration_key = 'vladimir-production';

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.record_whatsapp_inbound_message(
      'a1111111-1111-4111-8111-111111111111',
      'vladimir-production',
      '447700910005',
      'wamid.SYNTHETICWEBHOOK0005',
      '2026-08-15 07:20:00+00'::timestamptz,
      'text',
      'Disabled route'
    )$$,
  '23503', null,
  'a disabled Vladimir route fails closed rather than borrowing Kristina'
);

select * from finish();
rollback;
