-- 1846_statistics_session_value.sql
--
-- Statistics money (20261015160000): estimated value from the artist's or the
-- project's own rates, confirmed value from sessions.price, kept apart, with
-- paid deposits taken off once. The estimate cases below are the same cases
-- as admin/src/test/session-pricing.test.ts ("suggestSessionPrice parity").

begin;
select no_plan();

-- ------------------------------------------------------------ closed surface

select ok(
  (select bool_and(not has_function_privilege(role, p.oid, 'EXECUTE'))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   cross join unnest(array['anon', 'authenticated', 'service_role']) role
   where n.nspname = 'crm_private' and p.proname = 'session_value_estimate'),
  'the estimate helper is not callable by any browser or service role'
);

select ok(
  pg_get_functiondef('public.gpt_get_statistics(timestamptz,timestamptz)'::regprocedure)
    like '%''forecast'', v_core -> ''finance'' -> ''forecast''%',
  'GPT reports the forecast the CRM shows, from the same core'
);

-- ------------------------------------------------- estimate (parity cases)
-- Artist: £140/h, £980 for a 7-hour day.

select is(
  (select row(amount, currency, basis, source)::text from crm_private.session_value_estimate(3, null, null, 140, 980, 7, 'GBP')),
  '(420.00,GBP,hourly,artist)', '3 h at the standard rate');
select is(
  (select row(amount, currency, basis, source)::text from crm_private.session_value_estimate(4, null, null, 140, 980, 7, 'GBP')),
  '(560.00,GBP,hourly,artist)', '4 h at the standard rate');
select is(
  (select row(amount, currency, basis, source)::text from crm_private.session_value_estimate(7, null, null, 140, 980, 7, 'GBP')),
  '(980.00,GBP,full_day,artist)', 'a full day is the configured day price');
select is(
  (select row(amount, currency, basis, source)::text from crm_private.session_value_estimate(8, null, null, 140, 980, 7, 'GBP')),
  '(980.00,GBP,full_day,artist)', 'a longer day is still the configured day price');
select is(
  (select row(amount, currency, basis, source)::text from crm_private.session_value_estimate(7, 140, 'GBP', 140, 980, 7, 'GBP')),
  '(980.00,GBP,full_day,project)', 'a project at the standard rate keeps the day price');
select is(
  (select row(amount, currency, basis, source)::text from crm_private.session_value_estimate(7, 200, 'GBP', 140, 980, 7, 'GBP')),
  '(1400.00,GBP,hourly,project)', 'a different project rate is never capped at the day price');
select is(
  (select row(amount, currency, basis, source)::text from crm_private.session_value_estimate(3, 200, 'EUR', 140, 980, 7, 'GBP')),
  '(600.00,EUR,hourly,project)', 'a project rate carries the project currency');
select is(
  (select row(amount, currency, basis, source)::text from crm_private.session_value_estimate(10, null, null, 140, null, null, 'GBP')),
  '(1400.00,GBP,hourly,artist)', 'no day price is inferred from an hourly rate');
select is(
  (select count(*)::int from crm_private.session_value_estimate(7, null, null, null, null, null, null)),
  0, 'an artist without rates has no estimate');
select is(
  (select count(*)::int from crm_private.session_value_estimate(null, null, null, 140, 980, 7, 'GBP')),
  0, 'a session without a length has no estimate');
select is(
  (select row(amount, currency, basis, source)::text from crm_private.session_value_estimate(3, 120, 'GBP', null, null, null, null)),
  '(360.00,GBP,hourly,project)', 'a project rate works for an artist without general rates');

-- ------------------------------------------------------------------ fixtures
-- Two fresh artists so nothing seeded can move the totals: "rated" has its
-- own rates, "unrated" has none (like Kristina on 2026-10-15).

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.artists (id, slug, display_name, workspace_id, timezone, default_currency)
select v.id::uuid, v.slug, v.name, a.workspace_id, 'Europe/London', 'GBP'
from (values
  ('5d000001-0000-4000-8000-000000000001', 'value-rated', 'Value rated'),
  ('5d000002-0000-4000-8000-000000000002', 'value-unrated', 'Value unrated')
) v(id, slug, name)
cross join public.artists a where a.id = 'a1111111-1111-4111-8111-111111111111';

insert into crm_private.artist_session_pricing (artist_id, currency, hourly_rate, full_day_rate, full_day_hours, session_deposit_amount)
values ('5d000001-0000-4000-8000-000000000001', 'GBP', 140, 980, 7, 250);

insert into public.clients (id, full_name, workspace_id)
select '5d100001-0000-4000-8000-000000000001'::uuid, 'Value client', a.workspace_id
from public.artists a where a.id = 'a1111111-1111-4111-8111-111111111111';

insert into public.projects (id, client_id, status, title, artist_id, hourly_rate, currency)
values
  ('5d300001-0000-4000-8000-000000000001', '5d100001-0000-4000-8000-000000000001', 'active', 'Standard', '5d000001-0000-4000-8000-000000000001', null, 'GBP'),
  ('5d300002-0000-4000-8000-000000000002', '5d100001-0000-4000-8000-000000000001', 'active', 'Project at 200', '5d000001-0000-4000-8000-000000000001', 200, 'GBP'),
  ('5d300003-0000-4000-8000-000000000003', '5d100001-0000-4000-8000-000000000001', 'active', 'Unrated artist', '5d000002-0000-4000-8000-000000000002', null, 'GBP');

-- Rated artist:
--  V1 7 h, no price            -> estimated 980 (day)
--  V2 4 h, no price            -> estimated 560
--  V3 3 h, project at 200      -> estimated 600 (project rate)
--  V4 5 h, price 1234          -> confirmed 1234 (an individual price wins)
--  V5 7 h, cancelled           -> out
--  V6 consultation, upcoming   -> out (free, never a value)
--  V7 touch-up, no price       -> out (often free; never estimated)
--  V8 touch-up, price 100      -> confirmed 100
--  V9 7 h, yesterday           -> out (history is not a forecast)
--  V10 7 h, rescheduled later  -> estimated 980 at its new date
-- Unrated artist:
--  U1, U2 7 h each, no price   -> no basis, 14 h
insert into public.sessions (
  id, project_id, client_id, status, appointment_type, start_at, end_at, duration_hours, price, currency, artist_id, cancelled_at
)
select v.id::uuid, v.project::uuid, '5d100001-0000-4000-8000-000000000001', v.status::public.session_status,
       v.kind::public.appointment_type, date_trunc('hour', now()) + v.offset_,
       date_trunc('hour', now()) + v.offset_ + make_interval(mins => (v.hours * 60)::int),
       v.hours, v.price, 'GBP', v.artist::uuid, case when v.status = 'cancelled' then now() end
from (values
  ('5d400001-0000-4000-8000-000000000001', '5d300001-0000-4000-8000-000000000001', '5d000001-0000-4000-8000-000000000001', 'confirmed', 'tattoo_session', interval '10 days', 7.0, null::numeric),
  ('5d400002-0000-4000-8000-000000000002', '5d300001-0000-4000-8000-000000000001', '5d000001-0000-4000-8000-000000000001', 'confirmed', 'tattoo_session', interval '11 days', 4.0, null),
  ('5d400003-0000-4000-8000-000000000003', '5d300002-0000-4000-8000-000000000002', '5d000001-0000-4000-8000-000000000001', 'confirmed', 'tattoo_session', interval '12 days', 3.0, null),
  ('5d400004-0000-4000-8000-000000000004', '5d300001-0000-4000-8000-000000000001', '5d000001-0000-4000-8000-000000000001', 'confirmed', 'tattoo_session', interval '13 days', 5.0, 1234),
  ('5d400005-0000-4000-8000-000000000005', '5d300001-0000-4000-8000-000000000001', '5d000001-0000-4000-8000-000000000001', 'cancelled', 'tattoo_session', interval '14 days', 7.0, null),
  ('5d400006-0000-4000-8000-000000000006', null, '5d000001-0000-4000-8000-000000000001', 'confirmed', 'in_person_consultation', interval '15 days', 0.5, null),
  ('5d400007-0000-4000-8000-000000000007', '5d300001-0000-4000-8000-000000000001', '5d000001-0000-4000-8000-000000000001', 'confirmed', 'touch_up', interval '16 days', 1.0, null),
  ('5d400008-0000-4000-8000-000000000008', '5d300001-0000-4000-8000-000000000001', '5d000001-0000-4000-8000-000000000001', 'confirmed', 'touch_up', interval '17 days', 1.0, 100),
  ('5d400009-0000-4000-8000-000000000009', '5d300001-0000-4000-8000-000000000001', '5d000001-0000-4000-8000-000000000001', 'confirmed', 'tattoo_session', interval '-1 day', 7.0, null),
  ('5d40000a-0000-4000-8000-00000000000a', '5d300001-0000-4000-8000-000000000001', '5d000001-0000-4000-8000-000000000001', 'confirmed', 'tattoo_session', interval '20 days', 7.0, null),
  ('5d40000b-0000-4000-8000-00000000000b', '5d300003-0000-4000-8000-000000000003', '5d000002-0000-4000-8000-000000000002', 'confirmed', 'tattoo_session', interval '10 days', 7.0, null),
  ('5d40000c-0000-4000-8000-00000000000c', '5d300003-0000-4000-8000-000000000003', '5d000002-0000-4000-8000-000000000002', 'confirmed', 'tattoo_session', interval '11 days', 7.0, null)
) v(id, project, artist, status, kind, offset_, hours, price);

-- V10 was moved: a reschedule is only a new start time.
update public.sessions
set start_at = start_at + interval '5 days', end_at = end_at + interval '5 days'
where id = '5d40000a-0000-4000-8000-00000000000a';

-- Paid deposits bound to one session: £250 on the estimated V1 and £250 on
-- the confirmed V4. Lifecycle triggers are bypassed for the fixture only.
set local session_replication_role = replica;
insert into public.payment_requests (
  id, idempotency_key, artist_id, client_id, project_id, session_id, purpose, amount, currency, status, provider, created_at
)
values
  ('5d500001-0000-4000-8000-000000000001', gen_random_uuid(), '5d000001-0000-4000-8000-000000000001', '5d100001-0000-4000-8000-000000000001',
   '5d300001-0000-4000-8000-000000000001', '5d400001-0000-4000-8000-000000000001', 'deposit', 250, 'GBP', 'paid', null, now() - interval '2 days'),
  ('5d500002-0000-4000-8000-000000000002', gen_random_uuid(), '5d000001-0000-4000-8000-000000000001', '5d100001-0000-4000-8000-000000000001',
   '5d300001-0000-4000-8000-000000000001', '5d400004-0000-4000-8000-000000000004', 'deposit', 250, 'GBP', 'paid', null, now() - interval '2 days');
set local session_replication_role = origin;

create temporary table value_forecast on commit drop as
select
  crm_private.statistics_core('5d000001-0000-4000-8000-000000000001', now() - interval '30 days', now(), now(), true) -> 'finance' -> 'forecast' as rated,
  crm_private.statistics_core('5d000002-0000-4000-8000-000000000002', now() - interval '30 days', now(), now(), true) -> 'finance' -> 'forecast' as unrated;

-- ------------------------------------------------------------ rated artist

select is((select (rated ->> 'sessions')::int from value_forecast), 6,
  'upcoming confirmed work: five tattoo sessions (one rescheduled) and the priced touch-up');
select is((select rated -> 'confirmed' ->> 'sessions' from value_forecast), '2',
  'two sessions carry a confirmed price');
select is((select rated -> 'confirmed' -> 'value' from value_forecast), '[{"amount": 1334.00, "currency": "GBP"}]'::jsonb,
  'confirmed value is the saved prices only: 1234 + 100');
select is((select rated -> 'estimated' ->> 'sessions' from value_forecast), '4',
  'four sessions are estimated from rates');
select is((select rated -> 'estimated' -> 'value' from value_forecast), '[{"amount": 3120.00, "currency": "GBP"}]'::jsonb,
  'estimated value: 980 (day) + 560 (4 h) + 600 (project at 200) + 980 (rescheduled day)');
select is((select array[rated -> 'estimated' ->> 'full_day', rated -> 'estimated' ->> 'hourly', rated -> 'estimated' ->> 'from_project_rate'] from value_forecast),
  array['2', '2', '1'], 'the estimate says how it was made');
select is((select rated -> 'expected_value' from value_forecast), '[{"amount": 4454.00, "currency": "GBP"}]'::jsonb,
  'expected value is confirmed plus estimated, never received money');
select is((select rated -> 'deposits_paid' from value_forecast), '[{"amount": 500, "currency": "GBP"}]'::jsonb,
  'each paid deposit is counted once');
select is((select rated -> 'remaining_after_deposits' from value_forecast), '[{"amount": 3954.00, "currency": "GBP"}]'::jsonb,
  'what is still to come takes each deposit off its own session once');
select is((select rated -> 'confirmed' -> 'remaining_after_deposits' from value_forecast), '[{"amount": 1084.00, "currency": "GBP"}]'::jsonb,
  'the confirmed balance is the booking-card balance: 1234 - 250 + 100');
select is((select rated -> 'no_basis' ->> 'sessions' from value_forecast), '0', 'nothing lacks a basis');
select is((select (rated ->> 'pricing_configured')::boolean from value_forecast), true, 'the artist has rates');

-- ---------------------------------------------------------- unrated artist

select is((select unrated -> 'no_basis' from value_forecast), '{"hours": 14.00, "sessions": 2}'::jsonb,
  'an artist without rates gets no estimate and no borrowed rate: two sessions, 14 h without a basis');
select is((select unrated -> 'expected_value' from value_forecast), '[]'::jsonb, 'and no invented value');
select is((select (unrated ->> 'pricing_configured')::boolean from value_forecast), false, 'the screen can say the rates are missing');

-- -------------------------------------------------- changes after booking

-- The session got longer: the estimate follows; a saved price does not move.
update public.sessions set duration_hours = 5, end_at = start_at + interval '5 hours'
where id = '5d400002-0000-4000-8000-000000000002';
update public.sessions set duration_hours = 6, end_at = start_at + interval '6 hours'
where id = '5d400004-0000-4000-8000-000000000004';
select is(
  (crm_private.statistics_core('5d000001-0000-4000-8000-000000000001', now() - interval '30 days', now(), now(), true)
     -> 'finance' -> 'forecast' -> 'estimated' -> 'value'),
  '[{"amount": 3260.00, "currency": "GBP"}]'::jsonb, 'a longer session raises its estimate (4 h -> 5 h)');
select is((select price from public.sessions where id = '5d400004-0000-4000-8000-000000000004'), 1234.00::numeric,
  'a confirmed price is never rewritten when the length changes');

-- The artist's general rate changed: estimates follow, saved prices stay.
update crm_private.artist_session_pricing set hourly_rate = 150 where artist_id = '5d000001-0000-4000-8000-000000000001';
select is(
  (crm_private.statistics_core('5d000001-0000-4000-8000-000000000001', now() - interval '30 days', now(), now(), true)
     -> 'finance' -> 'forecast' -> 'confirmed' -> 'value'),
  '[{"amount": 1334.00, "currency": "GBP"}]'::jsonb, 'confirmed value is untouched by a new artist rate');
select is(
  (crm_private.statistics_core('5d000001-0000-4000-8000-000000000001', now() - interval '30 days', now(), now(), true)
     -> 'finance' -> 'forecast' -> 'estimated' -> 'value'),
  '[{"amount": 3310.00, "currency": "GBP"}]'::jsonb,
  'estimates use the new rate: 980 + 750 (5 h x 150) + 600 (project rate) + 980');
select is(
  (select count(*)::int from public.sessions where artist_id = '5d000001-0000-4000-8000-000000000001' and price is not null),
  2, 'no estimate was ever written into sessions.price');

-- ------------------------------------- through the CRM's own RPCs, as staff
-- A member who manages sessions and views finance moves, shortens and
-- cancels sessions the way the CRM does. The forecast follows on the next
-- read; a confirmed price never moves.

insert into auth.users (id, email) values ('5d900001-0000-4000-8000-000000000001', 'value-staff@example.test');
insert into public.profiles (id, email, display_name, role, is_active)
values ('5d900001-0000-4000-8000-000000000001', 'value-staff@example.test', 'Value staff', 'booking_manager', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level, can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values ('5d900001-0000-4000-8000-000000000001', '5d000001-0000-4000-8000-000000000001', 'manager', true, false, true, false, true);

create function pg_temp.value_forecast() returns jsonb language sql as $$
  select crm_private.statistics_core('5d000001-0000-4000-8000-000000000001', now() - interval '30 days', now(), now(), true)
    -> 'finance' -> 'forecast';
$$;
create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated;

set local role authenticated;
select pg_temp.claims('{"sub":"5d900001-0000-4000-8000-000000000001","role":"authenticated"}');

-- V2 (estimated, 5 h) moved to another day and shortened to 3 h.
select lives_ok(
  $$select public.reschedule_appointment('5d400002-0000-4000-8000-000000000002',
      date_trunc('day', now()) + interval '40 days 10 hours', date_trunc('day', now()) + interval '40 days 13 hours')$$,
  'staff reschedule an estimated session to a shorter slot');
-- V4 (confirmed £1,234, 6 h) moved and lengthened to 8 h.
select lives_ok(
  $$select public.reschedule_appointment('5d400004-0000-4000-8000-000000000004',
      date_trunc('day', now()) + interval '41 days 9 hours', date_trunc('day', now()) + interval '41 days 17 hours')$$,
  'staff reschedule a confirmed-price session to a longer slot');
-- V1 (estimated day, £250 deposit paid) cancelled.
select lives_ok(
  $$select public.set_appointment_status('5d400001-0000-4000-8000-000000000001', 'cancelled')$$,
  'staff cancel a session');

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is((select duration_hours from public.sessions where id = '5d400002-0000-4000-8000-000000000002'), 3.00::numeric,
  'the reschedule recorded the new length');
select is((select price from public.sessions where id = '5d400004-0000-4000-8000-000000000004'), 1234.00::numeric,
  'a reschedule to a longer slot keeps the confirmed price');
select is((pg_temp.value_forecast() ->> 'sessions')::int, 5, 'the cancelled session leaves the forecast');
select is(pg_temp.value_forecast() -> 'estimated' -> 'value', '[{"amount": 2030.00, "currency": "GBP"}]'::jsonb,
  'estimates follow: 450 (3 h x 150) + 600 (project rate) + 980 (day); the cancelled day is gone');
select is(pg_temp.value_forecast() -> 'confirmed' -> 'value', '[{"amount": 1334.00, "currency": "GBP"}]'::jsonb,
  'confirmed value unchanged by moving or lengthening');
select is(pg_temp.value_forecast() -> 'deposits_paid', '[{"amount": 250, "currency": "GBP"}]'::jsonb,
  'the cancelled session''s deposit is no longer taken off the forecast');
select is(pg_temp.value_forecast() -> 'remaining_after_deposits', '[{"amount": 3114.00, "currency": "GBP"}]'::jsonb,
  'forecast remainder: 2030 + (1234 - 250) + 100');
select is(
  (select count(*)::int from public.sessions where artist_id = '5d000001-0000-4000-8000-000000000001' and price is not null),
  2, 'still no estimate written into sessions.price');

-- Without finance access there is no money at all.
select is(
  crm_private.statistics_core('5d000001-0000-4000-8000-000000000001', now() - interval '30 days', now(), now(), false) -> 'finance',
  'null'::jsonb, 'no finance block without finance access');

select * from finish();
rollback;
