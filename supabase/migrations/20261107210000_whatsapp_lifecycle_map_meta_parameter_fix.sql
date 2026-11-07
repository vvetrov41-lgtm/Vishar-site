-- Fix Meta template parameter rejection: dynamic values must be single-line.
-- Existing approved Utility templates and parameter counts are unchanged.
-- This changes only future payload rendering; no client message is sent.
CREATE OR REPLACE FUNCTION crm_private.lifecycle_whatsapp_location_with_map(
  p_address text, p_map_url text
) RETURNS text LANGUAGE sql IMMUTABLE
SET search_path=pg_catalog,public,crm_private
AS $map$
  WITH cleaned AS (
    SELECT
      NULLIF(regexp_replace(btrim(p_address), '[[:space:]]+', ' ', 'g'), '') AS address,
      NULLIF(btrim(p_map_url), '') AS map_url
  )
  SELECT CASE
    WHEN address IS NOT NULL
      AND map_url IS NOT NULL
      AND map_url ~ '^https://((www[.])?google[.]com/maps/|maps[.]app[.]goo[.]gl/[A-Za-z0-9])'
      AND map_url !~ '[[:space:]]'
      AND char_length(address) + char_length(' | Google Maps: ') + char_length(map_url) <= 1024
    THEN address || ' | Google Maps: ' || map_url
    ELSE address
  END
  FROM cleaned;
$map$;
REVOKE ALL ON FUNCTION crm_private.lifecycle_whatsapp_location_with_map(text,text)
  FROM public,anon,authenticated,service_role;
