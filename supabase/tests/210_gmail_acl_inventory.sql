-- 210_gmail_acl_inventory.sql
-- Exact API-role privilege inventory for the Gmail production RPC boundary.
-- This complements the global callable-function allow-list with per-role labels
-- so any future privilege drift identifies the exact function and role.

begin;
select no_plan();

create temporary table gmail_acl_expectations (
  signature text primary key,
  anon_allowed boolean not null,
  authenticated_allowed boolean not null,
  service_role_allowed boolean not null
);

insert into gmail_acl_expectations values
  ('public.gpt_authorize_gmail_enquiry(uuid)', false, true, false),
  ('public.gpt_create_gmail_reply_draft(uuid,uuid,text)', false, true, false),
  ('public.service_resolve_gmail_target(uuid,uuid,uuid)', false, false, true),
  ('public.service_resolve_gmail_outbox_target(uuid,text)', false, false, true),
  ('public.service_set_gmail_integration(uuid,text,text,text[])', false, false, true),
  ('public.service_disable_gmail_integration(uuid,text,text)', false, false, true),
  ('public.service_upsert_gmail_thread_context(uuid,uuid,uuid,text,text,text,text)', false, false, true),
  ('public.service_get_gmail_thread_context(uuid,uuid,uuid,uuid)', false, false, true),
  ('public.claim_email_outbox(text,integer,integer)', false, false, true),
  ('public.record_email_outbox_result(uuid,text,boolean,text,text)', false, false, true);

select is(
  has_function_privilege('anon', signature, 'EXECUTE'),
  anon_allowed,
  signature || ' anon EXECUTE matches the Gmail ACL contract'
) from gmail_acl_expectations order by signature;

select is(
  has_function_privilege('authenticated', signature, 'EXECUTE'),
  authenticated_allowed,
  signature || ' authenticated EXECUTE matches the Gmail ACL contract'
) from gmail_acl_expectations order by signature;

select is(
  has_function_privilege('service_role', signature, 'EXECUTE'),
  service_role_allowed,
  signature || ' service_role EXECUTE matches the Gmail ACL contract'
) from gmail_acl_expectations order by signature;

select * from finish();
rollback;
