-- The prepared sender allowlist cannot activate an unapproved Meta template.
-- No production clients or synthetic appointments; pgTAP rolls everything back.
BEGIN;
SELECT plan(8);

SELECT ok(
  has_function_privilege('postgres',
    'crm_private.activate_reminder_72h_cash_v5(uuid)','execute'),
  'operator has a controlled activation function');

SELECT ok(
  NOT has_function_privilege('anon',
    'crm_private.activate_reminder_72h_cash_v5(uuid)','execute')
  AND NOT has_function_privilege('authenticated',
    'crm_private.activate_reminder_72h_cash_v5(uuid)','execute')
  AND NOT has_function_privilege('service_role',
    'crm_private.activate_reminder_72h_cash_v5(uuid)','execute'),
  'browser and backend service cannot unilaterally promote a Meta template');

SELECT throws_ok(
  $$SELECT crm_private.activate_reminder_72h_cash_v5(
    'a2222222-2222-4222-8222-222222222222'::uuid)$$,
  '42501',NULL,'activation never targets Kristina');

SELECT is(
  (SELECT crm_private.activate_reminder_72h_cash_v5(
    'a1111111-1111-4111-8111-111111111111'::uuid)),
  'waiting_for_meta_approval'::text,
  'unapproved Meta candidate is not promoted');

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM crm_private.lifecycle_whatsapp_template_registry
    WHERE template_name='vishar_lifecycle_reminder_72h_v5'
  ),'new 72h Meta identity remains inactive after a guarded no-op');

SELECT ok(
  position('vishar_lifecycle_reminder_72h_v5' in
    pg_get_functiondef('crm_private.queue_lifecycle_whatsapp_job(uuid)'::regprocedure))>0,
  'job queue accepts the new identity only when registry is promoted');

SELECT ok(
  position('vishar_lifecycle_reminder_72h_v5' in
    pg_get_functiondef('crm_private.lifecycle_whatsapp_send_ready(uuid,uuid,text)'::regprocedure))>0,
  'sender readiness explicitly checks the new identity');

SELECT ok(
  position('vishar_lifecycle_reminder_72h_v5' in
    pg_get_functiondef('public.service_resolve_whatsapp_lifecycle_payload(uuid,text)'::regprocedure))>0,
  'provider payload identity remains strictly allowlisted');

SELECT * FROM finish(true);
ROLLBACK;
