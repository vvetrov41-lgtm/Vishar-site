-- 20260922210000_operational_failure_alerts.sql
--
-- Audit H-5 (2026-09-22). Production Workers report no errors anywhere a
-- person looks: Sentry is wired only into the Cloudflare gateway (disabled),
-- and dead outbox jobs and failed AI jobs were found only by the audit.
--
-- This sweep turns those failures into the existing internal notifications,
-- which the scheduler already delivers to each recipient's personal Telegram:
--
--   * outbox jobs that became dead in the last 24 hours, excluding deliberate
--     outcomes (operator cancellation, obsolete deposit email);
--   * enquiry AI and CRM agent jobs that failed in the last 24 hours;
--   * one notification per artist, category, UTC day and recipient;
--   * counts only: no client names, contact details or message content.

create or replace function public.service_sweep_operational_failure_alerts(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_created integer;
  v_since timestamptz := now() - interval '24 hours';
  v_day text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD');
begin
  if not crm_private.is_service_backend() then
    raise exception 'operational failure alerts are backend-only' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'alert limit must be between 1 and 100' using errcode = '22023';
  end if;

  with failures as (
    select o.artist_id, 'outbox_dead'::text as category
    from public.integration_outbox o
    where o.status = 'dead'
      and o.updated_at between v_since and now()
      and coalesce(o.last_error_code, '') not in ('operator_cancelled', 'gmail_deposit_email_obsolete')
    union all
    select j.artist_id, 'ai_failed'::text
    from public.enquiry_ai_jobs j
    where j.status::text = 'failed'
      and j.updated_at between v_since and now()
    union all
    select j.artist_id, 'ai_failed'::text
    from public.crm_agent_jobs j
    where j.status::text = 'failed'
      and j.updated_at between v_since and now()
  ), grouped as (
    select f.artist_id, f.category, count(*)::integer as failure_count
    from failures f
    join crm_private.artist_state a on a.artist_id = f.artist_id and a.is_active
    where f.artist_id is not null
    group by f.artist_id, f.category
  ), targeted as (
    select g.artist_id, g.category, g.failure_count, r.profile_id,
      'operational_failure:' || g.artist_id::text || ':' || g.category || ':'
        || v_day || ':' || r.profile_id::text as dedupe_key
    from grouped g
    cross join lateral crm_private.automation_notification_recipients(g.artist_id) r
  ), due as (
    select t.* from targeted t
    where not exists (select 1 from public.notifications n where n.dedupe_key = t.dedupe_key)
    order by t.artist_id, t.category, t.profile_id
    limit p_limit
  ), inserted as (
    insert into public.notifications (
      recipient_profile_id, artist_id, notification_type, title, body,
      priority, status, dedupe_key, scheduled_at, delivered_at
    )
    select d.profile_id, d.artist_id,
      case d.category when 'outbox_dead' then 'system.integration_delivery_failed'
        else 'system.ai_processing_failed' end,
      case d.category when 'outbox_dead' then 'Integration deliveries need attention'
        else 'AI processing needs attention' end,
      case d.category when 'outbox_dead'
        then d.failure_count || ' notification, calendar or message deliveries stopped retrying in the last 24 hours. Open Activity for this artist and check the failed items.'
        else d.failure_count || ' AI summaries could not be produced in the last 24 hours. The enquiries are saved; open them to review manually or retry AI.' end,
      'high', 'delivered', d.dedupe_key, now(), now()
    from due d
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select count(*)::integer into v_created from inserted;
  return v_created;
end;
$$;

revoke all on function public.service_sweep_operational_failure_alerts(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.service_sweep_operational_failure_alerts(integer) to service_role;

comment on function public.service_sweep_operational_failure_alerts(integer) is
  'Bounded backend-only daily-deduplicated alerts for dead outbox jobs and failed AI jobs. Counts only; no customer data.';
