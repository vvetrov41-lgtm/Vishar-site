-- Synthetic, rollback-only Monzo -> existing manual invoice payment linking.
-- One verified transfer must not create a second payment ledger credit.
begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id,email) values
  ('f9111111-1111-4111-8111-111111111111','recorded-receipt-owner@example.test'),
  ('f9122222-2222-4222-8222-222222222222','recorded-receipt-outsider@example.test');
insert into public.profiles (id,email,display_name,role,is_active) values
  ('f9111111-1111-4111-8111-111111111111','recorded-receipt-owner@example.test','Receipt Owner','owner',true),
  ('f9122222-2222-4222-8222-222222222222','recorded-receipt-outsider@example.test','Receipt Outsider','read_only',true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims',p,true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated, service_role;

insert into public.clients (id,full_name,email) values (
  'f9211111-1111-4111-8111-111111111111', 'Recorded Invoice Client', 'receipt-client@example.test'
);
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'f9311111-1111-4111-8111-111111111111',
  'f9211111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'PENDING','f9411111-1111-4111-8111-111111111111', repeat('f',64),
  'accepted','complete','Recorded Invoice Client','receipt-client@example.test',
  '2026-07-29',now()
);
insert into public.projects (id,client_id,enquiry_id,artist_id,title,status,currency) values (
  'f9511111-1111-4111-8111-111111111111',
  'f9211111-1111-4111-8111-111111111111',
  'f9311111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'Recorded Invoice Project','active','GBP'
);
insert into public.sessions (id,project_id,artist_id,status,start_at,end_at)
values (
  'f9611111-1111-4111-8111-111111111111',
  'f9511111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'confirmed',
  date_trunc('day',now()) + interval '10 days 10 hours',
  date_trunc('day',now()) + interval '10 days 17 hours'
);

set local role authenticated;
select pg_temp.claims('{"sub":"f9111111-1111-4111-8111-111111111111","role":"authenticated"}');
create temporary table recorded_invoice_fixture as
select public.create_invoice(
  'f9511111-1111-4111-8111-111111111111',
  'f9711111-1111-4111-8111-111111111111',
  null,
  'Synthetic invoice balance'
) as result;
grant select on recorded_invoice_fixture to authenticated, service_role;

select lives_ok(
  $$select public.set_invoice_line_item(
    (select (result ->> 'invoice_id')::uuid from recorded_invoice_fixture),
    'Synthetic tattoo session balance',1,730,null,
    'f9611111-1111-4111-8111-111111111111',null
  )$$,
  'invoice line is linked to one synthetic session'
);
select lives_ok(
  $$select public.issue_invoice((select (result ->> 'invoice_id')::uuid from recorded_invoice_fixture))$$,
  'owner issues synthetic invoice'
);
create temporary table recorded_receipt_fixture as
select public.record_invoice_payment(
  (select (result ->> 'invoice_id')::uuid from recorded_invoice_fixture),
  'f9811111-1111-4111-8111-111111111111',
  730,now(),null,null
) as result;
grant select on recorded_receipt_fixture to authenticated, service_role;

reset role;
select pg_temp.claims('{"role":"service_role"}');
set local role service_role;
create temporary table recorded_bank_fixture as
select public.register_monzo_reconciliation_candidate(
  'monzo_ebt_a1111111111141118111111111111111',
  'monzo:transaction.created:tx_recorded_receipt_001',
  'tx_recorded_receipt_001',730,'GBP',now() - interval '15 minutes'
) as result;
grant select on recorded_bank_fixture to authenticated, service_role;
reset role;

set local role authenticated;
select pg_temp.claims('{"sub":"f9122222-2222-4222-8222-222222222222","role":"authenticated"}');
select throws_ok(
  $$select public.link_monzo_recorded_receipt(
    (select (result ->> 'candidate_id')::uuid from recorded_bank_fixture),
    (select (result ->> 'payment_transaction_id')::uuid from recorded_receipt_fixture)
  )$$,
  '42501',null,'read-only outsider cannot associate incoming money with a client'
);
select pg_temp.claims('{"sub":"f9111111-1111-4111-8111-111111111111","role":"authenticated"}');

select ok(
  exists (
    select 1 from jsonb_array_elements(
      public.list_monzo_reconciliation_candidates('a1111111-1111-4111-8111-111111111111')
    ) as candidate
    where (candidate ->> 'id')::uuid =
      (select (result ->> 'candidate_id')::uuid from recorded_bank_fixture)
      and jsonb_array_length(candidate -> 'match_options') = 0
      and exists (
        select 1 from jsonb_array_elements(candidate -> 'recorded_receipt_options') as option
        where (option ->> 'payment_transaction_id')::uuid =
          (select (result ->> 'payment_transaction_id')::uuid from recorded_receipt_fixture)
          and option ->> 'client_name' = 'Recorded Invoice Client'
      )
  ),
  'paid invoice appears only as already-recorded receipt option (not an unpaid deposit)'
);

create temporary table recorded_link_result as
select public.link_monzo_recorded_receipt(
  (select (result ->> 'candidate_id')::uuid from recorded_bank_fixture),
  (select (result ->> 'payment_transaction_id')::uuid from recorded_receipt_fixture)
) as result;
grant select on recorded_link_result to authenticated;

select is((select result ->> 'confirmed' from recorded_link_result),'true',
  'human confirms link without posting money');
select is((select result ->> 'replayed' from recorded_link_result),'false',
  'first association is new');

select is(public.link_monzo_recorded_receipt(
  (select (result ->> 'candidate_id')::uuid from recorded_bank_fixture),
  (select (result ->> 'payment_transaction_id')::uuid from recorded_receipt_fixture)
) ->> 'replayed','true','identical retry is idempotent');

select ok(
  exists (
    select 1 from jsonb_array_elements(
      public.list_monzo_reconciliation_candidates('a1111111-1111-4111-8111-111111111111')
    ) as candidate
    where (candidate ->> 'id')::uuid =
      (select (result ->> 'candidate_id')::uuid from recorded_bank_fixture)
      and candidate ->> 'confirmed' = 'true'
      and candidate ->> 'linked_existing_receipt' = 'true'
      and candidate -> 'matched_payment_request' ->> 'client_name' = 'Recorded Invoice Client'
  ),
  'candidate becomes processed with the correct client, via evidence-only association'
);

reset role;
select is(
  (select count(*)::int from public.payment_transactions
   where payment_request_id =
     (select (result ->> 'payment_request_id')::uuid from recorded_receipt_fixture)),
  1,
  'link does not insert a second payment transaction'
);
select is(
  (select transaction_type::text from public.payment_transactions
   where id=(select (result ->> 'payment_transaction_id')::uuid from recorded_receipt_fixture)),
  'manual_payment',
  'immutable human-receipt provenance remains untouched'
);
select is(
  (select count(*)::int from public.monzo_recorded_receipt_links
   where candidate_id=(select (result ->> 'candidate_id')::uuid from recorded_bank_fixture)),
  1,
  'one-to-one link is persisted separately from money'
);
select is(
  (select amount_outstanding from crm_private.invoice_totals(
    (select (result ->> 'invoice_id')::uuid from recorded_invoice_fixture)
  )),
  0::numeric,
  'invoice remains settled after bank evidence is linked'
);
select ok(
  not has_table_privilege('authenticated','public.monzo_recorded_receipt_links','select')
  and has_function_privilege('authenticated','public.link_monzo_recorded_receipt(uuid,uuid)','execute')
  and not has_function_privilege('anon','public.link_monzo_recorded_receipt(uuid,uuid)','execute')
  and not has_function_privilege('service_role','public.link_monzo_recorded_receipt(uuid,uuid)','execute'),
  'bank receipt linking is restricted to CRM human RPC and not direct table/service access'
);

select * from finish();
rollback;
