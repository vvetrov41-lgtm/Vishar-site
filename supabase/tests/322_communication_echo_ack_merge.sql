-- 322_communication_echo_ack_merge.sql
--
-- Migration 20260928170000: a provider echo of a CRM send that arrives before
-- the Worker acknowledges the send is folded into the CRM row instead of
-- blocking the acknowledgement on the provider id unique key.
--
-- Everything here is synthetic. No Meta endpoint is contacted.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.artist_integrations
  (id, artist_id, integration_type, provider, integration_key, configuration, is_enabled)
values
  ('f9322111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'whatsapp', 'meta_cloud_api', 'vladimir-production', '{}'::jsonb, true);

insert into public.clients (id, full_name, email, phone) values
  ('19322111-1111-4111-8111-111111111111', 'Echo Ack Client', 'echo.ack@example.test', '+44 7700 903221');

insert into public.communication_conversations
  (id, artist_id, channel, client_id, link_state, integration_key, external_contact_id)
values
  ('29322111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'whatsapp', '19322111-1111-4111-8111-111111111111', 'linked',
   'vladimir-production', '447700903221');

-- A CRM reply waiting for its send result, with its leased outbox job.
insert into public.communication_messages
  (id, conversation_id, artist_id, channel, direction, origin, status, message_type, body)
values
  ('59322111-1111-4111-8111-111111111111', '29322111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'outbound', 'crm', 'queued',
   'text', 'CRM reply');

insert into public.integration_outbox
  (id, artist_id, kind, status, dedupe_key, payload, client_id, communication_message_id,
   leased_by, leased_at, lease_expires_at, provider_send_started_at)
values
  ('69322111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'whatsapp_message', 'leased',
   'whatsapp:send:79322111-1111-4111-8111-111111111111',
   jsonb_build_object('communication_message_id', '59322111-1111-4111-8111-111111111111'),
   '19322111-1111-4111-8111-111111111111', '59322111-1111-4111-8111-111111111111',
   'worker-echo-ack', now(), now() + interval '5 minutes', now());

-- Meta echoes that send before the Worker records the result.
select is(
  (public.record_communication_outbound_echo(
    'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'vladimir-production',
    '447700903221', 'wamid.SYNTHETICECHOACK0001', now(), 'text', 'CRM reply', '[]'::jsonb
  ) ->> 'changed')::boolean,
  true,
  'an early echo is first recorded as a provider-app message'
);

select lives_ok(
  $$select public.record_communication_outbox_result(
      '69322111-1111-4111-8111-111111111111', 'worker-echo-ack', true,
      'wamid.SYNTHETICECHOACK0001', null)$$,
  'the acknowledgement of the same send is not blocked by the early echo'
);

select is(
  (select status::text || ':' || provider_message_id from public.communication_messages
   where id = '59322111-1111-4111-8111-111111111111'),
  'sent:wamid.SYNTHETICECHOACK0001',
  'the CRM message takes the provider id and is sent'
);

select is(
  (select status::text from public.integration_outbox
   where id = '69322111-1111-4111-8111-111111111111'),
  'succeeded',
  'the job succeeds instead of dead-lettering as an unknown result'
);

select is(
  (select count(*)::int from public.communication_messages
   where conversation_id = '29322111-1111-4111-8111-111111111111'),
  1,
  'the echo is folded into the CRM message, not kept as a duplicate'
);

-- A later echo replay stays a no-op.
select is(
  (public.record_communication_outbound_echo(
    'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'vladimir-production',
    '447700903221', 'wamid.SYNTHETICECHOACK0001', now(), 'text', 'CRM reply', '[]'::jsonb
  ) ->> 'changed')::boolean,
  false,
  'a replayed echo after the acknowledgement changes nothing'
);

-- A genuine Business app message with another id is untouched.
select is(
  (public.record_communication_outbound_echo(
    'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'vladimir-production',
    '447700903221', 'wamid.SYNTHETICAPPONLY0001', now(), 'text', 'Typed in the app', '[]'::jsonb
  ) ->> 'changed')::boolean,
  true,
  'a Business app reply is still recorded'
);
select is(
  (select count(*)::int from public.communication_messages
   where conversation_id = '29322111-1111-4111-8111-111111111111'
     and origin = 'provider_app'),
  1,
  'only the unrelated app reply remains as provider_app'
);

select * from finish();
rollback;
