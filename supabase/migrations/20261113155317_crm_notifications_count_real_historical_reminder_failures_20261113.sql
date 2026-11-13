CREATE OR REPLACE FUNCTION crm_private.lifecycle_notification_required(p_job_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
  -- Determine if a specific lifecycle message is expected under the active
  -- appointment schedule. Suppressed duplicate jobs are not incidents.
  SELECT COALESCE((
    SELECT CASE
      WHEN s.status IN ('cancelled','no_show') THEN false
      WHEN j.message_purpose='post_session_aftercare' THEN
        s.status='completed'
        AND s.id=(
          SELECT b.session_id
          FROM crm_private.session_lifecycle_block(s.id) b
          ORDER BY b.start_at,b.session_id LIMIT 1
        )
      WHEN j.message_purpose='post_session_checkin' THEN
        s.status='completed'
        AND s.id=(
          SELECT b.session_id
          FROM crm_private.session_lifecycle_block(s.id) b
          ORDER BY b.end_at DESC,b.session_id DESC LIMIT 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM crm_private.session_lifecycle_block(s.id) b
          JOIN public.sessions bs ON bs.id=b.session_id
          WHERE bs.status<>'completed'
        )
      WHEN j.message_purpose IN ('session_reminder_24h','session_reminder_72h') THEN
        s.status IN ('confirmed','completed')
        AND s.id=(
          SELECT b.session_id FROM crm_private.session_lifecycle_block(s.id) b
          ORDER BY b.start_at,b.session_id LIMIT 1
        )
      WHEN j.message_purpose='consultation_reminder' THEN
        s.status IN ('confirmed','completed')
      ELSE true
    END
    FROM public.automation_jobs j
    JOIN public.sessions s ON s.id=j.session_id AND s.artist_id=j.artist_id
    WHERE j.id=p_job_id
      AND j.action_type='send_client_message'
      AND j.status IN ('pending','failed','completed')
  ), false);
$function$;
COMMENT ON FUNCTION crm_private.lifecycle_notification_required(uuid) IS 'Operational policy: notify only on genuinely required lifecycle messages. Consecutive tattoo sessions: full aftercare immediately after first, no intervening guides, check-in 24h after last. Do not alert on suppressed, cancelled, superseded or already delivered sends. Historical failed reminders still count toward the three-failures-in-24h threshold, even when an appointment has since completed.';
