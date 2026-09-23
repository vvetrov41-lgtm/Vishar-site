-- Audit L-4 (Vishar CRM audit 2026-09-22): close two stale test sessions.
--
-- Two sessions created while testing self-service artist onboarding stayed
-- open after their date: e716ae38 (`confirmed`, 7 Sep 2026) and f8f0b61b
-- (`proposed`, 8 Sep 2026). Their clients are named "Vladimir Vishar test" and
-- "Test", their enquiries are already excluded from Statistics, and neither
-- has a calendar event or a lifecycle job. The owner decided to close them.
--
-- The close mirrors `set_appointment_status(..., 'cancelled')` without its
-- caller checks: the same allowed transition, `cancelled_at`, a
-- `calendar_version` bump and an audited `appointment.status_changed`
-- activity row, here with actor `system` and a reason code. A cancellation
-- only reaches a provider when the session has a calendar event, and the
-- helper refuses one that does, so this sends nothing to anyone. Nothing is
-- deleted: the append-only history keeps both sessions and the reason.
--
-- The helper is private, idempotent, and refuses anything that is not a
-- past, still-open session whose enquiry is excluded from Statistics.

create or replace function crm_private.close_stale_test_session(
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
    raise exception 'a close reason code is required' using errcode = '22023';
  end if;

  select * into v_session from public.sessions s where s.id = p_session_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_session.status = 'cancelled' then
    return 'already_closed';
  end if;
  if v_session.status not in ('draft', 'proposed', 'confirmed') then
    return 'not_open';
  end if;
  if v_session.start_at >= now() then
    return 'not_past';
  end if;
  if v_session.calendar_event_id is not null then
    return 'has_calendar_event';
  end if;
  if v_session.enquiry_id is null or not exists (
    select 1 from public.enquiries e
    where e.id = v_session.enquiry_id and e.excluded_from_analytics
  ) then
    return 'not_marked_test';
  end if;

  update public.sessions s
  set status = 'cancelled',
      cancelled_at = now(),
      calendar_version = s.calendar_version + 1
  where s.id = p_session_id;

  perform crm_private.log_artist_activity(
    v_session.artist_id,
    'appointment.status_changed',
    'system',
    null,
    v_session.client_id,
    v_session.enquiry_id,
    v_session.project_id,
    v_session.id,
    null,
    jsonb_build_object(
      'appointment_type', v_session.appointment_type,
      'from_status', v_session.status,
      'to_status', 'cancelled',
      'close_reason', p_reason
    )
  );
  return 'closed';
end;
$$;

revoke all on function crm_private.close_stale_test_session(uuid, text)
  from public, anon, authenticated, service_role;

comment on function crm_private.close_stale_test_session(uuid, text) is
  'Owner-approved close of a past, still-open test session whose enquiry is excluded from Statistics. Idempotent; refuses sessions with a calendar event.';

do $$
declare
  v_id uuid;
  v_outcome text;
begin
  foreach v_id in array array[
    'e716ae38-ebdc-4b01-8c05-98f015e98d97',
    'f8f0b61b-3337-49b9-9e3d-3f5f45b753af'
  ]::uuid[] loop
    v_outcome := crm_private.close_stale_test_session(v_id, 'audit_l4_owner_approved_test_data');
    raise notice 'L-4 stale test session %: %', v_id, v_outcome;
  end loop;
end;
$$;
