-- 1006_communication_send_intent.sql
--
-- Audit M-2: a WhatsApp/Instagram job whose provider call was started but
-- never acknowledged is dead-lettered for the owner, never sent twice; an
-- explicit provider failure keeps the ordinary bounded retry.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  has_function_privilege('service_role', 'public.service_begin_communication_send(uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.service_begin_communication_send(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.service_begin_communication_send(uuid,text)', 'EXECUTE'),
  'only the trusted backend can record a send intent'
);

insert into public.artist_integrations (
  id, artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
) values ('e4011111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'meta_cloud_api', 'vladimir-production', 'Synthetic Intent WhatsApp', '{"coexistence":true}'::jsonb, true);
insert into public.clients (id, full_name, email) values
  ('e4021111-1111-4111-8111-111111111111', 'Intent Client', 'intent@example.test');
insert into public.communication_conversations (
  id, artist_id, channel, client_id, link_state, integration_key, external_contact_id
) values ('e4031111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'e4021111-1111-4111-8111-111111111111', 'linked', 'vladimir-production', '447700900099');
insert into public.communication_messages (
  id, conversation_id, artist_id, channel, direction, origin, status, body
) values
  ('e4041111-1111-4111-8111-111111111111', 'e4031111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'outbound', 'crm', 'queued', 'Intent probe'),
  ('e4051111-1111-4111-8111-111111111111', 'e4031111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'outbound', 'crm', 'queued', 'Retry probe');

insert into public.integration_outbox (
  id, artist_id, kind, dedupe_key, payload, communication_message_id, client_id,
  status, leased_by, leased_at, lease_expires_at
) values
  ('e4061111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'whatsapp_message', 'whatsapp:send:intent-unknown', '{}'::jsonb,
   'e4041111-1111-4111-8111-111111111111', 'e4021111-1111-4111-8111-111111111111',
   'leased', 'whatsapp-worker-a', now(), now() + interval '2 minutes'),
  ('e4071111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'whatsapp_message', 'whatsapp:send:intent-retry', '{}'::jsonb,
   'e4051111-1111-4111-8111-111111111111', 'e4021111-1111-4111-8111-111111111111',
   'leased', 'whatsapp-worker-a', now(), now() + interval '2 minutes');

select throws_ok(
  $$select public.service_begin_communication_send('e4061111-1111-4111-8111-111111111111', 'whatsapp-worker-b')$$,
  '42501', null, 'only the lease holder can record the intent'
);
select is(
  public.service_begin_communication_send('e4061111-1111-4111-8111-111111111111', 'whatsapp-worker-a') ->> 'proceed',
  'true', 'the first attempt may call the provider'
);
select isnt((select provider_send_started_at from public.integration_outbox where id = 'e4061111-1111-4111-8111-111111111111'),
  null, 'the intent is durable before the provider call');

-- The worker crashed after the provider call: the lease expires and a new
-- worker claims the same job.
update public.integration_outbox
set leased_by = 'whatsapp-worker-c', leased_at = now(), lease_expires_at = now() + interval '2 minutes'
where id = 'e4061111-1111-4111-8111-111111111111';
select is(
  public.service_begin_communication_send('e4061111-1111-4111-8111-111111111111', 'whatsapp-worker-c') ->> 'proceed',
  'false', 'a job with an unacknowledged send is never sent again'
);
select public.record_whatsapp_outbox_result(
  'e4061111-1111-4111-8111-111111111111', 'whatsapp-worker-c', false, null, 'communication_send_result_unknown');
select results_eq(
  $$select o.status::text, o.last_error_code, m.status::text
    from public.integration_outbox o join public.communication_messages m on m.id = o.communication_message_id
    where o.id = 'e4061111-1111-4111-8111-111111111111'$$,
  $$values ('dead'::text, 'communication_send_result_unknown'::text, 'failed'::text)$$,
  'an unknown send outcome is dead-lettered immediately and visible on the message'
);

-- An explicit provider refusal clears the intent and keeps the retry.
select public.service_begin_communication_send('e4071111-1111-4111-8111-111111111111', 'whatsapp-worker-a');
select public.record_whatsapp_outbox_result(
  'e4071111-1111-4111-8111-111111111111', 'whatsapp-worker-a', false, null, 'whatsapp_provider_unavailable');
select results_eq(
  $$select status::text, provider_send_started_at is null from public.integration_outbox
    where id = 'e4071111-1111-4111-8111-111111111111'$$,
  $$values ('failed'::text, true)$$,
  'an explicit failure is retried normally with the intent cleared'
);

select * from finish(true);
rollback;
