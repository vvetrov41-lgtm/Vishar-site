-- Resolve approved email delivery through its owned lease. Deposit messages
-- intentionally have no enquiry and must use payment -> project ownership.
-- No queue is drained or customer record changed by this migration.

create or replace function crm_private.gmail_deposit_email_obsolete(p_email_message_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1 from public.email_messages m
    join public.payment_requests r on r.id = m.payment_request_id
    where m.id = p_email_message_id and r.purpose = 'deposit'
      and m.artist_id = r.artist_id and m.client_id = r.client_id
      and m.project_id = r.project_id
      and ((m.template_key = 'deposit_request' and r.status not in ('pending', 'partially_paid'))
        or (m.template_key = 'deposit_confirmation' and r.status <> 'paid'))
  );
$$;
revoke all on function crm_private.gmail_deposit_email_obsolete(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.service_resolve_gmail_outbox_target(
  p_outbox_id uuid, p_worker_id text
)
returns table (
  outbox_id uuid, email_message_id uuid, artist_id uuid, enquiry_id uuid,
  client_id uuid, client_email text, integration_key text, mailbox_email text,
  configuration jsonb, delivery_allowed boolean
)
language plpgsql stable security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.integration_outbox%rowtype;
  v_message public.email_messages%rowtype;
  v_client_email text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Gmail outbox target resolution is backend-only' using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'a safe worker id is required' using errcode = '22023';
  end if;

  select o.* into v_job from public.integration_outbox o
  where o.id = p_outbox_id and o.kind = 'approved_email'::public.outbox_kind
    and o.status = 'leased'::public.outbox_status and o.leased_by = p_worker_id
    and o.lease_expires_at > now();
  if not found then
    raise exception 'email outbox lease is not owned by this worker' using errcode = '42501';
  end if;

  select m.* into v_message from public.email_messages m
  where m.id = v_job.email_message_id and m.status = 'approved'::public.email_message_status
    and m.artist_id = v_job.artist_id and m.client_id = v_job.client_id
    and m.enquiry_id is not distinct from v_job.enquiry_id
    and m.project_id is not distinct from v_job.project_id
    and m.sent_at is null and m.provider_message_id is null;
  if not found then
    raise exception 'Gmail CRM target is unavailable' using errcode = '22023';
  end if;
  select lower(btrim(c.email)) into v_client_email from public.clients c
  where c.id = v_job.client_id;
  if nullif(v_client_email, '') is null
     or v_client_email is distinct from lower(btrim(v_message.to_email)) then
    raise exception 'Gmail CRM target is unavailable' using errcode = '22023';
  end if;

  if v_message.payment_request_id is null then
    -- Existing enquiry/GPT routing remains authoritative for non-payment mail.
    return query
    select v_job.id, v_message.id, t.artist_id, t.enquiry_id, t.client_id,
      t.client_email, t.integration_key, t.mailbox_email, t.configuration, true
    from public.service_resolve_gmail_target(v_job.artist_id, v_job.enquiry_id, v_job.client_id) t;
    return;
  end if;

  if v_job.enquiry_id is not null or v_message.gmail_thread_context_id is not null
     or v_message.created_by_kind is distinct from 'system' or v_message.automation_job_id is not null
     or coalesce(v_message.template_key, '') not in ('deposit_request', 'deposit_confirmation')
     or not exists (
       select 1 from public.payment_requests r
       join public.projects p on p.id = r.project_id
       where r.id = v_message.payment_request_id and r.purpose = 'deposit'
         and r.artist_id = v_job.artist_id and r.client_id = v_job.client_id
         and r.project_id = v_job.project_id
         and r.session_id is not distinct from v_job.session_id
         and p.artist_id = r.artist_id and p.client_id = r.client_id
     )
     or crm_private.client_send_block_reason(v_job.client_id, 'email', 'service') is not null then
    raise exception 'Gmail CRM target is unavailable' using errcode = '22023';
  end if;

  return query
  select v_job.id, v_message.id, v_job.artist_id, v_job.enquiry_id, v_job.client_id,
    v_client_email, i.integration_key, lower(btrim(i.external_account_label)), i.configuration,
    not crm_private.gmail_deposit_email_obsolete(v_message.id)
  from public.artist_integrations i
  join crm_private.artist_state s on s.artist_id = i.artist_id and s.is_active
  where i.artist_id = v_job.artist_id and i.integration_type = 'email'::public.artist_integration_type
    and i.provider = 'google' and i.is_enabled
    and nullif(btrim(i.external_account_label), '') is not null;
  if not found then
    raise exception 'artist Gmail integration is unavailable' using errcode = '22023';
  end if;
end;
$$;
revoke all on function public.service_resolve_gmail_outbox_target(uuid, text)
  from public, anon, authenticated;
grant execute on function public.service_resolve_gmail_outbox_target(uuid, text) to service_role;

-- Preserve lease ownership, deterministic provider-id acknowledgement and retry
-- semantics; only a DB-confirmed obsolete deposit email ends without retry.
create or replace function public.record_email_outbox_result(
  p_outbox_id uuid,
  p_worker_id text,
  p_succeeded boolean,
  p_provider_message_id text default null,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
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
$function$;
