-- 196_monzo_easy_bank_transfer_deposits.sql
-- Synthetic-only validation for the fixed GBP 250 Monzo deposit foundation.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('c6111111-1111-4111-8111-111111111111', 'monzo-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('c6111111-1111-4111-8111-111111111111', 'monzo-owner@example.test', 'Monzo Test Owner', 'owner', true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated, service_role;

insert into public.clients (id, full_name, email) values
  ('c6211111-1111-4111-8111-111111111111', 'Monzo Deposit Client', 'deposit@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'c6311111-1111-4111-8111-111111111111',
  'c6211111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'PENDING', 'c6411111-1111-4111-8111-111111111111', repeat('c', 64),
  'accepted', 'complete', 'Monzo Deposit Client', 'deposit@example.test',
  '2026-07-29', now()
);

insert into public.projects (id, client_id, enquiry_id, artist_id, title, status, currency) values (
  'c6511111-1111-4111-8111-111111111111',
  'c6211111-1111-4111-8111-111111111111',
  'c6311111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'Monzo Deposit Project', 'active', 'GBP'
);

insert into public.sessions (id, project_id, artist_id, status, start_at, end_at) values (
  'c6611111-1111-4111-8111-111111111111',
  'c6511111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'proposed',
  date_trunc('day', now()) + interval '20 days 10 hours',
  date_trunc('day', now()) + interval '20 days 17 hours'
);

set local role authenticated;
select pg_temp.claims('{"sub":"c6111111-1111-4111-8111-111111111111","role":"authenticated"}');

select throws_ok(
  $$select public.configure_monzo_easy_bank_transfer(
      'a1111111-1111-4111-8111-111111111111',
      'https://evil.example/pay/r/not-monzo', true
    )$$,
  '22023', 'Monzo Easy Bank Transfer URL is invalid',
  'payment setup rejects non-Monzo redirect destinations'
);

select lives_ok(
  $$select public.configure_monzo_easy_bank_transfer(
      'a1111111-1111-4111-8111-111111111111',
      'https://monzo.com/pay/r/synthetic-vladimir_250', true
    )$$,
  'owner configures an artist-scoped synthetic Monzo reusable link'
);

select is(
  (select fixed_amount from public.artist_payment_policies
   where artist_id = 'a1111111-1111-4111-8111-111111111111' and is_active),
  250.00::numeric,
  'Monzo setup activates a fixed GBP 250 deposit policy'
);

create temporary table first_request as
select public.request_session_deposit(
  'c6611111-1111-4111-8111-111111111111',
  'c6711111-1111-4111-8111-111111111111',
  'email'
) as result;
grant select on first_request to authenticated, service_role;

select is((select (result ->> 'amount')::numeric from first_request), 250::numeric,
  'the one-action deposit request is always GBP 250');
select like((select result ->> 'public_path' from first_request), '/pay-by-bank-transfer/%',
  'the client-facing path contains only the payment route and opaque id');
select is((select result ->> 'delivery_status' from first_request), 'queued_provider_not_connected',
  'email is queued honestly while no provider is connected');

select is(
  (select count(*)::int from public.integration_outbox
   where kind = 'transactional_email'
     and session_id = 'c6611111-1111-4111-8111-111111111111'),
  1,
  'one deposit email job is durably deduplicated'
);

create temporary table replay_request as
select public.request_session_deposit(
  'c6611111-1111-4111-8111-111111111111',
  'c6722222-2222-4222-8222-222222222222',
  'copy_link'
) as result;
grant select on replay_request to authenticated, service_role;

select is(
  (select result ->> 'payment_request_id' from replay_request),
  (select result ->> 'payment_request_id' from first_request),
  'a second action reuses the existing pending session deposit'
);
select is(
  (select count(*)::int from public.payment_request_links
   where payment_request_id = (select (result ->> 'payment_request_id')::uuid from first_request)),
  1,
  'the pending deposit has exactly one opaque public link'
);

select throws_ok(
  $$select public.request_session_deposit(
      'c6611111-1111-4111-8111-111111111111',
      'c6733333-3333-4333-8333-333333333333',
      'sms'
    )$$,
  '22023', 'SMS deposit delivery is not configured',
  'SMS remains fail-closed until a provider is deliberately chosen'
);

select throws_ok(
  format(
    'select public.resolve_monzo_deposit_redirect(%L::uuid)',
    (select l.public_id from public.payment_request_links l
     where l.payment_request_id = (select (result ->> 'payment_request_id')::uuid from first_request))
  ),
  '42501', null,
  'browser-authenticated staff cannot call the backend redirect resolver'
);

reset role;
select pg_temp.claims('{"role":"service_role"}');
set local role service_role;

select is(
  public.resolve_monzo_deposit_redirect(
    (select l.public_id from public.payment_request_links l
     where l.payment_request_id = (select (result ->> 'payment_request_id')::uuid from first_request))
  ),
  'https://monzo.com/pay/r/synthetic-vladimir_250',
  'service backend resolves only the configured Monzo reusable link'
);

reset role;
select is(
  (select status::text from public.payment_requests
   where id = (select (result ->> 'payment_request_id')::uuid from first_request)),
  'pending',
  'opening the personal link does not mark the deposit paid'
);
select is(
  (select count(*)::int from public.payment_transactions
   where payment_request_id = (select (result ->> 'payment_request_id')::uuid from first_request)),
  0,
  'opening the personal link creates no payment ledger entry'
);

select pg_temp.claims('{"role":"service_role"}');
set local role service_role;
create temporary table candidate as
select public.register_monzo_reconciliation_candidate(
  'monzo_ebt_a1111111111141118111111111111111',
  'evt_synthetic_001', 'tx_synthetic_001', 250.00, 'GBP', now()
) as result;
grant select on candidate to service_role;
select is((select result ->> 'status' from candidate), 'candidate',
  'one matching verified transaction is only a reconciliation candidate');

reset role;
select is(
  (select status::text from public.payment_requests
   where id = (select (result ->> 'payment_request_id')::uuid from first_request)),
  'pending',
  'Monzo reconciliation candidate registration still does not settle the request'
);
select is(
  (select count(*)::int from public.payment_transactions
   where payment_request_id = (select (result ->> 'payment_request_id')::uuid from first_request)),
  0,
  'Monzo reconciliation creates no immutable payment transaction automatically'
);
select ok(
  not has_table_privilege('authenticated', 'public.payment_request_links', 'select')
  and not has_table_privilege('authenticated', 'public.payment_reconciliation_candidates', 'select'),
  'new payment infrastructure tables have no direct browser read grant'
);

select * from finish();
rollback;
