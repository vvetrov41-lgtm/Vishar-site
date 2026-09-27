-- 318_booking_card_instagram.sql
--
-- Instagram is a full booking-card channel on the existing Instagram
-- transport: latest Instagram conversation -> Instagram only, quick replies
-- carry the canonical capability, a closed messaging window fails closed.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select public.service_set_instagram_integration(
  'a1111111-1111-4111-8111-111111111111', 'vladimir-instagram', '17841400000000001',
  'vladimir.synthetic', array['instagram_business_basic', 'instagram_business_manage_messages']
);

update crm_private.booking_card_artist_settings
set email_enabled = true,
    whatsapp_enabled = false,
    instagram_enabled = true,
    appointment_start_from = null
where artist_id = 'a1111111-1111-4111-8111-111111111111';

select ok(
  (select instagram_enabled and client_action_base_url is not null
   from crm_private.booking_card_artist_settings
   where artist_id = 'a1111111-1111-4111-8111-111111111111'),
  'Instagram cards can be switched on for an artist with a studio and action links'
);

insert into public.clients (id, full_name, email, phone) values
  ('f01a1111-1111-4111-8111-111111111111', 'Insta Client', 'insta@example.test', '+447700900701'),
  ('f01b1111-1111-4111-8111-111111111111', 'Quiet Insta', 'quiet-insta@example.test', '+447700900702'),
  ('f01c1111-1111-4111-8111-111111111111', 'Legacy Insta', 'legacy-insta@example.test', '+447700900703');

-- Real inbound Instagram messages through the existing ingestion RPC.
select public.record_communication_inbound_message(
  'a1111111-1111-4111-8111-111111111111', 'instagram', 'vladimir-instagram', '900000000001',
  'ig_mid_CARDTEST00000001', now() - interval '1 hour', 'text', 'Hi, can I book?', '[]'::jsonb, null);
select public.record_communication_inbound_message(
  'a1111111-1111-4111-8111-111111111111', 'instagram', 'vladimir-instagram', '900000000002',
  'ig_mid_CARDTEST00000002', now() - interval '2 days', 'text', 'Hello', '[]'::jsonb, null);
select public.record_communication_inbound_message(
  'a1111111-1111-4111-8111-111111111111', 'instagram', 'vladimir-instagram', '900000000003',
  'ig_mid_CARDTEST00000003', now() - interval '1 hour', 'text', 'Hello', '[]'::jsonb, null);

update public.communication_conversations c
set client_id = v.client_id::uuid, link_state = 'linked'
from (values
  ('900000000001', 'f01a1111-1111-4111-8111-111111111111'),
  ('900000000002', 'f01b1111-1111-4111-8111-111111111111'),
  ('900000000003', 'f01c1111-1111-4111-8111-111111111111')
) as v(contact, client_id)
where c.artist_id = 'a1111111-1111-4111-8111-111111111111'
  and c.channel = 'instagram'
  and c.external_contact_id = v.contact;

insert into public.sessions (
  id, client_id, artist_id, appointment_type, status, start_at, end_at,
  duration_hours, price, currency, created_at
) values
  ('f06a1111-1111-4111-8111-111111111111', 'f01a1111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'in_person_consultation', 'confirmed',
   date_trunc('day', now()) + interval '80 days 11 hours',
   date_trunc('day', now()) + interval '80 days 11 hours 30 minutes', 0.5, null, 'GBP', now()),
  ('f06b1111-1111-4111-8111-111111111111', 'f01b1111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'in_person_consultation', 'confirmed',
   date_trunc('day', now()) + interval '81 days 11 hours',
   date_trunc('day', now()) + interval '81 days 11 hours 30 minutes', 0.5, null, 'GBP', now()),
  ('f06c1111-1111-4111-8111-111111111111', 'f01c1111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'in_person_consultation', 'confirmed',
   date_trunc('day', now()) + interval '82 days 11 hours',
   date_trunc('day', now()) + interval '82 days 11 hours 30 minutes', 0.5, null, 'GBP',
   '2026-09-01T10:00:00Z');

create temporary view ig_cards as
select s.id as session_id, b.id as card_id,
       count(d.id) filter (where d.channel = 'instagram')::int as instagram,
       count(d.id) filter (where d.channel = 'email')::int as email,
       count(d.id) filter (where d.channel = 'whatsapp')::int as whatsapp,
       x.channel, x.outcome
from public.sessions s
left join crm_private.booking_cards b on b.session_id = s.id and b.superseded_at is null
left join crm_private.booking_card_deliveries d on d.booking_card_id = b.id
left join crm_private.booking_card_channel_decisions x on x.booking_card_id = b.id
group by s.id, b.id, x.channel, x.outcome;

-- Latest Instagram conversation -> Instagram only.
select results_eq(
  $$ select instagram, email, whatsapp, channel, outcome from ig_cards
     where session_id = 'f06a1111-1111-4111-8111-111111111111' $$,
  $$ values (1, 0, 0, 'instagram'::text, 'selected'::text) $$,
  'latest Instagram conversation gives exactly one Instagram delivery'
);

select results_eq(
  $$ select o.kind::text, o.session_id is null
     from public.integration_outbox o
     join ig_cards c on o.dedupe_key = 'instagram:booking_card:' || c.card_id::text
     where c.session_id = 'f06a1111-1111-4111-8111-111111111111' $$,
  $$ values ('instagram_message'::text, true) $$,
  'the card is one job on the existing Instagram outbox'
);

select ok(
  (select m.channel = 'instagram' and m.direction = 'outbound' and m.origin = 'automation'
          and m.status = 'queued' and m.message_type = 'booking_card'
          and m.body = 'Your consultation is booked.'
          and m.body !~ '[0-9a-f]{64}'
   from crm_private.booking_card_instagram_payloads p
   join public.communication_messages m on m.id = p.communication_message_id
   join ig_cards c on c.card_id = p.booking_card_id
   where c.session_id = 'f06a1111-1111-4111-8111-111111111111'),
  'the CRM timeline shows a short message without capabilities'
);

select ok(
  (select p.message_text like 'Hi Insta, your consultation with % is booked%'
          and p.message_text like '%I''ll be there: https://%'
          and p.message_text like '%Need another time: https://%'
          and p.message_text not like '%Deposit%'
          and char_length(p.message_text) <= 1000
          and p.confirm_payload ~ '^booking_action:[0-9a-f]{64}$'
          and p.reschedule_payload ~ '^booking_action:[0-9a-f]{64}$'
   from crm_private.booking_card_instagram_payloads p
   join ig_cards c on c.card_id = p.booking_card_id
   where c.session_id = 'f06a1111-1111-4111-8111-111111111111'),
  'the card text comes from canonical card facts, consultation without money, with link fallback'
);

select is(
  (select count(*)::int from crm_private.appointment_client_action_tokens t
   where t.session_id = 'f06a1111-1111-4111-8111-111111111111'
     and t.consumed_at is null and t.invalidated_at is null),
  2,
  'one capability pair for the one channel'
);

-- Closed messaging window: fail closed, no fallback, waits for the client.
select results_eq(
  $$ select instagram, email, whatsapp, channel, outcome from ig_cards
     where session_id = 'f06b1111-1111-4111-8111-111111111111' $$,
  $$ values (0, 0, 0, 'instagram'::text, 'messaging_window_closed'::text) $$,
  'a closed Instagram window blocks the card and never switches to Email'
);

select public.record_communication_inbound_message(
  'a1111111-1111-4111-8111-111111111111', 'instagram', 'vladimir-instagram', '900000000002',
  'ig_mid_CARDTEST00000004', now() - interval '1 minute', 'text', 'Still interested', '[]'::jsonb, null);

select results_eq(
  $$ select instagram, email, whatsapp, outcome from ig_cards
     where session_id = 'f06b1111-1111-4111-8111-111111111111' $$,
  $$ values (1, 0, 0, 'selected'::text) $$,
  'when the client writes again the waiting card goes to Instagram'
);

-- Grandfathering holds for Instagram too.
select results_eq(
  $$ select card_id is null from ig_cards where session_id = 'f06c1111-1111-4111-8111-111111111111' $$,
  $$ values (true) $$,
  'an appointment booked before activation gets no Instagram card'
);

-- The drain resolves what to send.
update public.integration_outbox o
set status = 'leased', leased_by = 'instagram-suite-worker', leased_at = now(),
    lease_expires_at = now() + interval '2 minutes'
from ig_cards c
where c.session_id = 'f06a1111-1111-4111-8111-111111111111'
  and o.dedupe_key = 'instagram:booking_card:' || c.card_id::text;

select results_eq(
  $$ select r.is_booking_card, r.delivery_allowed, r.confirm_payload = p.confirm_payload
     from ig_cards c
     join public.integration_outbox o on o.dedupe_key = 'instagram:booking_card:' || c.card_id::text
     join crm_private.booking_card_instagram_payloads p on p.booking_card_id = c.card_id
     cross join lateral public.service_resolve_instagram_booking_card_payload(o.id, 'instagram-suite-worker') r
     where c.session_id = 'f06a1111-1111-4111-8111-111111111111' $$,
  $$ values (true, true, true) $$,
  'the drain gets the card text and quick replies for a current card'
);

-- G. No sibling channel for an Instagram card.
select throws_ok(
  $$ insert into crm_private.booking_card_deliveries (booking_card_id, channel, status)
     select card_id, 'email'::public.message_template_channel, 'pending'
     from ig_cards where session_id = 'f06a1111-1111-4111-8111-111111111111' $$,
  '23505',
  'booking card already has a delivery in another channel',
  'the database refuses an Email sibling of an Instagram card'
);

-- Quick replies enter the canonical response flow, only from the card's contact.
create temporary table ig_payloads as
select p.confirm_payload, p.reschedule_payload
from crm_private.booking_card_instagram_payloads p
join ig_cards c on c.card_id = p.booking_card_id
where c.session_id = 'f06a1111-1111-4111-8111-111111111111';

select is(
  (select public.service_apply_instagram_booking_card_action(
     'a1111111-1111-4111-8111-111111111111', 'vladimir-instagram', '900000000003',
     'ig_mid_CARDTEST00000010', now(), confirm_payload, 'I''ll be there') ->> 'applied'
   from ig_payloads),
  'false',
  'a capability pressed from another Instagram contact is not applied'
);

select is(
  (select public.service_apply_instagram_booking_card_action(
     'a1111111-1111-4111-8111-111111111111', 'vladimir-instagram', '900000000001',
     'ig_mid_CARDTEST00000011', now(), confirm_payload, 'I''ll be there') ->> 'applied'
   from ig_payloads),
  'true',
  'I''ll be there from the card''s contact is applied'
);

select is(
  (select client_response::text from public.sessions where id = 'f06a1111-1111-4111-8111-111111111111'),
  'attendance_confirmed',
  'the appointment records the confirmation through the canonical flow'
);

select is(
  (select count(*)::int from public.communication_messages m
   join public.communication_conversations c on c.id = m.conversation_id
   where c.external_contact_id = '900000000001' and m.provider_message_id = 'ig_mid_CARDTEST00000011'),
  1,
  'the button press is recorded once as the client''s message'
);

select is(
  (select public.service_apply_instagram_booking_card_action(
     'a1111111-1111-4111-8111-111111111111', 'vladimir-instagram', '900000000001',
     'ig_mid_CARDTEST00000012', now(), confirm_payload, 'I''ll be there') ->> 'applied'
   from ig_payloads),
  'false',
  'a one-time capability cannot be applied twice'
);

-- Moving the appointment supersedes the Instagram message.
update public.sessions
set start_at = start_at + interval '1 day', end_at = end_at + interval '1 day',
    calendar_version = calendar_version + 1
where id = 'f06b1111-1111-4111-8111-111111111111';

select ok(
  (select bool_and(m.status = 'failed' and m.error_code = 'booking_card_superseded')
   from crm_private.booking_cards b
   join crm_private.booking_card_instagram_payloads p on p.booking_card_id = b.id
   join public.communication_messages m on m.id = p.communication_message_id
   where b.session_id = 'f06b1111-1111-4111-8111-111111111111' and b.superseded_at is not null),
  'a superseded card''s queued Instagram message can never be sent'
);

select ok(
  not has_table_privilege('service_role', 'crm_private.booking_card_instagram_payloads', 'SELECT')
  and not has_table_privilege('authenticated', 'crm_private.booking_card_instagram_payloads', 'SELECT')
  and has_function_privilege('service_role', 'public.service_resolve_instagram_booking_card_payload(uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.service_resolve_instagram_booking_card_payload(uuid,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.service_apply_instagram_booking_card_action(uuid,text,text,text,timestamptz,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.service_apply_instagram_booking_card_action(uuid,text,text,text,timestamptz,text,text)', 'EXECUTE'),
  'Instagram card payloads and RPCs are backend-only'
);

select * from finish(true);
rollback;
