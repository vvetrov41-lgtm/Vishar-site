-- 0058_monzo_reconciliation_crm_review.sql
--
-- Human review surface for independently verified Monzo reconciliation
-- candidates. Matching is non-financial. Only an explicit separate confirmation
-- writes one immutable provider-origin payment ledger row. No webhook or list
-- operation settles a payment request automatically.
--
-- Direct access to payment_reconciliation_candidates remains closed. Browser
-- callers receive only safe CRM context and never provider account, event or
-- transaction identifiers.
--
-- Forward-only.

-- ---------------------------------------------------------------------------
-- Private safe presentation helpers
-- ---------------------------------------------------------------------------

create or replace function crm_private.monzo_reconciliation_request_summary(
  p_payment_request_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select jsonb_build_object(
    'payment_request_id', r.id,
    'client_name', c.full_name,
    'purpose', r.purpose::text,
    'request_status', r.status::text,
    'amount', r.amount,
    'outstanding_amount', greatest(
      r.amount - crm_private.payment_request_net_paid(r.id), 0::numeric
    ),
    'currency', r.currency,
    'session_start_at', s.start_at,
    'session_end_at', s.end_at
  )
  from public.payment_requests r
  join public.clients c on c.id = r.client_id
  left join public.sessions s on s.id = r.session_id
  where r.id = p_payment_request_id;
$$;

create or replace function crm_private.monzo_reconciliation_match_options(
  p_candidate_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select coalesce(jsonb_agg(q.item order by q.sort_at desc, q.payment_request_id), '[]'::jsonb)
  from (
    select
      r.id as payment_request_id,
      coalesce(s.start_at, r.created_at) as sort_at,
      jsonb_build_object(
        'payment_request_id', r.id,
        'client_name', cl.full_name,
        'purpose', r.purpose::text,
        'request_status', r.status::text,
        'amount', r.amount,
        'outstanding_amount', greatest(
          r.amount - crm_private.payment_request_net_paid(r.id), 0::numeric
        ),
        'currency', r.currency,
        'session_start_at', s.start_at,
        'session_end_at', s.end_at,
        'is_suggested', r.id = c.suggested_payment_request_id,
        'is_matched', r.id = c.matched_payment_request_id
      ) as item
    from public.payment_reconciliation_candidates c
    join public.payment_requests r
      on r.artist_id = c.artist_id
     and r.provider = c.provider
     and r.provider_account_key = c.provider_account_key
     and r.currency = c.currency
    join public.clients cl on cl.id = r.client_id
    left join public.sessions s on s.id = r.session_id
    where c.id = p_candidate_id
      and c.provider = 'monzo_easy_bank_transfer'
      and r.purpose = 'deposit'
      and r.status in ('pending', 'partially_paid')
      and greatest(r.amount - crm_private.payment_request_net_paid(r.id), 0::numeric) = c.amount
      and (r.expires_at is null or r.expires_at > c.occurred_at)
    order by coalesce(s.start_at, r.created_at) desc, r.id
    limit 25
  ) q;
$$;

revoke all on function crm_private.monzo_reconciliation_request_summary(uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.monzo_reconciliation_match_options(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Finance-scoped safe candidate list
-- ---------------------------------------------------------------------------

create or replace function public.list_monzo_reconciliation_candidates(
  p_artist_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_result jsonb;
begin
  perform crm_private.require_artist_access(p_artist_id, 'view_finance');

  select coalesce(jsonb_agg(q.item order by q.sort_rank, q.occurred_at desc), '[]'::jsonb)
  into v_result
  from (
    select
      c.occurred_at,
      case
        when exists (
          select 1
          from public.payment_transactions t
          where t.provider = c.provider
            and t.provider_transaction_id = c.provider_transaction_id
            and t.status = 'succeeded'
        ) then 0
        when c.status = 'matched' then 1
        when c.status = 'candidate' then 2
        when c.status = 'ambiguous' then 3
        when c.status = 'unmatched' then 4
        else 5
      end as sort_rank,
      jsonb_build_object(
        'id', c.id,
        'amount', c.amount,
        'currency', c.currency,
        'occurred_at', c.occurred_at,
        'status', c.status,
        'confirmed', exists (
          select 1
          from public.payment_transactions t
          where t.provider = c.provider
            and t.provider_transaction_id = c.provider_transaction_id
            and t.status = 'succeeded'
        ),
        'suggested_payment_request',
          crm_private.monzo_reconciliation_request_summary(c.suggested_payment_request_id),
        'matched_payment_request',
          crm_private.monzo_reconciliation_request_summary(c.matched_payment_request_id),
        'match_options',
          crm_private.monzo_reconciliation_match_options(c.id)
      ) as item
    from public.payment_reconciliation_candidates c
    where c.artist_id = p_artist_id
      and c.provider = 'monzo_easy_bank_transfer'
    order by
      case
        when exists (
          select 1
          from public.payment_transactions t
          where t.provider = c.provider
            and t.provider_transaction_id = c.provider_transaction_id
            and t.status = 'succeeded'
        ) then 0
        when c.status = 'matched' then 1
        when c.status = 'candidate' then 2
        when c.status = 'ambiguous' then 3
        when c.status = 'unmatched' then 4
        else 5
      end,
      c.occurred_at desc
    limit 50
  ) q;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Non-financial human matching
-- ---------------------------------------------------------------------------

create or replace function public.match_monzo_reconciliation_candidate(
  p_candidate_id uuid,
  p_payment_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_candidate public.payment_reconciliation_candidates%rowtype;
  v_request public.payment_requests%rowtype;
  v_outstanding numeric(12,2);
begin
  select * into v_candidate
  from public.payment_reconciliation_candidates c
  where c.id = p_candidate_id
  for update;
  if not found or v_candidate.provider <> 'monzo_easy_bank_transfer' then
    raise exception 'Monzo reconciliation candidate does not exist'
      using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_candidate.artist_id, 'manage_finance');

  if v_candidate.status = 'ignored' then
    raise exception 'ignored reconciliation candidate cannot be matched'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.payment_transactions t
    where t.provider = v_candidate.provider
      and t.provider_transaction_id = v_candidate.provider_transaction_id
  ) then
    raise exception 'confirmed reconciliation candidate cannot be re-matched'
      using errcode = '22023';
  end if;

  select * into v_request
  from public.payment_requests r
  where r.id = p_payment_request_id
  for update;
  if not found then
    raise exception 'payment request % does not exist', p_payment_request_id
      using errcode = '23503';
  end if;

  v_outstanding := greatest(
    v_request.amount - crm_private.payment_request_net_paid(v_request.id),
    0::numeric
  );

  if v_request.artist_id <> v_candidate.artist_id
     or v_request.provider <> v_candidate.provider
     or v_request.provider_account_key <> v_candidate.provider_account_key
     or v_request.currency <> v_candidate.currency
     or v_request.purpose <> 'deposit'
     or v_request.status not in ('pending', 'partially_paid')
     or v_outstanding <> v_candidate.amount
     or (v_request.expires_at is not null and v_request.expires_at <= v_candidate.occurred_at) then
    raise exception 'payment request is not eligible for this reconciliation candidate'
      using errcode = '22023';
  end if;

  update public.payment_reconciliation_candidates
  set status = 'matched',
      matched_payment_request_id = v_request.id,
      updated_at = now()
  where id = v_candidate.id;

  perform crm_private.log_artist_activity(
    v_candidate.artist_id,
    'payment.reconciliation_matched',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_request.client_id, null, v_request.project_id, v_request.session_id, null,
    jsonb_build_object(
      'candidate_id', v_candidate.id,
      'payment_request_id', v_request.id,
      'previous_status', v_candidate.status
    )
  );

  return jsonb_build_object(
    'candidate_id', v_candidate.id,
    'status', 'matched',
    'payment_request_id', v_request.id,
    'confirmed', false
  );
end;
$$;

create or replace function public.ignore_monzo_reconciliation_candidate(
  p_candidate_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_candidate public.payment_reconciliation_candidates%rowtype;
begin
  select * into v_candidate
  from public.payment_reconciliation_candidates c
  where c.id = p_candidate_id
  for update;
  if not found or v_candidate.provider <> 'monzo_easy_bank_transfer' then
    raise exception 'Monzo reconciliation candidate does not exist'
      using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_candidate.artist_id, 'manage_finance');

  if exists (
    select 1 from public.payment_transactions t
    where t.provider = v_candidate.provider
      and t.provider_transaction_id = v_candidate.provider_transaction_id
  ) then
    raise exception 'confirmed reconciliation candidate cannot be ignored'
      using errcode = '22023';
  end if;

  if v_candidate.status = 'ignored' then
    return jsonb_build_object(
      'candidate_id', v_candidate.id,
      'status', 'ignored',
      'changed', false,
      'confirmed', false
    );
  end if;

  update public.payment_reconciliation_candidates
  set status = 'ignored',
      matched_payment_request_id = null,
      updated_at = now()
  where id = v_candidate.id;

  perform crm_private.log_artist_activity(
    v_candidate.artist_id,
    'payment.reconciliation_ignored',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    null, null, null, null, null,
    jsonb_build_object(
      'candidate_id', v_candidate.id,
      'previous_status', v_candidate.status
    )
  );

  return jsonb_build_object(
    'candidate_id', v_candidate.id,
    'status', 'ignored',
    'changed', true,
    'confirmed', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Explicit human confirmation into the immutable provider ledger
-- ---------------------------------------------------------------------------

create or replace function public.confirm_monzo_reconciliation_candidate(
  p_candidate_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_candidate public.payment_reconciliation_candidates%rowtype;
  v_request public.payment_requests%rowtype;
  v_event public.payment_webhook_events%rowtype;
  v_existing public.payment_transactions%rowtype;
  v_transaction_id uuid;
  v_outstanding numeric(12,2);
  v_request_status public.payment_request_status;
begin
  select * into v_candidate
  from public.payment_reconciliation_candidates c
  where c.id = p_candidate_id
  for update;
  if not found or v_candidate.provider <> 'monzo_easy_bank_transfer' then
    raise exception 'Monzo reconciliation candidate does not exist'
      using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_candidate.artist_id, 'manage_finance');

  if v_candidate.status <> 'matched' or v_candidate.matched_payment_request_id is null then
    raise exception 'reconciliation candidate must be matched before confirmation'
      using errcode = '22023';
  end if;

  select * into v_request
  from public.payment_requests r
  where r.id = v_candidate.matched_payment_request_id
  for update;
  if not found then
    raise exception 'matched payment request does not exist'
      using errcode = '23503';
  end if;

  select * into v_event
  from public.payment_webhook_events e
  where e.provider = v_candidate.provider
    and e.provider_event_id = v_candidate.provider_event_id
  for update;
  if not found then
    raise exception 'verified payment webhook evidence does not exist'
      using errcode = '23503';
  end if;

  if v_event.artist_id <> v_candidate.artist_id
     or v_event.provider_account_key <> v_candidate.provider_account_key
     or v_event.processing_status <> 'succeeded' then
    raise exception 'reconciliation evidence no longer matches the verified route'
      using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'monzo-reconciliation-confirm:' || v_candidate.id::text, 0
  ));

  select * into v_existing
  from public.payment_transactions t
  where t.provider = v_candidate.provider
    and t.provider_transaction_id = v_candidate.provider_transaction_id;

  if found then
    if v_existing.payment_request_id <> v_request.id
       or v_existing.webhook_event_id <> v_event.id
       or v_existing.transaction_type <> 'payment'
       or v_existing.direction <> 'credit'
       or v_existing.amount <> v_candidate.amount
       or v_existing.currency <> v_candidate.currency
       or v_existing.status <> 'succeeded'
       or v_existing.occurred_at <> v_candidate.occurred_at then
      raise exception 'provider transaction already belongs to a different ledger entry'
        using errcode = '23514';
    end if;

    return jsonb_build_object(
      'candidate_id', v_candidate.id,
      'payment_request_id', v_request.id,
      'payment_transaction_id', v_existing.id,
      'payment_request_status', v_request.status::text,
      'confirmed', true,
      'replayed', true
    );
  end if;

  select * into v_existing
  from public.payment_transactions t
  where t.idempotency_key = v_candidate.id;
  if found then
    raise exception 'reconciliation idempotency key conflicts with another ledger entry'
      using errcode = '23514';
  end if;

  v_outstanding := greatest(
    v_request.amount - crm_private.payment_request_net_paid(v_request.id),
    0::numeric
  );

  if v_request.artist_id <> v_candidate.artist_id
     or v_request.provider <> v_candidate.provider
     or v_request.provider_account_key <> v_candidate.provider_account_key
     or v_request.currency <> v_candidate.currency
     or v_request.purpose <> 'deposit'
     or v_request.status not in ('pending', 'partially_paid')
     or v_outstanding <> v_candidate.amount
     or (v_request.expires_at is not null and v_request.expires_at <= v_candidate.occurred_at) then
    raise exception 'matched payment request is no longer eligible for confirmation'
      using errcode = '22023';
  end if;

  insert into public.payment_transactions (
    idempotency_key, payment_request_id, artist_id,
    transaction_type, direction, amount, currency, status,
    provider, provider_transaction_id, webhook_event_id,
    occurred_at, recorded_by, recorded_by_kind, safe_note_code
  ) values (
    v_candidate.id, v_request.id, v_request.artist_id,
    'payment', 'credit', v_candidate.amount, v_candidate.currency, 'succeeded',
    v_candidate.provider, v_candidate.provider_transaction_id, v_event.id,
    v_candidate.occurred_at, null, 'webhook', 'monzo_human_reconciled'
  )
  returning id into v_transaction_id;

  update public.payment_webhook_events
  set processing_status = 'succeeded',
      processed_at = now(),
      safe_error_code = null
  where id = v_event.id;

  update public.payment_reconciliation_candidates
  set updated_at = now()
  where id = v_candidate.id;

  perform crm_private.log_artist_activity(
    v_candidate.artist_id,
    'payment.reconciliation_confirmed',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_request.client_id, null, v_request.project_id, v_request.session_id, null,
    jsonb_build_object(
      'candidate_id', v_candidate.id,
      'payment_request_id', v_request.id,
      'currency', v_request.currency
    )
  );

  select r.status into v_request_status
  from public.payment_requests r
  where r.id = v_request.id;

  return jsonb_build_object(
    'candidate_id', v_candidate.id,
    'payment_request_id', v_request.id,
    'payment_transaction_id', v_transaction_id,
    'payment_request_status', v_request_status::text,
    'confirmed', true,
    'replayed', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Closed browser surface: named finance RPCs only
-- ---------------------------------------------------------------------------

revoke all on function public.list_monzo_reconciliation_candidates(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.match_monzo_reconciliation_candidate(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.ignore_monzo_reconciliation_candidate(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.confirm_monzo_reconciliation_candidate(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.list_monzo_reconciliation_candidates(uuid)
  to authenticated;
grant execute on function public.match_monzo_reconciliation_candidate(uuid,uuid)
  to authenticated;
grant execute on function public.ignore_monzo_reconciliation_candidate(uuid)
  to authenticated;
grant execute on function public.confirm_monzo_reconciliation_candidate(uuid)
  to authenticated;

comment on function public.list_monzo_reconciliation_candidates(uuid) is
  'Finance-scoped safe CRM view of verified Monzo candidates. Provider account/event/transaction identifiers are never returned.';
comment on function public.match_monzo_reconciliation_candidate(uuid,uuid) is
  'Human finance action that links a verified Monzo candidate to one eligible deposit request. Matching alone never writes the payment ledger.';
comment on function public.ignore_monzo_reconciliation_candidate(uuid) is
  'Human finance action that ignores one unconfirmed Monzo candidate without changing any payment request or ledger row.';
comment on function public.confirm_monzo_reconciliation_candidate(uuid) is
  'Separate human confirmation that records one immutable provider-origin payment from previously verified Monzo evidence. No automatic settlement path is introduced.';
