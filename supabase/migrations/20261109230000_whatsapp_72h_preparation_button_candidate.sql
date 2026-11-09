-- Stage exactly one Vladimir-only 72h three-button Utility template.
-- No client sends, no approvals asserted, no active registry switched.
-- The FAQ URL is a static third button; the first two use existing one-use actions.
ALTER TABLE crm_private.whatsapp_template_proposals
  DROP CONSTRAINT whatsapp_template_proposals_kind_check,
  ADD CONSTRAINT whatsapp_template_proposals_kind_check
    CHECK (kind IN (
      'booking_tattoo','booking_consultation','booking_video',
      'reminder_72h','reminder_24h','reminder_consultation',
      'reminder_24h_button','reminder_consultation_button',
      'reminder_consultation_video','reminder_72h_button'
    ));

INSERT INTO crm_private.whatsapp_template_proposals
 (artist_id,kind,template_name,template_language)
VALUES
 ('a1111111-1111-4111-8111-111111111111','reminder_72h_button',
  'vishar_lifecycle_reminder_72h_v4','en_GB')
ON CONFLICT (artist_id,kind) DO NOTHING;

-- Preserve the same two one-use confirmation/reschedule capabilities as
-- the approved 72h v3 template. Only allow the extra pre-reviewed v4 identity.
DO $route$
DECLARE
 v_old text := $old$    if j.message_purpose='session_reminder_72h'
       and t.template_name='vishar_lifecycle_reminder_72h_v3' then$old$;
 v_new text := $new$    if j.message_purpose='session_reminder_72h'
       and t.template_name in ('vishar_lifecycle_reminder_72h_v3',
                               'vishar_lifecycle_reminder_72h_v4') then$new$;
 v_source text;
BEGIN
 SELECT pg_get_functiondef('crm_private.queue_lifecycle_whatsapp_job(uuid)'::regprocedure)
 INTO v_source;
 IF v_source IS NULL OR
  length(v_source)-length(replace(v_source,v_old,''))<>length(v_old)
 THEN RAISE EXCEPTION '72h capability source changed concurrently'; END IF;
 EXECUTE replace(v_source,v_old,v_new);
END;
$route$;

-- Separate approval-gated promotion: never change Meta, the booking card,
-- the 24h reminder, other artists, or any queued client message.
CREATE OR REPLACE FUNCTION crm_private.activate_reminder_72h_preparation_button(p_artist_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO pg_catalog,public,crm_private
AS $promo$
DECLARE v_approved integer;
BEGIN
 IF p_artist_id IS DISTINCT FROM 'a1111111-1111-4111-8111-111111111111'::uuid
   OR NOT EXISTS (SELECT 1 FROM public.artists a
     WHERE a.id=p_artist_id AND a.slug='vladimir')
 THEN RAISE EXCEPTION 'Only Vladimir reviewed 72h template can be activated'
   USING errcode='42501'; END IF;

 LOCK TABLE crm_private.whatsapp_template_proposals,
   crm_private.lifecycle_whatsapp_template_registry,
   public.integration_outbox IN SHARE ROW EXCLUSIVE MODE;

 IF EXISTS (SELECT 1 FROM crm_private.lifecycle_whatsapp_template_registry r
   WHERE r.artist_id=p_artist_id AND r.purpose='session_reminder_72h'
     AND r.template_name='vishar_lifecycle_reminder_72h_v4'
     AND r.approval_status='APPROVED')
 THEN RETURN 'already_active'; END IF;

 SELECT count(*) INTO v_approved
 FROM crm_private.whatsapp_template_proposals p
 WHERE p.artist_id=p_artist_id
   AND p.kind='reminder_72h_button'
   AND p.template_name='vishar_lifecycle_reminder_72h_v4'
   AND p.template_language='en_GB'
   AND p.approval_status='APPROVED'
   AND p.provider_template_id ~ '^[0-9]{5,32}$'
   AND p.verified_at>now()-interval '24 hours';
 IF v_approved<>1 THEN RETURN 'waiting_for_meta_approval'; END IF;

 IF NOT EXISTS (SELECT 1 FROM crm_private.lifecycle_whatsapp_template_registry r
   WHERE r.artist_id=p_artist_id AND r.purpose='session_reminder_72h'
     AND r.template_name='vishar_lifecycle_reminder_72h_v3'
     AND r.approval_status='APPROVED' AND r.provider_template_id IS NOT NULL)
 THEN RETURN 'active_template_drift'; END IF;

 IF EXISTS (SELECT 1 FROM public.integration_outbox o
   WHERE o.artist_id=p_artist_id AND o.kind='whatsapp_message'
     AND o.status IN ('pending','leased'))
 THEN RETURN 'outbox_not_drained'; END IF;

 UPDATE crm_private.lifecycle_whatsapp_template_registry r
 SET template_name=p.template_name,
     template_language=p.template_language,
     approval_status=p.approval_status,
     provider_template_id=p.provider_template_id,
     verified_at=p.verified_at
 FROM crm_private.whatsapp_template_proposals p
 WHERE r.artist_id=p_artist_id
   AND r.purpose='session_reminder_72h'
   AND p.artist_id=r.artist_id AND p.kind='reminder_72h_button'
   AND p.template_name='vishar_lifecycle_reminder_72h_v4';
 RETURN 'activated';
END;
$promo$;

REVOKE ALL ON FUNCTION crm_private.activate_reminder_72h_preparation_button(uuid)
 FROM PUBLIC,anon,authenticated,service_role;
