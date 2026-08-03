-- 110_payment_ledger.sql
--
-- Migration 0018: versioned policies, artist/request consistency, immutable
-- transaction history, ledger-derived request status, refund limits, provider
-- webhook idempotency and artist-scoped finance visibility.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Schema and enum surface
-- ---------------------------------------------------------------------------

select has_type('public', 'payment_policy_mode', 'payment_policy_mode exists');
select has_type('public', 'payment_request_purpose', 'payment_request_purpose exists');
select has_type('public', 'payment_request_status', 'payment_request_status exists');
select has_type('public', 'payment_transaction_type', 'payment_transaction_type exists');
select has_type('public', 'payment_transaction_direction', 'payment_transaction_direction exists');
select has_type('public', 'payment_transaction_status', 'payment_transaction_status exists');
select has_type('public', 'payment_recorded_by_kind', 'payment_recorded_by_kind exists');
select has_type('public', 'payment_webhook_processing_status',
                'payment_webhook_processing_status exists');

select enum_has_labels(
  'public', 'payment_request_status',
  array['pending', 'partially_paid', 'paid', 'cancelled', 'expired'],
  'request status separates financial and closed states'
);
select enum_has_labels(
  'public', 'payment_transaction_type',
  array['payment', 'refund', 'partial_refund', 'manual_payment', 'adjustment'],
  'transactions include payments, refunds, manual payments and adjustments'
);

select has_table('public', 'artist_payment_policies',
                 'artist_payment_policies exists');
select has_table('public', 'payment_requests', 'payment_requests exists');
select has_table('public', 'payment_transactions', 'payment_transactions exists');
select has_table('public', 'payment_webhook_events',
                 'payment_webhook_events exists');

select has_column('public', 'payment_requests', c,
                  'payment_requests.' || c || ' exists')
from unnest(array[
  'id', 'idempotency_key', 'artist_id', 'client_id', 'project_id',
  'session_id', 'purpose', 'amount', 'currency', 'status', 'provider',
  'provider_account_key', 'policy_id', 'policy_version', 'policy_snapshot',
  'expires_at', 'created_by', 'created_at', 'updated_at'
]) as c;

select has_column('public', 'payment_transactions', c,
                  'payment_transactions.' || c || ' exists')
from unnest(array[
  'id', 'idempotency_key', 'payment_request_id', 'artist_id',
  'transaction_type', 'direction', 'amount', 'currency', 'status',
  'provider', 'provider_transaction_id', 'webhook_event_id',
  'occurred_at', 'recorded_by', 'recorded_by_kind', 'safe_note_code',
  'created_at'
]) as c;

select hasnt_column('public', 'payment_webhook_events', 'payload',
                    'raw webhook payload is not stored');
select hasnt_column('public', 'payment_webhook_events', 'signature',
                    'webhook signature is not stored');
select hasnt_column('public', 'payment_webhook_events', 'secret',
                    'provider secret is not stored');
select hasnt_column('public', 'payment_transactions', 'updated_at',
                    'immutable transactions have no updated_at column');

select col_is_unique('public', 'payment_requests', 'idempotency_key',
                     'payment request idempotency is enforced');
select col_is_unique('public', 'payment_transactions', 'idempotency_key',
                     'payment transaction idempotency is enforced');
select col_is_unique(
  'public', 'payment_webhook_events', array['provider', 'provider_event_id'],
  'provider event id is globally idempotent within one provider'
);

-- ---------------------------------------------------------------------------
-- RLS and direct API privileges
-- ---------------------------------------------------------------------------

select ok(
  (select c.relrowsecurity and c.relforcerowsecurity
   from pg_class c where c.oid = 'public.artist_payment_policies'::regclass),
  'artist_payment_policies has enabled and forced RLS'
);
select ok(
  (select c.relrowsecurity and c.relforcerowsecurity
   from pg_class c where c.oid = 'public.payment_requests'::regclass),
  'payment_requests has enabled and forced RLS'
);
select ok(
  (select c.relrowsecurity and c.relforcerowsecurity
   from pg_class c where c.oid = 'public.payment_transactions'::regclass),
  'payment_transactions has enabled and forced RLS'
);
select ok(
  (select c.relrowsecurity and c.relforcerowsecurity
   from pg_class c where c.oid = 'public.payment_webhook_events'::regclass),
  'payment_webhook_events has enabled and forced RLS'
);

select ok(has_table_privilege('authenticated', 'public.payment_requests', 'SELECT'),
          'authenticated may read RLS-permitted payment requests');
select ok(not has_table_privilege('authenticated', 'public.payment_requests', 'INSERT'),
          'authenticated cannot directly create payment requests');
select ok(not has_table_privilege('authenticated', 'public.payment_requests', 'UPDATE'),
          'authenticated cannot directly mark a request paid');
select ok(has_table_privilege('authenticated', 'public.payment_transactions', 'SELECT'),
          'authenticated may read RLS-permitted immutable transactions');
select ok(not has_table_privilege('authenticated', 'public.payment_transactions', 'INSERT'),
          'authenticated cannot directly insert payment transactions');
select ok(not has_table_privilege('authenticated', 'public.payment_transactions', 'UPDATE'),
          'authenticated cannot update payment transactions');
select ok(not has_table_privilege('authenticated', 'public.payment_transactions', 'DELETE'),
          'authenticated cannot delete payment transactions');
select ok(not has_table_privilege('service_role', 'public.payment_requests', 'SELECT'),
          'service_role has no arbitrary payment request table access');
select ok(not has_table_privilege('service_role', 'public.payment_transactions', 'SELECT'),
          'service_role has no arbitrary ledger table access');

-- ---------------------------------------------------------------------------
-- Synthetic profiles and artist memberships
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('81111111-1111-4111-8111-111111111111', 'payment-owner@example.test'),
  ('82222222-2222-4222-8222-222222222222', 'kristina-finance@example.test'),
  ('83333333-3333-4333-8333-333333333333', 'kristina-no-finance@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('81111111-1111-4111-8111-111111111111', 'payment-owner@example.test', 'Payment Owner', 'owner', true),
  ('82222222-2222-4222-8222-222222222222', 'kristina-finance@example.test', 'Kristina Finance', 'booking_manager', true),
  ('83333333-3333-4333-8333-333333333333', 'kristina-no-finance@example.test', 'Kristina No Finance', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  (
    '82222222-2222-4222-8222-222222222222',
    'a2222222-2222-4222-8222-222222222222',
    'artist', true, true, true, false, true
  ),
  (
    '83333333-3333-4333-8333-333333333333',
    'a2222222-2222-4222-8222-222222222222',
    'artist', false, false, true, false, true
  );

-- ---------------------------------------------------------------------------
-- Synthetic clients, enquiries, projects and sessions for both artists
-- ---------------------------------------------------------------------------

insert into public.clients (id, full_name, email) values
  ('c1111111-1111-4111-8111-111111111111', 'Synthetic Vladimir Payer', 'vladimir-payer@example.test'),
  ('c2222222-2222-4222-8222-222222222222', 'Synthetic Kristina Payer', 'kristina-payer@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values
  (
    'e1111111-1111-4111-8111-111111111111',
    'c1111111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111',
    'PENDING', '51000000-0000-4000-8000-000000000001', repeat('1', 64),
    'accepted', 'complete', 'Synthetic Vladimir Payer',
    'vladimir-payer@example.test', '2026-07-29', now()
  ),
  (
    'e2222222-2222-4222-8222-222222222222',
    'c2222222-2222-4222-8222-222222222222',
    'a2222222-2222-4222-8222-222222222222',
    'PENDING', '52000000-0000-4000-8000-000000000002', repeat('2', 64),
    'accepted', 'complete', 'Synthetic Kristina Payer',
    'kristina-payer@example.test', '2026-07-29', now()
  );

insert into public.projects (
  id, client_id, enquiry_id, artist_id, title, status, currency
) values
  (
    'd1111111-1111-4111-8111-111111111111',
    'c1111111-1111-4111-8111-111111111111',
    'e1111111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111',
    'Synthetic Vladimir Payment Project', 'draft', 'GBP'
  ),
  (
    'd2222222-2222-4222-8222-222222222222',
    'c2222222-2222-4222-8222-222222222222',
    'e2222222-2222-4222-8222-222222222222',
    'a2222222-2222-4222-8222-222222222222',
    'Synthetic Kristina Payment Project', 'draft', 'GBP'
  );

insert into public.sessions (
  id, project_id, artist_id, status, start_at, end_at
) values
  (
    'f1111111-1111-4111-8111-111111111111',
    'd1111111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111',
    'proposed', now() + interval '30 days', now() + interval '30 days 7 hours'
  ),
  (
    'f2222222-2222-4222-8222-222222222222',
    'd2222222-2222-4222-8222-222222222222',
    'a2222222-2222-4222-8222-222222222222',
    'proposed', now() + interval '40 days', now() + interval '40 days 6 hours'
  );

-- ---------------------------------------------------------------------------
-- Versioned policy constraints
-- ---------------------------------------------------------------------------

insert into public.artist_payment_policies (
  id, artist_id, version, deposit_mode, fixed_amount,
  payment_deadline_hours, transfer_allowed, refund_policy_version,
  is_active, created_by
) values (
  '91111111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  1, 'fixed', 150.00, 72, true, 'v1', true,
  '81111111-1111-4111-8111-111111111111'
);

insert into public.artist_payment_policies (
  id, artist_id, version, deposit_mode, percentage,
  payment_deadline_hours, transfer_allowed, refund_policy_version,
  is_active, created_by
) values (
  '92222222-2222-4222-8222-222222222222',
  'a2222222-2222-4222-8222-222222222222',
  1, 'percentage', 20.00, 48, false, 'k-v1', true,
  '81111111-1111-4111-8111-111111111111'
);

select throws_ok(
  $$insert into public.artist_payment_policies (
      artist_id, version, deposit_mode, fixed_amount, percentage,
      refund_policy_version
    ) values (
      'a1111111-1111-4111-8111-111111111111',
      2, 'fixed', 100.00, 20.00, 'bad-v2'
    )$$,
  '23514', null,
  'one policy cannot contain both fixed and percentage values'
);

select throws_ok(
  $$insert into public.artist_payment_policies (
      artist_id, version, deposit_mode, fixed_amount,
      refund_policy_version, is_active
    ) values (
      'a1111111-1111-4111-8111-111111111111',
      2, 'fixed', 200.00, 'v2', true
    )$$,
  '23505', null,
  'one artist cannot have two active payment policy versions'
);

select throws_ok(
  $$update public.artist_payment_policies
    set fixed_amount = 175.00
    where id = '91111111-1111-4111-8111-111111111111'$$,
  '23514', null,
  'policy financial terms cannot be rewritten in place'
);

select lives_ok(
  $$update public.artist_payment_policies
    set is_active = false,
        effective_until = effective_from + interval '1 second'
    where id = '91111111-1111-4111-8111-111111111111'$$,
  'an active policy version may be closed without rewriting its terms'
);

select throws_ok(
  $$update public.artist_payment_policies
    set is_active = true
    where id = '91111111-1111-4111-8111-111111111111'$$,
  '23514', null,
  'a closed policy version cannot be reactivated'
);

-- ---------------------------------------------------------------------------
-- Payment requests and cross-artist consistency
-- ---------------------------------------------------------------------------

insert into public.payment_requests (
  id, idempotency_key, artist_id, client_id, project_id, session_id,
  purpose, amount, currency, policy_id, policy_version, policy_snapshot,
  expires_at, created_by
) values (
  'a8111111-1111-4111-8111-111111111111',
  '61000000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  'c1111111-1111-4111-8111-111111111111',
  'd1111111-1111-4111-8111-111111111111',
  'f1111111-1111-4111-8111-111111111111',
  'deposit', 200.00, 'GBP',
  '91111111-1111-4111-8111-111111111111', 1,
  '{"deposit_mode":"fixed","fixed_amount":150,"refund_policy_version":"v1"}'::jsonb,
  now() + interval '72 hours',
  '81111111-1111-4111-8111-111111111111'
);

insert into public.payment_requests (
  id, idempotency_key, artist_id, client_id, project_id,
  purpose, amount, currency, provider, provider_account_key,
  policy_id, policy_version, policy_snapshot, expires_at, created_by
) values (
  'a8222222-2222-4222-8222-222222222222',
  '62000000-0000-4000-8000-000000000002',
  'a2222222-2222-4222-8222-222222222222',
  'c2222222-2222-4222-8222-222222222222',
  'd2222222-2222-4222-8222-222222222222',
  'deposit', 300.00, 'GBP', 'stripe', 'kristina_staging',
  '92222222-2222-4222-8222-222222222222', 1,
  '{"deposit_mode":"percentage","percentage":20,"refund_policy_version":"k-v1"}'::jsonb,
  now() + interval '48 hours',
  '81111111-1111-4111-8111-111111111111'
);

insert into public.payment_requests (
  id, idempotency_key, artist_id, client_id, project_id,
  purpose, amount, currency, provider, provider_account_key,
  expires_at, created_by
) values (
  'a8333333-3333-4333-8333-333333333333',
  '63000000-0000-4000-8000-000000000003',
  'a1111111-1111-4111-8111-111111111111',
  'c1111111-1111-4111-8111-111111111111',
  'd1111111-1111-4111-8111-111111111111',
  'additional_payment', 100.00, 'GBP', 'stripe', 'vladimir_staging',
  now() + interval '24 hours',
  '81111111-1111-4111-8111-111111111111'
);

select is(
  (select status::text from public.payment_requests
   where id = 'a8111111-1111-4111-8111-111111111111'),
  'pending',
  'a new request starts pending without payment evidence'
);

select throws_ok(
  $$insert into public.payment_requests (
      idempotency_key, artist_id, client_id, project_id,
      purpose, amount, currency, created_by
    ) values (
      '64000000-0000-4000-8000-000000000004',
      'a1111111-1111-4111-8111-111111111111',
      'c2222222-2222-4222-8222-222222222222',
      'd2222222-2222-4222-8222-222222222222',
      'deposit', 100.00, 'GBP',
      '81111111-1111-4111-8111-111111111111'
    )$$,
  '23514', null,
  'a Vladimir request cannot reference a Kristina project'
);

select throws_ok(
  $$insert into public.payment_requests (
      idempotency_key, artist_id, client_id, project_id, session_id,
      purpose, amount, currency, created_by
    ) values (
      '65000000-0000-4000-8000-000000000005',
      'a1111111-1111-4111-8111-111111111111',
      'c1111111-1111-4111-8111-111111111111',
      'd1111111-1111-4111-8111-111111111111',
      'f2222222-2222-4222-8222-222222222222',
      'session_balance', 100.00, 'GBP',
      '81111111-1111-4111-8111-111111111111'
    )$$,
  '23514', null,
  'a payment request session must belong to its project and artist'
);

select throws_ok(
  $$insert into public.payment_requests (
      idempotency_key, artist_id, client_id, project_id,
      purpose, amount, currency, status, created_by
    ) values (
      '66000000-0000-4000-8000-000000000006',
      'a1111111-1111-4111-8111-111111111111',
      'c1111111-1111-4111-8111-111111111111',
      'd1111111-1111-4111-8111-111111111111',
      'deposit', 100.00, 'GBP', 'paid',
      '81111111-1111-4111-8111-111111111111'
    )$$,
  '23514', null,
  'a request cannot be inserted directly as paid'
);

select throws_ok(
  $$update public.payment_requests
    set status = 'paid'
    where id = 'a8111111-1111-4111-8111-111111111111'$$,
  '23514', null,
  'paid cannot be set without immutable succeeded transactions'
);

-- ---------------------------------------------------------------------------
-- Manual payments derive partial and paid states
-- ---------------------------------------------------------------------------

insert into public.payment_transactions (
  id, idempotency_key, payment_request_id, artist_id,
  transaction_type, direction, amount, currency, status,
  occurred_at, recorded_by, recorded_by_kind, safe_note_code
) values (
  '71111111-1111-4111-8111-111111111111',
  '71000000-0000-4000-8000-000000000001',
  'a8111111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'manual_payment', 'credit', 50.00, 'GBP', 'succeeded',
  now(), '81111111-1111-4111-8111-111111111111', 'human',
  'cash_received'
);

select is(
  (select status::text from public.payment_requests
   where id = 'a8111111-1111-4111-8111-111111111111'),
  'partially_paid',
  'a £50 succeeded manual payment makes a £200 request partially paid'
);
select is(
  crm_private.payment_request_net_paid('a8111111-1111-4111-8111-111111111111'),
  50.00::numeric,
  'net paid is calculated from succeeded immutable transactions'
);

select throws_ok(
  $$insert into public.payment_transactions (
      idempotency_key, payment_request_id, artist_id,
      transaction_type, direction, amount, currency, status,
      occurred_at, recorded_by, recorded_by_kind
    ) values (
      '71000000-0000-4000-8000-000000000001',
      'a8111111-1111-4111-8111-111111111111',
      'a1111111-1111-4111-8111-111111111111',
      'manual_payment', 'credit', 50.00, 'GBP', 'succeeded',
      now(), '81111111-1111-4111-8111-111111111111', 'human'
    )$$,
  '23505', null,
  'an exact manual-payment retry cannot create a duplicate transaction'
);

insert into public.payment_transactions (
  id, idempotency_key, payment_request_id, artist_id,
  transaction_type, direction, amount, currency, status,
  occurred_at, recorded_by, recorded_by_kind, safe_note_code
) values (
  '72222222-2222-4222-8222-222222222222',
  '72000000-0000-4000-8000-000000000002',
  'a8111111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'manual_payment', 'credit', 150.00, 'GBP', 'succeeded',
  now(), '81111111-1111-4111-8111-111111111111', 'human',
  'bank_transfer_received'
);

select is(
  (select status::text from public.payment_requests
   where id = 'a8111111-1111-4111-8111-111111111111'),
  'paid',
  'the second succeeded manual payment derives paid status'
);
select is(
  crm_private.payment_request_net_paid('a8111111-1111-4111-8111-111111111111'),
  200.00::numeric,
  'the ledger reaches exactly the requested amount'
);

select throws_ok(
  $$insert into public.payment_transactions (
      idempotency_key, payment_request_id, artist_id,
      transaction_type, direction, amount, currency, status,
      occurred_at, recorded_by, recorded_by_kind
    ) values (
      '73000000-0000-4000-8000-000000000003',
      'a8111111-1111-4111-8111-111111111111',
      'a1111111-1111-4111-8111-111111111111',
      'manual_payment', 'credit', 1.00, 'GBP', 'succeeded',
      now(), '81111111-1111-4111-8111-111111111111', 'human'
    )$$,
  '23514', null,
  'credits cannot overpay the requested amount'
);

select throws_ok(
  $$insert into public.payment_transactions (
      idempotency_key, payment_request_id, artist_id,
      transaction_type, direction, amount, currency, status,
      occurred_at, recorded_by, recorded_by_kind
    ) values (
      '74000000-0000-4000-8000-000000000004',
      'a8111111-1111-4111-8111-111111111111',
      'a1111111-1111-4111-8111-111111111111',
      'manual_payment', 'credit', 1.00, 'USD', 'succeeded',
      now(), '81111111-1111-4111-8111-111111111111', 'human'
    )$$,
  '23514', null,
  'transaction currency must match the request currency'
);

-- A failed immutable attempt does not alter the financial state.
insert into public.payment_transactions (
  idempotency_key, payment_request_id, artist_id,
  transaction_type, direction, amount, currency, status,
  occurred_at, recorded_by, recorded_by_kind, safe_note_code
) values (
  '75000000-0000-4000-8000-000000000005',
  'a8111111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'adjustment', 'credit', 10.00, 'GBP', 'failed',
  now(), '81111111-1111-4111-8111-111111111111', 'human',
  'failed_manual_adjustment'
);

select is(
  crm_private.payment_request_net_paid('a8111111-1111-4111-8111-111111111111'),
  200.00::numeric,
  'failed transactions have no ledger effect'
);

-- ---------------------------------------------------------------------------
-- Refunds append rows and cannot exceed settled funds
-- ---------------------------------------------------------------------------

insert into public.payment_transactions (
  idempotency_key, payment_request_id, artist_id,
  transaction_type, direction, amount, currency, status,
  occurred_at, recorded_by, recorded_by_kind, safe_note_code
) values (
  '76000000-0000-4000-8000-000000000006',
  'a8111111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'partial_refund', 'debit', 40.00, 'GBP', 'succeeded',
  now(), '81111111-1111-4111-8111-111111111111', 'human',
  'partial_refund_recorded'
);

select is(
  crm_private.payment_request_net_paid('a8111111-1111-4111-8111-111111111111'),
  160.00::numeric,
  'a partial refund reduces net settled funds without rewriting payments'
);
select is(
  (select status::text from public.payment_requests
   where id = 'a8111111-1111-4111-8111-111111111111'),
  'partially_paid',
  'refund recalculates request status from the ledger'
);

select throws_ok(
  $$insert into public.payment_transactions (
      idempotency_key, payment_request_id, artist_id,
      transaction_type, direction, amount, currency, status,
      occurred_at, recorded_by, recorded_by_kind
    ) values (
      '77000000-0000-4000-8000-000000000007',
      'a8111111-1111-4111-8111-111111111111',
      'a1111111-1111-4111-8111-111111111111',
      'partial_refund', 'debit', 160.00, 'GBP', 'succeeded',
      now(), '81111111-1111-4111-8111-111111111111', 'human'
    )$$,
  '23514', null,
  'a partial refund cannot equal the entire settled balance'
);

select throws_ok(
  $$insert into public.payment_transactions (
      idempotency_key, payment_request_id, artist_id,
      transaction_type, direction, amount, currency, status,
      occurred_at, recorded_by, recorded_by_kind
    ) values (
      '78000000-0000-4000-8000-000000000008',
      'a8111111-1111-4111-8111-111111111111',
      'a1111111-1111-4111-8111-111111111111',
      'refund', 'debit', 161.00, 'GBP', 'succeeded',
      now(), '81111111-1111-4111-8111-111111111111', 'human'
    )$$,
  '23514', null,
  'a refund cannot exceed the available settled balance'
);

insert into public.payment_transactions (
  idempotency_key, payment_request_id, artist_id,
  transaction_type, direction, amount, currency, status,
  occurred_at, recorded_by, recorded_by_kind, safe_note_code
) values (
  '79000000-0000-4000-8000-000000000009',
  'a8111111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'refund', 'debit', 160.00, 'GBP', 'succeeded',
  now(), '81111111-1111-4111-8111-111111111111', 'human',
  'full_refund_recorded'
);

select is(
  crm_private.payment_request_net_paid('a8111111-1111-4111-8111-111111111111'),
  0.00::numeric,
  'a full refund returns net paid to zero'
);
select is(
  (select status::text from public.payment_requests
   where id = 'a8111111-1111-4111-8111-111111111111'),
  'pending',
  'fully refunded request returns to ledger-derived pending status'
);

-- ---------------------------------------------------------------------------
-- Provider webhook and provider transaction idempotency
-- ---------------------------------------------------------------------------

insert into public.payment_webhook_events (
  id, artist_id, provider, provider_account_key, provider_event_id,
  processing_status, payload_sha256
) values (
  'b8111111-1111-4111-8111-111111111111',
  'a2222222-2222-4222-8222-222222222222',
  'stripe', 'kristina_staging', 'evt_synthetic_kristina_001',
  'received', repeat('a', 64)
);

select throws_ok(
  $$insert into public.payment_webhook_events (
      artist_id, provider, provider_account_key, provider_event_id,
      processing_status, payload_sha256
    ) values (
      'a2222222-2222-4222-8222-222222222222',
      'stripe', 'kristina_staging', 'evt_synthetic_kristina_001',
      'received', repeat('b', 64)
    )$$,
  '23505', null,
  'the same provider event cannot be inserted twice'
);

insert into public.payment_transactions (
  idempotency_key, payment_request_id, artist_id,
  transaction_type, direction, amount, currency, status,
  provider, provider_transaction_id, webhook_event_id,
  occurred_at, recorded_by_kind, safe_note_code
) values (
  '7a000000-0000-4000-8000-000000000010',
  'a8222222-2222-4222-8222-222222222222',
  'a2222222-2222-4222-8222-222222222222',
  'payment', 'credit', 300.00, 'GBP', 'succeeded',
  'stripe', 'pi_synthetic_kristina_001',
  'b8111111-1111-4111-8111-111111111111',
  now(), 'webhook', 'provider_payment_confirmed'
);

select is(
  (select status::text from public.payment_requests
   where id = 'a8222222-2222-4222-8222-222222222222'),
  'paid',
  'a confirmed provider transaction derives paid status'
);

select throws_ok(
  $$insert into public.payment_transactions (
      idempotency_key, payment_request_id, artist_id,
      transaction_type, direction, amount, currency, status,
      provider, provider_transaction_id, webhook_event_id,
      occurred_at, recorded_by_kind
    ) values (
      '7b000000-0000-4000-8000-000000000011',
      'a8222222-2222-4222-8222-222222222222',
      'a2222222-2222-4222-8222-222222222222',
      'payment', 'credit', 1.00, 'GBP', 'failed',
      'stripe', 'pi_synthetic_kristina_001',
      'b8111111-1111-4111-8111-111111111111',
      now(), 'webhook'
    )$$,
  '23505', null,
  'one provider transaction id cannot be recorded twice'
);

select throws_ok(
  $$insert into public.payment_transactions (
      idempotency_key, payment_request_id, artist_id,
      transaction_type, direction, amount, currency, status,
      provider, provider_transaction_id, webhook_event_id,
      occurred_at, recorded_by_kind
    ) values (
      '7c000000-0000-4000-8000-000000000012',
      'a8333333-3333-4333-8333-333333333333',
      'a1111111-1111-4111-8111-111111111111',
      'payment', 'credit', 100.00, 'GBP', 'succeeded',
      'stripe', 'pi_synthetic_wrong_artist_001',
      'b8111111-1111-4111-8111-111111111111',
      now(), 'webhook'
    )$$,
  '23514', null,
  'a Kristina webhook cannot fund a Vladimir request'
);

select lives_ok(
  $$update public.payment_webhook_events
    set processing_status = 'succeeded', processed_at = now()
    where id = 'b8111111-1111-4111-8111-111111111111'$$,
  'webhook processing metadata may be completed without changing its identity'
);

select throws_ok(
  $$update public.payment_webhook_events
    set provider_event_id = 'evt_rewritten'
    where id = 'b8111111-1111-4111-8111-111111111111'$$,
  '23514', null,
  'provider event identity cannot be rewritten'
);

-- ---------------------------------------------------------------------------
-- Transaction history is immutable even for a role that bypasses RLS
-- ---------------------------------------------------------------------------

select throws_ok(
  $$update public.payment_transactions
    set amount = 1.00
    where id = '71111111-1111-4111-8111-111111111111'$$,
  '42501', null,
  'an existing payment transaction cannot be updated'
);
select throws_ok(
  $$delete from public.payment_transactions
    where id = '71111111-1111-4111-8111-111111111111'$$,
  '42501', null,
  'an existing payment transaction cannot be deleted'
);
select throws_ok(
  $$truncate public.payment_transactions$$,
  '42501', null,
  'the immutable payment ledger cannot be truncated'
);

-- ---------------------------------------------------------------------------
-- Artist-scoped finance visibility and no browser writes
-- ---------------------------------------------------------------------------

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text)
  to anon, authenticated, service_role;

set local role authenticated;
select pg_temp.claims('{"sub":"81111111-1111-4111-8111-111111111111","role":"authenticated"}');
select is((select count(*)::int from public.payment_requests), 3,
          'owner sees payment requests for both artists');
select is((select count(*)::int from public.payment_transactions), 6,
          'owner sees all six immutable transactions for both artists');
select is((select count(*)::int from public.payment_webhook_events), 1,
          'owner sees provider event metadata for both artists');
select throws_ok(
  $$update public.payment_requests set status = 'paid'$$,
  '42501', null,
  'owner browser session cannot directly mark any request paid'
);
select throws_ok(
  $$insert into public.payment_transactions (
      idempotency_key, payment_request_id, artist_id,
      transaction_type, direction, amount, currency, status,
      occurred_at, recorded_by, recorded_by_kind
    ) values (
      '7d000000-0000-4000-8000-000000000013',
      'a8111111-1111-4111-8111-111111111111',
      'a1111111-1111-4111-8111-111111111111',
      'manual_payment', 'credit', 1.00, 'GBP', 'succeeded',
      now(), '81111111-1111-4111-8111-111111111111', 'human'
    )$$,
  '42501', null,
  'owner browser session cannot insert a payment transaction directly'
);
reset role;

set local role authenticated;
select pg_temp.claims('{"sub":"82222222-2222-4222-8222-222222222222","role":"authenticated"}');
select is((select count(*)::int from public.payment_requests), 1,
          'Kristina finance member sees only Kristina payment requests');
select ok(not exists (
            select 1 from public.payment_requests
            where artist_id = 'a1111111-1111-4111-8111-111111111111'),
          'Kristina cannot read Vladimir payment requests');
select is((select count(*)::int from public.payment_transactions), 1,
          'Kristina finance member sees only Kristina transactions');
select is((select count(*)::int from public.payment_webhook_events), 1,
          'Kristina finance manager sees her provider event metadata');
select throws_ok(
  $$update public.payment_webhook_events
    set processing_status = 'failed', processed_at = now()$$,
  '42501', null,
  'Kristina cannot bypass webhook workflows with a direct update'
);
reset role;

set local role authenticated;
select pg_temp.claims('{"sub":"83333333-3333-4333-8333-333333333333","role":"authenticated"}');
select is((select count(*)::int from public.artist_payment_policies), 0,
          'artist membership without finance permission sees no payment policy');
select is((select count(*)::int from public.payment_requests), 0,
          'artist membership without finance permission sees no payment request');
select is((select count(*)::int from public.payment_transactions), 0,
          'artist membership without finance permission sees no transaction');
select is((select count(*)::int from public.payment_webhook_events), 0,
          'artist membership without finance permission sees no webhook metadata');
reset role;

set local role anon;
select pg_temp.claims('{"role":"anon"}');
select throws_ok($$select count(*) from public.payment_requests$$, '42501', null,
  'anon cannot read payment requests');
select throws_ok($$select count(*) from public.payment_transactions$$, '42501', null,
  'anon cannot read the payment ledger');
reset role;

select * from finish(true);
rollback;
