-- Promote Vladimir's Meta-APPROVED first-person aftercare and 24h check-in.
-- Never send clients, replay history, change times, or affect Kristina.
-- The immutable provider-approved v1 texts remain blocked as fallback.
CREATE OR REPLACE FUNCTION crm_private.activate_approved_post_session_v2(p_artist_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO pg_catalog,public,crm_private
AS $promote$
DECLARE
 v_count integer;
 v_changed integer;
BEGIN
 IF p_artist_id IS DISTINCT FROM 'a1111111-1111-4111-8111-111111111111'::uuid
   OR NOT EXISTS (SELECT 1 FROM public.artists a
     WHERE a.id=p_artist_id AND a.slug='vladimir')
 THEN RAISE EXCEPTION 'unapproved post-session artist' USING errcode='42501';
 END IF;

 -- Guard the source functions before promoting a provider identity.
 IF position('vishar_lifecycle_aftercare_v2' in pg_get_functiondef(
     'crm_private.lifecycle_whatsapp_send_ready(uuid,uuid,text)'::regprocedure))=0
    OR position('vishar_lifecycle_checkin_v2' in pg_get_functiondef(
     'crm_private.queue_lifecycle_whatsapp_job(uuid)'::regprocedure))=0
    OR position('vishar_lifecycle_aftercare_v2' in pg_get_functiondef(
     'public.service_resolve_whatsapp_lifecycle_payload(uuid,text)'::regprocedure))=0
 THEN RAISE EXCEPTION 'first-person Meta sender not active' USING errcode='23514';
 END IF;

 -- Enqueue reads the registry without a row lock. Serialize the cutover
 -- against old and new scheduler transactions with ACCESS EXCLUSIVE first.
 LOCK TABLE crm_private.lifecycle_whatsapp_template_registry
   IN ACCESS EXCLUSIVE MODE;
 PERFORM 1 FROM crm_private.lifecycle_whatsapp_template_registry t
   WHERE t.artist_id=p_artist_id
     AND t.purpose IN ('post_session_aftercare','post_session_checkin')
   FOR UPDATE;
 PERFORM 1 FROM crm_private.lifecycle_whatsapp_template_candidates c
   WHERE c.artist_id=p_artist_id
     AND c.purpose IN ('post_session_aftercare','post_session_checkin')
   FOR UPDATE;

 SELECT count(*) INTO v_count
 FROM crm_private.lifecycle_whatsapp_template_registry t
 WHERE t.artist_id=p_artist_id
   AND t.approval_status='APPROVED'
   AND t.provider_template_id ~ '^[0-9]{5,32}$'
   AND ((t.purpose='post_session_aftercare' AND t.template_name='vishar_lifecycle_aftercare_v2')
     OR (t.purpose='post_session_checkin' AND t.template_name='vishar_lifecycle_checkin_v2'));
 IF v_count=2 THEN RETURN 'already_active'; END IF;

 SELECT count(*) INTO v_count
 FROM crm_private.lifecycle_whatsapp_template_candidates c
 WHERE c.artist_id=p_artist_id
   AND c.template_language='en_GB'
   AND c.approval_status='APPROVED'
   AND c.provider_template_id ~ '^[0-9]{5,32}$'
   AND c.verified_at>now()-interval '24 hours'
   AND ((c.purpose='post_session_aftercare' AND c.template_name='vishar_lifecycle_aftercare_v2')
     OR (c.purpose='post_session_checkin' AND c.template_name='vishar_lifecycle_checkin_v2'));
 IF v_count<>2 THEN RETURN 'waiting_for_meta_approval'; END IF;

 SELECT count(*) INTO v_count
 FROM crm_private.lifecycle_whatsapp_template_registry t
 WHERE t.artist_id=p_artist_id
   AND t.template_language='en_GB'
   AND t.approval_status='APPROVED'
   AND t.provider_template_id ~ '^[0-9]{5,32}$'
   AND ((t.purpose='post_session_aftercare' AND t.template_name='vishar_lifecycle_aftercare_v1')
     OR (t.purpose='post_session_checkin' AND t.template_name='vishar_lifecycle_checkin_v1'));
 IF v_count<>2 THEN RAISE EXCEPTION 'post-session active registry drift'
   USING errcode='23514'; END IF;

 -- Never invalidate a pending Meta send, even if it still references v1.
 IF EXISTS (
   SELECT 1 FROM crm_private.lifecycle_whatsapp_payloads p
   JOIN public.integration_outbox o
     ON o.communication_message_id=p.communication_message_id
   WHERE p.artist_id=p_artist_id
     AND p.purpose IN ('post_session_aftercare','post_session_checkin')
     AND o.status IN ('pending','leased')
 ) THEN RAISE EXCEPTION 'post-session WhatsApp outbox not drained'
   USING errcode='23514'; END IF;

 UPDATE crm_private.lifecycle_whatsapp_template_registry t
 SET template_name=c.template_name,template_language=c.template_language,
     approval_status=c.approval_status,provider_template_id=c.provider_template_id,
     verified_at=c.verified_at,next_retry_at=null,last_failure_code=null,
     updated_at=now()
 FROM crm_private.lifecycle_whatsapp_template_candidates c
 WHERE t.artist_id=p_artist_id AND c.artist_id=t.artist_id
   AND t.purpose=c.purpose
   AND ((t.purpose='post_session_aftercare' AND c.template_name='vishar_lifecycle_aftercare_v2')
     OR (t.purpose='post_session_checkin' AND c.template_name='vishar_lifecycle_checkin_v2'))
   AND c.approval_status='APPROVED';
 GET DIAGNOSTICS v_changed=ROW_COUNT;
 IF v_changed<>2 THEN RAISE EXCEPTION 'incomplete post-session template promotion'
   USING errcode='23514'; END IF;

 -- Promoted identities are now polled via the active registry; avoid
 -- duplicate Meta maintenance claims from candidate shadows.
 DELETE FROM crm_private.lifecycle_whatsapp_template_candidates c
 WHERE c.artist_id=p_artist_id
   AND ((c.purpose='post_session_aftercare' AND c.template_name='vishar_lifecycle_aftercare_v2')
     OR (c.purpose='post_session_checkin' AND c.template_name='vishar_lifecycle_checkin_v2'));
 GET DIAGNOSTICS v_changed=ROW_COUNT;
 IF v_changed<>2 THEN RAISE EXCEPTION 'post-session candidate cleanup drift'
   USING errcode='23514'; END IF;

 RETURN 'activated';
END;
$promote$;

REVOKE ALL ON FUNCTION crm_private.activate_approved_post_session_v2(uuid)
  FROM PUBLIC,anon,authenticated,service_role;

-- CI: UNKNOWN candidate rows mean safe no-op, without synthetic approvals.
-- Production: only genuine recently verified Meta-approved candidates can move.
SELECT crm_private.activate_approved_post_session_v2(
 'a1111111-1111-4111-8111-111111111111'::uuid
);
