-- WIP: do not release until the shared schedule lock and provider delivery
-- race are covered by concurrency tests. Existing token security is preserved.
create table crm_private.lifecycle_confirmation_snapshots (
 token_id uuid primary key references crm_private.appointment_client_action_tokens(id) on delete cascade,
 session_id uuid not null references public.sessions(id) on delete restrict,
 members jsonb not null check(jsonb_typeof(members)='array' and jsonb_array_length(members) between 2 and 12)
);
revoke all on crm_private.lifecycle_confirmation_snapshots from public,anon,authenticated,service_role;

create or replace function crm_private.register_lifecycle_confirmation(p_token text,p_session_id uuid)
returns void language plpgsql security definer
set search_path=pg_catalog,public,crm_private,extensions as $function$
declare v_token_id uuid; v_members jsonb; v_invalid boolean;
begin
 if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'confirmation unavailable' using errcode='42501'; end if;
 select t.id into v_token_id from crm_private.appointment_client_action_tokens t
 where t.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') and t.session_id=p_session_id
   and t.action='confirm_attendance' and t.consumed_at is null and t.invalidated_at is null and t.expires_at>now();
 if not found then raise exception 'confirmation unavailable' using errcode='42501'; end if;
 select crm_private.lifecycle_email_members(p_session_id,'session_reminder_24h') into v_members;
 if jsonb_array_length(v_members)=1 then return; end if;
 if jsonb_array_length(v_members)<2 or jsonb_array_length(v_members)>12 then raise exception 'confirmation group unavailable' using errcode='42501'; end if;
 select exists(select 1 from crm_private.session_lifecycle_block(p_session_id) b join public.sessions s on s.id=b.session_id where s.status<>'confirmed' or s.start_at<=now()) into v_invalid;
 if v_invalid then raise exception 'confirmation group unavailable' using errcode='42501'; end if;
 insert into crm_private.lifecycle_confirmation_snapshots(token_id,session_id,members) values(v_token_id,p_session_id,v_members);
end;
$function$;
revoke all on function crm_private.register_lifecycle_confirmation(text,uuid) from public,anon,authenticated,service_role;

create or replace function crm_private.lifecycle_confirmation_valid(p_token_id uuid)
returns boolean language sql stable security invoker
set search_path=pg_catalog,public,crm_private as $function$
 select exists(select 1 from crm_private.lifecycle_confirmation_snapshots x
   where x.token_id=p_token_id and x.members=crm_private.lifecycle_email_members(x.session_id,'session_reminder_24h')
     and not exists(select 1 from crm_private.session_lifecycle_block(x.session_id) b join public.sessions s on s.id=b.session_id where s.status<>'confirmed' or s.start_at<=now()));
$function$;
revoke all on function crm_private.lifecycle_confirmation_valid(uuid) from public,anon,authenticated,service_role;

create or replace function crm_private.apply_lifecycle_confirmation(p_token text)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,crm_private,extensions as $function$
declare v_token crm_private.appointment_client_action_tokens%rowtype; v_snap crm_private.lifecycle_confirmation_snapshots%rowtype;
 v_sid uuid; v_s public.sessions%rowtype; v_result jsonb;
begin
 if not crm_private.is_service_backend() or p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'appointment action is unavailable' using errcode='42501'; end if;
 select t.* into v_token from crm_private.appointment_client_action_tokens t join crm_private.lifecycle_confirmation_snapshots x on x.token_id=t.id
 where t.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') and t.action='confirm_attendance'
   and t.expires_at>now() and t.consumed_at is null and t.invalidated_at is null;
 if not found then raise exception 'appointment action is unavailable' using errcode='42501'; end if;
 select * into v_snap from crm_private.lifecycle_confirmation_snapshots where token_id=v_token.id;
 for v_sid in select s.id from jsonb_array_elements(v_snap.members) m join public.sessions s on s.id=(m->>'id')::uuid order by s.id for update of s loop null; end loop;
 if not crm_private.lifecycle_confirmation_valid(v_token.id) then raise exception 'appointment action is unavailable' using errcode='42501'; end if;
 perform set_config('vishar.group_booking_action_inner','on',true);
 begin
   v_result:=public.service_apply_appointment_client_action(p_token);
 exception when others then
   perform set_config('vishar.group_booking_action_inner','off',true);
   raise;
 end;
 perform set_config('vishar.group_booking_action_inner','off',true);
 for v_s in select s.* from jsonb_array_elements(v_snap.members) m join public.sessions s on s.id=(m->>'id')::uuid where s.id<>v_token.session_id order by s.id loop
   update public.sessions set client_response='attendance_confirmed',client_response_at=now(),client_response_calendar_version=v_s.calendar_version where id=v_s.id;
   perform crm_private.log_artist_activity(v_s.artist_id,'appointment.client_response','worker',null,v_s.client_id,v_s.enquiry_id,v_s.project_id,v_s.id,null,
     jsonb_build_object('response','attendance_confirmed','calendar_version',v_s.calendar_version,'source','lifecycle_block'));
 end loop;
 update crm_private.appointment_client_action_tokens t set invalidated_at=now()
 where t.session_id in (select (m->>'id')::uuid from jsonb_array_elements(v_snap.members) m)
   and t.id<>v_token.id and t.consumed_at is null and t.invalidated_at is null;
 return v_result || jsonb_build_object('grouped',true,'session_count',jsonb_array_length(v_snap.members));
end;
$function$;
revoke all on function crm_private.apply_lifecycle_confirmation(text) from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.service_apply_appointment_client_action(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private', 'extensions'
AS $function$
declare
  v_hash text;
  v_token_id uuid;
  v_session_id uuid;
  v_action public.appointment_client_action;
  v_token_version integer;
  v_expires_at timestamptz;
  v_consumed_at timestamptz;
  v_invalidated_at timestamptz;
  v_status public.session_status;
  v_artist_id uuid;
  v_workspace_id uuid;
  v_artist_name text;
  v_client_id uuid;
  v_enquiry_id uuid;
  v_project_id uuid;
  v_type public.appointment_type;
  v_start_at timestamptz;
  v_calendar_version integer;
  v_calendar_event_id text;
  v_response public.appointment_client_response;
  v_notification_type text;
  v_notification_title text;
  v_notification_body text;
  v_notification_priority public.notification_priority;
begin
  if not crm_private.is_service_backend() then
    raise exception 'appointment client action mutation is backend-only'
      using errcode = '42501';
  end if;

  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;

  if coalesce(current_setting('vishar.group_booking_action_inner',true),'')<>'on'
     and exists (select 1 from crm_private.appointment_client_action_tokens t
       join crm_private.lifecycle_confirmation_snapshots x on x.token_id=t.id
       where t.token_hash=encode(extensions.digest(p_token,'sha256'),'hex')) then
    return crm_private.apply_lifecycle_confirmation(p_token);
  end if;

  -- A group token is applied to every snapshotted session atomically.
  if coalesce(current_setting('vishar.group_booking_action_inner',true),'')<>'on'
     and exists (select 1 from crm_private.appointment_client_action_tokens t
       join crm_private.booking_card_group_action_tokens gt on gt.token_id=t.id
       where t.token_hash=encode(extensions.digest(p_token,'sha256'),'hex')) then
    return crm_private.apply_group_booking_card_action(p_token);
  end if;

  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  -- First resolve only the immutable token -> session identity without taking
  -- a token-row lock. Every path that can mutate these capabilities locks the
  -- session first, then a token row. Keeping one lock order avoids a deadlock
  -- between reminder minting and a client POST arriving at the same moment.
  select t.id, t.session_id
    into v_token_id, v_session_id
  from crm_private.appointment_client_action_tokens t
  where t.token_hash = v_hash;

  if not found then
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;

  select s.status, s.artist_id, a.workspace_id, a.display_name,
         s.client_id, s.enquiry_id, s.project_id, s.appointment_type,
         s.start_at, s.calendar_version, s.calendar_event_id
    into v_status, v_artist_id, v_workspace_id, v_artist_name,
         v_client_id, v_enquiry_id, v_project_id, v_type,
         v_start_at, v_calendar_version, v_calendar_event_id
  from public.sessions s
  join public.artists a on a.id = s.artist_id
  join crm_private.artist_state st on st.artist_id = s.artist_id and st.is_active
  where s.id = v_session_id
  for update of s;

  if not found
     or v_status <> 'confirmed'::public.session_status
     or v_start_at <= now() then
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;

  -- Re-read and lock the capability only after the session lock. This closes
  -- the race between the initial lookup and lock acquisition, while preserving
  -- the same session -> token lock order used by the minting primitive.
  select t.action, t.session_calendar_version, t.expires_at,
         t.consumed_at, t.invalidated_at
    into v_action, v_token_version, v_expires_at,
         v_consumed_at, v_invalidated_at
  from crm_private.appointment_client_action_tokens t
  where t.id = v_token_id
    and t.session_id = v_session_id
    and t.token_hash = v_hash
  for update;

  if not found
     or v_consumed_at is not null
     or v_invalidated_at is not null
     or v_expires_at <= now()
     or v_token_version <> v_calendar_version then
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;

  if v_action = 'confirm_attendance'::public.appointment_client_action then
    v_response := 'attendance_confirmed'::public.appointment_client_response;
    v_notification_type := 'appointment.attendance_confirmed';
    v_notification_title := 'Client confirmed attendance';
    v_notification_body := 'The client confirmed they plan to attend this appointment.';
    v_notification_priority := 'low'::public.notification_priority;

    update public.sessions s
    set client_response = v_response,
        client_response_at = now(),
        client_response_calendar_version = v_calendar_version
    where s.id = v_session_id;

  elsif v_action = 'request_reschedule'::public.appointment_client_action then
    v_response := 'reschedule_requested'::public.appointment_client_response;
    v_notification_type := 'appointment.reschedule_requested';
    v_notification_title := 'Client requested a reschedule';
    v_notification_body := 'The appointment time has not changed. Contact the client and choose a new slot before rescheduling it in CRM.';
    v_notification_priority := 'high'::public.notification_priority;

    update public.sessions s
    set client_response = v_response,
        client_response_at = now(),
        client_response_calendar_version = v_calendar_version
    where s.id = v_session_id;

  elsif v_action = 'cancel'::public.appointment_client_action then
    v_notification_type := 'appointment.cancelled_by_client';
    v_notification_title := 'Client cancelled an appointment';
    v_notification_body := 'The client cancelled this appointment from the secure reminder link.';
    v_notification_priority := 'high'::public.notification_priority;

    -- Exact confirmed -> cancelled semantics from public.set_appointment_status:
    -- increment the calendar version, preserve the activity projection and
    -- enqueue a provider cancellation only when a calendar event already exists.
    update public.sessions s
    set status = 'cancelled'::public.session_status,
        cancelled_at = now(),
        calendar_version = s.calendar_version + 1
    where s.id = v_session_id;

    perform crm_private.log_artist_activity(
      v_artist_id,
      'appointment.status_changed',
      'worker',
      null,
      v_client_id,
      v_enquiry_id,
      v_project_id,
      v_session_id,
      null,
      jsonb_build_object(
        'appointment_type', v_type,
        'from_status', v_status,
        'to_status', 'cancelled',
        'source', 'client_action_link'
      )
    );

    if v_calendar_event_id is not null then
      perform crm_private.enqueue_outbox(
        'calendar_cancel',
        public.calendar_outbox_dedupe_key('cancel', v_session_id, v_calendar_version + 1),
        jsonb_build_object(
          'session_id', v_session_id,
          'appointment_type', v_type,
          'calendar_version', v_calendar_version + 1
        ),
        v_client_id, v_enquiry_id, v_project_id, v_session_id, null
      );
    end if;
  else
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;

  if v_action <> 'cancel'::public.appointment_client_action then
    perform crm_private.log_artist_activity(
      v_artist_id,
      'appointment.client_response',
      'worker',
      null,
      v_client_id,
      v_enquiry_id,
      v_project_id,
      v_session_id,
      null,
      jsonb_build_object(
        'response', v_response,
        'calendar_version', v_calendar_version,
        'source', 'client_action_link'
      )
    );
  end if;

  insert into public.notifications (
    recipient_profile_id,
    artist_id,
    workspace_id,
    notification_type,
    title,
    body,
    entity_type,
    entity_id,
    priority,
    status,
    dedupe_key,
    scheduled_at,
    delivered_at
  )
  select
    r.profile_id,
    v_artist_id,
    v_workspace_id,
    v_notification_type,
    v_notification_title,
    v_notification_body,
    'session',
    v_session_id,
    v_notification_priority,
    'delivered'::public.notification_status,
    'appointment_client_action:' || v_session_id::text || ':'
      || v_calendar_version::text || ':' || v_action::text || ':' || r.profile_id::text,
    now(),
    now()
  from crm_private.automation_notification_recipients(v_artist_id) r
  on conflict (dedupe_key) do nothing;

  -- Consume the chosen capability and invalidate its siblings atomically. A
  -- retry or a contradictory click from the same reminder cannot mutate twice.
  update crm_private.appointment_client_action_tokens t
  set consumed_at = now()
  where t.id = v_token_id;

  update crm_private.appointment_client_action_tokens t
  set invalidated_at = now()
  where t.session_id = v_session_id
    and t.id <> v_token_id
    and t.consumed_at is null
    and t.invalidated_at is null;

  return jsonb_build_object(
    'action', v_action,
    'outcome', case v_action
      when 'confirm_attendance'::public.appointment_client_action then 'attendance_confirmed'
      when 'request_reschedule'::public.appointment_client_action then 'reschedule_requested'
      when 'cancel'::public.appointment_client_action then 'cancelled'
    end,
    'artist_display_name', v_artist_name
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.service_resolve_appointment_client_action(p_token text)
 RETURNS TABLE(action appointment_client_action, artist_display_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private', 'extensions'
AS $function$
declare
  v_hash text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'appointment client action resolution is backend-only'
      using errcode = '42501';
  end if;

  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;

  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  return query
  select t.action, a.display_name
  from crm_private.appointment_client_action_tokens t
  join public.sessions s on s.id = t.session_id
  join public.artists a on a.id = s.artist_id
  join crm_private.artist_state st on st.artist_id = s.artist_id and st.is_active
  where t.token_hash = v_hash
    and t.consumed_at is null
    and t.invalidated_at is null
    and t.expires_at > now()
    and t.session_calendar_version = s.calendar_version
    and s.status = 'confirmed'::public.session_status
    and s.start_at > now()
    and (t.booking_card_id is null or crm_private.booking_group_card_valid(t.booking_card_id))
    and (not exists (select 1 from crm_private.lifecycle_confirmation_snapshots x where x.token_id=t.id)
         or crm_private.lifecycle_confirmation_valid(t.id));

  if not found then
    raise exception 'appointment action is unavailable'
      using errcode = '42501';
  end if;
end;
$function$;

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
