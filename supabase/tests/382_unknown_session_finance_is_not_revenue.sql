-- 382_unknown_session_finance_is_not_revenue.sql
-- Phase 2 data-integrity regression for the observed historic records:
-- a completed tattoo can have payment_status='unpaid' AND price IS NULL.
-- Such rows are not an agreed debt, not a confirmed payment, and must never
-- be priced implicitly in the studio-share financial totals. Consultations
-- remain free, even when the operational payment_status defaults to 'unpaid'.
-- Entire fixture is synthetic, rolled back, with no provider sends.
begin;
select no_plan();

insert into public.clients (id, full_name, email) values
  ('f8200000-0000-4000-8000-000000000001',
   'Synthetic Price Integrity Client', 'price-integrity-382@example.test');

insert into public.projects
  (id, client_id, artist_id, status, title, hourly_rate, estimate_total, currency)
values
  ('f8200000-0000-4000-8000-000000000002',
   'f8200000-0000-4000-8000-000000000001',
   'a1111111-1111-4111-8111-111111111111',
   'active', 'Synthetic Finance Reconciliation', 140, 980, 'GBP');

insert into public.sessions
  (id, project_id, client_id, artist_id, appointment_type, status,
   start_at, end_at, duration_hours, price, payment_status, currency)
values
  -- The two positively priced paid sessions are the ONLY source of gross.
  ('f8210000-0000-4000-8000-000000000001',
   'f8200000-0000-4000-8000-000000000002',
   'f8200000-0000-4000-8000-000000000001',
   'a1111111-1111-4111-8111-111111111111',
   'tattoo_session', 'completed',
   '2017-04-01T10:00:00Z', '2017-04-01T17:00:00Z', 7, 980, 'paid', 'GBP'),
  ('f8210000-0000-4000-8000-000000000002',
   'f8200000-0000-4000-8000-000000000002',
   'f8200000-0000-4000-8000-000000000001',
   'a1111111-1111-4111-8111-111111111111',
   'touch_up', 'completed',
   '2017-04-02T10:00:00Z', '2017-04-02T13:00:00Z', 3, 420, 'paid', 'GBP'),
  -- Unknown price and unpaid badge: no invented money or debt.
  ('f8210000-0000-4000-8000-000000000003',
   'f8200000-0000-4000-8000-000000000002',
   'f8200000-0000-4000-8000-000000000001',
   'a1111111-1111-4111-8111-111111111111',
   'tattoo_session', 'completed',
   '2017-04-03T10:00:00Z', '2017-04-03T17:00:00Z', 7, null, 'unpaid', 'GBP'),
  -- Even a paid status cannot invent a price if finance is incomplete.
  ('f8210000-0000-4000-8000-000000000004',
   'f8200000-0000-4000-8000-000000000002',
   'f8200000-0000-4000-8000-000000000001',
   'a1111111-1111-4111-8111-111111111111',
   'tattoo_session', 'completed',
   '2017-04-04T10:00:00Z', '2017-04-04T17:00:00Z', 7, null, 'paid', 'GBP'),
  -- A future confirmed high-value booking is never historical revenue.
  ('f8210000-0000-4000-8000-000000000005',
   'f8200000-0000-4000-8000-000000000002',
   'f8200000-0000-4000-8000-000000000001',
   'a1111111-1111-4111-8111-111111111111',
   'tattoo_session', 'confirmed',
   '2037-04-05T10:00:00Z', '2037-04-05T17:00:00Z', 7, 5000, 'paid', 'GBP'),
  -- Free consultation: never counted as tattoo revenue or payment debt.
  ('f8210000-0000-4000-8000-000000000006',
   null, 'f8200000-0000-4000-8000-000000000001',
   'a1111111-1111-4111-8111-111111111111',
   'in_person_consultation', 'completed',
   '2017-04-06T10:00:00Z', '2017-04-06T10:30:00Z',
   0.5, null, 'unpaid', 'GBP');

create temp table phase2_share_result as
select crm_private.statistics_studio_share(
  'a1111111-1111-4111-8111-111111111111',
  '2017-04-01T00:00:00Z'::timestamptz,
  '2017-04-08T00:00:00Z'::timestamptz
) as data;

select is((select data->>'currency' from phase2_share_result),
          'GBP', 'studio share uses known GBP prices');
select is((select (data->>'sessions')::int from phase2_share_result),
          2, 'only two completed paid tattoo sessions have known prices');
select is((select (data->>'incomplete_sessions')::int from phase2_share_result),
          1, 'paid tattoo session lacking price is kept in incomplete count');
select is((select (data->>'unpaid_sessions')::int from phase2_share_result),
          1, 'unpaid tattoo session is flagged without inventing balance');
select is((select (data->>'gross')::numeric from phase2_share_result),
          1400::numeric, 'unknown-price sessions and free consultations add no revenue');
select is((select (data->>'studio_fee')::numeric from phase2_share_result),
          306::numeric, 'studio fee uses per-session known prices only');
select is((select (data->>'artist_net')::numeric from phase2_share_result),
          1094::numeric, 'artist net excludes unknown prices');
select is((select (data->>'effective_percent')::numeric from phase2_share_result),
          21.86::numeric, 'effective percent is based only on priced sessions');
select is((select count(*)::int from public.client_artist_links
           where client_id='f8200000-0000-4000-8000-000000000001'), 0,
          'an explicit client_artist_links row is not required for a project-backed card');
select ok(exists(
  select 1 from crm_private.client_artist_ids('f8200000-0000-4000-8000-000000000001')
  where artist_id='a1111111-1111-4111-8111-111111111111'
), 'the actual project/session relationship still grants proper artist access');

select * from finish(true);
rollback;
