-- Post-session first-person activation, Meta approvals simulated only in
-- this rolled-back pgTAP transaction. Never contact Meta or actual clients.
BEGIN;
SELECT no_plan();

SELECT ok(
 NOT has_function_privilege('anon',
   'crm_private.activate_first_person_post_session_whatsapp(uuid)','execute')
 AND NOT has_function_privilege('authenticated',
   'crm_private.activate_first_person_post_session_whatsapp(uuid)','execute')
 AND NOT has_function_privilege('service_role',
   'crm_private.activate_first_person_post_session_whatsapp(uuid)','execute'),
 'no external client/service API role can promote templates directly');

SELECT throws_ok(
  $$SELECT crm_private.activate_first_person_post_session_whatsapp(
    'a2222222-2222-4222-8222-222222222222'::uuid)$$,
  '42501',NULL,
  'Kristina cannot be promoted by the Vladimir-only action');

-- Synthetic current approvals and operational readiness, rolled back.
UPDATE crm_private.lifecycle_whatsapp_delivery_gates
SET enabled=true
WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid;

UPDATE crm_private.lifecycle_whatsapp_template_registry
SET approval_status='APPROVED',
    provider_template_id=CASE purpose
      WHEN 'post_session_aftercare' THEN '888888888881'
      ELSE '888888888882' END,
    verified_at=now()
WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid
  AND purpose IN ('post_session_aftercare','post_session_checkin');

SELECT throws_ok(
  $$SELECT crm_private.activate_first_person_post_session_whatsapp(
    'a1111111-1111-4111-8111-111111111111'::uuid)$$,
  '23514',NULL,
  'unapproved v2 candidates cannot be activated');

SELECT is(
  (SELECT count(*)::integer
   FROM crm_private.lifecycle_whatsapp_template_registry r
   WHERE r.artist_id='a1111111-1111-4111-8111-111111111111'::uuid
     AND r.purpose IN ('post_session_aftercare','post_session_checkin')
     AND r.template_name LIKE '%_v1'),2,
  'failed preflight leaves both old identities unchanged');

CREATE TEMP TABLE post_session_before_send AS
SELECT
 (SELECT count(*) FROM public.communication_messages) AS messages,
 (SELECT count(*) FROM public.integration_outbox) AS outbox,
 (SELECT count(*) FROM public.automation_jobs) AS jobs;
GRANT SELECT ON post_session_before_send TO PUBLIC;

UPDATE crm_private.lifecycle_whatsapp_template_candidates
SET approval_status='APPROVED',
    provider_template_id=CASE purpose
      WHEN 'post_session_aftercare' THEN '999999999991'
      ELSE '999999999992' END,
    verified_at=now()
WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid
  AND purpose IN ('post_session_aftercare','post_session_checkin');

SELECT is(
 crm_private.activate_first_person_post_session_whatsapp(
   'a1111111-1111-4111-8111-111111111111'::uuid),
 'activated','two distinct approved v2 templates are promoted atomically');

SELECT is(
 (SELECT count(*)::integer
  FROM crm_private.lifecycle_whatsapp_template_registry r
  WHERE r.artist_id='a1111111-1111-4111-8111-111111111111'::uuid
    AND r.approval_status='APPROVED'
    AND r.verified_at>now()-interval '24 hours'
    AND ((r.purpose='post_session_aftercare'
          AND r.template_name='vishar_lifecycle_aftercare_v2'
          AND r.provider_template_id='999999999991')
      OR (r.purpose='post_session_checkin'
          AND r.template_name='vishar_lifecycle_checkin_v2'
          AND r.provider_template_id='999999999992'))),
 2,'live registry carries exactly two distinct verified first-person IDs');

SELECT is(
 (SELECT count(*)::integer
  FROM crm_private.lifecycle_whatsapp_template_registry r
  WHERE r.artist_id='a2222222-2222-4222-8222-222222222222'::uuid
    AND r.purpose IN ('post_session_aftercare','post_session_checkin')
    AND r.template_name LIKE '%_v1'),
 2,'Kristina keeps her disabled/unapproved legacy identities');

SELECT is(
 crm_private.activate_first_person_post_session_whatsapp(
   'a1111111-1111-4111-8111-111111111111'::uuid),
 'already_active','activation is safe to retry without modifying routes');

SELECT ok(
 (SELECT count(*) FROM public.communication_messages)=
  (SELECT messages FROM post_session_before_send)
 AND
 (SELECT count(*) FROM public.integration_outbox)=
  (SELECT outbox FROM post_session_before_send)
 AND
 (SELECT count(*) FROM public.automation_jobs)=
  (SELECT jobs FROM post_session_before_send),
 'approval activates only provider identities, with no sends or job replays');

SELECT ok(
 position('vishar_lifecycle_aftercare_v2' in pg_get_functiondef(
   'crm_private.lifecycle_whatsapp_send_ready(uuid,uuid,text)'::regprocedure))>0
 AND position('vishar_lifecycle_checkin_v2' in pg_get_functiondef(
   'public.service_resolve_whatsapp_lifecycle_payload(uuid,text)'::regprocedure))>0
 AND position('jsonb_build_array(v_first)' in pg_get_functiondef(
   'crm_private.queue_lifecycle_whatsapp_job(uuid)'::regprocedure))>0,
 'first-person queue and provider send contracts preserve approved v2 arity');

SELECT * FROM finish();
ROLLBACK;
