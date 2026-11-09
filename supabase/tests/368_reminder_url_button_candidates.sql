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
SELECT * FROM finish();
ROLLBACK;
