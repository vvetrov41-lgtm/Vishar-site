-- Ledger reconciliation: this exact statement is already applied in production.
--
-- Production recorded version 20261111204748
-- (`ignore_whatsapp_attendance_confirm_buttons_for_reply_alerts`) on
-- 2026-11-11 through Supabase's migration API, outside the private production
-- release. The canonical branch never carried it, so:
--
--   * `supabase db push` from the canonical branch would refuse to run with
--     "Remote migration versions not found in local migrations directory";
--   * a later migration that redefines this function from the repository copy
--     would silently revert the production behaviour.
--
-- The body below is byte-for-byte the statement stored in
-- supabase_migrations.schema_migrations for that version (md5
-- 4ba6499ff17384dc685da54b28e0a35b, 2006 bytes). Because the version already
-- exists remotely, the release treats this file as applied and does not run it
-- again; on a fresh database it reproduces production.
--
-- Behaviour: tapping Meta's "confirm attendance" quick reply is an action, not
-- a message the artist owes a reply to. The button row is recorded in the same
-- transaction as sessions.client_response_at, so the two timestamps are equal.
-- Other buttons, including a reschedule request, still wait for a reply.

CREATE OR REPLACE FUNCTION crm_private.inbound_message_handled_by_booking(p_message_id uuid)
RETURNS timestamp with time zone
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
  WITH msg AS (
    SELECT m.id, m.message_type, m.created_at AS recorded_at,
           c.artist_id, c.client_id, c.enquiry_id, c.channel,
           coalesce(m.provider_timestamp, m.created_at) AS at
    FROM public.communication_messages m
    JOIN public.communication_conversations c ON c.id = m.conversation_id
    WHERE m.id = p_message_id
      AND m.direction = 'inbound'
      AND c.client_id IS NOT NULL
  ), evidence AS (
    SELECT crm_private.appointment_confirmed_at(s.id) AS confirmed_at,
           msg.at, msg.recorded_at, msg.message_type,
           s.client_response, s.client_response_at,
           crm_private.studio_outbound_capture_started_at(msg.artist_id, msg.channel) AS capture_at
    FROM msg
    JOIN public.sessions s
      ON s.artist_id = msg.artist_id AND s.client_id = msg.client_id
    WHERE s.status = 'confirmed' AND s.cancelled_at IS NULL
      AND (msg.enquiry_id IS NULL
           OR s.enquiry_id = msg.enquiry_id
           OR EXISTS (
             SELECT 1 FROM public.projects p
             WHERE p.id = s.project_id AND p.enquiry_id = msg.enquiry_id
           ))
  )
  SELECT min(CASE
    -- Meta's appointment-confirmation button is recorded at exactly the same
    -- transaction time as sessions.client_response_at. It is an action, not
    -- a customer message that requires an artist's reply.
    -- Do not suppress unrelated buttons, including reschedule requests.
    WHEN e.message_type = 'button'
     AND e.client_response = 'attendance_confirmed'
     AND e.client_response_at = e.recorded_at
    THEN e.client_response_at
    WHEN e.confirmed_at >= e.at THEN e.confirmed_at
    WHEN e.capture_at IS NOT NULL AND e.at < e.capture_at
    THEN greatest(e.confirmed_at, e.at)
  END)
  FROM evidence e;
$function$;
