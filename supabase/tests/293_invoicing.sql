-- 293_invoicing.sql
--
-- Migrations 20260920120000 and 20260920121000: invoices, line items, credit
-- notes, and the nullable link from the existing payment ledger.
--
-- The arithmetic is checked against the case the product was specified from:
-- seven hours at £140 is £980, a £250 deposit leaves £730 outstanding, and a
-- £140 credit note on a £980 invoice corrects it to £840.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Schema surface
-- ---------------------------------------------------------------------------

select has_type('public', 'invoice_status', 'invoice_status exists');
select enum_has_labels(
  'public', 'invoice_status',
  array['draft', 'issued', 'partially_paid', 'paid', 'void'],
  'invoice status covers the draft, issued, part paid, paid and void states'
);

select has_table('public', 'invoices', 'invoices exists');
select has_table('public', 'invoice_line_items', 'invoice_line_items exists');
select has_table('public', 'credit_notes', 'credit_notes exists');

select has_column('public', 'invoices', c, 'invoices.' || c || ' exists')
from unnest(array[
  'id', 'idempotency_key', 'artist_id', 'client_id', 'project_id', 'invoice_number', 'status',
  'currency', 'discount_amount', 'issue_date', 'due_date', 'notes',
  'issued_at', 'voided_at', 'void_reason', 'created_by', 'created_at', 'updated_at'
]) as c;

select has_column('public', 'invoice_line_items', c,
                  'invoice_line_items.' || c || ' exists')
from unnest(array[
  'id', 'invoice_id', 'artist_id', 'session_id', 'line_position',
  'description', 'quantity', 'unit_amount', 'line_total'
]) as c;

select has_column('public', 'credit_notes', c, 'credit_notes.' || c || ' exists')
from unnest(array[
  'id', 'idempotency_key', 'invoice_id', 'artist_id', 'credit_note_number',
  'amount', 'reason', 'issued_at'
]) as c;

-- The link that keeps every historical deposit working untouched.
select has_column('public', 'payment_requests', 'invoice_id',
                  'payment_requests carries the optional invoice link');
select col_is_null('public', 'payment_requests', 'invoice_id',
                   'the invoice link is nullable, so existing payments need no backfill');
select has_column('public', 'payment_requests', 'payment_method_code',
                  'payment_requests records how a payment arrived');
select has_column('public', 'payment_requests', 'external_reference',
                  'payment_requests records the provider reference');

-- ---------------------------------------------------------------------------
-- Privileges: reads only, writes through RPCs
-- ---------------------------------------------------------------------------

select ok(
  (select bool_and(relrowsecurity and relforcerowsecurity)
   from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in ('invoices', 'invoice_line_items', 'credit_notes')),
  'every invoicing table has enabled and forced RLS'
);

select ok(has_table_privilege('authenticated', 'public.' || t, 'SELECT'),
          'authenticated may read RLS-permitted ' || t)
from unnest(array['invoices', 'invoice_line_items', 'credit_notes']) as t;

select ok(not has_table_privilege('authenticated', 'public.' || t, p),
          'authenticated cannot ' || lower(p) || ' ' || t || ' directly')
from unnest(array['invoices', 'invoice_line_items', 'credit_notes']) as t,
     unnest(array['INSERT', 'UPDATE', 'DELETE']) as p;

select ok(not has_table_privilege('anon', 'public.' || t, 'SELECT'),
          'anon has no access to ' || t)
from unnest(array['invoices', 'invoice_line_items', 'credit_notes']) as t;

select ok(not has_table_privilege('service_role', 'public.invoices', 'SELECT'),
          'service_role has no arbitrary invoice table access');

select ok(not has_function_privilege('anon', 'public.get_invoice(uuid)', 'EXECUTE'),
          'anon cannot read an invoice through the RPC either');

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('91111111-1111-4111-8111-111111111111', 'invoice-owner@example.test'),
  ('92222222-2222-4222-8222-222222222222', 'invoice-kristina-finance@example.test'),
  ('93333333-3333-4333-8333-333333333333', 'invoice-kristina-plain@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('91111111-1111-4111-8111-111111111111', 'invoice-owner@example.test', 'Invoice Owner', 'owner', true),
  ('92222222-2222-4222-8222-222222222222', 'invoice-kristina-finance@example.test', 'Kristina Finance', 'booking_manager', true),
  ('93333333-3333-4333-8333-333333333333', 'invoice-kristina-plain@example.test', 'Kristina Plain', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance, can_manage_sessions, can_manage_integrations, is_active
) values
  ('92222222-2222-4222-8222-222222222222', 'a2222222-2222-4222-8222-222222222222',
   'artist', true, true, true, false, true),
  ('93333333-3333-4333-8333-333333333333', 'a2222222-2222-4222-8222-222222222222',
   'artist', false, false, true, false, true);

insert into public.clients (id, full_name, email) values
  ('c9111111-1111-4111-8111-111111111111', 'Simon Invoice', 'simon-invoice@example.test'),
  ('c9222222-2222-4222-8222-222222222222', 'Kristina Invoice Client', 'kristina-invoice@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values
  ('e9111111-1111-4111-8111-111111111111', 'c9111111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'PENDING',
   '59000000-0000-4000-8000-000000000001', repeat('9', 64),
   'accepted', 'complete', 'Simon Invoice', 'simon-invoice@example.test', '2026-07-29', now()),
  ('e9222222-2222-4222-8222-222222222222', 'c9222222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222', 'PENDING',
   '59000000-0000-4000-8000-000000000002', repeat('8', 64),
   'accepted', 'complete', 'Kristina Invoice Client', 'kristina-invoice@example.test', '2026-07-29', now());

insert into public.projects (id, client_id, enquiry_id, artist_id, title, status, currency) values
  ('d9111111-1111-4111-8111-111111111111', 'c9111111-1111-4111-8111-111111111111',
   'e9111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'Simon sleeve', 'active', 'GBP'),
  ('d9222222-2222-4222-8222-222222222222', 'c9222222-2222-4222-8222-222222222222',
   'e9222222-2222-4222-8222-222222222222', 'a2222222-2222-4222-8222-222222222222',
   'Kristina piece', 'active', 'GBP');

insert into public.sessions (id, project_id, artist_id, status, start_at, end_at) values
  ('f9111111-1111-4111-8111-111111111111', 'd9111111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'confirmed',
   date_trunc('hour', now()) + interval '20 days',
   date_trunc('hour', now()) + interval '20 days 7 hours');

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- A draft invoice, priced from line items
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"91111111-1111-4111-8111-111111111111","role":"authenticated"}');

select lives_ok(
  $$select public.create_invoice(
      'd9111111-1111-4111-8111-111111111111',
      '60000000-0000-4000-8000-000000000001'
    )$$,
  'the owner can open a draft invoice on their own project'
);

select is(
  (select count(*)::int from public.invoices
   where project_id = 'd9111111-1111-4111-8111-111111111111'),
  1,
  'exactly one invoice exists for the project'
);

select is(
  (select status::text from public.invoices
   where project_id = 'd9111111-1111-4111-8111-111111111111'),
  'draft',
  'a new invoice starts as a draft'
);

select ok(
  (select invoice_number ~ '^INV-[0-9]{4}-[0-9]{5}$' from public.invoices
   where project_id = 'd9111111-1111-4111-8111-111111111111'),
  'the invoice carries a human-readable number'
);

-- The same request twice returns the same document rather than a second one.
select is(
  ((select public.create_invoice(
      'd9111111-1111-4111-8111-111111111111',
      '60000000-0000-4000-8000-000000000001'
    )) ->> 'replayed'),
  'true',
  'the same invoice request replays the document it already created'
);

select throws_ok(
  $$select public.create_invoice(
      'd9111111-1111-4111-8111-111111111111',
      '60000000-0000-4000-8000-000000000001',
      current_date + 7
    )$$,
  '22023', null,
  'an invoice idempotency key cannot be reused for different terms'
);

select lives_ok(
  $$select public.set_invoice_line_item(
      (select id from public.invoices where project_id = 'd9111111-1111-4111-8111-111111111111'),
      'Tattoo session', 7, 140,
      null, 'f9111111-1111-4111-8111-111111111111'
    )$$,
  'a line item can cite the session it charges for'
);

select is(
  (select line_total from public.invoice_line_items
   where description = 'Tattoo session'),
  980.00::numeric(12,2),
  'seven hours at 140 is 980, computed by the column rather than the caller'
);

select throws_ok(
  $$select public.set_invoice_line_item(
      (select id from public.invoices where project_id = 'd9111111-1111-4111-8111-111111111111'),
      'Negative work', 1, -50
    )$$,
  '22023', null,
  'a negative unit price is refused'
);

select throws_ok(
  $$select public.set_invoice_line_item(
      (select id from public.invoices where project_id = 'd9111111-1111-4111-8111-111111111111'),
      'No hours', 0, 140
    )$$,
  '22023', null,
  'a zero quantity is refused'
);

-- ---------------------------------------------------------------------------
-- Issue, then the deposit already taken
-- ---------------------------------------------------------------------------

select lives_ok(
  $$select public.issue_invoice(
      (select id from public.invoices where project_id = 'd9111111-1111-4111-8111-111111111111')
    )$$,
  'a priced draft can be issued'
);

select is(
  (select status::text from public.invoices
   where project_id = 'd9111111-1111-4111-8111-111111111111'),
  'issued',
  'an issued invoice with nothing paid reads as issued'
);

select throws_ok(
  $$select public.set_invoice_line_item(
      (select id from public.invoices where project_id = 'd9111111-1111-4111-8111-111111111111'),
      'Late addition', 1, 100
    )$$,
  '42501', null,
  'an issued invoice cannot gain a line item'
);

reset role;

-- A deposit taken before the invoice existed, exactly as the CRM takes one
-- today: a payment request with no invoice link and a settled transaction.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.payment_requests (
  id, idempotency_key, artist_id, client_id, project_id,
  purpose, amount, currency
) values (
  'a9111111-1111-4111-8111-111111111111',
  '61000000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  'c9111111-1111-4111-8111-111111111111',
  'd9111111-1111-4111-8111-111111111111',
  'deposit', 250.00, 'GBP'
);

insert into public.payment_transactions (
  idempotency_key, payment_request_id, artist_id,
  transaction_type, direction, amount, currency, status,
  occurred_at, recorded_by, recorded_by_kind
) values (
  '62000000-0000-4000-8000-000000000001',
  'a9111111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'manual_payment', 'credit', 250.00, 'GBP', 'succeeded',
  now(), '91111111-1111-4111-8111-111111111111', 'human'
);

select is(
  (select invoice_id from public.payment_requests
   where id = 'a9111111-1111-4111-8111-111111111111'),
  null,
  'a deposit taken the old way still has no invoice, and still works'
);

set local role authenticated;
select pg_temp.claims('{"sub":"91111111-1111-4111-8111-111111111111","role":"authenticated"}');

select lives_ok(
  $$select public.attach_payment_request_to_invoice(
      'a9111111-1111-4111-8111-111111111111',
      (select id from public.invoices where project_id = 'd9111111-1111-4111-8111-111111111111')
    )$$,
  'the deposit already taken can be counted towards the invoice'
);

select is(
  (((select public.get_invoice(id) from public.invoices
     where project_id = 'd9111111-1111-4111-8111-111111111111') -> 'invoice') ->> 'amount_outstanding'),
  '730.00',
  'a 980 invoice with a 250 deposit still asks for 730'
);

select is(
  (select status::text from public.invoices
   where project_id = 'd9111111-1111-4111-8111-111111111111'),
  'partially_paid',
  'the invoice reads as part paid once the deposit counts'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.payment_requests (
  id, idempotency_key, artist_id, client_id, project_id,
  purpose, amount, currency
) values (
  'a9444444-4444-4444-8444-444444444444',
  '61000000-0000-4000-8000-000000000004',
  'a1111111-1111-4111-8111-111111111111',
  'c9111111-1111-4111-8111-111111111111',
  'd9111111-1111-4111-8111-111111111111',
  'additional_payment', 900.00, 'GBP'
);

set local role authenticated;
select pg_temp.claims('{"sub":"91111111-1111-4111-8111-111111111111","role":"authenticated"}');

select throws_ok(
  $$select public.attach_payment_request_to_invoice(
      'a9444444-4444-4444-8444-444444444444',
      (select id from public.invoices where project_id = 'd9111111-1111-4111-8111-111111111111')
    )$$,
  '23514', null,
  'a request whose face value exceeds the remaining invoice balance cannot be attached'
);

select throws_ok(
  $$select public.record_invoice_payment(
      (select id from public.invoices where project_id = 'd9111111-1111-4111-8111-111111111111'),
      '63000000-0000-4000-8000-000000000009', 900
    )$$,
  '23514', null,
  'a payment larger than the balance is refused rather than double counted'
);

select throws_ok(
  $$select public.record_invoice_payment(
      (select id from public.invoices where project_id = 'd9111111-1111-4111-8111-111111111111'),
      '63000000-0000-4000-8000-000000000008', -10
    )$$,
  '22023', null,
  'a negative payment is refused'
);

select lives_ok(
  $$select public.record_invoice_payment(
      (select id from public.invoices where project_id = 'd9111111-1111-4111-8111-111111111111'),
      '63000000-0000-4000-8000-000000000001', 730,
      now(), 'bank_transfer', 'MONZO-REF-1'
    )$$,
  'the balance can be settled'
);

select is(
  (select status::text from public.invoices
   where project_id = 'd9111111-1111-4111-8111-111111111111'),
  'paid',
  'a fully settled invoice reads as paid'
);

select is(
  ((select public.record_invoice_payment(
      (select id from public.invoices where project_id = 'd9111111-1111-4111-8111-111111111111'),
      '63000000-0000-4000-8000-000000000001', 730
    )) ->> 'replayed'),
  'true',
  'the same payment sent twice is recognised as one payment'
);

select is(
  (select count(*)::int from public.payment_transactions t
   join public.payment_requests r on r.id = t.payment_request_id
   where r.invoice_id = (select id from public.invoices
                         where project_id = 'd9111111-1111-4111-8111-111111111111')),
  2,
  'the replay added no second transaction'
);

select throws_ok(
  $$select public.void_invoice(
      (select id from public.invoices where project_id = 'd9111111-1111-4111-8111-111111111111'),
      'Mistake'
    )$$,
  '42501', null,
  'an invoice with settled money cannot be voided away'
);

-- ---------------------------------------------------------------------------
-- Credit notes correct without deleting
-- ---------------------------------------------------------------------------

select lives_ok(
  $$select public.create_invoice(
      'd9111111-1111-4111-8111-111111111111',
      '60000000-0000-4000-8000-000000000003',
      null, 'Second piece'
    )$$,
  'a second invoice can be opened on the same project'
);

select lives_ok(
  $$select public.set_invoice_line_item(
      (select id from public.invoices where notes = 'Second piece'),
      'Tattoo session', 7, 140
    )$$,
  'the second invoice is priced the same way'
);

select lives_ok(
  $$select public.issue_invoice((select id from public.invoices where notes = 'Second piece'))$$,
  'the second invoice can be issued'
);

select throws_ok(
  $$select public.create_credit_note(
      (select id from public.invoices where notes = 'Second piece'),
      '64000000-0000-4000-8000-000000000009', 1200, 'Too much'
    )$$,
  '23514', null,
  'a credit note cannot exceed what the invoice asks for'
);

select lives_ok(
  $$select public.create_credit_note(
      (select id from public.invoices where notes = 'Second piece'),
      '64000000-0000-4000-8000-000000000001', 140, 'One hour shorter than quoted'
    )$$,
  'a partial credit note can be issued'
);

select is(
  (((select public.get_invoice(id) from public.invoices where notes = 'Second piece')
    -> 'invoice') ->> 'amount_outstanding'),
  '840.00',
  'a 140 credit note corrects a 980 invoice to 840'
);

select is(
  (((select public.get_invoice(id) from public.invoices where notes = 'Second piece')
    -> 'invoice') ->> 'total'),
  '980.00',
  'the original invoice total stays visible after the correction'
);

select ok(
  (select credit_note_number ~ '^CN-[0-9]{4}-[0-9]{5}$' from public.credit_notes),
  'the credit note carries its own number'
);

select is(
  (select reason from public.credit_notes),
  'One hour shorter than quoted',
  'the credit note records why'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok(
  $$update public.credit_notes set amount = 1$$,
  '42501', null,
  'a credit note cannot be edited after the fact'
);
select throws_ok(
  $$delete from public.credit_notes$$,
  '42501', null,
  'a credit note cannot be deleted'
);

-- ---------------------------------------------------------------------------
-- Void is terminal
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"91111111-1111-4111-8111-111111111111","role":"authenticated"}');

select lives_ok(
  $$select public.create_invoice(
      'd9111111-1111-4111-8111-111111111111',
      '60000000-0000-4000-8000-000000000004',
      null, 'Raised in error'
    )$$,
  'a third invoice can be opened'
);

select throws_ok(
  $$select public.void_invoice(
      (select id from public.invoices where notes = 'Raised in error'), '  '
    )$$,
  '22023', null,
  'voiding without a reason is refused'
);

select lives_ok(
  $$select public.void_invoice(
      (select id from public.invoices where notes = 'Raised in error'),
      'Raised against the wrong project'
    )$$,
  'an unpaid invoice can be voided with a reason'
);

select is(
  (select status::text from public.invoices where notes = 'Raised in error'),
  'void',
  'the voided invoice reads as void'
);

select throws_ok(
  $$select public.issue_invoice(
      (select id from public.invoices where notes = 'Raised in error')
    )$$,
  '42501', null,
  'a void invoice cannot be issued afterwards'
);

select throws_ok(
  $$select public.record_invoice_payment(
      (select id from public.invoices where notes = 'Raised in error'),
      '63000000-0000-4000-8000-000000000007', 10
    )$$,
  '42501', null,
  'a void invoice cannot take a payment'
);

-- ---------------------------------------------------------------------------
-- A void invoice can never end up holding money
--
-- The path Codex found on PR 818: attach a request while it is still pending,
-- void the invoice while nothing has settled, then let the payment arrive.
-- ---------------------------------------------------------------------------

select lives_ok(
  $$select public.create_invoice(
      'd9111111-1111-4111-8111-111111111111',
      '60000000-0000-4000-8000-000000000006',
      null, 'Open request'
    )$$,
  'a fourth invoice can be opened'
);
select lives_ok(
  $$select public.set_invoice_line_item(
      (select id from public.invoices where notes = 'Open request'),
      'Tattoo session', 1, 200
    )$$,
  'and priced'
);
select lives_ok(
  $$select public.issue_invoice((select id from public.invoices where notes = 'Open request'))$$,
  'and issued'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- A deposit request that has been asked for but not paid.
insert into public.payment_requests (
  id, idempotency_key, artist_id, client_id, project_id,
  purpose, amount, currency
) values (
  'a9333333-3333-4333-8333-333333333333',
  '61000000-0000-4000-8000-000000000003',
  'a1111111-1111-4111-8111-111111111111',
  'c9111111-1111-4111-8111-111111111111',
  'd9111111-1111-4111-8111-111111111111',
  'deposit', 200.00, 'GBP'
);

set local role authenticated;
select pg_temp.claims('{"sub":"91111111-1111-4111-8111-111111111111","role":"authenticated"}');

select lives_ok(
  $$select public.attach_payment_request_to_invoice(
      'a9333333-3333-4333-8333-333333333333',
      (select id from public.invoices where notes = 'Open request')
    )$$,
  'a request that has not settled yet can still be attached'
);

select throws_ok(
  $$select public.void_invoice(
      (select id from public.invoices where notes = 'Open request'),
      'Changed my mind'
    )$$,
  '42501', null,
  'an invoice with an open payment request cannot be voided'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Force the invoice void behind the RPC's back, so the ledger guard is tested
-- on its own rather than only through the door that already refuses.
update public.invoices
set voided_at = now(), void_reason = 'Forced for the test', status = 'void'
where notes = 'Open request';

select throws_ok(
  $$insert into public.payment_transactions (
      idempotency_key, payment_request_id, artist_id,
      transaction_type, direction, amount, currency, status,
      occurred_at, recorded_by, recorded_by_kind
    ) values (
      '62000000-0000-4000-8000-000000000003',
      'a9333333-3333-4333-8333-333333333333',
      'a1111111-1111-4111-8111-111111111111',
      'manual_payment', 'credit', 200.00, 'GBP', 'succeeded',
      now(), '91111111-1111-4111-8111-111111111111', 'human'
    )$$,
  '42501', null,
  'a payment cannot settle against a void invoice'
);

select is(
  (select count(*)::int from public.payment_transactions t
   join public.payment_requests r on r.id = t.payment_request_id
   where r.invoice_id = (select id from public.invoices where notes = 'Open request')),
  0,
  'the void invoice holds no money'
);

-- ---------------------------------------------------------------------------
-- Vladimir and Kristina stay apart
-- ---------------------------------------------------------------------------

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- The other artist's real invoice id, held outside `public.invoices` so the
-- probe below is a genuine "guess the id in the URL" rather than a lookup that
-- row level security had already emptied.
create temporary table vladimir_invoice_ids as
select id, notes from public.invoices
where artist_id = 'a1111111-1111-4111-8111-111111111111';
grant select on vladimir_invoice_ids to authenticated, anon;

set local role authenticated;
select pg_temp.claims('{"sub":"92222222-2222-4222-8222-222222222222","role":"authenticated"}');

select throws_ok(
  $$select public.create_invoice(
      'd9111111-1111-4111-8111-111111111111',
      '60000000-0000-4000-8000-000000000005'
    )$$,
  '42501', null,
  'a finance manager on Kristina cannot raise an invoice on a Vladimir project'
);

select throws_ok(
  $$select public.get_invoice(
      (select id from vladimir_invoice_ids where notes = 'Second piece')
    )$$,
  '42501', null,
  'changing the id in the URL does not open another artist invoice'
);

select is(
  (select count(*)::int from public.invoices),
  0,
  'Kristina reads none of the Vladimir invoices'
);

select is(
  (select jsonb_array_length(public.list_invoices())),
  0,
  'the invoice list returns nothing outside the caller artists'
);

reset role;
set local role authenticated;
select pg_temp.claims('{"sub":"93333333-3333-4333-8333-333333333333","role":"authenticated"}');

select is(
  (select count(*)::int from public.invoices),
  0,
  'a membership without finance permission sees no invoice at all'
);
select is(
  (select count(*)::int from public.credit_notes),
  0,
  'a membership without finance permission sees no credit note'
);

reset role;
set local role anon;
select pg_temp.claims('{"role":"anon"}');
select throws_ok($$select count(*) from public.invoices$$, '42501', null,
  'anon cannot read invoices');
select throws_ok($$select count(*) from public.credit_notes$$, '42501', null,
  'anon cannot read credit notes');
reset role;

-- ---------------------------------------------------------------------------
-- Existing records keep working
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.payment_requests (
  id, idempotency_key, artist_id, client_id, project_id,
  purpose, amount, currency
) values (
  'a9222222-2222-4222-8222-222222222222',
  '61000000-0000-4000-8000-000000000002',
  'a1111111-1111-4111-8111-111111111111',
  'c9111111-1111-4111-8111-111111111111',
  'd9111111-1111-4111-8111-111111111111',
  'deposit', 100.00, 'GBP'
);

select is(
  (select invoice_id from public.payment_requests
   where id = 'a9222222-2222-4222-8222-222222222222'),
  null,
  'a deposit request created the way the CRM creates one today needs no invoice'
);

select is(
  (select status::text from public.payment_requests
   where id = 'a9222222-2222-4222-8222-222222222222'),
  'pending',
  'and it behaves exactly as it did before invoicing existed'
);

select * from finish(true);
rollback;
