-- Stage a NEW Vladimir-only 72h WhatsApp Utility message with an optional
-- cash preference. Existing approved Meta v4, old jobs, buttons and client
-- deliveries remain untouched. Approval and activation are separate releases.
-- This migration alone never switches any client-facing template.

DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM crm_private.whatsapp_template_proposals
    WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid
      AND kind='reminder_72h_cash'
  ) THEN
    RAISE EXCEPTION 'Cash 72h proposal identity already exists'
      USING errcode='23514';
  END IF;
END;
$guard$;

ALTER TABLE crm_private.whatsapp_template_proposals
  DROP CONSTRAINT whatsapp_template_proposals_kind_check,
  ADD CONSTRAINT whatsapp_template_proposals_kind_check CHECK (kind IN (
    'booking_tattoo','booking_consultation','booking_video',
    'reminder_72h','reminder_24h','reminder_consultation',
    'reminder_24h_button','reminder_consultation_button',
    'reminder_consultation_video','reminder_72h_button',
    'booking_consultation_directions','reminder_consultation_directions',
    'booking_tattoo_cash','reminder_24h_clean','reminder_72h_cash'
  ));

INSERT INTO crm_private.whatsapp_template_proposals
  (artist_id,kind,template_name,template_language)
VALUES (
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'reminder_72h_cash','vishar_lifecycle_reminder_72h_v5','en_GB'
);

DO $postcheck$
BEGIN
  IF (SELECT count(*) FROM crm_private.whatsapp_template_proposals
    WHERE artist_id='a1111111-1111-4111-8111-111111111111'::uuid
      AND kind='reminder_72h_cash'
      AND template_name='vishar_lifecycle_reminder_72h_v5'
      AND template_language='en_GB' AND approval_status='UNKNOWN'
      AND provider_template_id IS NULL AND verified_at IS NULL)<>1
  OR EXISTS (
    SELECT 1 FROM crm_private.whatsapp_template_proposals
    WHERE artist_id='a2222222-2222-4222-8222-222222222222'::uuid
      AND kind='reminder_72h_cash'
  )
  OR EXISTS (
    SELECT 1 FROM crm_private.lifecycle_whatsapp_template_registry
    WHERE purpose='session_reminder_72h'
      AND template_name='vishar_lifecycle_reminder_72h_v5'
  ) THEN
    RAISE EXCEPTION '72h cash candidate staging contract violated'
      USING errcode='23514';
  END IF;
END;
$postcheck$;
