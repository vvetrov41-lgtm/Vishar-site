-- Permit one new Meta-approved 72h reminder identity for Vladimir only.
-- This migration DOES NOT switch the active registry or send any message.
-- Activation is a separate operator-only, guarded step after genuine Meta APPROVED.

DO $allowlist$
DECLARE
  v_signature text;
  v_source text;
  v_old text := '''vishar_lifecycle_reminder_72h_v4''';
  v_new text := '''vishar_lifecycle_reminder_72h_v4'',''vishar_lifecycle_reminder_72h_v5''';
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'crm_private.queue_lifecycle_whatsapp_job(uuid)',
    'crm_private.lifecycle_whatsapp_send_ready(uuid,uuid,text)',
    'public.service_resolve_whatsapp_lifecycle_payload(uuid,text)'
  ] LOOP
    SELECT pg_get_functiondef(v_signature::regprocedure) INTO v_source;
    IF v_source IS NULL
      OR (length(v_source)-length(replace(v_source,v_old,'')))<>length(v_old)
      OR v_source LIKE '%vishar_lifecycle_reminder_72h_v5%'
    THEN
      RAISE EXCEPTION '72h approved template allowlist drift in %',v_signature
        USING errcode='23514';
    END IF;
    EXECUTE replace(v_source,v_old,v_new);
  END LOOP;
END;
$allowlist$;

CREATE OR REPLACE FUNCTION crm_private.activate_reminder_72h_cash_v5(p_artist_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO pg_catalog,public,crm_private
AS $activate$
DECLARE v_candidate crm_private.whatsapp_template_proposals%rowtype;
BEGIN
  IF p_artist_id IS DISTINCT FROM 'a1111111-1111-4111-8111-111111111111'::uuid
    OR NOT EXISTS (
      SELECT 1 FROM public.artists
      WHERE id=p_artist_id AND slug='vladimir' AND is_active
    )
  THEN
    RAISE EXCEPTION 'Only Vladimir 72h cash reminder may be activated'
      USING errcode='42501';
  END IF;

  LOCK TABLE crm_private.whatsapp_template_proposals,
    crm_private.lifecycle_whatsapp_template_registry,
    public.integration_outbox IN SHARE ROW EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1 FROM crm_private.lifecycle_whatsapp_template_registry
    WHERE artist_id=p_artist_id AND purpose='session_reminder_72h'
      AND template_name='vishar_lifecycle_reminder_72h_v5'
      AND approval_status='APPROVED' AND provider_template_id IS NOT NULL
  ) THEN RETURN 'already_active'; END IF;

  SELECT * INTO v_candidate
  FROM crm_private.whatsapp_template_proposals p
  WHERE p.artist_id=p_artist_id
    AND p.kind='reminder_72h_cash'
    AND p.template_name='vishar_lifecycle_reminder_72h_v5'
    AND p.template_language='en_GB';

  IF NOT FOUND OR v_candidate.approval_status<>'APPROVED'
    OR coalesce(v_candidate.provider_template_id,'') !~ '^[0-9]{5,32}$'
    OR v_candidate.verified_at IS NULL
    OR v_candidate.verified_at<=now()-interval '24 hours'
  THEN RETURN 'waiting_for_meta_approval'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM crm_private.lifecycle_whatsapp_template_registry
    WHERE artist_id=p_artist_id AND purpose='session_reminder_72h'
      AND template_name='vishar_lifecycle_reminder_72h_v4'
      AND template_language='en_GB'
      AND approval_status='APPROVED' AND provider_template_id IS NOT NULL
  ) THEN RETURN 'active_template_drift'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.integration_outbox
    WHERE artist_id=p_artist_id AND kind='whatsapp_message'
      AND status IN ('pending','leased')
  ) THEN RETURN 'outbox_not_drained'; END IF;

  UPDATE crm_private.lifecycle_whatsapp_template_registry r
  SET template_name=v_candidate.template_name,
      template_language=v_candidate.template_language,
      approval_status=v_candidate.approval_status,
      provider_template_id=v_candidate.provider_template_id,
      verified_at=v_candidate.verified_at,
      updated_at=now()
  WHERE r.artist_id=p_artist_id AND r.purpose='session_reminder_72h';
  IF NOT FOUND THEN
    RAISE EXCEPTION '72h registry disappeared during activation'
      USING errcode='23514';
  END IF;
  RETURN 'activated';
END;
$activate$;

REVOKE ALL ON FUNCTION crm_private.activate_reminder_72h_cash_v5(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
