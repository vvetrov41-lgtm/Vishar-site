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
     and d.status = 'queued'),
  2,
  'one card queues Email and WhatsApp independently'
);

select is(
  (select count(*)::int
   from crm_private.appointment_client_action_tokens t
   where t.session_id = 'fc611111-1111-4111-8111-111111111111'
     and t.consumed_at is null
     and t.invalidated_at is null),
  4,
  'each queued channel has its own two-action capability pair'
);

select ok(
  (select m.html_body is not null
          and m.body not like '%Deposit%'
          and m.body not like '%balance%'
   from public.email_messages m
   join crm_private.booking_cards b on b.id = m.booking_card_id
   where b.session_id = 'fc611111-1111-4111-8111-111111111111'),
  'consultation Email card is HTML-capable and financially empty'
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
   where o.session_id = 'fc611111-1111-4111-8111-111111111111'
     and o.kind in (
       'approved_email'::public.outbox_kind,
       'whatsapp_message'::public.outbox_kind
     )),
  2,
  'dispatch creates exactly two durable provider jobs and sends nothing inline'
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
  2,
  'superseded card closes both old channel deliveries'
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
  (select m.status = 'cancelled'::public.email_message_status
   from public.email_messages m
   join crm_private.booking_cards b on b.id = m.booking_card_id
   where b.session_id = 'fc611111-1111-4111-8111-111111111111'
     and b.superseded_at is not null),
  'superseded Email card cannot be claimed for provider delivery'
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

-- One unavailable channel must not break the already queued sibling. Later
-- reconciliation can add the missing channel without invalidating Email links.
insert into public.clients (
  id, full_name, email, phone
) values (
  'fc222222-2222-4222-8222-222222222222',
  'Partial Channel Client',
  'partial-channel@example.test',
  null
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
  1,
  'Email queues even when WhatsApp is initially unreachable'
);

create temporary table partial_email_tokens as
select t.token_hash
from crm_private.appointment_client_action_tokens t
where t.session_id = 'fc633333-3333-4333-8333-333333333333'
  and t.consumed_at is null
  and t.invalidated_at is null;

select is(
  (select count(*)::int from partial_email_tokens),
  2,
  'the unavailable WhatsApp subtransaction did not leave orphan live capabilities'
);

update public.clients
set phone = '+447700900654'
where id = 'fc222222-2222-4222-8222-222222222222';

select lives_ok(
  $$ select * from crm_private.reconcile_booking_cards(
    'a1111111-1111-4111-8111-111111111111',
    200
  ) $$,
  'reconciliation can add a channel that becomes reachable later'
);

select is(
  (select count(*)::int
   from crm_private.booking_card_deliveries d
   join crm_private.booking_cards b on b.id = d.booking_card_id
   where b.session_id = 'fc633333-3333-4333-8333-333333333333'),
  2,
  'the previously missing WhatsApp delivery is added without requeueing Email'
);

select is(
  (select count(*)::int
   from crm_private.appointment_client_action_tokens t
   where t.session_id = 'fc633333-3333-4333-8333-333333333333'
     and t.consumed_at is null
     and t.invalidated_at is null),
  4,
  'the repaired card has two independent channel capability pairs'
);

select ok(
  not exists (
    select 1
    from partial_email_tokens old
    join crm_private.appointment_client_action_tokens t
      on t.token_hash = old.token_hash
    where t.invalidated_at is not null
       or t.consumed_at is not null
  ),
  'retrying WhatsApp does not invalidate already queued Email actions'
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
