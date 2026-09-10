-- 999_telegram_enquiry_notification_guardrails.sql
--
-- Regression guard for the enquiry -> internal notification -> Telegram path.
-- The 2026-09-10 incident was caused by treating the membership label
-- `artist` as a delivery capability, which excluded an otherwise fully
-- authorised owner profile. These checks keep routing and recovery on the same
-- effective-access predicate and prevent that role gate from returning.

begin;
select no_plan();

select has_function(
  'crm_private',
  'telegram_notification_recipient_eligible',
  array['uuid', 'uuid', 'uuid'],
  'shared Telegram recipient eligibility predicate exists'
);

select function_returns(
  'crm_private',
  'telegram_notification_recipient_eligible',
  array['uuid', 'uuid', 'uuid'],
  'boolean',
  'shared Telegram recipient eligibility predicate returns boolean'
);

select ok(
  pg_get_functiondef(
    'crm_private.telegram_notification_recipient_eligible(uuid,uuid,uuid)'::regprocedure
  ) ilike '%profile_can_receive_notification%',
  'Telegram recipient eligibility is based on effective CRM access'
);

select ok(
  pg_get_functiondef(
    'crm_private.telegram_notification_recipient_eligible(uuid,uuid,uuid)'::regprocedure
  ) ilike '%telegram_destinations%',
  'Telegram recipient eligibility requires an active destination'
);

select ok(
  pg_get_functiondef(
    'crm_private.telegram_notification_recipient_eligible(uuid,uuid,uuid)'::regprocedure
  ) ilike '%notification_preferences%',
  'Telegram recipient eligibility requires the explicit Telegram preference'
);

select ok(
  pg_get_functiondef(
    'public.service_route_telegram_enquiry_notification(uuid,text)'::regprocedure
  ) ilike '%telegram_notification_recipient_eligible%',
  'normal enquiry routing uses the shared recipient predicate'
);

select ok(
  pg_get_functiondef(
    'public.service_recover_telegram_enquiry_outbox(uuid)'::regprocedure
  ) ilike '%telegram_notification_recipient_eligible%',
  'dead-job recovery uses the same recipient predicate as normal routing'
);

select ok(
  pg_get_functiondef(
    'public.service_route_telegram_enquiry_notification(uuid,text)'::regprocedure
  ) not ilike '%access_level%artist%',
  'normal enquiry routing does not hard-code the artist membership label'
);

select ok(
  pg_get_functiondef(
    'public.service_recover_telegram_enquiry_outbox(uuid)'::regprocedure
  ) not ilike '%access_level%artist%',
  'dead-job recovery does not hard-code the artist membership label'
);

select ok(
  pg_get_functiondef(
    'public.service_route_telegram_enquiry_notification(uuid,text)'::regprocedure
  ) ilike '%on conflict (dedupe_key) do nothing%',
  'enquiry notification materialisation remains idempotent'
);

select ok(
  pg_get_functiondef(
    'public.service_recover_telegram_enquiry_outbox(uuid)'::regprocedure
  ) ilike '%telegram_delivery_evidence_present%',
  'recovery refuses to replay a job that already has delivery evidence'
);

select * from finish(true);
rollback;
