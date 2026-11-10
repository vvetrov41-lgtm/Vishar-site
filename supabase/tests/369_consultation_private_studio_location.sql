BEGIN;
SELECT no_plan();
SELECT is((SELECT studio_name FROM crm_private.consultation_email_location()),
 'Label Tattoo Kensington'::text, 'Consultation venue is Kensington');
SELECT is((SELECT studio_address FROM crm_private.consultation_email_location()),
 'Unit B, York House, Avonmore Place, London W14 8RL'::text,
 'In-person consultations use York House');
SELECT is((SELECT studio_map_url FROM crm_private.consultation_email_location()),
 'https://maps.app.goo.gl/zfTRAJ4MXEHcHf3S6?g_st=ic'::text,
 'Consultation map uses the pin supplied by the artist');
SELECT is((SELECT count(*)::integer FROM crm_private.booking_card_artist_settings s
 JOIN public.artists a ON a.id=s.artist_id
 WHERE a.slug IN ('vladimir','kristina')
 AND s.studio_name='Label Tattoo Private'
 AND s.studio_address='16 Exhibition House, Addison Bridge Place, London W14 8XP'),2,
 'Tattoo sessions for both artists retain Exhibition House');
SELECT isnt((SELECT studio_address FROM crm_private.consultation_email_location()),
 (SELECT studio_address FROM crm_private.booking_card_artist_settings s
 JOIN public.artists a ON a.id=s.artist_id WHERE a.slug='vladimir'),
 'Consultation and tattoo-session addresses remain distinct');
SELECT ok(position('consultation_email_location() l' in
 pg_get_functiondef('crm_private.render_booking_card_email(uuid,text,text)'::regprocedure))>0,
 'Booking confirmation email overrides consultation location and map');
SELECT ok(NOT EXISTS(SELECT 1 FROM crm_private.lifecycle_whatsapp_template_registry r
 JOIN public.artists a ON a.id=r.artist_id
 WHERE a.slug='vladimir' AND r.purpose='consultation_reminder'
 AND r.approval_status='APPROVED'
 AND r.template_name='vishar_lifecycle_consultation_v5'),
 'No active consultation reminder template with the incorrect static URL');
SELECT is((SELECT prosecdef FROM pg_proc
 WHERE oid='crm_private.consultation_email_location()'::regprocedure),
 false,'Consultation location remains security invoker');
SELECT * FROM finish();
ROLLBACK;
