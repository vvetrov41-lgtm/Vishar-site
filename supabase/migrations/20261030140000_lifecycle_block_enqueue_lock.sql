-- Serialize each lifecycle enqueue against artist schedule changes and all current block member rows.
-- The provider retains its separate last pre-send snapshot check.
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
  v_expected_members integer;
  v_locked_members integer;
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

  if v_job.message_purpose in ('session_reminder_72h','session_reminder_24h',
      'post_session_aftercare','post_session_checkin')
     and v_session.appointment_type in ('tattoo_session','touch_up') then
    -- Booking/rescheduling uses this same artist advisory lock. Try rather
    -- than wait while holding an appointment row: reschedule locks its row
    -- before acquiring the artist lock, so waiting here could deadlock.
    if not pg_try_advisory_xact_lock(
      hashtextextended('crm:artist-schedule:' || v_job.artist_id::text,0)) then
      return 'pending';
    end if;

    select count(*) into v_expected_members
    from crm_private.session_lifecycle_block(v_session.id);
    -- Cancellation/completion can lock a different day without the schedule
    -- advisory lock. Skip that row and retry on a later tick; after acquiring
    -- every member row, all block decisions and the enqueue share one commit.
    with locked as materialized (
      select s.id from public.sessions s
      join crm_private.session_lifecycle_block(v_session.id) b on b.session_id=s.id
      order by s.id for update of s skip locked
    ) select count(*) into v_locked_members from locked;
    if v_expected_members=0 or v_locked_members<>v_expected_members then
      return 'pending';
    end if;
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

        if v_job.message_purpose='session_reminder_24h' then
          perform crm_private.register_lifecycle_confirmation(v_confirm_token,v_session.id);
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
