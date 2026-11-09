-- Update only the in-person consultation location used by existing Gmail,
-- booking-card HTML and WhatsApp consultation reminders.
-- Keep existing Meta templates, arrival links, client records, and jobs unchanged.
-- Fail closed if an independently edited studio setting disagrees.
DO $studio_guard$
DECLARE v_definition text;
BEGIN
  SELECT pg_get_functiondef('crm_private.consultation_email_location()'::regprocedure)
    INTO v_definition;
  IF v_definition IS NULL
     OR position('Label Tattoo Kensington' in v_definition)=0
     OR position('Unit B, York House, Avonmore Place, London W14 8RL' in v_definition)=0
  THEN RAISE EXCEPTION 'Consultation location was modified concurrently';
  END IF;
  IF (SELECT count(*) FROM crm_private.booking_card_artist_settings s
      JOIN public.artists a ON a.id=s.artist_id
      WHERE a.slug IN ('vladimir','kristina')
        AND s.studio_name='Label Tattoo Private'
        AND s.studio_address='16 Exhibition House, Addison Bridge Place, London W14 8XP'
        AND s.studio_map_url='https://www.google.com/maps/search/?api=1&query=16%20Exhibition%20House%2C%20Addison%20Bridge%20Place%2C%20London%20W14%208XP')<>2
  THEN RAISE EXCEPTION 'Current production studio settings do not match reviewed location';
  END IF;
END;
$studio_guard$;

CREATE OR REPLACE FUNCTION crm_private.consultation_email_location()
RETURNS TABLE(studio_name text, studio_address text, studio_map_url text)
LANGUAGE sql IMMUTABLE
SET search_path TO pg_catalog
AS $location$
  SELECT
    'Label Tattoo Private'::text,
    '16 Exhibition House, Addison Bridge Place, London W14 8XP'::text,
    'https://www.google.com/maps/search/?api=1&query=16%20Exhibition%20House%2C%20Addison%20Bridge%20Place%2C%20London%20W14%208XP'::text;
$location$;

REVOKE ALL ON FUNCTION crm_private.consultation_email_location()
  FROM PUBLIC,anon,authenticated,service_role;
