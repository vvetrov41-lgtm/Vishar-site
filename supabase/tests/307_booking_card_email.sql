-- 307_booking_card_email.sql

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.clients (id, full_name, email) values (
  'fa211111-1111-4111-8111-111111111111',
  'Email Card Client',
  'email-card@example.test'
);

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'fa311111-1111-4111-8111-111111111111',
  'fa211111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'ENQ-2099-9917',
  'fa411111-1111-4111-8111-111111111111',
  repeat('a', 64),
  'accepted', 'complete', 'Email Card Client',
  'email-card@example.test', '2026-08-05', now()
);

insert into public.projects (
  id, client_id, enquiry_id, artist_id, title, status, currency
) values (
  'fa511111-1111-4111-8111-111111111111',
  'fa211111-1111-4111-8111-111111111111',
  'fa311111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'Email booking card project', 'active', 'GBP'
);

insert into public.sessions (
  id, project_id, client_id, enquiry_id, artist_id, appointment_type,
  status, start_at, end_at, duration_hours, price, currency
) values (
  'fa611111-1111-4111-8111-111111111111',
  'fa511111-1111-4111-8111-111111111111',
  'fa211111-1111-4111-8111-111111111111',
  'fa311111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'tattoo_session', 'confirmed',
  date_trunc('day', now()) + interval '30 days 10 hours',
  date_trunc('day', now()) + interval '30 days 17 hours',
  7, 980.00, 'GBP'
), (
  'fa622222-2222-4222-8222-222222222222',
  null,
  'fa211111-1111-4111-8111-111111111111',
  null,
  'a1111111-1111-4111-8111-111111111111',
  'in_person_consultation', 'confirmed',
  date_trunc('day', now()) + interval '31 days 11 hours',
  date_trunc('day', now()) + interval '31 days 11 hours 30 minutes',
  0.5, null, 'GBP'
);

insert into crm_private.booking_card_artist_settings (
  artist_id,
  email_enabled,
  whatsapp_enabled,
  studio_name,
  studio_address,
  studio_map_url
) values (
  'a1111111-1111-4111-8111-111111111111',
  true,
  false,
  'Synthetic Studio',
  '1 Synthetic Street, London',
  'https://maps.example.test/synthetic'
);

-- The tattoo renderer trusts only a canonical card. Foundation materialization
-- is tested separately with a real payment transition.
insert into crm_private.booking_cards (
  id, session_id, artist_id, workspace_id, client_id, enquiry_id, project_id,
  card_kind, appointment_type, calendar_version, revision,
  start_at, end_at, timezone, currency,
  session_price, deposit_paid, remaining_balance, fact_hash
)
select
  'fa711111-1111-4111-8111-111111111111',
  s.id, s.artist_id, a.workspace_id, s.client_id, s.enquiry_id, s.project_id,
  'tattoo_deposit_paid', s.appointment_type, s.calendar_version, 1,
  s.start_at, s.end_at, a.timezone, s.currency,
  980.00, 250.00, 730.00, repeat('b', 64)
from public.sessions s
join public.artists a on a.id = s.artist_id
where s.id = 'fa611111-1111-4111-8111-111111111111';

select ok(
  (select body like '%Deposit paid: £250%'
          and body like '%Remaining balance: £730%'
          and html_body like '%I&#39;ll be there%'
          and html_body like '%Need another time%'
   from crm_private.render_booking_card_email(
     'fa711111-1111-4111-8111-111111111111',
     repeat('c', 64),
     repeat('d', 64)
   )),
  'tattoo Email card renders canonical money and the two client actions'
);

select ok(
  (select body not like '%Deposit%'
          and body not like '%balance%'
          and html_body not like '%Deposit%'
          and html_body not like '%balance%'
   from crm_private.render_booking_card_email(
     (select id from crm_private.booking_cards
      where session_id = 'fa622222-2222-4222-8222-222222222222'
        and superseded_at is null),
     repeat('e', 64),
     repeat('f', 64)
   )),
  'consultation Email card is completely free with no financial block'
);

select ok(
  crm_private.create_booking_card_email(
    'fa711111-1111-4111-8111-111111111111',
    repeat('c', 64),
    repeat('d', 64)
  ) is not null,
  'reviewed tattoo Email content can be materialized as a system-approved message'
);

select ok(
  (select m.created_by_kind = 'system'
          and m.approved_at is not null
          and m.booking_card_id = 'fa711111-1111-4111-8111-111111111111'
          and m.payment_request_id is null
          and m.automation_job_id is null
          and m.html_body is not null
   from public.email_messages m
   where m.booking_card_id = 'fa711111-1111-4111-8111-111111111111'),
  'booking card Email has canonical provenance and an HTML alternative'
);

select is(
  (select count(*)::int
   from public.email_messages
   where booking_card_id = 'fa711111-1111-4111-8111-111111111111'),
  1,
  'Email card creation is idempotent'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'crm_private.create_booking_card_email(uuid,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'crm_private.create_booking_card_email(uuid,text,text)',
    'EXECUTE'
  ),
  'no API role can mint a reviewed booking-card Email'
);

select * from finish(true);
rollback;
