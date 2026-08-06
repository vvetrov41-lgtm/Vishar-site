-- 0031_appointment_five_minute_step.sql
--
-- Enforce five-minute appointment boundaries for new schedules and time changes.
-- Existing retained rows are preserved until the corresponding boundary changes.

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
      raise exception 'appointment times must use five-minute increments'
        using errcode = '22023';
    end if;
  else
    if new.start_at is distinct from old.start_at
       and mod(extract(epoch from new.start_at)::numeric, 300) <> 0 then
      raise exception 'appointment times must use five-minute increments'
        using errcode = '22023';
    end if;

    if new.end_at is distinct from old.end_at
       and mod(extract(epoch from new.end_at)::numeric, 300) <> 0 then
      raise exception 'appointment times must use five-minute increments'
        using errcode = '22023';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function crm_private.validate_appointment_time_step()
  from public, anon, authenticated, service_role;

drop trigger if exists sessions_validate_appointment_time_step on public.sessions;
create trigger sessions_validate_appointment_time_step
  before insert or update of start_at, end_at
  on public.sessions
  for each row execute function crm_private.validate_appointment_time_step();

comment on function crm_private.validate_appointment_time_step() is
  'Rejects new or changed appointment boundaries outside the five-minute grid while preserving each untouched legacy boundary.';
