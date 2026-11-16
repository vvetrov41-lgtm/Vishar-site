-- 20261116160000_healing_check_whatsapp_candidate.sql
--
-- Stage the Meta Utility template for the artist-initiated healing question
-- (specs/google-review-request). Vladimir only: Kristina's WhatsApp Cloud API
-- route does not exist yet.
--
-- This only queues the template for Meta review through the existing
-- maintenance claim. No registry row, rule, job, send path or client message
-- is added: an approved candidate cannot be used by the lifecycle sender,
-- which reads only crm_private.lifecycle_whatsapp_template_registry.

ALTER TABLE crm_private.lifecycle_whatsapp_template_candidates
  DROP CONSTRAINT lifecycle_whatsapp_template_candidates_purpose_check,
  ADD CONSTRAINT lifecycle_whatsapp_template_candidates_purpose_check
  CHECK (purpose IN (
    'session_reminder_72h','session_reminder_24h',
    'consultation_reminder','post_session_aftercare','post_session_checkin',
    'healing_check'
  ));

INSERT INTO crm_private.lifecycle_whatsapp_template_candidates(
  artist_id,purpose,template_name,template_language)
SELECT a.id,'healing_check','vishar_healing_check_v1','en_GB'
FROM public.artists a
WHERE a.id='a1111111-1111-4111-8111-111111111111'::uuid
ON CONFLICT (artist_id,purpose) DO NOTHING;
