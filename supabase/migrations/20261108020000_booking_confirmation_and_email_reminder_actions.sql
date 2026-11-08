-- The scheduled appointment is already confirmed. Booking cards do not
-- request a second acknowledgement. Prior delivery/outbox rows are untouched.
CREATE OR REPLACE FUNCTION crm_private.render_booking_card_email(p_booking_card_id uuid, p_confirm_token text, p_reschedule_token text)
 RETURNS TABLE(subject text, body text, html_body text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_card crm_private.booking_cards%rowtype;
  v_settings crm_private.booking_card_artist_settings%rowtype;
  v_client_name text;
  v_artist_name text;
  v_first_name text;
  v_date text;
  v_time text;
  v_confirm_url text;
  v_reschedule_url text;
  v_deposit text;
  v_remaining text;
  v_title text;
  v_finance_text text := '';
  v_finance_html text := '';
  v_group record;
  v_grouped boolean := false;
  v_video boolean := false;
begin
  if p_booking_card_id is null
     or coalesce(p_confirm_token, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_reschedule_token, '') !~ '^[0-9a-f]{64}$'
     or p_confirm_token = p_reschedule_token then
    return;
  end if;

  select b.* into v_card
  from crm_private.booking_cards b
  where b.id = p_booking_card_id
    and b.superseded_at is null;

  if not found then
    return;
  end if;

  select s.* into v_settings
  from crm_private.booking_card_artist_settings s
  where s.artist_id = v_card.artist_id
    and s.email_enabled;

  if not found then
    return;
  end if;

  select c.full_name, a.display_name
    into v_client_name, v_artist_name
  from public.clients c
  join public.artists a on a.id = v_card.artist_id
  where c.id = v_card.client_id
    and c.archived_at is null;

  if not found
     or nullif(btrim(v_client_name), '') is null
     or nullif(btrim(v_artist_name), '') is null then
    return;
  end if;

  v_video := v_card.appointment_type = 'video_consultation'::public.appointment_type;
  if v_card.card_kind = 'consultation_booked' and v_card.appointment_type = 'in_person_consultation'::public.appointment_type then
    select l.studio_name,l.studio_address,l.studio_map_url
      into v_settings.studio_name,v_settings.studio_address,v_settings.studio_map_url
    from crm_private.consultation_email_location() l;
  end if;
  v_first_name := split_part(btrim(v_client_name), ' ', 1);
  v_date := to_char(v_card.start_at at time zone v_card.timezone, 'FMDay, FMDD FMMonth YYYY');
  v_time := to_char(v_card.start_at at time zone v_card.timezone, 'HH24:MI');
  select * into v_group from crm_private.booking_group_card_summary(v_card.id);
  v_grouped := found and v_group.session_count > 1;
  if v_grouped then v_date := v_group.dates_text; v_time := ''; end if;
  if v_settings.client_action_base_url is null then
    return;
  end if;
  v_confirm_url := v_settings.client_action_base_url || p_confirm_token;
  v_reschedule_url := v_settings.client_action_base_url || p_reschedule_token;

  if v_card.card_kind = 'tattoo_deposit_paid' then
    v_title := case when v_grouped then 'Your tattoo sessions are booked' else 'Your tattoo session is booked' end;
    subject := v_title;
    v_deposit := crm_private.booking_card_money(case when v_grouped then v_group.total_deposit else v_card.deposit_paid end, v_card.currency);
    v_remaining := crm_private.booking_card_money(case when v_grouped then v_group.total_remaining else v_card.remaining_balance end, v_card.currency);
    v_finance_text := E'\nDeposit paid: ' || v_deposit
      || E'\nRemaining balance: ' || v_remaining;
    v_finance_html :=
      '<div style="margin:20px 0;padding:16px;border-radius:12px;background:#f6f6f6;">'
      || '<div style="margin-bottom:8px;"><strong>Deposit paid:</strong> '
      || crm_private.booking_card_html_escape(v_deposit) || '</div>'
      || '<div><strong>Remaining balance:</strong> '
      || crm_private.booking_card_html_escape(v_remaining) || '</div>'
      || '</div>';
  elsif v_card.card_kind = 'consultation_booked' then
    v_title := case when v_video then 'Your video consultation is booked' else 'Your consultation is booked' end;
    subject := v_title;
  else
    return;
  end if;

  -- Scheduling is the booking confirmation; no second client confirmation.
  body :=
    'Hi ' || v_first_name || ',' || chr(10) || chr(10)
    || v_title || '.' || chr(10) || chr(10)
    || 'When: ' || v_date || case when v_grouped then '' else ' at ' || v_time end
    || v_finance_text || chr(10) || chr(10)
    || case when v_video then
         'This is an online call. We will agree how to connect before the appointment.'
         || chr(10) || chr(10)
       else
         v_settings.studio_name || chr(10) || v_settings.studio_address
           || chr(10) || v_settings.studio_map_url || chr(10) || chr(10)
       end
    || 'If you need another time, just reply to me here.';

  html_body :=
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f2f2f2;'
    || 'font-family:Arial,Helvetica,sans-serif;color:#111;">'
    || '<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:18px;'
    || 'padding:28px;box-sizing:border-box;">'
    || '<p style="margin:0 0 20px;">Hi '
    || crm_private.booking_card_html_escape(v_first_name) || ',</p>'
    || '<h1 style="font-size:24px;line-height:1.2;margin:0 0 22px;">'
    || crm_private.booking_card_html_escape(v_title) || ' ✓</h1>'
    || '<div style="line-height:1.6;"><strong>When:</strong> '
    || replace(crm_private.booking_card_html_escape(v_date ||
       case when v_grouped then '' else ' at ' || v_time end), chr(10),'<br>')
    || '</div>'
    || v_finance_html
    || case when v_video then
         '<p>Video consultation. We will agree how to connect before the appointment.</p>'
       else '<div style="margin:20px 0;line-height:1.5;">'
         || '<strong>' || crm_private.booking_card_html_escape(v_settings.studio_name) || '</strong><br>'
         || crm_private.booking_card_html_escape(v_settings.studio_address) || '<br>'
         || '<a href="' || crm_private.booking_card_html_escape(v_settings.studio_map_url)
         || '" style="color:#111;">View location</a></div>' end
    || '<p style="margin:24px 0 0;">If you need another time, just reply to me here.</p>'
    || '</div></body></html>';

  return next;
end;
$function$;
CREATE OR REPLACE FUNCTION crm_private.execute_client_lifecycle_job(p_job_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
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
     and coalesce(v_session.actual_end_at,v_session.end_at) + make_interval(mins => v_job.anchor_offset_minutes) > now() then
    return 'pending';
  end if;

  -- Recheck immediately before materialising a message. Full serialization
  -- against schedule mutation and in-flight delivery is still required.
  if crm_private.lifecycle_block_disposition(p_job_id) not in ('eligible','unmanaged') then
    return 'pending';
  end if;

  -- Resolve at the scheduled execution time, not only on enrolment.
  -- A previously recorded one-time fallback must not retry the same WhatsApp
  -- job or create a second provider message.
  if v_job.message_purpose in
       ('session_reminder_72h','session_reminder_24h',
        'post_session_aftercare','post_session_checkin',
        'consultation_reminder')
     and crm_private.lifecycle_selected_channel(
       v_session.client_id,v_job.artist_id)='whatsapp' then
    if crm_private.lifecycle_email_fallback_allowed(v_job.id) then
      null; -- WhatsApp already failed definitively; continue with Email.
    elsif exists (
      select 1 from crm_private.lifecycle_whatsapp_payloads p
      where p.automation_job_id=v_job.id
    ) then
      -- An outbox result is ambiguous or still in flight. Do not duplicate.
      return 'pending';
    elsif crm_private.lifecycle_whatsapp_send_ready(
      v_session.client_id,v_job.artist_id,v_job.message_purpose) then
      return crm_private.queue_lifecycle_whatsapp_job(p_job_id);
    else
      insert into crm_private.lifecycle_email_fallbacks (
        job_id,artist_id,client_id,reason
      ) values (
        v_job.id,v_job.artist_id,v_session.client_id,'whatsapp_unavailable'
      ) on conflict(job_id) do nothing;
    end if;
  end if;

  -- Instagram has no unrestricted unattended provider route. Keep the
  -- existing operational Email reminder rather than silently dropping it.

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
      'session_reminder_72h',
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
       position('{{reschedule_link}}' in coalesce(v_template.body, '')) = 0
       or (
         v_job.message_purpose in ('session_reminder_72h','consultation_reminder')
         and position('{{confirm_link}}' in coalesce(v_template.body, '')) = 0
       )
       or (
         v_job.message_purpose = 'session_reminder_24h'
         and position('{{confirm_link}}' in coalesce(v_template.body, '')) > 0
       )
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

        if v_job.message_purpose='session_reminder_72h' then
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
$function$;

-- Version the active email templates, retaining historical revisions.
with previous as (
 update public.message_templates t set status='retired',updated_at=now()
 where t.status='active' and t.channel='email' and t.locale='en'
   and t.purpose in ('session_reminder_72h','session_reminder_24h','consultation_reminder')
 returning t.*
), revised as (
 select p.*, (select coalesce(max(v.version),0)+1 from public.message_templates v
   where v.workspace_id=p.workspace_id
     and v.artist_id is not distinct from p.artist_id
     and v.purpose=p.purpose and v.channel=p.channel and v.locale=p.locale) as next_version
 from previous p
)
insert into public.message_templates (
 id,workspace_id,artist_id,purpose,channel,locale,version,status,subject,body,created_by
)
select
 gen_random_uuid(),p.workspace_id,p.artist_id,p.purpose,p.channel,p.locale,
 p.next_version,'active',
 case p.purpose
 when 'session_reminder_72h' then 'Your tattoo session in three days | {{appointment_date}}'
 when 'session_reminder_24h' then 'Your tattoo session tomorrow | {{appointment_date}}'
 else 'Consultation reminder | {{appointment_date}}'
 end,
 case p.purpose
 when 'session_reminder_72h' then
 'Hi {{client_first_name}},

Just a reminder that your tattoo appointment with me is in three days, on {{appointment_date}} at {{appointment_time}}.

Please note: if a deposit applies, it is non-refundable if you cancel within 72 hours of your appointment.

How to prepare: https://vishartattoo.com/faq/

Confirm you can still make it:
https://booking.vishartattoo.com/appointments/respond/{{confirm_link}}

Need another time:
https://booking.vishartattoo.com/appointments/respond/{{reschedule_link}}
Your booking stays in place until we agree another time.

See you soon,
{{artist_display_name}}'
 when 'session_reminder_24h' then
 'Hi {{client_first_name}},

Just a reminder that your tattoo appointment with me is tomorrow, {{appointment_date}} at {{appointment_time}}.

How to prepare: https://vishartattoo.com/faq/

Need another time:
https://booking.vishartattoo.com/appointments/respond/{{reschedule_link}}
Your existing appointment stays booked until I agree a different time with you.

See you tomorrow,
{{artist_display_name}}'
 else
 'Hi {{client_first_name}},

Just a reminder that our consultation is tomorrow, {{appointment_date}} at {{appointment_time}}.

Please bring any reference images or ideas you want to discuss.

Confirm consultation:
https://booking.vishartattoo.com/appointments/respond/{{confirm_link}}

Need another time:
https://booking.vishartattoo.com/appointments/respond/{{reschedule_link}}
The current appointment stays booked until we agree another time.

See you tomorrow,
{{artist_display_name}}'
 end,
 p.created_by
from revised p;
