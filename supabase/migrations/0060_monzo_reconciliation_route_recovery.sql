-- 0060_monzo_reconciliation_route_recovery.sql
--
-- A connected Monzo account and its webhook are independently configured from
-- the optional reusable Easy Bank Transfer payment-link destination. Incoming
-- transaction reconciliation must therefore resolve artist ownership from the
-- server-derived Monzo provider-account key, not from an enabled payment-link
-- integration row.
--
-- This remains backend-only and does not settle payments automatically.
-- Forward-only.

create or replace function crm_private.resolve_monzo_reconciliation_owner(
  p_provider_account_key text
)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  p_provider_account_key := lower(btrim(coalesce(p_provider_account_key, '')));

  if p_provider_account_key !~ '^monzo_ebt_[a-f0-9]{32}$' then
    raise exception 'Monzo reconciliation route is invalid'
      using errcode = '22023';
  end if;

  select a.artist_id into v_artist_id
  from crm_private.artist_state a
  where a.is_active
    and ('monzo_ebt_' || replace(a.artist_id::text, '-', '')) = p_provider_account_key;

  if not found then
    raise exception 'Monzo reconciliation route is not enabled'
      using errcode = '42501';
  end if;

  return v_artist_id;
end;
$$;

revoke all on function crm_private.resolve_monzo_reconciliation_owner(text)
  from public, anon, authenticated, service_role;

create or replace function public.register_monzo_reconciliation_candidate(
  p_provider_account_key text,
  p_provider_event_id text,
  p_provider_transaction_id text,
  p_amount numeric,
  p_currency text,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_existing public.payment_reconciliation_candidates%rowtype;
  v_webhook_event public.payment_webhook_events%rowtype;
  v_webhook_event_exists boolean := false;
  v_candidate_count integer;
  v_suggested_request_id uuid;
  v_status text;
  v_candidate_id uuid;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Monzo reconciliation registration is backend-only'
      using errcode = '42501';
  end if;

  p_provider_account_key := lower(btrim(coalesce(p_provider_account_key, '')));
  p_provider_event_id := btrim(coalesce(p_provider_event_id, ''));
  p_provider_transaction_id := btrim(coalesce(p_provider_transaction_id, ''));
  p_currency := upper(btrim(coalesce(p_currency, '')));

  if p_provider_account_key !~ '^monzo_ebt_[a-f0-9]{32}$'
     or p_provider_event_id = '' or char_length(p_provider_event_id) > 255
     or p_provider_transaction_id = '' or char_length(p_provider_transaction_id) > 255
     or p_amount is null or p_amount <= 0
     or p_currency <> 'GBP'
     or p_occurred_at is null then
    raise exception 'Monzo reconciliation metadata is invalid'
      using errcode = '22023';
  end if;

  v_artist_id := crm_private.resolve_monzo_reconciliation_owner(
    p_provider_account_key
  );

  perform pg_advisory_xact_lock(hashtextextended(
    'monzo-event:' || p_provider_event_id, 0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'monzo-transaction:' || p_provider_account_key || ':' || p_provider_transaction_id, 0
  ));

  select * into v_webhook_event
  from public.payment_webhook_events e
  where e.provider = 'monzo_easy_bank_transfer'
    and e.provider_event_id = p_provider_event_id;
  v_webhook_event_exists := found;

  if v_webhook_event_exists and (
    v_webhook_event.artist_id <> v_artist_id
    or v_webhook_event.provider_account_key <> p_provider_account_key
  ) then
    raise exception 'Monzo provider event id belongs to another payment route'
      using errcode = '22023';
  end if;

  select * into v_existing
  from public.payment_reconciliation_candidates c
  where c.provider = 'monzo_easy_bank_transfer'
    and c.provider_account_key = p_provider_account_key
    and c.provider_transaction_id = p_provider_transaction_id;

  if found then
    if v_existing.artist_id <> v_artist_id
       or v_existing.provider_event_id <> p_provider_event_id
       or v_existing.amount <> p_amount
       or v_existing.currency <> p_currency
       or v_existing.occurred_at <> p_occurred_at then
      raise exception 'Monzo transaction id was reused with different metadata'
        using errcode = '22023';
    end if;

    return jsonb_build_object(
      'candidate_id', v_existing.id,
      'artist_id', v_existing.artist_id,
      'status', v_existing.status,
      'replayed', true
    );
  end if;

  select count(*)::integer into v_candidate_count
  from public.payment_requests r
  where r.artist_id = v_artist_id
    and r.provider = 'monzo_easy_bank_transfer'
    and r.provider_account_key = p_provider_account_key
    and r.purpose = 'deposit'
    and r.status in ('pending', 'partially_paid')
    and r.amount = p_amount
    and r.currency = p_currency
    and (r.expires_at is null or r.expires_at > p_occurred_at);

  if v_candidate_count = 1 then
    select r.id into v_suggested_request_id
    from public.payment_requests r
    where r.artist_id = v_artist_id
      and r.provider = 'monzo_easy_bank_transfer'
      and r.provider_account_key = p_provider_account_key
      and r.purpose = 'deposit'
      and r.status in ('pending', 'partially_paid')
      and r.amount = p_amount
      and r.currency = p_currency
      and (r.expires_at is null or r.expires_at > p_occurred_at)
    order by r.created_at, r.id
    limit 1;
    v_status := 'candidate';
  elsif v_candidate_count > 1 then
    v_suggested_request_id := null;
    v_status := 'ambiguous';
  else
    v_suggested_request_id := null;
    v_status := 'unmatched';
  end if;

  if not v_webhook_event_exists then
    insert into public.payment_webhook_events (
      artist_id, provider, provider_account_key, provider_event_id,
      processing_status, processed_at
    ) values (
      v_artist_id, 'monzo_easy_bank_transfer', p_provider_account_key,
      p_provider_event_id, 'succeeded', now()
    );
  end if;

  insert into public.payment_reconciliation_candidates (
    artist_id, provider, provider_account_key,
    provider_event_id, provider_transaction_id,
    amount, currency, occurred_at, status,
    suggested_payment_request_id
  ) values (
    v_artist_id, 'monzo_easy_bank_transfer', p_provider_account_key,
    p_provider_event_id, p_provider_transaction_id,
    p_amount, p_currency, p_occurred_at, v_status,
    v_suggested_request_id
  )
  returning id into v_candidate_id;

  return jsonb_build_object(
    'candidate_id', v_candidate_id,
    'artist_id', v_artist_id,
    'status', v_status,
    'replayed', false
  );
end;
$$;

revoke all on function public.register_monzo_reconciliation_candidate(text,text,text,numeric,text,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.register_monzo_reconciliation_candidate(text,text,text,numeric,text,timestamptz)
  to service_role;
