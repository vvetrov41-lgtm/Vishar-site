-- 20260923000000_public_scheduler_heartbeat_status.sql
--
-- Audit H-5 follow-up (2026-09-22). The operational failure sweep runs inside
-- the production scheduler, so it cannot report the scheduler itself being
-- dead. An external monitor that holds no production credential needs one
-- narrow, anonymous read: how old is the last successful lifecycle tick.
--
-- The result carries no Artist, client, appointment, provider or credential
-- data - only the singleton heartbeat age. Staleness uses the same 15-minute
-- threshold as get_lifecycle_automation_health (three missed */5 windows).

create function public.get_scheduler_heartbeat_status()
returns table (
  last_succeeded_at timestamptz,
  age_seconds integer,
  stale boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  -- Always exactly one row; a missing heartbeat is reported as stale.
  select
    h.last_succeeded_at,
    case when h.last_succeeded_at is not null
      then greatest(0, floor(extract(epoch from (now() - h.last_succeeded_at))))::integer
    end,
    coalesce(h.last_succeeded_at < now() - interval '15 minutes', true)
  from (select 1) as one
  left join crm_private.automation_scheduler_heartbeat h on h.singleton;
$$;

revoke all on function public.get_scheduler_heartbeat_status() from public;
grant execute on function public.get_scheduler_heartbeat_status()
  to anon, authenticated, service_role;

comment on function public.get_scheduler_heartbeat_status() is
  'Anonymous read of the lifecycle scheduler heartbeat age for the external watchdog. Returns no customer or provider data.';
