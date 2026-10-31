-- WORK IN PROGRESS: do not release before scheduling serialization, grouped copy and delivery-state rechecks.

create or replace function crm_private.execute_client_lifecycle_job(p_job_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.automation_jobs%rowtype;
  v_session public.sessions%rowtype;
  v_template record;
  v_block_reason text;
  v_to_email text;
  v_subject text;
  v_body text;
  v_message_id uuid;
  v_outbox_id uuid;
  v_actions_required boolean := false;
  v_confirm_token text;
  v_reschedule_token text;
  v_cancel_token text;
  v_block_count integer;
  v_block_dates text;
  v_artist_timezone text;
  v_studio_address text;
  v_aftercare_url text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'client lifecycle execution is backend-only' using errcode = '42501';
  end if;

  select j.* into v_job
  from public.automation_jobs j
  where j.id = p_job_id
  for update;

  if not found
     or v_job.status <> 'pending'::public.automation_job_status
     or v_job.action_type <> 'send_client_message'::public.automation_action_type then
    return 'skipped';
  end if;

  if not crm_private.automations_enabled_for_artist(v_job.artist_id) then
    return 'paused';
  end if;

  -- 0098's mint/apply concurrency contract locks the authoritative session
  -- before the capability row. Keep the lifecycle executor on the same order.
  select s.* into v_session
  from public.sessions s
  where s.id = v_job.session_id
    and s.artist_id = v_job.artist_id
  for update;

  if not found
     or v_session.appointment_type <> v_job.condition_appointment_type then
    update public.automation_jobs
    set status = 'cancelled', cancelled_at = now(),
        last_error_category = 'appointment_ineligible'
    where id = p_job_id;
    return 'cancelled';
  end if;

  if v_job.schedule_anchor = 'session_start'::public.automation_schedule_anchor then
    if v_session.status in ('cancelled', 'no_show', 'completed') then
      update public.automation_jobs
      set status = 'cancelled', cancelled_at = now(),
          last_error_category = 'appointment_ineligible'
      where id = p_job_id;
      return 'cancelled';
    end if;
    if v_session.status <> 'confirmed' then
      return 'pending';
    end if;
  else
    if v_session.status in ('cancelled', 'no_show') then
      update public.automation_jobs
      set status = 'cancelled', cancelled_at = now(),
          last_error_category = 'appointment_ineligible'
      where id = p_job_id;
      return 'cancelled';
    end if;
    if v_session.status <> 'completed' then
      return 'pending';
    end if;
  end if;

  if v_job.scheduled_at > now() then
    return 'pending';
  end if;

  -- An independently invoked executor must not trust a stale job timestamp
  -- after an appointment is moved. The scheduler normally reconciles this.
  if v_job.schedule_anchor = 'session_start'::public.automation_schedule_anchor
     and v_session.start_at + make_interval(mins => v_job.anchor_offset_minutes) > now() then
    return 'pending';
  end if;
  if v_job.schedule_anchor = 'session_end'::public.automation_schedule_anchor
     and v_session.end_at + make_interval(mins => v_job.anchor_offset_minutes) > now() then
    return 'pending';
  end if;

  -- Recheck immediately before materialising a message. Full serialization
  -- against schedule mutation and in-flight delivery is still required.
  if crm_private.lifecycle_block_disposition(p_job_id) not in ('eligible','unmanaged') then
    return 'pending';
  end if;

  select lower(btrim(c.email)) into v_to_email
  from public.clients c
  where c.id = v_session.client_id
    and c.archived_at is null
    and c.email is not null
    and btrim(c.email) <> '';

  if v_to_email is null then
    update public.automation_jobs
    set status = 'failed', attempt_count = attempt_count + 1,
        last_error_category = 'destination_unavailable'
    where id = p_job_id;
    return 'failed';
  end if;

  select t.id, t.purpose, t.version, t.subject, t.body, p.classification
    into v_template
  from public.message_templates t
  join public.artists a on a.id = v_job.artist_id
  join public.message_template_purposes p on p.purpose = t.purpose
  where t.workspace_id = a.workspace_id
    and (t.artist_id = v_job.artist_id or t.artist_id is null)
    and t.purpose = v_job.message_purpose
    and t.channel = v_job.message_channel
    and t.locale = v_job.message_locale
    and t.status = 'active'
  order by (t.artist_id is not null) desc, t.version desc, t.id
  limit 1;

  if v_template.id is null or v_template.classification <> 'service'::public.message_classification then
    update public.automation_jobs
    set status = 'failed', attempt_count = attempt_count + 1,
        last_error_category = 'template_unavailable'
    where id = p_job_id;
    return 'failed';
  end if;

  v_block_reason := crm_private.client_send_block_reason(
    v_session.client_id,
    v_job.message_channel,
    v_template.classification
  );

  if v_block_reason is not null then
    update public.automation_jobs
    set status = 'cancelled', cancelled_at = now(),
        last_error_category = 'client_blocked'
    where id = p_job_id;
    return 'blocked';
  end if;

  if not exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = v_job.artist_id
      and i.integration_type = 'email'::public.artist_integration_type
      and i.provider = 'google'
      and i.is_enabled
      and i.external_account_label is not null
      and btrim(i.external_account_label) <> ''
  ) then
    update public.automation_jobs
    set status = 'failed', attempt_count = attempt_count + 1,
        last_error_category = 'integration_unavailable'
    where id = p_job_id;
    return 'failed';
  end if;

  -- A lifecycle retry that already materialised its email must reuse the exact
  -- stored body. Minting again here would invalidate links already present in
  -- that idempotent message.
  select m.id into v_message_id
  from public.email_messages m
  where m.automation_job_id = v_job.id;

  -- Workspace defaults opt into action links by carrying all three catalogued
  -- variables. Artist-authored overrides that carry none remain valid ordinary
  -- reminders. A partial opt-in fails closed rather than creating an email with
  -- a missing or ambiguous action.
  if position('{{confirm_link}}' in coalesce(v_template.subject, '')) > 0
     or position('{{reschedule_link}}' in coalesce(v_template.subject, '')) > 0
     or position('{{cancel_link}}' in coalesce(v_template.subject, '')) > 0 then
    update public.automation_jobs
    set status = 'failed', attempt_count = attempt_count + 1,
        last_error_category = 'template_unavailable'
    where id = p_job_id;
    return 'failed';
  end if;

  v_actions_required := v_template.purpose in (
      'session_reminder_24h',
      'consultation_reminder'
    )
    and (
      position('{{confirm_link}}' in coalesce(v_template.body, '')) > 0
      or position('{{reschedule_link}}' in coalesce(v_template.body, '')) > 0
      or position('{{cancel_link}}' in coalesce(v_template.body, '')) > 0
    );

  if v_actions_required
     and (
       position('{{confirm_link}}' in coalesce(v_template.body, '')) = 0
       or position('{{reschedule_link}}' in coalesce(v_template.body, '')) = 0
       or position('{{cancel_link}}' in coalesce(v_template.body, '')) = 0
     ) then
    update public.automation_jobs
    set status = 'failed', attempt_count = attempt_count + 1,
        last_error_category = 'template_unavailable'
    where id = p_job_id;
    return 'failed';
  end if;

  if v_message_id is null then
    v_subject := crm_private.render_lifecycle_template_text(v_template.subject, v_session.id);

    if v_actions_required then
      -- Validate all ordinary variables before minting a real capability set.
      v_body := crm_private.render_lifecycle_action_template_text(
        v_template.body,
        v_session.id,
        repeat('a', 64),
        repeat('b', 64),
        repeat('c', 64)
      );
    else
      v_body := crm_private.render_lifecycle_template_text(v_template.body, v_session.id);
    end if;

    if v_subject is null or btrim(v_subject) = ''
       or v_body is null or btrim(v_body) = '' then
      update public.automation_jobs
      set status = 'failed', attempt_count = attempt_count + 1,
          last_error_category = 'template_unavailable'
      where id = p_job_id;
      return 'failed';
    end if;
  end if;

  begin
    if v_message_id is null then
      if v_actions_required then
        select
          max(x.raw_token) filter (where x.action = 'confirm_attendance'::public.appointment_client_action),
          max(x.raw_token) filter (where x.action = 'request_reschedule'::public.appointment_client_action),
          max(x.raw_token) filter (where x.action = 'cancel'::public.appointment_client_action)
        into v_confirm_token, v_reschedule_token, v_cancel_token
        from crm_private.issue_appointment_client_actions(v_session.id) x;

        if v_confirm_token is null or v_confirm_token !~ '^[0-9a-f]{64}$'
           or v_reschedule_token is null or v_reschedule_token !~ '^[0-9a-f]{64}$'
           or v_cancel_token is null or v_cancel_token !~ '^[0-9a-f]{64}$' then
          raise exception 'appointment action capability issuance failed'
            using errcode = '23514';
        end if;

        v_body := crm_private.render_lifecycle_action_template_text(
          v_template.body,
          v_session.id,
          v_confirm_token,
          v_reschedule_token,
          v_cancel_token
        );

        if v_body is null or btrim(v_body) = '' then
          raise exception 'appointment action rendering failed'
            using errcode = '23514';
        end if;
      end if;

      if v_job.message_purpose in ('session_reminder_72h','session_reminder_24h') then
        select a.timezone into v_artist_timezone from public.artists a where a.id=v_job.artist_id;
        select count(*)::integer, string_agg(
          to_char(b.start_at at time zone v_artist_timezone,'FMDay, FMDD FMMonth YYYY')
            || ' at ' || to_char(b.start_at at time zone v_artist_timezone,'HH24:MI'),
          E'\n' order by b.start_at,b.session_id)
        into v_block_count,v_block_dates from crm_private.session_lifecycle_block(v_session.id) b;
        if v_block_count>1 then
          v_body := v_body || E'\n\nYour appointment dates:\n' || v_block_dates
            || E'\n\nIf a deposit applies, the 72-hour cancellation period is calculated separately for each appointment date.';
        end if;
        if v_job.message_purpose='session_reminder_24h' then
          select nullif(btrim(c.studio_address),'') into v_studio_address
          from crm_private.booking_card_artist_settings c where c.artist_id=v_job.artist_id
            and (c.appointment_start_from is null or v_session.start_at>=c.appointment_start_from);
          if v_studio_address is not null then
            v_body := v_body || E'\n\nStudio address: ' || v_studio_address;
          end if;
        end if;
      end if;

      if v_job.message_purpose='post_session_checkin' then
        select substring(t.body from 'https://[a-z0-9.-]+/aftercare/') into v_aftercare_url
        from public.message_templates t
        join public.artists a on a.id=v_job.artist_id
        where t.workspace_id=a.workspace_id and (t.artist_id=a.id or t.artist_id is null)
          and t.purpose='post_session_aftercare' and t.channel='email'
          and t.locale=v_job.message_locale and t.status='active'
        order by (t.artist_id is not null) desc,t.version desc,t.id limit 1;
        if v_aftercare_url is null then
          raise exception 'approved artist aftercare link is unavailable' using errcode='23514';
        end if;
        v_body := v_body || E'\n\nYour aftercare guide: ' || v_aftercare_url;
      end if;

      insert into public.email_messages (
        status, artist_id, client_id, enquiry_id, project_id,
        to_email, subject, body,
        template_key, template_version,
        created_by, created_by_kind, approved_by, approved_at,
        automation_job_id
      ) values (
        'approved', v_job.artist_id, v_session.client_id,
        v_session.enquiry_id, v_session.project_id,
        v_to_email, v_subject, v_body,
        v_template.purpose, v_template.version,
        null, 'system', null, now(),
        v_job.id
      )
      on conflict do nothing
      returning id into v_message_id;

      if v_message_id is null then
        select m.id into v_message_id
        from public.email_messages m
        where m.automation_job_id = v_job.id;
      end if;
    end if;

    if v_message_id is null then
      raise exception 'lifecycle email idempotency could not resolve a message';
    end if;

    v_outbox_id := crm_private.enqueue_outbox(
      'approved_email',
      'email:automation:' || v_job.id::text,
      jsonb_build_object('email_message_id', v_message_id),
      v_session.client_id,
      v_session.enquiry_id,
      v_session.project_id,
      v_session.id,
      v_message_id
    );

    update public.automation_jobs
    set status = 'completed', completed_at = now(),
        attempt_count = attempt_count + 1,
        last_error_category = 'none'
    where id = p_job_id;

    perform crm_private.log_artist_activity(
      v_job.artist_id,
      'email.automation_queued',
      'system',
      null,
      v_session.client_id,
      v_session.enquiry_id,
      v_session.project_id,
      v_session.id,
      null,
      jsonb_build_object(
        'automation_job_id', v_job.id,
        'email_message_id', v_message_id,
        'purpose', v_template.purpose
      )
    );
  exception when others then
    -- The exception block is a PostgreSQL subtransaction. Any capability set
    -- minted above is rolled back before the failed job state is recorded.
    update public.automation_jobs
    set status = 'failed', attempt_count = attempt_count + 1,
        last_error_category = 'unknown'
    where id = p_job_id;
    return 'failed';
  end;

  return 'queued';
end;
$$;

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
