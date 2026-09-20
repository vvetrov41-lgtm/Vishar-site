-- 20260920120000_invoicing_core.sql
--
-- Invoices, line items and credit notes over the existing payment ledger.
--
-- WHAT THIS IS NOT
--
-- Not a second payment system. `public.payment_requests` still describes what
-- is owed and `public.payment_transactions` is still the only proof money
-- moved. An invoice is a document that points at those rows through a new
-- nullable `payment_requests.invoice_id`, so every deposit and payment that
-- exists today keeps working untouched with that column null.
--
-- Not bookkeeping. There is no VAT, no tax period and no nominal ledger.
--
-- DERIVED, NEVER STORED TWICE
--
-- Subtotal, total, amount paid, amount credited and outstanding are computed
-- from line items, settled transactions and credit notes every time they are
-- read. `invoices.status` is a cache of that computation plus two lifecycle
-- markers, and a trigger refuses any value the ledger does not support - the
-- same contract `payment_requests.status` already has.
--
-- `overdue` is deliberately not a stored status. It is `due_date` in the past
-- with something still outstanding, which the read RPCs answer at query time,
-- so no background job is needed to keep a row honest.
--
-- Forward-only. No column is dropped or renamed.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.invoice_status as enum (
    'draft', 'issued', 'partially_paid', 'paid', 'void'
  );
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Human-readable numbering
--
-- One installation-wide sequence per document kind. A per-artist counter would
-- need a lock per artist to stay gapless and still would not be gapless after
-- a rolled back transaction, so the number is unique and readable rather than
-- consecutive-per-artist.
-- ---------------------------------------------------------------------------

create sequence if not exists crm_private.invoice_number_seq as bigint start with 1 increment by 1;
create sequence if not exists crm_private.credit_note_number_seq as bigint start with 1 increment by 1;

create or replace function crm_private.next_invoice_number()
returns text
language sql
volatile
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select 'INV-' || to_char(now() at time zone 'UTC', 'YYYY') || '-'
      || lpad(nextval('crm_private.invoice_number_seq')::text, 5, '0');
$$;

create or replace function crm_private.next_credit_note_number()
returns text
language sql
volatile
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select 'CN-' || to_char(now() at time zone 'UTC', 'YYYY') || '-'
      || lpad(nextval('crm_private.credit_note_number_seq')::text, 5, '0');
$$;

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------

create table if not exists public.invoices (
  id              uuid primary key default gen_random_uuid(),
  artist_id       uuid not null references public.artists(id) on delete restrict,
  client_id       uuid not null references public.clients(id) on delete restrict,
  project_id      uuid not null,
  invoice_number  text not null,
  status          public.invoice_status not null default 'draft',
  currency        text not null,
  discount_amount numeric(12,2) not null default 0,
  issue_date      date,
  due_date        date,
  notes           text,
  issued_at       timestamptz,
  voided_at       timestamptz,
  void_reason     text,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint invoices_number_key unique (invoice_number),
  constraint invoices_id_artist_key unique (id, artist_id),
  constraint invoices_number_shape check (invoice_number ~ '^INV-[0-9]{4}-[0-9]{5,}$'),
  constraint invoices_currency_iso check (currency ~ '^[A-Z]{3}$'),
  constraint invoices_discount_not_negative check (discount_amount >= 0),
  constraint invoices_notes_length check (notes is null or char_length(notes) <= 4000),
  constraint invoices_void_reason_length check (
    void_reason is null or (btrim(void_reason) <> '' and char_length(void_reason) <= 500)
  ),
  -- The three lifecycle facts the status is derived from.
  constraint invoices_issue_date_pairs check (
    (issued_at is null and issue_date is null)
    or (issued_at is not null and issue_date is not null)
  ),
  constraint invoices_void_reason_pairs check (
    (voided_at is null and void_reason is null)
    or (voided_at is not null and void_reason is not null)
  ),
  constraint invoices_due_after_issue check (
    due_date is null or issue_date is null or due_date >= issue_date
  ),

  constraint invoices_project_artist_fkey
    foreign key (project_id, artist_id)
    references public.projects(id, artist_id)
    on delete restrict
);

create index if not exists invoices_artist_status_idx
  on public.invoices (artist_id, status, created_at desc);
create index if not exists invoices_project_idx
  on public.invoices (project_id, created_at desc);
create index if not exists invoices_client_idx
  on public.invoices (client_id, created_at desc);
create index if not exists invoices_due_idx
  on public.invoices (due_date)
  where due_date is not null and status in ('issued', 'partially_paid');

comment on table public.invoices is
  'Artist-scoped invoice documents. Totals are derived from line items, credit notes and the payment ledger; status is a guarded cache of that derivation.';
comment on column public.invoices.status is
  'Derived: void when voided_at is set, draft until issued_at is set, then issued/partially_paid/paid from settled payments and credit notes. Overdue is computed at read time from due_date.';

-- ---------------------------------------------------------------------------
-- Line items
-- ---------------------------------------------------------------------------

create table if not exists public.invoice_line_items (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null,
  artist_id    uuid not null,
  session_id   uuid,
  line_position integer not null default 1,
  description  text not null,
  quantity     numeric(12,2) not null,
  unit_amount  numeric(12,2) not null,
  line_total   numeric(12,2) generated always as (round(quantity * unit_amount, 2)) stored,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint invoice_line_items_description_length check (
    btrim(description) <> '' and char_length(description) <= 500
  ),
  constraint invoice_line_items_positive_quantity check (quantity > 0),
  constraint invoice_line_items_unit_not_negative check (unit_amount >= 0),
  constraint invoice_line_items_position_positive check (line_position > 0),
  constraint invoice_line_items_invoice_artist_fkey
    foreign key (invoice_id, artist_id)
    references public.invoices(id, artist_id)
    on delete cascade,
  constraint invoice_line_items_session_artist_fkey
    foreign key (session_id, artist_id)
    references public.sessions(id, artist_id)
    on delete restrict
);

create index if not exists invoice_line_items_invoice_idx
  on public.invoice_line_items (invoice_id, line_position, created_at);

comment on table public.invoice_line_items is
  'What an invoice charges for. Editable only while the invoice is a draft; line_total is generated so a client cannot send an arithmetic of its own.';

-- ---------------------------------------------------------------------------
-- Credit notes
-- ---------------------------------------------------------------------------

create table if not exists public.credit_notes (
  id                 uuid primary key default gen_random_uuid(),
  idempotency_key    uuid not null default gen_random_uuid(),
  invoice_id         uuid not null,
  artist_id          uuid not null,
  credit_note_number text not null,
  amount             numeric(12,2) not null,
  reason             text not null,
  issued_at          timestamptz not null default now(),
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),

  constraint credit_notes_idempotency_key_key unique (idempotency_key),
  constraint credit_notes_number_key unique (credit_note_number),
  constraint credit_notes_id_artist_key unique (id, artist_id),
  constraint credit_notes_number_shape check (credit_note_number ~ '^CN-[0-9]{4}-[0-9]{5,}$'),
  constraint credit_notes_positive_amount check (amount > 0),
  constraint credit_notes_reason_length check (
    btrim(reason) <> '' and char_length(reason) <= 500
  ),
  constraint credit_notes_invoice_artist_fkey
    foreign key (invoice_id, artist_id)
    references public.invoices(id, artist_id)
    on delete restrict
);

create index if not exists credit_notes_invoice_idx
  on public.credit_notes (invoice_id, issued_at desc);

comment on table public.credit_notes is
  'An append-only correction that reduces what an invoice still asks for. The invoice it corrects is never edited or deleted, so the original figure stays visible.';

-- ---------------------------------------------------------------------------
-- The link from the existing ledger to the new document
--
-- Nullable on purpose. Every payment request that exists today - every deposit
-- - keeps `invoice_id is null` and behaves exactly as before. Nothing is
-- backfilled by this migration; see docs/manager-calendar-finance-plan.md for
-- the separate backfill plan.
-- ---------------------------------------------------------------------------

alter table public.payment_requests
  add column if not exists invoice_id uuid;

alter table public.payment_requests
  add column if not exists payment_method_code text;

alter table public.payment_requests
  add column if not exists external_reference text;

do $$ begin
  alter table public.payment_requests
    add constraint payment_requests_invoice_artist_fkey
    foreign key (invoice_id, artist_id)
    references public.invoices(id, artist_id)
    on delete restrict;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.payment_requests
    add constraint payment_requests_method_code_shape
    check (
      payment_method_code is null
      or payment_method_code ~ '^[a-z][a-z0-9_]{1,31}$'
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.payment_requests
    add constraint payment_requests_external_reference_shape
    check (
      external_reference is null
      or (btrim(external_reference) <> '' and char_length(external_reference) <= 120)
    );
exception when duplicate_object then null; end $$;

create index if not exists payment_requests_invoice_idx
  on public.payment_requests (invoice_id, created_at)
  where invoice_id is not null;

comment on column public.payment_requests.invoice_id is
  'Optional link to the invoice this request settles. Null on every historical deposit; once set it is immutable.';
comment on column public.payment_requests.external_reference is
  'Operator-entered provider reference for reconciliation. Never a credential and never a full card or account number.';

-- ---------------------------------------------------------------------------
-- Derivation
-- ---------------------------------------------------------------------------

create or replace function crm_private.invoice_totals(p_invoice_id uuid)
returns table (
  currency           text,
  subtotal           numeric(12,2),
  discount_amount    numeric(12,2),
  total              numeric(12,2),
  amount_paid        numeric(12,2),
  amount_credited    numeric(12,2),
  amount_outstanding numeric(12,2)
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with invoice as (
    select i.id, i.currency, i.discount_amount
    from public.invoices i
    where i.id = p_invoice_id
  ),
  lines as (
    select coalesce(sum(li.line_total), 0)::numeric(12,2) as subtotal
    from public.invoice_line_items li
    where li.invoice_id = p_invoice_id
  ),
  settled as (
    select coalesce(sum(
      case
        when t.status <> 'succeeded' then 0
        when t.direction = 'credit' then t.amount
        else -t.amount
      end
    ), 0)::numeric(12,2) as amount_paid
    from public.payment_transactions t
    join public.payment_requests r on r.id = t.payment_request_id
    where r.invoice_id = p_invoice_id
  ),
  credited as (
    select coalesce(sum(c.amount), 0)::numeric(12,2) as amount_credited
    from public.credit_notes c
    where c.invoice_id = p_invoice_id
  )
  select
    invoice.currency,
    lines.subtotal,
    invoice.discount_amount,
    greatest(lines.subtotal - invoice.discount_amount, 0)::numeric(12,2) as total,
    greatest(settled.amount_paid, 0)::numeric(12,2) as amount_paid,
    credited.amount_credited,
    greatest(
      greatest(lines.subtotal - invoice.discount_amount, 0)
        - greatest(settled.amount_paid, 0)
        - credited.amount_credited,
      0
    )::numeric(12,2) as amount_outstanding
  from invoice, lines, settled, credited;
$$;

create or replace function crm_private.invoice_expected_status(p_invoice_id uuid)
returns public.invoice_status
language plpgsql
stable
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

  return crm_private.invoice_status_for(v_invoice);
end;
$$;

/**
 * The same derivation, from a row rather than an id, so a BEFORE trigger can
 * judge the row it is about to write rather than the one still on disk.
 */
create or replace function crm_private.invoice_status_for(p_invoice public.invoices)
returns public.invoice_status
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_totals record;
  v_settled numeric(12,2);
begin
  if p_invoice.voided_at is not null then return 'void'; end if;
  if p_invoice.issued_at is null then return 'draft'; end if;

  select * into v_totals from crm_private.invoice_totals(p_invoice.id);

  -- A brand new invoice row is not yet visible to the totals query during its
  -- own INSERT, so an issued invoice with no readable totals is simply issued.
  if not found then return 'issued'; end if;

  v_settled := coalesce(v_totals.amount_paid, 0) + coalesce(v_totals.amount_credited, 0);

  if v_settled <= 0 then return 'issued'; end if;
  if v_settled < coalesce(v_totals.total, 0) then return 'partially_paid'; end if;
  return 'paid';
end;
$$;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

create or replace function crm_private.guard_invoice()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_project public.projects%rowtype;
  v_expected public.invoice_status;
begin
  if tg_op = 'INSERT' then
    perform crm_private.require_active_artist(new.artist_id);

    select * into v_project from public.projects p where p.id = new.project_id;
    if not found then
      raise exception 'invoice project % does not exist', new.project_id using errcode = '23503';
    end if;
    if v_project.artist_id <> new.artist_id then
      raise exception 'invoice artist must match the project artist' using errcode = '23514';
    end if;
    if v_project.client_id <> new.client_id then
      raise exception 'invoice client must match the project client' using errcode = '23514';
    end if;
    if new.currency <> v_project.currency then
      raise exception 'invoice currency must match the project currency' using errcode = '23514';
    end if;
    if new.status <> 'draft' or new.issued_at is not null or new.voided_at is not null then
      raise exception 'a new invoice must start as an unissued draft' using errcode = '23514';
    end if;

    return new;
  end if;

  if old.voided_at is not null then
    raise exception 'a void invoice is immutable; issue a new invoice instead'
      using errcode = '42501';
  end if;

  if new.id is distinct from old.id
     or new.artist_id is distinct from old.artist_id
     or new.client_id is distinct from old.client_id
     or new.project_id is distinct from old.project_id
     or new.invoice_number is distinct from old.invoice_number
     or new.currency is distinct from old.currency
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'invoice identity is immutable' using errcode = '23514';
  end if;

  -- Once issued, the figures the client was shown stop moving. A correction is
  -- a credit note; a mistake is a void plus a new invoice.
  if old.issued_at is not null then
    if new.issued_at is distinct from old.issued_at
       or new.issue_date is distinct from old.issue_date
       or new.due_date is distinct from old.due_date
       or new.discount_amount is distinct from old.discount_amount then
      raise exception 'an issued invoice cannot be re-dated or re-priced'
        using errcode = '23514';
    end if;
  end if;

  v_expected := crm_private.invoice_status_for(new);
  if new.status <> v_expected then
    raise exception 'invoice status must be derived from its line items, payments and credit notes'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function crm_private.guard_invoice_line_item()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_row public.invoice_line_items;
  v_invoice public.invoices%rowtype;
  v_session public.sessions%rowtype;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;

  select * into v_invoice from public.invoices i where i.id = v_row.invoice_id;
  if not found then
    -- A cascade from a deleted invoice has nothing left to protect.
    if tg_op = 'DELETE' then return old; end if;
    raise exception 'invoice % does not exist', v_row.invoice_id using errcode = '23503';
  end if;

  if v_invoice.artist_id <> v_row.artist_id then
    raise exception 'line item artist must match the invoice artist' using errcode = '23514';
  end if;

  if v_invoice.issued_at is not null or v_invoice.voided_at is not null then
    raise exception 'only a draft invoice may have its line items changed'
      using errcode = '42501';
  end if;

  if tg_op <> 'DELETE' and new.session_id is not null then
    select * into v_session from public.sessions s where s.id = new.session_id;
    if not found then
      raise exception 'session % does not exist', new.session_id using errcode = '23503';
    end if;
    if v_session.project_id is distinct from v_invoice.project_id then
      raise exception 'a line item may only cite a session on the invoice project'
        using errcode = '23514';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function crm_private.guard_credit_note()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_invoice public.invoices%rowtype;
  v_totals record;
  v_headroom numeric(12,2);
begin
  select * into v_invoice from public.invoices i where i.id = new.invoice_id;
  if not found then
    raise exception 'invoice % does not exist', new.invoice_id using errcode = '23503';
  end if;

  if v_invoice.artist_id <> new.artist_id then
    raise exception 'credit note artist must match the invoice artist' using errcode = '23514';
  end if;
  if v_invoice.issued_at is null then
    raise exception 'a draft invoice is corrected by editing it, not by a credit note'
      using errcode = '42501';
  end if;
  if v_invoice.voided_at is not null then
    raise exception 'a void invoice cannot be credited' using errcode = '42501';
  end if;

  select * into v_totals from crm_private.invoice_totals(new.invoice_id);

  -- A credit note may cancel what is still owed. It may not manufacture a
  -- refund of money already settled, which is what record_manual_refund is for.
  v_headroom := coalesce(v_totals.total, 0)
    - coalesce(v_totals.amount_paid, 0)
    - coalesce(v_totals.amount_credited, 0);

  if new.amount > v_headroom then
    raise exception 'a credit note cannot exceed the amount the invoice still asks for'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function crm_private.block_credit_note_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  raise exception 'credit notes are immutable; issue another credit note instead'
    using errcode = '42501';
end;
$$;

create or replace function crm_private.guard_payment_request_invoice_link()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_invoice public.invoices%rowtype;
begin
  if tg_op = 'UPDATE'
     and old.invoice_id is not null
     and new.invoice_id is distinct from old.invoice_id then
    raise exception 'a payment request cannot be moved to another invoice'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
     and (new.payment_method_code is distinct from old.payment_method_code
          or new.external_reference is distinct from old.external_reference) then
    raise exception 'recorded payment method and reference are immutable'
      using errcode = '23514';
  end if;

  if new.invoice_id is null then return new; end if;

  select * into v_invoice from public.invoices i where i.id = new.invoice_id;
  if not found then
    raise exception 'invoice % does not exist', new.invoice_id using errcode = '23503';
  end if;

  if v_invoice.artist_id <> new.artist_id
     or v_invoice.client_id <> new.client_id
     or v_invoice.project_id is distinct from new.project_id then
    raise exception 'a payment request may only settle an invoice for the same artist, client and project'
      using errcode = '23514';
  end if;
  if v_invoice.currency <> new.currency then
    raise exception 'a payment request must share the invoice currency' using errcode = '23514';
  end if;
  if v_invoice.voided_at is not null then
    raise exception 'a void invoice cannot take payments' using errcode = '42501';
  end if;

  return new;
end;
$$;

/**
 * Keeps `invoices.status` honest after anything that moves the arithmetic:
 * a line item, a credit note, or a settled transaction on a linked request.
 */
create or replace function crm_private.refresh_invoice_status(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_status public.invoice_status;
begin
  if p_invoice_id is null then return; end if;
  v_status := crm_private.invoice_expected_status(p_invoice_id);
  update public.invoices
  set status = v_status,
      updated_at = now()
  where id = p_invoice_id
    and status is distinct from v_status;
end;
$$;

create or replace function crm_private.refresh_invoice_from_line_item()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.refresh_invoice_status(
    case when tg_op = 'DELETE' then old.invoice_id else new.invoice_id end
  );
  return null;
end;
$$;

create or replace function crm_private.refresh_invoice_from_credit_note()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.refresh_invoice_status(new.invoice_id);
  return null;
end;
$$;

create or replace function crm_private.refresh_invoice_from_transaction()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_invoice_id uuid;
begin
  if new.status = 'failed' then return null; end if;

  select r.invoice_id into v_invoice_id
  from public.payment_requests r
  where r.id = new.payment_request_id;

  perform crm_private.refresh_invoice_status(v_invoice_id);
  return null;
end;
$$;

revoke all on function crm_private.next_invoice_number()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.next_credit_note_number()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.invoice_totals(uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.invoice_expected_status(uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.invoice_status_for(public.invoices)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.guard_invoice()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.guard_invoice_line_item()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.guard_credit_note()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.block_credit_note_mutation()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.guard_payment_request_invoice_link()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.refresh_invoice_status(uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.refresh_invoice_from_line_item()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.refresh_invoice_from_credit_note()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.refresh_invoice_from_transaction()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

drop trigger if exists invoices_guard on public.invoices;
create trigger invoices_guard
  before insert or update on public.invoices
  for each row execute function crm_private.guard_invoice();

drop trigger if exists invoices_set_updated_at on public.invoices;
create trigger invoices_set_updated_at
  before update on public.invoices
  for each row execute function public.set_updated_at();

drop trigger if exists invoice_line_items_guard on public.invoice_line_items;
create trigger invoice_line_items_guard
  before insert or update or delete on public.invoice_line_items
  for each row execute function crm_private.guard_invoice_line_item();

drop trigger if exists invoice_line_items_set_updated_at on public.invoice_line_items;
create trigger invoice_line_items_set_updated_at
  before update on public.invoice_line_items
  for each row execute function public.set_updated_at();

drop trigger if exists invoice_line_items_refresh_invoice on public.invoice_line_items;
create trigger invoice_line_items_refresh_invoice
  after insert or update or delete on public.invoice_line_items
  for each row execute function crm_private.refresh_invoice_from_line_item();

drop trigger if exists credit_notes_guard on public.credit_notes;
create trigger credit_notes_guard
  before insert on public.credit_notes
  for each row execute function crm_private.guard_credit_note();

drop trigger if exists credit_notes_block_update_delete on public.credit_notes;
create trigger credit_notes_block_update_delete
  before update or delete on public.credit_notes
  for each row execute function crm_private.block_credit_note_mutation();

drop trigger if exists credit_notes_block_truncate on public.credit_notes;
create trigger credit_notes_block_truncate
  before truncate on public.credit_notes
  for each statement execute function crm_private.block_credit_note_mutation();

drop trigger if exists credit_notes_refresh_invoice on public.credit_notes;
create trigger credit_notes_refresh_invoice
  after insert on public.credit_notes
  for each row execute function crm_private.refresh_invoice_from_credit_note();

-- Named so it sorts after `payment_requests_guard`, which owns the financial
-- identity of the row this one only adds a link to.
drop trigger if exists payment_requests_invoice_link_guard on public.payment_requests;
create trigger payment_requests_invoice_link_guard
  before insert or update on public.payment_requests
  for each row execute function crm_private.guard_payment_request_invoice_link();

drop trigger if exists payment_transactions_refresh_invoice on public.payment_transactions;
create trigger payment_transactions_refresh_invoice
  after insert on public.payment_transactions
  for each row execute function crm_private.refresh_invoice_from_transaction();

-- ---------------------------------------------------------------------------
-- RLS and API privileges
--
-- Reads follow the finance boundary the ledger already uses. There is
-- deliberately no INSERT, UPDATE or DELETE policy and no write grant on any of
-- the three tables: every write below is a SECURITY DEFINER RPC that re-checks
-- `manage_finance` on the invoice's own artist.
-- ---------------------------------------------------------------------------

alter table public.invoices enable row level security;
alter table public.invoices force row level security;
alter table public.invoice_line_items enable row level security;
alter table public.invoice_line_items force row level security;
alter table public.credit_notes enable row level security;
alter table public.credit_notes force row level security;

revoke all on public.invoices from public, anon, authenticated, service_role;
revoke all on public.invoice_line_items from public, anon, authenticated, service_role;
revoke all on public.credit_notes from public, anon, authenticated, service_role;

grant select on public.invoices to authenticated;
grant select on public.invoice_line_items to authenticated;
grant select on public.credit_notes to authenticated;

drop policy if exists invoices_select on public.invoices;
create policy invoices_select on public.invoices
  for select
  using (public.can_view_artist_finance(artist_id));

drop policy if exists invoice_line_items_select on public.invoice_line_items;
create policy invoice_line_items_select on public.invoice_line_items
  for select
  using (public.can_view_artist_finance(artist_id));

drop policy if exists credit_notes_select on public.credit_notes;
create policy credit_notes_select on public.credit_notes
  for select
  using (public.can_view_artist_finance(artist_id));
