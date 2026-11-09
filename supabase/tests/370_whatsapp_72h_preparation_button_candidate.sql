BEGIN;
SELECT no_plan();

SELECT is((SELECT count(*)::integer
  FROM crm_private.whatsapp_template_proposals
  WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid
    AND kind='reminder_72h_button'
    AND template_name='vishar_lifecycle_reminder_72h_v4'),1,
  'One new Vladimir-only three-button candidate is staged');
SELECT is((SELECT approval_status
  FROM crm_private.whatsapp_template_proposals
  WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid
    AND kind='reminder_72h_button'),'UNKNOWN',
  'Meta approval is not fabricated by the migration');
SELECT is((SELECT count(*)::integer
  FROM crm_private.whatsapp_template_proposals
  WHERE artist_id='a2222222-2222-4222-8222-222222222222'::uuid
    AND kind='reminder_72h_button'),0,
  'Kristina onboarding remains untouched');
SELECT is(crm_private.activate_reminder_72h_preparation_button(
  'a1111111-1111-4111-8111-111111111111'::uuid),
  'waiting_for_meta_approval',
  'Cannot activate before genuine Meta approval');
SELECT throws_ok(
 $$SELECT crm_private.activate_reminder_72h_preparation_button(
  'a2222222-2222-4222-8222-222222222222'::uuid)$$,
 '42501',NULL,'Another artist cannot activate Vladimir template');
SELECT ok(
 NOT has_function_privilege('anon',
 'crm_private.activate_reminder_72h_preparation_button(uuid)','execute')
 AND NOT has_function_privilege('service_role',
 'crm_private.activate_reminder_72h_preparation_button(uuid)','execute'),
 'Promotion is operator-only');
SELECT ok(position('vishar_lifecycle_reminder_72h_v4' IN
 pg_get_functiondef('crm_private.queue_lifecycle_whatsapp_job(uuid)'::regprocedure))>0,
 'Sender database path recognises the new 72h action-capable identity');

-- Rollback-only simulation: never write a false approval to production.
UPDATE crm_private.whatsapp_template_proposals
 SET approval_status='APPROVED',
     provider_template_id='123456789012345',
     verified_at=now()
 WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid
   AND kind='reminder_72h_button';
UPDATE crm_private.lifecycle_whatsapp_template_registry
 SET template_name='vishar_lifecycle_reminder_72h_v3',
     approval_status='APPROVED',
     provider_template_id='123456789012345',
     verified_at=now()
 WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid
   AND purpose='session_reminder_72h';
SELECT is(crm_private.activate_reminder_72h_preparation_button(
  'a1111111-1111-4111-8111-111111111111'::uuid),
  'activated','A valid recent provider approval can activate v4');
SELECT is((SELECT template_name
  FROM crm_private.lifecycle_whatsapp_template_registry
  WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid
    AND purpose='session_reminder_72h'),
  'vishar_lifecycle_reminder_72h_v4',
  '72h registry uses the reviewed third-button identity');
SELECT is(crm_private.activate_reminder_72h_preparation_button(
  'a1111111-1111-4111-8111-111111111111'::uuid),
  'already_active','Promotion is idempotent');
SELECT is((SELECT count(*)::integer
  FROM crm_private.lifecycle_whatsapp_template_registry
  WHERE artist_id='a2222222-2222-4222-8222-222222222222'::uuid
    AND template_name='vishar_lifecycle_reminder_72h_v4'),0,
  'Other artists have not been switched');

SELECT * FROM finish();
ROLLBACK;
