-- Static active-output contract after outbound-first-person hardening.
-- No real production clients, events, provider calls or fake bookings.
BEGIN;
SELECT no_plan();

SELECT is(
  (SELECT count(*)::integer FROM public.message_templates
   WHERE status='active' AND artist_id IS NULL AND channel='email'
     AND purpose IN ('consultation_reminder','deposit_request',
       'deposit_confirmation','session_reminder_24h','session_reminder_72h')),
  10, 'both artist workspaces retain five shared lifecycle/deposit templates');

SELECT is(
  (SELECT count(*)::integer FROM public.message_templates
   WHERE status='active' AND artist_id IS NULL AND channel='email'
     AND (
       (purpose='consultation_reminder' AND subject='Our consultation tomorrow | {{appointment_date}}')
       OR (purpose='deposit_request' AND subject='Deposit to secure your tattoo booking')
       OR (purpose='deposit_confirmation' AND subject='I''ve received your tattoo deposit')
       OR (purpose='session_reminder_24h' AND subject='See you tomorrow | Tattoo session')
       OR (purpose='session_reminder_72h' AND subject='Our tattoo session in three days | {{appointment_date}}')
     )),
  10, 'all shared active email subjects have neutral or first-person artist voice');

SELECT ok(NOT EXISTS (
  SELECT 1 FROM public.message_templates
  WHERE status='active' AND channel='email'
    AND subject ~* $rx$with[[:space:]]+(\{\{artist_display_name\}\}|Vladimir|Kristina)$rx$
), 'no active email template uses third-person with-artist subject');

SELECT ok(
 position('subject := v_title;' in pg_get_functiondef(
   'crm_private.render_booking_card_email(uuid,text,text)'::regprocedure))>0
 AND position('subject := v_title || ' in pg_get_functiondef(
   'crm_private.render_booking_card_email(uuid,text,text)'::regprocedure))=0,
 'booking-card email subject does not append the sender as a third person');

SELECT ok(
 position('tattoo sessions with me are booked' in pg_get_functiondef(
   'crm_private.create_booking_card_instagram(uuid,text,text)'::regprocedure))>0
 AND position('video consultation with me is booked' in pg_get_functiondef(
   'crm_private.create_booking_card_instagram(uuid,text,text)'::regprocedure))>0
 AND position('|| v_artist.display_name ||' in pg_get_functiondef(
   'crm_private.create_booking_card_instagram(uuid,text,text)'::regprocedure))=0,
 'legacy Instagram booking messages use the sender voice');

SELECT ok(
 position('with me is booked' in pg_get_functiondef(
   'crm_private.create_booking_card_instagram(uuid,text,text,text)'::regprocedure))>0,
 'current Instagram booking message remains first-person');

SELECT ok(
 position('v_template_name not in' in pg_get_functiondef(
   'crm_private.create_booking_card_whatsapp(uuid,text,text)'::regprocedure))>0
 AND position('p.template_name in' in pg_get_functiondef(
   'public.service_resolve_whatsapp_booking_card_payload(uuid,text)'::regprocedure))>0,
 'old WhatsApp booking-card identities fail closed at queue and provider');

SELECT ok(
 position('Explicit first-person allowlist' in pg_get_functiondef(
   'crm_private.lifecycle_whatsapp_send_ready(uuid,uuid,text)'::regprocedure))>0
 AND position('vishar_lifecycle_aftercare_v2' in pg_get_functiondef(
   'crm_private.lifecycle_whatsapp_send_ready(uuid,uuid,text)'::regprocedure))>0
 AND position('vishar_lifecycle_checkin_v2' in pg_get_functiondef(
   'crm_private.lifecycle_whatsapp_send_ready(uuid,uuid,text)'::regprocedure))>0,
 'WhatsApp lifecycle chooses first-person provider identities only');

SELECT ok(
 position('vishar_lifecycle_consultation_video_v1' in pg_get_functiondef(
   'public.service_resolve_whatsapp_lifecycle_payload(uuid,text)'::regprocedure))>0
 AND position('vishar_lifecycle_aftercare_v2' in pg_get_functiondef(
   'public.service_resolve_whatsapp_lifecycle_payload(uuid,text)'::regprocedure))>0,
 'WhatsApp provider resolver applies same first-person gate including video');

SELECT ok(
 position('session_lifecycle_block' in pg_get_functiondef(
   'crm_private.lifecycle_block_disposition(uuid)'::regprocedure))>0,
 'consecutive-session deduplication remains active');

SELECT * FROM finish();
ROLLBACK;
