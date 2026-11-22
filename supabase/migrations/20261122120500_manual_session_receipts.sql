-- A booking deposit requested from the client follows the pricing policy.
-- An explicitly recorded receipt has the operator's actual amount and no payment link.
-- Keep all transport, ownership and ledger limits in the database.

create or replace function crm_private.guard_session_deposit_tier_amount()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_tier record;
  v_has_schedule boolean;
begin
  if new.purpose <> 'deposit' or new.session_id is null
     or (new.provider is null and new.policy_snapshot->>'origin' = 'manual_session_receipt') then
    return new;
  end if;

  select exists (
    select 1
    from public.artist_payment_policies p
    join public.artist_payment_policy_session_tiers t on t.policy_id = p.id
    where p.artist_id = new.artist_id
      and p.is_active
      and p.effective_from <= now()
      and (p.effective_until is null or p.effective_until > now())
      and p.deposit_mode = 'per_session_fixed'
      and p.refund_policy_version = 'monzo-ebt-duration-v1'
  ) into v_has_schedule;

  if not v_has_schedule then
    return new;
  end if;

  select * into v_tier
  from crm_private.resolve_session_deposit_tier(new.artist_id, new.session_id);

  if new.amount <> v_tier.amount or new.currency <> v_tier.currency then
    raise exception 'session deposit amount must match the server duration policy'
      using errcode = '22023';
  end if;

  if new.policy_id is distinct from v_tier.policy_id
     or new.policy_version is distinct from v_tier.policy_version then
    raise exception 'session deposit policy version must match the active duration policy'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

create or replace function crm_private.queue_paid_deposit_confirmation()
returns trigger language plpgsql security definer
set search_path to 'pg_catalog','public','crm_private'
as $function$
declare v_email_id uuid;
begin
  if new.purpose <> 'deposit' or new.status <> 'paid' or old.status='paid'
     or new.policy_snapshot->>'origin' in ('legacy_paid_project_reconciliation', 'manual_session_receipt') then
    return new;
  end if;
  begin
    v_email_id:=crm_private.create_deposit_email(new.id,'deposit_confirmation');
    if v_email_id is not null then
      perform crm_private.enqueue_outbox(
        'approved_email'::public.outbox_kind,
        'email:deposit:' || new.id::text || ':confirmation',
        jsonb_build_object('email_message_id',v_email_id),
        new.client_id,null,new.project_id,new.session_id,v_email_id
      );
    end if;
  exception when others then
    raise warning 'deposit confirmation queue failed, sqlstate=%',sqlstate;
  end;
  return new;
end;
$function$;

create or replace function crm_private.refresh_booking_card_from_payment()
returns trigger language plpgsql security definer
set search_path to 'pg_catalog','public','crm_private'
as $function$
declare v_session_id uuid;
begin
  -- Historical recovery must not send a second card to a client who already
  -- confirmed their booking.
  if new.policy_snapshot->>'origin' in ('legacy_paid_project_reconciliation', 'manual_session_receipt') then
    return new;
  end if;
  begin
    if new.session_id is not null then
      perform crm_private.sync_booking_card(new.session_id);
    end if;
    for v_session_id in
      select m.session_id from public.session_deposit_groups g
      join public.session_deposit_group_members m on m.group_id=g.id
      where g.payment_request_id=new.id and m.released_at is null
    loop
      perform crm_private.sync_booking_card(v_session_id);
    end loop;
    if new.session_id is null and new.project_id is not null then
      perform crm_private.sync_project_booking_cards(new.project_id);
    end if;
  exception when others then
    raise warning 'booking card payment sync failed, sqlstate=%',sqlstate;
  end;
  return new;
end;
$function$;

create or replace function crm_private.visit_session_finance(p_session_id uuid, p_price numeric default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_session public.sessions%rowtype;
  v_project public.projects%rowtype;
  v_price numeric;
  v_warnings text[] := '{}';
  v_deposit numeric := 0;
  v_invoiced numeric := 0;
  v_due numeric;
  v_session_invoices uuid[];
  v_payable uuid;
  v_payable_outstanding numeric;
  v_payable_status public.invoice_status;
begin
  select * into v_session from public.sessions where id = p_session_id;
  if not found then
    raise exception 'appointment does not exist' using errcode = '23503';
  end if;
  v_price := coalesce(p_price, v_session.price);
  if v_session.project_id is not null then
    select * into v_project from public.projects where id = v_session.project_id;
  end if;

  -- Deposits: currency and allocation checks (project scope).
  if exists (
    select 1 from public.payment_requests r
    where r.project_id = v_session.project_id and r.purpose = 'deposit'
      and (r.session_id = v_session.id or r.session_id is null)
      and r.currency <> v_session.currency
      and crm_private.visit_request_net_paid(r.id) > 0
  ) then v_warnings := array_append(v_warnings, 'currency_mismatch'); end if;
  -- A paid project-level deposit with no session AND no deposit group has no
  -- allocation record. One that backs a group is allocated by its members.
  if exists (
    select 1 from public.payment_requests r
    where r.project_id = v_session.project_id and r.purpose = 'deposit'
      and r.session_id is null and crm_private.visit_request_net_paid(r.id) > 0
      and not exists (select 1 from public.session_deposit_groups g where g.payment_request_id = r.id)
  ) then v_warnings := array_append(v_warnings, 'unallocated_deposit'); end if;
  -- This session's share of a grouped deposit counts only while the whole
  -- group request is fully paid in the ledger and in this session's currency.
  if exists (
    select 1 from public.session_deposit_group_members m
    join public.session_deposit_groups g on g.id = m.group_id
    join public.payment_requests r on r.id = g.payment_request_id
    where m.session_id = v_session.id and m.released_at is null
      and (m.currency <> v_session.currency
           or crm_private.visit_request_net_paid(r.id) < g.total_amount - 0.005)
  ) then v_warnings := array_append(v_warnings, 'unallocated_deposit'); end if;
  -- A legacy paid project deposit without a ledger request cannot be allocated.
  if v_project.id is not null and v_project.deposit_status = 'paid'
     and coalesce(v_project.deposit_amount, 0) > 0
     and not exists (
       select 1 from public.payment_requests r
       where r.project_id = v_project.id and r.purpose = 'deposit'
         and crm_private.visit_request_net_paid(r.id) > 0)
  then v_warnings := array_append(v_warnings, 'unallocated_deposit'); end if;

  -- Invoices of this project.
  if exists (
    select 1 from public.invoices i
    where i.project_id = v_session.project_id and i.status <> 'void'
      and (not exists (select 1 from public.invoice_line_items li where li.invoice_id = i.id)
           or exists (select 1 from public.invoice_line_items li
                      where li.invoice_id = i.id and li.session_id is null))
  ) then v_warnings := array_append(v_warnings, 'unlinked_invoice'); end if;

  select coalesce(array_agg(i.id order by i.created_at, i.id), '{}') into v_session_invoices
  from public.invoices i
  where i.project_id = v_session.project_id and i.status <> 'void'
    and exists (select 1 from public.invoice_line_items li
                where li.invoice_id = i.id and li.session_id = v_session.id);

  if exists (select 1 from public.invoices i where i.id = any(v_session_invoices)
             and i.currency <> v_session.currency)
  then v_warnings := array_append(v_warnings, 'currency_mismatch'); end if;
  if exists (select 1 from public.invoices i
             cross join lateral crm_private.invoice_totals(i.id) t
             where i.id = any(v_session_invoices)
               and (coalesce(t.amount_credited, 0) > 0 or coalesce(i.discount_amount, 0) > 0))
  then v_warnings := array_append(v_warnings, 'credited_invoice'); end if;
  if exists (select 1 from public.invoice_line_items li
             where li.invoice_id = any(v_session_invoices)
               and li.session_id is distinct from v_session.id)
  then v_warnings := array_append(v_warnings, 'mixed_invoice'); end if;

  select coalesce(sum(crm_private.visit_request_net_paid(r.id)), 0) into v_deposit
  from public.payment_requests r
  where r.session_id = v_session.id and r.purpose = 'deposit'
    and r.currency = v_session.currency
    and (r.invoice_id is null or not (r.invoice_id = any(v_session_invoices)));

  select coalesce(sum(t.amount_paid), 0) into v_invoiced
  from public.invoices i
  cross join lateral crm_private.invoice_totals(i.id) t
  where i.id = any(v_session_invoices) and i.currency = v_session.currency
    and not exists (select 1 from public.invoice_line_items li
                    where li.invoice_id = i.id and li.session_id is distinct from v_session.id);

  -- Receipts explicitly assigned to this session must count even without an invoice.
  v_invoiced := v_invoiced + coalesce((
    select sum(crm_private.visit_request_net_paid(r.id))
    from public.payment_requests r
    where r.session_id = v_session.id and r.purpose = 'session_balance'
      and r.invoice_id is null and r.currency = v_session.currency
  ), 0);

  -- This session's unreleased share of a fully paid deposit group.
  v_deposit := v_deposit + coalesce((
    select sum(m.amount)
    from public.session_deposit_group_members m
    join public.session_deposit_groups g on g.id = m.group_id
    join public.payment_requests r on r.id = g.payment_request_id
    where m.session_id = v_session.id and m.released_at is null
      and m.currency = v_session.currency
      and crm_private.visit_request_net_paid(r.id) >= g.total_amount - 0.005
  ), 0);

  v_deposit := round(v_deposit, 2);
  v_invoiced := round(v_invoiced, 2);
  if v_price is not null and v_price + 0.005 < v_deposit + v_invoiced then
    v_warnings := array_append(v_warnings, 'overpaid');
  end if;

  select coalesce(array_agg(distinct w order by w), '{}') into v_warnings from unnest(v_warnings) w;

  if cardinality(v_warnings) = 0 and v_price is not null and v_price >= 0 then
    v_due := round(greatest(0, v_price - v_deposit - v_invoiced), 2);
  end if;

  if v_due is not null and v_due > 0 and cardinality(v_session_invoices) = 1 then
    select i.status, t.amount_outstanding into v_payable_status, v_payable_outstanding
    from public.invoices i cross join lateral crm_private.invoice_totals(i.id) t
    where i.id = v_session_invoices[1];
    if v_payable_status in ('issued', 'partially_paid')
       and abs(coalesce(v_payable_outstanding, -1) - v_due) < 0.005 then
      v_payable := v_session_invoices[1];
    end if;
  end if;

  return jsonb_build_object(
    'currency', v_session.currency,
    'price', v_price,
    'stored_price', v_session.price,
    'deposit_paid', v_deposit,
    'invoiced_paid', v_invoiced,
    'due', v_due,
    'warnings', to_jsonb(v_warnings),
    'session_invoice_count', cardinality(v_session_invoices),
    'payable_invoice_id', v_payable,
    'hourly_rate', v_project.hourly_rate,
    'project_currency', v_project.currency
  );
end;
$fn$;

-- Confirm a receipt entered by the operator in the immutable payments ledger.
-- An unknown allocation may hide the balance without invalidating a receipt.

create or replace function public.record_session_receipt(
  p_session_id uuid,
  p_request_id uuid,
  p_purpose text,
  p_amount numeric,
  p_method text,
  p_occurred_at timestamptz default null
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_session public.sessions%rowtype;
  v_project public.projects%rowtype;
  v_request public.payment_requests%rowtype;
  v_existing public.payment_transactions%rowtype;
  v_open_ids uuid[];
  v_open_balance numeric;
  v_finance jsonb;
  v_receipt jsonb;
  v_due numeric;
  v_paid numeric;
  v_when timestamptz := coalesce(p_occurred_at, now());
  v_note text := 'session_receipt_' || p_method;
  v_status public.payment_status;
  v_invoice_id uuid;
begin
  if p_request_id is null or p_purpose is null or p_purpose not in ('deposit','session_balance')
     or p_method is null or p_method not in ('cash','bank_transfer','card','studio_direct','other')
     or p_amount is null or not (p_amount between 0.01 and 100000)
     or p_amount <> round(p_amount, 2) or not isfinite(v_when) or v_when > clock_timestamp() then
    raise exception 'invalid receipt details' using errcode = '22023';
  end if;
  select * into v_session from public.sessions where id = p_session_id for update;
  if not found then
    raise exception 'appointment does not exist' using errcode = '23503';
  end if;
  perform crm_private.require_artist_access(v_session.artist_id, 'manage_finance');
  perform crm_private.require_active_artist(v_session.artist_id);
  select * into v_project from public.projects
  where id = v_session.project_id and artist_id = v_session.artist_id for update;
  if not found or v_project.client_id is distinct from v_session.client_id
     or v_project.currency is distinct from v_session.currency then
    raise exception 'a receipt requires an appointment linked to its client and project' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('session-receipt:' || p_request_id::text, 0));
  select * into v_existing from public.payment_transactions where idempotency_key = p_request_id;
  if found then
    select * into v_request from public.payment_requests where id = v_existing.payment_request_id;
    if v_request.artist_id is distinct from v_session.artist_id
       or v_request.session_id is distinct from p_session_id
       or v_request.purpose::text is distinct from p_purpose
       or v_existing.transaction_type <> 'manual_payment' or v_existing.direction <> 'credit'
       or v_existing.status <> 'succeeded' or v_existing.amount <> p_amount
       or v_existing.safe_note_code is distinct from v_note
       or (p_occurred_at is not null and v_existing.occurred_at is distinct from p_occurred_at) then
      raise exception 'receipt id was reused with different terms' using errcode = '22023';
    end if;
    return jsonb_build_object('payment_request_id', v_request.id, 'payment_transaction_id', v_existing.id,
      'amount', v_existing.amount, 'currency', v_existing.currency, 'confirmed', true,
      'payment_status', v_session.payment_status, 'replayed', true);
  end if;

  select * into v_request from public.payment_requests where idempotency_key = p_request_id;
  if found then
    select * into v_existing from public.payment_transactions
    where payment_request_id = v_request.id and transaction_type = 'manual_payment'
      and direction = 'credit' and status = 'succeeded' and safe_note_code = 'crm_invoice_payment';
    if p_purpose <> 'session_balance' or v_request.invoice_id is null
       or v_request.artist_id <> v_session.artist_id or v_request.project_id is distinct from v_session.project_id
       or v_request.payment_method_code is distinct from p_method
       or v_request.amount <> p_amount or v_existing.id is null
       or not exists (select 1 from public.invoice_line_items where invoice_id = v_request.invoice_id and session_id = p_session_id)
       or exists (select 1 from public.invoice_line_items where invoice_id = v_request.invoice_id and session_id is distinct from p_session_id)
       or (p_occurred_at is not null and v_existing.occurred_at is distinct from p_occurred_at) then
      raise exception 'receipt id was reused with different terms' using errcode = '22023';
    end if;
    return jsonb_build_object('payment_request_id', v_request.id, 'payment_transaction_id', v_existing.id,
      'amount', v_existing.amount, 'currency', v_existing.currency, 'confirmed', true,
      'payment_status', v_session.payment_status, 'replayed', true);
  end if;

  if v_project.archived_at is not null or v_project.status = 'cancelled'
     or v_session.appointment_type not in ('tattoo_session','touch_up')
     or v_session.status not in ('proposed','confirmed','completed')
     or (p_purpose = 'session_balance'
       and (v_session.start_at > now() or v_session.status = 'proposed')) then
    raise exception 'appointment cannot receive this payment' using errcode = '22023';
  end if;
  if v_session.payment_status = 'refunded'
     or (p_purpose = 'session_balance' and v_session.payment_status = 'paid') then
    raise exception 'this appointment already has a terminal payment status' using errcode = '23514';
  end if;

  v_finance := crm_private.visit_session_finance(p_session_id);
  if p_purpose = 'session_balance' then
    if (v_finance -> 'warnings') - 'unallocated_deposit' <> '[]'::jsonb then
      raise exception 'existing invoices or payment conflicts need review before recording this receipt'
        using errcode = '23514';
    end if;
    v_due := coalesce((v_finance ->> 'due')::numeric,
      v_session.price - (v_finance ->> 'deposit_paid')::numeric - (v_finance ->> 'invoiced_paid')::numeric);
    v_invoice_id := (v_finance ->> 'payable_invoice_id')::uuid;
    if (v_finance ->> 'session_invoice_count')::integer > 0 and v_invoice_id is null then
      raise exception 'existing invoices need review before recording this receipt' using errcode = '23514';
    end if;
    if v_due is null or p_amount > v_due then
      raise exception 'the amount received is more than the remaining balance or the session price is missing'
        using errcode = '23514';
    end if;
  end if;

  if p_purpose = 'deposit' and exists (
    select 1 from public.session_deposit_group_members m where m.session_id = p_session_id and m.released_at is null
  ) then
    raise exception 'record this receipt on the existing grouped deposit request' using errcode = '23514';
  end if;
  if v_invoice_id is not null then
    v_receipt := public.record_invoice_payment(v_invoice_id, p_request_id, p_amount, v_when, p_method, null);
  else
    select array_agg(r.id order by r.id) into v_open_ids
    from public.payment_requests r
    where r.session_id = p_session_id and r.purpose::text = p_purpose
      and r.currency = v_session.currency and r.invoice_id is null
      and r.status in ('pending','partially_paid')
      and (r.purpose <> 'deposit' or r.expires_at is null or r.expires_at > now());
    if cardinality(v_open_ids) > 1 then
      raise exception 'choose the exact existing payment request before recording the receipt' using errcode = '23514';
    elsif cardinality(v_open_ids) = 1 then
      select * into v_request from public.payment_requests where id = v_open_ids[1] for update;
      v_open_balance := v_request.amount - crm_private.payment_request_net_paid(v_request.id);
      if v_request.status not in ('pending','partially_paid') or p_amount > v_open_balance then
        raise exception 'the amount received is more than the remaining balance on the existing request' using errcode = '23514';
      end if;
    else
      if p_purpose = 'deposit' and v_session.price is not null
         and p_amount + (v_finance ->> 'deposit_paid')::numeric + (v_finance ->> 'invoiced_paid')::numeric > v_session.price then
        raise exception 'the amount received is more than the remaining balance' using errcode = '23514';
      end if;
      insert into public.payment_requests (
        idempotency_key, artist_id, client_id, project_id, session_id, purpose,
        amount, currency, policy_snapshot, payment_method_code, created_by
      ) values (
        md5(p_request_id::text || ':session-receipt-request')::uuid, v_session.artist_id,
        v_session.client_id, v_session.project_id, v_session.id, p_purpose::public.payment_request_purpose,
        p_amount, v_session.currency, jsonb_build_object('origin','manual_session_receipt'), p_method, auth.uid()
      ) returning * into v_request;
    end if;

    v_receipt := public.record_manual_payment(v_request.id, p_request_id, p_amount, v_when, v_note);
  end if;
  v_finance := crm_private.visit_session_finance(p_session_id);
  v_due := (v_finance ->> 'due')::numeric;
  v_paid := (v_finance ->> 'deposit_paid')::numeric + (v_finance ->> 'invoiced_paid')::numeric;
  v_status := case
    when v_session.payment_status = 'paid' or v_due = 0 then 'paid'
    when v_session.payment_status = 'part_paid' or (v_paid > 0 and p_purpose = 'session_balance') then 'part_paid'
    when v_paid > 0 then 'deposit_paid'
    else v_session.payment_status
  end;
  update public.sessions set payment_status = v_status
  where id = p_session_id and payment_status is distinct from v_status;

  return v_receipt || jsonb_build_object('amount', p_amount, 'currency', v_session.currency,
    'confirmed', true, 'payment_status', v_status, 'outstanding', v_due,
    'balance_needs_review', jsonb_array_length(v_finance -> 'warnings') > 0);
end;
$fn$;

revoke all on function public.record_session_receipt(uuid,uuid,text,numeric,text,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.record_session_receipt(uuid,uuid,text,numeric,text,timestamptz) to authenticated;

create or replace function public.gpt_record_session_receipt(
  p_session_id uuid,
  p_request_id uuid,
  p_purpose text,
  p_amount numeric,
  p_method text,
  p_occurred_at timestamptz default null
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare v_ctx record; v_artist uuid;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('finance', 'manage_finance');
  select s.artist_id into v_artist from public.sessions s where s.id = p_session_id;
  perform crm_private.require_gpt_record_artist(v_artist, v_ctx.artist_id, 'session');
  return public.record_session_receipt(p_session_id, p_request_id, p_purpose, p_amount, p_method, p_occurred_at);
end;
$fn$;

revoke all on function public.gpt_record_session_receipt(uuid,uuid,text,numeric,text,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.gpt_record_session_receipt(uuid,uuid,text,numeric,text,timestamptz) to authenticated;


alter table public.visit_outcomes drop constraint visit_outcomes_payment_method_check;
alter table public.visit_outcomes add constraint visit_outcomes_payment_method_check
  check (payment_method in ('cash','bank_transfer','card','other','studio_direct'));

create or replace function public.record_visit_outcome(
  p_session_id uuid,
  p_operation_id uuid,
  p_expected_version integer,
  p_outcome text,
  p_details jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_session public.sessions%rowtype;
  v_outcome public.visit_outcomes%rowtype;
  v_has_outcome boolean;
  v_revision public.visit_outcome_revisions%rowtype;
  v_details jsonb := coalesce(p_details, '{}'::jsonb);
  v_hash text;
  v_now timestamptz := clock_timestamp();
  v_is_tattoo boolean;
  v_target public.session_status;
  v_actor_kind text;
  v_manage_finance boolean;
  v_correction boolean;
  v_status_changed boolean := false;
  v_minutes integer;
  v_price numeric;
  v_received numeric := 0;
  v_method text;
  v_outside boolean := false;
  v_work text;
  v_notes text;
  v_linked uuid;
  v_follow_at timestamptz;
  v_follow_up uuid;
  v_existing_follow_up uuid;
  v_keep_finance boolean := false;
  v_close_enquiry boolean := false;
  v_enquiry_after public.enquiry_status;
  v_finance jsonb;
  v_after jsonb;
  v_invoice uuid;
  v_payment jsonb;
  v_effects jsonb := '{}'::jsonb;
  v_payment_state text;
  v_outstanding numeric;
  v_new_version integer;
  v_result jsonb;
  v_aftercare_sent boolean;
  v_enquiry_status public.enquiry_status;
begin
  if p_session_id is null or p_operation_id is null then
    raise exception 'an appointment and an operation id are required' using errcode = '22023';
  end if;
  if jsonb_typeof(v_details) <> 'object' then
    raise exception 'outcome details must be an object' using errcode = '22023';
  end if;

  -- One operation id is one decision. A retry with the same id and the same
  -- request returns the stored result and repeats no side effect.
  perform pg_advisory_xact_lock(hashtextextended('visit-outcome-op:' || p_operation_id::text, 0));
  v_hash := md5(jsonb_build_object('session', p_session_id, 'outcome', p_outcome,
    'expected', p_expected_version, 'details', v_details)::text);
  select * into v_revision from public.visit_outcome_revisions where operation_id = p_operation_id;
  if found then
    perform crm_private.require_artist_access(v_revision.artist_id, 'manage_sessions');
    if v_revision.session_id <> p_session_id or v_revision.request_hash <> v_hash then
      raise exception 'that outcome operation id was already used for a different request'
        using errcode = '22023';
    end if;
    return v_revision.result || jsonb_build_object('replayed', true);
  end if;

  select * into v_session from public.sessions where id = p_session_id for update;
  if not found then
    raise exception 'appointment does not exist' using errcode = '23503';
  end if;
  perform crm_private.require_artist_access(v_session.artist_id, 'manage_sessions');
  perform crm_private.require_active_artist(v_session.artist_id);
  v_manage_finance := crm_private.has_artist_capability(v_session.artist_id, 'manage_finance');
  v_actor_kind := case when public.is_owner() then 'owner' else 'staff' end;
  v_is_tattoo := v_session.appointment_type in ('tattoo_session', 'touch_up');

  select * into v_outcome from public.visit_outcomes where session_id = v_session.id for update;
  v_has_outcome := found;
  if coalesce(p_expected_version, -1) <> coalesce(v_outcome.version, 0) then
    raise exception 'this visit outcome was changed in another session; reload and try again'
      using errcode = '40001';
  end if;
  v_correction := v_has_outcome and v_outcome.state = 'confirmed';
  v_keep_finance := v_correction and not v_manage_finance
    and v_outcome.outcome = 'attended' and p_outcome = 'attended';

  -- Outcome vocabulary and the session status it implies.
  if v_is_tattoo then
    v_target := case p_outcome
      when 'attended' then 'completed' when 'no_show' then 'no_show'
      when 'cancelled' then 'cancelled' end;
  else
    v_target := case p_outcome
      when 'booked' then 'completed' when 'ready_to_book' then 'completed'
      when 'thinking' then 'completed' when 'declined' then 'completed'
      when 'no_show' then 'no_show' end;
  end if;
  if v_target is null then
    raise exception 'unknown outcome % for this appointment type', p_outcome using errcode = '22023';
  end if;

  -- Timing: no outcome before the visit could have happened.
  if v_is_tattoo then
    if v_session.start_at > v_now then
      raise exception 'this session has not started yet' using errcode = '22023';
    end if;
  elsif v_session.end_at > v_now then
    raise exception 'this consultation has not finished yet' using errcode = '22023';
  end if;

  -- Status eligibility. Draft/proposed bookings were never confirmed. A
  -- cancellation made elsewhere is final; only this workflow's own outcome
  -- may be corrected away from cancelled / no_show.
  if v_session.status in ('draft', 'proposed') then
    raise exception 'an unconfirmed appointment has no visit outcome' using errcode = '22023';
  end if;
  if v_session.status in ('cancelled', 'no_show') and not v_correction
     and v_session.status <> v_target then
    raise exception 'this appointment was already closed as %; reopen it first', v_session.status
      using errcode = '22023';
  end if;

  -- Money already received through this workflow cannot be turned into a
  -- no-show or cancellation; that needs a refund in project finances.
  if v_correction and v_outcome.received_via_outcome > 0 and p_outcome <> 'attended' then
    raise exception 'money was recorded for this visit; refund it in project finances before changing the outcome'
      using errcode = '23514';
  end if;

  v_notes := nullif(btrim(coalesce(v_details ->> 'notes', '')), '');
  if v_notes is not null and char_length(v_notes) > 2000 then
    raise exception 'notes are limited to 2000 characters' using errcode = '22023';
  end if;

  -- ------------------------------------------------------------- tattoo
  if v_is_tattoo and p_outcome = 'attended' then
    begin
      v_minutes := (v_details ->> 'worked_minutes')::integer;
      v_price := round((v_details ->> 'final_price')::numeric, 2);
      v_received := coalesce(round((v_details ->> 'received_now')::numeric, 2), 0);
    exception when others then
      raise exception 'duration and amounts must be numbers' using errcode = '22023';
    end;
    if v_minutes is null or v_minutes < 1 or v_minutes > 1440 then
      raise exception 'enter the actual working time (1 minute to 24 hours)' using errcode = '22023';
    end if;
    v_work := coalesce(v_details ->> 'work_result', 'work_complete');
    if v_work not in ('work_complete', 'next_session_needed', 'touch_up_needed') then
      raise exception 'unknown work result' using errcode = '22023';
    end if;
    v_method := nullif(v_details ->> 'payment_method', '');
    if v_method is not null and v_method not in ('cash', 'bank_transfer', 'card', 'other', 'studio_direct') then
      raise exception 'unknown payment method' using errcode = '22023';
    end if;
    v_outside := coalesce((v_details ->> 'paid_outside_crm')::boolean, false);
    if v_received < 0 or v_received > 100000 then
      raise exception 'the amount received is out of range' using errcode = '22023';
    end if;

    if v_price is null then
      if v_manage_finance then
        raise exception 'enter the final session price' using errcode = '22023';
      end if;
      if v_received > 0 or v_outside then
        raise exception 'recording money requires finance access' using errcode = '42501';
      end if;
    else
      if not v_manage_finance then
        raise exception 'confirming the session price requires finance access' using errcode = '42501';
      end if;
      if v_price <= 0 or v_price > 100000 then
        raise exception 'session price must be between 0.01 and 100000.00' using errcode = '22023';
      end if;
    end if;
    if v_received > 0 and v_method is null then
      raise exception 'choose how the money was received' using errcode = '22023';
    end if;
    if v_received > 0 and v_outside then
      raise exception 'money received now and money received outside the CRM are separate answers'
        using errcode = '22023';
    end if;
  elsif v_is_tattoo then
    if coalesce((v_details ->> 'received_now')::numeric, 0) <> 0 then
      raise exception 'a session that did not happen takes no payment here' using errcode = '22023';
    end if;
  end if;

  -- ------------------------------------------------------- consultation
  if not v_is_tattoo then
    if v_details ?| array['final_price', 'received_now', 'payment_method', 'paid_outside_crm', 'worked_minutes'] then
      raise exception 'consultations are free; no price or payment fields' using errcode = '22023';
    end if;
    if p_outcome = 'booked' then
      begin
        v_linked := (v_details ->> 'linked_session_id')::uuid;
      exception when others then
        raise exception 'invalid booking reference' using errcode = '22023';
      end;
      if v_linked is null or not exists (
        select 1 from public.sessions b
        where b.id = v_linked and b.artist_id = v_session.artist_id
          and b.client_id = v_session.client_id and b.id <> v_session.id
          and b.appointment_type in ('tattoo_session', 'touch_up')
          and b.cancelled_at is null and b.status in ('proposed', 'confirmed', 'completed')
      ) then
        raise exception 'choose an existing tattoo booking of this client' using errcode = '22023';
      end if;
    end if;
    if p_outcome in ('ready_to_book', 'thinking') and nullif(v_details ->> 'follow_up_at', '') is not null then
      begin
        v_follow_at := (v_details ->> 'follow_up_at')::timestamptz;
      exception when others then
        raise exception 'invalid follow-up date' using errcode = '22023';
      end;
      if v_follow_at < v_now - interval '1 day' or v_follow_at > v_now + interval '366 days' then
        raise exception 'the follow-up date must be within the next year' using errcode = '22023';
      end if;
    end if;
    v_close_enquiry := p_outcome = 'declined' and coalesce((v_details ->> 'close_enquiry')::boolean, false);
  end if;

  -- Lifecycle facts at the time of the decision (never revoked).
  v_aftercare_sent := v_is_tattoo and exists (
    select 1 from public.automation_jobs j
    where j.session_id = v_session.id and j.message_purpose = 'post_session_aftercare'
      and j.status = 'completed');

  -- ------------------------------------------------------- status change
  v_status_changed := crm_private.apply_visit_status(v_session, v_target, v_actor_kind);
  if v_status_changed then
    v_effects := v_effects || jsonb_build_object('status_from', v_session.status, 'status_to', v_target);
  end if;
  -- A correction back to a held visit must not release overdue post-session
  -- messages late: the scheduler already cancelled them for no_show/cancelled
  -- and never revives a cancelled job; any still-pending overdue one is
  -- withdrawn here. A message that was already sent stays sent.
  if v_status_changed and v_correction and v_target = 'completed' then
    update public.automation_jobs j
    set status = 'cancelled', cancelled_at = now(), last_error_category = 'appointment_ineligible'
    where j.session_id = v_session.id and j.artist_id = v_session.artist_id
      and j.status = 'pending'
      and j.action_type = 'send_client_message'::public.automation_action_type
      and j.schedule_anchor = 'session_end'::public.automation_schedule_anchor
      and j.scheduled_at <= v_now;
  end if;

  -- ------------------------------------------------------- money (tattoo)
  if v_is_tattoo and p_outcome = 'attended' and v_price is not null then
    v_finance := crm_private.visit_session_finance(v_session.id, v_price);
    if v_price + 0.005 < (v_finance ->> 'deposit_paid')::numeric + (v_finance ->> 'invoiced_paid')::numeric then
      raise exception 'the price is lower than money already recorded for this session' using errcode = '23514';
    end if;
    if v_session.price is distinct from v_price then
      update public.sessions set price = v_price where id = v_session.id;
      perform crm_private.log_artist_activity(
        v_session.artist_id, 'appointment.price_changed', v_actor_kind, auth.uid(),
        v_session.client_id, v_session.enquiry_id, v_session.project_id, v_session.id, null,
        jsonb_build_object('currency', v_session.currency, 'previous_price', v_session.price,
          'price', v_price, 'source', 'visit_outcome'));
      v_effects := v_effects || jsonb_build_object('price_set', true);
    end if;

    if v_received > 0 and v_finance -> 'warnings' = '["unallocated_deposit"]'::jsonb
       and (v_finance ->> 'session_invoice_count')::integer = 0 then
      v_payment := public.record_session_receipt(v_session.id,
        md5(p_operation_id::text || ':visit-payment')::uuid, 'session_balance', v_received, v_method, v_now);
      v_effects := v_effects || jsonb_build_object('payment_request_id', v_payment ->> 'payment_request_id');
    elsif v_received > 0 then
      if jsonb_array_length(v_finance -> 'warnings') > 0 or v_finance ->> 'due' is null then
        raise exception 'payments for this session need review in project finances before recording more'
          using errcode = '23514';
      end if;
      if v_received > (v_finance ->> 'due')::numeric + 0.005 then
        raise exception 'the amount received is more than the remaining balance (%)', v_finance ->> 'due'
          using errcode = '23514';
      end if;
      v_invoice := nullif(v_finance ->> 'payable_invoice_id', '')::uuid;
      if v_invoice is null then
        if (v_finance ->> 'session_invoice_count')::integer <> 0 then
          raise exception 'this session already has an invoice that does not match the balance; review it in project finances'
            using errcode = '23514';
        end if;
        v_invoice := (public.create_invoice(
          v_session.project_id, md5(p_operation_id::text || ':visit-invoice')::uuid, null,
          'Balance for one tattoo session. Deposit recorded separately.') ->> 'invoice_id')::uuid;
        perform public.set_invoice_line_item(v_invoice,
          'Tattoo session balance after allocated deposit', 1, (v_finance ->> 'due')::numeric,
          null, v_session.id, null);
        perform public.issue_invoice(v_invoice, null);
        v_effects := v_effects || jsonb_build_object('invoice_created', v_invoice);
      end if;
      v_payment := public.record_invoice_payment(v_invoice,
        md5(p_operation_id::text || ':visit-payment')::uuid, v_received, v_now, v_method, null);
      v_effects := v_effects || jsonb_build_object('invoice_id', v_invoice,
        'payment_request_id', v_payment ->> 'payment_request_id');
    end if;

    v_after := crm_private.visit_session_finance(v_session.id, v_price);
    if v_after ->> 'due' is null then
      v_payment_state := 'needs_review';
      v_outstanding := null;
    elsif v_outside or (v_after ->> 'due')::numeric = 0 then
      v_payment_state := 'paid';
      v_outstanding := 0;
    elsif (v_after ->> 'deposit_paid')::numeric + (v_after ->> 'invoiced_paid')::numeric > 0 then
      v_payment_state := 'part_paid';
      v_outstanding := (v_after ->> 'due')::numeric;
    else
      v_payment_state := 'unpaid';
      v_outstanding := (v_after ->> 'due')::numeric;
    end if;

    -- The legacy appointment badge only moves up, never down: an earlier
    -- manual "paid" can reflect money taken outside the ledger.
    if v_payment_state = 'paid' and v_session.payment_status <> 'paid' then
      update public.sessions set payment_status = 'paid' where id = v_session.id;
    elsif v_payment_state = 'part_paid' and v_session.payment_status in ('unpaid', 'deposit_paid') then
      update public.sessions set payment_status = 'part_paid' where id = v_session.id;
    end if;
  elsif v_is_tattoo and p_outcome = 'attended' then
    v_payment_state := 'not_recorded';
  end if;

  -- ---------------------------------------------- consultation follow-ups
  -- One reminder per consultation outcome. A correction moves the existing
  -- open reminder, or cancels it when the new answer needs none; it never
  -- leaves a second or obsolete task behind. The reminder is created on the
  -- appointment's own (already authorised) artist, never re-derived from a
  -- client that may be shared by several artists.
  if not v_is_tattoo then
    if v_correction and v_outcome.follow_up_id is not null then
      select f.id into v_existing_follow_up from public.follow_ups f
      where f.id = v_outcome.follow_up_id and f.artist_id = v_session.artist_id and f.status = 'open'
      for update;
    end if;
    if v_follow_at is not null then
      if v_existing_follow_up is not null then
        update public.follow_ups set due_at = v_follow_at,
          subject = case p_outcome when 'ready_to_book' then 'Agree a tattoo date after the consultation'
                                   else 'Check in after the consultation' end
        where id = v_existing_follow_up;
        v_follow_up := v_existing_follow_up;
        v_effects := v_effects || jsonb_build_object('follow_up_moved', v_follow_up);
      else
        perform crm_private.require_role('owner', 'booking_manager');
        perform crm_private.require_artist_access(v_session.artist_id, 'manage');
        insert into public.follow_ups (artist_id, subject, due_at, client_id, enquiry_id, created_by, details)
        values (v_session.artist_id,
          case p_outcome when 'ready_to_book' then 'Agree a tattoo date after the consultation'
                         else 'Check in after the consultation' end,
          v_follow_at, v_session.client_id, v_session.enquiry_id, auth.uid(),
          'Created from the visit outcome; no message is sent automatically.')
        returning id into v_follow_up;
        perform crm_private.log_artist_activity(
          v_session.artist_id, 'follow_up.created', v_actor_kind, auth.uid(),
          v_session.client_id, v_session.enquiry_id, null, null, null,
          jsonb_build_object('follow_up_id', v_follow_up, 'source', 'visit_outcome'));
        v_effects := v_effects || jsonb_build_object('follow_up_id', v_follow_up);
      end if;
    elsif v_existing_follow_up is not null then
      update public.follow_ups set status = 'cancelled', cancelled_at = now()
      where id = v_existing_follow_up;
      v_effects := v_effects || jsonb_build_object('follow_up_cancelled', v_existing_follow_up);
    end if;
  end if;
  if v_close_enquiry and v_session.enquiry_id is not null then
    select e.status into v_enquiry_status from public.enquiries e where e.id = v_session.enquiry_id;
    if v_enquiry_status not in ('declined', 'converted', 'closed') then
      perform public.transition_enquiry_status(v_session.enquiry_id, 'declined');
      v_enquiry_after := 'declined';
      v_effects := v_effects || jsonb_build_object('enquiry_status', 'declined');
    else
      v_enquiry_after := v_enquiry_status;
    end if;
  end if;

  -- --------------------------------------------------------- persist
  v_new_version := coalesce(v_outcome.version, 0) + 1;
  if v_has_outcome then
    update public.visit_outcomes o set
      state = 'confirmed', outcome = p_outcome,
      work_result = case when v_is_tattoo and p_outcome = 'attended' then v_work end,
      worked_minutes = case when v_is_tattoo and p_outcome = 'attended' then v_minutes end,
      -- Someone without finance access may correct time, result or notes,
      -- but never erases money facts an authorised person confirmed.
      final_price = case when v_keep_finance then o.final_price
                         when v_is_tattoo and p_outcome = 'attended' then v_price end,
      currency = case when v_is_tattoo then v_session.currency end,
      deposit_applied = case when v_keep_finance then o.deposit_applied
                             when v_after is not null then (v_after ->> 'deposit_paid')::numeric end,
      previously_received = case when v_keep_finance then o.previously_received
                                 when v_finance is not null then (v_finance ->> 'invoiced_paid')::numeric end,
      received_via_outcome = o.received_via_outcome + v_received,
      outstanding = case when v_keep_finance then o.outstanding else v_outstanding end,
      payment_state = case when v_keep_finance then o.payment_state else v_payment_state end,
      payment_method = case when v_keep_finance then o.payment_method
                            when v_received > 0 then v_method
                            when v_is_tattoo and p_outcome = 'attended' then coalesce(v_method, o.payment_method) end,
      paid_outside_crm = case when v_keep_finance then o.paid_outside_crm else v_outside end,
      linked_session_id = v_linked,
      follow_up_id = v_follow_up,
      enquiry_status_after = coalesce(v_enquiry_after, case when p_outcome = 'declined' then o.enquiry_status_after end),
      notes = v_notes,
      aftercare_sent_before_outcome = v_aftercare_sent,
      deferred_until = null,
      version = v_new_version,
      confirmed_by = coalesce(o.confirmed_by, auth.uid()),
      confirmed_at = coalesce(o.confirmed_at, v_now),
      updated_by = auth.uid()
    where o.id = v_outcome.id
    returning * into v_outcome;
  else
    insert into public.visit_outcomes (
      session_id, artist_id, client_id, appointment_type, state, outcome,
      work_result, worked_minutes, final_price, currency, deposit_applied,
      previously_received, received_via_outcome, outstanding, payment_state,
      payment_method, paid_outside_crm, linked_session_id, follow_up_id,
      enquiry_status_after, notes, aftercare_sent_before_outcome,
      version, confirmed_by, confirmed_at, updated_by
    ) values (
      v_session.id, v_session.artist_id, v_session.client_id, v_session.appointment_type,
      'confirmed', p_outcome,
      case when v_is_tattoo and p_outcome = 'attended' then v_work end,
      case when v_is_tattoo and p_outcome = 'attended' then v_minutes end,
      case when v_is_tattoo and p_outcome = 'attended' then v_price end,
      case when v_is_tattoo then v_session.currency end,
      case when v_after is not null then (v_after ->> 'deposit_paid')::numeric end,
      case when v_finance is not null then (v_finance ->> 'invoiced_paid')::numeric end,
      v_received, v_outstanding, v_payment_state,
      case when v_is_tattoo and p_outcome = 'attended' then v_method end,
      v_outside, v_linked, v_follow_up, v_enquiry_after, v_notes, v_aftercare_sent,
      v_new_version, auth.uid(), v_now, auth.uid()
    ) returning * into v_outcome;
  end if;

  v_result := jsonb_build_object(
    'session_id', v_session.id, 'outcome', p_outcome, 'state', 'confirmed',
    'version', v_new_version, 'correction', v_correction,
    'session_status', v_target, 'payment_state', v_outcome.payment_state,
    'aftercare_already_sent', v_aftercare_sent,
    'effects', v_effects, 'replayed', false);

  insert into public.visit_outcome_revisions (
    operation_id, outcome_id, session_id, artist_id, version, action,
    request_hash, snapshot, effects, result, created_by
  ) values (
    p_operation_id, v_outcome.id, v_session.id, v_session.artist_id, v_new_version,
    case when v_correction then 'correct' else 'confirm' end,
    v_hash, to_jsonb(v_outcome), v_effects, v_result, auth.uid());

  -- Activity carries no money: the activity feed is visible without finance access.
  perform crm_private.log_artist_activity(
    v_session.artist_id, 'visit.outcome_recorded', v_actor_kind, auth.uid(),
    v_session.client_id, v_session.enquiry_id, v_session.project_id, v_session.id, null,
    jsonb_build_object('appointment_type', v_session.appointment_type, 'outcome', p_outcome,
      'correction', v_correction, 'version', v_new_version));

  return v_result;
end;
$fn$;

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
        'purpose', r.purpose, 'session_start_at', s.start_at,
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
     and abs(extract(epoch from (pt.occurred_at - c.occurred_at))) <= 604800
    join public.payment_requests r
      on r.id = pt.payment_request_id
     and r.artist_id = c.artist_id
     and r.currency = c.currency
    left join public.invoices i
      on i.id = r.invoice_id
     and i.artist_id = c.artist_id
     and i.client_id = r.client_id
     and i.issued_at is not null
     and i.voided_at is null
    left join public.sessions s on s.id = r.session_id and s.artist_id = r.artist_id
    join public.clients cl on cl.id = r.client_id
    where (
      (r.purpose = 'additional_payment' and r.status = 'paid' and r.amount = pt.amount
       and i.id is not null and r.payment_method_code is distinct from 'cash'
       and r.payment_method_code is distinct from 'studio_direct')
      or (r.purpose in ('deposit','session_balance') and r.invoice_id is null and s.id is not null
        and pt.safe_note_code = 'session_receipt_bank_transfer'
        and r.status in ('partially_paid','paid'))
    )
      and c.id = p_candidate_id
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
     or abs(extract(epoch from (v_receipt.occurred_at - v_candidate.occurred_at))) > 604800 then
    raise exception 'recorded receipt does not match bank evidence' using errcode='22023';
  end if;

  select * into v_request from public.payment_requests
  where id = v_receipt.payment_request_id for update;
  if not found or v_request.artist_id <> v_candidate.artist_id
     or v_request.currency <> v_candidate.currency
     or crm_private.payment_request_net_paid(v_request.id) < v_receipt.amount then
    raise exception 'receipt request is no longer eligible' using errcode='22023';
  end if;

  if v_request.purpose = 'additional_payment' and v_request.invoice_id is not null then
    select * into v_invoice from public.invoices
    where id = v_request.invoice_id for update;
    if not found or v_invoice.artist_id <> v_candidate.artist_id
       or v_invoice.client_id <> v_request.client_id
       or v_invoice.project_id <> v_request.project_id
       or v_invoice.issued_at is null or v_invoice.voided_at is not null
       or v_request.status <> 'paid' or v_request.amount <> v_receipt.amount
       or v_request.payment_method_code in ('cash','studio_direct') then
      raise exception 'recorded invoice is no longer eligible' using errcode='22023';
    end if;
  elsif v_request.purpose not in ('deposit','session_balance')
     or v_request.invoice_id is not null or v_request.session_id is null
     or v_receipt.safe_note_code is distinct from 'session_receipt_bank_transfer'
     or v_request.status not in ('partially_paid','paid') then
    raise exception 'recorded session payment is no longer eligible' using errcode='22023';
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

revoke all on function public.link_monzo_recorded_receipt(uuid, uuid) from public, anon, service_role;
grant execute on function public.link_monzo_recorded_receipt(uuid, uuid) to authenticated;

-- The operator may identify an unassigned transfer without a prior request.
-- Lock and verify the bank evidence before posting, and link both in the same transaction.
create or replace function public.confirm_monzo_session_receipt(
  p_candidate_id uuid, p_session_id uuid, p_purpose text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_candidate public.payment_reconciliation_candidates%rowtype;
  v_session public.sessions%rowtype;
  v_receipt jsonb;
  v_linked uuid;
  v_key uuid;
begin
  select * into v_candidate from public.payment_reconciliation_candidates
  where id = p_candidate_id and provider = 'monzo_easy_bank_transfer' for update;
  if not found then
    raise exception 'verified Monzo transfer not found' using errcode = '23503';
  end if;
  perform crm_private.require_artist_access(v_candidate.artist_id, 'manage_finance');
  select * into v_session from public.sessions
  where id = p_session_id and artist_id = v_candidate.artist_id;
  if not found or v_session.currency <> v_candidate.currency then
    raise exception 'artist access is not permitted for this transfer and appointment' using errcode = '42501';
  end if;

  v_key := md5(p_candidate_id::text || ':confirmed-session-receipt')::uuid;
  select t.idempotency_key into v_linked
  from public.monzo_recorded_receipt_links l
  join public.payment_transactions t on t.id = l.payment_transaction_id
  join public.payment_requests r on r.id = t.payment_request_id
  where l.candidate_id = p_candidate_id and l.artist_id = v_candidate.artist_id;
  if v_linked is not null then
    if v_linked <> v_key and not exists (
      select 1 from public.payment_requests r
      join public.payment_transactions t on t.payment_request_id = r.id
      where r.idempotency_key = v_key and t.idempotency_key = v_linked
    ) then
      raise exception 'bank transfer is already assigned' using errcode = '23514';
    end if;
    return public.record_session_receipt(p_session_id, v_key, p_purpose,
      v_candidate.amount, 'bank_transfer', v_candidate.occurred_at);
  end if;

  if v_candidate.status not in ('unmatched','candidate','ambiguous')
     or v_candidate.matched_payment_request_id is not null
     or crm_private.monzo_recorded_receipt_options(p_candidate_id) <> '[]'::jsonb
     or exists (
       select 1 from public.payment_transactions t
       where t.provider = v_candidate.provider and t.provider_transaction_id = v_candidate.provider_transaction_id
     ) then
    raise exception 'reconcile this transfer with its existing receipt or match first' using errcode = '23514';
  end if;

  v_receipt := public.record_session_receipt(p_session_id, v_key, p_purpose,
    v_candidate.amount, 'bank_transfer', v_candidate.occurred_at);
  perform public.link_monzo_recorded_receipt(p_candidate_id, (v_receipt->>'payment_transaction_id')::uuid);
  return v_receipt;
end;
$fn$;

revoke all on function public.confirm_monzo_session_receipt(uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.confirm_monzo_session_receipt(uuid,uuid,text) to authenticated;
