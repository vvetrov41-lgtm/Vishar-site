-- 1837_gpt_unified_finance.sql
--
-- Unified GPT v2 Project Finance and Billing & Reconciliation wrappers:
-- closed surface, finance ceiling, human finance capability, record ownership
-- across Artists, and the draft-invoice path through the CRM contracts.

begin;
select no_plan();

select ok(
  (select bool_and(
     has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and not has_function_privilege('anon', p.oid, 'EXECUTE')
     and not has_function_privilege('service_role', p.oid, 'EXECUTE')
     and p.prosecdef)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in (
     'gpt_get_deposit_policy', 'gpt_configure_deposit_policy', 'gpt_preview_project_deposit',
     'gpt_set_project_deposit_override', 'gpt_request_project_deposit', 'gpt_confirm_project_deposit_manually',
     'gpt_request_grouped_session_deposit', 'gpt_list_invoices', 'gpt_get_invoice', 'gpt_create_invoice',
     'gpt_set_invoice_line_item', 'gpt_remove_invoice_line_item', 'gpt_set_invoice_details', 'gpt_issue_invoice',
     'gpt_void_invoice', 'gpt_attach_payment_request_to_invoice', 'gpt_record_invoice_payment',
     'gpt_create_credit_note', 'gpt_attach_monzo_payment_link', 'gpt_list_monzo_destinations',
     'gpt_upsert_monzo_destination', 'gpt_archive_monzo_destination', 'gpt_get_monzo_transfer_settings',
     'gpt_configure_monzo_transfer_settings', 'gpt_list_monzo_reconciliation_candidates',
     'gpt_match_monzo_reconciliation_candidate', 'gpt_ignore_monzo_reconciliation_candidate',
     'gpt_confirm_monzo_reconciliation_candidate')),
  'every finance wrapper is an authenticated-only SECURITY DEFINER function'
);
select ok(
  (select bool_and(
     not has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and not has_function_privilege('anon', p.oid, 'EXECUTE'))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'crm_private'
     and p.proname in ('gpt_finance_project', 'gpt_finance_invoice', 'gpt_finance_payment_request', 'gpt_finance_candidate')),
  'finance ownership helpers are not an API surface'
);

-- ------------------------------------------------------------------ fixtures

insert into auth.users (id, email) values
  ('dd011111-1111-4111-8111-111111111111', 'gpt-finance-owner@example.test'),
  ('dd022222-2222-4222-8222-222222222222', 'gpt-finance-manager@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('dd011111-1111-4111-8111-111111111111', 'gpt-finance-owner@example.test', 'GPT Finance Owner', 'owner', true),
  ('dd022222-2222-4222-8222-222222222222', 'gpt-finance-manager@example.test', 'GPT Finance Manager', 'booking_manager', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level, can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values (
  'dd022222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111', 'manager',
  false, false, true, false, true
);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated;

set local role authenticated;
select pg_temp.claims('{"sub":"dd011111-1111-4111-8111-111111111111","role":"authenticated"}');
select public.configure_gpt_action_client('vishar-unified-gpt', 'oauth-unified-finance', true, true);
select public.configure_gpt_enquiry_read_access('vishar-unified-gpt', true);
select public.configure_gpt_full_management('vishar-unified-gpt', true, false, false);

create temporary table fin_vladimir as
select public.create_manual_enquiry(
  'dd031111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
  jsonb_build_object('full_name', 'Finance Vladimir Client', 'email', 'finance-vladimir@example.test'),
  jsonb_build_object('project_type', 'Realism', 'placement', 'Back', 'idea', 'Synthetic finance fixture'),
  true) as result;
create temporary table fin_kristina as
select public.create_manual_enquiry(
  'dd032222-2222-4222-8222-222222222222', 'a2222222-2222-4222-8222-222222222222',
  jsonb_build_object('full_name', 'Finance Kristina Client', 'email', 'finance-kristina@example.test'),
  jsonb_build_object('project_type', 'Fine line', 'placement', 'Wrist', 'idea', 'Synthetic finance fixture'),
  true) as result;
select public.transition_enquiry_status((select (result ->> 'enquiry_id')::uuid from fin_vladimir), 'accepted');
select public.transition_enquiry_status((select (result ->> 'enquiry_id')::uuid from fin_kristina), 'accepted');
create temporary table fin_project_v as
select public.convert_enquiry_to_project((select (result ->> 'enquiry_id')::uuid from fin_vladimir), 'Finance V', null) as result;
create temporary table fin_project_k as
select public.convert_enquiry_to_project((select (result ->> 'enquiry_id')::uuid from fin_kristina), 'Finance K', null) as result;
create temporary table fin_invoice_k as
select public.create_invoice((select (result ->> 'project_id')::uuid from fin_project_k),
  'dd041111-1111-4111-8111-111111111111', null, 'Kristina draft') as result;
grant select on fin_vladimir, fin_kristina, fin_project_v, fin_project_k, fin_invoice_k to authenticated;

-- ---------------------------------------------------- finance ceiling is off

select pg_temp.claims('{"sub":"dd011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-finance"}');
select public.gpt_artist_context('a1111111-1111-4111-8111-111111111111');
select throws_ok(
  $$select public.gpt_list_invoices(null, null, null, 10)$$,
  '42501', null,
  'invoices stay closed while the unified client has no finance ceiling'
);
select throws_ok(
  $$select public.gpt_get_deposit_policy()$$,
  '42501', null,
  'deposit policy reads need the finance ceiling too'
);

select pg_temp.claims('{"sub":"dd011111-1111-4111-8111-111111111111","role":"authenticated"}');
select public.configure_gpt_full_management('vishar-unified-gpt', true, true, false);
select pg_temp.claims('{"sub":"dd011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-finance"}');

-- ------------------------------------------------------------ happy path (V)

select lives_ok($$select public.gpt_get_deposit_policy()$$, 'deposit policy reads with the finance ceiling');
select lives_ok(
  $$select public.gpt_configure_deposit_policy('fixed', 100, null, null, 1)$$,
  'the owner configures a fixed project deposit through the CRM contract'
);
select lives_ok(
  $$select public.gpt_preview_project_deposit((select (result ->> 'project_id')::uuid from fin_project_v))$$,
  'project deposit preview for the active Artist'
);

create temporary table fin_invoice_v as
select public.gpt_create_invoice((select (result ->> 'project_id')::uuid from fin_project_v),
  'dd042222-2222-4222-8222-222222222222', null, 'Vladimir draft') as result;
grant select on fin_invoice_v to authenticated;
select ok((select result ? 'invoice_id' or result ? 'id' from fin_invoice_v), 'a draft invoice is created for the Vladimir project');

select lives_ok(
  $$select public.gpt_set_invoice_line_item(
      coalesce((select (result ->> 'invoice_id')::uuid from fin_invoice_v), (select (result ->> 'id')::uuid from fin_invoice_v)),
      'Tattoo session', 1, 400)$$,
  'a line is added to the draft invoice'
);
select ok(
  jsonb_typeof(public.gpt_list_invoices(null, null, null, 10)) in ('array', 'object'),
  'invoices list for the active Artist'
);
select ok(
  not (public.gpt_list_invoices(null, null, null, 100)::text like '%Kristina draft%'),
  'the Vladimir context never lists a Kristina invoice'
);
select lives_ok($$select public.gpt_list_monzo_reconciliation_candidates()$$, 'Monzo reconciliation queue reads');
select lives_ok($$select public.gpt_list_monzo_destinations()$$, 'Monzo destinations read');

-- --------------------------------------------------- cross-Artist ownership

select throws_ok(
  $$select public.gpt_get_invoice(coalesce((select (result ->> 'invoice_id')::uuid from fin_invoice_k), (select (result ->> 'id')::uuid from fin_invoice_k)))$$,
  '42501', null,
  'a Kristina invoice cannot be read in the Vladimir context'
);
select throws_ok(
  $$select public.gpt_issue_invoice(coalesce((select (result ->> 'invoice_id')::uuid from fin_invoice_k), (select (result ->> 'id')::uuid from fin_invoice_k)), null)$$,
  '42501', null,
  'a Kristina invoice cannot be issued in the Vladimir context'
);
select throws_ok(
  $$select public.gpt_create_invoice((select (result ->> 'project_id')::uuid from fin_project_k), 'dd043333-3333-4333-8333-333333333333', null, null)$$,
  '42501', null,
  'an invoice cannot be created on a Kristina project from the Vladimir context'
);
select throws_ok(
  $$select public.gpt_request_project_deposit((select (result ->> 'project_id')::uuid from fin_project_k), 'dd044444-4444-4444-8444-444444444444', 'copy_link')$$,
  '42501', null,
  'a deposit cannot be requested on a Kristina project from the Vladimir context'
);
select throws_ok(
  $$select public.gpt_ignore_monzo_reconciliation_candidate('dd059999-9999-4999-8999-999999999999')$$,
  '42501', null,
  'an unknown reconciliation candidate is refused as out of scope, not guessed'
);
select throws_ok(
  $$select public.gpt_request_grouped_session_deposit(array['dd069999-9999-4999-8999-999999999999']::uuid[], 'dd045555-5555-4555-8555-555555555555', 'copy_link')$$,
  '42501', null,
  'a grouped deposit refuses any session outside the active Artist'
);

-- ------------------------------------------- the human finance capability

select pg_temp.claims('{"sub":"dd022222-2222-4222-8222-222222222222","role":"authenticated","client_id":"oauth-unified-finance"}');
select throws_ok(
  $$select public.gpt_list_invoices(null, null, null, 10)$$,
  '42501', null,
  'a manager without CRM finance access cannot read invoices through the GPT'
);

select * from finish();
rollback;
