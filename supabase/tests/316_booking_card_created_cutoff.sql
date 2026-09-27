-- 316_booking_card_created_cutoff.sql
--
-- Appointments booked before booking cards were switched on never get a card,
-- even when their price is saved later. Appointments booked after it do.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  (select appointment_created_from = '2026-09-27T05:00:00Z'::timestamptz
   from crm_private.booking_card_artist_settings
   where artist_id = 'a1111111-1111-4111-8111-111111111111'),
  'the activation cutoff is the release that switched cards on'
);

update crm_private.booking_card_artist_settings
set email_enabled = true,
    whatsapp_enabled = true,
    whatsapp_consultation_template_name = 'booking_card_consultation_v1',
    whatsapp_tattoo_template_name = 'booking_card_tattoo_v1',
    whatsapp_consultation_template_status = 'APPROVED',
    whatsapp_tattoo_template_status = 'APPROVED',
    appointment_start_from = null
where artist_id = 'a1111111-1111-4111-8111-111111111111';

insert into public.artist_integrations (
  artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
)
select 'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'meta_cloud_api',
  'vladimir-production', null, '{}'::jsonb, true
where not exists (
  select 1 from public.artist_integrations i
  where i.artist_id = 'a1111111-1111-4111-8111-111111111111'
    and i.integration_type = 'whatsapp'::public.artist_integration_type
    and i.integration_key = 'vladimir-production'
);

insert into public.clients (id, full_name, email, phone) values
  ('fe1a1111-1111-4111-8111-111111111111', 'Legacy Client', 'legacy@example.test', '+447700900501'),
  ('fe1b1111-1111-4111-8111-111111111111', 'New Client', 'new@example.test', '+447700900502');

-- Both clients really talk on WhatsApp, so only the cutoff can stop a card.
insert into public.communication_conversations (
  id, artist_id, channel, integration_key, external_contact_id, client_id, link_state, state
) values
  ('fe2a1111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'whatsapp', 'vladimir-production', '447700900501',
   'fe1a1111-1111-4111-8111-111111111111', 'linked', 'open'),
  ('fe2b1111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'whatsapp', 'vladimir-production', '447700900502',
   'fe1b1111-1111-4111-8111-111111111111', 'linked', 'open');

insert into public.communication_messages (
  conversation_id, artist_id, channel, direction, origin, status, message_type, body, provider_timestamp
) values
  ('fe2a1111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'whatsapp', 'inbound', 'contact', 'received', 'text', 'Hello', now() - interval '1 day'),
  ('fe2b1111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'whatsapp', 'inbound', 'contact', 'received', 'text', 'Hello', now() - interval '1 day');

insert into public.projects (id, client_id, artist_id, title, description, deposit_status, status) values
  ('fe7a1111-1111-4111-8111-111111111111', 'fe1a1111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'Legacy project', 'rollback only', 'paid', 'active');

-- Booked before activation, appointment far after the date window.
insert into public.sessions (
  id, client_id, artist_id, appointment_type, status, start_at, end_at,
  duration_hours, price, currency, created_at, project_id
) values
  ('fe6a1111-1111-4111-8111-111111111111', 'fe1a1111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'in_person_consultation', 'confirmed',
   date_trunc('day', now()) + interval '60 days 11 hours',
   date_trunc('day', now()) + interval '60 days 11 hours 30 minutes', 0.5, null, 'GBP',
   '2026-09-20T10:00:00Z', null),
  ('fe6c1111-1111-4111-8111-111111111111', 'fe1a1111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'tattoo_session', 'confirmed',
   date_trunc('day', now()) + interval '61 days 10 hours',
   date_trunc('day', now()) + interval '61 days 17 hours', 7, null, 'GBP',
   '2026-09-20T10:00:00Z', 'fe7a1111-1111-4111-8111-111111111111');

select is(
  (select reason from crm_private.booking_card_eligibility('fe6a1111-1111-4111-8111-111111111111')),
  'appointment_before_activation',
  'a legacy consultation is not eligible, with an explicit reason'
);

select is(
  (select count(*)::int from crm_private.booking_cards
   where session_id in ('fe6a1111-1111-4111-8111-111111111111', 'fe6c1111-1111-4111-8111-111111111111')),
  0,
  'legacy appointments get no card'
);

-- Saving a real price on a legacy session is safe.
select lives_ok(
  $$ update public.sessions set price = 980 where id = 'fe6c1111-1111-4111-8111-111111111111' $$,
  'a legacy session price can be saved'
);

select is(
  (select price from public.sessions where id = 'fe6c1111-1111-4111-8111-111111111111'),
  980::numeric,
  'the saved price is the real session price'
);

select is(
  (select reason from crm_private.booking_card_eligibility('fe6c1111-1111-4111-8111-111111111111')),
  'appointment_before_activation',
  'a priced legacy tattoo session stays ineligible'
);

select lives_ok(
  $$ select * from crm_private.reconcile_booking_cards('a1111111-1111-4111-8111-111111111111', 200) $$,
  'reconciliation runs'
);

select is(
  (select count(*)::int
   from crm_private.booking_cards b
   left join crm_private.booking_card_deliveries d on d.booking_card_id = b.id
   where b.session_id in ('fe6a1111-1111-4111-8111-111111111111', 'fe6c1111-1111-4111-8111-111111111111')),
  0,
  'neither saving the price nor reconciliation creates a card or delivery for legacy appointments'
);

-- A new appointment after the cutoff works automatically.
insert into public.sessions (
  id, client_id, artist_id, appointment_type, status, start_at, end_at,
  duration_hours, price, currency
) values (
  'fe6b1111-1111-4111-8111-111111111111', 'fe1b1111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111', 'in_person_consultation', 'confirmed',
  date_trunc('day', now()) + interval '62 days 11 hours',
  date_trunc('day', now()) + interval '62 days 11 hours 30 minutes', 0.5, null, 'GBP'
);

select results_eq(
  $$ select d.channel::text, count(*)::int
     from crm_private.booking_cards b
     join crm_private.booking_card_deliveries d on d.booking_card_id = b.id
     where b.session_id = 'fe6b1111-1111-4111-8111-111111111111'
       and b.superseded_at is null
     group by d.channel $$,
  $$ values ('whatsapp'::text, 1) $$,
  'an appointment booked after activation gets its one card automatically'
);

select * from finish(true);
rollback;
