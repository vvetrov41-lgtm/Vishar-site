-- A definitive WhatsApp refusal is terminal on its first report.
--
-- Technical audit, 2026-11-11. public.record_communication_outbox_result
-- decided retry-versus-dead-letter by attempt count alone, so a request Meta
-- refuses with a 4xx (`whatsapp_rejected`) was replayed unchanged until
-- max_attempts. Production evidence: the consultation reminder queued at
-- 2026-11-07 10:00:12 UTC was refused eight times (10:00, 10:05, 10:10, 10:15,
-- 10:20, 10:30, 10:50, 11:25) and only then dead-lettered, which is also the
-- moment crm_private.lifecycle_whatsapp_terminal_email_fallback could hand the
-- reminder to email. The operator alert and the CRM "failed" state waited the
-- same 85 minutes.
--
-- The four codes below are deterministic for one job: Meta's explicit refusal
-- of this request, and the Worker's own refusal to build it (invalid
-- destination, body or template shape). They never mean the provider may have
-- accepted the message, so no duplicate can follow from stopping early.
-- Everything else is unchanged: `whatsapp_provider_unavailable`,
-- `whatsapp_unreachable`, `whatsapp_rate_limited`,
-- `whatsapp_credentials_rejected`, `whatsapp_response_invalid` and database
-- errors keep the existing backoff; Instagram jobs are not affected.
--
-- The body is the 20261030175000 definition with one added branch.

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
    -- Meta refused this exact request, or the Worker refused to build it. The
    -- same job cannot succeed on a later attempt, so it is dead-lettered now
    -- rather than replayed until max_attempts: production replayed one
    -- refused consultation reminder eight times over 85 minutes on 2026-11-07
    -- before the client's email fallback could start. Timeouts, 5xx, rate
    -- limits and credential refusals keep their retry budget.
    when v_job.kind = 'whatsapp_message'::public.outbox_kind
      and p_error_code in (
        'whatsapp_rejected',
        'whatsapp_destination_invalid',
        'whatsapp_message_invalid',
        'whatsapp_template_invalid'
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
