-- 20261112210000_lifecycle_integration_failure_auto_retry.sql
--
-- A client lifecycle message (reminder, aftercare, check-in) whose sending
-- integration was unavailable was marked failed on its first attempt and never
-- tried again: the executor only reads pending jobs, and the only way back was
-- the operator RPC retry_client_lifecycle_job. A revoked Gmail token on
-- 2026-11-08 therefore lost every reminder that fell due while the account was
-- disconnected, including ones whose appointment was still a day away when the
-- account could have been reconnected.
--
-- The scheduler now returns such a job to pending, but only while the message
-- is still current:
--
--   * before the appointment: the appointment is confirmed and has not started;
--   * after the appointment: it is completed and the message is less than
--     24 hours late;
--   * no later message of the same series for that appointment is already due
--     (a recovered 72-hour reminder is not sent once the 24-hour one is due);
--   * nothing was materialised for the job (no email row, no WhatsApp payload),
--     the same irreversible boundary retry_client_lifecycle_job uses;
--   * the rule is still enabled at the job's version and the artist's
--     automations are not switched off.
--
-- A message that is no longer current stays failed and is never back-sent.
-- Attempts are spaced 30 minutes apart; the artist alert for the failure is
-- deduplicated per job, so repeated attempts do not repeat the alert.
-- attempt_count keeps the history of every attempt.

create or replace function crm_private.requeue_recoverable_lifecycle_jobs(p_limit integer default 100)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_requeued integer := 0;
begin
  with candidates as (
    select j.id
    from public.automation_jobs j
    join public.sessions s
      on s.id = j.session_id
     and s.artist_id = j.artist_id
    join public.automation_rules r
      on r.id = j.rule_id
     and r.artist_id = j.artist_id
    where j.status = 'failed'::public.automation_job_status
      and j.action_type = 'send_client_message'::public.automation_action_type
      and j.last_error_category = 'integration_unavailable'
      and j.updated_at <= now() - interval '30 minutes'
      and r.is_enabled
      and r.version = j.rule_version
      and s.appointment_type = j.condition_appointment_type
      and crm_private.automations_enabled_for_artist(j.artist_id)
      -- Once anything was materialised a replay could duplicate a client
      -- message; that boundary belongs to the delivery layer.
      and not exists (
        select 1 from public.email_messages m
        where m.automation_job_id = j.id
      )
      and not exists (
        select 1 from crm_private.lifecycle_whatsapp_payloads p
        where p.automation_job_id = j.id
      )
      -- Still current.
      and (
        (j.schedule_anchor = 'session_start'::public.automation_schedule_anchor
         and s.status = 'confirmed'
         and s.start_at > now())
        or
        (j.schedule_anchor = 'session_end'::public.automation_schedule_anchor
         and s.status = 'completed'
         and coalesce(s.actual_end_at, s.end_at)
             + make_interval(mins => j.anchor_offset_minutes)
             > now() - interval '24 hours')
      )
      -- Not overtaken by a later message of the same series.
      and not exists (
        select 1
        from public.automation_jobs n
        where n.session_id = j.session_id
          and n.artist_id = j.artist_id
          and n.id <> j.id
          and n.action_type = 'send_client_message'::public.automation_action_type
          and n.schedule_anchor = j.schedule_anchor
          and n.anchor_offset_minutes > j.anchor_offset_minutes
          and n.status <> 'cancelled'::public.automation_job_status
          and case n.schedule_anchor
                when 'session_start'::public.automation_schedule_anchor then s.start_at
                else coalesce(s.actual_end_at, s.end_at)
              end + make_interval(mins => n.anchor_offset_minutes) <= now()
      )
    order by j.scheduled_at, j.id
    limit least(greatest(coalesce(p_limit, 100), 1), 500)
    for update of j skip locked
  ),
  requeued as (
    update public.automation_jobs j
    set status = 'pending'::public.automation_job_status,
        last_error_category = null,
        completed_at = null,
        cancelled_at = null
    from candidates c
    where j.id = c.id
    returning 1
  )
  select count(*)::integer into v_requeued from requeued;

  return v_requeued;
end;
$function$;

comment on function crm_private.requeue_recoverable_lifecycle_jobs(integer) is
  'Returns client lifecycle jobs that failed with integration_unavailable to pending while the message is still current and nothing was materialised. Called only by service_run_automation_tick.';

revoke all on function crm_private.requeue_recoverable_lifecycle_jobs(integer)
  from public, anon, authenticated, service_role;

-- service_run_automation_tick: the definition below is the one production runs
-- (20261030085308, body md5 4b37a2d702a6623587afaa6db498cf3e) with one added
-- statement, the call to requeue_recoverable_lifecycle_jobs.
CREATE OR REPLACE FUNCTION public.service_run_automation_tick(p_limit integer DEFAULT 100)
 RETURNS TABLE(materialised integer, withdrawn integer, executed integer, notified integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_materialised integer := 0;
  v_withdrawn integer := 0;
  v_executed integer := 0;
  v_notified integer := 0;
  v_client_job record;
  v_client_result text;
  v_recovery_session uuid;
begin
  if not crm_private.is_service_backend() then
    raise exception 'automation ticks are backend-only' using errcode = '42501';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'automation tick limit must be between 1 and 500' using errcode = '22023';
  end if;

  -- Complete eligible tattoo sessions before selecting due client lifecycle emails.
  perform crm_private.auto_complete_due_tattoo_sessions(100);

  -- Re-enrol confirmed future tattoos that predate lifecycle activation. The
  -- existing private helper locks and rechecks the session, refuses anything
  -- within 72 hours and refuses a session with an event or any job already.
  -- Bounded work keeps one sweep from starving other automation.
  for v_recovery_session in
    select s.id from public.sessions s
    join crm_private.artist_state a on a.artist_id=s.artist_id and a.is_active
    where s.status='confirmed' and s.appointment_type in ('tattoo_session','touch_up')
      and s.start_at>now()+interval '72 hours'
      and not exists (select 1 from public.automation_events e
        where e.entity_kind='session' and e.entity_id=s.id and e.event_type='appointment.scheduled')
      and not exists (select 1 from public.automation_jobs j where j.session_id=s.id)
    order by s.start_at,s.id limit 25
  loop
    perform crm_private.enrol_booked_session_in_lifecycle(v_recovery_session,'lifecycle_reconciliation');
  end loop;

  with pairs as (
    select r.id as rule_id, r.version, e.id as event_id, e.artist_id,
           r.action_type, r.action_title, r.action_body, r.action_priority,
           r.schedule_anchor, r.anchor_offset_minutes,
           r.condition_appointment_type,
           r.message_purpose, r.message_channel, r.message_locale,
           case
             when r.action_type = 'send_client_message'::public.automation_action_type
             then e.entity_id
             else null
           end as session_id,
           crm_private.resolve_automation_scheduled_at(
             r.schedule_anchor,
             r.delay_minutes,
             r.anchor_offset_minutes,
             e.occurred_at,
             e.artist_id,
             e.entity_kind,
             e.entity_id,
             r.condition_appointment_type
           ) as scheduled_at
    from public.automation_events e
    join public.automation_rules r
      on r.artist_id = e.artist_id
     and r.trigger_event_type = e.event_type
     and r.is_enabled
    where (r.condition_from_status is null or r.condition_from_status = e.from_status)
      and (r.condition_to_status is null or r.condition_to_status = e.to_status)
      and not exists (
        select 1 from public.automation_jobs j
        where j.rule_id = r.id and j.event_id = e.id
      )
      -- A client rule conditioned on one appointment type still sees every
      -- session event its artist emits, and an event it can never match never
      -- produces a job. Without this predicate those pairs are re-selected on
      -- every tick, and once there are more of them than p_limit they occupy
      -- the whole batch in occurred_at order and starve the real work behind
      -- them. Excluding them here rather than after the limit is what keeps
      -- the batch made of pairs that can actually materialise.
      and (
        r.action_type <> 'send_client_message'::public.automation_action_type
        or exists (
          select 1
          from public.sessions s
          where s.id = e.entity_id
            and s.artist_id = e.artist_id
            and s.appointment_type = r.condition_appointment_type
        )
      )
    order by e.occurred_at, e.id
    limit p_limit
  ),
  inserted as (
    insert into public.automation_jobs (
      rule_id, rule_version, event_id, artist_id,
      action_type, action_title, action_body, action_priority,
      schedule_anchor, anchor_offset_minutes, condition_appointment_type,
      message_purpose, message_channel, message_locale,
      session_id, scheduled_at
    )
    select rule_id, version, event_id, artist_id,
           action_type, action_title, action_body, action_priority,
           schedule_anchor, anchor_offset_minutes, condition_appointment_type,
           message_purpose, message_channel, message_locale,
           session_id, scheduled_at
    from pairs
    where scheduled_at is not null
    on conflict do nothing
    returning 1
  )
  select count(*)::int into v_materialised from inserted;

  -- Withdraw stale rule snapshots first. A later reschedule never revives work
  -- that was explicitly disabled or edited.
  with stale as (
    update public.automation_jobs j
    set status = 'cancelled',
        cancelled_at = now(),
        last_error_category = 'rule_withdrawn'
    from public.automation_rules r
    where j.rule_id = r.id
      and j.status = 'pending'
      and (not r.is_enabled or r.version <> j.rule_version)
    returning 1
  )
  select count(*)::int into v_withdrawn from stale;

  -- A client message that failed only because its sending integration was
  -- unavailable is tried again while it is still current. It runs before the
  -- reconciliation and the cancellation below so a recovered job follows a
  -- moved appointment and is dropped with a cancelled one, and before the
  -- executor loop so it is sent in this same pass.
  perform crm_private.requeue_recoverable_lifecycle_jobs(p_limit);

  -- Reconcile every still-pending lifecycle job from the authoritative session.
  -- This is the reschedule primitive: the domain row moves, the job follows.
  update public.automation_jobs j
  set scheduled_at = case j.schedule_anchor
        when 'session_start'::public.automation_schedule_anchor
          then s.start_at + make_interval(mins => j.anchor_offset_minutes)
        when 'session_end'::public.automation_schedule_anchor
          then coalesce(s.actual_end_at,s.end_at) + make_interval(mins => j.anchor_offset_minutes)
        else j.scheduled_at
      end
  from public.sessions s
  where j.status = 'pending'
    and j.action_type = 'send_client_message'::public.automation_action_type
    and s.id = j.session_id
    and s.artist_id = j.artist_id
    and j.scheduled_at is distinct from case j.schedule_anchor
        when 'session_start'::public.automation_schedule_anchor
          then s.start_at + make_interval(mins => j.anchor_offset_minutes)
        when 'session_end'::public.automation_schedule_anchor
          then coalesce(s.actual_end_at,s.end_at) + make_interval(mins => j.anchor_offset_minutes)
        else j.scheduled_at
      end;

  -- Definitive appointment states cancel pending lifecycle work. Proposed/draft
  -- are deliberately not terminal: a later confirmation may still make a due
  -- reminder eligible, and the next tick will pick it up.
  update public.automation_jobs j
  set status = 'cancelled', cancelled_at = now(),
      last_error_category = 'appointment_ineligible'
  where j.status = 'pending'
    and j.action_type = 'send_client_message'::public.automation_action_type
    and (
      not exists (
        select 1 from public.sessions s
        where s.id = j.session_id
          and s.artist_id = j.artist_id
          and s.appointment_type = j.condition_appointment_type
      )
      or exists (
        select 1 from public.sessions s
        where s.id = j.session_id
          and s.artist_id = j.artist_id
          and (
            (j.schedule_anchor = 'session_start'::public.automation_schedule_anchor
             and s.status in ('cancelled', 'no_show', 'completed'))
            or
            (j.schedule_anchor = 'session_end'::public.automation_schedule_anchor
             and s.status in ('cancelled', 'no_show'))
          )
      )
    );

  -- Legacy artist-team notification execution is unchanged.
  with due as (
    select j.id, j.artist_id, j.action_title, j.action_body, j.action_priority,
           e.entity_kind, e.entity_id
    from public.automation_jobs j
    join public.automation_events e on e.id = j.event_id
    join crm_private.artist_state s on s.artist_id = j.artist_id and s.is_active
    where j.status = 'pending'
      and j.scheduled_at <= now()
      and j.action_type = 'notify_artist_team'
      and crm_private.automations_enabled_for_artist(j.artist_id)
    order by j.scheduled_at, j.id
    limit p_limit
  ),
  targeted as (
    select d.*, r.profile_id
    from due d
    cross join lateral crm_private.automation_notification_recipients(d.artist_id) r
  ),
  sent as (
    insert into public.notifications (
      recipient_profile_id, artist_id, notification_type, title, body,
      entity_type, entity_id, priority, status, dedupe_key,
      scheduled_at, delivered_at
    )
    select t.profile_id, t.artist_id, 'automation.triggered',
           t.action_title, t.action_body,
           case when t.entity_id is not null then t.entity_kind end,
           t.entity_id, t.action_priority,
           'delivered',
           'automation_job:' || t.id::text || ':' || t.profile_id::text,
           now(), now()
    from targeted t
    on conflict (dedupe_key) do nothing
    returning 1
  ),
  finished as (
    update public.automation_jobs j
    set status = 'completed',
        completed_at = now(),
        attempt_count = j.attempt_count + 1,
        last_error_category = case
          when exists (select 1 from targeted t where t.id = j.id) then 'none'
          else 'no_recipient'
        end
    where j.id in (select id from due)
    returning 1
  )
  select (select count(*)::int from finished), (select count(*)::int from sent)
  into v_executed, v_notified;

  -- Client work is executed one locked job at a time. The helper rechecks every
  -- live gate under that lock and creates email + outbox atomically.
  for v_client_job in
    select j.id
    from public.automation_jobs j
    join public.sessions s
      on s.id = j.session_id
     and s.artist_id = j.artist_id
    join crm_private.artist_state a
      on a.artist_id = j.artist_id
     and a.is_active
    where j.status = 'pending'
      and j.action_type = 'send_client_message'::public.automation_action_type
      -- Non-anchor jobs remain pending so split blocks can be re-evaluated.
      and crm_private.lifecycle_block_disposition(j.id) in ('eligible','unmanaged')
      and j.scheduled_at <= now()
      and crm_private.automations_enabled_for_artist(j.artist_id)
      and (
        (j.schedule_anchor = 'session_start'::public.automation_schedule_anchor
         and s.status = 'confirmed')
        or
        (j.schedule_anchor = 'session_end'::public.automation_schedule_anchor
         and s.status = 'completed')
      )
    order by j.scheduled_at, j.id
    limit p_limit
  loop
    v_client_result := crm_private.execute_client_lifecycle_job(v_client_job.id);
    if v_client_result in ('queued', 'failed', 'blocked', 'cancelled') then
      v_executed := v_executed + 1;
    end if;
  end loop;

  return query select v_materialised, v_withdrawn, v_executed, v_notified;
end;
$function$
;

revoke all on function public.service_run_automation_tick(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.service_run_automation_tick(integer) to service_role;
