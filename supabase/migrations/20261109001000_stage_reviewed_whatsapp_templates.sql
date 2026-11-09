-- Stage reviewed WhatsApp Utility templates without changing active Meta send paths.
-- The Worker is permitted to submit a NEW named template for Meta review,
-- but no candidate can be sent to a client until a separate, gated promotion.
-- For Kristina the WABA may reject template creation until Coexistence is ready.

CREATE TABLE crm_private.whatsapp_template_proposals (
  artist_id uuid NOT NULL REFERENCES public.artists(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK(kind IN (
    'booking_tattoo','booking_consultation','booking_video',
    'reminder_72h','reminder_24h','reminder_consultation'
  )),
  template_name text NOT NULL CHECK(
    template_name~'^[a-z0-9_]+$' AND char_length(template_name)<=512
  ),
  template_language text NOT NULL DEFAULT 'en_GB'
    CHECK(template_language~'^[a-z]{2}(_[A-Z]{2})?$'),
  approval_status text NOT NULL DEFAULT 'UNKNOWN'
    CHECK(approval_status IN ('UNKNOWN','PENDING','APPROVED','REJECTED','PAUSED')),
  provider_template_id text
    CHECK(provider_template_id IS NULL OR provider_template_id~'^[0-9]{5,32}$'),
  verified_at timestamptz,
  attempted_at timestamptz,
  next_retry_at timestamptz,
  last_failure_code text CHECK(
    last_failure_code IS NULL OR last_failure_code~'^[a-z][a-z0-9_]{2,63}$'
  ),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (artist_id,kind),
  CONSTRAINT approved_proposal_evidence CHECK (
    approval_status<>'APPROVED'
    OR (provider_template_id IS NOT NULL AND verified_at IS NOT NULL)
  )
);
REVOKE ALL ON crm_private.whatsapp_template_proposals FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.service_claim_whatsapp_template_proposals(p_limit integer DEFAULT 8)
RETURNS TABLE(
  artist_id uuid, integration_key text, kind text,
  template_name text, template_language text,
  arrival_guide_url text, preparation_guide_url text,
  artist_name text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','crm_private'
AS $body$
BEGIN
 IF NOT crm_private.is_service_backend() THEN
   RAISE EXCEPTION 'WhatsApp template proposal maintenance is backend-only'
     USING errcode='42501';
 END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN
   RAISE EXCEPTION 'Invalid proposal claim limit' USING errcode='22023';
 END IF;
 -- Proposals are registered on the first backend maintenance call, not
 -- while Supabase is still applying startup migrations. This avoids a
 -- transient artist-FK lock at bootstrap, and never changes send gates.
 INSERT INTO crm_private.whatsapp_template_proposals
  (artist_id,kind,template_name,template_language)
 VALUES
  ('a1111111-1111-4111-8111-111111111111'::uuid,'booking_tattoo','booking_card_tattoo_v2','en_GB'),
  ('a1111111-1111-4111-8111-111111111111'::uuid,'booking_consultation','booking_card_consultation_v2','en_GB'),
  ('a1111111-1111-4111-8111-111111111111'::uuid,'booking_video','booking_card_video_consultation_v2','en_GB'),
  ('a1111111-1111-4111-8111-111111111111'::uuid,'reminder_72h','vishar_lifecycle_reminder_72h_v3','en_GB'),
  ('a1111111-1111-4111-8111-111111111111'::uuid,'reminder_24h','vishar_lifecycle_reminder_24h_v3','en_GB'),
  ('a1111111-1111-4111-8111-111111111111'::uuid,'reminder_consultation','vishar_lifecycle_consultation_v4','en_GB'),
  ('a2222222-2222-4222-8222-222222222222'::uuid,'booking_tattoo','booking_card_tattoo_v2','en_GB'),
  ('a2222222-2222-4222-8222-222222222222'::uuid,'booking_consultation','booking_card_consultation_v2','en_GB'),
  ('a2222222-2222-4222-8222-222222222222'::uuid,'booking_video','booking_card_video_consultation_v2','en_GB'),
  ('a2222222-2222-4222-8222-222222222222'::uuid,'reminder_72h','vishar_lifecycle_reminder_72h_v3','en_GB'),
  ('a2222222-2222-4222-8222-222222222222'::uuid,'reminder_24h','vishar_lifecycle_reminder_24h_v3','en_GB'),
  ('a2222222-2222-4222-8222-222222222222'::uuid,'reminder_consultation','vishar_lifecycle_consultation_v4','en_GB')
 ON CONFLICT ON CONSTRAINT whatsapp_template_proposals_pkey DO NOTHING;
 RETURN QUERY WITH candidates AS (
  SELECT p.artist_id,p.kind,p.template_name,p.template_language,
         i.integration_key,s.arrival_guide_url,s.preparation_guide_url,
         a.display_name
  FROM crm_private.whatsapp_template_proposals p
  JOIN public.artists a ON a.id=p.artist_id AND a.is_active
  JOIN crm_private.artist_state st ON st.artist_id=a.id AND st.is_active
  JOIN crm_private.booking_card_artist_settings s ON s.artist_id=p.artist_id
  JOIN public.artist_integrations i ON i.artist_id=p.artist_id
    AND i.integration_type='whatsapp'
    AND i.provider='meta_cloud_api' AND i.is_enabled
  WHERE s.arrival_guide_url LIKE 'https://%'
    AND s.preparation_guide_url LIKE 'https://%'
    AND (p.next_retry_at IS NULL OR p.next_retry_at<=now())
    AND (p.attempted_at IS NULL OR p.attempted_at<=now()-CASE
      WHEN p.approval_status='PENDING' THEN INTERVAL '15 minutes'
      WHEN p.approval_status='APPROVED' THEN INTERVAL '24 hours'
      ELSE INTERVAL '30 minutes' END)
    AND (SELECT count(*) FROM public.artist_integrations i2
         WHERE i2.artist_id=p.artist_id AND i2.integration_type='whatsapp'
           AND i2.provider='meta_cloud_api' AND i2.is_enabled)=1
  ORDER BY coalesce(p.attempted_at,'-infinity'::timestamptz),
           p.artist_id,p.kind
  LIMIT p_limit
  FOR UPDATE OF p SKIP LOCKED
 ), claimed AS (
  UPDATE crm_private.whatsapp_template_proposals p
  SET attempted_at=now(),updated_at=now()
  FROM candidates c WHERE p.artist_id=c.artist_id AND p.kind=c.kind
  RETURNING c.*
 )
 SELECT c.artist_id,c.integration_key,c.kind,c.template_name,
   c.template_language,c.arrival_guide_url,c.preparation_guide_url,c.display_name
 FROM claimed c;
END;
$body$;

CREATE OR REPLACE FUNCTION public.service_record_whatsapp_template_proposal(
  p_artist_id uuid,p_kind text,p_template_name text,
  p_status text,p_provider_template_id text DEFAULT NULL,
  p_failure_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','crm_private'
AS $body$
DECLARE v_status text:=upper(btrim(coalesce(p_status,'')));
BEGIN
 IF NOT crm_private.is_service_backend() THEN
   RAISE EXCEPTION 'Template proposal status is backend-only'
     USING errcode='42501';
 END IF;
 IF v_status NOT IN ('UNKNOWN','PENDING','APPROVED','REJECTED','PAUSED')
    OR (v_status='APPROVED' AND coalesce(p_provider_template_id,'')!~'^[0-9]{5,32}$')
    OR (p_provider_template_id IS NOT NULL
        AND p_provider_template_id!~'^[0-9]{5,32}$')
    OR (p_failure_code IS NOT NULL
        AND p_failure_code!~'^[a-z][a-z0-9_]{2,63}$') THEN
   RAISE EXCEPTION 'Invalid Meta provider status or evidence' USING errcode='22023';
 END IF;
 UPDATE crm_private.whatsapp_template_proposals p
 SET approval_status=CASE WHEN p_failure_code IS NULL THEN v_status ELSE p.approval_status END,
     provider_template_id=CASE WHEN p_failure_code IS NULL AND v_status='APPROVED'
          THEN p_provider_template_id
          WHEN p_failure_code IS NULL THEN NULL ELSE p.provider_template_id END,
     verified_at=CASE WHEN p_failure_code IS NULL THEN now() ELSE p.verified_at END,
     last_failure_code=p_failure_code,
     next_retry_at=CASE
        WHEN p_failure_code IS NOT NULL THEN
          now()+CASE WHEN p_failure_code='whatsapp_template_api_unavailable_for_account'
            THEN INTERVAL '3 hours' ELSE INTERVAL '45 minutes' END
        ELSE NULL END,
     updated_at=now()
 WHERE p.artist_id=p_artist_id AND p.kind=p_kind
   AND p.template_name=p_template_name;
 IF NOT FOUND THEN RAISE EXCEPTION 'Proposal identity mismatch' USING errcode='23503'; END IF;
 RETURN jsonb_build_object(
   'artist_id',p_artist_id,'kind',p_kind,
   'status',CASE WHEN p_failure_code IS NULL THEN v_status ELSE 'FAILED_CHECK' END,
   'verified_at',now()
 );
END;
$body$;

REVOKE ALL ON FUNCTION public.service_claim_whatsapp_template_proposals(integer)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.service_record_whatsapp_template_proposal(uuid,text,text,text,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.service_claim_whatsapp_template_proposals(integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.service_record_whatsapp_template_proposal(uuid,text,text,text,text,text)
  TO service_role;


