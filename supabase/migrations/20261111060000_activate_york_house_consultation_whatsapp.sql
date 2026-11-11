-- Activate ONLY Meta-approved York House consultation cards after 10 Nov provider readback.
-- This changes no client booking, message, payment or tattoo-session route.
-- A clean local migration fixture remains inert, while any unexpected
-- production state fails closed instead of guessing an artist's venue.

CREATE OR REPLACE FUNCTION crm_private.activate_york_house_consultation_whatsapp(p_artist_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO pg_catalog,public,crm_private AS $activation$
DECLARE
 v_booking text;
 v_reminder text;
 v_approvals integer;
 v_reminder_proposal crm_private.whatsapp_template_proposals%rowtype;
 v_video_approved boolean;
BEGIN
 IF p_artist_id IS DISTINCT FROM 'a1111111-1111-4111-8111-111111111111'::uuid
    OR NOT EXISTS (SELECT 1 FROM public.artists a
                   WHERE a.id=p_artist_id AND a.slug='vladimir') THEN
   RAISE EXCEPTION 'Only Vladimir York House consultation cards may be promoted'
     USING errcode='42501';
 END IF;

 LOCK TABLE crm_private.booking_card_artist_settings,
   crm_private.lifecycle_whatsapp_template_registry,
   crm_private.whatsapp_template_proposals,
   public.integration_outbox IN SHARE ROW EXCLUSIVE MODE;

 SELECT s.whatsapp_consultation_template_name, r.template_name
   INTO v_booking,v_reminder
 FROM crm_private.booking_card_artist_settings s
 JOIN crm_private.lifecycle_whatsapp_template_registry r
   ON r.artist_id=s.artist_id AND r.purpose='consultation_reminder'
 WHERE s.artist_id=p_artist_id AND s.whatsapp_enabled=true
   AND s.whatsapp_template_language='en_GB'
   AND r.template_language='en_GB';
 IF NOT FOUND THEN RAISE EXCEPTION 'Consultation delivery settings changed'; END IF;

 IF v_booking='booking_card_consultation_v3'
    AND v_reminder='vishar_lifecycle_consultation_v6' THEN
   RETURN 'already_active';
 END IF;

 SELECT count(*) INTO v_approvals FROM crm_private.whatsapp_template_proposals p
 WHERE p.artist_id=p_artist_id
   AND ((p.kind='booking_consultation_directions'
         AND p.template_name='booking_card_consultation_v3')
     OR (p.kind='reminder_consultation_directions'
         AND p.template_name='vishar_lifecycle_consultation_v6'))
   AND p.approval_status='APPROVED' AND p.provider_template_id~'^[0-9]{5,32}$'
   AND p.verified_at>now()-interval '24 hours';

 -- Clean CI fixture has pre-approval v1 identities. Do not forge Meta status.
 IF v_booking='booking_card_consultation_v1'
    AND v_reminder='vishar_lifecycle_consultation_v1'
    AND v_approvals=0 THEN
   RETURN 'local_fixture_unapproved';
 END IF;

 IF v_booking<>'booking_card_consultation_v2'
    OR v_reminder<>'vishar_lifecycle_consultation_v4' THEN
   RAISE EXCEPTION 'Live consultation identities changed concurrently';
 END IF;
 IF v_approvals<>2 THEN
   RAISE EXCEPTION 'Both corrected Meta templates require fresh genuine approval';
 END IF;
 IF (SELECT count(*) FROM crm_private.consultation_email_location() l
       WHERE l.studio_name='Label Tattoo Kensington'
         AND l.studio_address='Unit B, York House, Avonmore Place, London W14 8RL'
         AND l.studio_map_url='https://maps.app.goo.gl/zfTRAJ4MXEHcHf3S6?g_st=ic')<>1 THEN
   RAISE EXCEPTION 'York House address or map drifted';
 END IF;
 IF NOT EXISTS (
   SELECT 1 FROM crm_private.booking_card_artist_settings s
   WHERE s.artist_id=p_artist_id
     AND s.studio_name='Label Tattoo Private'
     AND s.studio_address='16 Exhibition House, Addison Bridge Place, London W14 8XP'
     AND s.whatsapp_consultation_template_status='APPROVED'
 ) THEN RAISE EXCEPTION 'Tattoo-session venue or booking status drifted'; END IF;

 -- v6 routes a video consultation to its own no-directions approved template.
 SELECT EXISTS (
   SELECT 1 FROM crm_private.whatsapp_template_proposals p
   WHERE p.artist_id=p_artist_id AND p.kind='reminder_consultation_video'
     AND p.template_name='vishar_lifecycle_consultation_video_v1'
     AND p.approval_status='APPROVED'
     AND p.provider_template_id~'^[0-9]{5,32}$'
     AND p.verified_at>now()-interval '24 hours'
 ) INTO v_video_approved;
 IF NOT v_video_approved THEN
   RAISE EXCEPTION 'Video consultation fallback needs a fresh Meta approval';
 END IF;

 IF EXISTS (
   SELECT 1 FROM public.integration_outbox o
   WHERE o.artist_id=p_artist_id
     AND o.kind='whatsapp_message' AND o.status IN ('pending','leased')
 ) THEN RAISE EXCEPTION 'WhatsApp outbox still has in-flight messages'; END IF;

 SELECT p.* INTO STRICT v_reminder_proposal
 FROM crm_private.whatsapp_template_proposals p
 WHERE p.artist_id=p_artist_id AND p.kind='reminder_consultation_directions'
   AND p.template_name='vishar_lifecycle_consultation_v6'
   AND p.approval_status='APPROVED' AND p.verified_at>now()-interval '24 hours';

 UPDATE crm_private.booking_card_artist_settings s
 SET whatsapp_consultation_template_name='booking_card_consultation_v3',
     whatsapp_consultation_template_status='APPROVED',
     whatsapp_template_checked_at=now(),updated_at=now()
 WHERE s.artist_id=p_artist_id
   AND s.whatsapp_consultation_template_name='booking_card_consultation_v2';
 IF NOT FOUND THEN RAISE EXCEPTION 'Booking activation lost race'; END IF;

 UPDATE crm_private.lifecycle_whatsapp_template_registry r
 SET template_name=v_reminder_proposal.template_name,
     template_language=v_reminder_proposal.template_language,
     provider_template_id=v_reminder_proposal.provider_template_id,
     approval_status=v_reminder_proposal.approval_status,
     verified_at=v_reminder_proposal.verified_at,updated_at=now()
 WHERE r.artist_id=p_artist_id AND r.purpose='consultation_reminder'
   AND r.template_name='vishar_lifecycle_consultation_v4';
 IF NOT FOUND THEN RAISE EXCEPTION 'Reminder activation lost race'; END IF;
 RETURN 'activated';
END;
$activation$;
REVOKE ALL ON FUNCTION crm_private.activate_york_house_consultation_whatsapp(uuid)
 FROM PUBLIC,anon,authenticated,service_role;

DO $apply$
DECLARE v_result text;
BEGIN
 v_result:=crm_private.activate_york_house_consultation_whatsapp(
   'a1111111-1111-4111-8111-111111111111'::uuid);
 IF v_result NOT IN ('activated','local_fixture_unapproved') THEN
   RAISE EXCEPTION 'Unexpected consultation activation result: %',v_result;
 END IF;
END;
$apply$;
