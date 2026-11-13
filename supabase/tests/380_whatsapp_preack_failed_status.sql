-- Signed Meta failed status arriving before its outbound provider id is known.
-- CI-only synthetic records; the transaction always rolls back.
begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.artist_integrations (
  id, artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
) values ('e3801111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'meta_cloud_api', 'vladimir-production', 'Synthetic Status WhatsApp', '{}'::jsonb, true);
insert into public.clients (id, full_name, email) values
  ('e3802222-2222-4222-8222-222222222222', 'Synthetic Meta Client', 'meta-380@example.test');
insert into public.communication_conversations (
  id, artist_id, channel, client_id, link_state, integration_key, external_contact_id
) values ('e3803333-3333-4333-8333-333333333333',
  'a1111111-1111-4111-8111-111111111111', 'whatsapp',
  'e3802222-2222-4222-8222-222222222222', 'linked',
  'vladimir-production', '447700900380');
insert into public.communication_messages (
  id, conversation_id, artist_id, channel, direction, origin, status, body
) values ('e3804444-4444-4444-8444-444444444444',
  'e3803333-3333-4333-8333-333333333333',
  'a1111111-1111-4111-8111-111111111111', 'whatsapp',
  'outbound', 'crm', 'queued', 'Synthetic status ordering test');
insert into public.integration_outbox (
  id, artist_id, kind, dedupe_key, payload, communication_message_id, client_id,
  status, leased_by, leased_at, lease_expires_at, provider_send_started_at
) values ('e3805555-5555-4555-8555-555555555555',
  'a1111111-1111-4111-8111-111111111111', 'whatsapp_message',
  'whatsapp:send:preack-380', '{}'::jsonb,
  'e3804444-4444-4444-8444-444444444444',
  'e3802222-2222-4222-8222-222222222222', 'leased',
  'whatsapp-worker-a', now(), now()+interval '2 minutes', now());

select is(
 (public.record_whatsapp_message_status(
   'a1111111-1111-4111-8111-111111111111', 'vladimir-production',
   'wamid.SYNTHETIC380A', 'failed', now()-interval '2 seconds'
 ) ->> 'buffered'), 'true',
 'signed failed status arriving before acknowledgement is buffered');
select is(
 (select count(*)::int from crm_private.whatsapp_preack_failed_status
  where provider_message_id='wamid.SYNTHETIC380A'), 1,
 'only one private pending status is stored');
select is(
 (public.record_whatsapp_message_status(
   'a1111111-1111-4111-8111-111111111111', 'vladimir-production',
   'wamid.SYNTHETIC380A', 'failed', now()-interval '1 second'
 ) ->> 'buffered'), 'true',
 'duplicate webhook is idempotently merged into the same buffer row');
select is(
 (select count(*)::int from crm_private.whatsapp_preack_failed_status
  where provider_message_id='wamid.SYNTHETIC380A'), 1,
 'duplicate does not create a second pending status');

select is(
 (public.record_whatsapp_outbox_result(
   'e3805555-5555-4555-8555-555555555555',
   'whatsapp-worker-a', true, 'wamid.SYNTHETIC380A', null
 ) ->> 'status'), 'succeeded',
 'send acknowledgement remains successful and never re-sends the client');
select results_eq(
 $$select m.status::text, m.error_code, o.status::text
   from public.communication_messages m
   join public.integration_outbox o on o.communication_message_id=m.id
   where m.id='e3804444-4444-4444-8444-444444444444'$$,
 $$values ('failed'::text, 'provider_failed'::text, 'succeeded'::text)$$,
 'pre-ack failure is reconciled into the CRM message without retrying outbox');
select is(
 (select count(*)::int from crm_private.whatsapp_preack_failed_status
  where provider_message_id='wamid.SYNTHETIC380A'), 0,
 'success acknowledgement atomically consumes buffered failure');

select is(
 (public.record_whatsapp_outbox_result(
   'e3805555-5555-4555-8555-555555555555',
   'whatsapp-worker-a', true, 'wamid.SYNTHETIC380A', null
 ) ->> 'changed'), 'false',
 'duplicate acknowledgement remains idempotent');
select is(
 (select status::text from public.communication_messages
  where id='e3804444-4444-4444-8444-444444444444'), 'failed',
 'duplicate success does not erase signed provider failure');

select is(
 (public.record_whatsapp_message_status(
   'a1111111-1111-4111-8111-111111111111', 'vladimir-production',
   'wamid.UNKNOWN380B', 'failed', now()
 ) ->> 'buffered'), null,
 'unknown business-app failure without in-flight CRM send is not buffered');
select is(
 (select count(*)::int from crm_private.whatsapp_preack_failed_status), 0,
 'no unrelated delivery status stays buffered');

select ok(not has_function_privilege('anon',
  'public.record_whatsapp_message_status(uuid,text,text,text,timestamptz)', 'EXECUTE'),
  'anon cannot call WhatsApp status RPC');
select ok(not has_function_privilege('authenticated',
  'public.record_whatsapp_outbox_result(uuid,text,boolean,text,text)', 'EXECUTE'),
  'authenticated cannot acknowledge WhatsApp outbox');
select ok(not has_table_privilege('authenticated',
  'crm_private.whatsapp_preack_failed_status', 'SELECT'),
  'authenticated cannot inspect private status buffer');
select * from finish(true);
rollback;
