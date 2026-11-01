-- Terminally withdraw definitely-unsent obsolete lifecycle WhatsApp
-- Utility templates. Keep the durable send-intent semantics unchanged for all
-- other WhatsApp and Instagram traffic and for provider-unknown results.
CREATE OR REPLACE FUNCTION public.record_communication_outbox_result(p_outbox_id uuid, p_worker_id text, p_succeeded boolean, p_provider_message_id text DEFAULT NULL::text, p_error_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_job public.integration_outbox%rowtype;
  v_status public.outbox_status;
  v_attempt_count integer;
  v_provider_message_id text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'communication outbox acknowledgement is backend-only'
      using errcode = '42501';
  end if;
  if p_outbox_id is null then
    raise exception 'an outbox id is required' using errcode = '22023';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'a safe worker id is required' using errcode = '22023';
  end if;
  if p_succeeded is null then
    raise exception 'an explicit result is required' using errcode = '22023';
  end if;
  if not p_succeeded
     and coalesce(p_error_code, '') !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'failed communication result requires a safe machine error code'
      using errcode = '22023';
  end if;

  v_provider_message_id := nullif(btrim(coalesce(p_provider_message_id, '')), '');
  if p_succeeded and v_provider_message_id is null then
    raise exception 'a successful send must report a provider message id'
      using errcode = '22023';
  end if;
  if v_provider_message_id is not null
     and v_provider_message_id !~ '^[A-Za-z0-9_=./-]{8,255}$' then
    raise exception 'the provider message id is not in the expected form'
      using errcode = '22023';
  end if;

  select o.* into v_job
  from public.integration_outbox o
  where o.id = p_outbox_id
    and o.kind in (
      'whatsapp_message'::public.outbox_kind,
      'instagram_message'::public.outbox_kind
    )
  for update;
  if not found then
    raise exception 'communication outbox job is unavailable' using errcode = '22023';
  end if;

  -- Idempotent replay of a successful acknowledgement. The lease fields were
  -- already cleared, so ownership is proved by the audit row this worker wrote.
  if v_job.status = 'succeeded'::public.outbox_status and p_succeeded then
    if not exists (
      select 1
      from public.activity_log a
      where a.outbox_id = p_outbox_id
        and a.event_type = 'outbox.succeeded'
        and a.metadata ->> 'worker_id' = p_worker_id
    ) then
      raise exception 'communication outbox lease is not owned by this worker'
        using errcode = '42501';
    end if;
    return jsonb_build_object(
      'outbox_id', p_outbox_id,
      'status', v_job.status,
      'attempt_count', v_job.attempt_count,
      'changed', false
    );
  end if;

  if v_job.status <> 'leased'::public.outbox_status
     or v_job.leased_by is distinct from p_worker_id then
    raise exception 'communication outbox lease is not owned by this worker'
      using errcode = '42501';
  end if;

  v_attempt_count := v_job.attempt_count + 1;
  v_status := case
    when p_succeeded then 'succeeded'::public.outbox_status
    -- An unknown send outcome is never retried automatically (audit M-2).
    when p_error_code = 'communication_send_result_unknown' then 'dead'::public.outbox_status
    -- A lease revalidated BEFORE send intent and found an obsolete lifecycle
    -- block. Definitively dead-letter, rather than retrying the same stale
    -- appointment up to max_attempts and delaying a replacement.
    when p_error_code = 'whatsapp_lifecycle_obsolete'
      and v_job.kind='whatsapp_message'::public.outbox_kind
      and v_job.provider_send_started_at is null
      and exists (
        select 1 from crm_private.lifecycle_whatsapp_payloads p
        where p.communication_message_id=v_job.communication_message_id
          and p.artist_id=v_job.artist_id
      ) then 'dead'::public.outbox_status
    when v_attempt_count >= v_job.max_attempts then 'dead'::public.outbox_status
    else 'failed'::public.outbox_status
  end;

  update public.integration_outbox o
  set status = v_status,
      attempt_count = v_attempt_count,
      next_attempt_at = case
        when p_succeeded or v_status = 'dead'::public.outbox_status then o.next_attempt_at
        else now() + make_interval(
          secs => least((power(2, least(v_job.attempt_count, 7)) * 30)::integer, 3600)
        )
      end,
      leased_by = null,
      leased_at = null,
      lease_expires_at = null,
      last_error_code = case when p_succeeded then null else p_error_code end,
      -- An explicit provider failure means nothing was accepted, so the next
      -- attempt may send; success and an unknown outcome keep the evidence.
      provider_send_started_at = case
        when p_succeeded or p_error_code = 'communication_send_result_unknown' then o.provider_send_started_at
        else null
      end,
      updated_at = now()
  where o.id = p_outbox_id;

  -- The message row follows the job. A retryable failure leaves the message
  -- queued; only a terminal failure marks it failed in the CRM timeline.
  if p_succeeded then
    -- Meta can deliver the echo of this very send before this acknowledgement
    -- arrives. The echo was then recorded as a provider_app row carrying the
    -- provider message id this CRM row is about to take, and the unique key
    -- would reject the acknowledgement. The echo is the same message, so it
    -- is folded into the CRM row instead of being kept as a duplicate.
    delete from public.communication_messages e
    using public.communication_messages m
    where m.id = v_job.communication_message_id
      and m.provider_message_id is null
      and e.id <> m.id
      and e.artist_id = m.artist_id
      and e.channel = m.channel
      and e.conversation_id = m.conversation_id
      and e.direction = 'outbound'::public.communication_direction
      and e.origin = 'provider_app'::public.communication_origin
      and e.provider_message_id = v_provider_message_id;

    update public.communication_messages m
    set status = 'sent'::public.communication_status,
        provider_message_id = coalesce(m.provider_message_id, v_provider_message_id),
        sent_at = coalesce(m.sent_at, now()),
        error_code = null,
        updated_at = now()
    where m.id = v_job.communication_message_id;
  elsif v_status = 'dead'::public.outbox_status then
    update public.communication_messages m
    set status = 'failed'::public.communication_status,
        failed_at = now(),
        error_code = p_error_code,
        updated_at = now()
    where m.id = v_job.communication_message_id;
  end if;

  perform crm_private.log_activity(
    case when p_succeeded then 'outbox.succeeded' else 'outbox.failed' end,
    'worker',
    null,
    v_job.client_id,
    v_job.enquiry_id,
    v_job.project_id,
    v_job.session_id,
    null, null, null,
    p_outbox_id,
    jsonb_build_object(
      'attempt_count', v_attempt_count,
      'error_code', case when p_succeeded then null else p_error_code end,
      'worker_id', p_worker_id,
      'lease_aware', true,
      'dead_letter', v_status = 'dead'::public.outbox_status
    )
  );

  return jsonb_build_object(
    'outbox_id', p_outbox_id,
    'status', v_status,
    'attempt_count', v_attempt_count,
    'changed', true
  );
end;
$function$;
create or replace function crm_private.lifecycle_block_disposition(p_job_id uuid)
returns text language plpgsql stable security invoker
set search_path = pg_catalog, public, crm_private as $function$
declare
  v_job public.automation_jobs%rowtype;
  v_session public.sessions%rowtype;
  v_anchor uuid;
  v_other_consumed boolean;
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

  select exists (
    select 1 from crm_private.session_lifecycle_block(v_session.id) b
    join public.automation_jobs j
      on j.session_id=b.session_id and j.artist_id=v_job.artist_id
    where j.id<>v_job.id
      and j.message_purpose=v_job.message_purpose
      and j.status='completed'
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
    join public.sessions s on s.id=b.session_id
    where s.status='completed'
    order by b.end_at,b.session_id limit 1;
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
  return 'eligible';
end;
$function$;
-- This hook can only fire on a provider ACK that definitively rejected
-- an obsolete template BEFORE the durable send-intent boundary.
create or replace function crm_private.reissue_pre_send_obsolete_whatsapp()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $function$
declare
 j public.automation_jobs%rowtype;
 r public.automation_rules%rowtype;
 s public.sessions%rowtype;
 v_due timestamptz;
begin
 if new.kind<>'whatsapp_message' or old.status<>'leased'
    or new.status<>'dead' or new.last_error_code<>'whatsapp_lifecycle_obsolete'
    or new.provider_send_started_at is not null
    or new.communication_message_id is null
 then return new; end if;

 select job.* into j
 from crm_private.lifecycle_whatsapp_payloads p
 join public.automation_jobs job on job.id=p.automation_job_id
 where p.communication_message_id=new.communication_message_id
   and p.artist_id=new.artist_id and job.artist_id=new.artist_id
   and job.status='completed';
 if not found then return new; end if;

 -- Keep the old provider message in CRM as failed, never as successfully sent.
 update public.communication_messages m
 set status='failed',failed_at=now(),
     error_code='whatsapp_lifecycle_obsolete',updated_at=now()
 where m.id=new.communication_message_id
   and m.artist_id=new.artist_id and m.status='queued';

 if j.lifecycle_revision>=1000 or exists(
   select 1 from public.automation_jobs later
   where later.rule_id=j.rule_id and later.session_id=j.session_id
     and later.lifecycle_revision>j.lifecycle_revision
 ) then return new; end if;

 select * into r from public.automation_rules
 where id=j.rule_id and artist_id=j.artist_id
   and is_enabled and version=j.rule_version;
 select * into s from public.sessions
 where id=j.session_id and artist_id=j.artist_id;
 if r.id is null or s.id is null
   or s.appointment_type is distinct from j.condition_appointment_type
   or (j.schedule_anchor='session_start' and s.status<>'confirmed')
   or (j.schedule_anchor='session_end' and s.status<>'completed')
   or crm_private.client_send_block_reason(s.client_id,'whatsapp','service') is not null
 then return new; end if;

 v_due:=case j.schedule_anchor when 'session_start' then s.start_at
   when 'session_end' then coalesce(s.actual_end_at,s.end_at)
   else null::timestamptz end + make_interval(mins=>j.anchor_offset_minutes);
 if v_due is null then return new; end if;

 if v_due<now()-interval '15 minutes' then
   insert into public.notifications(
     recipient_profile_id,artist_id,notification_type,title,body,
     priority,status,dedupe_key,scheduled_at,delivered_at
   )
   select recipient.profile_id,j.artist_id,
     'automation.lifecycle_obsolete_requires_review',
     'Automatic message needs review',
     'An automatic WhatsApp message was cancelled before delivery after an appointment changed. Its replacement is now past due and requires review.',
     'high','delivered',
     'lifecycle_wa_obsolete_late:'||j.id::text||':'||recipient.profile_id::text,
     now(),now()
   from crm_private.automation_notification_recipients(j.artist_id) recipient
   on conflict (dedupe_key) do nothing;
   return new;
 end if;

 insert into public.automation_jobs(
   rule_id,rule_version,event_id,artist_id,action_type,action_title,
   action_body,action_priority,schedule_anchor,anchor_offset_minutes,
   condition_appointment_type,message_purpose,message_channel,
   message_locale,session_id,scheduled_at,lifecycle_revision
 ) values (
   j.rule_id,j.rule_version,j.event_id,j.artist_id,
   j.action_type,j.action_title,j.action_body,j.action_priority,
   j.schedule_anchor,j.anchor_offset_minutes,j.condition_appointment_type,
   j.message_purpose,j.message_channel,j.message_locale,j.session_id,v_due,
   j.lifecycle_revision+1
 ) on conflict do nothing;
 return new;
end;
$function$;
revoke all on function crm_private.reissue_pre_send_obsolete_whatsapp()
 from public,anon,authenticated,service_role;
create trigger integration_outbox_reissue_obsolete_whatsapp
after update of status,last_error_code on public.integration_outbox
for each row execute function crm_private.reissue_pre_send_obsolete_whatsapp();
