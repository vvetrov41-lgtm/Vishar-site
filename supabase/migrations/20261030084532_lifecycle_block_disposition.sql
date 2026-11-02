-- Read-only decision primitive. It is not connected to dispatch: callers must
-- serialize concurrent scheduling and recheck after acquiring their locks.
create or replace function crm_private.lifecycle_block_disposition(p_job_id uuid)
returns text language plpgsql stable security invoker
set search_path = pg_catalog, public, crm_private as $function$
declare
  v_job public.automation_jobs%rowtype;
  v_session public.sessions%rowtype;
  v_anchor uuid;
  v_other_delivered boolean;
begin
  select * into v_job from public.automation_jobs where id=p_job_id;
  if not found then return 'ineligible'; end if;
  if v_job.message_purpose is null or v_job.message_purpose not in ('session_reminder_72h','session_reminder_24h','post_session_aftercare','post_session_checkin') then
    return 'unmanaged';
  end if;
  if v_job.status <> 'pending' or v_job.action_type <> 'send_client_message' then return 'ineligible'; end if;
  select * into v_session from public.sessions where id=v_job.session_id and artist_id=v_job.artist_id;
  if not found or v_session.appointment_type not in ('tattoo_session','touch_up') then return 'ineligible'; end if;
  if not exists (select 1 from crm_private.session_lifecycle_block(v_session.id)) then return 'ineligible'; end if;

  -- A completed job represents an email already enqueued, not necessarily
  -- delivered. Treat it as consumed to avoid a duplicate during retries.
  select exists (
    select 1 from crm_private.session_lifecycle_block(v_session.id) b
    join public.automation_jobs j on j.session_id=b.session_id and j.artist_id=v_job.artist_id
    where j.id<>v_job.id and j.message_purpose=v_job.message_purpose
      and j.status='completed'
  ) into v_other_delivered;
  if v_other_delivered then return 'already_queued'; end if;

  if v_job.message_purpose in ('session_reminder_72h','session_reminder_24h') then
    select b.session_id into v_anchor from crm_private.session_lifecycle_block(v_session.id) b
    order by b.start_at,b.session_id limit 1;
    if v_session.status<>'confirmed' then return 'defer'; end if;
  elsif v_job.message_purpose='post_session_aftercare' then
    select b.session_id into v_anchor from crm_private.session_lifecycle_block(v_session.id) b
    join public.sessions s on s.id=b.session_id
    where s.status='completed' order by b.end_at,b.session_id limit 1;
    if v_session.status<>'completed' then return 'defer'; end if;
  else
    if exists (select 1 from crm_private.session_lifecycle_block(v_session.id) b
      join public.sessions s on s.id=b.session_id where s.status<>'completed') then return 'defer'; end if;
    select b.session_id into v_anchor from crm_private.session_lifecycle_block(v_session.id) b
    order by b.end_at desc,b.session_id desc limit 1;
    if v_session.status<>'completed' then return 'defer'; end if;
  end if;
  if v_anchor is distinct from v_session.id then return 'defer'; end if;
  return 'eligible';
end;
$function$;
revoke all on function crm_private.lifecycle_block_disposition(uuid) from public,anon,authenticated,service_role;
comment on function crm_private.lifecycle_block_disposition(uuid) is 'Non-dispatching advisory decision only. Caller must serialize mutations and revalidate before sending.';
