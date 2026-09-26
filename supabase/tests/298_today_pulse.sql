-- 298_today_pulse.sql
--
-- Phase 4: one server-side Today. The CRM and Telegram read the same items,
-- every item carries a rule reason, and acknowledgements hide exactly the
-- version that was seen. Everything is rolled back.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- Pure ordering rules
-- ---------------------------------------------------------------------------

select ok(crm_private.pulse_rank('reschedule_requested') < crm_private.pulse_rank('reply')
      and crm_private.pulse_rank('reply') < crm_private.pulse_rank('new_enquiry')
      and crm_private.pulse_rank('new_enquiry') < crm_private.pulse_rank('client_cold')
      and crm_private.pulse_rank('client_cold') < crm_private.pulse_rank('integration_failure'),
  'client-visible delays rank above leads, leads above silence, the system talking about itself last');
select is(crm_private.pulse_section('unmatched_inbound'), 'inbox', 'unknown senders are an Inbox section');
select is(crm_private.pulse_section('client_cold'), 'waiting_on_clients', 'cold clients wait on the client');
select is(crm_private.pulse_section('reply'), 'waiting_for_you', 'a reply owed waits on the operator');

-- ---------------------------------------------------------------------------
-- Fixtures: one manager with a linked Telegram chat, synthetic records.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('d4111111-1111-4111-8111-111111111111', 'pulse-manager@example.test');
insert into public.profiles (id, email, role, is_active) values
  ('d4111111-1111-4111-8111-111111111111', 'pulse-manager@example.test', 'booking_manager', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level, can_manage_sessions, can_manage_integrations, is_active
) values ('d4111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
  'manager', true, false, true);
insert into crm_private.telegram_destinations (
  destination_kind, profile_id, chat_id, chat_type, safe_label, is_active
) values ('profile', 'd4111111-1111-4111-8111-111111111111', '424242424', 'private', 'Pulse manager', true);
insert into public.notification_preferences (profile_id, channel, is_enabled)
  values ('d4111111-1111-4111-8111-111111111111', 'telegram', true);

insert into public.clients (id, workspace_id, full_name, email) values
  ('d4200000-0000-4000-8000-000000000001',
   (select workspace_id from public.artists where id = 'a1111111-1111-4111-8111-111111111111'),
   'Pulse Lead', 'pulse-lead@example.test'),
  ('d4200000-0000-4000-8000-000000000002',
   (select workspace_id from public.artists where id = 'a1111111-1111-4111-8111-111111111111'),
   'Pulse Talker', 'pulse-talker@example.test');

-- An untouched new enquiry.
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at, created_at
) values (
  'd4300000-0000-4000-8000-000000000001', 'd4200000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-9801', 'd4310000-0000-4000-8000-000000000001',
  repeat('d', 64), 'new', 'complete', 'Pulse Lead', 'pulse-lead@example.test', '2026-08-05', now(),
  now() - interval '3 hours'
);

-- A linked conversation where the client spoke last.
insert into public.communication_conversations (
  id, artist_id, channel, client_id, link_state, integration_key, external_contact_id
) values ('d4400000-0000-4000-8000-000000000001', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'd4200000-0000-4000-8000-000000000002', 'linked', 'vladimir-production', '447700900881');
insert into public.communication_messages (
  id, conversation_id, artist_id, channel, direction, origin, status, body, provider_timestamp
) values ('d4410000-0000-4000-8000-000000000001', 'd4400000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'inbound', 'contact', 'received',
  'Synthetic question', now() - interval '2 hours');

-- Two unknown senders waiting.
insert into public.communication_conversations (
  id, artist_id, channel, link_state, integration_key, external_contact_id
) values
  ('d4400000-0000-4000-8000-000000000002', 'a1111111-1111-4111-8111-111111111111',
   'whatsapp', 'unmatched', 'vladimir-production', '447700900882'),
  ('d4400000-0000-4000-8000-000000000003', 'a1111111-1111-4111-8111-111111111111',
   'whatsapp', 'unmatched', 'vladimir-production', '447700900883');
insert into public.communication_messages (
  id, conversation_id, artist_id, channel, direction, origin, status, body, provider_timestamp
) values
  ('d4410000-0000-4000-8000-000000000002', 'd4400000-0000-4000-8000-000000000002',
   'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'inbound', 'contact', 'received', 'Hi', now() - interval '1 hour'),
  ('d4410000-0000-4000-8000-000000000003', 'd4400000-0000-4000-8000-000000000003',
   'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'inbound', 'contact', 'received', 'Hello', now() - interval '1 hour');

-- A proposed appointment nobody confirmed.
insert into public.sessions (id, artist_id, client_id, appointment_type, status, start_at, end_at, duration_hours)
values ('d4500000-0000-4000-8000-000000000001', 'a1111111-1111-4111-8111-111111111111',
  'd4200000-0000-4000-8000-000000000002', 'video_consultation', 'proposed',
  date_trunc('hour', now()) + interval '3 days', date_trunc('hour', now()) + interval '3 days 30 minutes', 0.5);

create temp table pulse_keys on commit drop as
select i ->> 'key' as key, i ->> 'kind' as kind, i ->> 'reason' as reason, o
from jsonb_array_elements(crm_private.pulse_items('a1111111-1111-4111-8111-111111111111', true, true)) with ordinality e(i, o);

select ok(exists (select 1 from pulse_keys where key = 'enquiry-d4300000-0000-4000-8000-000000000001'
                                            and reason = 'new_enquiry_untouched'),
  'an untouched new enquiry is on Today with its rule reason');
select ok(exists (select 1 from pulse_keys where key = 'reply-d4400000-0000-4000-8000-000000000001'
                                            and reason = 'client_message_unanswered'),
  'a linked conversation where the client spoke last is on Today');
select is((select count(*)::int from pulse_keys where kind = 'unmatched_inbound'), 1,
  'unknown senders are one grouped row, not one row each');
select is((select count(*)::int from pulse_keys where kind = 'reply' and key like 'reply-d44%'), 1,
  'an unknown sender is never presented as a known client waiting for a reply');
select ok(exists (select 1 from pulse_keys where key = 'unconfirmed-d4500000-0000-4000-8000-000000000001'),
  'a proposed appointment nobody confirmed is on Today');
select is((select count(*)::int from pulse_keys where reason is null), 0,
  'every item says why it is there');
select ok((select o from pulse_keys where key = 'reply-d4400000-0000-4000-8000-000000000001')
        < (select o from pulse_keys where key = 'enquiry-d4300000-0000-4000-8000-000000000001'),
  'a client waiting for a reply ranks above a new lead');

-- ---------------------------------------------------------------------------
-- The CRM surface
-- ---------------------------------------------------------------------------

create function pg_temp.pulse_claims(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p, 'role', 'authenticated')::text, true)::void;
$$;
grant execute on function pg_temp.pulse_claims(uuid) to authenticated;

set local role authenticated;
select pg_temp.pulse_claims('d4111111-1111-4111-8111-111111111111');

select is((public.get_today_pulse('a1111111-1111-4111-8111-111111111111') ->> 'enabled')::boolean, false,
  'CRM Today keeps the browser list until the pulse is switched on');
select ok(jsonb_array_length(public.get_today_pulse('a1111111-1111-4111-8111-111111111111') -> 'items') >= 4,
  'the manager sees the artist pulse');
select is(public.get_today_pulse('a1111111-1111-4111-8111-111111111111') #>> '{artists,0,sources,gmail_snapshot}',
  'unavailable', 'a source that could not be read is reported, not shown as zero');

create temp table crm_keys on commit drop as
select i ->> 'key' as key, o
from jsonb_array_elements(public.get_today_pulse('a1111111-1111-4111-8111-111111111111') -> 'items') with ordinality e(i, o)
where i ->> 'kind' not in ('payment_to_confirm', 'integration_failure');

-- Acknowledging the exact version hides it.
select lives_ok(
  $$select public.acknowledge_attention_item('a1111111-1111-4111-8111-111111111111', 'new_enquiry',
      'd4300000-0000-4000-8000-000000000001',
      (select created_at from public.enquiries where id = 'd4300000-0000-4000-8000-000000000001'))$$,
  'the manager acknowledges the new enquiry');
select ok(not exists (
    select 1 from jsonb_array_elements(public.get_today_pulse('a1111111-1111-4111-8111-111111111111') -> 'items') i
    where i ->> 'key' = 'enquiry-d4300000-0000-4000-8000-000000000001'),
  'an acknowledged item leaves the pulse');

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
delete from public.attention_acknowledgements
where entity_id = 'd4300000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------
-- Telegram: the same items, fewer fields, no money.
-- ---------------------------------------------------------------------------

select results_eq(
  $$ select i ->> 'key' from jsonb_array_elements(public.service_telegram_today_pulse('424242424', 20) -> 'items')
       with ordinality e(i, o)
     where i ->> 'key' in (select key from crm_keys) order by o $$,
  $$ select key from crm_keys order by o limit 20 $$,
  'Telegram /today returns the same items in the same order as CRM Today'
);
select ok(not exists (
    select 1 from jsonb_array_elements(public.service_telegram_today_pulse('424242424', 20) -> 'items') i
    where i ?| array['client_id', 'artist_id', 'ai_suggestion', 'acknowledgement', 'href']),
  'Telegram items carry no identifier, AI suggestion or action handle');
select ok(not exists (
    select 1 from jsonb_array_elements(public.service_telegram_today_pulse('424242424', 20) -> 'items') i
    where i ->> 'kind' in ('payment_to_confirm', 'integration_failure')),
  'Telegram never shows money or integration internals');
select is(public.service_telegram_today_pulse('999000999', 10) ->> 'status', 'empty',
  'an unlinked chat sees nothing');
select throws_ok($$select public.service_telegram_today_pulse('not-a-chat', 10)$$, '22023', null,
  'a malformed chat id is rejected');

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.pulse_claims('d4111111-1111-4111-8111-111111111111');
select throws_ok($$select public.service_telegram_today_pulse('424242424', 10)$$, '42501', null,
  'only the backend reads a Telegram pulse');
reset role;

select ok(not has_function_privilege('anon', 'public.get_today_pulse(uuid)', 'execute'),
  'anonymous callers cannot read the pulse');
select ok(not has_function_privilege('authenticated', 'crm_private.pulse_items(uuid, boolean, boolean, timestamptz)', 'execute'),
  'the pulse engine itself is private');

select * from finish(true);
rollback;
