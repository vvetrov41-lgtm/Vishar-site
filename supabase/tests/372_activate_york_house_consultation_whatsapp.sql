-- Simulate Meta approval in a rollback-only local fixture. No clients/sends.
BEGIN;
SELECT no_plan();
SELECT is((SELECT count(*)::integer
 FROM crm_private.whatsapp_template_proposals p
 WHERE p.artist_id='a1111111-1111-4111-8111-111111111111'
 AND p.kind IN ('booking_consultation_directions','reminder_consultation_directions')
 AND p.approval_status='APPROVED'),0,
 'Clean local fixture has no forged Meta approval');
SELECT is((SELECT whatsapp_consultation_template_name
 FROM crm_private.booking_card_artist_settings
 WHERE artist_id='a1111111-1111-4111-8111-111111111111'),
 'booking_card_consultation_v1'::text,'Local migration did not silently promote booking v1');
SELECT throws_ok($$SELECT crm_private.activate_york_house_consultation_whatsapp(
 'a2222222-2222-4222-8222-222222222222'::uuid)$$,'42501',NULL,
 'Kristina cannot be promoted by this Vladimir-only operation');
SELECT ok(NOT has_function_privilege('anon',
 'crm_private.activate_york_house_consultation_whatsapp(uuid)','EXECUTE')
 AND NOT has_function_privilege('authenticated',
 'crm_private.activate_york_house_consultation_whatsapp(uuid)','EXECUTE')
 AND NOT has_function_privilege('service_role',
 'crm_private.activate_york_house_consultation_whatsapp(uuid)','EXECUTE'),
 'Activation cannot be called by browser or routine service roles');

-- Production before promotion is v2 booking + v4 consultation reminder.
UPDATE crm_private.booking_card_artist_settings
 SET whatsapp_consultation_template_name='booking_card_consultation_v2',
     whatsapp_consultation_template_status='APPROVED'
 WHERE artist_id='a1111111-1111-4111-8111-111111111111';
UPDATE crm_private.lifecycle_whatsapp_template_registry
 SET template_name='vishar_lifecycle_consultation_v4',
     template_language='en_GB',approval_status='APPROVED',
     provider_template_id='123456789123456',verified_at=now()
 WHERE artist_id='a1111111-1111-4111-8111-111111111111'
   AND purpose='consultation_reminder';
SELECT throws_ok($$SELECT crm_private.activate_york_house_consultation_whatsapp(
 'a1111111-1111-4111-8111-111111111111'::uuid)$$,
 'P0001','Both corrected Meta templates require fresh genuine approval',
 'Neither new template can be activated without Meta readback');

-- Test-only fake approvals, never committed or published to production.
UPDATE crm_private.whatsapp_template_proposals
 SET approval_status='APPROVED', provider_template_id='123456789123456',
     verified_at=now()
 WHERE artist_id='a1111111-1111-4111-8111-111111111111'
   AND kind IN ('booking_consultation_directions',
                'reminder_consultation_directions','reminder_consultation_video');

SELECT is(crm_private.activate_york_house_consultation_whatsapp(
 'a1111111-1111-4111-8111-111111111111'::uuid),'activated',
 'Both freshly approved corrected cards promote in the same transaction');
SELECT is((SELECT whatsapp_consultation_template_name
 FROM crm_private.booking_card_artist_settings
 WHERE artist_id='a1111111-1111-4111-8111-111111111111'),
 'booking_card_consultation_v3'::text,
 'New in-person bookings use correct York House static button');
SELECT is((SELECT template_name
 FROM crm_private.lifecycle_whatsapp_template_registry
 WHERE artist_id='a1111111-1111-4111-8111-111111111111'
   AND purpose='consultation_reminder'),
 'vishar_lifecycle_consultation_v6'::text,
 '24-hour consultations use correct York House static button');
SELECT is(crm_private.activate_york_house_consultation_whatsapp(
 'a1111111-1111-4111-8111-111111111111'::uuid),'already_active',
 'Repeat activation is idempotent');
SELECT is((SELECT whatsapp_consultation_template_name
 FROM crm_private.booking_card_artist_settings
 WHERE artist_id='a2222222-2222-4222-8222-222222222222'),
 'booking_card_consultation_v1'::text,
 'Kristina WhatsApp onboarding remains untouched');
SELECT is((SELECT studio_address FROM crm_private.booking_card_artist_settings
 WHERE artist_id='a1111111-1111-4111-8111-111111111111'),
 '16 Exhibition House, Addison Bridge Place, London W14 8XP'::text,
 'Tattoo-session location remains Exhibition House');
SELECT is((SELECT studio_address FROM crm_private.consultation_email_location()),
 'Unit B, York House, Avonmore Place, London W14 8RL'::text,
 'In-person consultation venue still York House');
SELECT * FROM finish();
ROLLBACK;
