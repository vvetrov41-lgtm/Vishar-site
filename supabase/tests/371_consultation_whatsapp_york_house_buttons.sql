BEGIN;
SELECT no_plan();

SELECT is((SELECT count(*)::integer FROM crm_private.whatsapp_template_proposals
 WHERE artist_id='a1111111-1111-4111-8111-111111111111'
 AND kind IN ('booking_consultation_directions','reminder_consultation_directions')),2,
 'Two new Vladimir-only Meta candidate identities are staged');
SELECT is((SELECT count(*)::integer FROM crm_private.whatsapp_template_proposals
 WHERE artist_id='a1111111-1111-4111-8111-111111111111'
 AND ((kind='booking_consultation_directions' AND template_name='booking_card_consultation_v3')
 OR (kind='reminder_consultation_directions' AND template_name='vishar_lifecycle_consultation_v6'))
 AND approval_status='UNKNOWN' AND provider_template_id IS NULL),2,
 'New candidates are not incorrectly marked as approved');
SELECT is((SELECT count(*)::integer FROM crm_private.whatsapp_template_proposals
 WHERE artist_id='a2222222-2222-4222-8222-222222222222'
 AND kind IN ('booking_consultation_directions','reminder_consultation_directions')),0,
 'Kristina Coexistence state and templates stay unchanged');

SELECT is((SELECT studio_map_url FROM crm_private.consultation_email_location()),
 'https://maps.app.goo.gl/zfTRAJ4MXEHcHf3S6?g_st=ic'::text,
 'Approved candidate design must match real consultation map');
SELECT ok(position('booking_card_consultation_v2' in
 pg_get_functiondef('crm_private.create_booking_card_whatsapp(uuid,text,text)'::regprocedure))>0
 and position('booking_card_consultation_v3' in
 pg_get_functiondef('crm_private.create_booking_card_whatsapp(uuid,text,text)'::regprocedure))>0,
 'Wrong v2 booking is fail-closed, future v3 identity is supported');
SELECT ok(position('booking_card_consultation_v2' in
 pg_get_functiondef('public.service_resolve_whatsapp_booking_card_payload(uuid,text)'::regprocedure))>0,
 'Existing queued bad booking-card v2 messages are delivery-blocked');
SELECT ok(position('vishar_lifecycle_consultation_v6' in
 pg_get_functiondef('crm_private.queue_lifecycle_whatsapp_job(uuid)'::regprocedure))>0,
 'New approved reminder can use v6 without recurring confirmation');
SELECT ok(position('vishar_lifecycle_consultation_v6' in
 pg_get_functiondef('public.service_resolve_whatsapp_lifecycle_payload(uuid,text)'::regprocedure))>0,
 'v6 and video route may be validated at provider delivery');
SELECT is((SELECT template_name FROM crm_private.lifecycle_whatsapp_template_registry
 WHERE artist_id='a1111111-1111-4111-8111-111111111111'
 AND purpose='consultation_reminder'),
 'vishar_lifecycle_consultation_v1'::text,
 'Staging never activates a new WhatsApp reminder on clean local fixture');
SELECT is((SELECT whatsapp_consultation_template_name
 FROM crm_private.booking_card_artist_settings
 WHERE artist_id='a1111111-1111-4111-8111-111111111111'),
 'booking_card_consultation_v1'::text,
 'Staging never activates a booking template on clean local fixture');
SELECT * FROM finish();
ROLLBACK;
