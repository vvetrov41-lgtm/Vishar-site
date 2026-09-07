-- 20260907182500_booking_time_step_error_code.sql
--
-- Keep the existing five-minute appointment invariant, but make its refusal
-- machine-readable to every booking caller. The old trigger raised SQLSTATE
-- 22023 with no hint, so the CRM could only show a generic "could not create"
-- message when a mobile datetime picker supplied (for example) 10:03.
--
-- Nothing is relaxed: the same start/end boundaries are still rejected. The
-- only behavioural change is HINT = INVALID_APPOINTMENT_STEP.

create or replace function crm_private.validate_appointment_time_step()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if tg_op = 'INSERT' then
    if mod(extract(epoch from new.start_at)::numeric, 300) <> 0
       or mod(extract(epoch from new.end_at)::numeric, 300) <> 0 then
      perform crm_private.booking_error(
        'INVALID_APPOINTMENT_STEP',
        'appointment times must use five-minute increments'
      );
    end if;
  else
    if new.start_at is distinct from old.start_at
       and mod(extract(epoch from new.start_at)::numeric, 300) <> 0 then
      perform crm_private.booking_error(
        'INVALID_APPOINTMENT_STEP',
        'appointment times must use five-minute increments'
      );
    end if;

    if new.end_at is distinct from old.end_at
       and mod(extract(epoch from new.end_at)::numeric, 300) <> 0 then
      perform crm_private.booking_error(
        'INVALID_APPOINTMENT_STEP',
        'appointment times must use five-minute increments'
      );
    end if;
  end if;

  return new;
end;
$$;

revoke all on function crm_private.validate_appointment_time_step()
  from public, anon, authenticated, service_role;

comment on function crm_private.validate_appointment_time_step() is
  'Reject appointment boundaries outside the five-minute grid with HINT INVALID_APPOINTMENT_STEP while preserving untouched legacy boundaries.';
