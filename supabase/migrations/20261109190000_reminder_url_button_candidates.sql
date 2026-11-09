-- Stage Meta-reviewed replacement identities, without activation or client sends.
-- Keep existing approved live reminder cards unchanged until Meta approves.
ALTER TABLE crm_private.whatsapp_template_proposals
  DROP CONSTRAINT whatsapp_template_proposals_kind_check,
  ADD CONSTRAINT whatsapp_template_proposals_kind_check
    CHECK (kind IN ('booking_tattoo','booking_consultation','booking_video',
      'reminder_72h','reminder_24h','reminder_consultation',
      'reminder_24h_button','reminder_consultation_button',
      'reminder_consultation_video'));
INSERT INTO crm_private.whatsapp_template_proposals
  (artist_id,kind,template_name,template_language)
VALUES
 ('a1111111-1111-4111-8111-111111111111','reminder_24h_button',
  'vishar_lifecycle_reminder_24h_v4','en_GB'),
 ('a1111111-1111-4111-8111-111111111111','reminder_consultation_button',
  'vishar_lifecycle_consultation_v5','en_GB'),
 ('a1111111-1111-4111-8111-111111111111','reminder_consultation_video',
  'vishar_lifecycle_consultation_video_v1','en_GB')
ON CONFLICT (artist_id,kind) DO NOTHING;
ALTER TABLE crm_private.whatsapp_template_smoke_tests
  DROP CONSTRAINT whatsapp_template_smoke_tests_body_parameters_check,
  ADD CONSTRAINT whatsapp_template_smoke_tests_body_parameters_check
    CHECK (jsonb_typeof(body_parameters)='array' AND (
      (purpose='consultation_reminder' AND jsonb_array_length(body_parameters) IN (4,5))
      OR (purpose='session_reminder_72h' AND jsonb_array_length(body_parameters)=4)
      OR (purpose='session_reminder_24h' AND jsonb_array_length(body_parameters)=3)
    ));
