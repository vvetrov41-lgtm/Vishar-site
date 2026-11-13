CREATE OR REPLACE FUNCTION crm_private.lifecycle_block_disposition(p_job_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_job public.automation_jobs%rowtype;
  v_session public.sessions%rowtype;
  v_anchor uuid;
  v_other_consumed boolean;
  v_aftercare_day date;
begin
  select * into v_job from public.automation_jobs where id=p_job_id;
  if not found then return 'ineligible'; end if;
  if v_job.message_purpose is null or v_job.message_purpose not in
    ('session_reminder_72h','session_reminder_24h','post_session_aftercare','post_session_checkin')
  then return 'unmanaged'; end if;
  if v_job.status <> 'pending' or v_job.action_type <> 'send_client_message'
  then return 'ineligible'; end if;
  select * into v_session from public.sessions
  where id=v_job.session_id and artist_id=v_job.artist_id;
  if not found or v_session.appointment_type not in ('tattoo_session','touch_up')
  then return 'ineligible'; end if;
  if not exists (select 1 from crm_private.session_lifecycle_block(v_session.id))
  then return 'ineligible'; end if;
  select b.local_day into v_aftercare_day
  from crm_private.session_lifecycle_block(v_session.id) b
  where b.session_id=v_session.id;
  if v_aftercare_day is null then return 'ineligible'; end if;

  select exists (
    select 1 from crm_private.session_lifecycle_block(v_session.id) b
    join public.automation_jobs j
      on j.session_id=b.session_id and j.artist_id=v_job.artist_id
    where j.id<>v_job.id
      and j.message_purpose=v_job.message_purpose
      and j.status='completed'
      -- Reminders, aftercare and check-ins are each once per consecutive block.
      and not (
        exists (
          select 1 from public.email_messages m
          join public.integration_outbox o on o.email_message_id=m.id
          where m.automation_job_id=j.id and m.status='cancelled'
            and o.kind='approved_email' and o.status='dead'
            and o.last_error_code='gmail_lifecycle_email_obsolete'
        )
        or exists (
          select 1 from crm_private.lifecycle_whatsapp_payloads p
          join public.integration_outbox o on o.communication_message_id=p.communication_message_id
          where p.automation_job_id=j.id and p.artist_id=j.artist_id
            and o.kind='whatsapp_message' and o.status='dead'
            and o.last_error_code='whatsapp_lifecycle_obsolete'
            and o.provider_send_started_at is null
        )
      )
  ) into v_other_consumed;
  if v_other_consumed then return 'already_queued'; end if;

  if v_job.message_purpose in ('session_reminder_72h','session_reminder_24h') then
    select b.session_id into v_anchor
    from crm_private.session_lifecycle_block(v_session.id) b
    order by b.start_at,b.session_id limit 1;
    if v_session.status<>'confirmed' then return 'defer'; end if;
  elsif v_job.message_purpose='post_session_aftercare' then
    select b.session_id into v_anchor
    from crm_private.session_lifecycle_block(v_session.id) b
    order by b.start_at,b.session_id limit 1;
    if v_session.status<>'completed' then return 'defer'; end if;
  else
    if exists (
      select 1 from crm_private.session_lifecycle_block(v_session.id) b
      join public.sessions s on s.id=b.session_id
      where s.status<>'completed'
    ) then return 'defer'; end if;
    select b.session_id into v_anchor
    from crm_private.session_lifecycle_block(v_session.id) b
    order by b.end_at desc,b.session_id desc limit 1;
    if v_session.status<>'completed' then return 'defer'; end if;
  end if;
  if v_anchor is distinct from v_session.id then return 'defer'; end if;
  -- When enabling this behaviour, previously blocked second-day jobs can
  -- still be pending. Do not suddenly message clients many hours/days late.
  if v_job.message_purpose='post_session_aftercare'
     and crm_private.lifecycle_aftercare_followup(v_session.id)
     and v_job.scheduled_at<now()-interval '6 hours'
  then return 'defer'; end if;
  return 'eligible';
end;
$function$;

CREATE OR REPLACE FUNCTION crm_private.notify_missed_aftercare_jobs(p_limit integer DEFAULT 100)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
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
      -- Only first session of consecutive block needs an aftercare guide.
      and j.session_id = (
        select b.session_id from crm_private.session_lifecycle_block(s.id) b
        order by b.start_at,b.session_id limit 1
      )
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

  -- Suppress later-session aftercare jobs in consecutive session blocks.
  update public.automation_jobs j
  set status='cancelled', cancelled_at=now(),
      last_error_category='appointment_ineligible'
  from public.sessions s
  where j.status='pending'
    and j.action_type='send_client_message'::public.automation_action_type
    and j.message_purpose='post_session_aftercare'
    and j.session_id=s.id and j.artist_id=s.artist_id
    and s.status='completed' and j.scheduled_at<=now()
    and exists (
      select 1 from crm_private.session_lifecycle_block(s.id) earlier
      where (earlier.start_at,earlier.session_id) < (s.start_at,s.id)
    )
    and not exists (select 1 from public.email_messages em where em.automation_job_id=j.id)
    and not exists (select 1 from crm_private.lifecycle_whatsapp_payloads wp where wp.automation_job_id=j.id)
    and not exists (select 1 from crm_private.lifecycle_instagram_payloads ip where ip.automation_job_id=j.id);

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
$function$;

update public.automation_jobs j
set status='cancelled', cancelled_at=now(),
    last_error_category='appointment_ineligible'
from public.sessions s
where j.status='pending'
  and j.action_type='send_client_message'::public.automation_action_type
  and j.message_purpose='post_session_aftercare'
  and j.session_id=s.id and j.artist_id=s.artist_id
  and s.status='completed' and j.scheduled_at<=now()
  and exists (
    select 1 from crm_private.session_lifecycle_block(s.id) earlier
    where (earlier.start_at,earlier.session_id) < (s.start_at,s.id)
  )
  and not exists (select 1 from public.email_messages em where em.automation_job_id=j.id)
  and not exists (select 1 from crm_private.lifecycle_whatsapp_payloads wp where wp.automation_job_id=j.id)
  and not exists (select 1 from crm_private.lifecycle_instagram_payloads ip where ip.automation_job_id=j.id);
