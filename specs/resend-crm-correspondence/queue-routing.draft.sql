-- Candidate SQL only. Generate migration and exact function manifest in isolated CI.
-- Existing definitions copied only after live hash matches committed manifest.
CREATE OR REPLACE FUNCTION public.claim_email_outbox(p_worker_id text, p_limit integer DEFAULT 10, p_lease_seconds integer DEFAULT 120)
 RETURNS TABLE(outbox_id uuid, artist_id uuid, email_message_id uuid, client_id uuid, enquiry_id uuid, integration_key text, mailbox_email text, to_email text, subject text, body text, html_body text, thread_context_id uuid, attempt_count integer, max_attempts integer, job_valid boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_limit integer := coalesce(p_limit, 10);
  v_lease_seconds integer := coalesce(p_lease_seconds, 120);
begin
  if not crm_private.is_service_backend() then
    raise exception 'email outbox claiming is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'a safe worker id is required' using errcode = '22023';
  end if;
  if v_limit < 1 or v_limit > 20 or v_lease_seconds < 30 or v_lease_seconds > 600 then
    raise exception 'invalid email claim bounds' using errcode = '22023';
  end if;

  return query
  with candidates as (
    select o.id
    from public.integration_outbox o
    where o.kind = 'approved_email'::public.outbox_kind
      and not exists (select 1 from crm_private.resend_correspondence_attempts a where a.outbox_id=o.id)
      and o.attempt_count < o.max_attempts
      and (
        (o.status in ('pending'::public.outbox_status, 'failed'::public.outbox_status)
          and o.next_attempt_at <= now())
        or (o.status = 'leased'::public.outbox_status and o.lease_expires_at <= now())
      )
    order by o.next_attempt_at, o.created_at, o.id
    for update of o skip locked
    limit v_limit
  ), leased as (
    update public.integration_outbox o
    set status = 'leased'::public.outbox_status,
        leased_by = p_worker_id,
        leased_at = now(),
        lease_expires_at = now() + make_interval(secs => v_lease_seconds),
        updated_at = now()
    from candidates c
    where o.id = c.id
    returning o.*
  )
  select
    l.id, l.artist_id, l.email_message_id, l.client_id, l.enquiry_id,
    i.integration_key, lower(btrim(i.external_account_label)),
    m.to_email, m.subject, m.body, m.html_body, m.gmail_thread_context_id,
    l.attempt_count, l.max_attempts,
    (
      m.id is not null
      and m.artist_id = l.artist_id
      and m.client_id = l.client_id
      and m.status = 'approved'::public.email_message_status
      and lower(btrim(m.to_email)) = lower(btrim(cl.email))
      and i.id is not null
      and i.provider = 'google'
      and i.is_enabled
      and (
        m.booking_card_id is null
        or exists (
          select 1
          from crm_private.booking_cards bc
          join public.sessions s on s.id = bc.session_id
          where bc.id = m.booking_card_id
            and bc.superseded_at is null
            and crm_private.booking_group_card_valid(bc.id)
            and s.artist_id = bc.artist_id
            and s.client_id = bc.client_id
            and s.status = 'confirmed'::public.session_status
            and s.calendar_version = bc.calendar_version
            and s.start_at > now()
        )
      )
      and (m.gmail_thread_context_id is null or exists (
        select 1 from crm_private.gmail_thread_contexts gc
        where gc.id = m.gmail_thread_context_id
          and gc.artist_id = l.artist_id
          and gc.client_id = l.client_id
          and gc.enquiry_id = l.enquiry_id
      ))
    ) as job_valid
  from leased l
  left join public.email_messages m on m.id = l.email_message_id
  left join public.clients cl on cl.id = l.client_id
  left join public.artist_integrations i
    on i.artist_id = l.artist_id
   and i.integration_type = 'email'::public.artist_integration_type
   and i.provider = 'google'
   and i.is_enabled
  order by l.next_attempt_at, l.created_at, l.id;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.record_email_outbox_result(p_outbox_id uuid, p_worker_id text, p_succeeded boolean, p_provider_message_id text DEFAULT NULL::text, p_error_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_job public.integration_outbox%rowtype;
  v_status public.outbox_status;
  v_attempt_count integer;
  v_provider_message_id text := nullif(btrim(coalesce(p_provider_message_id, '')), '');
begin
  if not crm_private.is_service_backend() then
    raise exception 'email outbox acknowledgement is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' or p_succeeded is null then
    raise exception 'valid email worker result is required' using errcode = '22023';
  end if;
  if p_succeeded and (v_provider_message_id is null or v_provider_message_id !~ '^[A-Za-z0-9_-]{4,255}$') then
    raise exception 'successful Gmail send requires a provider message id' using errcode = '22023';
  end if;
  if not p_succeeded and coalesce(p_error_code, '') !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'failed Gmail result requires a safe error code' using errcode = '22023';
  end if;

  select o.* into v_job
  from public.integration_outbox o
  where o.id = p_outbox_id and o.kind = 'approved_email'::public.outbox_kind
  for update;
  if not found then
    raise exception 'email outbox job is unavailable' using errcode = '22023';
  end if;

  if exists (select 1 from crm_private.resend_correspondence_attempts a where a.outbox_id=v_job.id) then
    raise exception 'Resend-reserved outbox requires Resend receipt' using errcode='42501';
  end if;

  if v_job.status = 'succeeded'::public.outbox_status and p_succeeded then
    return jsonb_build_object('outbox_id', p_outbox_id, 'status', v_job.status, 'attempt_count', v_job.attempt_count, 'changed', false);
  end if;
  if v_job.status <> 'leased'::public.outbox_status or v_job.leased_by is distinct from p_worker_id then
    raise exception 'email outbox lease is not owned by this worker' using errcode = '42501';
  end if;

  v_attempt_count := v_job.attempt_count + 1;
  v_status := case
    when p_succeeded then 'succeeded'::public.outbox_status
    when p_error_code = 'gmail_deposit_email_obsolete'
      and crm_private.gmail_deposit_email_obsolete(v_job.email_message_id)
      then 'dead'::public.outbox_status
    -- The claim found the CRM record itself unsendable (status, recipient,
    -- integration, card or thread). Retrying the same record cannot help.
    when p_error_code = 'gmail_lifecycle_email_obsolete'
      and exists (select 1 from crm_private.lifecycle_email_snapshots snap where snap.email_message_id=v_job.email_message_id)
      and not crm_private.lifecycle_delivery_snapshot_current(v_job.email_message_id)
      then 'dead'::public.outbox_status
    when p_error_code = 'gmail_email_job_invalid' then 'dead'::public.outbox_status
    when v_attempt_count >= v_job.max_attempts then 'dead'::public.outbox_status
    else 'failed'::public.outbox_status
  end;

  update public.integration_outbox o
  set status = v_status,
      attempt_count = v_attempt_count,
      next_attempt_at = case
        when p_succeeded or v_status = 'dead'::public.outbox_status then o.next_attempt_at
        else now() + make_interval(secs => least((power(2, least(v_job.attempt_count, 7)) * 30)::integer, 3600))
      end,
      leased_by = null,
      leased_at = null,
      lease_expires_at = null,
      last_error_code = case when p_succeeded then null else p_error_code end,
      updated_at = now()
  where o.id = p_outbox_id;

  if p_succeeded then
    update public.email_messages m
    set status = 'sent'::public.email_message_status,
        sent_at = coalesce(m.sent_at, now()),
        failed_at = null,
        provider = 'google_gmail',
        provider_message_id = coalesce(m.provider_message_id, v_provider_message_id),
        error_code = null,
        updated_at = now()
    where m.id = v_job.email_message_id and m.artist_id = v_job.artist_id;
  elsif v_status = 'dead'::public.outbox_status
        and p_error_code = 'gmail_lifecycle_email_obsolete'
        and exists (select 1 from crm_private.lifecycle_email_snapshots snap where snap.email_message_id=v_job.email_message_id)
      and not crm_private.lifecycle_delivery_snapshot_current(v_job.email_message_id) then
    update public.email_messages m
    set status = 'cancelled'::public.email_message_status,
        error_code = p_error_code,
        updated_at = now()
    where m.id = v_job.email_message_id and m.artist_id = v_job.artist_id;
  elsif v_status = 'dead'::public.outbox_status then
    update public.email_messages m
    set status = 'failed'::public.email_message_status,
        failed_at = now(),
        error_code = p_error_code,
        updated_at = now()
    where m.id = v_job.email_message_id and m.artist_id = v_job.artist_id;
  end if;

  perform crm_private.log_activity(
    case when p_succeeded then 'outbox.succeeded' else 'outbox.failed' end,
    'worker', null,
    v_job.client_id, v_job.enquiry_id, v_job.project_id, v_job.session_id,
    null, null, null, p_outbox_id,
    jsonb_build_object(
      'channel', 'email',
      'provider', 'google_gmail',
      'attempt_count', v_attempt_count,
      'error_code', case when p_succeeded then null else p_error_code end,
      'worker_id', p_worker_id,
      'dead_letter', v_status = 'dead'::public.outbox_status
    )
  );

  return jsonb_build_object('outbox_id', p_outbox_id, 'status', v_status, 'attempt_count', v_attempt_count, 'changed', true);
end;
$function$
;

create function public.service_reserve_resend_correspondence(p_outbox_id uuid,p_worker_id text,p_payload_sha256 text)
returns jsonb language plpgsql security definer
set search_path to 'pg_catalog','public','crm_private'
as $function$
declare
  j public.integration_outbox%rowtype;
  m public.email_messages%rowtype;
  t record;
  a crm_private.resend_correspondence_attempts%rowtype;
begin
  if not crm_private.is_service_backend() then raise exception 'backend only' using errcode='42501'; end if;
  if coalesce(p_worker_id,'') !~ '^[a-z][a-z0-9_-]{2,127}$' or coalesce(p_payload_sha256,'') !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid reservation' using errcode='22023';
  end if;
  select * into strict j from public.integration_outbox where id=p_outbox_id for update;
  if j.kind<>'approved_email' or j.artist_id<>'a1111111-1111-4111-8111-111111111111'::uuid
    or j.status<>'leased' or j.leased_by is distinct from p_worker_id or j.lease_expires_at<=now()
    or j.attempt_count<>0 then raise exception 'invalid test lease' using errcode='42501'; end if;
  select * into strict m from public.email_messages where id=j.email_message_id and artist_id=j.artist_id for update;
  select * into strict t from public.service_resolve_gmail_outbox_target(j.id,p_worker_id);
  if t.delivery_allowed is distinct from true or t.artist_id is distinct from j.artist_id
    or t.email_message_id is distinct from m.id or t.client_id is distinct from j.client_id
    or t.integration_key is distinct from 'google_gmail_vladimir' or t.mailbox_email is distinct from 'vvetrov41@gmail.com'
    or t.client_email is distinct from 'vvetrov41@gmail.com' or lower(btrim(m.to_email)) is distinct from t.client_email
    or m.status<>'approved' or m.created_by_kind<>'human' or m.approved_at is null or m.approved_by is null
    or m.gmail_thread_context_id is not null or m.booking_card_id is not null
    or m.automation_job_id is not null or m.payment_request_id is not null
    or coalesce(t.configuration->>'review_email','false')='true'
    or coalesce(t.configuration->>'booking_card_reply_in_existing_thread','false')='true'
    or m.subject not like '[Resend owner test] %' then
      raise exception 'owner-only test scope denied' using errcode='42501';
  end if;
  insert into crm_private.resend_correspondence_attempts(email_message_id,outbox_id,artist_id,recipient,payload_sha256)
    values(m.id,j.id,j.artist_id,t.client_email,p_payload_sha256)
    on conflict(email_message_id) do nothing returning * into a;
  -- Never dispatch on any repeated reservation, including a lost RPC response.
  if not found then return jsonb_build_object('reserved',false); end if;
  return jsonb_build_object('reserved',true,'email_message_id',a.email_message_id,'prepared_at',a.prepared_at);
end;
$function$;
revoke all on function public.service_reserve_resend_correspondence(uuid,text,text) from public,anon,authenticated;
grant execute on function public.service_reserve_resend_correspondence(uuid,text,text) to service_role;

create function public.service_record_resend_correspondence(p_outbox_id uuid,p_worker_id text,p_payload_sha256 text,p_state text,p_provider_message_id uuid default null)
returns jsonb language plpgsql security definer
set search_path to 'pg_catalog','public','crm_private'
as $function$
declare
  j public.integration_outbox%rowtype;
  a crm_private.resend_correspondence_attempts%rowtype;
  m public.email_messages%rowtype;
  code text;
begin
  if not crm_private.is_service_backend() then raise exception 'backend only' using errcode='42501'; end if;
  if p_state is null or p_state not in ('accepted','rejected','uncertain') or
    (p_state='accepted') is distinct from (p_provider_message_id is not null) then
    raise exception 'invalid Resend receipt' using errcode='22023';
  end if;
  select * into strict j from public.integration_outbox where id=p_outbox_id for update;
  select * into strict a from crm_private.resend_correspondence_attempts where outbox_id=j.id for update;
  if a.artist_id is distinct from j.artist_id or a.email_message_id is distinct from j.email_message_id
    or a.payload_sha256 is distinct from p_payload_sha256 then raise exception 'Resend receipt scope mismatch' using errcode='42501'; end if;
  if a.state=p_state and a.provider_message_id is not distinct from p_provider_message_id then
    return jsonb_build_object('state',a.state,'changed',false);
  end if;
  if a.state<>'prepared' or j.status<>'leased' or j.leased_by is distinct from p_worker_id then
    raise exception 'Resend receipt lease mismatch' using errcode='42501';
  end if;
  select * into strict m from public.email_messages where id=a.email_message_id and artist_id=a.artist_id for update;
  if m.status<>'approved' or m.provider_message_id is not null then raise exception 'message changed' using errcode='42501'; end if;
  code:=case when p_state='accepted' then null when p_state='uncertain' then 'resend_correspondence_uncertain' else 'resend_correspondence_rejected' end;
  update crm_private.resend_correspondence_attempts set state=p_state,provider_message_id=p_provider_message_id,
    accepted_at=case when p_state='accepted' then now() else null end,updated_at=now() where email_message_id=a.email_message_id;
  update public.integration_outbox set status=case when p_state='accepted' then 'succeeded'::public.outbox_status else 'dead'::public.outbox_status end,
    attempt_count=attempt_count+1,leased_by=null,leased_at=null,lease_expires_at=null,last_error_code=code,updated_at=now() where id=j.id;
  update public.email_messages set status=case when p_state='accepted' then 'sent'::public.email_message_status else 'failed'::public.email_message_status end,
    provider=case when p_state='accepted' then 'resend' else null end,provider_message_id=p_provider_message_id::text,
    sent_at=case when p_state='accepted' then now() else null end,failed_at=case when p_state='accepted' then null else now() end,
    error_code=code,updated_at=now() where id=m.id;
  perform crm_private.log_activity(case when p_state='accepted' then 'outbox.succeeded' else 'outbox.failed' end,
    'worker',null,j.client_id,j.enquiry_id,j.project_id,j.session_id,null,null,null,j.id,
    jsonb_build_object('channel','email','provider','resend','attempt_count',j.attempt_count+1,'error_code',code,'worker_id',p_worker_id,'dead_letter',p_state<>'accepted'));
  return jsonb_build_object('state',p_state,'changed',true);
end;
$function$;
revoke all on function public.service_record_resend_correspondence(uuid,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.service_record_resend_correspondence(uuid,text,text,text,uuid) to service_role;
