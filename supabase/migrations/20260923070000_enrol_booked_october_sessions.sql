-- Audit H-2 (Vishar CRM audit 2026-09-22): enrol two sessions that were booked
-- before lifecycle email was activated.
--
-- 0097 deliberately did not backfill already-booked sessions: a lifecycle job
-- only materialises from an `appointment.scheduled` automation event, and those
-- are projected from new activity_log rows. The owner has now decided that the
-- two confirmed tattoo sessions on 27 and 28 October 2026 should receive the
-- normal lifecycle emails, exactly as a session booked today would.
--
-- This migration uses the same path a new booking takes. It writes one
-- `appointment.scheduled` activity row per session; the existing projection
-- trigger turns it into an automation event, and the next scheduler tick
-- materialises the jobs from the enabled rules. Delivery, consent, suppression,
-- the Gmail route and the kill switches are all re-checked at send time by the
-- existing executor, so nothing here can send an email.
--
-- The helper refuses anything that would not be a plain, future enrolment:
--   * the session must exist, be `confirmed`, and start more than 72 hours
--     from now, so no reminder can fall due immediately;
--   * a session that already has an `appointment.scheduled` event or any
--     lifecycle job is left untouched, so a replay or a later rebooking can
--     never produce a second reminder.
-- It is private and runs only here; no role can call it.

create or replace function crm_private.enrol_booked_session_in_lifecycle(
  p_session_id uuid,
  p_reason text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_session public.sessions%rowtype;
begin
  if p_reason is null or p_reason !~ '^[a-z0-9_]{1,64}$' then
    raise exception 'an enrolment reason code is required' using errcode = '22023';
  end if;

  select * into v_session from public.sessions s where s.id = p_session_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_session.status <> 'confirmed' then
    return 'not_confirmed';
  end if;
  if v_session.start_at <= now() + interval '72 hours' then
    return 'too_close';
  end if;
  if exists (
    select 1 from public.automation_events e
    where e.entity_kind = 'session'
      and e.entity_id = p_session_id
      and e.event_type = 'appointment.scheduled'
  ) or exists (
    select 1 from public.automation_jobs j where j.session_id = p_session_id
  ) then
    return 'already_enrolled';
  end if;

  perform crm_private.log_artist_activity(
    v_session.artist_id,
    'appointment.scheduled',
    'system',
    null,
    v_session.client_id,
    v_session.enquiry_id,
    v_session.project_id,
    v_session.id,
    null,
    jsonb_build_object(
      'appointment_type', v_session.appointment_type,
      'status', v_session.status,
      'lifecycle_enrolment', p_reason
    )
  );
  return 'enrolled';
end;
$$;

revoke all on function crm_private.enrol_booked_session_in_lifecycle(uuid, text)
  from public, anon, authenticated, service_role;

comment on function crm_private.enrol_booked_session_in_lifecycle(uuid, text) is
  'Owner-approved, one-off lifecycle enrolment of an already-booked confirmed session through the normal appointment.scheduled event. Idempotent; refuses sessions within 72 hours.';

do $$
declare
  v_id uuid;
  v_outcome text;
begin
  foreach v_id in array array[
    '438b706a-ea4e-461d-96f5-4989c232afb3',
    'c4f2c594-ccae-4978-b45e-048c03f65e47'
  ]::uuid[] loop
    v_outcome := crm_private.enrol_booked_session_in_lifecycle(v_id, 'audit_h2_owner_approved');
    raise notice 'H-2 lifecycle enrolment %: %', v_id, v_outcome;
  end loop;
end;
$$;
