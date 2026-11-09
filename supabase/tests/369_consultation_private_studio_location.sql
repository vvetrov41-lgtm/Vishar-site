BEGIN;
SELECT no_plan();

SELECT is((SELECT studio_name FROM crm_private.consultation_email_location()),
  'Label Tattoo Private'::text, 'Consultation label comes from current studio');
SELECT is((SELECT studio_address FROM crm_private.consultation_email_location()),
  '16 Exhibition House, Addison Bridge Place, London W14 8XP'::text,
  'In-person consultation no longer sends York House address');
SELECT is((SELECT studio_map_url FROM crm_private.consultation_email_location()),
  'https://www.google.com/maps/search/?api=1&query=16%20Exhibition%20House%2C%20Addison%20Bridge%20Place%2C%20London%20W14%208XP'::text,
  'Consultation directions link matches verified artist studio settings');
SELECT is((SELECT count(*)::integer
  FROM crm_private.booking_card_artist_settings s
  JOIN public.artists a ON a.id=s.artist_id
  CROSS JOIN crm_private.consultation_email_location() l
  WHERE a.slug IN ('vladimir','kristina')
    AND s.studio_name=l.studio_name
    AND s.studio_address=l.studio_address
    AND s.studio_map_url=l.studio_map_url),2,
    'Both artists and consultation location agree');
SELECT ok(position('York House' in
  pg_get_functiondef('crm_private.consultation_email_location()'::regprocedure))=0,
  'Old consultation address is absent from source');
SELECT is((SELECT prosecdef FROM pg_proc
  WHERE oid='crm_private.consultation_email_location()'::regprocedure),
  false,'Consultation location is still security invoker');

SELECT * FROM finish();
ROLLBACK;
