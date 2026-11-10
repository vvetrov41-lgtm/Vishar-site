-- First-person aftercare/check-in for Vladimir and Kristina.
-- New Meta v2 identities require real provider review. Never mutate v1 templates.
-- Until v2 is approved and separately activated, use the existing Email
-- fallback instead of sending the known third-person WhatsApp v1 body.
DO $precondition$
DECLARE v_source text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM crm_private.lifecycle_whatsapp_template_registry r
    WHERE r.artist_id='a1111111-1111-4111-8111-111111111111'::uuid
      AND r.purpose='post_session_aftercare'
      AND r.template_name='vishar_lifecycle_aftercare_v1'
  ) OR NOT EXISTS (
    SELECT 1 FROM crm_private.lifecycle_whatsapp_template_registry r
    WHERE r.artist_id='a1111111-1111-4111-8111-111111111111'::uuid
      AND r.purpose='post_session_checkin'
      AND r.template_name='vishar_lifecycle_checkin_v1'
  ) THEN RAISE EXCEPTION 'Post-session identity drift'; END IF;

  IF EXISTS (
    SELECT 1 FROM crm_private.lifecycle_whatsapp_payloads p
    JOIN public.integration_outbox o ON o.communication_message_id=p.communication_message_id
    WHERE o.status IN ('pending','leased')
      AND p.purpose IN ('post_session_aftercare','post_session_checkin')
      AND p.template_name IN ('vishar_lifecycle_aftercare_v1',
                              'vishar_lifecycle_checkin_v1')
  ) THEN RAISE EXCEPTION 'Unresolved v1 post-session WhatsApp delivery'; END IF;

  v_source:=pg_get_functiondef(
    'crm_private.lifecycle_whatsapp_send_ready(uuid,uuid,text)'::regprocedure);
  IF v_source IS NULL OR position(
    'and t.verified_at>now()-interval ''24 hours''' in v_source)=0
  THEN RAISE EXCEPTION 'WhatsApp readiness contract changed'; END IF;
END;
$precondition$;

-- Provider review is independent for each artist. Kristina remains gated
-- until her WhatsApp Cloud API route becomes available.
INSERT INTO crm_private.lifecycle_whatsapp_template_candidates(
  artist_id,purpose,template_name,template_language)
VALUES
 ('a1111111-1111-4111-8111-111111111111','post_session_aftercare',
  'vishar_lifecycle_aftercare_v2','en_GB'),
 ('a1111111-1111-4111-8111-111111111111','post_session_checkin',
  'vishar_lifecycle_checkin_v2','en_GB'),
 ('a2222222-2222-4222-8222-222222222222','post_session_aftercare',
  'vishar_lifecycle_aftercare_v2','en_GB'),
 ('a2222222-2222-4222-8222-222222222222','post_session_checkin',
  'vishar_lifecycle_checkin_v2','en_GB')
ON CONFLICT DO NOTHING;

DO $readiness_patch$
DECLARE v_source text; v_old text; v_new text;
BEGIN
  SELECT pg_get_functiondef(
    'crm_private.lifecycle_whatsapp_send_ready(uuid,uuid,text)'::regprocedure)
  INTO v_source;
  v_old:=$old$        and t.verified_at>now()-interval '24 hours'$old$;
  v_new:=$new$        and t.verified_at>now()-interval '24 hours'
        -- The provider-approved v1 bodies speak about the artist in third
        -- person. Keep the email fallback until the reviewed v2 is active.
        and not (
          (t.purpose='post_session_aftercare'
           and t.template_name='vishar_lifecycle_aftercare_v1')
          or (t.purpose='post_session_checkin'
           and t.template_name='vishar_lifecycle_checkin_v1')
        )$new$;
  IF v_source IS NULL OR
     (length(v_source)-length(replace(v_source,v_old,'')))<>length(v_old)
  THEN RAISE EXCEPTION 'Concurrent WhatsApp readiness change'; END IF;
  EXECUTE replace(v_source,v_old,v_new);
END;
$readiness_patch$;

-- The button URLs are static, checked at Meta approval. A v2 BODY has
-- exactly one parameter (the client name). Keep all existing v1 arities.
DO $composer_patch$
DECLARE v_source text; v_old text; v_new text;
BEGIN
  SELECT pg_get_functiondef(
    'crm_private.queue_lifecycle_whatsapp_job(uuid)'::regprocedure)
  INTO v_source;
  v_old:=$old$    v_params:=jsonb_build_array(v_first,a.display_name,v_url);
  end if;$old$;
  v_new:=$new$    if (j.message_purpose='post_session_aftercare'
         and t.template_name='vishar_lifecycle_aftercare_v2')
       or (j.message_purpose='post_session_checkin'
         and t.template_name='vishar_lifecycle_checkin_v2') then
      v_params:=jsonb_build_array(v_first);
    else
      v_params:=jsonb_build_array(v_first,a.display_name,v_url);
    end if;
  end if;$new$;
  IF v_source IS NULL OR
     (length(v_source)-length(replace(v_source,v_old,'')))<>length(v_old)
  THEN RAISE EXCEPTION 'Concurrent lifecycle composer change'; END IF;
  EXECUTE replace(v_source,v_old,v_new);
END;
$composer_patch$;

-- Provider resolver already checks: active registry identity, Meta APPROVED,
-- fresh verification, original job, immutable session and recipient.
-- This migration does not promote v2 or send/replay any client message.
