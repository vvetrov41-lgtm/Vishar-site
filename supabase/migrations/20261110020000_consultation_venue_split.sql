-- Keep tattoo sessions at Exhibition House, but consultations at York House.
-- Restore the artist-provided consultation pin. Do not alter completed sends,
-- real sessions, arrival pages, artist settings, or video call locations.
DO $guard$
DECLARE v_def text;
BEGIN
 SELECT pg_get_functiondef('crm_private.consultation_email_location()'::regprocedure) INTO v_def;
 IF v_def IS NULL
   OR position('Label Tattoo Private' in v_def)=0
   OR position('16 Exhibition House, Addison Bridge Place, London W14 8XP' in v_def)=0
 THEN RAISE EXCEPTION 'Consultation location was changed concurrently'; END IF;
 IF (SELECT count(*) FROM crm_private.booking_card_artist_settings s
   JOIN public.artists a ON a.id=s.artist_id
   WHERE a.slug IN ('vladimir','kristina')
     AND s.studio_name='Label Tattoo Private'
     AND s.studio_address='16 Exhibition House, Addison Bridge Place, London W14 8XP')<>2
 THEN RAISE EXCEPTION 'Tattoo-session location diverged; do not overwrite it'; END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION crm_private.consultation_email_location()
RETURNS TABLE(studio_name text, studio_address text, studio_map_url text)
LANGUAGE sql IMMUTABLE SET search_path TO pg_catalog
AS $location$
 SELECT 'Label Tattoo Kensington'::text,
        'Unit B, York House, Avonmore Place, London W14 8RL'::text,
        'https://maps.app.goo.gl/zfTRAJ4MXEHcHf3S6?g_st=ic'::text;
$location$;
REVOKE ALL ON FUNCTION crm_private.consultation_email_location()
 FROM PUBLIC,anon,authenticated,service_role;

-- The newer booking-confirmation email renderer removed the earlier
-- consultation-specific override. Reintroduce it for in-person cards only,
-- including the clickable Get directions destination (not the tattoo
-- session's private arrival guide). Preserve all other renderer behaviour.
DO $booking_card$
DECLARE
 v_source text := pg_get_functiondef(
   'crm_private.render_booking_card_email(uuid,text,text)'::regprocedure);
 v_anchor text := '  v_video := v_card.appointment_type=''video_consultation''::public.appointment_type;';
 v_patch text := $patch$
  IF v_card.card_kind='consultation_booked'
     AND v_card.appointment_type='in_person_consultation'::public.appointment_type THEN
    SELECT l.studio_name,l.studio_address,l.studio_map_url,l.studio_map_url
      INTO v_settings.studio_name,v_settings.studio_address,
           v_settings.studio_map_url,v_arrival_url
    FROM crm_private.consultation_email_location() l;
  END IF;
$patch$;
BEGIN
 IF v_source IS NULL OR
   (length(v_source)-length(replace(v_source,v_anchor,'')))<>length(v_anchor)
   OR position('legacy consultation_email_location() York House override' in v_source)=0
 THEN RAISE EXCEPTION 'Booking card renderer changed concurrently'; END IF;
 EXECUTE replace(v_source,v_anchor,v_anchor||E'\n'||v_patch);
END;
$booking_card$;

-- The approved v5 template contains a STATIC URL to the tattoo-only arrival
-- page. Until Meta approves a consultation-map template, prevent it from
-- sending wrong directions. Use the previously approved v4 with clickable
-- Google Maps text in {{3}}; preserve its original review-proven identity.
-- Nothing is changed for Kristina or unapproved/test-only installations.
DO $temporary_route$
DECLARE v_artist uuid := 'a1111111-1111-4111-8111-111111111111';
 v_approved record;
BEGIN
 IF EXISTS (
   SELECT 1 FROM crm_private.lifecycle_whatsapp_template_registry r
   JOIN public.artists a ON a.id=r.artist_id
   WHERE a.id=v_artist AND a.slug='vladimir'
     AND r.purpose='consultation_reminder'
     AND r.template_name='vishar_lifecycle_consultation_v5'
     AND r.approval_status='APPROVED'
 ) THEN
   SELECT p.template_name,p.template_language,p.provider_template_id,p.verified_at
     INTO v_approved
   FROM crm_private.whatsapp_template_proposals p
   WHERE p.artist_id=v_artist AND p.kind='reminder_consultation'
     AND p.template_name='vishar_lifecycle_consultation_v4'
     AND p.approval_status='APPROVED'
     AND p.provider_template_id IS NOT NULL
     AND p.verified_at>now()-interval '24 hours'
   FOR UPDATE;
   IF NOT FOUND THEN
     RAISE EXCEPTION 'Approved map-in-body fallback not recently verified';
   END IF;
   UPDATE crm_private.lifecycle_whatsapp_template_registry r
   SET template_name=v_approved.template_name,
       template_language=v_approved.template_language,
       provider_template_id=v_approved.provider_template_id,
       verified_at=v_approved.verified_at,
       updated_at=now()
   WHERE r.artist_id=v_artist AND r.purpose='consultation_reminder'
     AND r.template_name='vishar_lifecycle_consultation_v5'
     AND r.approval_status='APPROVED';
   IF NOT FOUND THEN RAISE EXCEPTION 'Concurrent consultation route change'; END IF;
 END IF;
END;
$temporary_route$;
