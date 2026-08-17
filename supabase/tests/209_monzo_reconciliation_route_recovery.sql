-- 209_monzo_reconciliation_route_recovery.sql
-- Synthetic-only regression for webhook ingestion when OAuth/webhook is
-- connected but the optional reusable Monzo payment-link destination has not
-- been configured in artist_integrations.

begin;
select no_plan();

select is(
  (select count(*)::int
   from public.artist_integrations i
   where i.artist_id = 'a1111111-1111-4111-8111-111111111111'
     and i.integration_type = 'payments'
     and i.provider = 'monzo_easy_bank_transfer'),
  0,
  'fixture starts without a Monzo payment-link integration row'
);

select throws_ok(
  $$select crm_private.resolve_payment_route_owner(
      'monzo_easy_bank_transfer',
      'monzo_ebt_a1111111111141118111111111111111'
    )$$,
  '42501', null,
  'generic enabled payment-destination resolver still rejects an unconfigured payment link'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

create temporary table route_recovery_candidate as
select public.register_monzo_reconciliation_candidate(
  'monzo_ebt_a1111111111141118111111111111111',
  'monzo:transaction.created:tx_route_recovery_001',
  'tx_route_recovery_001',
  250.00,
  'GBP',
  timestamptz '2026-08-17 21:05:00+00'
) as result;
grant select on route_recovery_candidate to service_role;

select is(
  (select result ->> 'artist_id' from route_recovery_candidate),
  'a1111111-1111-4111-8111-111111111111',
  'backend reconciliation resolves the active artist from the server-derived Monzo account key'
);
select is(
  (select result ->> 'status' from route_recovery_candidate),
  'unmatched',
  'verified transfer is recorded unmatched when no payment request exists'
);
select is(
  (select result ->> 'replayed' from route_recovery_candidate),
  'false',
  'first recovered transaction is not a replay'
);

reset role;
select is(
  (select count(*)::int
   from public.payment_webhook_events e
   where e.provider = 'monzo_easy_bank_transfer'
     and e.provider_event_id = 'monzo:transaction.created:tx_route_recovery_001'),
  1,
  'route recovery records one verified provider event'
);
select is(
  (select count(*)::int
   from public.payment_reconciliation_candidates c
   where c.provider = 'monzo_easy_bank_transfer'
     and c.provider_transaction_id = 'tx_route_recovery_001'),
  1,
  'route recovery records one reconciliation candidate'
);
select is(
  (select artist_id::text
   from public.payment_reconciliation_candidates c
   where c.provider = 'monzo_easy_bank_transfer'
     and c.provider_transaction_id = 'tx_route_recovery_001'),
  'a1111111-1111-4111-8111-111111111111',
  'candidate remains artist-scoped without a payment-link integration row'
);
select is(
  (select count(*)::int from public.payment_transactions),
  0,
  'route recovery never settles money automatically'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
create temporary table route_recovery_replay as
select public.register_monzo_reconciliation_candidate(
  'monzo_ebt_a1111111111141118111111111111111',
  'monzo:transaction.created:tx_route_recovery_001',
  'tx_route_recovery_001',
  250.00,
  'GBP',
  timestamptz '2026-08-17 21:05:00+00'
) as result;
grant select on route_recovery_replay to service_role;
select is(
  (select result ->> 'replayed' from route_recovery_replay),
  'true',
  'recovery and webhook delivery share the same idempotent transaction identity'
);

select throws_ok(
  $$select public.register_monzo_reconciliation_candidate(
      'monzo_ebt_ffffffffffffffffffffffffffffffff',
      'monzo:transaction.created:tx_unknown_route_001',
      'tx_unknown_route_001', 10.00, 'GBP', now()
    )$$,
  '42501', null,
  'unknown deterministic Monzo route cannot select an artist'
);
select throws_ok(
  $$select public.register_monzo_reconciliation_candidate(
      'monzo_ebt_not-a-uuid',
      'monzo:transaction.created:tx_bad_route_001',
      'tx_bad_route_001', 10.00, 'GBP', now()
    )$$,
  '22023', null,
  'malformed provider account key is rejected before artist resolution'
);

reset role;
select set_config(
  'request.jwt.claims',
  '{"sub":"e9999999-9999-4999-8999-999999999999","role":"authenticated"}',
  true
);
set local role authenticated;
select throws_ok(
  $$select public.register_monzo_reconciliation_candidate(
      'monzo_ebt_a1111111111141118111111111111111',
      'monzo:transaction.created:tx_browser_denied_001',
      'tx_browser_denied_001', 10.00, 'GBP', now()
    )$$,
  '42501', null,
  'browser role still cannot register provider transactions'
);

reset role;
select ok(
  not has_function_privilege(
    'service_role',
    'crm_private.resolve_monzo_reconciliation_owner(text)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'crm_private.resolve_monzo_reconciliation_owner(text)',
    'execute'
  ),
  'private deterministic resolver is not directly callable by Worker or browser roles'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.register_monzo_reconciliation_candidate(text,text,text,numeric,text,timestamptz)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.register_monzo_reconciliation_candidate(text,text,text,numeric,text,timestamptz)',
    'execute'
  ),
  'only the existing backend reconciliation RPC remains externally callable'
);

select * from finish();
rollback;
