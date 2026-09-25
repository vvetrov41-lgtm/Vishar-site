-- 20260924037000_converge_daily_retry.sql
--
-- Phase 6a follow-up. The convergence sweep deduplicated by watermark alone,
-- so a refresh that failed during a provider outage would never be swept
-- again until the client's facts changed. It is now once per watermark per
-- UTC day: a failing client is retried the next day, never in a loop.

create or replace function public.service_converge_client_ai_briefs(p_limit integer default 4)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_budget integer;
  v_queued integer := 0;
  v_stale integer := 0;
  v_row record;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;
  if not coalesce((select enabled from crm_private.crm_agent_config where singleton), false) then
    return jsonb_build_object('status', 'disabled');
  end if;
  -- One sweep at a time; a concurrent drain simply skips.
  if not pg_try_advisory_xact_lock(hashtext('crm_private.converge_client_ai_briefs')) then
    return jsonb_build_object('status', 'busy');
  end if;

  -- An hourly budget, so a mass invalidation drains over hours rather than
  -- becoming a burst of model calls.
  v_budget := least(greatest(coalesce(p_limit, 4), 0), 10) - (
    select count(*)::integer from public.crm_agent_jobs j
    where j.source_event_id like 'converge:%'
      and j.created_at > clock_timestamp() - interval '1 hour');

  -- Nothing can be queued this hour: do not compute a single watermark.
  if v_budget <= 0 then
    return jsonb_build_object('status', 'budget_spent', 'queued', 0, 'budget', 0);
  end if;

  for v_row in
    select s.artist_id, s.client_id, w.watermark
    from public.client_ai_state s
    cross join lateral (select crm_private.client_ai_watermark(s.artist_id, s.client_id) as watermark) w
    where w.watermark is not null
      and s.source_watermark is distinct from w.watermark
      and not exists (select 1 from public.crm_agent_jobs j
                      where j.artist_id = s.artist_id and j.client_id = s.client_id
                        and j.job_type = 'refresh_client_ai_state'
                        and j.status in ('pending', 'processing'))
    order by s.updated_at asc, s.client_id
  loop
    v_stale := v_stale + 1;
    if crm_private.schedule_client_ai_refresh(
         v_row.artist_id, v_row.client_id,
         'converge:' || to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDD') || ':'
           || left(v_row.watermark, 24)) is not null then
      v_queued := v_queued + 1;
    end if;
    -- Stop as soon as the budget is used; the rest waits for the next hour.
    exit when v_queued >= v_budget;
  end loop;

  return jsonb_build_object('status', 'ok', 'examined', v_stale, 'queued', v_queued, 'budget', v_budget);
end;
$$;

