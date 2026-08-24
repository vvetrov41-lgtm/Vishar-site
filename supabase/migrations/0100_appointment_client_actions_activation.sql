-- 0100_appointment_client_actions_activation.sql
--
-- Activate the already-live 0098 appointment client-action foundation from the
-- existing 24-hour lifecycle reminders. The 72-hour tattoo message deliberately
-- stays action-free: a newly scheduled appointment can make the 72h and 24h jobs
-- due in the same automation tick, and minting twice would invalidate the first
-- email's single-use capabilities before delivery.
--
-- No new Worker, scheduler, secret or provider path is introduced. The branded
-- action runtime is already live at booking.vishartattoo.com.

-- ---------------------------------------------------------------------------
-- 1. Catalogue the three lifecycle-only URL variables
-- ---------------------------------------------------------------------------

insert into public.message_template_variables (variable, description) values
  ('confirm_link', 'Single-use client link that confirms attendance for the authoritative appointment version.'),
  ('reschedule_link', 'Single-use client link that requests a different appointment time without moving the current booking.'),
  ('cancel_link', 'Single-use client link that confirms cancellation of the authoritative appointment version.')
on conflict (variable) do update
set description = excluded.description;

-- ---------------------------------------------------------------------------
-- 2. Activate reviewed 24-hour copy in place
--
-- Only workspace defaults are changed. Existing artist-authored overrides stay
-- byte-for-byte intact. A custom 24h template that uses none of the new action
-- variables remains a valid action-free reminder after this migration.
-- ---------------------------------------------------------------------------

update public.message_templates t
set body = E'Hi {{client_first_name}},\n\nYour tattoo appointment with {{artist_display_name}} at {{studio_name}} is tomorrow, {{appointment_date}}, at {{appointment_time}}.\n\nPlease note: if a deposit applies to this booking, it is non-refundable if you cancel within 72 hours of the scheduled start time.\n\nManage this appointment securely:\n\nConfirm attendance:\n{{confirm_link}}\n\nRequest a different time:\n{{reschedule_link}}\nYour current appointment stays booked until we contact you and agree a new time.\n\nCancel this appointment:\n{{cancel_link}}\n\nOpening a link only shows a confirmation page. No appointment change is made until you confirm the action there.\n\nIf you have a question before then, just reply to this email.\n\nSee you tomorrow,\n{{studio_name}}',
    version = t.version + 1,
    updated_at = now()
where t.artist_id is null
  and t.purpose = 'session_reminder_24h'
  and t.channel = 'email'
  and t.locale = 'en'
  and t.status = 'active';

update public.message_templates t
set body = E'Hi {{client_first_name}},\n\nYour consultation with {{artist_display_name}} is tomorrow, {{appointment_date}}, at {{appointment_time}}.\n\nPlease bring any reference images or ideas you would like to talk through.\n\nManage this appointment securely:\n\nConfirm attendance:\n{{confirm_link}}\n\nRequest a different time:\n{{reschedule_link}}\nYour current appointment stays booked until we contact you and agree a new time.\n\nCancel this appointment:\n{{cancel_link}}\n\nOpening a link only shows a confirmation page. No appointment change is made until you confirm the action there.\n\nIf you have a question before then, just reply to this email.\n\nSee you tomorrow,\n{{studio_name}}',
    version = t.version + 1,
    updated_at = now()
where t.artist_id is null
  and t.purpose = 'consultation_reminder'
  and t.channel = 'email'
  and t.locale = 'en'
  and t.status = 'active';

-- ---------------------------------------------------------------------------
-- 3. Internal renderer for server-minted action capabilities
-- ---------------------------------------------------------------------------

create or replace function crm_private.render_lifecycle_action_template_text(
  p_text text,
  p_session_id uuid,
  p_confirm_token text,
  p_reschedule_token text,
  p_cancel_token text
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_out text := p_text;
  v_base constant text := 'https://booking.vishartattoo.com/appointments/respond/';
begin
  if v_out is null then
    return null;
  end if;

  -- Raw capabilities are accepted only in the exact shape produced by 0098.
  if p_confirm_token is null or p_confirm_token !~ '^[0-9a-f]{64}$'
     or p_reschedule_token is null or p_reschedule_token !~ '^[0-9a-f]{64}$'
     or p_cancel_token is null or p_cancel_token !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  v_out := replace(v_out, '{{confirm_link}}', v_base || p_confirm_token);
  v_out := replace(v_out, '{{reschedule_link}}', v_base || p_reschedule_token);
  v_out := replace(v_out, '{{cancel_link}}', v_base || p_cancel_token);

  -- The existing lifecycle renderer owns all ordinary variables and the final
  -- unresolved-variable fail-closed check.
  return crm_private.render_lifecycle_template_text(v_out, p_session_id);
end;
$$;

revoke all on function crm_private.render_lifecycle_action_template_text(
  text, uuid, text, text, text
) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Mint capabilities only inside the authoritative lifecycle send transaction
-- ---------------------------------------------------------------------------

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

revoke all on function crm_private.execute_client_lifecycle_job(uuid)
  from public, anon, authenticated;
grant execute on function crm_private.execute_client_lifecycle_job(uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. Apply-time invariants
-- ---------------------------------------------------------------------------

do $$
declare
  v_active_workspaces integer;
  v_action_templates integer;
  v_72h_action_templates integer;
  v_72h_policy_templates integer;
begin
  select count(distinct a.workspace_id)
    into v_active_workspaces
  from public.artists a
  join public.workspaces w on w.id = a.workspace_id
  where a.is_active and w.is_active;

  select count(*)
    into v_action_templates
  from public.message_templates t
  where t.artist_id is null
    and t.channel = 'email'
    and t.locale = 'en'
    and t.status = 'active'
    and t.purpose in ('session_reminder_24h', 'consultation_reminder')
    and position('{{confirm_link}}' in t.body) > 0
    and position('{{reschedule_link}}' in t.body) > 0
    and position('{{cancel_link}}' in t.body) > 0;

  if v_action_templates <> v_active_workspaces * 2 then
    raise exception '24h appointment action templates are not active for every workspace'
      using errcode = '23514';
  end if;

  select count(*)
    into v_72h_action_templates
  from public.message_templates t
  where t.channel = 'email'
    and t.locale = 'en'
    and t.status = 'active'
    and t.purpose = 'session_reminder_72h'
    and (
      position('{{confirm_link}}' in t.body) > 0
      or position('{{reschedule_link}}' in t.body) > 0
      or position('{{cancel_link}}' in t.body) > 0
    );

  if v_72h_action_templates <> 0 then
    raise exception '72h reminder must remain action-free to avoid same-tick capability invalidation'
      using errcode = '23514';
  end if;

  select count(*)
    into v_72h_policy_templates
  from public.message_templates t
  where t.artist_id is null
    and t.channel = 'email'
    and t.locale = 'en'
    and t.status = 'active'
    and t.purpose = 'session_reminder_72h'
    and t.body like '%if a deposit applies to this booking, it is non-refundable if you cancel within 72 hours of the scheduled start time.%';

  if v_72h_policy_templates <> v_active_workspaces then
    raise exception '0099 72h deposit-policy copy was not preserved'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.automation_rules r
    where r.is_enabled
      and r.action_type = 'send_client_message'::public.automation_action_type
      and r.condition_appointment_type <> 'tattoo_session'::public.appointment_type
      and r.anchor_offset_minutes = -4320
  ) then
    raise exception '72h consultation automation is not part of lifecycle v1'
      using errcode = '23514';
  end if;
end;
$$;
