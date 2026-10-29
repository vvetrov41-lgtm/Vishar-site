-- Historical project marked paid without a CRM payment request.
-- All synthetic records and finance mutations roll back.
begin;
select no_plan();
select set_config('request.jwt.claims','{"role":"service_role"}',true);

insert into auth.users(id,email) values
 ('f7111111-1111-4111-8111-111111111111','legacy-deposit-owner@example.test'),
 ('f7122222-2222-4222-8222-222222222222','legacy-deposit-outsider@example.test');
insert into public.profiles(id,email,display_name,role,is_active) values
 ('f7111111-1111-4111-8111-111111111111','legacy-deposit-owner@example.test','Legacy Owner','owner',true),
 ('f7122222-2222-4222-8222-222222222222','legacy-deposit-outsider@example.test','Legacy Outsider','read_only',true);

-- Clean CI databases do not have the production artist's active duration
-- policy. Seed the standard tiers in this rollback-only transaction.
insert into public.artist_payment_policies(
 id,artist_id,version,deposit_mode,fixed_amount,transfer_allowed,
 refund_policy_version,is_active,created_by
) values (
 'f7511111-1111-4111-8111-111111111111',
 'a1111111-1111-4111-8111-111111111111',
 1,'per_session_fixed',250,true,'monzo-ebt-duration-v1',true,
 'f7111111-1111-4111-8111-111111111111'
);
insert into public.artist_payment_policy_session_tiers(
 policy_id,artist_id,policy_version,tier_order,max_minutes,amount,currency
) values
 ('f7511111-1111-4111-8111-111111111111','a1111111-1111-4111-8111-111111111111',1,1,60,50,'GBP'),
 ('f7511111-1111-4111-8111-111111111111','a1111111-1111-4111-8111-111111111111',1,2,180,100,'GBP'),
 ('f7511111-1111-4111-8111-111111111111','a1111111-1111-4111-8111-111111111111',1,3,300,150,'GBP'),
 ('f7511111-1111-4111-8111-111111111111','a1111111-1111-4111-8111-111111111111',1,4,null,250,'GBP');

create function pg_temp.claims(p text) returns void language sql as $
 select set_config('request.jwt.claims',p,true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated, service_role;
insert into public.clients(id,full_name,email) values
 ('f7211111-1111-4111-8111-111111111111','Legacy Deposit Client','legacy-deposit-client@example.test');
insert into public.projects(
 id,client_id,artist_id,title,status,currency,deposit_amount,deposit_status
) values (
 'f7311111-1111-4111-8111-111111111111',
 'f7211111-1111-4111-8111-111111111111',
 'a1111111-1111-4111-8111-111111111111',
 'Synthetic four-hour tattoo','active','GBP',150,'paid'
);
insert into public.sessions(id,project_id,artist_id,status,appointment_type,start_at,end_at)
values (
 'f7411111-1111-4111-8111-111111111111',
 'f7311111-1111-4111-8111-111111111111',
 'a1111111-1111-4111-8111-111111111111',
 'confirmed','tattoo_session',
 date_trunc('day',now())+interval '10 days 11 hours',
 date_trunc('day',now())+interval '10 days 15 hours'
);

set local role service_role;
create temporary table legacy_bank_fixture as
select public.register_monzo_reconciliation_candidate(
 'monzo_ebt_a1111111111141118111111111111111',
 'monzo:transaction.created:tx_legacy_deposit_001',
 'tx_legacy_deposit_001',150,'GBP',now()-interval '15 minutes'
) as result;
grant select on legacy_bank_fixture to authenticated, service_role;
reset role;

set local role authenticated;
select pg_temp.claims('{"sub":"f7122222-2222-4222-8222-222222222222","role":"authenticated"}');
select throws_ok($$select public.reconcile_monzo_legacy_paid_deposit(
 (select (result->>'candidate_id')::uuid from legacy_bank_fixture),
 'f7411111-1111-4111-8111-111111111111'
)$$,'42501',null,'non-finance operator cannot assign bank money to client');
select pg_temp.claims('{"sub":"f7111111-1111-4111-8111-111111111111","role":"authenticated"}');

select ok(exists(
 select 1 from jsonb_array_elements(
   public.list_monzo_reconciliation_candidates('a1111111-1111-4111-8111-111111111111')
 ) candidate
 where (candidate->>'id')::uuid=(select (result->>'candidate_id')::uuid from legacy_bank_fixture)
 and exists (
   select 1 from jsonb_array_elements(candidate->'legacy_paid_deposit_options') option
   where option->>'client_name'='Legacy Deposit Client'
     and (option->>'session_id')::uuid='f7411111-1111-4111-8111-111111111111'
 )
), 'matching already-paid project and four-hour session are selectable');

select throws_ok($$select public.reconcile_monzo_legacy_paid_deposit(
 (select (result->>'candidate_id')::uuid from legacy_bank_fixture),
 '00000000-0000-4000-8000-000000000000'
)$$,'22023',null,'cannot assign transfer to an unrelated session');

create temporary table legacy_result as
select public.reconcile_monzo_legacy_paid_deposit(
 (select (result->>'candidate_id')::uuid from legacy_bank_fixture),
 'f7411111-1111-4111-8111-111111111111'
) as result;
grant select on legacy_result to authenticated,service_role;

select is((select result->>'confirmed' from legacy_result),'true',
 'verified transfer becomes a real ledger receipt');
select is((select result->>'replayed' from legacy_result),'false',
 'first settlement creates a receipt');
select is(public.reconcile_monzo_legacy_paid_deposit(
 (select (result->>'candidate_id')::uuid from legacy_bank_fixture),
 'f7411111-1111-4111-8111-111111111111'
)->>'replayed','true','identical retry is idempotent');

reset role;
select is((select count(*)::int from public.payment_requests r
 where r.project_id='f7311111-1111-4111-8111-111111111111'),1,
 'creates exactly one genuine deposit request');
select is((select count(*)::int from public.payment_transactions t
 join public.payment_requests r on r.id=t.payment_request_id
 where r.project_id='f7311111-1111-4111-8111-111111111111' and t.status='succeeded'
 and t.transaction_type='payment' and t.direction='credit'),1,
 'real Monzo receipt inserted exactly once');
select is((select count(*)::int from public.email_messages m
 where m.payment_request_id=(select (result->>'payment_request_id')::uuid from legacy_result)),0,
 'historical recovery does not enqueue another deposit email');
select is((select status::text from public.payment_requests
 where id=(select (result->>'payment_request_id')::uuid from legacy_result)),'paid',
 'request status derives from immutable receipt');
select is((select deposit_status::text from public.projects where
 id='f7311111-1111-4111-8111-111111111111'),'paid',
 'existing project deposit remains paid');
select ok(exists(select 1 from public.payment_transactions t
 where t.provider_transaction_id='tx_legacy_deposit_001' and t.amount=150 and t.currency='GBP'),
 'ledger uses original verified bank identity and amount');

select * from finish();
rollback;
