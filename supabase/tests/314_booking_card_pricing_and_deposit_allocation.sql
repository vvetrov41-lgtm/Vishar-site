-- 314_booking_card_pricing_and_deposit_allocation.sql

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Pricing configuration ------------------------------------------------------

select ok(
  not has_table_privilege('authenticated', 'crm_private.artist_session_pricing', 'SELECT')
  and not has_table_privilege('service_role', 'crm_private.artist_session_pricing', 'SELECT')
  and not has_table_privilege('anon', 'crm_private.artist_session_pricing', 'SELECT'),
  'artist session pricing is private'
);

select ok(
  has_function_privilege('authenticated', 'public.get_artist_session_pricing(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_artist_session_pricing(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated',
    'public.set_artist_session_pricing(uuid,numeric,numeric,numeric,numeric,text)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.set_artist_session_pricing(uuid,numeric,numeric,numeric,numeric,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.get_session_booking_card_status(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_session_booking_card_status(uuid)', 'EXECUTE'),
  'pricing and card status RPCs are for signed-in operators only'
);

select is(
  (select row(hourly_rate, full_day_rate, full_day_hours, session_deposit_amount, currency)::text
   from crm_private.artist_session_pricing
   where artist_id = 'a1111111-1111-4111-8111-111111111111'),
  '(140.00,980.00,7.00,250.00,GBP)',
  'Vladimir is seeded with £140/hour, £980 per 7-hour day and £250 per session'
);

select is(
  (select count(*)::int from crm_private.artist_session_pricing
   where artist_id = 'a2222222-2222-4222-8222-222222222222'),
  0,
  'Kristina gets no borrowed prices; she configures her own'
);

select is(crm_private.booking_card_money(1500, 'GBP'), '£1,500', 'thousands separator');
select is(crm_private.booking_card_money(980, 'GBP'), '£980', 'whole pounds drop pence');
select is(crm_private.booking_card_money(62.5, 'GBP'), '£62.50', 'pence are kept');
select is(crm_private.booking_card_money(12345.6, 'EUR'), '12,345.60 EUR', 'other currencies');

-- Fixtures ---------------------------------------------------------------------

insert into auth.users (id, email) values
  ('f9111111-1111-4111-8111-111111111111', 'alloc-manager@example.test'),
  ('f9122222-2222-4222-8222-222222222222', 'alloc-viewer@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('f9111111-1111-4111-8111-111111111111', 'alloc-manager@example.test',
   'Allocation Manager', 'booking_manager', true),
  ('f9122222-2222-4222-8222-222222222222', 'alloc-viewer@example.test',
   'Allocation Viewer', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('f9111111-1111-4111-8111-111111111111', 'a2222222-2222-4222-8222-222222222222',
   'manager', true, true, true, false, true),
  ('f9122222-2222-4222-8222-222222222222', 'a2222222-2222-4222-8222-222222222222',
   'manager', false, false, true, false, true);

insert into public.clients (id, full_name, email) values
  ('f9211111-1111-4111-8111-111111111111', 'Allocation Client', 'alloc-client@example.test');

-- Vladimir: project deposit £500 recorded only as project state (legacy),
-- three booked full-day sessions at £980.
insert into public.projects (
  id, client_id, artist_id, title, status, currency, deposit_status, deposit_amount
) values (
  'f9511111-1111-4111-8111-111111111111',
  'f9211111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'Sleeve', 'active', 'GBP', 'paid', 500.00
);

insert into public.sessions (
  id, project_id, client_id, artist_id, appointment_type, status,
  start_at, end_at, duration_hours, price, currency
) values
  ('f9611111-1111-4111-8111-111111111111', 'f9511111-1111-4111-8111-111111111111',
   'f9211111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'tattoo_session', 'confirmed', now() + interval '30 days', now() + interval '30 days 7 hours',
   7, 980.00, 'GBP'),
  ('f9622222-2222-4222-8222-222222222222', 'f9511111-1111-4111-8111-111111111111',
   'f9211111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'tattoo_session', 'confirmed', now() + interval '40 days', now() + interval '40 days 7 hours',
   7, 980.00, 'GBP'),
  ('f9633333-3333-4333-8333-333333333333', 'f9511111-1111-4111-8111-111111111111',
   'f9211111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'tattoo_session', 'confirmed', now() + interval '50 days', now() + interval '50 days 4 hours',
   4, 560.00, 'GBP'),
  ('f9644444-4444-4444-8444-444444444444', 'f9511111-1111-4111-8111-111111111111',
   'f9211111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'tattoo_session', 'confirmed', now() + interval '60 days', now() + interval '60 days 7 hours',
   7, null, 'GBP');

select results_eq(
  $$select session_price, deposit_paid, remaining_balance
    from crm_private.booking_cards
    where session_id in ('f9611111-1111-4111-8111-111111111111', 'f9622222-2222-4222-8222-222222222222')
      and superseded_at is null
    order by start_at$$,
  $$values (980.00::numeric(12,2), 250.00::numeric(12,2), 730.00::numeric(12,2)),
           (980.00::numeric(12,2), 250.00::numeric(12,2), 730.00::numeric(12,2))$$,
  'a £500 project deposit covers the first two sessions at £250 each: £980 - £250 = £730'
);

select is(
  (select reason from crm_private.booking_card_eligibility('f9633333-3333-4333-8333-333333333333')),
  'deposit_not_paid_for_session',
  'the third session is not covered by the project deposit, so no card'
);

select is(
  (select count(*)::int from crm_private.booking_cards
   where session_id = 'f9633333-3333-4333-8333-333333333333'),
  0,
  'no card is materialised for an uncovered session'
);

select is(
  (select reason from crm_private.booking_card_eligibility('f9644444-4444-4444-8444-444444444444')),
  'session_price_missing',
  'a tattoo session without an explicit price never gets a card'
);

-- Cancelling the first session releases its share to the next booked one.
update public.sessions set status = 'cancelled'
where id = 'f9611111-1111-4111-8111-111111111111';

select is(
  (select count(*)::int from crm_private.booking_cards
   where session_id = 'f9611111-1111-4111-8111-111111111111' and superseded_at is null),
  0,
  'a cancelled session loses its current card'
);

select is(
  (select row(session_price, deposit_paid, remaining_balance)::text
   from crm_private.booking_cards
   where session_id = 'f9633333-3333-4333-8333-333333333333' and superseded_at is null),
  '(560.00,250.00,310.00)',
  'the freed deposit share moves to the next booked session (4 h at £140 = £560, balance £310)'
);

-- A price edit re-issues the card with new money facts.
update public.sessions set price = 1120.00
where id = 'f9622222-2222-4222-8222-222222222222';

select is(
  (select row(revision, session_price, remaining_balance)::text
   from crm_private.booking_cards
   where session_id = 'f9622222-2222-4222-8222-222222222222' and superseded_at is null),
  '(2,1120.00,870.00)',
  'changing the session price creates a new card revision with recomputed balance'
);

-- Changing it back is allowed: the fact hash may repeat across revisions.
update public.sessions set price = 980.00
where id = 'f9622222-2222-4222-8222-222222222222';

select is(
  (select row(revision, remaining_balance)::text
   from crm_private.booking_cards
   where session_id = 'f9622222-2222-4222-8222-222222222222' and superseded_at is null),
  '(3,730.00)',
  'returning to earlier facts creates a fresh current revision'
);

-- A refunded project deposit withdraws every card that relied on it.
update public.projects set deposit_status = 'refunded'
where id = 'f9511111-1111-4111-8111-111111111111';

select is(
  (select count(*)::int from crm_private.booking_cards
   where project_id = 'f9511111-1111-4111-8111-111111111111' and superseded_at is null),
  0,
  'a refunded project deposit supersedes the tattoo cards'
);

-- Kristina: no per-session deposit configured. A project deposit is only
-- attributable when exactly one tattoo session is booked.
insert into public.projects (
  id, client_id, artist_id, title, status, currency, deposit_status, deposit_amount
) values (
  'f9522222-2222-4222-8222-222222222222',
  'f9211111-1111-4111-8111-111111111111',
  'a2222222-2222-4222-8222-222222222222',
  'Floral piece', 'active', 'GBP', 'paid', 500.00
);

insert into public.sessions (
  id, project_id, client_id, artist_id, appointment_type, status,
  start_at, end_at, duration_hours, price, currency
) values
  ('f9655555-5555-4555-8555-555555555555', 'f9522222-2222-4222-8222-222222222222',
   'f9211111-1111-4111-8111-111111111111', 'a2222222-2222-4222-8222-222222222222',
   'tattoo_session', 'confirmed', now() + interval '35 days', now() + interval '35 days 5 hours',
   5, 900.00, 'GBP');

select is(
  (select row(deposit_paid, remaining_balance)::text
   from crm_private.booking_cards
   where session_id = 'f9655555-5555-4555-8555-555555555555' and superseded_at is null),
  '(500.00,400.00)',
  'a single booked session takes the whole project deposit with Kristina''s own price'
);

insert into public.sessions (
  id, project_id, client_id, artist_id, appointment_type, status,
  start_at, end_at, duration_hours, price, currency
) values
  ('f9666666-6666-4666-8666-666666666666', 'f9522222-2222-4222-8222-222222222222',
   'f9211111-1111-4111-8111-111111111111', 'a2222222-2222-4222-8222-222222222222',
   'tattoo_session', 'confirmed', now() + interval '45 days', now() + interval '45 days 5 hours',
   5, 900.00, 'GBP');

select is(
  (select count(*)::int from crm_private.booking_cards
   where project_id = 'f9522222-2222-4222-8222-222222222222' and superseded_at is null),
  0,
  'two booked sessions without a per-session deposit are ambiguous, so neither card claims the deposit'
);

-- Operator RPCs ----------------------------------------------------------------

create function pg_temp.alloc_claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.alloc_claims(text) to authenticated, service_role;

set local role authenticated;
select pg_temp.alloc_claims(
  '{"sub":"f9111111-1111-4111-8111-111111111111","role":"authenticated"}'
);

select throws_ok(
  $$select public.set_artist_session_pricing(
      'a2222222-2222-4222-8222-222222222222', 120.005, null, null, 250, 'GBP')$$,
  '22023',
  null,
  'rates are validated to two decimal places'
);

select throws_ok(
  $$select public.set_artist_session_pricing(
      'a2222222-2222-4222-8222-222222222222', 120, 800, null, 250, 'GBP')$$,
  '22023',
  null,
  'a full-day rate needs its length in hours'
);

select is(
  (public.set_artist_session_pricing(
     'a2222222-2222-4222-8222-222222222222', 130, 850, 6.5, 250, 'GBP') ->> 'session_deposit_amount')::numeric,
  250::numeric,
  'Kristina''s manager can set her own rates and per-session deposit'
);

select is(
  (public.get_session_booking_card_status('f9666666-6666-4666-8666-666666666666') ->> 'remaining_balance')::numeric,
  650::numeric,
  'with a £250 per-session deposit configured, her second session is covered too: £900 - £250'
);

select throws_ok(
  $$select public.set_artist_session_pricing(
      'a1111111-1111-4111-8111-111111111111', 1, null, null, null, 'GBP')$$,
  '42501',
  null,
  'a manager cannot change another artist''s rates'
);

select pg_temp.alloc_claims(
  '{"sub":"f9122222-2222-4222-8222-222222222222","role":"authenticated"}'
);

select ok(
  (public.get_session_booking_card_status('f9666666-6666-4666-8666-666666666666') ->> 'session_price') is null
  and (public.get_session_booking_card_status('f9666666-6666-4666-8666-666666666666') ->> 'reason') = 'ready',
  'an operator without finance access sees the card state but not the money'
);

select throws_ok(
  $$select public.get_artist_session_pricing('a2222222-2222-4222-8222-222222222222')$$,
  '42501',
  null,
  'rates are finance data'
);

reset role;

select * from finish();
rollback;
