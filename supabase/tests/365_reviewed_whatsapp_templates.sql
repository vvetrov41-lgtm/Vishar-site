-- Meta reviews happen asynchronously; this test only inspects the staged contract.
-- It never creates a production booking, sends WhatsApp or calls Meta.
BEGIN;
SELECT no_plan();
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SET LOCAL ROLE service_role;
SELECT lives_ok(
 $SELECT * FROM public.service_claim_whatsapp_template_proposals(8)$,
 'Backend claim registers the 12 approved-design proposals without Meta sends'
);
RESET ROLE;

SELECT is(
 (SELECT count(*)::integer FROM crm_private.whatsapp_template_proposals
  WHERE artist_id IN (
    'a1111111-1111-4111-8111-111111111111',
    'a2222222-2222-4222-8222-222222222222'
  )),12,
 'Six unactivated Meta Utility proposals exist for each artist'
);

SELECT is(
 (SELECT count(*)::integer FROM crm_private.whatsapp_template_proposals
  WHERE approval_status='UNKNOWN' AND provider_template_id IS NULL),12,
 'Proposals begin unapproved and cannot be sent'
);

SELECT is(
 (SELECT count(*)::integer FROM crm_private.whatsapp_template_proposals
   WHERE kind IN ('reminder_72h','reminder_24h','reminder_consultation')),6,
 'Both artists have three reminder proposals'
);

SELECT is(
 (SELECT count(*)::integer FROM crm_private.booking_card_artist_settings
   WHERE artist_id='a1111111-1111-4111-8111-111111111111'
     AND whatsapp_tattoo_template_name='booking_card_tattoo_v1'
     AND whatsapp_consultation_template_name='booking_card_consultation_v1'
     AND whatsapp_video_template_name='booking_card_video_consultation_v1'
     AND whatsapp_enabled),1,
 'Vladimir approved current booking cards and send gate stay intact'
);

SELECT is(
 (SELECT count(*)::integer FROM crm_private.booking_card_artist_settings
   WHERE artist_id='a2222222-2222-4222-8222-222222222222'
     AND NOT whatsapp_enabled),1,
 'Kristina remains disabled until provider-approved coexistence'
);

SELECT is(
 (SELECT count(*)::integer FROM crm_private.lifecycle_whatsapp_template_registry
   WHERE artist_id='a1111111-1111-4111-8111-111111111111'
     AND approval_status='APPROVED'
     AND provider_template_id IS NOT NULL),5,
 'Existing Vladimir lifecycle Meta templates remain approved'
);

SET LOCAL ROLE authenticated;
SELECT throws_ok(
 $$SELECT * FROM public.service_claim_whatsapp_template_proposals(6)$$,
 '42501',NULL,
 'Unprivileged clients cannot claim outbound Meta template provisioning'
);
SELECT throws_ok(
 $$SELECT public.service_record_whatsapp_template_proposal(
   'a1111111-1111-4111-8111-111111111111','booking_tattoo',
   'booking_card_tattoo_v2','APPROVED','12345678901234',NULL)$$,
 '42501',NULL,
 'Clients cannot forge Meta approval status'
);
RESET ROLE;

SELECT ok(
 NOT has_function_privilege('anon',
   'public.service_claim_whatsapp_template_proposals(integer)','EXECUTE')
 AND NOT has_function_privilege('authenticated',
   'public.service_record_whatsapp_template_proposal(uuid,text,text,text,text,text)','EXECUTE'),
 'Meta proposal maintenance RPCs are unavailable to browser roles'
);

SELECT * FROM finish(true);
ROLLBACK;
