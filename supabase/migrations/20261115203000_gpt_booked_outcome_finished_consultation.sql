-- ChatGPT plugin parity: "Booked a tattoo" for a finished consultation.
--
-- The Today card in the CRM records a consultation outcome as soon as the
-- consultation has ended, while its status is still `confirmed`:
-- crm_private.visit_outcome_due lists confirmed and completed consultations,
-- and public.record_visit_outcome moves a confirmed one to `completed` itself.
-- Consultations are never auto-completed (only tattoo sessions are), so a
-- confirmed status is the normal state after the visit. In production on
-- 2026-11-15 both of Kristina's finished consultations without an outcome
-- were still `confirmed`.
--
-- The plugin wrapper accepted only `completed`, so the same answer given in
-- ChatGPT was refused, and the only way round it was setAppointmentStatus,
-- which checks no end time and edits the calendar event. Now the wrapper
-- accepts a finished consultation that is `confirmed` or `completed`, exactly
-- the set the Today card offers, and hands it to the same record_visit_outcome
-- call. Everything else in the function is unchanged: artist scope, fresh
-- request id, expected version zero, one linked booking of the same client,
-- no payment, no new appointment, no message.

create or replace function public.gpt_record_consultation_booked_outcome(
  p_session_id uuid,
  p_request_id uuid,
  p_expected_version integer,
  p_linked_session_id uuid
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_ctx record;
  v_session public.sessions%rowtype;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('appointments', 'manage_sessions');
  select * into v_session from public.sessions s where s.id = p_session_id;
  perform crm_private.require_gpt_record_artist(v_session.artist_id, v_ctx.artist_id, 'consultation');

  -- Same eligibility as the Today card (crm_private.visit_outcome_due):
  -- a consultation that has ended and is confirmed or already completed.
  if v_session.appointment_type not in ('video_consultation', 'in_person_consultation')
     or v_session.status not in ('confirmed', 'completed')
     or v_session.cancelled_at is not null
     or v_session.end_at > clock_timestamp() then
    raise exception 'only a consultation that has already finished can be recorded here'
      using errcode = '22023';
  end if;
  if p_request_id is null or p_linked_session_id is null or p_expected_version <> 0 then
    raise exception 'provide a fresh request id, one linked booking and expected version zero'
      using errcode = '22023';
  end if;

  -- Read and record are individually artist-scoped. The underlying outcome
  -- RPC validates that the linked booking belongs to the SAME artist/client.
  if exists (
    select 1 from public.visit_outcomes o
    where o.session_id = p_session_id
  ) and not exists (
    select 1 from public.visit_outcome_revisions r
    where r.session_id = p_session_id and r.operation_id = p_request_id
  ) then
    raise exception 'this consultation already has an outcome; use the CRM correction form'
      using errcode = '23514';
  end if;

  -- The existing audited workflow provides idempotency, version locking,
  -- status synchronization (confirmed -> completed, as in the CRM form) and
  -- immutable revision history. A booked, free consultation has NO payment,
  -- fee, follow-up or message.
  return public.record_visit_outcome(
    p_session_id, p_request_id, p_expected_version, 'booked',
    jsonb_build_object('linked_session_id', p_linked_session_id)
  );
end;
$fn$;

revoke all on function public.gpt_record_consultation_booked_outcome(uuid,uuid,integer,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.gpt_record_consultation_booked_outcome(uuid,uuid,integer,uuid)
  to authenticated;
