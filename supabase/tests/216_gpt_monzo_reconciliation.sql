-- 216_gpt_monzo_reconciliation.sql
--
-- Synthetic-only validation for the Custom GPT Monzo reconciliation surface.
-- Artist routing comes only from the OAuth client_id. Match remains non-financial;
-- settlement requires the separate Confirm action.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('f6111111-1111-4111-8111-111111111111', 'gpt-monzo-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('f6111111-1111-4111-8111-111111111111',
   'gpt-monzo-owner@example.test', 'GPT Monzo Owner', 'owner', true);

create function pg_temp.gpt_monzo_claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.gpt_monzo_claims(text) to authenticated, service_role;

insert into public.clients (id, full_name, email) values
  ('f6211111-1111-4111-8111-111111111111', 'GPT Monzo Client', 'gpt-monzo-client@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'f6311111-1111-4111-8111-111111111111',
  'f6211111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'PENDING', 'f6411111-1111-4111-8111-111111111111', repeat('f', 64),
  'accepted', 'complete', 'GPT Monzo Client', 'gpt-monzo-client@example.test',
  '2026-07-29', now()
);

insert into public.projects (id, client_id, enquiry_id, artist_id, title, status, currency) values (
  'f6511111-1111-4111-8111-111111111111',
  'f6211111-1111-4111-8111-111111111111',
  'f6311111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'GPT Monzo Project', 'active', 'GBP'
);

insert into public.sessions (id, project_id, artist_id, status, start_at, end_at) values (
  'f6611111-1111-4111-8111-111111111111',
  'f6511111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'proposed',
  date_trunc('day', now()) + interval '25 days 10 hours',
  date_trunc('day', now()) + interval '25 days 17 hours'
);

set local role authenticated;
select pg_temp.gpt_monzo_claims(
  '{"sub":"f6111111-1111-4111-8111-111111111111","role":"authenticated"}'
);

select lives_ok(
  $$select public.configure_gpt_action_client(
      'vladimir-gpt-actions','oauth-vladimir-monzo-test',true,true
    )$$,
  'owner binds the Vladimir GPT OAuth fixture'
);
select lives_ok(
  $$select public.configure_gpt_action_client(
      'kristina-gpt-actions','oauth-kristina-monzo-test',true,true
    )$$,
  'owner binds the Kristina GPT OAuth fixture'
);
select lives_ok(
  $$select public.configure_gpt_full_management(
      'vladimir-gpt-actions',true,true,true
    )$$,
  'owner enables Vladimir GPT finance capability'
);

select lives_ok(
  $$select public.configure_monzo_easy_bank_transfer(
      'a1111111-1111-4111-8111-111111111111',
      'https://monzo.com/pay/r/synthetic-gpt-reconciliation', true
    )$$,
  'owner configures a synthetic Vladimir Monzo destination'
);

create temporary table gpt_monzo_request as
select public.request_session_deposit(
  'f6611111-1111-4111-8111-111111111111',
  'f6711111-1111-4111-8111-111111111111',
  'copy_link'
) as result;
grant select on gpt_monzo_request to authenticated, service_role;

select is(
  (select (result ->> 'amount')::numeric from gpt_monzo_request),
  250::numeric,
  'synthetic seven-hour session creates the expected GBP 250 request'
);

select throws_ok(
  $$select public.gpt_list_monzo_reconciliation_candidates()$$,
  '42501', null,
  'ordinary authenticated CRM token cannot use the GPT Monzo RPC surface'
);

reset role;
select pg_temp.gpt_monzo_claims('{"role":"service_role"}');
set local role service_role;

create temporary table vladimir_candidate as
select public.register_monzo_reconciliation_candidate(
  'monzo_ebt_a1111111111141118111111111111111',
  'evt_gpt_monzo_001', 'tx_gpt_monzo_001', 250.00, 'GBP', now()
) as result;
grant select on vladimir_candidate to authenticated, service_role;

create temporary table vladimir_ignored_candidate as
select public.register_monzo_reconciliation_candidate(
  'monzo_ebt_a1111111111141118111111111111111',
  'evt_gpt_monzo_002', 'tx_gpt_monzo_002', 50.00, 'GBP', now()
) as result;
grant select on vladimir_ignored_candidate to authenticated, service_role;

create temporary table kristina_candidate as
select public.register_monzo_reconciliation_candidate(
  'monzo_ebt_a2222222222242228222222222222222',
  'evt_gpt_monzo_003', 'tx_gpt_monzo_003', 75.00, 'GBP', now()
) as result;
grant select on kristina_candidate to authenticated, service_role;

reset role;
set local role authenticated;
select pg_temp.gpt_monzo_claims(
  '{"sub":"f6111111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-vladimir-monzo-test"}'
);

create temporary table gpt_candidate_list as
select public.gpt_list_monzo_reconciliation_candidates() as result;
grant select on gpt_candidate_list to authenticated;

select is(
  jsonb_array_length((select result from gpt_candidate_list)),
  2,
  'Vladimir GPT lists only Vladimir reconciliation candidates'
);
select ok(
  exists (
    select 1
    from jsonb_array_elements((select result from gpt_candidate_list)) item
    where (item ->> 'id')::uuid =
      (select (result ->> 'candidate_id')::uuid from vladimir_candidate)
  ),
  'Vladimir GPT list includes the Vladimir candidate'
);
select ok(
  not exists (
    select 1
    from jsonb_array_elements((select result from gpt_candidate_list)) item
    where (item ->> 'id')::uuid =
      (select (result ->> 'candidate_id')::uuid from kristina_candidate)
  ),
  'Vladimir GPT list excludes Kristina candidate'
);
select ok(
  not exists (
    select 1
    from jsonb_array_elements((select result from gpt_candidate_list)) item
    where item ? 'provider_account_key'
       or item ? 'provider_event_id'
       or item ? 'provider_transaction_id'
  ),
  'GPT candidate list never exposes raw Monzo routing or provider identifiers'
);

select throws_ok(
  $$select public.gpt_match_monzo_reconciliation_candidate(
      (select (result ->> 'candidate_id')::uuid from kristina_candidate),
      (select (result ->> 'payment_request_id')::uuid from gpt_monzo_request)
    )$$,
  '42501', null,
  'Vladimir GPT cannot match a Kristina reconciliation candidate'
);
select throws_ok(
  $$select public.gpt_ignore_monzo_reconciliation_candidate(
      (select (result ->> 'candidate_id')::uuid from kristina_candidate)
    )$$,
  '42501', null,
  'Vladimir GPT cannot ignore a Kristina reconciliation candidate'
);
select throws_ok(
  $$select public.gpt_confirm_monzo_reconciliation_candidate(
      (select (result ->> 'candidate_id')::uuid from kristina_candidate)
    )$$,
  '42501', null,
  'Vladimir GPT cannot confirm a Kristina reconciliation candidate'
);

select throws_ok(
  $$select public.gpt_confirm_monzo_reconciliation_candidate(
      (select (result ->> 'candidate_id')::uuid from vladimir_candidate)
    )$$,
  '22023', null,
  'GPT Confirm cannot skip the separate Match step'
);

create temporary table gpt_match_result as
select public.gpt_match_monzo_reconciliation_candidate(
  (select (result ->> 'candidate_id')::uuid from vladimir_candidate),
  (select (result ->> 'payment_request_id')::uuid from gpt_monzo_request)
) as result;
grant select on gpt_match_result to authenticated;

select is((select result ->> 'status' from gpt_match_result), 'matched',
  'GPT Match links the candidate to the selected payment request');
select is((select result ->> 'confirmed' from gpt_match_result), 'false',
  'GPT Match remains explicitly non-financial');

reset role;
select is(
  (select count(*)::int from public.payment_transactions
   where payment_request_id =
     (select (result ->> 'payment_request_id')::uuid from gpt_monzo_request)),
  0,
  'GPT Match creates no immutable payment ledger row'
);

set local role authenticated;
select pg_temp.gpt_monzo_claims(
  '{"sub":"f6111111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-vladimir-monzo-test"}'
);

select is(
  public.gpt_ignore_monzo_reconciliation_candidate(
    (select (result ->> 'candidate_id')::uuid from vladimir_ignored_candidate)
  ) ->> 'status',
  'ignored',
  'GPT Ignore is explicit and non-financial'
);

create temporary table gpt_confirm_result as
select public.gpt_confirm_monzo_reconciliation_candidate(
  (select (result ->> 'candidate_id')::uuid from vladimir_candidate)
) as result;
grant select on gpt_confirm_result to authenticated;

select is((select result ->> 'confirmed' from gpt_confirm_result), 'true',
  'separate GPT Confirm records the verified payment');
select is((select result ->> 'payment_request_status' from gpt_confirm_result), 'paid',
  'authoritative ledger transition marks the request paid after Confirm');

reset role;
select is(
  (select count(*)::int from public.payment_transactions
   where payment_request_id =
     (select (result ->> 'payment_request_id')::uuid from gpt_monzo_request)),
  1,
  'GPT Confirm creates exactly one immutable ledger row'
);
select is(
  (select count(*)::int from public.payment_transactions
   where provider_transaction_id = 'tx_gpt_monzo_002'),
  0,
  'GPT Ignore never creates a payment ledger row'
);

set local role authenticated;
select pg_temp.gpt_monzo_claims(
  '{"sub":"f6111111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-kristina-monzo-test"}'
);
select throws_ok(
  $$select public.gpt_list_monzo_reconciliation_candidates()$$,
  '42501', null,
  'Kristina GPT Monzo access stays fail-closed while finance capability is disabled'
);

reset role;
select ok(
  has_function_privilege('authenticated', 'public.gpt_list_monzo_reconciliation_candidates()', 'execute')
  and has_function_privilege('authenticated', 'public.gpt_match_monzo_reconciliation_candidate(uuid,uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.gpt_ignore_monzo_reconciliation_candidate(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.gpt_confirm_monzo_reconciliation_candidate(uuid)', 'execute'),
  'authenticated OAuth tokens receive only the four named GPT reconciliation RPCs'
);
select ok(
  not has_function_privilege('anon', 'public.gpt_list_monzo_reconciliation_candidates()', 'execute')
  and not has_function_privilege('service_role', 'public.gpt_list_monzo_reconciliation_candidates()', 'execute')
  and not has_function_privilege('anon', 'public.gpt_match_monzo_reconciliation_candidate(uuid,uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.gpt_match_monzo_reconciliation_candidate(uuid,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.gpt_ignore_monzo_reconciliation_candidate(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.gpt_ignore_monzo_reconciliation_candidate(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.gpt_confirm_monzo_reconciliation_candidate(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.gpt_confirm_monzo_reconciliation_candidate(uuid)', 'execute'),
  'GPT reconciliation RPCs are unavailable to anon and service_role'
);

select * from finish();
rollback;