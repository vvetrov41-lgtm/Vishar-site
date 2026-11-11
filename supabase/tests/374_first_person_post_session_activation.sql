-- Safe metadata-only Meta approval simulation. All changes roll back.
BEGIN;
SELECT no_plan();

SELECT ok(NOT has_function_privilege('anon',
  'crm_private.activate_approved_post_session_v2(uuid)','execute')
 AND NOT has_function_privilege('authenticated',
  'crm_private.activate_approved_post_session_v2(uuid)','execute')
 AND NOT has_function_privilege('service_role',
  'crm_private.activate_approved_post_session_v2(uuid)','execute'),
 'client and service API cannot promote Meta templates');

SELECT is(crm_private.activate_approved_post_session_v2(
 'a1111111-1111-4111-8111-111111111111'::uuid),
 'waiting_for_meta_approval',
 'without verified Meta approval live WhatsApp registry stays untouched');

-- Simulate reviewed identities only in this rollback transaction.
UPDATE crm_private.lifecycle_whatsapp_template_registry
SET approval_status='APPROVED',provider_template_id='123456789012341',
    verified_at=now()
WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid
 AND purpose IN ('post_session_aftercare','post_session_checkin');

UPDATE crm_private.lifecycle_whatsapp_template_candidates
SET approval_status='APPROVED',
    provider_template_id=CASE purpose
      WHEN 'post_session_aftercare' THEN '123456789012342'
      ELSE '123456789012343' END,
    verified_at=now()
WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid
 AND purpose IN ('post_session_aftercare','post_session_checkin');

SELECT is(crm_private.activate_approved_post_session_v2(
 'a1111111-1111-4111-8111-111111111111'::uuid),'activated',
 'both genuinely evidenced-looking fixture identities switch atomically');

SELECT is((SELECT count(*)::integer
 FROM crm_private.lifecycle_whatsapp_template_registry t
 WHERE t.artist_id='a1111111-1111-4111-8111-111111111111'::uuid
   AND t.approval_status='APPROVED'
   AND ((t.purpose='post_session_aftercare'
          AND t.template_name='vishar_lifecycle_aftercare_v2'
          AND t.provider_template_id='123456789012342')
     OR (t.purpose='post_session_checkin'
          AND t.template_name='vishar_lifecycle_checkin_v2'
          AND t.provider_template_id='123456789012343'))),
 2, 'active registry has the exact two first-person Meta identities');

SELECT is((SELECT count(*)::integer
 FROM crm_private.lifecycle_whatsapp_template_candidates c
 WHERE c.artist_id='a1111111-1111-4111-8111-111111111111'::uuid
   AND c.purpose IN ('post_session_aftercare','post_session_checkin')),
 0, 'promoted provider candidates no longer cause duplicate Meta polling');

SELECT is(crm_private.activate_approved_post_session_v2(
 'a1111111-1111-4111-8111-111111111111'::uuid),'already_active',
 'repeated promotion cannot generate messages or mutate identity');

SELECT is((SELECT count(*)::integer
 FROM crm_private.lifecycle_whatsapp_template_registry
 WHERE artist_id='a2222222-2222-4222-8222-222222222222'::uuid
 AND purpose IN ('post_session_aftercare','post_session_checkin')
 AND template_name IN ('vishar_lifecycle_aftercare_v1',
                      'vishar_lifecycle_checkin_v1')),
 2, 'Kristina Meta registry remains unchanged');

SELECT is((SELECT count(*)::integer FROM public.integration_outbox
 WHERE created_at>now()-interval '5 minutes'
   AND kind='whatsapp_message' AND dedupe_key like 'whatsapp:lifecycle:%'),
 0, 'promotion itself never sends or queues a real WhatsApp message');

SELECT * FROM finish();
ROLLBACK;
