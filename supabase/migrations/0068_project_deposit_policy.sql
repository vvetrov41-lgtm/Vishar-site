-- 0068_project_deposit_policy.sql
--
-- Move deposit pricing above the Monzo layer.
--
-- Until now the only server-owned deposit rule was the per-session duration
-- schedule, and the reusable Monzo catalogue implicitly decided which amounts
-- were possible. This migration adds an artist-scoped, versioned project
-- deposit policy so a project can produce any valid amount, and makes that
-- authoritative server-side amount the only thing a project deposit request can
-- be created with.
--
--   project estimate / project facts
--     -> artist project deposit policy
--     -> suggested deposit
--     -> optional authorised project override
--     -> authoritative project deposit amount
--     -> immutable payment request
--     -> immutable request-bound destination snapshot (migration 0067)
--
-- Multiple Sessions is deliberately left on the per-session duration schedule
-- it already shares with single-session deposits, so there is exactly one
-- session pricing rule and exactly one project pricing rule, never two copies
-- of either.
--
-- No amount here is provider specific. Nothing in this migration settles a
-- payment, creates a destination or prints a provider URL.

-- ---------------------------------------------------------------------------
-- 1. Versioned artist project deposit policy
-- ---------------------------------------------------------------------------

create table public.artist_project_deposit_policies (
  id              uuid primary key default gen_random_uuid(),
  artist_id       uuid not null references public.artists(id) on delete restrict,
  version         integer not null,
  mode            text not null,
  fixed_amount    numeric(12,2),
  percentage      numeric(5,2),
  minimum_amount  numeric(12,2),
  rounding_step   numeric(12,2) not null default 1.00,
  currency        text not null default 'GBP',
  is_active       boolean not null default true,
  effective_from  timestamptz not null default now(),
  effective_until timestamptz,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),

  constraint artist_project_deposit_policies_artist_version_key
    unique (artist_id, version),
  constraint artist_project_deposit_policies_id_artist_version_key
    unique (id, artist_id, version),
  constraint artist_project_deposit_policies_positive_version
    check (version > 0),
  constraint artist_project_deposit_policies_currency_gbp
    check (currency = 'GBP'),
  constraint artist_project_deposit_policies_mode_values
    check (
      (mode = 'fixed'
       and fixed_amount is not null and fixed_amount > 0 and fixed_amount <= 100000.00
       and percentage is null)
      or
      (mode = 'percentage_of_estimate'
       and percentage is not null and percentage > 0 and percentage <= 100
       and fixed_amount is null)
    ),
  constraint artist_project_deposit_policies_minimum_range
    check (minimum_amount is null or (minimum_amount > 0 and minimum_amount <= 100000.00)),
  constraint artist_project_deposit_policies_rounding_range
    check (rounding_step > 0 and rounding_step <= 1000.00),
  constraint artist_project_deposit_policies_effective_window
    check (effective_until is null or effective_until > effective_from)
);

-- At most one live policy per artist. A change is a new version, not an edit.
create unique index artist_project_deposit_policies_live_idx
  on public.artist_project_deposit_policies (artist_id)
  where is_active and effective_until is null;

alter table public.artist_project_deposit_policies enable row level security;
alter table public.artist_project_deposit_policies force row level security;
revoke all on public.artist_project_deposit_policies
  from public, anon, authenticated, service_role;

comment on table public.artist_project_deposit_policies is
  'Versioned artist-scoped rule that turns project facts into a suggested project deposit. It is provider neutral: it knows nothing about Monzo, reusable links, hours, session length or session count.';
comment on column public.artist_project_deposit_policies.rounding_step is
  'Percentage results are rounded up to a whole multiple of this step so a deposit never under-collects against the policy.';

create or replace function crm_private.guard_artist_project_deposit_policy()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a project deposit policy version is retained evidence'
      using errcode = '42501';
  end if;

  if new.id is distinct from old.id
     or new.artist_id is distinct from old.artist_id
     or new.version is distinct from old.version
     or new.mode is distinct from old.mode
     or new.fixed_amount is distinct from old.fixed_amount
     or new.percentage is distinct from old.percentage
     or new.minimum_amount is distinct from old.minimum_amount
     or new.rounding_step is distinct from old.rounding_step
     or new.currency is distinct from old.currency
     or new.effective_from is distinct from old.effective_from
     or new.created_at is distinct from old.created_at then
    raise exception 'project deposit policy terms are immutable; create a new version'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function crm_private.guard_artist_project_deposit_policy()
  from public, anon, authenticated, service_role;

drop trigger if exists artist_project_deposit_policies_guard
  on public.artist_project_deposit_policies;
create trigger artist_project_deposit_policies_guard
  before update or delete on public.artist_project_deposit_policies
  for each row execute function crm_private.guard_artist_project_deposit_policy();

-- ---------------------------------------------------------------------------
-- 2. Authorised project override
-- ---------------------------------------------------------------------------

alter table public.projects
  add column if not exists deposit_override_amount numeric(12,2),
  add column if not exists deposit_override_set_by uuid references public.profiles(id) on delete set null,
  add column if not exists deposit_override_set_at timestamptz;

alter table public.projects
  add constraint projects_deposit_override_range
    check (
      deposit_override_amount is null
      or (deposit_override_amount > 0 and deposit_override_amount <= 100000.00)
    );

comment on column public.projects.deposit_override_amount is
  'Explicit authorised project deposit that replaces the policy suggestion for future requests only. It never reprices an already issued payment request.';

-- ---------------------------------------------------------------------------
-- 3. Immutable project deposit pricing snapshot
-- ---------------------------------------------------------------------------

create table public.project_deposit_requests (
  payment_request_id uuid primary key,
  artist_id          uuid not null references public.artists(id) on delete restrict,
  client_id          uuid not null references public.clients(id) on delete restrict,
  project_id         uuid not null,
  policy_id          uuid not null,
  policy_version     integer not null,
  mode               text not null,
  fixed_amount       numeric(12,2),
  percentage         numeric(5,2),
  minimum_amount     numeric(12,2),
  rounding_step      numeric(12,2) not null,
  estimate_total     numeric(12,2),
  suggested_amount   numeric(12,2) not null,
  override_amount    numeric(12,2),
  amount             numeric(12,2) not null,
  currency           text not null default 'GBP',
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),

  constraint project_deposit_requests_request_artist_fkey
    foreign key (payment_request_id, artist_id)
    references public.payment_requests(id, artist_id)
    on delete restrict,
  constraint project_deposit_requests_project_artist_fkey
    foreign key (project_id, artist_id)
    references public.projects(id, artist_id)
    on delete restrict,
  constraint project_deposit_requests_policy_artist_version_fkey
    foreign key (policy_id, artist_id, policy_version)
    references public.artist_project_deposit_policies(id, artist_id, version)
    on delete restrict,
  constraint project_deposit_requests_currency_gbp check (currency = 'GBP'),
  constraint project_deposit_requests_positive_amount check (amount > 0),
  constraint project_deposit_requests_positive_suggested check (suggested_amount > 0),
  constraint project_deposit_requests_amount_source
    check (amount = coalesce(override_amount, suggested_amount))
);

create index project_deposit_requests_project_idx
  on public.project_deposit_requests (project_id, created_at desc);

alter table public.project_deposit_requests enable row level security;
alter table public.project_deposit_requests force row level security;
revoke all on public.project_deposit_requests
  from public, anon, authenticated, service_role;

comment on table public.project_deposit_requests is
  'Immutable evidence of exactly which project facts, policy version and authorised override produced the amount of one project deposit payment request. Later policy or override changes never rewrite it.';

create or replace function crm_private.block_project_deposit_request_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  raise exception 'an issued project deposit pricing snapshot is immutable'
    using errcode = '42501';
end;
$$;

revoke all on function crm_private.block_project_deposit_request_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists project_deposit_requests_block_mutation
  on public.project_deposit_requests;
create trigger project_deposit_requests_block_mutation
  before update or delete on public.project_deposit_requests
  for each row execute function crm_private.block_project_deposit_request_mutation();

-- ---------------------------------------------------------------------------
-- 4. Canonical server-side project deposit calculation
-- ---------------------------------------------------------------------------

-- The single place the project deposit amount is computed. Browser previews
-- read this through an RPC rather than reimplementing the rule.
create or replace function crm_private.resolve_project_deposit(
  p_project_id uuid
)
returns table (
  artist_id uuid,
  client_id uuid,
  currency text,
  policy_id uuid,
  policy_version integer,
  mode text,
  fixed_amount numeric,
  percentage numeric,
  minimum_amount numeric,
  rounding_step numeric,
  estimate_total numeric,
  suggested_amount numeric,
  override_amount numeric,
  amount numeric
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_project public.projects%rowtype;
  v_policy public.artist_project_deposit_policies%rowtype;
  v_suggested numeric(12,2);
begin
  select * into v_project
  from public.projects p
  where p.id = p_project_id;
  if not found then
    raise exception 'project % does not exist', p_project_id using errcode = '23503';
  end if;

  select * into v_policy
  from public.artist_project_deposit_policies q
  where q.artist_id = v_project.artist_id
    and q.is_active
    and q.effective_from <= now()
    and (q.effective_until is null or q.effective_until > now())
  order by q.version desc
  limit 1;
  if not found then
    raise exception 'this artist has no active project deposit policy'
      using errcode = '22023';
  end if;

  if v_policy.currency <> v_project.currency then
    raise exception 'the project currency does not match the project deposit policy'
      using errcode = '22023';
  end if;

  if v_policy.mode = 'fixed' then
    v_suggested := v_policy.fixed_amount;
  else
    if v_project.estimate_total is null or v_project.estimate_total <= 0 then
      raise exception 'a percentage project deposit needs a positive project estimate'
        using errcode = '22023';
    end if;
    -- Round up to a whole rounding step so the deposit never under-collects.
    v_suggested := ceil(
      (v_project.estimate_total * v_policy.percentage / 100.0) / v_policy.rounding_step
    ) * v_policy.rounding_step;
  end if;

  if v_policy.minimum_amount is not null and v_suggested < v_policy.minimum_amount then
    v_suggested := v_policy.minimum_amount;
  end if;

  if v_suggested <= 0 or v_suggested > 100000.00 then
    raise exception 'the calculated project deposit is outside the supported range'
      using errcode = '22023';
  end if;

  return query
  select v_project.artist_id,
         v_project.client_id,
         v_project.currency,
         v_policy.id,
         v_policy.version,
         v_policy.mode,
         v_policy.fixed_amount,
         v_policy.percentage,
         v_policy.minimum_amount,
         v_policy.rounding_step,
         v_project.estimate_total,
         v_suggested,
         v_project.deposit_override_amount,
         coalesce(v_project.deposit_override_amount, v_suggested);
end;
$$;

revoke all on function crm_private.resolve_project_deposit(uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.resolve_project_deposit(uuid) is
  'Canonical server-side project deposit calculation. Produces any valid amount from project facts, the active artist policy and an authorised override; no browser value reaches it.';

-- ---------------------------------------------------------------------------
-- 5. Policy configuration and finance-scoped reads
-- ---------------------------------------------------------------------------

create or replace function public.configure_project_deposit_policy(
  p_artist_id uuid,
  p_mode text,
  p_fixed_amount numeric default null,
  p_percentage numeric default null,
  p_minimum_amount numeric default null,
  p_rounding_step numeric default 1.00
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_next_version integer;
  v_policy public.artist_project_deposit_policies%rowtype;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_finance');
  perform crm_private.require_active_artist(p_artist_id);

  p_mode := lower(btrim(coalesce(p_mode, '')));
  if p_mode not in ('fixed', 'percentage_of_estimate') then
    raise exception 'project deposit mode must be fixed or percentage_of_estimate'
      using errcode = '22023';
  end if;

  p_rounding_step := coalesce(p_rounding_step, 1.00);

  if p_mode = 'fixed' then
    p_percentage := null;
    if p_fixed_amount is null or p_fixed_amount <= 0 or p_fixed_amount > 100000.00 then
      raise exception 'a fixed project deposit needs an amount between 0.01 and 100000.00'
        using errcode = '22023';
    end if;
  else
    p_fixed_amount := null;
    if p_percentage is null or p_percentage <= 0 or p_percentage > 100 then
      raise exception 'a percentage project deposit needs a percentage between 0.01 and 100'
        using errcode = '22023';
    end if;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('project-deposit-policy:' || p_artist_id::text, 0)
  );

  -- now() is the transaction timestamp, so a policy created and superseded in
  -- the same transaction would otherwise close exactly when it opened.
  update public.artist_project_deposit_policies q
  set is_active = false,
      effective_until = greatest(now(), q.effective_from + interval '1 microsecond')
  where q.artist_id = p_artist_id
    and q.is_active
    and q.effective_until is null;

  select coalesce(max(q.version), 0) + 1 into v_next_version
  from public.artist_project_deposit_policies q
  where q.artist_id = p_artist_id;

  insert into public.artist_project_deposit_policies (
    artist_id, version, mode, fixed_amount, percentage,
    minimum_amount, rounding_step, currency, is_active, created_by
  ) values (
    p_artist_id, v_next_version, p_mode,
    round(p_fixed_amount, 2), round(p_percentage, 2),
    round(p_minimum_amount, 2), round(p_rounding_step, 2),
    'GBP', true, auth.uid()
  )
  returning * into v_policy;

  perform crm_private.log_artist_activity(
    p_artist_id,
    'payment.project_deposit_policy_configured',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    null, null, null, null, null,
    jsonb_build_object(
      'policy_id', v_policy.id,
      'policy_version', v_policy.version,
      'mode', v_policy.mode,
      'currency', v_policy.currency
    )
  );

  return jsonb_build_object(
    'policy_id', v_policy.id,
    'artist_id', p_artist_id,
    'version', v_policy.version,
    'mode', v_policy.mode,
    'fixed_amount', v_policy.fixed_amount,
    'percentage', v_policy.percentage,
    'minimum_amount', v_policy.minimum_amount,
    'rounding_step', v_policy.rounding_step,
    'currency', v_policy.currency,
    'is_active', v_policy.is_active
  );
end;
$$;

create or replace function public.get_project_deposit_policy(
  p_artist_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_policy public.artist_project_deposit_policies%rowtype;
begin
  perform crm_private.require_artist_access(p_artist_id, 'view_finance');

  select * into v_policy
  from public.artist_project_deposit_policies q
  where q.artist_id = p_artist_id
    and q.is_active
    and q.effective_from <= now()
    and (q.effective_until is null or q.effective_until > now())
  order by q.version desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'artist_id', p_artist_id,
      'configured', false,
      'currency', 'GBP'
    );
  end if;

  return jsonb_build_object(
    'artist_id', p_artist_id,
    'configured', true,
    'policy_id', v_policy.id,
    'version', v_policy.version,
    'mode', v_policy.mode,
    'fixed_amount', v_policy.fixed_amount,
    'percentage', v_policy.percentage,
    'minimum_amount', v_policy.minimum_amount,
    'rounding_step', v_policy.rounding_step,
    'currency', v_policy.currency
  );
end;
$$;

-- Server-calculated preview for the Project screen. The browser renders this
-- rather than recomputing the policy, so a preview can never drift from the
-- amount a request would actually be created with.
create or replace function public.preview_project_deposit(
  p_project_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_project public.projects%rowtype;
  v_deposit record;
  v_destination_ready boolean := false;
  v_open_request public.payment_requests%rowtype;
begin
  select * into v_project
  from public.projects p
  where p.id = p_project_id;
  if not found then
    raise exception 'project % does not exist', p_project_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_project.artist_id, 'view_finance');

  select * into v_open_request
  from public.payment_requests r
  where r.project_id = p_project_id
    and r.session_id is null
    and r.purpose = 'deposit'
    and r.status in ('pending', 'partially_paid', 'paid')
  order by r.created_at desc
  limit 1;

  begin
    select * into v_deposit from crm_private.resolve_project_deposit(p_project_id);
  exception when others then
    return jsonb_build_object(
      'project_id', p_project_id,
      'currency', v_project.currency,
      'estimate_total', v_project.estimate_total,
      'estimated_hours', v_project.estimated_hours,
      'estimated_sessions', v_project.estimated_sessions,
      'policy_configured', false,
      'calculable', false,
      'reason', sqlerrm,
      'override_amount', v_project.deposit_override_amount,
      'open_payment_request_id', v_open_request.id,
      'open_payment_request_status', v_open_request.status::text
    );
  end;

  -- Presence only. The catalogue URL never reaches the browser.
  select exists (
    select 1
    from public.monzo_payment_destinations d
    where d.artist_id = v_deposit.artist_id
      and d.amount = v_deposit.amount
      and d.currency = v_deposit.currency
      and d.archived_at is null
  ) into v_destination_ready;

  return jsonb_build_object(
    'project_id', p_project_id,
    'artist_id', v_deposit.artist_id,
    'currency', v_deposit.currency,
    'estimate_total', v_deposit.estimate_total,
    'estimated_hours', v_project.estimated_hours,
    'estimated_sessions', v_project.estimated_sessions,
    'policy_configured', true,
    'calculable', true,
    'policy_id', v_deposit.policy_id,
    'policy_version', v_deposit.policy_version,
    'mode', v_deposit.mode,
    'fixed_amount', v_deposit.fixed_amount,
    'percentage', v_deposit.percentage,
    'minimum_amount', v_deposit.minimum_amount,
    'rounding_step', v_deposit.rounding_step,
    'suggested_amount', v_deposit.suggested_amount,
    'override_amount', v_deposit.override_amount,
    'amount', v_deposit.amount,
    'reusable_destination_configured', v_destination_ready,
    'open_payment_request_id', v_open_request.id,
    'open_payment_request_status', v_open_request.status::text
  );
end;
$$;

create or replace function public.set_project_deposit_override(
  p_project_id uuid,
  p_amount numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_project public.projects%rowtype;
  v_amount numeric(12,2);
begin
  select * into v_project
  from public.projects p
  where p.id = p_project_id
  for update;
  if not found then
    raise exception 'project % does not exist', p_project_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_project.artist_id, 'manage_finance');
  perform crm_private.require_active_artist(v_project.artist_id);

  if p_amount is null then
    v_amount := null;
  else
    v_amount := round(p_amount::numeric, 2);
    if v_amount <> p_amount then
      raise exception 'a project deposit override may not have sub-penny precision'
        using errcode = '22023';
    end if;
    if v_amount <= 0 or v_amount > 100000.00 then
      raise exception 'a project deposit override must be between 0.01 and 100000.00'
        using errcode = '22023';
    end if;
  end if;

  update public.projects p
  set deposit_override_amount = v_amount,
      deposit_override_set_by = case when v_amount is null then null else auth.uid() end,
      deposit_override_set_at = case when v_amount is null then null else now() end
  where p.id = p_project_id;

  -- The amount itself is finance data and is deliberately not copied into the
  -- audit trail; the state change and the actor are what the log records.
  perform crm_private.log_artist_activity(
    v_project.artist_id,
    case when v_amount is null then 'project.deposit_override_cleared'
         else 'project.deposit_override_set' end,
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_project.client_id, null, p_project_id, null, null,
    jsonb_build_object('currency', v_project.currency)
  );

  return jsonb_build_object(
    'project_id', p_project_id,
    'override_set', v_amount is not null,
    'currency', v_project.currency
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Authoritative project deposit request
-- ---------------------------------------------------------------------------

create or replace function public.request_project_deposit(
  p_project_id uuid,
  p_idempotency_key uuid,
  p_delivery_channel text default 'copy_link'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_project public.projects%rowtype;
  v_deposit record;
  v_route record;
  v_existing public.project_deposit_requests%rowtype;
  v_open public.payment_requests%rowtype;
  v_request_result jsonb;
  v_request_id uuid;
  v_link public.payment_request_links%rowtype;
  v_destination_source text;
begin
  if p_project_id is null or p_idempotency_key is null then
    raise exception 'project and idempotency key are required' using errcode = '22023';
  end if;

  p_delivery_channel := lower(btrim(coalesce(p_delivery_channel, '')));
  if p_delivery_channel not in ('email', 'copy_link') then
    raise exception 'deposit delivery channel is invalid' using errcode = '22023';
  end if;

  select * into v_project
  from public.projects p
  where p.id = p_project_id
  for update;
  if not found then
    raise exception 'project % does not exist', p_project_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_project.artist_id, 'manage_finance');
  perform crm_private.require_active_artist(v_project.artist_id);

  if v_project.archived_at is not null or v_project.status = 'cancelled' then
    raise exception 'a deposit cannot be requested for a closed project'
      using errcode = '22023';
  end if;

  -- Replay the same idempotency key without creating a second request.
  select d.* into v_existing
  from public.project_deposit_requests d
  join public.payment_requests r on r.id = d.payment_request_id
  where r.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.project_id <> p_project_id then
      raise exception 'project deposit idempotency key was reused with a different project'
        using errcode = '22023';
    end if;

    select * into v_link
    from public.payment_request_links l
    where l.payment_request_id = v_existing.payment_request_id;

    select d.source into v_destination_source
    from public.payment_request_payment_destinations d
    where d.payment_request_id = v_existing.payment_request_id;

    return jsonb_build_object(
      'payment_request_id', v_existing.payment_request_id,
      'payment_link_id', v_link.id,
      'public_path', '/pay-by-bank-transfer/' || v_link.public_id::text,
      'amount', v_existing.amount,
      'currency', v_existing.currency,
      'suggested_amount', v_existing.suggested_amount,
      'override_amount', v_existing.override_amount,
      'destination_source', v_destination_source,
      'destination_ready', v_destination_source is not null,
      'delivery_channel', p_delivery_channel,
      'delivery_status', case
        when p_delivery_channel = 'email' then 'queued_provider_not_connected'
        else 'link_created'
      end,
      'replayed', true
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('project-deposit:' || p_project_id::text, 0)
  );

  -- One live project-level deposit request per project. A different amount
  -- requires cancelling the open request first: an issued request is never
  -- repriced.
  select * into v_open
  from public.payment_requests r
  where r.project_id = p_project_id
    and r.session_id is null
    and r.purpose = 'deposit'
    and r.status in ('pending', 'partially_paid', 'paid')
  order by r.created_at desc
  limit 1;
  if found then
    raise exception 'this project already has an open or paid project deposit request'
      using errcode = '22023';
  end if;

  -- The amount is calculated here, from project facts and the artist policy.
  -- The caller supplies no amount at all.
  select * into v_deposit from crm_private.resolve_project_deposit(p_project_id);

  select * into v_route
  from crm_private.resolve_enabled_payment_route(v_project.artist_id);
  if v_route.provider <> 'monzo_easy_bank_transfer' then
    raise exception 'Monzo Easy Bank Transfer is not the enabled payment destination'
      using errcode = '22023';
  end if;

  v_request_result := public.create_payment_request(
    p_idempotency_key,
    v_deposit.artist_id,
    v_deposit.client_id,
    'deposit',
    v_deposit.amount,
    p_project_id,
    null,
    v_deposit.currency,
    null
  );
  v_request_id := (v_request_result ->> 'payment_request_id')::uuid;

  insert into public.project_deposit_requests (
    payment_request_id, artist_id, client_id, project_id,
    policy_id, policy_version, mode, fixed_amount, percentage,
    minimum_amount, rounding_step, estimate_total,
    suggested_amount, override_amount, amount, currency, created_by
  ) values (
    v_request_id, v_deposit.artist_id, v_deposit.client_id, p_project_id,
    v_deposit.policy_id, v_deposit.policy_version, v_deposit.mode,
    v_deposit.fixed_amount, v_deposit.percentage,
    v_deposit.minimum_amount, v_deposit.rounding_step, v_deposit.estimate_total,
    v_deposit.suggested_amount, v_deposit.override_amount, v_deposit.amount,
    v_deposit.currency, auth.uid()
  );

  -- The destination is an ordinary artist + amount + currency lookup, frozen
  -- into this request the moment it is issued.
  v_destination_source := crm_private.bind_payment_request_destination(v_request_id);

  insert into public.payment_request_links (
    payment_request_id, artist_id, created_by
  ) values (
    v_request_id, v_deposit.artist_id, auth.uid()
  )
  on conflict (payment_request_id) do nothing;

  select * into v_link
  from public.payment_request_links l
  where l.payment_request_id = v_request_id;

  if p_delivery_channel = 'email' then
    insert into public.integration_outbox (
      kind, dedupe_key, payload,
      artist_id, client_id, project_id, session_id
    ) values (
      'transactional_email',
      'project_deposit_email:' || v_request_id::text,
      jsonb_build_object(
        'template', 'deposit_request',
        'template_version', 1,
        'payment_link_id', v_link.id,
        'payment_request_id', v_request_id
      ),
      v_deposit.artist_id,
      v_deposit.client_id,
      p_project_id,
      null
    )
    on conflict (dedupe_key) do nothing;
  end if;

  perform crm_private.log_artist_activity(
    v_deposit.artist_id,
    'payment.project_deposit_requested',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_deposit.client_id, null, p_project_id, null, null,
    jsonb_build_object(
      'payment_request_id', v_request_id,
      'policy_id', v_deposit.policy_id,
      'policy_version', v_deposit.policy_version,
      'mode', v_deposit.mode,
      'overridden', v_deposit.override_amount is not null,
      'currency', v_deposit.currency
    )
  );

  return jsonb_build_object(
    'payment_request_id', v_request_id,
    'payment_link_id', v_link.id,
    'public_path', '/pay-by-bank-transfer/' || v_link.public_id::text,
    'amount', v_deposit.amount,
    'currency', v_deposit.currency,
    'suggested_amount', v_deposit.suggested_amount,
    'override_amount', v_deposit.override_amount,
    'destination_source', v_destination_source,
    'destination_ready', v_destination_source is not null,
    'delivery_channel', p_delivery_channel,
    'delivery_status', case
      when p_delivery_channel = 'email' then 'queued_provider_not_connected'
      else 'link_created'
    end,
    'replayed', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. A project deposit amount may only come from a server-side workflow
-- ---------------------------------------------------------------------------

-- create_payment_request is a general finance RPC that accepts an amount. For a
-- session-backed deposit, migration 0057 already forces that amount to match
-- the server duration policy. This closes the equivalent project-level gap:
-- once an artist has an active project deposit policy, a project-level deposit
-- request must be backed either by the normalized grouped-session evidence or
-- by the project deposit pricing snapshot, both of which are written only by
-- server-side workflows. The check is deferred so the workflow can insert its
-- evidence row after the request row inside the same transaction.
create or replace function crm_private.guard_project_deposit_request_amount()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.purpose <> 'deposit'
     or new.session_id is not null
     or new.project_id is null then
    return new;
  end if;

  if not exists (
    select 1
    from public.artist_project_deposit_policies q
    where q.artist_id = new.artist_id
      and q.is_active
      and q.effective_from <= now()
      and (q.effective_until is null or q.effective_until > now())
  ) then
    return new;
  end if;

  if exists (
    select 1 from public.session_deposit_groups g
    where g.payment_request_id = new.id
  ) then
    return new;
  end if;

  if exists (
    select 1 from public.project_deposit_requests d
    where d.payment_request_id = new.id
      and d.amount = new.amount
      and d.currency = new.currency
      and d.artist_id = new.artist_id
      and d.project_id = new.project_id
  ) then
    return new;
  end if;

  raise exception 'a project deposit amount must come from the server-side project deposit workflow'
    using errcode = '22023';
end;
$$;

revoke all on function crm_private.guard_project_deposit_request_amount()
  from public, anon, authenticated, service_role;

drop trigger if exists payment_requests_project_deposit_guard
  on public.payment_requests;
create constraint trigger payment_requests_project_deposit_guard
  after insert on public.payment_requests
  deferrable initially deferred
  for each row execute function crm_private.guard_project_deposit_request_amount();

-- ---------------------------------------------------------------------------
-- 8. A project deposit request may also carry a one-off destination
-- ---------------------------------------------------------------------------

create or replace function public.attach_monzo_one_off_payment_destination(
  p_payment_request_id uuid,
  p_payment_url text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_request public.payment_requests%rowtype;
  v_group public.session_deposit_groups%rowtype;
  v_existing public.payment_request_payment_destinations%rowtype;
  v_replaced boolean := false;
  v_public_id uuid;
begin
  select * into v_request
  from public.payment_requests r
  where r.id = p_payment_request_id
  for update;
  if not found then
    raise exception 'payment request % does not exist', p_payment_request_id
      using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_request.artist_id, 'manage_finance');
  perform crm_private.require_active_artist(v_request.artist_id);

  p_payment_url := btrim(coalesce(p_payment_url, ''));
  if p_payment_url !~ '^https://monzo[.]com/pay/r/[A-Za-z0-9_-]{4,255}$' then
    raise exception 'Monzo payment URL is invalid' using errcode = '22023';
  end if;

  if v_request.provider is distinct from 'monzo_easy_bank_transfer'
     or v_request.purpose <> 'deposit'
     or v_request.currency <> 'GBP'
     or v_request.status not in ('pending', 'partially_paid') then
    raise exception 'a one-off Monzo destination applies only to an open server-priced deposit request'
      using errcode = '22023';
  end if;

  if v_request.session_id is not null then
    -- Single-session requests keep the immutable duration pricing snapshot.
    if v_request.policy_id is null or v_request.policy_version is null then
      raise exception 'single-session deposit terms are incomplete' using errcode = '22023';
    end if;
  elsif exists (
    select 1 from public.project_deposit_requests d
    where d.payment_request_id = v_request.id
      and d.artist_id = v_request.artist_id
      and d.project_id = v_request.project_id
      and d.amount = v_request.amount
      and d.currency = v_request.currency
  ) then
    -- A project deposit request proves its amount through its own immutable
    -- pricing snapshot.
    null;
  else
    -- Otherwise a project-level request is accepted only when the normalized
    -- group proves exactly which sessions produced this immutable amount.
    select * into v_group
    from public.session_deposit_groups g
    where g.payment_request_id = v_request.id
      and g.artist_id = v_request.artist_id
      and g.client_id = v_request.client_id
      and g.project_id = v_request.project_id
      and g.total_amount = v_request.amount
      and g.currency = v_request.currency;
    if not found then
      raise exception 'a one-off Monzo destination requires a single-session, grouped or project deposit request'
        using errcode = '22023';
    end if;
  end if;

  -- The immutable payment request is the authoritative pricing snapshot. The
  -- browser supplies only the URL; it cannot supply artist, amount, currency,
  -- provider account or policy version.

  if not exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = v_request.artist_id
      and i.integration_type = 'payments'
      and i.provider = 'monzo_easy_bank_transfer'
      and i.integration_key = v_request.provider_account_key
      and i.is_enabled
  ) then
    raise exception 'Monzo Easy Bank Transfer is not the enabled payment destination'
      using errcode = '22023';
  end if;

  select * into v_existing
  from public.payment_request_payment_destinations d
  where d.payment_request_id = v_request.id;
  v_replaced := found;

  -- A one-off fills a gap. It never overrides a destination the request was
  -- already issued with, and never overrides a live reusable entry.
  if v_replaced and v_existing.source <> 'one_off' then
    raise exception 'this request was already issued with a reusable Monzo destination'
      using errcode = '22023';
  end if;

  if not v_replaced and exists (
    select 1
    from public.monzo_payment_destinations d
    where d.artist_id = v_request.artist_id
      and d.amount = v_request.amount
      and d.currency = v_request.currency
      and d.archived_at is null
  ) then
    raise exception 'this amount already has a reusable Monzo destination'
      using errcode = '22023';
  end if;

  -- A URL cannot be a reusable destination and a one-off, nor can a one-off be
  -- shared by two requests or two artists.
  if exists (
    select 1 from public.monzo_payment_destinations d
    where d.payment_url = p_payment_url
  ) then
    raise exception 'this Monzo URL is already a reusable destination'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.payment_request_payment_destinations d
    where d.payment_url = p_payment_url
      and d.source = 'one_off'
      and d.payment_request_id <> v_request.id
  ) then
    raise exception 'this Monzo URL is already attached to another payment request'
      using errcode = '22023';
  end if;

  insert into public.payment_request_payment_destinations (
    payment_request_id, artist_id, amount, currency, payment_url,
    source, created_by, updated_by
  ) values (
    v_request.id, v_request.artist_id, v_request.amount, v_request.currency,
    p_payment_url, 'one_off', auth.uid(), auth.uid()
  )
  on conflict (payment_request_id) do update
  set payment_url = excluded.payment_url,
      updated_by = excluded.updated_by,
      updated_at = now();

  insert into public.payment_request_links (
    payment_request_id, artist_id, created_by
  ) values (
    v_request.id, v_request.artist_id, auth.uid()
  )
  on conflict (payment_request_id) do nothing;

  select l.public_id into v_public_id
  from public.payment_request_links l
  where l.payment_request_id = v_request.id;

  perform crm_private.log_artist_activity(
    v_request.artist_id,
    'payment.one_off_destination_attached',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_request.client_id, null, v_request.project_id, v_request.session_id, null,
    jsonb_build_object(
      'payment_request_id', v_request.id,
      'currency', v_request.currency,
      'replaced', v_replaced,
      'grouped', v_request.session_id is null
    )
  );

  return jsonb_build_object(
    'payment_request_id', v_request.id,
    'public_path', '/pay-by-bank-transfer/' || v_public_id::text,
    'amount', v_request.amount,
    'currency', v_request.currency,
    'replaced', v_replaced,
    'confirmed', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Closed API surface
-- ---------------------------------------------------------------------------

revoke all on function public.configure_project_deposit_policy(uuid,text,numeric,numeric,numeric,numeric)
  from public, anon, authenticated, service_role;
revoke all on function public.get_project_deposit_policy(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.preview_project_deposit(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.set_project_deposit_override(uuid,numeric)
  from public, anon, authenticated, service_role;
revoke all on function public.request_project_deposit(uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.attach_monzo_one_off_payment_destination(uuid,text)
  from public, anon, authenticated, service_role;

grant execute on function public.configure_project_deposit_policy(uuid,text,numeric,numeric,numeric,numeric)
  to authenticated;
grant execute on function public.get_project_deposit_policy(uuid)
  to authenticated;
grant execute on function public.preview_project_deposit(uuid)
  to authenticated;
grant execute on function public.set_project_deposit_override(uuid,numeric)
  to authenticated;
grant execute on function public.request_project_deposit(uuid,uuid,text)
  to authenticated;
grant execute on function public.attach_monzo_one_off_payment_destination(uuid,text)
  to authenticated;

comment on function public.configure_project_deposit_policy(uuid,text,numeric,numeric,numeric,numeric) is
  'Creates a new version of one artist project deposit policy. Existing payment requests keep the policy version they were priced with.';
comment on function public.get_project_deposit_policy(uuid) is
  'Finance-scoped read of the active artist project deposit policy. Returns no provider URL, credential or bank account id.';
comment on function public.preview_project_deposit(uuid) is
  'Server-calculated, explicitly non-authoritative preview of the project deposit a request would be created with. Reports only whether a reusable destination exists, never its URL.';
comment on function public.set_project_deposit_override(uuid,numeric) is
  'Sets or clears the authorised project deposit override for future requests. It never reprices an already issued payment request.';
comment on function public.request_project_deposit(uuid,uuid,text) is
  'Creates or replays one artist-scoped project deposit request. The amount is calculated server-side from project facts, the artist policy and an authorised override; the caller supplies no amount.';
comment on function public.attach_monzo_one_off_payment_destination(uuid,text) is
  'Attaches one clean Monzo URL to one open single-session, grouped or project deposit request that has no bound destination and no live reusable entry for its immutable amount. Never settles payment.';
