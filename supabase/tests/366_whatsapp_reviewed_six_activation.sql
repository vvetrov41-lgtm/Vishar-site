-- Reviewed WhatsApp activation: no messages are sent; all simulated approvals roll back.
BEGIN;
SELECT no_plan();
SELECT is(crm_private.activate_reviewed_whatsapp_six(
 'a1111111-1111-4111-8111-111111111111'::uuid),
 'waiting_for_meta_approval','Clean local DB has no provider approvals and stays unchanged');
SELECT throws_ok($$SELECT crm_private.activate_reviewed_whatsapp_six(
 'a2222222-2222-4222-8222-222222222222'::uuid)$$,
 '42501',NULL,'Kristina cannot be promoted using Vladimir rollout');
SELECT ok(
 NOT has_function_privilege('anon','crm_private.activate_reviewed_whatsapp_six(uuid)','EXECUTE')
 AND NOT has_function_privilege('authenticated','crm_private.activate_reviewed_whatsapp_six(uuid)','EXECUTE')
 AND NOT has_function_privilege('service_role','crm_private.activate_reviewed_whatsapp_six(uuid)','EXECUTE'),
 'Only a privileged release migration can promote templates');
SELECT lives_ok($$DO $body$ BEGIN
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 EXECUTE 'SET LOCAL ROLE service_role';
 PERFORM 1 FROM public.service_claim_whatsapp_template_proposals(12);
 EXECUTE 'RESET ROLE';
END $body$ $$, 'Register candidates without contacting Meta');
UPDATE crm_private.whatsapp_template_proposals p SET
 approval_status='APPROVED',provider_template_id=
 CASE kind WHEN 'booking_tattoo' THEN '1490870826193533'
 WHEN 'booking_consultation' THEN '1485450136791177'
 WHEN 'booking_video' THEN '1430834262545862'
 WHEN 'reminder_72h' THEN '2104018896918004'
 WHEN 'reminder_24h' THEN '1679245973610644'
 WHEN 'reminder_consultation' THEN '1725181715729712' END,
 verified_at=now()
WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid
  AND kind IN ('booking_tattoo','booking_consultation','booking_video',
    'reminder_72h','reminder_24h','reminder_consultation');
UPDATE crm_private.booking_card_artist_settings SET
 whatsapp_enabled=true,whatsapp_tattoo_template_name='booking_card_tattoo_v1',
 whatsapp_consultation_template_name='booking_card_consultation_v1',
 whatsapp_video_template_name='booking_card_video_consultation_v1',
 whatsapp_tattoo_template_status='APPROVED',
 whatsapp_consultation_template_status='APPROVED',
 whatsapp_video_template_status='APPROVED'
WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid;
UPDATE crm_private.lifecycle_whatsapp_template_registry SET
 template_name=CASE purpose
   WHEN 'session_reminder_72h' THEN 'vishar_lifecycle_reminder_72h_v2'
   WHEN 'session_reminder_24h' THEN 'vishar_lifecycle_reminder_24h_v2'
   ELSE 'vishar_lifecycle_consultation_v2' END,
 approval_status='APPROVED',provider_template_id='123456789012345',verified_at=now()
WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid
  AND purpose IN ('session_reminder_72h','session_reminder_24h','consultation_reminder');
SELECT is(crm_private.activate_reviewed_whatsapp_six(
 'a1111111-1111-4111-8111-111111111111'::uuid),
 'activated','Six reviewed, provider-approved templates are activated atomically');
SELECT is((SELECT whatsapp_tattoo_template_name
 FROM crm_private.booking_card_artist_settings
 WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid),
 'booking_card_tattoo_v2','Tattoo booking v2 gets static Get directions + How to prepare URLs');
SELECT is((SELECT whatsapp_video_template_name
 FROM crm_private.booking_card_artist_settings
 WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid),
 'booking_card_video_consultation_v2','Video booking uses headerless v2');
SELECT is((SELECT count(*)::integer
 FROM crm_private.lifecycle_whatsapp_template_registry
 WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid
 AND template_name IN ('vishar_lifecycle_reminder_72h_v3',
                       'vishar_lifecycle_reminder_24h_v3',
                       'vishar_lifecycle_consultation_v4')),3,
 'All three new reminders use provider-approved identities');
SELECT is(crm_private.activate_reviewed_whatsapp_six(
 'a1111111-1111-4111-8111-111111111111'::uuid),
 'already_active','Repeated activation is idempotent');
SELECT ok((SELECT NOT whatsapp_enabled FROM crm_private.booking_card_artist_settings
 WHERE artist_id='a2222222-2222-4222-8222-222222222222'::uuid),
 'Kristina stays disabled');
SELECT ok(
 position('booking_card_tattoo_v2' in pg_get_functiondef(
 'crm_private.create_booking_card_whatsapp(uuid,text,text)'::regprocedure))>0
 AND position('vishar_lifecycle_reminder_24h_v3' in pg_get_functiondef(
 'crm_private.queue_lifecycle_whatsapp_job(uuid)'::regprocedure))>0,
 'SQL composers support reviewed Meta parameter counts');
SELECT * FROM finish();
ROLLBACK;
