-- 311_booking_card_dispatch.sql

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Ensure the synthetic artist has the provider routes the dispatch contract
-- expects. Everything is rolled back and no provider is contacted.
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

insert into auth.users (id, email) values
  ('fc111111-1111-4111-8111-111111111111', 'booking-dispatch-owner@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('fc111111-1111-4111-8111-111111111111',
   'booking-dispatch-owner@example.test',
   'Booking Dispatch Owner',
   'owner',
   true);

insert into public.clients (
  id, full_name, email, phone
) values (
  'fc211111-1111-4111-8111-111111111111',
  'Dispatch Client',
  'dispatch-client@example.test',
  '+447700900321'
);

-- Cards follow the client's real conversation. This client talks on WhatsApp.
insert into public.communication_conversations (
  id, artist_id, channel, integration_key, external_contact_id,
  client_id, link_state, state
) values (
  'fc311111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'vladimir-production', '447700900321',
  'fc211111-1111-4111-8111-111111111111', 'linked', 'open'
);

insert into public.communication_messages (
  conversation_id, artist_id, channel, direction, origin, status, message_type, body
) values (
  'fc311111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'inbound', 'contact', 'received', 'text', 'Hello'
);

insert into crm_private.booking_card_artist_settings (
  artist_id,
  email_enabled,
  whatsapp_enabled,
  studio_name,
  studio_address,
  studio_map_url,
  location_latitude,
  location_longitude,
  whatsapp_tattoo_template_name,
  whatsapp_consultation_template_name,
  whatsapp_template_language,
  whatsapp_tattoo_template_status,
  whatsapp_consultation_template_status,
  appointment_start_from,
  client_action_base_url
) values (
  'a1111111-1111-4111-8111-111111111111',
  true,
  true,
  'Synthetic Studio',
  '1 Synthetic Street, London',
  'https://maps.example.test/studio',
  51.500001,
  -0.100001,
  'booking_card_tattoo_v1',
  'booking_card_consultation_v1',
  'en_GB',
  'APPROVED',
  'APPROVED',
  null,
  'https://booking.example.test/appointments/respond/'
)
-- 20260926210000 already configures Vladimir (London, from November).
on conflict (artist_id) do update
set email_enabled = excluded.email_enabled,
    whatsapp_tattoo_template_status = excluded.whatsapp_tattoo_template_status,
    whatsapp_consultation_template_status = excluded.whatsapp_consultation_template_status,
    whatsapp_enabled = excluded.whatsapp_enabled,
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

insert into public.sessions (
  id, project_id, client_id, enquiry_id, artist_id,
  appointment_type, status, start_at, end_at,
  duration_hours, price, currency
) values (
  'fc611111-1111-4111-8111-111111111111',
  null,
  'fc211111-1111-4111-8111-111111111111',
  null,
  'a1111111-1111-4111-8111-111111111111',
  'in_person_consultation',
  'confirmed',
  date_trunc('day', now()) + interval '40 days 11 hours',
  date_trunc('day', now()) + interval '40 days 11 hours 30 minutes',
  0.5,
  null,
  'GBP'
);

select is(
  (select count(*)::int
   from crm_private.booking_cards
   where session_id = 'fc611111-1111-4111-8111-111111111111'
     and superseded_at is null),
  1,
  'confirmed consultation creates one canonical current booking card'
);

select is(
  (select count(*)::int
   from crm_private.booking_card_deliveries d
   join crm_private.booking_cards b on b.id = d.booking_card_id
   where b.session_id = 'fc611111-1111-4111-8111-111111111111'
     and d.status = 'queued'
     and d.channel = 'whatsapp'),
  1,
  'one card queues exactly one delivery, in the conversation channel'
);

select is(
  (select count(*)::int
   from crm_private.booking_card_deliveries d
   join crm_private.booking_cards b on b.id = d.booking_card_id
   where b.session_id = 'fc611111-1111-4111-8111-111111111111'
     and d.channel = 'email'),
  0,
  'an email address on file does not add an Email delivery'
);

select is(
  (select count(*)::int
   from crm_private.appointment_client_action_tokens t
   where t.session_id = 'fc611111-1111-4111-8111-111111111111'
     and t.consumed_at is null
     and t.invalidated_at is null),
  2,
  'the one queued channel has its two-action capability pair'
);

select results_eq(
  $$ select jsonb_array_length(p.body_parameters), p.template_name
     from crm_private.booking_card_whatsapp_payloads p
     join crm_private.booking_cards b on b.id = p.booking_card_id
     where b.session_id = 'fc611111-1111-4111-8111-111111111111' $$,
  $$ values (4, 'booking_card_consultation_v1'::text) $$,
  'consultation WhatsApp payload uses four reviewed body parameters'
);

select is(
  (select count(*)::int
   from public.integration_outbox o
   join crm_private.booking_cards b
     on o.dedupe_key in ('email:booking_card:' || b.id::text, 'whatsapp:booking_card:' || b.id::text)
   where b.session_id = 'fc611111-1111-4111-8111-111111111111'
     and o.kind in (
       'approved_email'::public.outbox_kind,
       'whatsapp_message'::public.outbox_kind
     )),
  1,
  'dispatch creates exactly one durable provider job and sends nothing inline'
);

select ok(
  (select bool_and(o.next_attempt_at >= now() + interval '110 seconds')
   from public.integration_outbox o
   join crm_private.booking_cards b
     on o.dedupe_key in ('email:booking_card:' || b.id::text, 'whatsapp:booking_card:' || b.id::text)
   where b.session_id = 'fc611111-1111-4111-8111-111111111111'),
  'card messages are held briefly so a follow-up edit supersedes them before sending'
);

-- Moving the appointment creates a new calendar version and supersedes the
-- old card. Both old queued channel messages must become unsendable.
update public.sessions
set start_at = start_at + interval '1 day',
    end_at = end_at + interval '1 day',
    calendar_version = calendar_version + 1
where id = 'fc611111-1111-4111-8111-111111111111';

select is(
  (select count(*)::int
   from crm_private.booking_cards
   where session_id = 'fc611111-1111-4111-8111-111111111111'),
  2,
  'rescheduling creates a new card revision rather than rewriting the old one'
);

select is(
  (select count(*)::int
   from crm_private.booking_card_deliveries d
   join crm_private.booking_cards b on b.id = d.booking_card_id
   where b.session_id = 'fc611111-1111-4111-8111-111111111111'
     and b.superseded_at is not null
     and d.status = 'superseded'),
  1,
  'superseded card closes its old channel delivery'
);

select is(
  (select count(*)::int
   from crm_private.appointment_client_action_tokens t
   join crm_private.booking_cards b on b.id = t.booking_card_id
   where b.session_id = 'fc611111-1111-4111-8111-111111111111'
     and b.superseded_at is not null
     and t.consumed_at is null
     and t.invalidated_at is null),
  0,
  'superseding a card invalidates all capabilities owned by that card'
);

select ok(
  (select m.status = 'failed'::public.communication_status
          and m.error_code = 'booking_card_superseded'
   from public.communication_messages m
   join crm_private.booking_card_whatsapp_payloads p
     on p.communication_message_id = m.id
   join crm_private.booking_cards b on b.id = p.booking_card_id
   where b.session_id = 'fc611111-1111-4111-8111-111111111111'
     and b.superseded_at is not null),
  'superseded WhatsApp card cannot be claimed for provider delivery'
);

-- The conversation channel being unreachable blocks the card; it never falls
-- back to another channel. Once reachable, reconciliation queues it.
insert into public.clients (
  id, full_name, email, phone
) values (
  'fc222222-2222-4222-8222-222222222222',
  'Partial Channel Client',
  'partial-channel@example.test',
  null
);

insert into public.communication_conversations (
  id, artist_id, channel, integration_key, external_contact_id,
  client_id, link_state, state
) values (
  'fc322222-2222-4222-8222-222222222222',
  'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'vladimir-production', '447700900654',
  'fc222222-2222-4222-8222-222222222222', 'linked', 'open'
);

insert into public.communication_messages (
  conversation_id, artist_id, channel, direction, origin, status, message_type, body
) values (
  'fc322222-2222-4222-8222-222222222222',
  'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'inbound', 'contact', 'received', 'text', 'Hello'
);

insert into public.sessions (
  id, project_id, client_id, enquiry_id, artist_id,
  appointment_type, status, start_at, end_at,
  duration_hours, price, currency
) values (
  'fc633333-3333-4333-8333-333333333333',
  null,
  'fc222222-2222-4222-8222-222222222222',
  null,
  'a1111111-1111-4111-8111-111111111111',
  'in_person_consultation',
  'confirmed',
  date_trunc('day', now()) + interval '50 days 11 hours',
  date_trunc('day', now()) + interval '50 days 11 hours 30 minutes',
  0.5,
  null,
  'GBP'
);

select is(
  (select count(*)::int
   from crm_private.booking_card_deliveries d
   join crm_private.booking_cards b on b.id = d.booking_card_id
   where b.session_id = 'fc633333-3333-4333-8333-333333333333'),
  0,
  'an unreachable WhatsApp conversation does not fall back to Email'
);

select is(
  (select x.outcome
   from crm_private.booking_card_channel_decisions x
   join crm_private.booking_cards b on b.id = x.booking_card_id
   where b.session_id = 'fc633333-3333-4333-8333-333333333333'
     and b.superseded_at is null),
  'conversation_channel_unreachable',
  'the blocked card records why'
);

select is(
  (select count(*)::int
   from crm_private.appointment_client_action_tokens t
   where t.session_id = 'fc633333-3333-4333-8333-333333333333'),
  0,
  'a blocked card leaves no orphan live capabilities'
);

update public.clients
set phone = '+447700900654'
where id = 'fc222222-2222-4222-8222-222222222222';

select lives_ok(
  $$ select * from crm_private.reconcile_booking_cards(
    'a1111111-1111-4111-8111-111111111111',
    200
  ) $$,
  'reconciliation can queue a card whose channel becomes reachable later'
);

select results_eq(
  $$ select d.channel::text, count(*)::int
     from crm_private.booking_card_deliveries d
     join crm_private.booking_cards b on b.id = d.booking_card_id
     where b.session_id = 'fc633333-3333-4333-8333-333333333333'
     group by d.channel $$,
  $$ values ('whatsapp'::text, 1) $$,
  'the repaired card has one WhatsApp delivery and no Email sibling'
);

select is(
  (select count(*)::int
   from crm_private.appointment_client_action_tokens t
   where t.session_id = 'fc633333-3333-4333-8333-333333333333'
     and t.consumed_at is null
     and t.invalidated_at is null),
  2,
  'the repaired card has one capability pair'
);

select ok(
  not has_function_privilege(
    'service_role',
    'crm_private.dispatch_booking_card(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'crm_private.dispatch_booking_card(uuid)',
    'EXECUTE'
  ),
  'no API role can mint or dispatch booking cards directly'
);

select * from finish(true);
rollback;
