-- Alert on three distinct failed lifecycle jobs within 24 hours. Reuse the
-- existing personal notification inbox and Telegram delivery, never client mail.
-- Each recipient gets at most one alert per Artist/category/UTC day. No client,
-- message content, destination or raw provider error enters the notification.

create function public.service_sweep_lifecycle_failure_alerts(p_limit integer default 100)
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
    raise exception 'lifecycle failure alerts are backend-only' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'alert limit must be between 1 and 100' using errcode = '22023';
  end if;

  with failures as (
    select j.id, j.artist_id, 'execution'::text as category
    from public.automation_jobs j
    where j.action_type = 'send_client_message'
      and j.status = 'failed'
      and j.updated_at >= v_since
      and j.updated_at <= now()
    union all
    select j.id, j.artist_id, 'delivery'::text
    from public.automation_jobs j
    join public.email_messages em
      on em.automation_job_id = j.id and em.artist_id = j.artist_id
    where j.action_type = 'send_client_message'
      and j.status = 'completed'
      -- A successful send or a deliberate cancellation overrides an old
      -- failed provider attempt. Retries of one job never count as three jobs.
      and em.status not in ('sent', 'cancelled')
      and (
        (em.status = 'failed' and em.updated_at between v_since and now())
        or exists (
          select 1 from public.integration_outbox io
          where io.kind = 'approved_email'
            and io.email_message_id = em.id
            and io.artist_id = j.artist_id
            and io.status in ('failed', 'dead')
            and io.updated_at between v_since and now()
        )
      )
  ), grouped as (
    select f.artist_id, f.category
    from failures f
    join crm_private.artist_state a on a.artist_id = f.artist_id and a.is_active
    where crm_private.automations_enabled_for_artist(f.artist_id)
    group by f.artist_id, f.category
    having count(distinct f.id) >= 3
  ), targeted as (
    select g.artist_id, g.category, r.profile_id,
      'lifecycle_failure:' || g.artist_id::text || ':' || g.category || ':'
        || v_day || ':' || r.profile_id::text as dedupe_key
    from grouped g
    cross join lateral crm_private.automation_notification_recipients(g.artist_id) r
  ), due as (
    select t.* from targeted t
    -- Filter before LIMIT so already-notified Artists cannot starve later ones.
    where not exists (select 1 from public.notifications n where n.dedupe_key = t.dedupe_key)
    order by t.artist_id, t.category, t.profile_id
    limit p_limit
  ), inserted as (
    insert into public.notifications (
      recipient_profile_id, artist_id, notification_type, title, body,
      priority, status, dedupe_key, scheduled_at, delivered_at
    )
    select d.profile_id, d.artist_id, 'automation.lifecycle_' || d.category || '_failed',
      case d.category when 'execution' then 'Automatic messages need attention'
        else 'Automatic email delivery needs attention' end,
      case d.category when 'execution'
        then 'At least 3 automatic messages could not be prepared in the last 24 hours. Open Automations for this artist and review the errors.'
        else 'At least 3 automatic emails have delivery errors from the last 24 hours. Open Automations for this artist and review delivery history.' end,
      'high', 'delivered', d.dedupe_key, now(), now()
    from due d
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select count(*)::integer into v_created from inserted;
  return v_created;
end;
$$;

revoke all on function public.service_sweep_lifecycle_failure_alerts(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.service_sweep_lifecycle_failure_alerts(integer) to service_role;

comment on function public.service_sweep_lifecycle_failure_alerts(integer) is
  'Bounded backend-only daily-deduplicated personal alerts for repeated lifecycle execution or delivery failures. No customer data or outbound customer messages.';
