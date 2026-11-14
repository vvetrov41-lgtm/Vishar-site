-- Visit outcomes: a deposit paid once for several sessions (a deposit group)
-- is allocated to each session by its group member row. The first version of
-- visit_session_finance read such a payment as "unallocated" (it has no
-- session_id of its own) and refused to compute a balance, so an artist whose
-- client paid one deposit for four sessions could not record the money for the
-- first visit. Now:
--   * a project deposit request that backs a deposit group is not "unallocated";
--   * this session's unreleased member amount counts as its deposit, but only
--     while the whole group request is fully paid in the ledger and in the
--     session's currency; otherwise the session is flagged for review;
--   * a paid project deposit with neither a session nor a group still needs review.
-- Read-only calculation: no row is written, no money moves, no message is sent.

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
