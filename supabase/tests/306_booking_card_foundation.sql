-- 306_booking_card_foundation.sql

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  not has_table_privilege('authenticated', 'crm_private.booking_cards', 'SELECT')
  and not has_table_privilege('service_role', 'crm_private.booking_cards', 'SELECT')
  and not has_table_privilege('anon', 'crm_private.booking_cards', 'SELECT')
  and not has_table_privilege('authenticated', 'crm_private.booking_card_deliveries', 'SELECT')
  and not has_table_privilege('service_role', 'crm_private.booking_card_deliveries', 'SELECT'),
  'canonical booking card state is private'
);

select ok(
  not has_function_privilege(
    'service_role',
    'crm_private.sync_booking_card(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'crm_private.sync_booking_card(uuid)',
    'EXECUTE'
  ),
  'API roles cannot mint canonical booking cards'
);

insert into auth.users (id, email) values
  ('f8111111-1111-4111-8111-111111111111', 'booking-card-owner@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('f8111111-1111-4111-8111-111111111111', 'booking-card-owner@example.test',
   'Booking Card Owner', 'owner', true);

insert into public.clients (id, full_name, email) values (
  'f8211111-1111-4111-8111-111111111111',
  'Booking Card Client',
  'booking-card-client@example.test'
);

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'f8311111-1111-4111-8111-111111111111',
  'f8211111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'ENQ-2099-9812',
  'f8411111-1111-4111-8111-111111111111',
  repeat('8', 64),
  'accepted', 'complete', 'Booking Card Client',
  'booking-card-client@example.test', '2026-08-05', now()
);

insert into public.projects (
  id, client_id, enquiry_id, artist_id, title, status, currency
) values (
  'f8511111-1111-4111-8111-111111111111',
  'f8211111-1111-4111-8111-111111111111',
  'f8311111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'Booking card project', 'active', 'GBP'
);

insert into public.sessions (
  id, project_id, client_id, enquiry_id, artist_id, appointment_type,
  status, start_at, end_at, duration_hours, price, currency
) values (
  'f8611111-1111-4111-8111-111111111111',
  'f8511111-1111-4111-8111-111111111111',
  'f8211111-1111-4111-8111-111111111111',
  'f8311111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'tattoo_session', 'confirmed',
  now() + interval '20 days', now() + interval '20 days 7 hours',
  7, 980.00, 'GBP'
), (
  'f8622222-2222-4222-8222-222222222222',
  null,
  'f8211111-1111-4111-8111-111111111111',
  null,
  'a1111111-1111-4111-8111-111111111111',
  'in_person_consultation', 'confirmed',
  now() + interval '21 days', now() + interval '21 days 30 minutes',
  0.5, null, 'GBP'
);

select is(
  (select count(*)::int
   from crm_private.booking_cards
   where session_id = 'f8611111-1111-4111-8111-111111111111'
     and superseded_at is null),
  0,
  'a tattoo card does not exist before an attributable paid deposit'
);

select is(
  (select count(*)::int
   from crm_private.booking_cards
   where session_id = 'f8622222-2222-4222-8222-222222222222'
     and card_kind = 'consultation_booked'
     and superseded_at is null),
  1,
  'a confirmed future in-person consultation materializes a free booking card'
);

select ok(
  (select session_price is null and deposit_paid is null and remaining_balance is null
   from crm_private.booking_cards
   where session_id = 'f8622222-2222-4222-8222-222222222222'
     and superseded_at is null),
  'consultation cards contain no financial fields'
);

insert into public.payment_requests (
  id, idempotency_key, artist_id, client_id, project_id, session_id,
  purpose, amount, currency, policy_id, policy_version, policy_snapshot
)
select
  'f8711111-1111-4111-8111-111111111111',
  'f8722222-2222-4222-8222-222222222222',
  'a1111111-1111-4111-8111-111111111111',
  'f8211111-1111-4111-8111-111111111111',
  'f8511111-1111-4111-8111-111111111111',
  'f8611111-1111-4111-8111-111111111111',
  'deposit',
  tier.amount,
  tier.currency,
  tier.policy_id,
  tier.policy_version,
  jsonb_build_object(
    'policy_id', tier.policy_id,
    'policy_version', tier.policy_version,
    'test_fixture', true
  )
from crm_private.resolve_session_deposit_tier(
  'a1111111-1111-4111-8111-111111111111',
  'f8611111-1111-4111-8111-111111111111'
) tier;

create function pg_temp.card_claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.card_claims(text) to authenticated, service_role;

set local role authenticated;
select pg_temp.card_claims(
  '{"sub":"f8111111-1111-4111-8111-111111111111","role":"authenticated"}'
);

select lives_ok(
  $$ select public.record_manual_payment(
    'f8711111-1111-4111-8111-111111111111',
    'f8733333-3333-4333-8333-333333333333',
    250.00,
    now(),
    'crm_manual_payment'
  ) $$,
  'settling the session deposit uses the existing immutable payment ledger'
);

reset role;

select is(
  (select status::text
   from public.payment_requests
   where id = 'f8711111-1111-4111-8111-111111111111'),
  'paid',
  'the payment request became paid authoritatively'
);

select results_eq(
  $$ select session_price, deposit_paid, remaining_balance
     from crm_private.booking_cards
     where session_id = 'f8611111-1111-4111-8111-111111111111'
       and card_kind = 'tattoo_deposit_paid'
       and superseded_at is null $$,
  $$ values (980.00::numeric, 250.00::numeric, 730.00::numeric) $$,
  'the tattoo card uses session price minus the attributable paid deposit'
);

set local role authenticated;
select pg_temp.card_claims(
  '{"sub":"f8111111-1111-4111-8111-111111111111","role":"authenticated"}'
);
select lives_ok(
  $$ select public.set_appointment_price(
    'f8611111-1111-4111-8111-111111111111',
    1000.00
  ) $$,
  'changing the explicit session price refreshes the canonical card facts'
);
reset role;

select is(
  (select count(*)::int
   from crm_private.booking_cards
   where session_id = 'f8611111-1111-4111-8111-111111111111'
     and card_kind = 'tattoo_deposit_paid'),
  2,
  'changed financial facts create a new card revision instead of rewriting history'
);

select results_eq(
  $$ select revision, remaining_balance
     from crm_private.booking_cards
     where session_id = 'f8611111-1111-4111-8111-111111111111'
       and superseded_at is null $$,
  $$ values (2, 750.00::numeric) $$,
  'the new revision is current and uses the new explicit price'
);

select is(
  (select count(*)::int
   from crm_private.booking_card_deliveries),
  0,
  'the foundation migration never queues client delivery'
);

select * from finish(true);
rollback;
