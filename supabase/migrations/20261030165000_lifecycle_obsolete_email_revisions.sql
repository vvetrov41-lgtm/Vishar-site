-- Recover only provider-confirmed pre-send obsolete lifecycle email.
-- Never re-issue an acknowledged, leased, ambiguously failed, or dispatched
-- message. Keep old jobs, email snapshots and outbox rows for audit.
alter table public.automation_jobs
  add column lifecycle_revision integer not null default 1
  check (lifecycle_revision between 1 and 1000);

-- The legacy unique indexes prevented even a verified pre-send cancellation
-- from producing a replacement. A revision is a distinct immutable attempt.
alter table public.automation_jobs
  drop constraint automation_jobs_rule_id_event_id_key;
create unique index automation_jobs_rule_event_revision_uidx
  on public.automation_jobs(rule_id,event_id,lifecycle_revision);
drop index public.automation_jobs_lifecycle_rule_session_idx;
create unique index automation_jobs_lifecycle_rule_session_rev_idx
  on public.automation_jobs(rule_id,session_id,lifecycle_revision)
  where session_id is not null;

-- A completed job can mean "Gmail queued", NOT "Gmail accepted".
-- A terminal provider PRE-SEND obsolete acknowledgement is the one case that
-- must not suppress a replacement from the current block's pending jobs.
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
      and not exists (
        select 1 from public.email_messages m
        join public.integration_outbox o on o.email_message_id=m.id
        where m.automation_job_id=j.id
          and m.status='cancelled'
          and o.kind='approved_email'
          and o.status='dead'
          and o.last_error_code='gmail_lifecycle_email_obsolete'
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
revoke all on function crm_private.lifecycle_block_disposition(uuid)
  from public,anon,authenticated,service_role;

-- Triggered by the existing durable Gmail outbox acknowledgement.
-- It never sends to a provider. Rechecking the last outbox result and
-- retention of earlier revisions avoids "unknown result" duplicate sends.
create or replace function crm_private.reissue_pre_send_obsolete_lifecycle()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, crm_private as $function$
declare
  v_job public.automation_jobs%rowtype;
  v_session public.sessions%rowtype;
  v_rule public.automation_rules%rowtype;
  v_due timestamptz;
  v_inserted uuid;
begin
  if new.kind <> 'approved_email' or new.status <> 'dead'
    or new.last_error_code <> 'gmail_lifecycle_email_obsolete'
    or old.status = 'dead' or new.email_message_id is null
    or new.provider_send_started_at is not null
  then return new; end if;

  select j.* into v_job
    from public.email_messages m
    join public.automation_jobs j on j.id=m.automation_job_id
    join crm_private.lifecycle_email_snapshots snap
      on snap.job_id=j.id and snap.email_message_id=m.id
    where m.id=new.email_message_id
      and m.artist_id=new.artist_id
      and j.artist_id=new.artist_id
      and j.status='completed'
      and j.message_channel='email'
      and j.message_purpose in
        ('session_reminder_72h','session_reminder_24h',
         'post_session_aftercare','post_session_checkin');
  if not found then return new; end if;

  -- A later attempt already exists, or another worker won the CAS. Neither
  -- the queued nor the successfully acknowledged attempt is overwritten.
  if exists (
    select 1 from public.automation_jobs j
    where j.rule_id=v_job.rule_id and j.session_id=v_job.session_id
      and j.lifecycle_revision>v_job.lifecycle_revision
  ) then return new; end if;
  if v_job.lifecycle_revision>=1000 then return new; end if;

  select * into v_rule from public.automation_rules
    where id=v_job.rule_id and artist_id=v_job.artist_id
      and is_enabled and version=v_job.rule_version;
  if not found then return new; end if;
  select * into v_session from public.sessions
    where id=v_job.session_id and artist_id=v_job.artist_id;
  if not found
    or v_session.appointment_type is distinct from v_job.condition_appointment_type
    or (v_job.schedule_anchor='session_start' and v_session.status<>'confirmed')
    or (v_job.schedule_anchor='session_end' and v_session.status<>'completed')
    or crm_private.client_send_block_reason(v_session.client_id,'email','service') is not null
  then return new; end if;

  v_due := case v_job.schedule_anchor
    when 'session_start' then v_session.start_at
    when 'session_end' then coalesce(v_session.actual_end_at,v_session.end_at)
    else null::timestamptz
  end + make_interval(mins=>v_job.anchor_offset_minutes);
  if v_due is null then return new; end if;

  -- Never batch-send an old 72h/24h reminder or a stale check-in.
  if v_due < now()-interval '15 minutes' then
    insert into public.notifications (
      recipient_profile_id,artist_id,notification_type,title,body,
      priority,status,dedupe_key,scheduled_at,delivered_at
    )
    select recip.profile_id,v_job.artist_id,
      'automation.lifecycle_obsolete_requires_review',
      'Automatic message needs review',
      'An automatic client message was cancelled before delivery after its appointment changed. Its replacement is now past due and requires review.',
      'high','delivered',
      'lifecycle_obsolete_late:'||v_job.id::text||':'||recip.profile_id::text,
      now(),now()
    from crm_private.automation_notification_recipients(v_job.artist_id) recip
    on conflict(dedupe_key) do nothing;
    return new;
  end if;

  insert into public.automation_jobs(
    rule_id,rule_version,event_id,artist_id,action_type,action_title,
    action_body,action_priority,schedule_anchor,anchor_offset_minutes,
    condition_appointment_type,message_purpose,message_channel,
    message_locale,session_id,scheduled_at,lifecycle_revision
  ) values (
    v_job.rule_id,v_job.rule_version,v_job.event_id,v_job.artist_id,
    v_job.action_type,v_job.action_title,v_job.action_body,
    v_job.action_priority,v_job.schedule_anchor,v_job.anchor_offset_minutes,
    v_job.condition_appointment_type,v_job.message_purpose,
    v_job.message_channel,v_job.message_locale,v_job.session_id,v_due,
    v_job.lifecycle_revision+1
  )
  on conflict do nothing returning id into v_inserted;
  return new;
end;
$function$;
revoke all on function crm_private.reissue_pre_send_obsolete_lifecycle()
  from public,anon,authenticated,service_role;
create trigger integration_outbox_reissue_obsolete_lifecycle
after update of status,last_error_code on public.integration_outbox
for each row execute function crm_private.reissue_pre_send_obsolete_lifecycle();
