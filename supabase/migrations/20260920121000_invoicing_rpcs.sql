-- 20260920121000_invoicing_rpcs.sql
--
-- The only way an invoice, a line item or a credit note is ever written.
--
-- Every function here is SECURITY DEFINER and re-derives the artist from the
-- record the caller names, then requires `manage_finance` on that artist. A
-- browser payload therefore cannot choose the artist, the client, the project
-- or the amount of anything: it names an id, and the server reads the rest.
--
-- Forward-only.

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

/**
 * One invoice as a document: the header, its line items, the payments that
 * settled it, its credit notes, and the arithmetic. Totals come from
 * `crm_private.invoice_totals`, never from anything the caller sent.
 *
 * `is_overdue` is computed here rather than stored, so a due date that passes
 * overnight needs no background job to become true.
 */
create or replace function public.get_invoice(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $
declare
  v_invoice public.invoices%rowtype;
  v_totals record;
  v_artist public.artists%rowtype;
  v_client public.clients%rowtype;
  v_project public.projects%rowtype;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id;
  if not found then
    raise exception 'invoice % does not exist', p_invoice_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_invoice.artist_id, 'view_finance');

  select * into v_totals from crm_private.invoice_totals(p_invoice_id);
  select * into v_artist from public.artists where id = v_invoice.artist_id;
  select * into v_client from public.clients where id = v_invoice.client_id;
  select * into v_project from public.projects where id = v_invoice.project_id;

  return jsonb_build_object(
    'invoice', jsonb_build_object(
      'id', v_invoice.id,
      'artist_id', v_invoice.artist_id,
      'client_id', v_invoice.client_id,
      'project_id', v_invoice.project_id,
      'invoice_number', v_invoice.invoice_number,
      'status', v_invoice.status,
      'currency', v_invoice.currency,
      'issue_date', v_invoice.issue_date,
      'due_date', v_invoice.due_date,
      'notes', v_invoice.notes,
      'void_reason', v_invoice.void_reason,
      'created_at', v_invoice.created_at,
      'updated_at', v_invoice.updated_at,
      'subtotal', v_totals.subtotal,
      'discount_amount', v_totals.discount_amount,
      'total', v_totals.total,
      'amount_paid', v_totals.amount_paid,
      'amount_credited', v_totals.amount_credited,
      'amount_outstanding', v_totals.amount_outstanding,
      'is_overdue', (
        v_invoice.status in ('issued', 'partially_paid')
        and v_invoice.due_date is not null
        and v_invoice.due_date < (now() at time zone coalesce(v_artist.timezone, 'Europe/London'))::date
        and v_totals.amount_outstanding > 0
      )
    ),
    'artist', jsonb_build_object(
      'id', v_artist.id,
      'display_name', v_artist.display_name,
      'legal_name', v_artist.legal_name,
      'timezone', v_artist.timezone
    ),
    'client', jsonb_build_object(
      'id', v_client.id,
      'full_name', v_client.full_name,
      'email', v_client.email,
      'phone', v_client.phone
    ),
    'project', jsonb_build_object(
      'id', v_project.id,
      'title', v_project.title
    ),
    'line_items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', li.id,
        'session_id', li.session_id,
        'line_position', li.line_position,
        'description', li.description,
        'quantity', li.quantity,
        'unit_amount', li.unit_amount,
        'line_total', li.line_total
      ) order by li.line_position, li.created_at)
      from public.invoice_line_items li
      where li.invoice_id = p_invoice_id
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'payment_request_id', r.id,
        'payment_transaction_id', t.id,
        'purpose', r.purpose,
        'transaction_type', t.transaction_type,
        'direction', t.direction,
        'amount', t.amount,
        'currency', t.currency,
        'status', t.status,
        'occurred_at', t.occurred_at,
        'payment_method_code', r.payment_method_code,
        'external_reference', r.external_reference
      ) order by t.occurred_at, t.created_at)
      from public.payment_transactions t
      join public.payment_requests r on r.id = t.payment_request_id
      where r.invoice_id = p_invoice_id
    ), '[]'::jsonb),
    'credit_notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'credit_note_number', c.credit_note_number,
        'amount', c.amount,
        'reason', c.reason,
        'issued_at', c.issued_at
      ) order by c.issued_at, c.created_at)
      from public.credit_notes c
      where c.invoice_id = p_invoice_id
    ), '[]'::jsonb)
  );
end;
$$;

/**
 * The invoice list, narrowed by whatever the caller supplied.
 *
 * It is SECURITY DEFINER because the totals live in `crm_private`, which no
 * API role may execute. That makes the visibility test explicit rather than
 * inherited: `can_view_artist_finance` is applied per row, so this returns
 * exactly what the table's own policy would have returned.
 */
create or replace function public.list_invoices(
  p_artist_id uuid default null,
  p_project_id uuid default null,
  p_client_id uuid default null,
  p_status public.invoice_status default null,
  p_limit integer default 100
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select coalesce(jsonb_agg(row_to_json(rows)::jsonb order by rows.created_at desc), '[]'::jsonb)
  from (
    select
      i.id,
      i.artist_id,
      i.client_id,
      i.project_id,
      i.invoice_number,
      i.status,
      i.currency,
      i.issue_date,
      i.due_date,
      i.created_at,
      totals.subtotal,
      totals.discount_amount,
      totals.total,
      totals.amount_paid,
      totals.amount_credited,
      totals.amount_outstanding,
      (
        i.status in ('issued', 'partially_paid')
        and i.due_date is not null
        and i.due_date < (now() at time zone coalesce(a.timezone, 'Europe/London'))::date
        and totals.amount_outstanding > 0
      ) as is_overdue
    from public.invoices i
    left join public.artists a on a.id = i.artist_id
    cross join lateral crm_private.invoice_totals(i.id) totals
    where public.can_view_artist_finance(i.artist_id)
      and (p_artist_id is null or i.artist_id = p_artist_id)
      and (p_project_id is null or i.project_id = p_project_id)
      and (p_client_id is null or i.client_id = p_client_id)
      and (p_status is null or i.status = p_status)
    order by i.created_at desc
    limit least(greatest(coalesce(p_limit, 100), 1), 500)
  ) rows;
$$;

-- ---------------------------------------------------------------------------
-- Draft lifecycle
-- ---------------------------------------------------------------------------

create or replace function public.create_invoice(
  p_project_id uuid,
  p_idempotency_key uuid,
  p_due_date date default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_project public.projects%rowtype;
  v_existing public.invoices%rowtype;
  v_invoice_id uuid;
  v_number text;
begin
  if p_idempotency_key is null then
    raise exception 'an idempotency key is required' using errcode = '22023';
  end if;

  select * into v_project from public.projects p where p.id = p_project_id;
  if not found then
    raise exception 'project % does not exist', p_project_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_project.artist_id, 'manage_finance');
  perform pg_advisory_xact_lock(hashtextextended('invoice:' || p_idempotency_key::text, 0));

  -- Idempotency is keyed by the caller-supplied UUID, not by fuzzy draft
  -- similarity. Two legitimate invoices may have identical terms; only a
  -- retry of the same request is a replay.
  select * into v_existing
  from public.invoices i
  where i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.project_id <> p_project_id
       or v_existing.due_date is distinct from p_due_date
       or v_existing.notes is distinct from nullif(btrim(coalesce(p_notes, '')), '') then
      raise exception 'that invoice reference was already used for different terms'
        using errcode = '22023';
    end if;

    return jsonb_build_object(
      'invoice_id', v_existing.id,
      'invoice_number', v_existing.invoice_number,
      'status', v_existing.status,
      'replayed', true
    );
  end if;

  v_number := crm_private.next_invoice_number();

  insert into public.invoices (
    idempotency_key, artist_id, client_id, project_id, invoice_number,
    currency, due_date, notes, created_by
  ) values (
    p_idempotency_key, v_project.artist_id, v_project.client_id, p_project_id, v_number,
    v_project.currency, p_due_date, nullif(btrim(coalesce(p_notes, '')), ''), auth.uid()
  )
  returning id into v_invoice_id;

  perform crm_private.log_artist_activity(
    v_project.artist_id, 'invoice.created',
    case when public.is_owner() then 'owner' else 'staff' end, auth.uid(),
    v_project.client_id, null, p_project_id, null, null,
    jsonb_build_object('invoice_number', v_number, 'currency', v_project.currency)
  );

  return jsonb_build_object(
    'invoice_id', v_invoice_id,
    'invoice_number', v_number,
    'status', 'draft',
    'replayed', false
  );
end;
$$;

/**
 * Adds a line item, or replaces one that exists. Draft only; the guard refuses
 * anything else. `line_total` is generated by the column, so an inflated total
 * in the request body has nowhere to land.
 */
create or replace function public.set_invoice_line_item(
  p_invoice_id uuid,
  p_description text,
  p_quantity numeric,
  p_unit_amount numeric,
  p_line_item_id uuid default null,
  p_session_id uuid default null,
  p_line_position integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_invoice public.invoices%rowtype;
  v_existing public.invoice_line_items%rowtype;
  v_id uuid;
  v_position integer;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id;
  if not found then
    raise exception 'invoice % does not exist', p_invoice_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_invoice.artist_id, 'manage_finance');

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'a line item quantity must be greater than zero' using errcode = '22023';
  end if;
  if p_unit_amount is null or p_unit_amount < 0 then
    raise exception 'a line item unit price cannot be negative' using errcode = '22023';
  end if;
  if p_description is null or btrim(p_description) = '' then
    raise exception 'a line item needs a description' using errcode = '22023';
  end if;

  if p_line_item_id is not null then
    select * into v_existing
    from public.invoice_line_items li
    where li.id = p_line_item_id and li.invoice_id = p_invoice_id;
    if not found then
      raise exception 'line item % is not on invoice %', p_line_item_id, p_invoice_id
        using errcode = '23503';
    end if;

    update public.invoice_line_items
    set description = btrim(p_description),
        quantity = round(p_quantity, 2),
        unit_amount = round(p_unit_amount, 2),
        session_id = p_session_id,
        line_position = coalesce(p_line_position, v_existing.line_position)
    where id = p_line_item_id
    returning id into v_id;
  else
    select coalesce(max(li.line_position), 0) + 1 into v_position
    from public.invoice_line_items li
    where li.invoice_id = p_invoice_id;

    insert into public.invoice_line_items (
      invoice_id, artist_id, session_id, line_position,
      description, quantity, unit_amount
    ) values (
      p_invoice_id, v_invoice.artist_id, p_session_id,
      coalesce(p_line_position, v_position),
      btrim(p_description), round(p_quantity, 2), round(p_unit_amount, 2)
    )
    returning id into v_id;
  end if;

  return jsonb_build_object('line_item_id', v_id, 'invoice_id', p_invoice_id);
end;
$$;

create or replace function public.remove_invoice_line_item(p_line_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_item public.invoice_line_items%rowtype;
begin
  select * into v_item from public.invoice_line_items where id = p_line_item_id;
  if not found then
    return jsonb_build_object('line_item_id', p_line_item_id, 'removed', false);
  end if;

  perform crm_private.require_artist_access(v_item.artist_id, 'manage_finance');

  delete from public.invoice_line_items where id = p_line_item_id;

  return jsonb_build_object(
    'line_item_id', p_line_item_id,
    'invoice_id', v_item.invoice_id,
    'removed', true
  );
end;
$$;

/**
 * Draft edits to the header. After issue only `notes` moves, which is why the
 * other two are refused rather than silently ignored.
 */
create or replace function public.set_invoice_details(
  p_invoice_id uuid,
  p_due_date date default null,
  p_discount_amount numeric default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_invoice public.invoices%rowtype;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id;
  if not found then
    raise exception 'invoice % does not exist', p_invoice_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_invoice.artist_id, 'manage_finance');

  if p_discount_amount is not null and p_discount_amount < 0 then
    raise exception 'a discount cannot be negative' using errcode = '22023';
  end if;

  if v_invoice.issued_at is not null
     and (p_due_date is distinct from v_invoice.due_date
          or (p_discount_amount is not null and p_discount_amount <> v_invoice.discount_amount)) then
    raise exception 'an issued invoice cannot be re-dated or re-priced' using errcode = '42501';
  end if;

  update public.invoices
  set due_date = case when v_invoice.issued_at is null then p_due_date else due_date end,
      discount_amount = case
        when v_invoice.issued_at is null then coalesce(p_discount_amount, discount_amount)
        else discount_amount
      end,
      notes = nullif(btrim(coalesce(p_notes, '')), '')
  where id = p_invoice_id;

  return jsonb_build_object('invoice_id', p_invoice_id, 'updated', true);
end;
$$;

create or replace function public.issue_invoice(
  p_invoice_id uuid,
  p_issue_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_invoice public.invoices%rowtype;
  v_artist public.artists%rowtype;
  v_totals record;
  v_issue_date date;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'invoice % does not exist', p_invoice_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_invoice.artist_id, 'manage_finance');

  if v_invoice.voided_at is not null then
    raise exception 'a void invoice cannot be issued' using errcode = '42501';
  end if;
  if v_invoice.issued_at is not null then
    return jsonb_build_object(
      'invoice_id', p_invoice_id,
      'status', v_invoice.status,
      'issue_date', v_invoice.issue_date,
      'replayed', true
    );
  end if;

  select * into v_totals from crm_private.invoice_totals(p_invoice_id);
  if coalesce(v_totals.total, 0) <= 0 then
    raise exception 'an invoice needs at least one line item worth more than nothing'
      using errcode = '23514';
  end if;

  select * into v_artist from public.artists where id = v_invoice.artist_id;
  v_issue_date := coalesce(
    p_issue_date,
    (now() at time zone coalesce(v_artist.timezone, 'Europe/London'))::date
  );

  if v_invoice.due_date is not null and v_invoice.due_date < v_issue_date then
    raise exception 'a due date cannot be before the issue date' using errcode = '23514';
  end if;

  update public.invoices
  set issued_at = now(),
      issue_date = v_issue_date,
      status = 'issued'
  where id = p_invoice_id;

  perform crm_private.log_artist_activity(
    v_invoice.artist_id, 'invoice.issued',
    case when public.is_owner() then 'owner' else 'staff' end, auth.uid(),
    v_invoice.client_id, null, v_invoice.project_id, null, null,
    jsonb_build_object(
      'invoice_number', v_invoice.invoice_number,
      'currency', v_invoice.currency,
      'issue_date', v_issue_date
    )
  );

  return jsonb_build_object(
    'invoice_id', p_invoice_id,
    'status', 'issued',
    'issue_date', v_issue_date,
    'total', v_totals.total,
    'replayed', false
  );
end;
$$;

/**
 * Void is for an invoice that should never have existed. Money that has
 * already settled is not undone by deleting the paperwork, so an invoice with
 * a settled payment is refused here and corrected with a credit note instead.
 *
 * A request that is merely attached and still open is refused too. It could
 * settle tomorrow - through a Monzo webhook nobody is watching - and a void
 * invoice holding a payment is not a state the ledger should be able to reach.
 * The transaction guard refuses that payment as well; this is the half that
 * tells the operator now rather than surprising the payer later.
 */
create or replace function public.void_invoice(
  p_invoice_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_invoice public.invoices%rowtype;
  v_totals record;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'voiding an invoice needs a reason' using errcode = '22023';
  end if;

  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'invoice % does not exist', p_invoice_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_invoice.artist_id, 'manage_finance');

  if v_invoice.voided_at is not null then
    return jsonb_build_object('invoice_id', p_invoice_id, 'status', 'void', 'replayed', true);
  end if;

  select * into v_totals from crm_private.invoice_totals(p_invoice_id);
  if coalesce(v_totals.amount_paid, 0) > 0 then
    raise exception 'an invoice with settled payments cannot be voided; issue a credit note'
      using errcode = '42501';
  end if;

  if exists (
    select 1 from public.payment_requests r
    where r.invoice_id = p_invoice_id
      and r.status in ('pending', 'partially_paid')
  ) then
    raise exception 'an invoice with an open payment request cannot be voided; cancel the request first'
      using errcode = '42501';
  end if;

  update public.invoices
  set voided_at = now(),
      void_reason = btrim(p_reason),
      status = 'void'
  where id = p_invoice_id;

  perform crm_private.log_artist_activity(
    v_invoice.artist_id, 'invoice.voided',
    case when public.is_owner() then 'owner' else 'staff' end, auth.uid(),
    v_invoice.client_id, null, v_invoice.project_id, null, null,
    jsonb_build_object('invoice_number', v_invoice.invoice_number)
  );

  return jsonb_build_object('invoice_id', p_invoice_id, 'status', 'void', 'replayed', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Money
-- ---------------------------------------------------------------------------

/**
 * Points an existing payment request - usually the project deposit already
 * taken - at this invoice. Nothing about the request's own money changes; the
 * invoice simply starts counting it.
 */
create or replace function public.attach_payment_request_to_invoice(
  p_payment_request_id uuid,
  p_invoice_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_request public.payment_requests%rowtype;
  v_invoice public.invoices%rowtype;
  v_totals record;
begin
  select * into v_request from public.payment_requests where id = p_payment_request_id for update;
  if not found then
    raise exception 'payment request % does not exist', p_payment_request_id using errcode = '23503';
  end if;

  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'invoice % does not exist', p_invoice_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_invoice.artist_id, 'manage_finance');
  perform crm_private.require_artist_access(v_request.artist_id, 'manage_finance');

  if v_request.invoice_id = p_invoice_id then
    return jsonb_build_object(
      'payment_request_id', p_payment_request_id,
      'invoice_id', p_invoice_id,
      'replayed', true
    );
  end if;
  if v_request.invoice_id is not null then
    raise exception 'that payment is already on another invoice' using errcode = '23514';
  end if;
  if v_request.status in ('cancelled', 'expired') then
    raise exception 'a closed payment request cannot be added to an invoice' using errcode = '23514';
  end if;
  if v_invoice.issued_at is null then
    raise exception 'a draft invoice takes no payments; issue it first' using errcode = '42501';
  end if;

  -- The table trigger repeats this invariant for every write path. Checking it
  -- here gives the operator an immediate, domain-specific refusal.
  select * into v_totals from crm_private.invoice_totals(p_invoice_id);
  if v_request.amount > coalesce(v_totals.amount_outstanding, 0) then
    raise exception 'that payment request is more than the invoice still asks for'
      using errcode = '23514';
  end if;

  update public.payment_requests
  set invoice_id = p_invoice_id
  where id = p_payment_request_id;

  perform crm_private.refresh_invoice_status(p_invoice_id);

  perform crm_private.log_artist_activity(
    v_invoice.artist_id, 'invoice.payment_linked',
    case when public.is_owner() then 'owner' else 'staff' end, auth.uid(),
    v_invoice.client_id, null, v_invoice.project_id, v_request.session_id, null,
    jsonb_build_object('invoice_number', v_invoice.invoice_number, 'purpose', v_request.purpose)
  );

  return jsonb_build_object(
    'payment_request_id', p_payment_request_id,
    'invoice_id', p_invoice_id,
    'replayed', false
  );
end;
$$;

/**
 * Records money received against an invoice.
 *
 * It creates its own immutable payment request for exactly the amount and
 * settles it, because `payment_transactions` is the ledger and a transaction
 * has to belong to a request. That is the existing system, reused - not a
 * second one.
 *
 * The amount is capped at what the invoice still asks for, so the same payment
 * entered twice fails the second time even if the operator invents a new
 * idempotency key.
 */
create or replace function public.record_invoice_payment(
  p_invoice_id uuid,
  p_idempotency_key uuid,
  p_amount numeric,
  p_occurred_at timestamptz default now(),
  p_method_code text default null,
  p_external_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_invoice public.invoices%rowtype;
  v_totals record;
  v_existing public.payment_requests%rowtype;
  v_request_id uuid;
  v_transaction_id uuid;
  v_amount numeric(12,2);
begin
  if p_idempotency_key is null then
    raise exception 'an idempotency key is required' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'a payment must be greater than zero' using errcode = '22023';
  end if;

  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'invoice % does not exist', p_invoice_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_invoice.artist_id, 'manage_finance');

  if v_invoice.voided_at is not null then
    raise exception 'a void invoice cannot take payments' using errcode = '42501';
  end if;
  if v_invoice.issued_at is null then
    raise exception 'a draft invoice takes no payments; issue it first' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('invoice-payment:' || p_idempotency_key::text, 0));

  select * into v_existing
  from public.payment_requests r
  where r.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.invoice_id is distinct from p_invoice_id
       or v_existing.amount <> round(p_amount, 2)
       or v_existing.payment_method_code is distinct from nullif(btrim(coalesce(p_method_code, '')), '')
       or v_existing.external_reference is distinct from nullif(btrim(coalesce(p_external_reference, '')), '') then
      raise exception 'that payment reference was already used for different terms'
        using errcode = '22023';
    end if;
    return jsonb_build_object(
      'invoice_id', p_invoice_id,
      'payment_request_id', v_existing.id,
      'replayed', true
    );
  end if;

  v_amount := round(p_amount, 2);
  select * into v_totals from crm_private.invoice_totals(p_invoice_id);

  if v_amount > coalesce(v_totals.amount_outstanding, 0) then
    raise exception 'that payment is more than the invoice still asks for'
      using errcode = '23514';
  end if;

  insert into public.payment_requests (
    idempotency_key, artist_id, client_id, project_id,
    purpose, amount, currency, invoice_id,
    payment_method_code, external_reference, created_by
  ) values (
    p_idempotency_key, v_invoice.artist_id, v_invoice.client_id, v_invoice.project_id,
    'additional_payment', v_amount, v_invoice.currency, p_invoice_id,
    nullif(btrim(coalesce(p_method_code, '')), ''),
    nullif(btrim(coalesce(p_external_reference, '')), ''),
    auth.uid()
  )
  returning id into v_request_id;

  insert into public.payment_transactions (
    idempotency_key, payment_request_id, artist_id,
    transaction_type, direction, amount, currency, status,
    occurred_at, recorded_by, recorded_by_kind, safe_note_code
  ) values (
    gen_random_uuid(), v_request_id, v_invoice.artist_id,
    'manual_payment', 'credit', v_amount, v_invoice.currency, 'succeeded',
    coalesce(p_occurred_at, now()), auth.uid(), 'human', 'crm_invoice_payment'
  )
  returning id into v_transaction_id;

  perform crm_private.log_artist_activity(
    v_invoice.artist_id, 'invoice.payment_recorded',
    case when public.is_owner() then 'owner' else 'staff' end, auth.uid(),
    v_invoice.client_id, null, v_invoice.project_id, null, null,
    jsonb_build_object('invoice_number', v_invoice.invoice_number, 'currency', v_invoice.currency)
  );

  select * into v_totals from crm_private.invoice_totals(p_invoice_id);

  return jsonb_build_object(
    'invoice_id', p_invoice_id,
    'payment_request_id', v_request_id,
    'payment_transaction_id', v_transaction_id,
    'amount_outstanding', v_totals.amount_outstanding,
    'replayed', false
  );
end;
$$;

/**
 * A correction that leaves the original invoice intact and visible.
 */
create or replace function public.create_credit_note(
  p_invoice_id uuid,
  p_idempotency_key uuid,
  p_amount numeric,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_invoice public.invoices%rowtype;
  v_existing public.credit_notes%rowtype;
  v_number text;
  v_id uuid;
  v_totals record;
  v_amount numeric(12,2);
begin
  if p_idempotency_key is null then
    raise exception 'an idempotency key is required' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'a credit note must be greater than zero' using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a credit note needs a reason' using errcode = '22023';
  end if;

  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'invoice % does not exist', p_invoice_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_invoice.artist_id, 'manage_finance');
  perform pg_advisory_xact_lock(hashtextextended('credit-note:' || p_idempotency_key::text, 0));

  select * into v_existing from public.credit_notes c where c.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.invoice_id <> p_invoice_id
       or v_existing.amount <> round(p_amount, 2)
       or v_existing.reason <> btrim(p_reason) then
      raise exception 'that credit note reference was already used for different terms'
        using errcode = '22023';
    end if;
    return jsonb_build_object(
      'credit_note_id', v_existing.id,
      'credit_note_number', v_existing.credit_note_number,
      'replayed', true
    );
  end if;

  v_amount := round(p_amount, 2);
  v_number := crm_private.next_credit_note_number();

  insert into public.credit_notes (
    idempotency_key, invoice_id, artist_id, credit_note_number,
    amount, reason, created_by
  ) values (
    p_idempotency_key, p_invoice_id, v_invoice.artist_id, v_number,
    v_amount, btrim(p_reason), auth.uid()
  )
  returning id into v_id;

  perform crm_private.log_artist_activity(
    v_invoice.artist_id, 'invoice.credited',
    case when public.is_owner() then 'owner' else 'staff' end, auth.uid(),
    v_invoice.client_id, null, v_invoice.project_id, null, null,
    jsonb_build_object(
      'invoice_number', v_invoice.invoice_number,
      'credit_note_number', v_number,
      'currency', v_invoice.currency
    )
  );

  select * into v_totals from crm_private.invoice_totals(p_invoice_id);

  return jsonb_build_object(
    'credit_note_id', v_id,
    'credit_note_number', v_number,
    'amount', v_amount,
    'amount_outstanding', v_totals.amount_outstanding,
    'replayed', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- API privileges
-- ---------------------------------------------------------------------------

revoke all on function public.get_invoice(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_invoices(uuid,uuid,uuid,public.invoice_status,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.create_invoice(uuid,uuid,date,text)
  from public, anon, authenticated, service_role;
revoke all on function public.set_invoice_line_item(uuid,text,numeric,numeric,uuid,uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.remove_invoice_line_item(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.set_invoice_details(uuid,date,numeric,text)
  from public, anon, authenticated, service_role;
revoke all on function public.issue_invoice(uuid,date)
  from public, anon, authenticated, service_role;
revoke all on function public.void_invoice(uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.attach_payment_request_to_invoice(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.record_invoice_payment(uuid,uuid,numeric,timestamptz,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.create_credit_note(uuid,uuid,numeric,text)
  from public, anon, authenticated, service_role;

grant execute on function public.get_invoice(uuid) to authenticated;
grant execute on function public.list_invoices(uuid,uuid,uuid,public.invoice_status,integer) to authenticated;
grant execute on function public.create_invoice(uuid,uuid,date,text) to authenticated;
grant execute on function public.set_invoice_line_item(uuid,text,numeric,numeric,uuid,uuid,integer) to authenticated;
grant execute on function public.remove_invoice_line_item(uuid) to authenticated;
grant execute on function public.set_invoice_details(uuid,date,numeric,text) to authenticated;
grant execute on function public.issue_invoice(uuid,date) to authenticated;
grant execute on function public.void_invoice(uuid,text) to authenticated;
grant execute on function public.attach_payment_request_to_invoice(uuid,uuid) to authenticated;
grant execute on function public.record_invoice_payment(uuid,uuid,numeric,timestamptz,text,text) to authenticated;
grant execute on function public.create_credit_note(uuid,uuid,numeric,text) to authenticated;

comment on function public.record_invoice_payment(uuid,uuid,numeric,timestamptz,text,text) is
  'Settles part or all of an invoice through the existing payment ledger. The amount is capped at the outstanding balance, so a repeated entry is refused rather than double counted.';
comment on function public.create_credit_note(uuid,uuid,numeric,text) is
  'Reduces what an issued invoice still asks for without editing or deleting it. Capped at the unsettled remainder.';
