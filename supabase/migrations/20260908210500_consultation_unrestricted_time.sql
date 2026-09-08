-- 20260908210500_consultation_unrestricted_time.sql
--
-- Native iOS datetime-local controls do not honor a five-minute wheel step.
-- Consultations intentionally accept arbitrary minute boundaries, while tattoo
-- sessions and touch-ups keep the existing five-minute invariant and stable
-- INVALID_APPOINTMENT_STEP refusal code.

create or replace function crm_private.validate_appointment_time_step()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_new_type text := to_jsonb(new)->>'appointment_type';
  v_old_type text;
begin
  if v_new_type in ('in_person_consultation', 'video_consultation') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if mod(extract(epoch from new.start_at)::numeric, 300) <> 0
       or mod(extract(epoch from new.end_at)::numeric, 300) <> 0 then
      perform crm_private.booking_error(
        'INVALID_APPOINTMENT_STEP',
        'appointment times must use five-minute increments'
      );
    end if;
  else
    v_old_type := to_jsonb(old)->>'appointment_type';

    -- If a consultation is converted to a strict appointment type, both
    -- boundaries must immediately satisfy the strict grid even when the time
    -- columns themselves were not edited in the same statement.
    if v_new_type is distinct from v_old_type then
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
  end if;

  return new;
end;
$$;

revoke all on function crm_private.validate_appointment_time_step()
  from public, anon, authenticated, service_role;

drop trigger if exists sessions_validate_appointment_time_step on public.sessions;
create trigger sessions_validate_appointment_time_step
  before insert or update of start_at, end_at, appointment_type
  on public.sessions
  for each row execute function crm_private.validate_appointment_time_step();

comment on function crm_private.validate_appointment_time_step() is
  'Allows unrestricted consultation minutes; rejects off-grid tattoo/touch-up boundaries with HINT INVALID_APPOINTMENT_STEP while preserving untouched legacy boundaries.';
