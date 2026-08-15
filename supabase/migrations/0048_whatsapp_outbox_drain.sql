-- 0048_whatsapp_outbox_drain.sql
--
-- Backend-only lease, claim and acknowledgement for the WhatsApp outbox,
-- mirroring the Telegram drain in migrations 0035 and 0036.
--
-- The claim projection differs from Telegram's in one deliberate way: it
-- returns the message body and the contact's WhatsApp id. A WhatsApp message
-- cannot be delivered without them, so withholding them would only move the
-- lookup somewhere less controlled. The boundary is kept elsewhere instead —
-- the durable payload carries an identifier only, the activity trail records
-- neither value, and the Worker logger allow-list still refuses both.
--
-- Both fields are recomputed from the authoritative conversation and message
-- rows at claim time rather than trusted from the queued job, so a mutated
-- outbox row cannot redirect a message to a different number.
--
-- Forward-only. No provider call, no credential, no cron, no deployment.

-- ---------------------------------------------------------------------------
-- Batched claim
-- ---------------------------------------------------------------------------

create or replace function public.claim_whatsapp_outbox(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  outbox_id uuid,
  artist_id uuid,
  kind public.outbox_kind,
  whatsapp_message_id uuid,
  conversation_id uuid,
  integration_key text,
  contact_wa_id text,
  body text,
  attempt_count integer,
  max_attempts integer,
  job_valid boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_lease_seconds integer;
  v_limit integer;
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp outbox claiming is backend-only'
      using errcode = '42501';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'a safe worker id is required' using errcode = '22023';
  end if;

  v_limit := coalesce(p_limit, 10);
  if v_limit < 1 or v_limit > 20 then
    raise exception 'the claim batch must be between 1 and 20' using errcode = '22023';
  end if;

  v_lease_seconds := coalesce(p_lease_seconds, 120);
  if v_lease_seconds < 30 or v_lease_seconds > 600 then
    raise exception 'the lease must be between 30 and 600 seconds' using errcode = '22023';
  end if;

  return query
  with candidates as (
    select o.id
    from public.integration_outbox o
    join crm_private.outbox_drain_rollouts r
      on r.kind = o.kind
    where o.kind = 'whatsapp_message'::public.outbox_kind
      and o.created_at >= r.automatic_after
      and o.attempt_count < o.max_attempts
      and (
        (o.status in ('pending'::public.outbox_status, 'failed'::public.outbox_status)
          and o.next_attempt_at <= now())
        or (o.status = 'leased'::public.outbox_status and o.lease_expires_at <= now())
      )
    order by o.next_attempt_at, o.created_at, o.id
    for update of o skip locked
    limit v_limit
  ),
  leased as (
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
    l.id,
    l.artist_id,
    l.kind,
    l.whatsapp_message_id,
    m.conversation_id,
    conv.integration_key,
    conv.contact_wa_id,
    m.body,
    l.attempt_count,
    l.max_attempts,
    (
      m.id is not null
      and m.artist_id = l.artist_id
      and conv.artist_id = l.artist_id
      and m.direction = 'outbound'::public.whatsapp_message_direction
      and m.origin in ('crm'::public.whatsapp_message_origin,
                       'automation'::public.whatsapp_message_origin)
      and m.status = 'queued'::public.whatsapp_message_status
      and m.body is not null
      and btrim(m.body) <> ''
      and exists (
        select 1
        from public.artist_integrations i
        where i.artist_id = l.artist_id
          and i.integration_type = 'whatsapp'::public.artist_integration_type
          and i.integration_key = conv.integration_key
          and i.is_enabled
      )
    ) as job_valid
  from leased l
  left join public.whatsapp_messages m on m.id = l.whatsapp_message_id
  left join public.whatsapp_conversations conv on conv.id = m.conversation_id
  order by l.next_attempt_at, l.created_at, l.id;
end;
$$;

revoke all on function public.claim_whatsapp_outbox(text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_whatsapp_outbox(text, integer, integer)
  to service_role;

comment on function public.claim_whatsapp_outbox(text, integer, integer) is
  'Backend-only bounded lease for due WhatsApp jobs. Returns the destination and body required to deliver, recomputed from authoritative rows, and no provider credential.';

-- ---------------------------------------------------------------------------
-- Exact-id claim
-- ---------------------------------------------------------------------------

create or replace function public.claim_whatsapp_outbox_by_id(
  p_outbox_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 120
)
returns table (
  outbox_id uuid,
  artist_id uuid,
  kind public.outbox_kind,
  whatsapp_message_id uuid,
  conversation_id uuid,
  integration_key text,
  contact_wa_id text,
  body text,
  attempt_count integer,
  max_attempts integer,
  job_valid boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_lease_seconds integer;
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp outbox claiming is backend-only'
      using errcode = '42501';
  end if;
  if p_outbox_id is null then
    raise exception 'an outbox id is required' using errcode = '22023';
  end if;
  if coalesce(p_worker_id, '') !~ '^[a-z][a-z0-9_-]{2,127}$' then
    raise exception 'a safe worker id is required' using errcode = '22023';
  end if;

  v_lease_seconds := coalesce(p_lease_seconds, 120);
  if v_lease_seconds < 30 or v_lease_seconds > 600 then
    raise exception 'the lease must be between 30 and 600 seconds' using errcode = '22023';
  end if;

  return query
  with candidate as (
    select o.id
    from public.integration_outbox o
    where o.id = p_outbox_id
      and o.kind = 'whatsapp_message'::public.outbox_kind
      and (
        (o.status in ('pending'::public.outbox_status, 'failed'::public.outbox_status)
          and o.next_attempt_at <= now())
        or (o.status = 'leased'::public.outbox_status and o.lease_expires_at <= now())
      )
    for update of o skip locked
  ),
  leased as (
    update public.integration_outbox o
    set status = 'leased'::public.outbox_status,
        leased_by = p_worker_id,
        leased_at = now(),
        lease_expires_at = now() + make_interval(secs => v_lease_seconds),
        updated_at = now()
    from candidate c
    where o.id = c.id
    returning o.*
  )
  select
    l.id,
    l.artist_id,
    l.kind,
    l.whatsapp_message_id,
    m.conversation_id,
    conv.integration_key,
    conv.contact_wa_id,
    m.body,
    l.attempt_count,
    l.max_attempts,
    (
      m.id is not null
      and m.artist_id = l.artist_id
      and conv.artist_id = l.artist_id
      and m.direction = 'outbound'::public.whatsapp_message_direction
      and m.origin in ('crm'::public.whatsapp_message_origin,
                       'automation'::public.whatsapp_message_origin)
      and m.status = 'queued'::public.whatsapp_message_status
      and m.body is not null
      and btrim(m.body) <> ''
      and exists (
        select 1
        from public.artist_integrations i
        where i.artist_id = l.artist_id
          and i.integration_type = 'whatsapp'::public.artist_integration_type
          and i.integration_key = conv.integration_key
          and i.is_enabled
      )
    ) as job_valid
  from leased l
  left join public.whatsapp_messages m on m.id = l.whatsapp_message_id
  left join public.whatsapp_conversations conv on conv.id = m.conversation_id;
end;
$$;

revoke all on function public.claim_whatsapp_outbox_by_id(uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_whatsapp_outbox_by_id(uuid, text, integer)
  to service_role;

comment on function public.claim_whatsapp_outbox_by_id(uuid, text, integer) is
  'Backend-only atomic lease for one explicit due WhatsApp job. Returns no provider credential.';

-- ---------------------------------------------------------------------------
-- Acknowledgement
-- ---------------------------------------------------------------------------

create or replace function public.record_whatsapp_outbox_result(
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
as $$
declare
  v_job public.integration_outbox%rowtype;
  v_status public.outbox_status;
  v_attempt_count integer;
  v_provider_message_id text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'WhatsApp outbox acknowledgement is backend-only'
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
    raise exception 'failed WhatsApp result requires a safe machine error code'
      using errcode = '22023';
  end if;

  v_provider_message_id := nullif(btrim(coalesce(p_provider_message_id, '')), '');
  if p_succeeded and v_provider_message_id is null then
    raise exception 'a successful WhatsApp send must report a provider message id'
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
    and o.kind = 'whatsapp_message'::public.outbox_kind
  for update;
  if not found then
    raise exception 'WhatsApp outbox job is unavailable' using errcode = '22023';
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
      raise exception 'WhatsApp outbox lease is not owned by this worker'
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
    raise exception 'WhatsApp outbox lease is not owned by this worker'
      using errcode = '42501';
  end if;

  v_attempt_count := v_job.attempt_count + 1;
  v_status := case
    when p_succeeded then 'succeeded'::public.outbox_status
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
      updated_at = now()
  where o.id = p_outbox_id;

  -- The message row follows the job. A retryable failure leaves the message
  -- queued; only a terminal failure marks it failed in the CRM timeline.
  if p_succeeded then
    update public.whatsapp_messages m
    set status = 'sent'::public.whatsapp_message_status,
        provider_message_id = coalesce(m.provider_message_id, v_provider_message_id),
        error_code = null,
        updated_at = now()
    where m.id = v_job.whatsapp_message_id;
  elsif v_status = 'dead'::public.outbox_status then
    update public.whatsapp_messages m
    set status = 'failed'::public.whatsapp_message_status,
        failed_at = now(),
        error_code = p_error_code,
        updated_at = now()
    where m.id = v_job.whatsapp_message_id;
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
$$;

revoke all on function public.record_whatsapp_outbox_result(uuid, text, boolean, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_whatsapp_outbox_result(uuid, text, boolean, text, text)
  to service_role;

comment on function public.record_whatsapp_outbox_result(uuid, text, boolean, text, text) is
  'Backend-only lease-owned WhatsApp acknowledgement with bounded retry, dead-lettering and no contact or message content in the audit trail.';
