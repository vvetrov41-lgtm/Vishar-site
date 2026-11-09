BEGIN;
SELECT no_plan();
SELECT is((SELECT count(*)::integer FROM crm_private.whatsapp_template_proposals p
 WHERE p.artist_id='a1111111-1111-4111-8111-111111111111'::uuid
  AND p.kind IN ('reminder_24h_button','reminder_consultation_button',
    'reminder_consultation_video')),3,'Three Vladimir reviewed Meta replacements staged');
SELECT is((SELECT count(*)::integer FROM crm_private.whatsapp_template_proposals p
 WHERE p.artist_id='a1111111-1111-4111-8111-111111111111'::uuid
  AND p.kind IN ('reminder_24h_button','reminder_consultation_button',
    'reminder_consultation_video') AND p.approval_status='UNKNOWN'),3,
 'No provider approvals forged');
SELECT is((SELECT count(*)::integer FROM crm_private.whatsapp_template_proposals p
 WHERE p.artist_id='a2222222-2222-4222-8222-222222222222'::uuid
  AND p.kind IN ('reminder_24h_button','reminder_consultation_button',
    'reminder_consultation_video')),0,'Kristina onboarding untouched');
SELECT ok(position('consultation_reminder' in
 pg_get_constraintdef((SELECT oid FROM pg_constraint
  WHERE conrelid='crm_private.whatsapp_template_smoke_tests'::regclass
  AND conname='whatsapp_template_smoke_tests_body_parameters_check')))>0,
 'Existing test queue remains bounded to known purposes');

SELECT is(crm_private.activate_reminder_url_buttons(
  'a1111111-1111-4111-8111-111111111111'::uuid),
  'waiting_for_meta_approval','Cannot switch before real Meta approval');
SELECT throws_ok($$SELECT crm_private.activate_reminder_url_buttons(
  'a2222222-2222-4222-8222-222222222222'::uuid)$$,
  '42501',NULL,'Kristina cannot be promoted');
SELECT ok(
  NOT has_function_privilege('anon',
    'crm_private.activate_reminder_url_buttons(uuid)','execute')
  AND NOT has_function_privilege('service_role',
    'crm_private.activate_reminder_url_buttons(uuid)','execute'),
  'Only a privileged rollout can promote');
UPDATE crm_private.whatsapp_template_proposals
 SET approval_status='APPROVED',
     provider_template_id='123456789123456',verified_at=now()
 WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid
   AND kind IN ('reminder_24h_button','reminder_consultation_button',
                'reminder_consultation_video');
-- Local seed keeps original inactive template names. Only inside
-- this rollback-only test, simulate the two currently active production
-- template identities before the final approval-gated promotion.
UPDATE crm_private.lifecycle_whatsapp_template_registry r
SET template_name=CASE r.purpose
  WHEN 'session_reminder_24h' THEN 'vishar_lifecycle_reminder_24h_v3'
  ELSE 'vishar_lifecycle_consultation_v4' END,
  approval_status='APPROVED',provider_template_id='123456789123456',
  verified_at=now()
WHERE r.artist_id='a1111111-1111-4111-8111-111111111111'::uuid
  AND r.purpose IN ('session_reminder_24h','consultation_reminder');
SELECT is(crm_private.activate_reminder_url_buttons(
  'a1111111-1111-4111-8111-111111111111'::uuid),
  'activated','Rollback-only approvals can promote both purposes');
SELECT is(crm_private.activate_reminder_url_buttons(
  'a1111111-1111-4111-8111-111111111111'::uuid),
  'already_active','Promotion is idempotent');
SELECT is((SELECT count(*)::integer
 FROM crm_private.lifecycle_whatsapp_template_registry
 WHERE artist_id='a2222222-2222-4222-8222-222222222222'::uuid
   AND template_name IN ('vishar_lifecycle_reminder_24h_v4',
                          'vishar_lifecycle_consultation_v5')),0,
 'Kristina delivery remains unchanged');
SELECT ok(position('vishar_lifecycle_consultation_video_v1' in pg_get_functiondef(
 'crm_private.queue_lifecycle_whatsapp_job(uuid)'::regprocedure))>0,
 'Separate no-directions video reminder route exists');
SELECT * FROM finish();
ROLLBACK;
