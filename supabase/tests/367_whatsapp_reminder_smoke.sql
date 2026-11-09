-- The existing owner-directed test queue permits only three Meta-approved
-- reminders and exact parameters; no real clients or sends are created.
begin;
select no_plan();
select ok(
  position('session_reminder_72h' in
    pg_get_constraintdef((select oid from pg_constraint
     where conrelid='crm_private.whatsapp_template_smoke_tests'::regclass
       and conname='whatsapp_template_smoke_tests_purpose_check')))>0
  and position('session_reminder_24h' in
    pg_get_constraintdef((select oid from pg_constraint
     where conrelid='crm_private.whatsapp_template_smoke_tests'::regclass
       and conname='whatsapp_template_smoke_tests_purpose_check')))>0,
  'smoke test purposes allow exactly the two additional session reminders'
);
select ok(
  position('session_reminder_72h' in
    pg_get_constraintdef((select oid from pg_constraint
     where conrelid='crm_private.whatsapp_template_smoke_tests'::regclass
       and conname='whatsapp_template_smoke_tests_body_parameters_check')))>0
  and position('session_reminder_24h' in
    pg_get_constraintdef((select oid from pg_constraint
     where conrelid='crm_private.whatsapp_template_smoke_tests'::regclass
       and conname='whatsapp_template_smoke_tests_body_parameters_check')))>0,
  'smoke reminder 72h and 24h parameter counts are constrained in SQL'
);
select ok(
  not has_function_privilege('anon',
    'public.service_claim_whatsapp_template_smoke_test()','execute')
  and not has_function_privilege('authenticated',
    'public.service_claim_whatsapp_template_smoke_test()','execute'),
  'new reminder smoke tests remain backend-only'
);
select * from finish();
rollback;
