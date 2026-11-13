-- Stage a clean Meta Utility 24h reminder for Vladimir. Do not change
-- the active v4 Meta template or send any client messages in this migration.
-- The new v5 has the SAME two buttons and body arity as the reviewed v4.
-- Promotion remains separate and fail-closed on actual Meta approval evidence.

DO $guard$
BEGIN
  -- Staging must also work in a clean local test DB without live Meta approvals.
  -- The explicit activation below enforces the existing v4 production contract.
  IF EXISTS (
    SELECT 1 FROM crm_private.whatsapp_template_proposals
    WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid
      AND kind='reminder_24h_clean'
  ) THEN
    RAISE EXCEPTION 'Clean-v5 proposal identity already exists';
  END IF;
END;
$guard$;

ALTER TABLE crm_private.whatsapp_template_proposals
  DROP CONSTRAINT whatsapp_template_proposals_kind_check,
  ADD CONSTRAINT whatsapp_template_proposals_kind_check CHECK (kind IN (
    'booking_tattoo','booking_consultation','booking_video',
    'reminder_72h','reminder_24h','reminder_consultation',
    'reminder_24h_button','reminder_consultation_button',
    'reminder_consultation_video','reminder_72h_button',
    'booking_consultation_directions','reminder_consultation_directions',
    'booking_tattoo_cash','reminder_24h_clean'
  ));

INSERT INTO crm_private.whatsapp_template_proposals
  (artist_id,kind,template_name,template_language)
VALUES
  ('a1111111-1111-4111-8111-111111111111',
   'reminder_24h_clean','vishar_lifecycle_reminder_24h_v5','en_GB');

-- Extend only the existing template identity allowlists. The reviewed v4
-- still remains active. Each patch checks the exact production function
-- fingerprint at the callsite before replacing source.
DO $allowlist$
DECLARE
  v_function text;
  v_source text;
  v_needle text := $old$'vishar_lifecycle_reminder_24h_v4'$old$;
  v_replacement text := $new$'vishar_lifecycle_reminder_24h_v4',
                             'vishar_lifecycle_reminder_24h_v5'$new$;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'crm_private.queue_lifecycle_whatsapp_job(uuid)',
    'crm_private.lifecycle_whatsapp_send_ready(uuid,uuid,text)',
    'public.service_resolve_whatsapp_lifecycle_payload(uuid,text)'
  ] LOOP
    SELECT pg_get_functiondef(v_function::regprocedure) INTO v_source;
    IF v_source IS NULL
      OR (length(v_source)-length(replace(v_source,v_needle,'')))<>length(v_needle)
    THEN
      RAISE EXCEPTION '24h v4 source drift in %',v_function;
    END IF;
    EXECUTE replace(v_source,v_needle,v_replacement);
  END LOOP;
END;
$allowlist$;

-- Explicit operator-only promotion. Meta APPROVED + exact identity +
-- fresh verification + empty pending outbox are mandatory preconditions.
CREATE OR REPLACE FUNCTION crm_private.activate_reminder_24h_clean_v5(p_artist_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO pg_catalog,public,crm_private
AS $activate$
DECLARE
  v_candidate crm_private.whatsapp_template_proposals%rowtype;
BEGIN
  IF p_artist_id IS DISTINCT FROM 'a1111111-1111-4111-8111-111111111111'::uuid
    OR NOT EXISTS (
      SELECT 1 FROM public.artists
      WHERE id=p_artist_id AND slug='vladimir' AND is_active
    ) THEN
    RAISE EXCEPTION 'Only Vladimir 24h v5 can be activated'
      USING errcode='42501';
  END IF;

  LOCK TABLE crm_private.whatsapp_template_proposals,
    crm_private.lifecycle_whatsapp_template_registry,
    public.integration_outbox IN SHARE ROW EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1 FROM crm_private.lifecycle_whatsapp_template_registry
    WHERE artist_id=p_artist_id AND purpose='session_reminder_24h'
      AND template_name='vishar_lifecycle_reminder_24h_v5'
      AND approval_status='APPROVED'
  ) THEN
    RETURN 'already_active';
  END IF;

  SELECT * INTO v_candidate
  FROM crm_private.whatsapp_template_proposals p
  WHERE p.artist_id=p_artist_id
    AND p.kind='reminder_24h_clean'
    AND p.template_name='vishar_lifecycle_reminder_24h_v5'
    AND p.template_language='en_GB';

  IF NOT FOUND OR v_candidate.approval_status<>'APPROVED'
    OR coalesce(v_candidate.provider_template_id,'') !~ '^[0-9]{5,32}$'
    OR v_candidate.verified_at IS NULL
    OR v_candidate.verified_at<=now()-interval '24 hours'
  THEN RETURN 'waiting_for_meta_approval'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM crm_private.lifecycle_whatsapp_template_registry
    WHERE artist_id=p_artist_id AND purpose='session_reminder_24h'
      AND template_name='vishar_lifecycle_reminder_24h_v4'
      AND approval_status='APPROVED'
      AND provider_template_id IS NOT NULL
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
  WHERE r.artist_id=p_artist_id AND r.purpose='session_reminder_24h';
  IF NOT FOUND THEN RAISE EXCEPTION '24h registry disappeared during promotion'; END IF;
  RETURN 'activated';
END;
$activate$;

REVOKE ALL ON FUNCTION crm_private.activate_reminder_24h_clean_v5(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
