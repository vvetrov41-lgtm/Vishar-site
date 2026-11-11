-- All fixtures are metadata-only. No production client or provider send.
BEGIN;
SELECT no_plan();

SELECT is(
 (SELECT count(*)::integer
  FROM crm_private.lifecycle_whatsapp_template_candidates c
  WHERE c.purpose='post_session_aftercare'
    AND c.template_name='vishar_lifecycle_aftercare_v2'
    AND c.artist_id IN ('a1111111-1111-4111-8111-111111111111'::uuid,
                        'a2222222-2222-4222-8222-222222222222'::uuid)),
 2, 'v2 aftercare candidates are staged for both artists');

SELECT is(
 (SELECT count(*)::integer
  FROM crm_private.lifecycle_whatsapp_template_candidates c
  WHERE c.purpose='post_session_checkin'
    AND c.template_name='vishar_lifecycle_checkin_v2'
    AND c.artist_id IN ('a1111111-1111-4111-8111-111111111111'::uuid,
                        'a2222222-2222-4222-8222-222222222222'::uuid)),
 2, 'v2 check-in candidates are staged for both artists');

SELECT is(
 (SELECT count(*)::integer
  FROM crm_private.lifecycle_whatsapp_template_candidates c
  WHERE c.template_name IN ('vishar_lifecycle_aftercare_v2',
                            'vishar_lifecycle_checkin_v2')
    AND c.approval_status='UNKNOWN'
    AND c.provider_template_id IS NULL),
 4, 'no Meta approval is fabricated');

SELECT is(
 (SELECT count(*)::integer
  FROM crm_private.lifecycle_whatsapp_template_registry r
  WHERE (r.purpose='post_session_aftercare'
          AND r.template_name='vishar_lifecycle_aftercare_v1')
     OR (r.purpose='post_session_checkin'
          AND r.template_name='vishar_lifecycle_checkin_v1')),
 4, 'existing Meta v1 registry identity is unchanged');

SELECT ok(
 position('vishar_lifecycle_aftercare_v1' in
   pg_get_functiondef(
     'crm_private.lifecycle_whatsapp_send_ready(uuid,uuid,text)'::regprocedure))=0
 AND position('vishar_lifecycle_checkin_v1' in
   pg_get_functiondef(
     'crm_private.lifecycle_whatsapp_send_ready(uuid,uuid,text)'::regprocedure))=0
 AND position('vishar_lifecycle_aftercare_v2' in
   pg_get_functiondef(
     'crm_private.lifecycle_whatsapp_send_ready(uuid,uuid,text)'::regprocedure))>0,
 'first-person readiness allowlist excludes legacy third-person post-session v1');

SELECT ok(
 position('vishar_lifecycle_aftercare_v2' in
   pg_get_functiondef(
     'crm_private.queue_lifecycle_whatsapp_job(uuid)'::regprocedure))>0
 AND position('vishar_lifecycle_checkin_v2' in
   pg_get_functiondef(
     'crm_private.queue_lifecycle_whatsapp_job(uuid)'::regprocedure))>0,
 'future approved v2 uses the single-name provider arity');

SELECT ok(
 position('vishar_lifecycle_reminder_72h_v4' in
   pg_get_functiondef(
     'crm_private.lifecycle_whatsapp_send_ready(uuid,uuid,text)'::regprocedure))>0
 AND position('vishar_lifecycle_reminder_72h_v1' in
   pg_get_functiondef(
     'crm_private.lifecycle_whatsapp_send_ready(uuid,uuid,text)'::regprocedure))=0,
 'first-person 72h reminders remain allowed; third-person v1 is excluded');

SELECT ok(
 NOT has_function_privilege('anon',
   'crm_private.lifecycle_whatsapp_send_ready(uuid,uuid,text)','execute')
 AND NOT has_function_privilege('authenticated',
   'crm_private.queue_lifecycle_whatsapp_job(uuid)','execute'),
 'public clients cannot call guarded backend routing');

SELECT * FROM finish();
ROLLBACK;
