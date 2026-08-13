-- 0022_artist_workflow_lint_fix.sql
--
-- Explicit enum casts required by plpgsql_check for provider payment state.
-- No behavioural or routing change.

create or replace function public.record_provider_payment(
  p_payment_webhook_event_id uuid,
  p_payment_request_id uuid,
  p_idempotency_key uuid,
  p_provider_transaction_id text,
  p_amount numeric,
  p_succeeded boolean,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_event public.payment_webhook_events%rowtype;
  v_request public.payment_requests%rowtype;
  v_existing public.payment_transactions%rowtype;
  v_transaction_id uuid;
  v_status public.payment_transaction_status;
begin
  if not crm_private.is_service_backend() then
    raise exception 'provider payment recording is backend-only'
      using errcode = '42501';
  end if;

  select * into v_event
  from public.payment_webhook_events e
  where e.id = p_payment_webhook_event_id
  for update;
  if not found then
    raise exception 'payment webhook event % does not exist', p_payment_webhook_event_id
      using errcode = '23503';
  end if;

  select * into v_request
  from public.payment_requests r
  where r.id = p_payment_request_id;
  if not found then
    raise exception 'payment request % does not exist', p_payment_request_id
      using errcode = '23503';
  end if;

  if v_event.artist_id <> v_request.artist_id
     or v_event.provider <> v_request.provider
     or v_event.provider_account_key <> v_request.provider_account_key then
    raise exception 'webhook event and payment request belong to different payment routes'
      using errcode = '23514';
  end if;

  v_status := case
    when p_succeeded then 'succeeded'::public.payment_transaction_status
    else 'failed'::public.payment_transaction_status
  end;

  perform pg_advisory_xact_lock(
    hashtextextended('payment-transaction:' || p_idempotency_key::text, 0)
  );

  select * into v_existing
  from public.payment_transactions t
  where t.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.payment_request_id <> p_payment_request_id
       or v_existing.webhook_event_id <> p_payment_webhook_event_id
       or v_existing.provider_transaction_id <> p_provider_transaction_id
       or v_existing.amount <> p_amount
       or v_existing.status <> v_status
       or v_existing.occurred_at <> p_occurred_at then
      raise exception 'provider transaction idempotency key was reused with different terms'
        using errcode = '22023';
    end if;

    return jsonb_build_object(
      'payment_transaction_id', v_existing.id,
      'payment_request_id', p_payment_request_id,
      'replayed', true
    );
  end if;

  insert into public.payment_transactions (
    idempotency_key, payment_request_id, artist_id,
    transaction_type, direction, amount, currency, status,
    provider, provider_transaction_id, webhook_event_id,
    occurred_at, recorded_by, recorded_by_kind
  ) values (
    p_idempotency_key, p_payment_request_id, v_request.artist_id,
    'payment', 'credit', p_amount, v_request.currency, v_status,
    v_event.provider, p_provider_transaction_id, v_event.id,
    p_occurred_at, null, 'webhook'
  )
  returning id into v_transaction_id;

  update public.payment_webhook_events
  set processing_status = case
        when p_succeeded then 'succeeded'::public.payment_webhook_processing_status
        else 'failed'::public.payment_webhook_processing_status
      end,
      processed_at = now(),
      safe_error_code = case
        when p_succeeded then null
        else 'provider_payment_failed'
      end
  where id = v_event.id;

  perform crm_private.log_artist_activity(
    v_request.artist_id,
    case
      when p_succeeded then 'payment.provider_recorded'
      else 'payment.provider_failed'
    end,
    'worker',
    null,
    v_request.client_id, null, v_request.project_id, v_request.session_id, null,
    jsonb_build_object(
      'provider', v_event.provider,
      'currency', v_request.currency
    )
  );

  return jsonb_build_object(
    'payment_transaction_id', v_transaction_id,
    'payment_request_id', p_payment_request_id,
    'replayed', false
  );
end;
$$;

revoke all on function public.record_provider_payment(uuid,uuid,uuid,text,numeric,boolean,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.record_provider_payment(uuid,uuid,uuid,text,numeric,boolean,timestamptz)
  to service_role;
