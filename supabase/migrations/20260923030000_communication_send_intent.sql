-- 20260923030000_communication_send_intent.sql
--
-- Audit M-2 (2026-09-22). WhatsApp and Instagram have no provider-side
-- idempotency key. If Meta accepts a message and the Worker then fails to
-- record the result, the lease expires and the next attempt sends the same
-- message to the client again.
--
-- The Worker now records a durable send intent immediately before it calls
-- the provider. A job that comes back with an intent but no recorded result
-- is ambiguous - the message may or may not have reached the client - so it
-- is never resent automatically: it is dead-lettered as
-- communication_send_result_unknown, which the operational failure alert
-- (H-5) reports to the owner, who can check the conversation and resend.
-- An explicit provider failure clears the intent and keeps the ordinary
-- bounded retry, so a legitimate retry is never suppressed.

alter table public.integration_outbox
  add column provider_send_started_at timestamptz;

comment on column public.integration_outbox.provider_send_started_at is
  'Set immediately before a WhatsApp/Instagram provider call; cleared by an explicit failure. Present without a result means the send outcome is unknown.';

create function public.service_begin_communication_send(
  p_outbox_id uuid,
  p_worker_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.integration_outbox%rowtype;
begin
  if not crm_private.is_service_backend() then
    raise exception 'communication send intent is backend-only' using errcode = '42501';
  end if;

  select o.* into v_job
  from public.integration_outbox o
  where o.id = p_outbox_id
    and o.kind in ('whatsapp_message'::public.outbox_kind, 'instagram_message'::public.outbox_kind)
  for update;
  if not found then
    raise exception 'communication outbox job is unavailable' using errcode = '22023';
  end if;
  if v_job.status <> 'leased'::public.outbox_status or v_job.leased_by is distinct from p_worker_id then
    raise exception 'communication outbox lease is not owned by this worker' using errcode = '42501';
  end if;

  if v_job.provider_send_started_at is not null then
    return jsonb_build_object('proceed', false, 'reason', 'send_result_unknown');
  end if;

  update public.integration_outbox o
  set provider_send_started_at = now(), updated_at = now()
  where o.id = p_outbox_id;
  return jsonb_build_object('proceed', true);
end;
$$;

revoke all on function public.service_begin_communication_send(uuid, text) from public, anon, authenticated;
grant execute on function public.service_begin_communication_send(uuid, text) to service_role;

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
