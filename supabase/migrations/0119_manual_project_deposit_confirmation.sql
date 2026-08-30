-- 0119_manual_project_deposit_confirmation.sql
--
-- Allow an authorised finance operator to confirm a project deposit without
-- matching a provider transaction. The immutable ledger remains authoritative:
-- manual confirmation creates (when needed) a provider-neutral payment request
-- and a human-authored manual_payment transaction. It never creates a payment
-- link, provider transaction id, webhook event or Monzo reconciliation match.

create or replace function public.confirm_project_deposit_manually(
  p_project_id uuid,
  p_idempotency_key uuid,
  p_occurred_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_project public.projects%rowtype;
  v_deposit record;
  v_request public.payment_requests%rowtype;
  v_existing_transaction public.payment_transactions%rowtype;
  v_transaction_result jsonb;
  v_outstanding numeric(12,2);
  v_request_created boolean := false;
begin
  if p_project_id is null or p_idempotency_key is null then
    raise exception 'project and idempotency key are required'
      using errcode = '22023';
  end if;

  if p_occurred_at is null then
    raise exception 'payment occurrence time is required'
      using errcode = '22023';
  end if;

  select * into v_project
  from public.projects p
  where p.id = p_project_id
  for update;

  if not found then
    raise exception 'project % does not exist', p_project_id
      using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_project.artist_id, 'manage_finance');
  perform crm_private.require_active_artist(v_project.artist_id);

  if v_project.archived_at is not null or v_project.status = 'cancelled' then
    raise exception 'a deposit cannot be confirmed for a closed project'
      using errcode = '22023';
  end if;

  if v_project.deposit_status = 'not_required'
     and v_project.deposit_amount = 0 then
    raise exception 'this project is explicitly marked as not requiring a deposit'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('project-deposit:' || p_project_id::text, 0)
  );

  -- The transaction idempotency key is the public operation idempotency key.
  -- A successful replay therefore returns the original manual settlement and
  -- can never insert another credit.
  select t.* into v_existing_transaction
  from public.payment_transactions t
  where t.idempotency_key = p_idempotency_key;

  if found then
    select * into v_request
    from public.payment_requests r
    where r.id = v_existing_transaction.payment_request_id;

    if not found
       or v_request.project_id is distinct from p_project_id
       or v_request.session_id is not null
       or v_request.purpose <> 'deposit'
       or v_existing_transaction.transaction_type <> 'manual_payment'
       or v_existing_transaction.direction <> 'credit'
       or v_existing_transaction.status <> 'succeeded' then
      raise exception 'manual deposit idempotency key was reused with different terms'
        using errcode = '22023';
    end if;

    return jsonb_build_object(
      'payment_request_id', v_request.id,
      'payment_transaction_id', v_existing_transaction.id,
      'amount', v_request.amount,
      'manually_recorded', v_existing_transaction.amount,
      'currency', v_request.currency,
      'request_created', v_request.provider is null,
      'already_paid', true,
      'replayed', true
    );
  end if;

  -- Prefer an existing project-level deposit request. This covers the common
  -- case where a Monzo link was already sent but the operator independently
  -- verified receipt by another route. Only the remaining balance is recorded
  -- manually, so partial provider settlements can never be double-counted.
  select * into v_request
  from public.payment_requests r
  where r.project_id = p_project_id
    and r.session_id is null
    and r.purpose = 'deposit'
    and r.status in ('pending', 'partially_paid', 'paid')
  order by r.created_at desc
  limit 1;

  if found and v_request.status = 'paid' then
    return jsonb_build_object(
      'payment_request_id', v_request.id,
      'payment_transaction_id', null,
      'amount', v_request.amount,
      'manually_recorded', 0,
      'currency', v_request.currency,
      'request_created', false,
      'already_paid', true,
      'replayed', false
    );
  end if;

  if not found then
    if exists (
      select 1
      from public.payment_requests r
      where r.idempotency_key = p_idempotency_key
    ) then
      raise exception 'manual deposit idempotency key was reused by another payment request'
        using errcode = '22023';
    end if;

    -- The caller never supplies the amount. Keep the same immutable project
    -- pricing snapshot as the ordinary deposit-request workflow, but deliberately
    -- leave provider/provider_account_key NULL and create no payment link.
    select * into v_deposit
    from crm_private.resolve_project_deposit(p_project_id);

    insert into public.payment_requests (
      idempotency_key,
      artist_id,
      client_id,
      project_id,
      session_id,
      purpose,
      amount,
      currency,
      status,
      provider,
      provider_account_key,
      policy_snapshot,
      created_by
    ) values (
      p_idempotency_key,
      v_deposit.artist_id,
      v_deposit.client_id,
      p_project_id,
      null,
      'deposit',
      v_deposit.amount,
      v_deposit.currency,
      'pending',
      null,
      null,
      jsonb_build_object(
        'workflow', 'manual_project_deposit_confirmation',
        'provider_neutral', true
      ),
      auth.uid()
    )
    returning * into v_request;

    insert into public.project_deposit_requests (
      payment_request_id,
      artist_id,
      client_id,
      project_id,
      policy_id,
      policy_version,
      mode,
      fixed_amount,
      percentage,
      minimum_amount,
      rounding_step,
      estimate_total,
      suggested_amount,
      override_amount,
      amount,
      currency,
      created_by
    ) values (
      v_request.id,
      v_deposit.artist_id,
      v_deposit.client_id,
      p_project_id,
      v_deposit.policy_id,
      v_deposit.policy_version,
      v_deposit.mode,
      v_deposit.fixed_amount,
      v_deposit.percentage,
      v_deposit.minimum_amount,
      v_deposit.rounding_step,
      v_deposit.estimate_total,
      v_deposit.suggested_amount,
      v_deposit.override_amount,
      v_deposit.amount,
      v_deposit.currency,
      auth.uid()
    );

    v_request_created := true;
  end if;

  v_outstanding := round(
    v_request.amount - crm_private.payment_request_net_paid(v_request.id),
    2
  );

  if v_outstanding <= 0 then
    raise exception 'the project deposit has no outstanding balance to confirm'
      using errcode = '22023';
  end if;

  v_transaction_result := public.record_manual_payment(
    v_request.id,
    p_idempotency_key,
    v_outstanding,
    p_occurred_at,
    'crm_manual_project_deposit'
  );

  perform crm_private.log_artist_activity(
    v_request.artist_id,
    'payment.project_deposit_manually_confirmed',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_request.client_id,
    null,
    p_project_id,
    null,
    null,
    jsonb_build_object(
      'payment_request_id', v_request.id,
      'payment_transaction_id', v_transaction_result ->> 'payment_transaction_id',
      'request_created', v_request_created,
      'currency', v_request.currency
    )
  );

  return jsonb_build_object(
    'payment_request_id', v_request.id,
    'payment_transaction_id', v_transaction_result ->> 'payment_transaction_id',
    'amount', v_request.amount,
    'manually_recorded', v_outstanding,
    'currency', v_request.currency,
    'request_created', v_request_created,
    'already_paid', false,
    'replayed', false
  );
end;
$$;

revoke all on function public.confirm_project_deposit_manually(uuid,uuid,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.confirm_project_deposit_manually(uuid,uuid,timestamptz)
  to authenticated;

comment on function public.confirm_project_deposit_manually(uuid,uuid,timestamptz) is
  'Finance-scoped manual project-deposit confirmation. Creates provider-neutral immutable request evidence when needed, then records only a human-authored manual_payment credit. It creates no provider payment, payment link, webhook or reconciliation match.';
