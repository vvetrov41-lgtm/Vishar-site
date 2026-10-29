-- One-time verified settlement of Charlie Sims' 28 October 2026 session.
-- Charlie paid the GBP 420 second day directly to the studio. The artist
-- already received GBP 980 over the two-day project; together this is the
-- agreed 70/30 allocation of GBP 1,400. This migration does NOT post money.
-- It only corrects the completed session's price and paid status after all
-- immutable receipts and the studio-held invoice have been verified.
do $settlement$
declare
  v_session public.sessions%rowtype;
  v_first public.sessions%rowtype;
  v_invoice public.invoices%rowtype;
  v_studio_request public.payment_requests%rowtype;
  v_studio_receipt public.payment_transactions%rowtype;
  v_first_deposit public.payment_requests%rowtype;
  v_first_balance public.payment_requests%rowtype;
  v_invoice_totals record;
  v_second_session_id constant uuid := 'c4f2c594-ccae-4978-b45e-048c03f65e47';
  v_first_session_id constant uuid := '438b706a-ea4e-461d-96f5-4989c232afb3';
  v_project_id constant uuid := '915a502f-1405-4666-b76d-7fbc85ba1e18';
  v_client_id constant uuid := 'ddb8f462-4522-4edb-a663-5a6fef972691';
  v_artist_id constant uuid := 'a1111111-1111-4111-8111-111111111111';
  v_invoice_id constant uuid := '3859cc93-2122-40a7-bba3-71f7fa36634e';
begin
  select * into v_session from public.sessions
  where id=v_second_session_id for update;
  if not found then
    -- CI/local/staging must not create fake client/payment records.
    raise notice 'Charlie second session absent in this environment: no mutation';
    return;
  end if;
  if v_session.artist_id <> v_artist_id
     or v_session.client_id <> v_client_id
     or v_session.project_id <> v_project_id
     or v_session.status <> 'completed'
     or v_session.appointment_type <> 'tattoo_session'
     or v_session.start_at <> timestamptz '2026-10-28 11:00:00+00'
     or v_session.end_at <> timestamptz '2026-10-28 14:00:00+00'
     or v_session.currency <> 'GBP'
     or v_session.payment_status not in ('unpaid','paid')
     or (v_session.price is not null and v_session.price <> 420) then
    raise exception 'Charlie second session identity/price/status drifted'
      using errcode='23514';
  end if;

  select * into v_first from public.sessions
  where id=v_first_session_id for share;
  if not found or v_first.artist_id <> v_artist_id
     or v_first.project_id <> v_project_id
     or v_first.client_id <> v_client_id
     or v_first.status <> 'completed'
     or v_first.payment_status <> 'paid'
     or v_first.price <> 980
     or v_first.start_at <> timestamptz '2026-10-27 11:00:00+00'
     or v_first.end_at <> timestamptz '2026-10-27 18:00:00+00' then
    raise exception 'first session must already be independently settled'
      using errcode='23514';
  end if;

  if not exists (select 1 from public.projects p
      where p.id=v_project_id and p.client_id=v_client_id
        and p.artist_id=v_artist_id and p.deposit_status='paid'
        and p.deposit_amount=250 and p.currency='GBP')
     or (select count(*) from public.sessions s where s.project_id=v_project_id) <> 2 then
    raise exception 'project/deposit scope changed'
      using errcode='23514';
  end if;

  select * into v_first_deposit from public.payment_requests r
  where r.id='9398b8a4-7e35-4f78-a2ae-1db943e365c3' for share;
  select * into v_first_balance from public.payment_requests r
  where r.id='40ea569c-f077-4d25-923e-ef7762b26f51' for share;
  if v_first_deposit.id is null
     or v_first_deposit.artist_id <> v_artist_id
     or v_first_deposit.client_id <> v_client_id
     or v_first_deposit.project_id <> v_project_id
     or v_first_deposit.session_id <> v_first_session_id
     or v_first_deposit.purpose <> 'deposit'
     or v_first_deposit.status <> 'paid'
     or v_first_deposit.amount <> 250
     or crm_private.payment_request_net_paid(v_first_deposit.id) <> 250
     or v_first_balance.id is null
     or v_first_balance.artist_id <> v_artist_id
     or v_first_balance.client_id <> v_client_id
     or v_first_balance.project_id <> v_project_id
     or v_first_balance.purpose <> 'additional_payment'
     or v_first_balance.status <> 'paid'
     or v_first_balance.amount <> 730
     or crm_private.payment_request_net_paid(v_first_balance.id) <> 730 then
    raise exception 'artist receipts must total the settled GBP 980'
      using errcode='23514';
  end if;

  select * into v_invoice from public.invoices i
  where id=v_invoice_id for share;
  if not found or v_invoice.artist_id <> v_artist_id
     or v_invoice.client_id <> v_client_id
     or v_invoice.project_id <> v_project_id
     or v_invoice.currency <> 'GBP'
     or v_invoice.invoice_number <> 'INV-2026-00002'
     or v_invoice.issue_date <> date '2026-10-28'
     or v_invoice.issued_at is null or v_invoice.voided_at is not null
     or v_invoice.status <> 'paid'
     or v_invoice.discount_amount <> 0 then
    raise exception 'studio-received invoice identity or status drifted'
      using errcode='23514';
  end if;

  select * into v_invoice_totals
  from crm_private.invoice_totals(v_invoice_id);
  if not found or v_invoice_totals.total <> 420
     or v_invoice_totals.amount_paid <> 420
     or v_invoice_totals.amount_credited <> 0
     or v_invoice_totals.amount_outstanding <> 0 then
    raise exception 'studio-held payment is not settled GBP 420'
      using errcode='23514';
  end if;

  if (select count(*) from public.invoice_line_items li
        where li.invoice_id=v_invoice_id) <> 1
     or not exists (
       select 1 from public.invoice_line_items li
       where li.invoice_id=v_invoice_id
         and li.session_id=v_second_session_id
         and li.quantity=1 and li.unit_amount=420 and li.line_total=420
     )
     or (select count(*) from public.invoice_line_items li
       join public.invoices i on i.id=li.invoice_id
       where li.session_id=v_second_session_id and i.voided_at is null) <> 1
  then
    raise exception 'second-session invoice line is ambiguous'
      using errcode='23514';
  end if;

  select * into v_studio_request from public.payment_requests r
  where r.id='2518b0e9-d07c-44f6-a190-bac66f238e83' for share;
  select * into v_studio_receipt from public.payment_transactions t
  where t.id='6551ee0d-764b-47bd-9358-67afea577d0b' for share;
  if v_studio_request.id is null
     or v_studio_request.invoice_id <> v_invoice_id
     or v_studio_request.artist_id <> v_artist_id
     or v_studio_request.client_id <> v_client_id
     or v_studio_request.project_id <> v_project_id
     or v_studio_request.status <> 'paid'
     or v_studio_request.purpose <> 'additional_payment'
     or v_studio_request.amount <> 420
     or v_studio_request.currency <> 'GBP'
     or v_studio_request.payment_method_code <> 'studio_direct'
     or v_studio_request.external_reference <> 'CHARLIE-2026-10-28-STUDIO-30PCT'
     or crm_private.payment_request_net_paid(v_studio_request.id) <> 420
     or v_studio_receipt.id is null
     or v_studio_receipt.payment_request_id <> v_studio_request.id
     or v_studio_receipt.artist_id <> v_artist_id
     or v_studio_receipt.transaction_type <> 'manual_payment'
     or v_studio_receipt.direction <> 'credit'
     or v_studio_receipt.status <> 'succeeded'
     or v_studio_receipt.amount <> 420
     or v_studio_receipt.currency <> 'GBP'
     or v_studio_receipt.provider is not null
     or v_studio_receipt.provider_transaction_id is not null
     or (select count(*) from public.payment_transactions t
       where t.payment_request_id=v_studio_request.id) <> 1 then
    raise exception 'studio receipt lacks required provenance or has duplicates'
      using errcode='23514';
  end if;

  if (select count(*) from public.payment_requests r
      where r.project_id=v_project_id
        and r.status not in ('cancelled','expired')) <> 3
     or (select coalesce(sum(case when t.direction='credit' then t.amount
             else -t.amount end),0)
       from public.payment_transactions t
       join public.payment_requests r on r.id=t.payment_request_id
       where r.project_id=v_project_id and t.status='succeeded') <> 1400
     or round(420::numeric/1400::numeric*100,2) <> 30.00 then
    raise exception 'the project gross receipts do not support the 70/30 split'
      using errcode='23514';
  end if;

  if v_session.price=420 and v_session.payment_status='paid' then
    return; -- safe replay, no repeated audit or side effects.
  end if;
  if v_session.price is not null or v_session.payment_status <> 'unpaid' then
    raise exception 'second session has unexpected previous settlement state'
      using errcode='23514';
  end if;

  update public.sessions s
  set price=420,payment_status='paid'
  where s.id=v_second_session_id;

  perform crm_private.log_artist_activity(
    v_artist_id,'session.settlement_verified','system',null,
    v_client_id,v_session.enquiry_id,v_project_id,v_second_session_id,null,
    jsonb_build_object(
      'session_date','2026-10-28','gross_price',420,'currency','GBP',
      'client_paid_to','studio_direct','studio_share',420,
      'artist_share',980,'two_day_total',1400,
      'invoice_id',v_invoice_id,
      'studio_payment_request_id',v_studio_request.id,
      'studio_receipt_transaction_id',v_studio_receipt.id,
      'ledger_transactions_added',0,
      'previous_payment_status',v_session.payment_status
    )
  );

  if not exists (select 1 from public.sessions s
    where s.id=v_second_session_id and s.price=420
      and s.payment_status='paid' and s.status='completed') then
    raise exception 'Charlie second session post-update readback failed'
      using errcode='23514';
  end if;
end;
$settlement$;
