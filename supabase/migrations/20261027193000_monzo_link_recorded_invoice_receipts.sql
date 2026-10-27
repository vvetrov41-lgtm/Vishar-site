-- Reconcile verified Monzo bank evidence with an already-recorded manual
-- invoice receipt. Do not insert, delete, or update money-ledger transactions.
-- The bank transfer is evidence of money already booked, not another receipt.

create table public.monzo_recorded_receipt_links (
  candidate_id uuid primary key references public.payment_reconciliation_candidates(id) on delete restrict,
  payment_transaction_id uuid not null unique references public.payment_transactions(id) on delete restrict,
  artist_id uuid not null references public.artists(id) on delete restrict,
  linked_at timestamptz not null default now(),
  linked_by uuid references public.profiles(id) on delete set null
);

-- Only SECURITY DEFINER RPCs may read/write this reconciliation index.
alter table public.monzo_recorded_receipt_links enable row level security;
revoke all on table public.monzo_recorded_receipt_links from public, anon, authenticated;

create or replace function crm_private.monzo_recorded_receipt_options(p_candidate_id uuid)
returns jsonb
language sql
stable security definer
set search_path to 'pg_catalog', 'public', 'crm_private'
as $function$
  select coalesce(jsonb_agg(t.option order by t.delta_seconds asc, t.recorded_at desc, t.transaction_id), '[]'::jsonb)
  from (
    select
      pt.id as transaction_id,
      pt.occurred_at as recorded_at,
      abs(extract(epoch from (pt.occurred_at - c.occurred_at))) as delta_seconds,
      jsonb_build_object(
        'payment_transaction_id', pt.id,
        'payment_request_id', r.id,
        'client_name', cl.full_name,
        'invoice_number', i.invoice_number,
        'occurred_at', pt.occurred_at,
        'amount', pt.amount,
        'currency', pt.currency
      ) as option
    from public.payment_reconciliation_candidates c
    join public.payment_transactions pt
      on pt.artist_id = c.artist_id
     and pt.transaction_type = 'manual_payment'
     and pt.direction = 'credit'
     and pt.status = 'succeeded'
     and pt.amount = c.amount
     and pt.currency = c.currency
     and abs(pt.occurred_at - c.occurred_at) <= interval '7 days'
    join public.payment_requests r
      on r.id = pt.payment_request_id
     and r.artist_id = c.artist_id
     and r.purpose = 'additional_payment'
     and r.status = 'paid'
     and r.invoice_id is not null
     and r.amount = pt.amount
     and r.currency = c.currency
    join public.invoices i
      on i.id = r.invoice_id
     and i.artist_id = c.artist_id
     and i.client_id = r.client_id
     and i.issued_at is not null
     and i.voided_at is null
    join public.clients cl on cl.id = r.client_id
    where c.id = p_candidate_id
      and c.provider = 'monzo_easy_bank_transfer'
      and c.status in ('unmatched', 'candidate', 'ambiguous')
      and not exists (
        select 1 from public.monzo_recorded_receipt_links l
        where l.candidate_id = c.id or l.payment_transaction_id = pt.id
      )
      and not exists (
        select 1 from public.payment_transactions provider_receipt
        where provider_receipt.provider = c.provider
          and provider_receipt.provider_transaction_id = c.provider_transaction_id
      )
    order by delta_seconds asc, pt.occurred_at desc, pt.id
    limit 20
  ) t;
$function$;

revoke all on function crm_private.monzo_recorded_receipt_options(uuid) from public, anon, authenticated;

create or replace function public.link_monzo_recorded_receipt(
  p_candidate_id uuid,
  p_payment_transaction_id uuid
) returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'crm_private'
as $function$
declare
  v_candidate public.payment_reconciliation_candidates%rowtype;
  v_receipt public.payment_transactions%rowtype;
  v_request public.payment_requests%rowtype;
  v_invoice public.invoices%rowtype;
  v_event public.payment_webhook_events%rowtype;
  v_existing public.monzo_recorded_receipt_links%rowtype;
begin
  if p_candidate_id is null or p_payment_transaction_id is null then
    raise exception 'candidate and receipt ids are required' using errcode='22023';
  end if;

  select * into v_candidate from public.payment_reconciliation_candidates
  where id = p_candidate_id for update;
  if not found or v_candidate.provider <> 'monzo_easy_bank_transfer' then
    raise exception 'Monzo reconciliation candidate not found' using errcode='23503';
  end if;

  perform crm_private.require_artist_access(v_candidate.artist_id, 'manage_finance');

  -- The same already-linked association is safely idempotent.
  select * into v_existing from public.monzo_recorded_receipt_links
  where candidate_id = v_candidate.id;
  if found then
    if v_existing.payment_transaction_id <> p_payment_transaction_id
       or v_existing.artist_id <> v_candidate.artist_id then
      raise exception 'candidate is linked to another receipt' using errcode='23514';
    end if;
    return jsonb_build_object(
      'candidate_id', v_candidate.id,
      'payment_transaction_id', v_existing.payment_transaction_id,
      'payment_request_id', v_candidate.matched_payment_request_id,
      'confirmed', true,
      'replayed', true
    );
  end if;

  if v_candidate.status not in ('unmatched','candidate','ambiguous')
     or v_candidate.matched_payment_request_id is not null then
    raise exception 'candidate is not available for receipt linking' using errcode='22023';
  end if;

  select * into v_event from public.payment_webhook_events e
  where e.provider = v_candidate.provider
    and e.provider_event_id = v_candidate.provider_event_id
  for update;
  if not found
     or v_event.artist_id <> v_candidate.artist_id
     or v_event.provider_account_key <> v_candidate.provider_account_key
     or v_event.processing_status <> 'succeeded' then
    raise exception 'verified bank evidence is absent or mismatched' using errcode='23514';
  end if;

  if exists (
    select 1 from public.payment_transactions pt
    where pt.provider = v_candidate.provider
      and pt.provider_transaction_id = v_candidate.provider_transaction_id
  ) then
    raise exception 'bank transfer already recorded in the ledger' using errcode='23514';
  end if;

  select * into v_receipt from public.payment_transactions pt
  where pt.id = p_payment_transaction_id for update;
  if not found
     or v_receipt.artist_id <> v_candidate.artist_id
     or v_receipt.transaction_type <> 'manual_payment'
     or v_receipt.direction <> 'credit'
     or v_receipt.status <> 'succeeded'
     or v_receipt.provider is not null
     or v_receipt.provider_transaction_id is not null
     or v_receipt.webhook_event_id is not null
     or v_receipt.amount <> v_candidate.amount
     or v_receipt.currency <> v_candidate.currency
     or abs(v_receipt.occurred_at - v_candidate.occurred_at) > interval '7 days' then
    raise exception 'recorded receipt does not match bank evidence' using errcode='22023';
  end if;

  select * into v_request from public.payment_requests
  where id = v_receipt.payment_request_id for update;
  if not found
     or v_request.artist_id <> v_candidate.artist_id
     or v_request.purpose <> 'additional_payment'
     or v_request.status <> 'paid'
     or v_request.amount <> v_receipt.amount
     or v_request.currency <> v_candidate.currency
     or v_request.invoice_id is null
     or crm_private.payment_request_net_paid(v_request.id) <> v_receipt.amount then
    raise exception 'receipt request is not a settled invoice payment' using errcode='22023';
  end if;

  select * into v_invoice from public.invoices
  where id = v_request.invoice_id for update;
  if not found
     or v_invoice.artist_id <> v_candidate.artist_id
     or v_invoice.client_id <> v_request.client_id
     or v_invoice.project_id <> v_request.project_id
     or v_invoice.issued_at is null
     or v_invoice.voided_at is not null then
    raise exception 'recorded invoice is no longer eligible' using errcode='22023';
  end if;

  -- Keep immutable money history intact; one evidence link per candidate and
  -- per human receipt. A unique constraint prevents two bank transfers
  -- claiming the same already-recorded money.
  insert into public.monzo_recorded_receipt_links (
    candidate_id, payment_transaction_id, artist_id, linked_by
  ) values (
    v_candidate.id, v_receipt.id, v_candidate.artist_id, auth.uid()
  );

  update public.payment_reconciliation_candidates
  set status = 'matched',
      suggested_payment_request_id = null,
      matched_payment_request_id = v_request.id,
      updated_at = now()
  where id = v_candidate.id;

  perform crm_private.log_artist_activity(
    v_candidate.artist_id, 'payment.existing_receipt_linked',
    case when public.is_owner() then 'owner' else 'staff' end, auth.uid(),
    v_request.client_id, null, v_request.project_id, null, null,
    jsonb_build_object(
      'candidate_id', v_candidate.id,
      'payment_request_id', v_request.id,
      'receipt_link_id', v_receipt.id,
      'currency', v_candidate.currency,
      'new_payment_created', false
    )
  );

  return jsonb_build_object(
    'candidate_id', v_candidate.id,
    'payment_transaction_id', v_receipt.id,
    'payment_request_id', v_request.id,
    'confirmed', true,
    'replayed', false
  );
end;
$function$;

revoke all on function public.link_monzo_recorded_receipt(uuid, uuid) from public, anon;
grant execute on function public.link_monzo_recorded_receipt(uuid, uuid) to authenticated;

-- Preserve deposit reconciliation; supplement it with the existence of a
-- validated manual-receipt evidence link. Never add another ledger credit.
create or replace function public.list_monzo_reconciliation_candidates(p_artist_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path to 'pg_catalog', 'public', 'crm_private'
as $function$
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
          select 1 from public.payment_transactions pt
          where pt.provider = c.provider and pt.provider_transaction_id = c.provider_transaction_id
            and pt.status = 'succeeded'
        ) or exists (
          select 1 from public.monzo_recorded_receipt_links lr where lr.candidate_id = c.id
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
        'confirmed', (
          exists (
            select 1 from public.payment_transactions pt
            where pt.provider = c.provider and pt.provider_transaction_id = c.provider_transaction_id
              and pt.status = 'succeeded'
          ) or exists (
            select 1 from public.monzo_recorded_receipt_links lr where lr.candidate_id = c.id
          )
        ),
        'linked_existing_receipt', exists (
          select 1 from public.monzo_recorded_receipt_links lr where lr.candidate_id = c.id
        ),
        'suggested_payment_request',
          crm_private.monzo_reconciliation_request_summary(c.suggested_payment_request_id),
        'matched_payment_request',
          crm_private.monzo_reconciliation_request_summary(c.matched_payment_request_id),
        'match_options', crm_private.monzo_reconciliation_match_options(c.id),
        'recorded_receipt_options', crm_private.monzo_recorded_receipt_options(c.id)
      ) as item
    from public.payment_reconciliation_candidates c
    where c.artist_id = p_artist_id
      and c.provider = 'monzo_easy_bank_transfer'
    order by
      case
        when exists (
          select 1 from public.payment_transactions pt
          where pt.provider = c.provider and pt.provider_transaction_id = c.provider_transaction_id
            and pt.status = 'succeeded'
        ) or exists (
          select 1 from public.monzo_recorded_receipt_links lr where lr.candidate_id = c.id
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
$function$;
