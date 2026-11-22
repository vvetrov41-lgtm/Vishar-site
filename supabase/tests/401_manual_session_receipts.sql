begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into auth.users (id,email) values ('ea800000-0000-4000-8000-000000000001','manual-receipts@example.test');
insert into public.profiles (id,email,display_name,role,is_active)
values ('ea800000-0000-4000-8000-000000000001','manual-receipts@example.test','Receipt owner','owner',true);
insert into public.clients (id,full_name)
values ('ea800000-0000-4000-8000-000000000002','Receipt client');
insert into public.projects (id,client_id,artist_id,status,title,currency,deposit_status,deposit_amount)
select 'ea800000-0000-4000-8000-000000000003','ea800000-0000-4000-8000-000000000002',
       id,'active','Receipt project','GBP','paid',300 from public.artists where slug='vladimir';
insert into public.sessions (id,artist_id,client_id,project_id,appointment_type,status,start_at,end_at,duration_hours,price,currency)
select 'ea800000-0000-4000-8000-000000000004',artist_id,client_id,id,'tattoo_session','completed',
       date_trunc('hour',now())-interval '2 days',date_trunc('hour',now())-interval '2 days'+interval '4 hours',4,770,'GBP'
from public.projects where id='ea800000-0000-4000-8000-000000000003';

select set_config('request.jwt.claims',
  '{"sub":"ea800000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
create temporary table receipt_test_results (name text, result jsonb);
insert into receipt_test_results values ('studio', public.record_session_receipt(
  'ea800000-0000-4000-8000-000000000004','ea800000-0000-4000-8000-000000000005',
  'session_balance',470,'studio_direct'));
insert into receipt_test_results values ('retry', public.record_session_receipt(
  'ea800000-0000-4000-8000-000000000004','ea800000-0000-4000-8000-000000000005',
  'session_balance',470,'studio_direct'));

select is((select result->>'confirmed' from receipt_test_results where name='studio'), 'true', 'studio receipt confirmed');
select is((select result->>'balance_needs_review' from receipt_test_results where name='studio'), 'true', 'unknown deposit leaves balance under review');
select is((select result->>'replayed' from receipt_test_results where name='retry'), 'true', 'identical receipt replays safely');
select throws_ok($$select public.record_session_receipt(
  'ea800000-0000-4000-8000-000000000004','ea800000-0000-4000-8000-000000000005',
  'session_balance',470,'cash')$$, '22023', 'receipt id was reused with different terms', 'method cannot change on retry');

insert into receipt_test_results values ('cash', public.record_session_receipt(
  'ea800000-0000-4000-8000-000000000004','ea800000-0000-4000-8000-000000000006',
  'deposit',300,'cash'));
select is((select result->>'payment_status' from receipt_test_results where name='cash'), 'paid', 'allocated deposit closes the known balance');
select is((select result->>'outstanding' from receipt_test_results where name='cash'), '0.00', 'no remainder once both receipts are assigned');

reset role;
select is((select count(*) from public.payment_transactions
  where idempotency_key in (
    'ea800000-0000-4000-8000-000000000005', 'ea800000-0000-4000-8000-000000000006'
  )), 2::bigint, 'one immutable credit per receipt');
select is((select count(*) from public.payment_requests
  where session_id='ea800000-0000-4000-8000-000000000004' and status='paid' and provider is null),
  2::bigint, 'manual recording is not contingent on a provider route');
select ok(not has_function_privilege('anon','public.record_session_receipt(uuid,uuid,text,numeric,text,timestamptz)','EXECUTE'),
  'anonymous callers cannot record receipts');
select ok(not has_function_privilege('service_role','public.gpt_record_session_receipt(uuid,uuid,text,numeric,text,timestamptz)','EXECUTE'),
  'plugin action requires a human authentication context');

-- A settled bank transfer can be associated manually when no request exists.
insert into public.sessions (id,artist_id,client_id,project_id,appointment_type,status,start_at,end_at,duration_hours,price,currency)
select 'ea800000-0000-4000-8000-000000000007',artist_id,client_id,id,'tattoo_session','completed',
       date_trunc('hour',now())-interval '1 day',date_trunc('hour',now())-interval '1 day'+interval '4 hours',4,500,'GBP'
from public.projects where id='ea800000-0000-4000-8000-000000000003';
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table bank_receipt_test as
select public.register_monzo_reconciliation_candidate(
  'monzo_ebt_a1111111111141118111111111111111',
  'monzo:transaction.created:tx_manual_session_test',
  'tx_manual_session_test',150,'GBP',now()-interval '1 day'
) as result;
grant select on bank_receipt_test to authenticated;
select set_config('request.jwt.claims',
  '{"sub":"ea800000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;

insert into receipt_test_results values ('bank', public.confirm_monzo_session_receipt(
  (select (result->>'candidate_id')::uuid from bank_receipt_test),
  'ea800000-0000-4000-8000-000000000007','deposit'));
select is((select result->>'confirmed' from receipt_test_results where name='bank'), 'true',
  'owner can confirm a bank transfer without an existing request');
select is(public.confirm_monzo_session_receipt(
  (select (result->>'candidate_id')::uuid from bank_receipt_test),
  'ea800000-0000-4000-8000-000000000007','deposit')->>'replayed','true','confirmed bank transfer retries safely');
reset role;
select is((select count(*) from public.payment_transactions where payment_request_id =
  (select (result->>'payment_request_id')::uuid from receipt_test_results where name='bank')),
  1::bigint, 'bank evidence does not credit the ledger a second time');
select ok(exists (
  select 1 from public.monzo_recorded_receipt_links
  where candidate_id = (select (result->>'candidate_id')::uuid from bank_receipt_test)
), 'bank evidence is linked to the receipt');

select * from finish();
rollback;
