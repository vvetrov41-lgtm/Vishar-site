-- 0018_payment_requests_transactions.sql
--
-- Artist-scoped payment policies, requests, immutable transactions and
-- idempotent provider webhook metadata. This migration creates no provider
-- connection and stores no payment secret, raw webhook body or bank data.
--
-- Payment requests describe what is owed. Only succeeded immutable transaction
-- rows prove that money moved. Refunds and corrections are new rows; historical
-- transactions are never updated, deleted or truncated.
--
-- Forward-only.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.payment_policy_mode as enum (
    'none', 'fixed', 'percentage', 'per_session_fixed'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_request_purpose as enum (
    'deposit', 'session_balance', 'additional_payment', 'design_fee', 'other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_request_status as enum (
    'pending', 'partially_paid', 'paid', 'cancelled', 'expired'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_transaction_type as enum (
    'payment', 'refund', 'partial_refund', 'manual_payment', 'adjustment'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_transaction_direction as enum ('credit', 'debit');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_transaction_status as enum ('succeeded', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_recorded_by_kind as enum (
    'human', 'webhook', 'system', 'ai'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_webhook_processing_status as enum (
    'received', 'processing', 'succeeded', 'failed', 'ignored'
  );
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Versioned artist payment policies
-- ---------------------------------------------------------------------------

create table if not exists public.artist_payment_policies (
  id                      uuid primary key default gen_random_uuid(),
  artist_id               uuid not null references public.artists(id) on delete restrict,
  version                 integer not null,
  deposit_mode            public.payment_policy_mode not null,
  fixed_amount            numeric(12,2),
  percentage              numeric(5,2),
  payment_deadline_hours  integer not null default 72,
  transfer_allowed        boolean not null default true,
  refund_policy_version   text not null,
  effective_from          timestamptz not null default now(),
  effective_until         timestamptz,
  is_active               boolean not null default false,
  created_by              uuid references public.profiles(id) on delete set null,
  created_at              timestamptz not null default now(),

  constraint artist_payment_policies_artist_version_key
    unique (artist_id, version),
  constraint artist_payment_policies_id_artist_version_key
    unique (id, artist_id, version),
  constraint artist_payment_policies_positive_version
    check (version > 0),
  constraint artist_payment_policies_deadline_range
    check (payment_deadline_hours between 1 and 8760),
  constraint artist_payment_policies_refund_version_shape
    check (
      refund_policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
    ),
  constraint artist_payment_policies_effective_window
    check (effective_until is null or effective_until > effective_from),
  constraint artist_payment_policies_mode_values
    check (
      (deposit_mode = 'none' and fixed_amount is null and percentage is null)
      or
      (deposit_mode in ('fixed', 'per_session_fixed')
       and fixed_amount is not null and fixed_amount > 0
       and percentage is null)
      or
      (deposit_mode = 'percentage'
       and percentage is not null and percentage > 0 and percentage <= 100
       and fixed_amount is null)
    )
);

create unique index if not exists artist_payment_policies_one_active_idx
  on public.artist_payment_policies (artist_id)
  where is_active;
create index if not exists artist_payment_policies_history_idx
  on public.artist_payment_policies (artist_id, version desc);

comment on table public.artist_payment_policies is
  'Versioned non-secret deposit and refund policy parameters for one artist. Old versions remain for historical payment requests.';

-- ---------------------------------------------------------------------------
-- Payment requests
-- ---------------------------------------------------------------------------

create table if not exists public.payment_requests (
  id                    uuid primary key default gen_random_uuid(),
  idempotency_key       uuid not null,
  artist_id             uuid not null references public.artists(id) on delete restrict,
  client_id             uuid not null references public.clients(id) on delete restrict,
  project_id            uuid,
  session_id            uuid,
  purpose               public.payment_request_purpose not null,
  amount                numeric(12,2) not null,
  currency              text not null,
  status                public.payment_request_status not null default 'pending',
  provider              text,
  provider_account_key  text,
  policy_id             uuid,
  policy_version        integer,
  policy_snapshot       jsonb not null default '{}'::jsonb,
  expires_at            timestamptz,
  created_by            uuid references public.profiles(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint payment_requests_idempotency_key_key unique (idempotency_key),
  constraint payment_requests_id_artist_key unique (id, artist_id),
  constraint payment_requests_positive_amount check (amount > 0),
  constraint payment_requests_currency_iso check (currency ~ '^[A-Z]{3}$'),
  constraint payment_requests_provider_shape check (
    provider is null or provider ~ '^[a-z][a-z0-9_-]{1,63}$'
  ),
  constraint payment_requests_provider_account_shape check (
    provider_account_key is null
    or provider_account_key ~ '^[a-z][a-z0-9_-]{2,79}$'
  ),
  constraint payment_requests_provider_pair check (
    (provider is null and provider_account_key is null)
    or (provider is not null and provider_account_key is not null)
  ),
  constraint payment_requests_policy_link_complete check (
    (policy_id is null and policy_version is null)
    or (policy_id is not null and policy_version is not null)
  ),
  constraint payment_requests_policy_snapshot_object check (
    jsonb_typeof(policy_snapshot) = 'object'
    and pg_column_size(policy_snapshot) <= 8192
  ),
  constraint payment_requests_session_requires_project check (
    session_id is null or project_id is not null
  ),
  constraint payment_requests_expiry_after_creation check (
    expires_at is null or expires_at > created_at
  ),

  constraint payment_requests_project_artist_fkey
    foreign key (project_id, artist_id)
    references public.projects(id, artist_id)
    on delete restrict,
  constraint payment_requests_session_artist_fkey
    foreign key (session_id, artist_id)
    references public.sessions(id, artist_id)
    on delete restrict,
  constraint payment_requests_policy_artist_version_fkey
    foreign key (policy_id, artist_id, policy_version)
    references public.artist_payment_policies(id, artist_id, version)
    on delete restrict
);

create index if not exists payment_requests_artist_status_idx
  on public.payment_requests (artist_id, status, created_at desc);
create index if not exists payment_requests_project_idx
  on public.payment_requests (project_id, created_at desc)
  where project_id is not null;
create index if not exists payment_requests_session_idx
  on public.payment_requests (session_id, created_at desc)
  where session_id is not null;
create index if not exists payment_requests_client_idx
  on public.payment_requests (client_id, created_at desc);

comment on table public.payment_requests is
  'Artist-scoped requested amounts. The status paid/partially_paid is valid only when immutable succeeded transactions support it.';
comment on column public.payment_requests.provider_account_key is
  'Non-secret selector for encrypted server-side provider configuration; never a provider credential.';
comment on column public.payment_requests.policy_snapshot is
  'Safe non-secret snapshot of the policy terms used when this request was created.';

-- ---------------------------------------------------------------------------
-- Provider webhook event metadata
-- ---------------------------------------------------------------------------

create table if not exists public.payment_webhook_events (
  id                    uuid primary key default gen_random_uuid(),
  artist_id             uuid not null references public.artists(id) on delete restrict,
  provider              text not null,
  provider_account_key  text not null,
  provider_event_id     text not null,
  processing_status     public.payment_webhook_processing_status not null default 'received',
  payload_sha256        text,
  received_at           timestamptz not null default now(),
  processed_at          timestamptz,
  safe_error_code       text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint payment_webhook_events_provider_event_key
    unique (provider, provider_event_id),
  constraint payment_webhook_events_id_artist_key
    unique (id, artist_id),
  constraint payment_webhook_events_provider_shape
    check (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  constraint payment_webhook_events_account_shape
    check (provider_account_key ~ '^[a-z][a-z0-9_-]{2,79}$'),
  constraint payment_webhook_events_event_id_length
    check (btrim(provider_event_id) <> '' and char_length(provider_event_id) <= 255),
  constraint payment_webhook_events_checksum_shape
    check (payload_sha256 is null or payload_sha256 ~ '^[a-f0-9]{64}$'),
  constraint payment_webhook_events_error_code_shape
    check (
      safe_error_code is null
      or safe_error_code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
    ),
  constraint payment_webhook_events_processed_state check (
    (processing_status in ('received', 'processing') and processed_at is null)
    or
    (processing_status in ('succeeded', 'failed', 'ignored') and processed_at is not null)
  )
);

create index if not exists payment_webhook_events_artist_recent_idx
  on public.payment_webhook_events (artist_id, received_at desc);
create index if not exists payment_webhook_events_unfinished_idx
  on public.payment_webhook_events (received_at)
  where processing_status in ('received', 'processing');

comment on table public.payment_webhook_events is
  'Idempotent safe webhook processing metadata. Raw request bodies, signatures and provider secrets are deliberately absent.';

-- ---------------------------------------------------------------------------
-- Immutable payment transactions
-- ---------------------------------------------------------------------------

create table if not exists public.payment_transactions (
  id                       uuid primary key default gen_random_uuid(),
  idempotency_key          uuid not null,
  payment_request_id       uuid not null,
  artist_id                uuid not null,
  transaction_type         public.payment_transaction_type not null,
  direction                public.payment_transaction_direction not null,
  amount                   numeric(12,2) not null,
  currency                 text not null,
  status                   public.payment_transaction_status not null,
  provider                 text,
  provider_transaction_id  text,
  webhook_event_id         uuid,
  occurred_at              timestamptz not null,
  recorded_by              uuid references public.profiles(id) on delete set null,
  recorded_by_kind         public.payment_recorded_by_kind not null,
  safe_note_code           text,
  created_at               timestamptz not null default now(),

  constraint payment_transactions_idempotency_key_key unique (idempotency_key),
  constraint payment_transactions_request_artist_fkey
    foreign key (payment_request_id, artist_id)
    references public.payment_requests(id, artist_id)
    on delete restrict,
  constraint payment_transactions_webhook_artist_fkey
    foreign key (webhook_event_id, artist_id)
    references public.payment_webhook_events(id, artist_id)
    on delete restrict,
  constraint payment_transactions_positive_amount check (amount > 0),
  constraint payment_transactions_currency_iso check (currency ~ '^[A-Z]{3}$'),
  constraint payment_transactions_provider_shape check (
    provider is null or provider ~ '^[a-z][a-z0-9_-]{1,63}$'
  ),
  constraint payment_transactions_provider_tx_length check (
    provider_transaction_id is null
    or (btrim(provider_transaction_id) <> '' and char_length(provider_transaction_id) <= 255)
  ),
  constraint payment_transactions_safe_note_code_shape check (
    safe_note_code is null
    or safe_note_code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
  ),
  constraint payment_transactions_type_direction check (
    (transaction_type in ('payment', 'manual_payment') and direction = 'credit')
    or
    (transaction_type in ('refund', 'partial_refund') and direction = 'debit')
    or
    transaction_type = 'adjustment'
  ),
  constraint payment_transactions_manual_origin check (
    transaction_type <> 'manual_payment'
    or (
      recorded_by_kind = 'human'
      and recorded_by is not null
      and provider is null
      and provider_transaction_id is null
      and webhook_event_id is null
    )
  ),
  constraint payment_transactions_provider_payment_origin check (
    transaction_type <> 'payment'
    or (
      recorded_by_kind = 'webhook'
      and recorded_by is null
      and provider is not null
      and provider_transaction_id is not null
      and webhook_event_id is not null
    )
  ),
  constraint payment_transactions_webhook_origin check (
    webhook_event_id is null
    or (recorded_by_kind = 'webhook' and provider is not null)
  ),
  constraint payment_transactions_human_actor check (
    recorded_by_kind <> 'human' or recorded_by is not null
  )
);

create unique index if not exists payment_transactions_provider_tx_key
  on public.payment_transactions (provider, provider_transaction_id)
  where provider_transaction_id is not null;
create index if not exists payment_transactions_request_ledger_idx
  on public.payment_transactions (payment_request_id, occurred_at, created_at);
create index if not exists payment_transactions_artist_recent_idx
  on public.payment_transactions (artist_id, occurred_at desc);

comment on table public.payment_transactions is
  'Append-only financial ledger. Direction and type encode the effect; amount is always positive. Refunds are debit rows.';

-- ---------------------------------------------------------------------------
-- Payment helpers
-- ---------------------------------------------------------------------------

create or replace function crm_private.payment_request_net_paid(p_request_id uuid)
returns numeric
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select coalesce(sum(
    case
      when t.status <> 'succeeded' then 0
      when t.direction = 'credit' then t.amount
      else -t.amount
    end
  ), 0)::numeric(12,2)
  from public.payment_transactions t
  where t.payment_request_id = p_request_id;
$$;

create or replace function crm_private.payment_request_expected_status(p_request_id uuid)
returns public.payment_request_status
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_amount numeric(12,2);
  v_net numeric(12,2);
begin
  select r.amount into v_amount
  from public.payment_requests r
  where r.id = p_request_id;

  if not found then
    raise exception 'payment request % does not exist', p_request_id
      using errcode = '23503';
  end if;

  v_net := crm_private.payment_request_net_paid(p_request_id);

  if v_net <= 0 then
    return 'pending';
  elsif v_net < v_amount then
    return 'partially_paid';
  else
    return 'paid';
  end if;
end;
$$;

create or replace function crm_private.guard_artist_payment_policy()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if tg_op = 'INSERT' then
    perform crm_private.require_active_artist(new.artist_id);
    return new;
  end if;

  if new.id is distinct from old.id
     or new.artist_id is distinct from old.artist_id
     or new.version is distinct from old.version
     or new.deposit_mode is distinct from old.deposit_mode
     or new.fixed_amount is distinct from old.fixed_amount
     or new.percentage is distinct from old.percentage
     or new.payment_deadline_hours is distinct from old.payment_deadline_hours
     or new.transfer_allowed is distinct from old.transfer_allowed
     or new.refund_policy_version is distinct from old.refund_policy_version
     or new.effective_from is distinct from old.effective_from
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'payment policy terms are immutable; create a new version'
      using errcode = '23514';
  end if;

  if not old.is_active and new.is_active then
    raise exception 'an inactive payment policy version cannot be reactivated'
      using errcode = '23514';
  end if;

  if old.effective_until is not null
     and new.effective_until is distinct from old.effective_until then
    raise exception 'a closed payment policy window is immutable'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function crm_private.guard_payment_request()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_link_artist uuid;
  v_project_client uuid;
  v_session_project uuid;
  v_expected public.payment_request_status;
  v_net numeric(12,2);
begin
  if tg_op = 'INSERT' then
    perform crm_private.require_active_artist(new.artist_id);

    if new.status <> 'pending' then
      raise exception 'a new payment request must start pending'
        using errcode = '23514';
    end if;

    v_link_artist := crm_private.resolve_artist_from_links(
      null, new.project_id, new.session_id
    );

    if v_link_artist is not null and v_link_artist <> new.artist_id then
      raise exception 'payment request artist must match linked project/session'
        using errcode = '23514';
    end if;

    if new.project_id is not null then
      select p.client_id into v_project_client
      from public.projects p where p.id = new.project_id;
      if v_project_client is distinct from new.client_id then
        raise exception 'payment request client must match the project client'
          using errcode = '23514';
      end if;
    end if;

    if new.session_id is not null then
      select s.project_id into v_session_project
      from public.sessions s where s.id = new.session_id;
      if v_session_project is distinct from new.project_id then
        raise exception 'payment request session must belong to its project'
          using errcode = '23514';
      end if;
    end if;

    return new;
  end if;

  if new.id is distinct from old.id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.artist_id is distinct from old.artist_id
     or new.client_id is distinct from old.client_id
     or new.project_id is distinct from old.project_id
     or new.session_id is distinct from old.session_id
     or new.purpose is distinct from old.purpose
     or new.amount is distinct from old.amount
     or new.currency is distinct from old.currency
     or new.provider is distinct from old.provider
     or new.provider_account_key is distinct from old.provider_account_key
     or new.policy_id is distinct from old.policy_id
     or new.policy_version is distinct from old.policy_version
     or new.policy_snapshot is distinct from old.policy_snapshot
     or new.expires_at is distinct from old.expires_at
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'payment request financial identity is immutable'
      using errcode = '23514';
  end if;

  if old.status in ('cancelled', 'expired') and new.status is distinct from old.status then
    raise exception 'a closed payment request cannot be reopened'
      using errcode = '23514';
  end if;

  v_net := crm_private.payment_request_net_paid(old.id);

  if new.status in ('cancelled', 'expired') then
    if v_net <> 0 then
      raise exception 'a request with net paid funds cannot be cancelled or expired'
        using errcode = '23514';
    end if;
  else
    v_expected := crm_private.payment_request_expected_status(old.id);
    if new.status <> v_expected then
      raise exception 'payment request status must be derived from the immutable ledger'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create or replace function crm_private.guard_payment_webhook_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if tg_op = 'INSERT' then
    perform crm_private.require_active_artist(new.artist_id);
    return new;
  end if;

  if new.id is distinct from old.id
     or new.artist_id is distinct from old.artist_id
     or new.provider is distinct from old.provider
     or new.provider_account_key is distinct from old.provider_account_key
     or new.provider_event_id is distinct from old.provider_event_id
     or new.payload_sha256 is distinct from old.payload_sha256
     or new.received_at is distinct from old.received_at
     or new.created_at is distinct from old.created_at then
    raise exception 'payment webhook event identity is immutable'
      using errcode = '23514';
  end if;

  if old.processing_status in ('succeeded', 'failed', 'ignored')
     and new.processing_status is distinct from old.processing_status then
    raise exception 'a completed webhook event cannot be reopened'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function crm_private.guard_payment_transaction_insert()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_request public.payment_requests%rowtype;
  v_webhook public.payment_webhook_events%rowtype;
  v_net numeric(12,2);
  v_after numeric(12,2);
begin
  select * into v_request
  from public.payment_requests r
  where r.id = new.payment_request_id
  for update;

  if not found then
    raise exception 'payment request % does not exist', new.payment_request_id
      using errcode = '23503';
  end if;

  if v_request.artist_id <> new.artist_id then
    raise exception 'transaction artist must match the payment request'
      using errcode = '23514';
  end if;

  if v_request.currency <> new.currency then
    raise exception 'transaction currency must match the payment request'
      using errcode = '23514';
  end if;

  if v_request.status in ('cancelled', 'expired') then
    raise exception 'a closed payment request cannot receive transactions'
      using errcode = '23514';
  end if;

  if new.webhook_event_id is not null then
    select * into v_webhook
    from public.payment_webhook_events w
    where w.id = new.webhook_event_id;

    if not found then
      raise exception 'payment webhook event % does not exist', new.webhook_event_id
        using errcode = '23503';
    end if;

    if v_webhook.artist_id <> new.artist_id
       or v_webhook.provider <> new.provider
       or v_webhook.provider_account_key is distinct from v_request.provider_account_key then
      raise exception 'transaction webhook routing must match artist, provider and account'
        using errcode = '23514';
    end if;
  end if;

  -- Failed provider attempts are retained as immutable evidence but have no
  -- financial effect and therefore do not need a balance transition.
  if new.status = 'failed' then
    return new;
  end if;

  v_net := crm_private.payment_request_net_paid(new.payment_request_id);
  v_after := v_net + case when new.direction = 'credit' then new.amount else -new.amount end;

  if v_after < 0 then
    raise exception 'refund or debit exceeds the available settled amount'
      using errcode = '23514';
  end if;

  if v_after > v_request.amount then
    raise exception 'payment credits cannot exceed the requested amount'
      using errcode = '23514';
  end if;

  if new.transaction_type = 'refund' and new.amount <> v_net then
    raise exception 'a full refund must equal the entire currently settled amount'
      using errcode = '23514';
  end if;

  if new.transaction_type = 'partial_refund' and new.amount >= v_net then
    raise exception 'a partial refund must be smaller than the currently settled amount'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function crm_private.refresh_payment_request_status()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_status public.payment_request_status;
begin
  if new.status = 'failed' then
    return new;
  end if;

  v_status := crm_private.payment_request_expected_status(new.payment_request_id);

  update public.payment_requests
  set status = v_status,
      updated_at = now()
  where id = new.payment_request_id
    and status not in ('cancelled', 'expired')
    and status is distinct from v_status;

  return new;
end;
$$;

create or replace function crm_private.block_payment_transaction_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  raise exception 'payment transactions are immutable; append a new transaction instead'
    using errcode = '42501';
end;
$$;

-- All helper/trigger functions remain outside the Data API.
revoke all on function crm_private.payment_request_net_paid(uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.payment_request_expected_status(uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.guard_artist_payment_policy()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.guard_payment_request()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.guard_payment_webhook_event()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.guard_payment_transaction_insert()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.refresh_payment_request_status()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.block_payment_transaction_mutation()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

drop trigger if exists artist_payment_policies_guard
  on public.artist_payment_policies;
create trigger artist_payment_policies_guard
  before insert or update on public.artist_payment_policies
  for each row execute function crm_private.guard_artist_payment_policy();

drop trigger if exists payment_requests_guard
  on public.payment_requests;
create trigger payment_requests_guard
  before insert or update on public.payment_requests
  for each row execute function crm_private.guard_payment_request();

drop trigger if exists payment_requests_set_updated_at
  on public.payment_requests;
create trigger payment_requests_set_updated_at
  before update on public.payment_requests
  for each row execute function public.set_updated_at();

drop trigger if exists payment_webhook_events_guard
  on public.payment_webhook_events;
create trigger payment_webhook_events_guard
  before insert or update on public.payment_webhook_events
  for each row execute function crm_private.guard_payment_webhook_event();

drop trigger if exists payment_webhook_events_set_updated_at
  on public.payment_webhook_events;
create trigger payment_webhook_events_set_updated_at
  before update on public.payment_webhook_events
  for each row execute function public.set_updated_at();

drop trigger if exists payment_transactions_guard_insert
  on public.payment_transactions;
create trigger payment_transactions_guard_insert
  before insert on public.payment_transactions
  for each row execute function crm_private.guard_payment_transaction_insert();

drop trigger if exists payment_transactions_refresh_request
  on public.payment_transactions;
create trigger payment_transactions_refresh_request
  after insert on public.payment_transactions
  for each row execute function crm_private.refresh_payment_request_status();

drop trigger if exists payment_transactions_block_update_delete
  on public.payment_transactions;
create trigger payment_transactions_block_update_delete
  before update or delete on public.payment_transactions
  for each row execute function crm_private.block_payment_transaction_mutation();

drop trigger if exists payment_transactions_block_truncate
  on public.payment_transactions;
create trigger payment_transactions_block_truncate
  before truncate on public.payment_transactions
  for each statement execute function crm_private.block_payment_transaction_mutation();

-- ---------------------------------------------------------------------------
-- RLS and API privileges
-- ---------------------------------------------------------------------------

alter table public.artist_payment_policies enable row level security;
alter table public.artist_payment_policies force row level security;
alter table public.payment_requests enable row level security;
alter table public.payment_requests force row level security;
alter table public.payment_webhook_events enable row level security;
alter table public.payment_webhook_events force row level security;
alter table public.payment_transactions enable row level security;
alter table public.payment_transactions force row level security;

revoke all on public.artist_payment_policies
  from public, anon, authenticated, service_role;
revoke all on public.payment_requests
  from public, anon, authenticated, service_role;
revoke all on public.payment_webhook_events
  from public, anon, authenticated, service_role;
revoke all on public.payment_transactions
  from public, anon, authenticated, service_role;

grant select on public.artist_payment_policies to authenticated;
grant select on public.payment_requests to authenticated;
grant select on public.payment_transactions to authenticated;
grant select on public.payment_webhook_events to authenticated;

drop policy if exists artist_payment_policies_select
  on public.artist_payment_policies;
create policy artist_payment_policies_select on public.artist_payment_policies
  for select
  using (public.can_view_artist_finance(artist_id));

drop policy if exists payment_requests_select on public.payment_requests;
create policy payment_requests_select on public.payment_requests
  for select
  using (public.can_view_artist_finance(artist_id));

drop policy if exists payment_transactions_select on public.payment_transactions;
create policy payment_transactions_select on public.payment_transactions
  for select
  using (public.can_view_artist_finance(artist_id));

drop policy if exists payment_webhook_events_select
  on public.payment_webhook_events;
create policy payment_webhook_events_select on public.payment_webhook_events
  for select
  using (public.can_manage_artist_finance(artist_id));

-- Deliberately no INSERT/UPDATE/DELETE policies or grants. Migration 0020 adds
-- narrow audited SECURITY DEFINER workflows for request creation, manual
-- payment, webhook processing, cancellation and refund. Direct browser writes
-- remain unavailable even to an owner.
