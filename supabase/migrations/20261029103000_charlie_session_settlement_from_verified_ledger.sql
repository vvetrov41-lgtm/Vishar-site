-- Bounded 27 Oct 2026 session settlement repair.
-- Previous CRM invoice + Monzo evidence were already settled and reconciled.
-- Never add ledger credits, reassign invoices, or alter any other session.
-- Runs in the gated exact-SHA production DB release; no direct SQL mutations.

do $settlement$
declare
  v_session public.sessions%rowtype;
  v_deposit public.payment_requests%rowtype;
  v_balance public.payment_requests%rowtype;
  v_invoice public.invoices%rowtype;
  v_invoice_totals record;
  v_transfer public.payment_transactions%rowtype;
  v_candidate public.payment_reconciliation_candidates%rowtype;
  v_session_id constant uuid := '438b706a-ea4e-461d-96f5-4989c232afb3';
  v_deposit_id constant uuid := '9398b8a4-7e35-4f78-a2ae-1db943e365c3';
  v_balance_id constant uuid := '40ea569c-f077-4d25-923e-ef7762b26f51';
  v_invoice_id constant uuid := 'bf7463ae-52dc-4ed9-89cb-b029163d9269';
  v_candidate_id constant uuid := '80163a72-6a34-470d-a141-9f11e6830c8c';
  v_transfer_id constant uuid := '5a15e469-abc1-41ac-b19d-11d4d1f84347';
  v_expected_price constant numeric := 980.00;
  v_expected_deposit constant numeric := 250.00;
  v_expected_balance constant numeric := 730.00;
begin
  -- CI/staging have no customer records and must not create synthetic customers.
  -- If the exact production session exists, every subsequent mismatch aborts
  -- the migration atomically instead of guessing a settlement.
  select * into v_session from public.sessions
  where id = v_session_id for update;
  if not found then
    raise notice 'No matching real session in this environment; no settlement repair performed';
    return;
  end if;

  if v_session.artist_id <> 'a1111111-1111-4111-8111-111111111111'::uuid
     or v_session.project_id <> '915a502f-1405-4666-b76d-7fbc85ba1e18'::uuid
     or v_session.status <> 'completed'
     or v_session.appointment_type <> 'tattoo_session'
     or v_session.currency <> 'GBP'
     or v_session.start_at <> timestamptz '2026-10-27 11:00:00+00'
     or v_session.end_at <> timestamptz '2026-10-27 18:00:00+00'
     or (v_session.price is not null and v_session.price <> v_expected_price)
     or v_session.payment_status not in ('unpaid','paid') then
    raise exception 'session settlement scope or previous price/status drifted' using errcode = '23514';
  end if;

  select * into v_deposit from public.payment_requests
  where id = v_deposit_id for share;
  if not found or v_deposit.artist_id <> v_session.artist_id
     or v_deposit.project_id <> v_session.project_id
     or v_deposit.session_id <> v_session.id
     or v_deposit.client_id is distinct from v_session.client_id
     or v_deposit.invoice_id is not null
     or v_deposit.purpose <> 'deposit'
     or v_deposit.status <> 'paid'
     or v_deposit.amount <> v_expected_deposit
     or v_deposit.currency <> 'GBP'
     or crm_private.payment_request_net_paid(v_deposit.id) <> v_expected_deposit then
    raise exception 'exact session deposit is not independently verified' using errcode = '23514';
  end if;

  select * into v_balance from public.payment_requests
  where id = v_balance_id for share;
  if not found or v_balance.artist_id <> v_session.artist_id
     or v_balance.project_id <> v_session.project_id
     or v_balance.client_id is distinct from v_session.client_id
     or v_balance.session_id is not null
     or v_balance.invoice_id <> v_invoice_id
     or v_balance.purpose <> 'additional_payment'
     or v_balance.status <> 'paid'
     or v_balance.amount <> v_expected_balance
     or v_balance.currency <> 'GBP'
     or crm_private.payment_request_net_paid(v_balance.id) <> v_expected_balance then
    raise exception 'exact invoice balance is not independently verified' using errcode = '23514';
  end if;

  select * into v_invoice from public.invoices
  where id = v_invoice_id for share;
  if not found or v_invoice.artist_id <> v_session.artist_id
     or v_invoice.client_id is distinct from v_session.client_id
     or v_invoice.project_id <> v_session.project_id
     or v_invoice.issued_at is null or v_invoice.voided_at is not null
     or v_invoice.currency <> 'GBP'
     or v_invoice.discount_amount <> 0 then
    raise exception 'invoice is not an issued, unchanged session balance' using errcode = '23514';
  end if;

  if (select count(*) from public.invoice_line_items li
      where li.invoice_id = v_invoice_id) <> 1
     or not exists (
      select 1 from public.invoice_line_items li
      where li.invoice_id = v_invoice_id
        and li.session_id = v_session.id
        and li.line_total = v_expected_balance
     )
     or (select count(*) from public.invoice_line_items li
         join public.invoices i on i.id = li.invoice_id
         where li.session_id = v_session.id and i.voided_at is null) <> 1
     or (select count(*) from public.payment_requests r
         where r.session_id = v_session.id and r.purpose = 'deposit') <> 1
     or (select count(*) from public.payment_requests r
         where r.invoice_id = v_invoice_id) <> 1 then
    raise exception 'session allocations are ambiguous, mixed or duplicated' using errcode = '23514';
  end if;

  select * into v_invoice_totals from crm_private.invoice_totals(v_invoice_id);
  if not found or v_invoice_totals.total <> v_expected_balance
     or v_invoice_totals.amount_paid <> v_expected_balance
     or v_invoice_totals.amount_credited <> 0
     or v_invoice_totals.amount_outstanding <> 0 then
    raise exception 'invoice is not settled in the authoritative ledger' using errcode = '23514';
  end if;

  if (select count(*) from public.payment_transactions t
      where t.payment_request_id = v_deposit_id) <> 1
     or not exists (
      select 1 from public.payment_transactions t
      where t.payment_request_id = v_deposit_id
        and t.status = 'succeeded' and t.direction = 'credit'
        and t.amount = v_expected_deposit and t.currency = 'GBP'
     )
     or (select count(*) from public.payment_transactions t
         where t.payment_request_id = v_balance_id) <> 1 then
    raise exception 'payment ledger transaction count or deposit has drifted' using errcode = '23514';
  end if;

  select * into v_transfer from public.payment_transactions
  where id = v_transfer_id for share;
  if not found or v_transfer.payment_request_id <> v_balance.id
     or v_transfer.artist_id <> v_session.artist_id
     or v_transfer.transaction_type <> 'manual_payment'
     or v_transfer.direction <> 'credit'
     or v_transfer.status <> 'succeeded'
     or v_transfer.amount <> v_expected_balance
     or v_transfer.currency <> 'GBP'
     or v_transfer.provider is not null
     or v_transfer.provider_transaction_id is not null then
    raise exception 'verified human-recorded receipt changed' using errcode = '23514';
  end if;

  select * into v_candidate from public.payment_reconciliation_candidates
  where id = v_candidate_id for share;
  if not found or v_candidate.artist_id <> v_session.artist_id
     or v_candidate.status <> 'matched'
     or v_candidate.provider <> 'monzo_easy_bank_transfer'
     or v_candidate.matched_payment_request_id <> v_balance.id
     or v_candidate.amount <> v_expected_balance
     or v_candidate.currency <> 'GBP'
     or not exists (
       select 1 from public.monzo_recorded_receipt_links l
       where l.candidate_id = v_candidate.id
         and l.payment_transaction_id = v_transfer.id
         and l.artist_id = v_session.artist_id
     ) then
    raise exception 'Monzo evidence has not been linked to this exact receipt' using errcode = '23514';
  end if;

  -- Idempotent for a retry; do not create duplicate audit activity.
  if v_session.price = v_expected_price and v_session.payment_status = 'paid' then
    return;
  end if;

  update public.sessions
    set price = v_expected_price, payment_status = 'paid'
  where id = v_session.id;

  perform crm_private.log_artist_activity(
    v_session.artist_id, 'session.settlement_verified', 'system', null,
    v_session.client_id, v_session.enquiry_id, v_session.project_id,
    v_session.id, null,
    jsonb_build_object(
      'price', v_expected_price, 'currency', v_session.currency,
      'deposit_paid', v_expected_deposit, 'invoice_paid', v_expected_balance,
      'balance_due', 0, 'invoice_id', v_invoice.id,
      'monzo_evidence_id', v_candidate.id, 'ledger_transactions_added', 0,
      'previous_payment_status', v_session.payment_status
    )
  );

  if not exists (
    select 1 from public.sessions s
    where s.id = v_session.id
      and s.price = v_expected_price
      and s.payment_status = 'paid'
  ) then
    raise exception 'session readback failed inside settlement transaction' using errcode = '23514';
  end if;
end;
$settlement$;
