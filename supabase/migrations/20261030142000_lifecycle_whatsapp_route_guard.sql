-- Do not silently route an automated lifecycle email to Gmail when the
-- client's most recent real conversation with this artist is WhatsApp.
-- Provider-approved WhatsApp lifecycle templates are a separate transport.
create or replace function crm_private.guard_lifecycle_email_conversation_channel()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $function$
declare v_channel text;
begin
  if new.automation_job_id is null or new.template_key not in
    ('session_reminder_72h','session_reminder_24h',
     'post_session_aftercare','post_session_checkin') then return new; end if;
  select ev.channel into v_channel
  from crm_private.booking_card_conversation_evidence(new.client_id,new.artist_id) ev;
  if v_channel='whatsapp' then
    raise exception 'lifecycle WhatsApp utility template is unavailable'
      using errcode='23514';
  end if;
  return new;
end;
$function$;
revoke all on function crm_private.guard_lifecycle_email_conversation_channel()
  from public,anon,authenticated,service_role;
create trigger email_messages_lifecycle_conversation_channel
before insert on public.email_messages for each row
execute function crm_private.guard_lifecycle_email_conversation_channel();

-- The executor catches the insertion error and marks the job failed. Turn
-- this specific route failure into the existing single-job artist alert.
create or replace function crm_private.classify_lifecycle_channel_failure()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $function$
declare v_channel text; v_client_id uuid;
begin
  if old.status='failed' or new.status<>'failed'
     or new.last_error_category<>'unknown'
     or new.action_type<>'send_client_message'
     or new.message_purpose not in
       ('session_reminder_72h','session_reminder_24h',
        'post_session_aftercare','post_session_checkin') then return new; end if;
  select s.client_id into v_client_id from public.sessions s
  where s.id=new.session_id and s.artist_id=new.artist_id;
  select ev.channel into v_channel
  from crm_private.booking_card_conversation_evidence(v_client_id,new.artist_id) ev;
  if v_channel='whatsapp' then
    new.last_error_category:='integration_unavailable';
  end if;
  return new;
end;
$function$;
revoke all on function crm_private.classify_lifecycle_channel_failure()
  from public,anon,authenticated,service_role;
create trigger automation_jobs_lifecycle_channel_failure
before update of status,last_error_category on public.automation_jobs
for each row execute function crm_private.classify_lifecycle_channel_failure();

-- A queued or leased legacy email also loses delivery permission when the
-- current conversation has moved to WhatsApp.
create or replace function crm_private.lifecycle_delivery_snapshot_current(p_email_message_id uuid)
returns boolean language plpgsql stable security invoker
set search_path=pg_catalog,public,crm_private as $function$
declare v_job public.automation_jobs%rowtype; v_snapshot crm_private.lifecycle_email_snapshots%rowtype; v_message public.email_messages%rowtype;
begin
 select * into v_message from public.email_messages where id=p_email_message_id;
 if not found or v_message.automation_job_id is null then return false; end if;
 select * into v_job from public.automation_jobs where id=v_message.automation_job_id;
 if not found then return false; end if;
 if v_job.message_purpose is null or v_job.message_purpose not in ('session_reminder_72h','session_reminder_24h','post_session_aftercare','post_session_checkin') then return true; end if;
 select * into v_snapshot from crm_private.lifecycle_email_snapshots where email_message_id=v_message.id and job_id=v_job.id;
 if not found or v_snapshot.session_id is distinct from v_job.session_id or v_snapshot.purpose is distinct from v_job.message_purpose then return false; end if;
 if v_job.artist_id is distinct from v_message.artist_id
    or crm_private.client_send_block_reason(v_message.client_id,'email','service') is not null
    or exists (select 1 from crm_private.booking_card_conversation_evidence(v_message.client_id,v_job.artist_id) ev where ev.channel='whatsapp')
    then return false; end if;
 return v_snapshot.members=crm_private.lifecycle_email_members(v_job.session_id,v_job.message_purpose);
end;
$function$;
