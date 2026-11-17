-- Healing question template is staged for Meta review only.
-- Metadata-only fixtures; no client, job or provider send.
BEGIN;
SELECT no_plan();

SELECT is(
 (SELECT count(*)::integer
  FROM crm_private.lifecycle_whatsapp_template_candidates c
  WHERE c.purpose='healing_check'
    AND c.template_name='vishar_healing_check_v1'
    AND c.template_language='en_GB'
    AND c.artist_id='a1111111-1111-4111-8111-111111111111'::uuid),
 1, 'healing question candidate is staged for Vladimir');

SELECT is(
 (SELECT count(*)::integer
  FROM crm_private.lifecycle_whatsapp_template_candidates c
  WHERE c.purpose='healing_check'
    AND c.artist_id<>'a1111111-1111-4111-8111-111111111111'::uuid),
 0, 'no other artist is staged before their WhatsApp route exists');

SELECT is(
 (SELECT count(*)::integer
  FROM crm_private.lifecycle_whatsapp_template_candidates c
  WHERE c.purpose='healing_check'
    AND c.approval_status='UNKNOWN'
    AND c.provider_template_id IS NULL
    AND c.verified_at IS NULL),
 1, 'no Meta approval is fabricated');

SELECT is(
 (SELECT count(*)::integer
  FROM crm_private.lifecycle_whatsapp_template_registry r
  WHERE r.purpose='healing_check' OR r.template_name='vishar_healing_check_v1'),
 0, 'the lifecycle sender registry is untouched');

SELECT is(
 (SELECT count(*)::integer FROM public.automation_rules r
  WHERE r.message_purpose='healing_check'),
 0, 'no automation rule can send the healing question');

SELECT throws_ok(
 $$INSERT INTO crm_private.lifecycle_whatsapp_template_candidates
     (artist_id,purpose,template_name,template_language)
   VALUES ('a1111111-1111-4111-8111-111111111111','review_request',
           'vishar_review_request_v1','en_GB')$$,
 '23514', NULL, 'unknown purposes are still rejected');

SELECT * FROM finish();
ROLLBACK;
