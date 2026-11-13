-- 13 November 2026 production aftercare reliability.
-- In-app, per-session alert for a verified *new* missed aftercare.
-- Never queue, resend, mutate or retry a client-facing message.
-- Historical jobs older than 48h are intentionally excluded.
create or replace function crm_private.notify_missed_aftercare_jobs(
  p_limit integer default 100
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_count integer := 0;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Aftercare alert sweep is backend-only'
      using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Invalid aftercare alert limit' using errcode = '22023';
  end if;
  with missed as (
    select j.id job_id, j.artist_id, j.session_id, j.scheduled_at
    from public.automation_jobs j
    join public.sessions s
      on s.id = j.session_id and s.artist_id = j.artist_id
    join public.artists a on a.id = j.artist_id
    join crm_private.artist_state ast
      on ast.artist_id = j.artist_id and ast.is_active
    where j.action_type = 'send_client_message'
      and j.message_purpose = 'post_session_aftercare'
      and j.status in ('failed','pending')
      and s.status = 'completed'
      and s.appointment_type in ('tattoo_session','touch_up')
      and j.scheduled_at <= now() - interval '30 minutes'
      and j.scheduled_at >= now() - interval '48 hours'
      and crm_private.automations_enabled_for_artist(j.artist_id)
      and (
        j.status = 'failed'
        or (
          j.status = 'pending'
          and (
            crm_private.lifecycle_block_disposition(j.id) = 'eligible'
            or (
              crm_private.lifecycle_block_disposition(j.id) = 'defer'
              and crm_private.lifecycle_aftercare_followup(s.id)
              and j.scheduled_at <= now() - interval '6 hours'
            )
          )
        )
      )
      -- The outcome may be unknown if a provider send was already started.
      -- No extra warning should suggest sending that message again.
      and not exists (
        select 1 from public.email_messages em
        where em.automation_job_id = j.id
      )
      and not exists (
        select 1 from crm_private.lifecycle_whatsapp_payloads wa
        where wa.automation_job_id = j.id
      )
      and not exists (
        select 1 from crm_private.lifecycle_instagram_payloads ig
        where ig.automation_job_id = j.id
      )
      -- An alternate job already processed the same local-day aftercare.
      and not exists (
        select 1 from crm_private.session_lifecycle_block(s.id) b
        join public.automation_jobs other
          on other.session_id = b.session_id
          and other.artist_id = j.artist_id
        where b.local_day = (s.start_at at time zone a.timezone)::date
          and other.id <> j.id
          and other.message_purpose = 'post_session_aftercare'
          and other.status = 'completed'
      )
  ), recipients as (
    select m.*, r.profile_id,
      'aftercare_missed:' || m.job_id::text || ':' || r.profile_id::text as dedupe_key
    from missed m
    cross join lateral crm_private.automation_notification_recipients(m.artist_id) r
  ), due as (
    select r.* from recipients r
    where not exists (
      select 1 from public.notifications n
      where n.dedupe_key = r.dedupe_key
    )
    order by r.scheduled_at, r.job_id, r.profile_id
    limit p_limit
  ), inserted as (
    insert into public.notifications (
      recipient_profile_id, artist_id, notification_type,
      title, body, entity_type, entity_id,
      priority, status, dedupe_key, scheduled_at, delivered_at
    )
    select d.profile_id, d.artist_id, 'automation.aftercare_needs_attention',
      'Aftercare needs attention',
      'The automatic aftercare message for this completed tattoo session was not prepared on time. Check its conversation and delivery history before contacting the client.',
      'session', d.session_id, 'high', 'delivered',
      d.dedupe_key, now(), now()
    from due d
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select count(*)::integer into v_count from inserted;
  return v_count;
end;
$function$;

revoke all on function crm_private.notify_missed_aftercare_jobs(integer)
  from public, anon, authenticated, service_role;

-- The existing 5-minute scheduler already invokes this backend-only RPC.
-- Add per-session missed-aftercare notices without another cron or Worker.

CREATE OR REPLACE FUNCTION public.service_sweep_lifecycle_failure_alerts(p_limit integer DEFAULT 100)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
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
  return v_created + crm_private.notify_missed_aftercare_jobs(p_limit);
end;
$function$
;
