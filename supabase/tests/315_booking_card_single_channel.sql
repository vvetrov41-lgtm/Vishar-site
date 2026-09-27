-- 315_booking_card_single_channel.sql
--
-- A booking card goes to exactly one channel: the newest real conversation
-- with the client. Everything is rolled back and no provider is contacted.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

update public.artist_integrations
set is_enabled = true,
    external_account_label = coalesce(external_account_label, 'synthetic@example.test')
where artist_id = 'a1111111-1111-4111-8111-111111111111'
  and integration_type in (
    'email'::public.artist_integration_type,
    'whatsapp'::public.artist_integration_type
  );

insert into public.artist_integrations (
  artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
)
select
  'a1111111-1111-4111-8111-111111111111',
  'whatsapp'::public.artist_integration_type,
  'meta_cloud_api',
  'vladimir-production',
  null,
  '{}'::jsonb,
  true
where not exists (
  select 1
  from public.artist_integrations i
  where i.artist_id = 'a1111111-1111-4111-8111-111111111111'
    and i.integration_type = 'whatsapp'::public.artist_integration_type
    and i.integration_key = 'vladimir-production'
);

insert into crm_private.booking_card_artist_settings (
  artist_id, email_enabled, whatsapp_enabled,
  studio_name, studio_address, studio_map_url,
  location_latitude, location_longitude,
  whatsapp_tattoo_template_name, whatsapp_consultation_template_name,
  whatsapp_template_language,
  whatsapp_tattoo_template_status, whatsapp_consultation_template_status,
  appointment_start_from, client_action_base_url
) values (
  'a1111111-1111-4111-8111-111111111111', true, true,
  'Synthetic Studio', '1 Synthetic Street, London', 'https://maps.example.test/studio',
  51.500001, -0.100001,
  'booking_card_tattoo_v1', 'booking_card_consultation_v1',
  'en_GB',
  'APPROVED', 'APPROVED',
  null, 'https://booking.example.test/appointments/respond/'
)
on conflict (artist_id) do update
set email_enabled = excluded.email_enabled,
    whatsapp_enabled = excluded.whatsapp_enabled,
    whatsapp_tattoo_template_status = excluded.whatsapp_tattoo_template_status,
    whatsapp_consultation_template_status = excluded.whatsapp_consultation_template_status,
    studio_name = excluded.studio_name,
    studio_address = excluded.studio_address,
    studio_map_url = excluded.studio_map_url,
    location_latitude = excluded.location_latitude,
    location_longitude = excluded.location_longitude,
    whatsapp_tattoo_template_name = excluded.whatsapp_tattoo_template_name,
    whatsapp_consultation_template_name = excluded.whatsapp_consultation_template_name,
    whatsapp_template_language = excluded.whatsapp_template_language,
    appointment_start_from = excluded.appointment_start_from,
    client_action_base_url = excluded.client_action_base_url;

-- Every client has both an email address and a phone number: contact details
-- alone must never pick a channel.
insert into public.clients (id, full_name, email, phone) values
  ('fd1a1111-1111-4111-8111-111111111111', 'Whatsapp Only', 'wa-only@example.test', '+447700900401'),
  ('fd1b1111-1111-4111-8111-111111111111', 'Email Only', 'email-only@example.test', '+447700900402'),
  ('fd1c1111-1111-4111-8111-111111111111', 'Email Then Whatsapp', 'email-then-wa@example.test', '+447700900403'),
  ('fd1d1111-1111-4111-8111-111111111111', 'Whatsapp Then Email', 'wa-then-email@example.test', '+447700900404'),
  ('fd1e1111-1111-4111-8111-111111111111', 'No Conversation', 'no-conversation@example.test', '+447700900405'),
  ('fd1f1111-1111-4111-8111-111111111111', 'Instagram Only', 'instagram-only@example.test', '+447700900406'),
  ('fd101111-1111-4111-8111-111111111111', 'Automation Only', 'automation-only@example.test', '+447700900407'),
  ('fd191111-1111-4111-8111-111111111111', 'Whatsapp Disabled', 'wa-disabled@example.test', '+447700900408');

-- WhatsApp conversations with the client's own number.
insert into public.communication_conversations (
  id, artist_id, channel, integration_key, external_contact_id,
  client_id, link_state, state
) values
  ('fd2a1111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'whatsapp', 'vladimir-production', '447700900401',
   'fd1a1111-1111-4111-8111-111111111111', 'linked', 'open'),
  ('fd2c1111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'whatsapp', 'vladimir-production', '447700900403',
   'fd1c1111-1111-4111-8111-111111111111', 'linked', 'open'),
  ('fd2d1111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'whatsapp', 'vladimir-production', '447700900404',
   'fd1d1111-1111-4111-8111-111111111111', 'linked', 'open'),
  ('fd201111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'whatsapp', 'vladimir-production', '447700900407',
   'fd101111-1111-4111-8111-111111111111', 'linked', 'open'),
  ('fd291111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'whatsapp', 'vladimir-production', '447700900408',
   'fd191111-1111-4111-8111-111111111111', 'linked', 'open'),
  ('fd2f1111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'instagram', 'vladimir-instagram', '17841400000000001',
   'fd1f1111-1111-4111-8111-111111111111', 'linked', 'open');

insert into public.communication_messages (
  id, conversation_id, artist_id, channel, direction, origin, status,
  message_type, body, provider_timestamp
) values
  ('fd3a1111-1111-4111-8111-111111111111', 'fd2a1111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'inbound', 'contact', 'received',
   'text', 'Hello', now() - interval '2 days'),
  ('fd3c1111-1111-4111-8111-111111111111', 'fd2c1111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'inbound', 'contact', 'received',
   'text', 'Hello', now() - interval '1 day'),
  ('fd3d1111-1111-4111-8111-111111111111', 'fd2d1111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'inbound', 'contact', 'received',
   'text', 'Hello', now() - interval '5 days'),
  -- An automated card or reminder is not a conversation.
  ('fd301111-1111-4111-8111-111111111111', 'fd201111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'outbound', 'automation', 'sent',
   'template', 'Reminder', now() - interval '1 day'),
  ('fd391111-1111-4111-8111-111111111111', 'fd291111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'inbound', 'contact', 'received',
   'text', 'Hello', now() - interval '1 day'),
  ('fd3f1111-1111-4111-8111-111111111111', 'fd2f1111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'instagram', 'inbound', 'contact', 'received',
   'text', 'Hello', now() - interval '1 day');

-- Email conversations: a Gmail thread with the client.
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at
) values
  ('fd4b1111-1111-4111-8111-111111111111', 'fd1b1111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-7151', 'fd5b1111-1111-4111-8111-111111111111',
   repeat('1', 64), 'reviewing', 'complete', 'Email Only', 'email-only@example.test', '2026-08-05', now()),
  ('fd4c1111-1111-4111-8111-111111111111', 'fd1c1111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-7152', 'fd5c1111-1111-4111-8111-111111111111',
   repeat('2', 64), 'reviewing', 'complete', 'Email Then Whatsapp', 'email-then-wa@example.test', '2026-08-05', now()),
  ('fd4d1111-1111-4111-8111-111111111111', 'fd1d1111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-7153', 'fd5d1111-1111-4111-8111-111111111111',
   repeat('3', 64), 'reviewing', 'complete', 'Whatsapp Then Email', 'wa-then-email@example.test', '2026-08-05', now()),
  ('fd4a1111-1111-4111-8111-111111111111', 'fd1a1111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-7154', 'fd5a1111-1111-4111-8111-111111111111',
   repeat('4', 64), 'reviewing', 'complete', 'Whatsapp Only', 'wa-only@example.test', '2026-08-05', now());

insert into crm_private.gmail_thread_contexts (
  artist_id, client_id, enquiry_id, provider_thread_id, subject, created_at, updated_at
) values
  ('a1111111-1111-4111-8111-111111111111', 'fd1b1111-1111-4111-8111-111111111111',
   'fd4b1111-1111-4111-8111-111111111111', 'thread-email-only', 'Tattoo idea',
   now() - interval '3 days', now()),
  ('a1111111-1111-4111-8111-111111111111', 'fd1c1111-1111-4111-8111-111111111111',
   'fd4c1111-1111-4111-8111-111111111111', 'thread-email-then-wa', 'Tattoo idea',
   now() - interval '6 days', now()),
  ('a1111111-1111-4111-8111-111111111111', 'fd1d1111-1111-4111-8111-111111111111',
   'fd4d1111-1111-4111-8111-111111111111', 'thread-wa-then-email', 'Tattoo idea',
   now() - interval '1 day', now());

-- Kristina-style artist setting: WhatsApp cards off, Email cards on.
update crm_private.booking_card_artist_settings
set whatsapp_enabled = false
where artist_id = 'a1111111-1111-4111-8111-111111111111';

insert into public.sessions (
  id, client_id, artist_id, appointment_type, status, start_at, end_at,
  duration_hours, price, currency
) values (
  'fd691111-1111-4111-8111-111111111111', 'fd191111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111', 'in_person_consultation', 'confirmed',
  date_trunc('day', now()) + interval '48 days 11 hours',
  date_trunc('day', now()) + interval '48 days 11 hours 30 minutes', 0.5, null, 'GBP'
);

update crm_private.booking_card_artist_settings
set whatsapp_enabled = true
where artist_id = 'a1111111-1111-4111-8111-111111111111';

insert into public.sessions (
  id, client_id, artist_id, appointment_type, status, start_at, end_at,
  duration_hours, price, currency
)
select v.session_id::uuid, v.client_id::uuid, 'a1111111-1111-4111-8111-111111111111',
  'in_person_consultation', 'confirmed',
  date_trunc('day', now()) + make_interval(days => v.day_offset) + interval '11 hours',
  date_trunc('day', now()) + make_interval(days => v.day_offset) + interval '11 hours 30 minutes',
  0.5, null, 'GBP'
from (values
  ('fd6a1111-1111-4111-8111-111111111111', 'fd1a1111-1111-4111-8111-111111111111', 40),
  ('fd6b1111-1111-4111-8111-111111111111', 'fd1b1111-1111-4111-8111-111111111111', 41),
  ('fd6c1111-1111-4111-8111-111111111111', 'fd1c1111-1111-4111-8111-111111111111', 42),
  ('fd6d1111-1111-4111-8111-111111111111', 'fd1d1111-1111-4111-8111-111111111111', 43),
  ('fd6e1111-1111-4111-8111-111111111111', 'fd1e1111-1111-4111-8111-111111111111', 44),
  ('fd6f1111-1111-4111-8111-111111111111', 'fd1f1111-1111-4111-8111-111111111111', 45),
  ('fd601111-1111-4111-8111-111111111111', 'fd101111-1111-4111-8111-111111111111', 46)
) as v(session_id, client_id, day_offset);

create temporary view card_channels as
select s.id as session_id,
       b.id as card_id,
       count(d.id) filter (where d.channel = 'email')::int as email_deliveries,
       count(d.id) filter (where d.channel = 'whatsapp')::int as whatsapp_deliveries,
       x.channel as decided_channel,
       x.outcome,
       x.evidence_source,
       x.evidence_message_id,
       x.evidence_conversation_id,
       x.evidence_at,
       x.decided_at
from public.sessions s
join crm_private.booking_cards b on b.session_id = s.id and b.superseded_at is null
left join crm_private.booking_card_deliveries d on d.booking_card_id = b.id
left join crm_private.booking_card_channel_decisions x on x.booking_card_id = b.id
group by s.id, b.id, x.channel, x.outcome, x.evidence_source, x.evidence_message_id,
  x.evidence_conversation_id, x.evidence_at, x.decided_at;

-- A. WhatsApp-only history
select results_eq(
  $$ select whatsapp_deliveries, email_deliveries, decided_channel, outcome, evidence_source
     from card_channels where session_id = 'fd6a1111-1111-4111-8111-111111111111' $$,
  $$ values (1, 0, 'whatsapp'::text, 'selected'::text, 'whatsapp_message'::text) $$,
  'A: WhatsApp-only conversation gives one WhatsApp delivery and no Email delivery'
);

select ok(
  (select evidence_message_id = 'fd3a1111-1111-4111-8111-111111111111'
          and evidence_conversation_id = 'fd2a1111-1111-4111-8111-111111111111'
          and evidence_at is not null and decided_at is not null
   from card_channels where session_id = 'fd6a1111-1111-4111-8111-111111111111'),
  'A: the decision records the conversation, the message and when it was decided'
);

select is(
  (select count(*)::int
   from public.integration_outbox o
   join crm_private.booking_cards b
     on o.dedupe_key in ('email:booking_card:' || b.id::text, 'whatsapp:booking_card:' || b.id::text)
   where b.session_id = 'fd6a1111-1111-4111-8111-111111111111'),
  1,
  'A: exactly one provider job is queued'
);

select is(
  (select count(*)::int
   from crm_private.appointment_client_action_tokens t
   where t.session_id = 'fd6a1111-1111-4111-8111-111111111111'
     and t.consumed_at is null and t.invalidated_at is null),
  2,
  'A: one capability pair for the one channel'
);

-- B. Email-only history
select results_eq(
  $$ select whatsapp_deliveries, email_deliveries, decided_channel, outcome, evidence_source
     from card_channels where session_id = 'fd6b1111-1111-4111-8111-111111111111' $$,
  $$ values (0, 1, 'email'::text, 'selected'::text, 'gmail_thread'::text) $$,
  'B: Email-only conversation gives one Email delivery and no WhatsApp delivery'
);

-- C. Email, then a newer WhatsApp conversation
select results_eq(
  $$ select whatsapp_deliveries, email_deliveries, decided_channel
     from card_channels where session_id = 'fd6c1111-1111-4111-8111-111111111111' $$,
  $$ values (1, 0, 'whatsapp'::text) $$,
  'C: the newer WhatsApp conversation wins over older Email'
);

-- D. WhatsApp, then a newer Email conversation
select results_eq(
  $$ select whatsapp_deliveries, email_deliveries, decided_channel
     from card_channels where session_id = 'fd6d1111-1111-4111-8111-111111111111' $$,
  $$ values (0, 1, 'email'::text) $$,
  'D: the newer Email conversation wins over older WhatsApp'
);

-- E. No conversation at all
select results_eq(
  $$ select whatsapp_deliveries, email_deliveries, decided_channel, outcome
     from card_channels where session_id = 'fd6e1111-1111-4111-8111-111111111111' $$,
  $$ values (0, 0, null::text, 'no_conversation_channel'::text) $$,
  'E: no conversation means no delivery and an explicit reason'
);

select is(
  (select count(*)::int
   from crm_private.appointment_client_action_tokens t
   where t.session_id = 'fd6e1111-1111-4111-8111-111111111111'),
  0,
  'E: no client action links are minted without a channel'
);

-- Automated messages are not a conversation.
select results_eq(
  $$ select whatsapp_deliveries, email_deliveries, outcome
     from card_channels where session_id = 'fd601111-1111-4111-8111-111111111111' $$,
  $$ values (0, 0, 'no_conversation_channel'::text) $$,
  'an automated outbound message does not count as conversation history'
);

-- F. Instagram-only history
select results_eq(
  $$ select whatsapp_deliveries, email_deliveries, decided_channel, outcome, evidence_source
     from card_channels where session_id = 'fd6f1111-1111-4111-8111-111111111111' $$,
  $$ values (0, 0, 'instagram'::text, 'conversation_channel_disabled'::text, 'instagram_message'::text) $$,
  'F: Instagram-only conversation with Instagram cards off sends nothing to Email or WhatsApp and says why'
);

-- The chosen channel being switched off never falls back to the other one.
select results_eq(
  $$ select whatsapp_deliveries, email_deliveries, decided_channel, outcome
     from card_channels where session_id = 'fd691111-1111-4111-8111-111111111111' $$,
  $$ values (0, 0, 'whatsapp'::text, 'conversation_channel_disabled'::text) $$,
  'WhatsApp conversation with WhatsApp cards off: blocked, no Email fallback'
);

-- G. Retry and idempotency never add a sibling channel.
insert into crm_private.gmail_thread_contexts (
  artist_id, client_id, enquiry_id, provider_thread_id, subject, created_at
) values (
  'a1111111-1111-4111-8111-111111111111', 'fd1a1111-1111-4111-8111-111111111111',
  'fd4a1111-1111-4111-8111-111111111111', 'thread-newer-email', 'Aftercare', now()
);

select lives_ok(
  $$ select crm_private.dispatch_booking_card(b.id)
     from crm_private.booking_cards b
     where b.session_id = 'fd6a1111-1111-4111-8111-111111111111'
       and b.superseded_at is null $$,
  'G: dispatching the same card again is safe'
);

select lives_ok(
  $$ select * from crm_private.reconcile_booking_cards('a1111111-1111-4111-8111-111111111111', 200) $$,
  'G: reconciliation is safe'
);

select results_eq(
  $$ select whatsapp_deliveries, email_deliveries, decided_channel
     from card_channels where session_id = 'fd6a1111-1111-4111-8111-111111111111' $$,
  $$ values (1, 0, 'whatsapp'::text) $$,
  'G: a newer Email conversation, retry and reconciliation leave one WhatsApp delivery'
);

select throws_ok(
  $$ insert into crm_private.booking_card_deliveries (booking_card_id, channel, status)
     select b.id, 'email'::public.message_template_channel, 'pending'
     from crm_private.booking_cards b
     where b.session_id = 'fd6a1111-1111-4111-8111-111111111111'
       and b.superseded_at is null $$,
  '23505',
  'booking card already has a delivery in another channel',
  'G: the database refuses a sibling delivery in a second channel'
);

select throws_ok(
  $$ insert into crm_private.booking_card_deliveries (booking_card_id, channel, status)
     select b.id, 'email'::public.message_template_channel, 'pending'
     from crm_private.booking_cards b
     where b.session_id = 'fd6f1111-1111-4111-8111-111111111111'
       and b.superseded_at is null $$,
  '23514',
  'booking card delivery does not match its channel decision',
  'a blocked card cannot get a delivery behind its decision'
);

select is(
  (select count(*)::int
   from crm_private.booking_card_deliveries d
   join crm_private.booking_cards b on b.id = d.booking_card_id
   where b.client_id::text like 'fd1%'
   group by b.id
   order by 1 desc
   limit 1),
  1,
  'no card in this suite has more than one delivery'
);

-- A card waiting for a conversation goes out once one appears.
insert into public.communication_conversations (
  id, artist_id, channel, integration_key, external_contact_id,
  client_id, link_state, state
) values (
  'fd2e1111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'vladimir-production', '447700900405',
  'fd1e1111-1111-4111-8111-111111111111', 'linked', 'open'
);

insert into public.communication_messages (
  conversation_id, artist_id, channel, direction, origin, status, message_type, body
) values (
  'fd2e1111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'inbound', 'contact', 'received', 'text', 'Hello'
);

select results_eq(
  $$ select whatsapp_deliveries, email_deliveries, decided_channel, outcome
     from card_channels where session_id = 'fd6e1111-1111-4111-8111-111111111111' $$,
  $$ values (1, 0, 'whatsapp'::text, 'selected'::text) $$,
  'E: the waiting card goes to the conversation channel once the client writes'
);

-- ---------------------------------------------------------------------------
-- Gmail transport: a booking card email without an enquiry resolves.
-- ---------------------------------------------------------------------------

insert into public.artist_integrations (
  artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
)
select
  'a1111111-1111-4111-8111-111111111111',
  'email'::public.artist_integration_type,
  'google',
  'vladimir-gmail',
  'studio@example.test',
  '{}'::jsonb,
  true
where not exists (
  select 1
  from public.artist_integrations i
  where i.artist_id = 'a1111111-1111-4111-8111-111111111111'
    and i.integration_type = 'email'::public.artist_integration_type
    and i.provider = 'google'
);

update public.integration_outbox o
set status = 'leased'::public.outbox_status,
    leased_by = 'gmail-worker-suite',
    leased_at = now(),
    lease_expires_at = now() + interval '2 minutes'
from crm_private.booking_cards b
where b.session_id = 'fd6b1111-1111-4111-8111-111111111111'
  and b.superseded_at is null
  and o.dedupe_key = 'email:booking_card:' || b.id::text;

select results_eq(
  $$ select t.enquiry_id, t.client_email, t.delivery_allowed
     from crm_private.booking_cards b
     join public.integration_outbox o on o.dedupe_key = 'email:booking_card:' || b.id::text
     cross join lateral public.service_resolve_gmail_outbox_target(o.id, 'gmail-worker-suite') t
     where b.session_id = 'fd6b1111-1111-4111-8111-111111111111'
       and b.superseded_at is null $$,
  $$ values (null::uuid, 'email-only@example.test'::text, true) $$,
  'Gmail resolves a booking card email that has no enquiry'
);

-- Moving an appointment closes the old card's Email job at once.
update public.sessions
set start_at = start_at + interval '1 day',
    end_at = end_at + interval '1 day',
    calendar_version = calendar_version + 1
where id = 'fd6d1111-1111-4111-8111-111111111111';

select results_eq(
  $$ select o.status::text, o.last_error_code
     from crm_private.booking_cards b
     join public.integration_outbox o on o.dedupe_key = 'email:booking_card:' || b.id::text
     where b.session_id = 'fd6d1111-1111-4111-8111-111111111111'
       and b.superseded_at is not null $$,
  $$ values ('dead'::text, 'booking_card_superseded'::text) $$,
  'a superseded card Email job is closed instead of retried'
);

select results_eq(
  $$ select whatsapp_deliveries, email_deliveries, decided_channel
     from card_channels where session_id = 'fd6d1111-1111-4111-8111-111111111111' $$,
  $$ values (0, 1, 'email'::text) $$,
  'the new card revision resolves its channel again and still uses one channel'
);

select ok(
  not has_table_privilege('authenticated', 'crm_private.booking_card_channel_decisions', 'SELECT')
  and not has_table_privilege('service_role', 'crm_private.booking_card_channel_decisions', 'SELECT')
  and not has_function_privilege('service_role', 'crm_private.resolve_booking_card_channel(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'crm_private.resolve_booking_card_channel(uuid,uuid)', 'EXECUTE'),
  'channel decisions and the resolver are private'
);

select * from finish(true);
rollback;
