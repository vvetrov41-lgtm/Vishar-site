-- 261_manual_project_deposit_confirmation.sql
-- Provider-neutral manual deposit confirmation must settle the immutable ledger
-- without inventing a bank/provider payment or weakening finance permissions.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated, service_role;

create function pg_temp.as_owner() returns void language sql as $$
  select pg_temp.claims('{"sub":"fa111111-1111-4111-8111-111111111111","role":"authenticated"}');
$$;
grant execute on function pg_temp.as_owner() to authenticated, service_role;

create function pg_temp.as_no_finance() returns void language sql as $$
  select pg_temp.claims('{"sub":"fa222222-2222-4222-8222-222222222222","role":"authenticated"}');
$$;
grant execute on function pg_temp.as_no_finance() to authenticated, service_role;

insert into auth.users (id, email) values
  ('fa111111-1111-4111-8111-111111111111', 'manual-deposit-owner@example.test'),
  ('fa222222-2222-4222-8222-222222222222', 'manual-deposit-no-finance@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('fa111111-1111-4111-8111-111111111111', 'manual-deposit-owner@example.test',
   'Manual Deposit Owner', 'owner', true),
  ('fa222222-2222-4222-8222-222222222222', 'manual-deposit-no-finance@example.test',
   'Manual Deposit Manager', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values (
  'fa222222-2222-4222-8222-222222222222',
  'a1111111-1111-4111-8111-111111111111',
  'manager', false, false, true, false, true
)
on conflict do nothing;

insert into public.clients (id, full_name, email) values
  ('fa311111-1111-4111-8111-111111111111', 'Manual Deposit Client', null);

insert into public.projects (
  id, client_id, artist_id, title, status, currency,
  estimated_sessions, estimated_hours, hourly_rate, estimate_total
) values
  ('fa411111-1111-4111-8111-111111111111',
   'fa311111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'Manual Deposit Project', 'active', 'GBP', 2, 8.00, 250.00, 2000.00),
  ('fa422222-2222-4222-8222-222222222222',
   'fa311111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'No Finance Manual Deposit Project', 'active', 'GBP', 1, 4.00, 250.00, 1000.00);

set local role authenticated;
select pg_temp.as_owner();

select lives_ok(
  $$select public.configure_project_deposit_policy(
      'a1111111-1111-4111-8111-111111111111',
      'fixed', 500.00, null, null, 1.00)$$,
  'owner configures a fixed project deposit without configuring a provider route'
);

select lives_ok(
  $$select public.confirm_project_deposit_manually(
      'fa411111-1111-4111-8111-111111111111',
      'fa511111-1111-4111-8111-111111111111',
      '2026-08-30 19:30:00+00'::timestamptz)$$,
  'finance authority may confirm a deposit manually without a provider payment'
);

-- State inspection is deliberately privileged test-only readback. The browser
-- role has no direct finance-table access; only the RPC above is user-callable.
reset role;

select is(
  (select r.status::text
   from public.payment_requests r
   where r.project_id = 'fa411111-1111-4111-8111-111111111111'
     and r.purpose = 'deposit' and r.session_id is null),
  'paid',
  'the immutable ledger advances the payment request to paid'
);

select is(
  (select p.deposit_status::text
   from public.projects p
   where p.id = 'fa411111-1111-4111-8111-111111111111'),
  'paid',
  'the ordinary ledger trigger advances the project deposit status to paid'
);

select is(
  (select p.deposit_amount
   from public.projects p
   where p.id = 'fa411111-1111-4111-8111-111111111111'),
  500.00::numeric,
  'the project carries the server-calculated deposit amount'
);

select is(
  (select r.amount
   from public.payment_requests r
   where r.project_id = 'fa411111-1111-4111-8111-111111111111'
     and r.purpose = 'deposit' and r.session_id is null),
  500.00::numeric,
  'the caller never supplies the amount; the project policy remains authoritative'
);

select ok(
  (select r.provider is null and r.provider_account_key is null
   from public.payment_requests r
   where r.project_id = 'fa411111-1111-4111-8111-111111111111'
     and r.purpose = 'deposit' and r.session_id is null),
  'a manually confirmed deposit request has no provider identity'
);

select is(
  (select count(*)::integer
   from public.payment_request_links l
   join public.payment_requests r on r.id = l.payment_request_id
   where r.project_id = 'fa411111-1111-4111-8111-111111111111'
     and r.purpose = 'deposit' and r.session_id is null),
  0,
  'manual confirmation creates no client payment link'
);

select is(
  (select count(*)::integer
   from public.payment_request_payment_destinations d
   join public.payment_requests r on r.id = d.payment_request_id
   where r.project_id = 'fa411111-1111-4111-8111-111111111111'
     and r.purpose = 'deposit' and r.session_id is null),
  0,
  'manual confirmation binds no Monzo payment destination'
);

select is(
  (select t.transaction_type::text
   from public.payment_transactions t
   join public.payment_requests r on r.id = t.payment_request_id
   where r.project_id = 'fa411111-1111-4111-8111-111111111111'
     and t.status = 'succeeded'),
  'manual_payment',
  'settlement is explicitly classified as a manual payment'
);

select ok(
  (select t.provider is null
          and t.provider_transaction_id is null
          and t.webhook_event_id is null
   from public.payment_transactions t
   join public.payment_requests r on r.id = t.payment_request_id
   where r.project_id = 'fa411111-1111-4111-8111-111111111111'
     and t.status = 'succeeded'),
  'manual settlement cannot pretend to be a provider transaction or webhook'
);

select ok(
  (select t.recorded_by = 'fa111111-1111-4111-8111-111111111111'::uuid
          and t.recorded_by_kind = 'human'
          and t.safe_note_code = 'crm_manual_project_deposit'
   from public.payment_transactions t
   join public.payment_requests r on r.id = t.payment_request_id
   where r.project_id = 'fa411111-1111-4111-8111-111111111111'
     and t.status = 'succeeded'),
  'the immutable transaction records the human operator and safe manual source'
);

-- Replay through the same authenticated boundary, then return to privileged
-- readback so the test never relies on direct finance-table browser grants.
set local role authenticated;
select pg_temp.as_owner();
select is(
  (public.confirm_project_deposit_manually(
      'fa411111-1111-4111-8111-111111111111',
      'fa511111-1111-4111-8111-111111111111',
      '2026-08-30 19:30:00+00'::timestamptz) ->> 'replayed')::boolean,
  true,
  'the same operation idempotency key replays instead of crediting twice'
);
reset role;

select is(
  (select count(*)::integer
   from public.payment_transactions t
   join public.payment_requests r on r.id = t.payment_request_id
   where r.project_id = 'fa411111-1111-4111-8111-111111111111'
     and t.transaction_type = 'manual_payment'),
  1,
  'idempotent replay leaves exactly one manual transaction'
);

select is(
  (select count(*)::integer
   from public.payment_requests r
   where r.project_id = 'fa411111-1111-4111-8111-111111111111'
     and r.purpose = 'deposit' and r.session_id is null),
  1,
  'idempotent replay leaves exactly one project deposit request'
);

select is(
  (select count(*)::integer
   from public.integration_outbox o
   where o.project_id = 'fa411111-1111-4111-8111-111111111111'
     and o.kind = 'transactional_email'
     and o.dedupe_key like 'project_deposit_email:%'),
  0,
  'manual confirmation never queues the ordinary deposit-request email/link workflow'
);

select is(
  (select count(*)::integer
   from public.activity_log a
   where a.project_id = 'fa411111-1111-4111-8111-111111111111'
     and a.event_type = 'payment.project_deposit_manually_confirmed'),
  1,
  'the project audit log records the specific manual confirmation action'
);

set local role authenticated;
select pg_temp.as_no_finance();

select throws_ok(
  $$select public.confirm_project_deposit_manually(
      'fa422222-2222-4222-8222-222222222222',
      'fa522222-2222-4222-8222-222222222222',
      now())$$,
  '42501', null,
  'a manager without manage_finance cannot manually confirm a project deposit'
);

reset role;
select * from finish();
rollback;
