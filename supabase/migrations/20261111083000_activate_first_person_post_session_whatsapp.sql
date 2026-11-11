-- Promote two genuine Meta-approved first-person WhatsApp post-session
-- templates for Vladimir only. Kristina remains disabled until onboarding.
-- Registry-only change: no client message, appointment, booking, payment,
-- outbox, lifecycle job or provider-facing request is created/replayed.
CREATE OR REPLACE FUNCTION crm_private.activate_first_person_post_session_whatsapp(
  p_artist_id uuid
)
RETURNS text
LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO pg_catalog,public,crm_private
AS $activation$
DECLARE
  v_legacy integer;
  v_approved integer;
  v_updated integer;
  v_signature text;
BEGIN
  IF p_artist_id IS DISTINCT FROM 'a1111111-1111-4111-8111-111111111111'::uuid
     OR NOT EXISTS (
       SELECT 1 FROM public.artists a
       WHERE a.id=p_artist_id AND a.slug='vladimir'
     ) THEN
    RAISE EXCEPTION 'Only Vladimir may activate approved post-session v2'
      USING errcode='42501';
  END IF;

  -- Serialize provider identity swaps against enqueue/dequeue, without
  -- ever marking a pending notification as sent.
  LOCK TABLE crm_private.lifecycle_whatsapp_template_registry,
     crm_private.lifecycle_whatsapp_template_candidates,
     crm_private.lifecycle_whatsapp_delivery_gates,
     crm_private.lifecycle_whatsapp_payloads,
     public.integration_outbox IN SHARE ROW EXCLUSIVE MODE;

  IF NOT EXISTS (
    SELECT 1 FROM crm_private.lifecycle_whatsapp_delivery_gates g
    WHERE g.artist_id=p_artist_id AND g.enabled
  ) THEN RAISE EXCEPTION 'WhatsApp lifecycle delivery gate disabled'
       USING errcode='23514'; END IF;

  -- Safe idempotency, but never reinterpret a mixed or unexpected identity.
  IF (SELECT count(*) FROM crm_private.lifecycle_whatsapp_template_registry r
      WHERE r.artist_id=p_artist_id
        AND ((r.purpose='post_session_aftercare'
          AND r.template_name='vishar_lifecycle_aftercare_v2')
         OR (r.purpose='post_session_checkin'
          AND r.template_name='vishar_lifecycle_checkin_v2'))
        AND r.approval_status='APPROVED'
        AND r.provider_template_id ~ '^[0-9]{5,32}$'
        AND r.template_language='en_GB') = 2 THEN
    RETURN 'already_active';
  END IF;

  SELECT count(*) INTO v_legacy
  FROM crm_private.lifecycle_whatsapp_template_registry r
  WHERE r.artist_id=p_artist_id
    AND r.template_language='en_GB'
    AND r.approval_status='APPROVED'
    AND r.provider_template_id ~ '^[0-9]{5,32}$'
    AND ((r.purpose='post_session_aftercare'
         AND r.template_name='vishar_lifecycle_aftercare_v1')
      OR (r.purpose='post_session_checkin'
         AND r.template_name='vishar_lifecycle_checkin_v1'));
  IF v_legacy<>2 THEN
    RAISE EXCEPTION 'Unexpected pre-activation post-session identities'
      USING errcode='23514';
  END IF;

  SELECT count(*) INTO v_approved
  FROM crm_private.lifecycle_whatsapp_template_candidates c
  WHERE c.artist_id=p_artist_id
    AND c.template_language='en_GB'
    AND c.approval_status='APPROVED'
    AND c.provider_template_id ~ '^[0-9]{5,32}$'
    AND c.verified_at>now()-interval '24 hours'
    AND c.verified_at<=now()+interval '5 minutes'
    AND ((c.purpose='post_session_aftercare'
         AND c.template_name='vishar_lifecycle_aftercare_v2')
      OR (c.purpose='post_session_checkin'
         AND c.template_name='vishar_lifecycle_checkin_v2'));
  IF v_approved<>2 THEN
    RAISE EXCEPTION 'Both first-person templates require fresh Meta approval'
      USING errcode='23514';
  END IF;

  IF (SELECT count(DISTINCT c.provider_template_id)
      FROM crm_private.lifecycle_whatsapp_template_candidates c
      WHERE c.artist_id=p_artist_id
        AND c.purpose IN ('post_session_aftercare','post_session_checkin'))<>2 THEN
    RAISE EXCEPTION 'Post-session approved identities are not distinct'
      USING errcode='23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM crm_private.lifecycle_whatsapp_payloads p
    JOIN public.integration_outbox o ON o.communication_message_id=p.communication_message_id
    WHERE p.artist_id=p_artist_id
      AND p.purpose IN ('post_session_aftercare','post_session_checkin')
      AND o.status IN ('pending','leased')
  ) THEN
    RAISE EXCEPTION 'In-flight post-session WhatsApp payloads require reconciliation'
      USING errcode='23514';
  END IF;

  -- Worker's one-parameter v2 composer and provider boundary were already
  -- tested and deployed in the prior release. Never promote if that drifted.
  v_signature:=pg_get_functiondef(
    'crm_private.queue_lifecycle_whatsapp_job(uuid)'::regprocedure);
  IF position('vishar_lifecycle_aftercare_v2' in v_signature)=0
     OR position('vishar_lifecycle_checkin_v2' in v_signature)=0
     OR position('jsonb_build_array(v_first)' in v_signature)=0
     OR position('Explicit first-person allowlist' in pg_get_functiondef(
       'crm_private.lifecycle_whatsapp_send_ready(uuid,uuid,text)'::regprocedure))=0
     OR position('vishar_lifecycle_checkin_v2' in pg_get_functiondef(
       'public.service_resolve_whatsapp_lifecycle_payload(uuid,text)'::regprocedure))=0
  THEN RAISE EXCEPTION 'First-person sender preflight contract drifted'
       USING errcode='23514'; END IF;

  UPDATE crm_private.lifecycle_whatsapp_template_registry r
  SET template_name=c.template_name,
      template_language=c.template_language,
      approval_status=c.approval_status,
      provider_template_id=c.provider_template_id,
      verified_at=c.verified_at,
      next_retry_at=NULL,
      last_failure_code=NULL,
      updated_at=now()
  FROM crm_private.lifecycle_whatsapp_template_candidates c
  WHERE r.artist_id=p_artist_id
    AND c.artist_id=r.artist_id
    AND c.purpose=r.purpose
    AND ((r.purpose='post_session_aftercare'
          AND r.template_name='vishar_lifecycle_aftercare_v1'
          AND c.template_name='vishar_lifecycle_aftercare_v2')
      OR (r.purpose='post_session_checkin'
          AND r.template_name='vishar_lifecycle_checkin_v1'
          AND c.template_name='vishar_lifecycle_checkin_v2'))
    AND c.approval_status='APPROVED'
    AND c.verified_at>now()-interval '24 hours';
  GET DIAGNOSTICS v_updated=ROW_COUNT;
  IF v_updated<>2 THEN
    RAISE EXCEPTION 'Post-session provider promotion raced with another writer'
      USING errcode='23514';
  END IF;
  RETURN 'activated';
END;
$activation$;

REVOKE ALL ON FUNCTION crm_private.activate_first_person_post_session_whatsapp(uuid)
FROM PUBLIC,anon,authenticated,service_role;

DO $apply$
DECLARE v_result text;
BEGIN
  -- Canonical clean CI DB has no actual client sessions. Keep it inert there,
  -- and test the activation helper separately with rollback-only approvals.
  IF NOT EXISTS (
    SELECT 1 FROM public.sessions s
    WHERE s.artist_id='a1111111-1111-4111-8111-111111111111'::uuid
  ) THEN RETURN; END IF;

  v_result:=crm_private.activate_first_person_post_session_whatsapp(
    'a1111111-1111-4111-8111-111111111111'::uuid);
  IF v_result<>'activated' THEN
    RAISE EXCEPTION 'Unexpected post-session activation outcome: %',v_result
      USING errcode='23514';
  END IF;
END;
$apply$;
