-- 208_monzo_reconciliation_crm_review.sql
-- Synthetic-only validation for human Monzo reconciliation review.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('e8111111-1111-4111-8111-111111111111', 'reconcile-owner@example.test'),
  ('e8122222-2222-4222-8222-222222222222', 'reconcile-outsider@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('e8111111-1111-4111-8111-111111111111', 'reconcile-owner@example.test', 'Reconciliation Owner', 'owner', true),
  ('e8122222-2222-4222-8222-222222222222', 'reconcile-outsider@example.test', 'Reconciliation Outsider', 'read_only', true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated, service_role;

insert into public.clients (id, full_name, email) values
  ('e8211111-1111-4111-8111-111111111111', 'Reconciliation Client', 'reconcile-client@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'e8311111-1111-4111-8111-111111111111',
  'e8211111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'PENDING', 'e8411111-1111-4111-8111-111111111111', repeat('e', 64),
  'accepted', 'complete', 'Reconciliation Client', 'reconcile-client@example.test',
  '2026-07-29', now()
);

insert into public.projects (id, client_id, enquiry_id, artist_id, title, status, currency) values (
  'e8511111-1111-4111-8111-111111111111',
  'e8211111-1111-4111-8111-111111111111',
  'e8311111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'Reconciliation Project', 'active', 'GBP'
);

insert into public.sessions (id, project_id, artist_id, status, start_at, end_at) values (
  'e8611111-1111-4111-8111-111111111111',
  'e8511111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'proposed',
  date_trunc('day', now()) + interval '20 days 10 hours',
  date_trunc('day', now()) + interval '20 days 17 hours'
);

set local role authenticated;
select pg_temp.claims('{"sub":"e8111111-1111-4111-8111-111111111111","role":"authenticated"}');

select lives_ok(
  $$select public.configure_monzo_easy_bank_transfer(
      'a1111111-1111-4111-8111-111111111111',
      'https://monzo.com/pay/r/synthetic-reconciliation', true
    )$$,
  'owner configures the synthetic Monzo destination'
);

create temporary table request_fixture as
select public.request_session_deposit(
  'e8611111-1111-4111-8111-111111111111',
  'e8711111-1111-4111-8111-111111111111',
  'copy_link'
) as result;
grant select on request_fixture to authenticated, service_role;

select is(
  (select (result ->> 'amount')::numeric from request_fixture),
  250::numeric,
  'seven-hour synthetic appointment receives the GBP 250 deposit tier'
);

reset role;
select pg_temp.claims('{"role":"service_role"}');
set local role service_role;

create temporary table candidate_fixture as
select public.register_monzo_reconciliation_candidate(
  'monzo_ebt_a1111111111141118111111111111111',
  'evt_review_001', 'tx_review_001', 250.00, 'GBP', now()
) as result;
grant select on candidate_fixture to authenticated, service_role;

select is(
  (select result ->> 'status' from candidate_fixture),
  'candidate',
  'verified Monzo transaction remains only a candidate before human review'
);

reset role;
set local role authenticated;
select pg_temp.claims('{"sub":"e8122222-2222-4222-8222-222222222222","role":"authenticated"}');

select throws_ok(
  $$select public.list_monzo_reconciliation_candidates(
      'a1111111-1111-4111-8111-111111111111'
    )$$,
  '42501', null,
  'authenticated user without artist finance access cannot list candidates'
);

select pg_temp.claims('{"sub":"e8111111-1111-4111-8111-111111111111","role":"authenticated"}');

create temporary table list_before as
select public.list_monzo_reconciliation_candidates(
  'a1111111-1111-4111-8111-111111111111'
) as result;
grant select on list_before to authenticated;

select is(jsonb_array_length((select result from list_before)), 1,
  'owner sees one reconciliation candidate through the safe RPC');
select is((select result -> 0 ->> 'status' from list_before), 'candidate',
  'safe list reports the candidate state');
select is((select result -> 0 ->> 'confirmed' from list_before), 'false',
  'candidate is not confirmed before the separate confirmation action');
select is((select result -> 0 -> 'suggested_payment_request' ->> 'client_name' from list_before),
  'Reconciliation Client', 'safe list includes enough CRM context to identify the payment');
select is(jsonb_array_length((select result -> 0 -> 'match_options' from list_before)), 1,
  'safe list exposes one eligible payment-request match option');
select ok(
  not ((select result -> 0 from list_before) ? 'provider_account_key')
  and not ((select result -> 0 from list_before) ? 'provider_event_id')
  and not ((select result -> 0 from list_before) ? 'provider_transaction_id'),
  'safe list never returns raw Monzo routing or provider identifiers'
);

create temporary table match_result as
select public.match_monzo_reconciliation_candidate(
  (select (result ->> 'candidate_id')::uuid from candidate_fixture),
  (select (result ->> 'payment_request_id')::uuid from request_fixture)
) as result;
grant select on match_result to authenticated;

select is((select result ->> 'status' from match_result), 'matched',
  'human Match links the verified candidate to the selected payment request');
select is((select result ->> 'confirmed' from match_result), 'false',
  'Match explicitly remains non-financial');

reset role;
select is(
  (select status::text from public.payment_requests
   where id = (select (result ->> 'payment_request_id')::uuid from request_fixture)),
  'pending',
  'Match alone does not mark the deposit paid'
);
select is(
  (select count(*)::int from public.payment_transactions
   where payment_request_id = (select (result ->> 'payment_request_id')::uuid from request_fixture)),
  0,
  'Match alone creates no immutable payment ledger row'
);

set local role authenticated;
select pg_temp.claims('{"sub":"e8111111-1111-4111-8111-111111111111","role":"authenticated"}');

create temporary table confirm_result as
select public.confirm_monzo_reconciliation_candidate(
  (select (result ->> 'candidate_id')::uuid from candidate_fixture)
) as result;
grant select on confirm_result to authenticated;

select is((select result ->> 'confirmed' from confirm_result), 'true',
  'separate human confirmation records the verified payment');
select is((select result ->> 'replayed' from confirm_result), 'false',
  'first confirmation is not an idempotent replay');
select is((select result ->> 'payment_request_status' from confirm_result), 'paid',
  'immutable ledger trigger derives paid status after confirmation');

reset role;
select is(
  (select count(*)::int from public.payment_transactions
   where payment_request_id = (select (result ->> 'payment_request_id')::uuid from request_fixture)),
  1,
  'confirmation creates exactly one payment ledger row'
);
select is(
  (select transaction_type::text from public.payment_transactions
   where payment_request_id = (select (result ->> 'payment_request_id')::uuid from request_fixture)),
  'payment',
  'confirmed Monzo money remains provider-payment provenance rather than manual payment'
);
select is(
  (select recorded_by_kind::text from public.payment_transactions
   where payment_request_id = (select (result ->> 'payment_request_id')::uuid from request_fixture)),
  'webhook',
  'provider payment ledger provenance remains webhook-derived evidence'
);
select is(
  (select recorded_by from public.payment_transactions
   where payment_request_id = (select (result ->> 'payment_request_id')::uuid from request_fixture)),
  null::uuid,
  'provider payment ledger row does not impersonate the human as provider evidence'
);
select is(
  (select safe_note_code from public.payment_transactions
   where payment_request_id = (select (result ->> 'payment_request_id')::uuid from request_fixture)),
  'monzo_human_reconciled',
  'ledger stores only a safe reconciliation note code'
);
select is(
  (select count(*)::int from public.activity_log
   where event_type = 'payment.reconciliation_confirmed'
     and actor_profile_id = 'e8111111-1111-4111-8111-111111111111'),
  1,
  'human confirmation is separately attributable in the append-only activity log'
);

set local role authenticated;
select pg_temp.claims('{"sub":"e8111111-1111-4111-8111-111111111111","role":"authenticated"}');

create temporary table replay_confirm as
select public.confirm_monzo_reconciliation_candidate(
  (select (result ->> 'candidate_id')::uuid from candidate_fixture)
) as result;
grant select on replay_confirm to authenticated;
select is((select result ->> 'replayed' from replay_confirm), 'true',
  'repeated confirmation is idempotent');

reset role;
select is(
  (select count(*)::int from public.payment_transactions
   where payment_request_id = (select (result ->> 'payment_request_id')::uuid from request_fixture)),
  1,
  'repeated confirmation never duplicates the ledger entry'
);

set local role authenticated;
select pg_temp.claims('{"sub":"e8111111-1111-4111-8111-111111111111","role":"authenticated"}');
create temporary table list_after as
select public.list_monzo_reconciliation_candidates(
  'a1111111-1111-4111-8111-111111111111'
) as result;
grant select on list_after to authenticated;
select is((select result -> 0 ->> 'confirmed' from list_after), 'true',
  'safe list derives confirmed state from the immutable ledger');

reset role;
select pg_temp.claims('{"role":"service_role"}');
set local role service_role;
create temporary table ignored_candidate as
select public.register_monzo_reconciliation_candidate(
  'monzo_ebt_a1111111111141118111111111111111',
  'evt_review_002', 'tx_review_002', 50.00, 'GBP', now()
) as result;
grant select on ignored_candidate to authenticated, service_role;
select is((select result ->> 'status' from ignored_candidate), 'unmatched',
  'unrelated verified transfer arrives unmatched');

reset role;
set local role authenticated;
select pg_temp.claims('{"sub":"e8111111-1111-4111-8111-111111111111","role":"authenticated"}');
select is(
  public.ignore_monzo_reconciliation_candidate(
    (select (result ->> 'candidate_id')::uuid from ignored_candidate)
  ) ->> 'status',
  'ignored',
  'human can explicitly ignore an unrelated verified transfer'
);

reset role;
select is(
  (select count(*)::int from public.payment_transactions
   where provider = 'monzo_easy_bank_transfer'
     and provider_transaction_id = 'tx_review_002'),
  0,
  'Ignore never creates a payment transaction'
);
select ok(
  not has_table_privilege('authenticated', 'public.payment_reconciliation_candidates', 'select'),
  'candidate table remains directly unreadable by the browser role'
);
select ok(
  has_function_privilege('authenticated', 'public.list_monzo_reconciliation_candidates(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.match_monzo_reconciliation_candidate(uuid,uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.ignore_monzo_reconciliation_candidate(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.confirm_monzo_reconciliation_candidate(uuid)', 'execute'),
  'authenticated CRM receives only the named reconciliation RPC surface'
);
select ok(
  not has_function_privilege('service_role', 'public.list_monzo_reconciliation_candidates(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.match_monzo_reconciliation_candidate(uuid,uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.ignore_monzo_reconciliation_candidate(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.confirm_monzo_reconciliation_candidate(uuid)', 'execute'),
  'human reconciliation RPCs are not a service-backend mutation surface'
);

select * from finish();
rollback;
