-- 379_whatsapp_definitive_refusal_terminal.sql
--
-- 20261112200000: a request Meta refuses, or one the Worker refuses to build,
-- is dead-lettered on its first report instead of being replayed until
-- max_attempts. Transient failures keep the bounded retry. Everything is
-- rolled back.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.artist_integrations (
  id, artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
) values ('e3761111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'meta_cloud_api', 'vladimir-production', 'Synthetic Refusal WhatsApp', '{"coexistence":true}'::jsonb, true);
insert into public.clients (id, full_name, email) values
  ('e3762222-2222-4222-8222-222222222222', 'Refusal Client', 'refusal-376@example.test');
insert into public.communication_conversations (
  id, artist_id, channel, client_id, link_state, integration_key, external_contact_id
) values ('e3763333-3333-4333-8333-333333333333', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'e3762222-2222-4222-8222-222222222222', 'linked', 'vladimir-production', '447700900376');

create function pg_temp.leased_job(p_n int) returns uuid language plpgsql as $$
declare
  v_message uuid := format('e3764444-4444-4444-8444-%s', lpad(p_n::text, 12, '0'))::uuid;
  v_outbox uuid := format('e3765555-5555-4555-8555-%s', lpad(p_n::text, 12, '0'))::uuid;
begin
  insert into public.communication_messages (
    id, conversation_id, artist_id, channel, direction, origin, status, body
  ) values (v_message, 'e3763333-3333-4333-8333-333333333333',
    'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'outbound', 'crm', 'queued', 'Refusal probe ' || p_n);
  insert into public.integration_outbox (
    id, artist_id, kind, dedupe_key, payload, communication_message_id, client_id,
    status, leased_by, leased_at, lease_expires_at
  ) values (v_outbox, 'a1111111-1111-4111-8111-111111111111',
    'whatsapp_message', 'whatsapp:send:refusal-376-' || p_n, '{}'::jsonb,
    v_message, 'e3762222-2222-4222-8222-222222222222',
    'leased', 'whatsapp-worker-a', now(), now() + interval '2 minutes');
  return v_outbox;
end;
$$;
create function pg_temp.report(p_n int, p_code text) returns text language sql as $$
  select public.record_whatsapp_outbox_result(
    pg_temp.leased_job(p_n), 'whatsapp-worker-a', false, null, p_code) ->> 'status';
$$;
create function pg_temp.state(p_n int) returns table (
  outbox_status text, attempt_count integer, max_attempts integer, error_code text, message_status text
) language sql as $$
  select o.status::text, o.attempt_count, o.max_attempts, o.last_error_code, m.status::text
  from public.integration_outbox o
  join public.communication_messages m on m.id = o.communication_message_id
  where o.id = format('e3765555-5555-4555-8555-%s', lpad(p_n::text, 12, '0'))::uuid;
$$;

-- Definitive refusals stop on the first attempt, with the retry budget unused.
select is(pg_temp.report(1, 'whatsapp_rejected'), 'dead',
  'a request Meta refused is dead-lettered on the first report');
select results_eq(
  $$select outbox_status, attempt_count, attempt_count < max_attempts, error_code, message_status from pg_temp.state(1)$$,
  $$values ('dead'::text, 1, true, 'whatsapp_rejected'::text, 'failed'::text)$$,
  'it is terminal after one attempt and the CRM message shows the failure');
select is(pg_temp.report(2, 'whatsapp_destination_invalid'), 'dead',
  'an invalid destination is not replayed');
select is(pg_temp.report(3, 'whatsapp_message_invalid'), 'dead',
  'an invalid message body is not replayed');
select is(pg_temp.report(4, 'whatsapp_template_invalid'), 'dead',
  'an invalid template shape is not replayed');

-- Failures that another attempt can cure keep the bounded retry.
select is(pg_temp.report(5, 'whatsapp_provider_unavailable'), 'failed', 'a provider outage is retried');
select is(pg_temp.report(6, 'whatsapp_unreachable'), 'failed', 'a network failure is retried');
select is(pg_temp.report(7, 'whatsapp_rate_limited'), 'failed', 'a rate limit is retried');
select is(pg_temp.report(8, 'whatsapp_credentials_rejected'), 'failed',
  'a credential refusal is retried: reconnecting the account cures it');
select is(pg_temp.report(9, 'whatsapp_response_invalid'), 'failed', 'an unreadable response is retried');
select results_eq(
  $$select outbox_status, attempt_count, message_status, next_ok from (
      select s.outbox_status, s.attempt_count, s.message_status,
             (select o.next_attempt_at > now() from public.integration_outbox o
              where o.id = 'e3765555-5555-4555-8555-000000000005') as next_ok
      from pg_temp.state(5) s) x$$,
  $$values ('failed'::text, 1, 'queued'::text, true)$$,
  'a retryable failure stays queued for the client and is rescheduled');

select * from finish(true);
rollback;
