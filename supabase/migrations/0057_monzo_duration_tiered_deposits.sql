-- 0057_monzo_duration_tiered_deposits.sql
--
-- Replace the Monzo session-deposit fixed GBP 250 rule with an artist-scoped,
-- versioned duration schedule:
--   up to 60 minutes   -> GBP 50
--   61..180 minutes    -> GBP 100
--   181..300 minutes   -> GBP 150
--   more than 300 min  -> GBP 250
--
-- The browser never supplies the amount. Session start_at/end_at remain the
-- authoritative duration and every created payment_request keeps its amount
-- immutable. Existing pending requests are never silently repriced after a
-- session duration change.
--
-- Forward-only. No provider connection, payment settlement or production
-- activation is performed by this migration.

-- ---------------------------------------------------------------------------
-- Immutable duration tiers attached to a versioned artist payment policy
-- ---------------------------------------------------------------------------

create table if not exists public.artist_payment_policy_session_tiers (
  policy_id       uuid not null,
  artist_id       uuid not null,
  policy_version  integer not null,
  tier_order      smallint not null,
  max_minutes     integer,
  amount          numeric(12,2) not null,
  currency        text not null default 'GBP',
  created_at      timestamptz not null default now(),

  constraint artist_payment_policy_session_tiers_pkey
    primary key (policy_id, tier_order),
  constraint artist_payment_policy_session_tiers_policy_fkey
    foreign key (policy_id, artist_id, policy_version)
    references public.artist_payment_policies(id, artist_id, version)
    on delete restrict,
  constraint artist_payment_policy_session_tiers_order_shape
    check (tier_order between 1 and 4),
  constraint artist_payment_policy_session_tiers_boundary_shape
    check (
      (tier_order = 1 and max_minutes = 60)
      or (tier_order = 2 and max_minutes = 180)
      or (tier_order = 3 and max_minutes = 300)
      or (tier_order = 4 and max_minutes is null)
    ),
  constraint artist_payment_policy_session_tiers_positive_amount
    check (amount > 0),
  constraint artist_payment_policy_session_tiers_currency_gbp
    check (currency = 'GBP')
);

create index if not exists artist_payment_policy_session_tiers_artist_idx
  on public.artist_payment_policy_session_tiers (artist_id, policy_version, tier_order);

alter table public.artist_payment_policy_session_tiers enable row level security;
alter table public.artist_payment_policy_session_tiers force row level security;
revoke all on public.artist_payment_policy_session_tiers
  from public, anon, authenticated, service_role;

comment on table public.artist_payment_policy_session_tiers is
  'Immutable duration bands for one versioned per-session deposit policy. Browser callers never choose the resulting amount.';
comment on column public.artist_payment_policy_session_tiers.max_minutes is
  'Inclusive upper duration bound. NULL is allowed only for the final open-ended full-day tier.';

create or replace function crm_private.block_session_deposit_tier_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  raise exception 'session deposit tiers are immutable; create a new payment policy version'
    using errcode = '42501';
end;
$$;

revoke all on function crm_private.block_session_deposit_tier_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists artist_payment_policy_session_tiers_block_mutation
  on public.artist_payment_policy_session_tiers;
create trigger artist_payment_policy_session_tiers_block_mutation
  before update or delete on public.artist_payment_policy_session_tiers
  for each row execute function crm_private.block_session_deposit_tier_mutation();

-- ---------------------------------------------------------------------------
-- Canonical server-side tier resolution
-- ---------------------------------------------------------------------------

create or replace function crm_private.resolve_session_deposit_tier(
  p_artist_id uuid,
  p_session_id uuid
)
returns table (
  policy_id uuid,
  policy_version integer,
  duration_minutes integer,
  tier_order smallint,
  max_minutes integer,
  amount numeric,
  currency text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_start_at timestamptz;
  v_end_at timestamptz;
  v_duration_minutes integer;
begin
  select s.start_at, s.end_at
    into v_start_at, v_end_at
  from public.sessions s
  where s.id = p_session_id
    and s.artist_id = p_artist_id;

  if not found then
    raise exception 'appointment does not exist' using errcode = '23503';
  end if;

  v_duration_minutes := ceil(extract(epoch from (v_end_at - v_start_at)) / 60.0)::integer;
  if v_duration_minutes <= 0 then
    raise exception 'appointment duration is invalid' using errcode = '22023';
  end if;

  return query
  select p.id,
         p.version,
         v_duration_minutes,
         t.tier_order,
         t.max_minutes,
         t.amount,
         t.currency
  from public.artist_payment_policies p
  join public.artist_payment_policy_session_tiers t
    on t.policy_id = p.id
   and t.artist_id = p.artist_id
   and t.policy_version = p.version
  where p.artist_id = p_artist_id
    and p.is_active
    and p.effective_from <= now()
    and (p.effective_until is null or p.effective_until > now())
    and p.deposit_mode = 'per_session_fixed'
    and p.fixed_amount = 250.00
    and p.transfer_allowed
    and p.refund_policy_version = 'monzo-ebt-duration-v1'
    and (t.max_minutes is null or v_duration_minutes <= t.max_minutes)
  order by t.tier_order
  limit 1;

  if not found then
    raise exception 'the active duration deposit policy is unavailable'
      using errcode = '22023';
  end if;
end;
$$;

revoke all on function crm_private.resolve_session_deposit_tier(uuid,uuid)
  from public, anon, authenticated, service_role;

-- Enforce the duration amount for every session-backed deposit insert, not only
-- for the convenience RPC. This closes the lower-level create_payment_request
-- path while preserving non-session and non-tiered payment workflows.
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
  if new.purpose <> 'deposit' or new.session_id is null then
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

revoke all on function crm_private.guard_session_deposit_tier_amount()
  from public, anon, authenticated, service_role;

drop trigger if exists payment_requests_session_deposit_tier_guard
  on public.payment_requests;
create trigger payment_requests_session_deposit_tier_guard
  before insert on public.payment_requests
  for each row execute function crm_private.guard_session_deposit_tier_amount();

-- ---------------------------------------------------------------------------
-- Monzo configuration now activates a duration-tiered per-session policy
-- ---------------------------------------------------------------------------

create or replace function public.configure_monzo_easy_bank_transfer(
  p_artist_id uuid,
  p_payment_url text,
  p_is_enabled boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_integration_key text;
  v_policy public.artist_payment_policies%rowtype;
  v_next_version integer;
  v_tiers_match boolean := false;
  v_result jsonb;
  v_tiers jsonb := jsonb_build_array(
    jsonb_build_object('max_minutes', 60, 'amount', 50, 'currency', 'GBP'),
    jsonb_build_object('max_minutes', 180, 'amount', 100, 'currency', 'GBP'),
    jsonb_build_object('max_minutes', 300, 'amount', 150, 'currency', 'GBP'),
    jsonb_build_object('max_minutes', null, 'amount', 250, 'currency', 'GBP')
  );
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_finance');
  perform crm_private.require_active_artist(p_artist_id);

  p_payment_url := btrim(coalesce(p_payment_url, ''));
  if p_payment_url !~ '^https://monzo[.]com/pay/r/[A-Za-z0-9_-]{4,255}$' then
    raise exception 'Monzo Easy Bank Transfer URL is invalid'
      using errcode = '22023';
  end if;

  v_integration_key := 'monzo_ebt_' || replace(p_artist_id::text, '-', '');

  if p_is_enabled and exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = p_artist_id
      and i.integration_type = 'payments'
      and i.is_enabled
      and not (
        i.provider = 'monzo_easy_bank_transfer'
        and i.integration_key = v_integration_key
      )
  ) then
    raise exception 'disable the existing payment destination before enabling Monzo Easy Bank Transfer'
      using errcode = '22023';
  end if;

  select * into v_policy
  from public.artist_payment_policies p
  where p.artist_id = p_artist_id
    and p.is_active
    and p.effective_from <= now()
    and (p.effective_until is null or p.effective_until > now())
  order by p.version desc
  limit 1;

  if found then
    select count(*) = 4
       and count(*) filter (where t.tier_order = 1 and t.max_minutes = 60 and t.amount = 50.00 and t.currency = 'GBP') = 1
       and count(*) filter (where t.tier_order = 2 and t.max_minutes = 180 and t.amount = 100.00 and t.currency = 'GBP') = 1
       and count(*) filter (where t.tier_order = 3 and t.max_minutes = 300 and t.amount = 150.00 and t.currency = 'GBP') = 1
       and count(*) filter (where t.tier_order = 4 and t.max_minutes is null and t.amount = 250.00 and t.currency = 'GBP') = 1
      into v_tiers_match
    from public.artist_payment_policy_session_tiers t
    where t.policy_id = v_policy.id;
  end if;

  if not found
     or v_policy.deposit_mode <> 'per_session_fixed'
     or v_policy.fixed_amount <> 250.00
     or not v_policy.transfer_allowed
     or v_policy.refund_policy_version <> 'monzo-ebt-duration-v1'
     or not v_tiers_match then
    select coalesce(max(p.version), 0) + 1 into v_next_version
    from public.artist_payment_policies p
    where p.artist_id = p_artist_id;

    perform public.create_artist_payment_policy(
      p_artist_id,
      v_next_version,
      'per_session_fixed',
      250.00,
      null,
      72,
      true,
      'monzo-ebt-duration-v1',
      now()
    );

    select * into v_policy
    from public.artist_payment_policies p
    where p.artist_id = p_artist_id
      and p.is_active
    order by p.version desc
    limit 1;

    insert into public.artist_payment_policy_session_tiers (
      policy_id, artist_id, policy_version, tier_order, max_minutes, amount, currency
    ) values
      (v_policy.id, p_artist_id, v_policy.version, 1, 60, 50.00, 'GBP'),
      (v_policy.id, p_artist_id, v_policy.version, 2, 180, 100.00, 'GBP'),
      (v_policy.id, p_artist_id, v_policy.version, 3, 300, 150.00, 'GBP'),
      (v_policy.id, p_artist_id, v_policy.version, 4, null, 250.00, 'GBP');
  end if;

  v_result := public.configure_artist_integration(
    p_artist_id,
    'payments',
    'monzo_easy_bank_transfer',
    v_integration_key,
    'Monzo Business Easy Bank Transfer',
    jsonb_build_object(
      'payment_url', p_payment_url,
      'deposit_amount', 250,
      'deposit_policy', 'duration_tiered_v1',
      'deposit_tiers', v_tiers,
      'currency', 'GBP',
      'default_delivery_channel', 'email',
      'email_status', 'provider_not_connected',
      'sms_status', 'not_configured',
      'monzo_api_status', 'not_connected'
    ),
    p_is_enabled
  );

  return v_result || jsonb_build_object(
    'deposit_amount', 250,
    'deposit_policy', 'duration_tiered_v1',
    'deposit_tiers', v_tiers,
    'currency', 'GBP',
    'email_status', 'provider_not_connected',
    'sms_status', 'not_configured',
    'monzo_api_status', 'not_connected'
  );
end;
$$;

create or replace function public.get_monzo_easy_bank_transfer_settings(
  p_artist_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_integration public.artist_integrations%rowtype;
  v_policy public.artist_payment_policies%rowtype;
  v_tiers jsonb;
  v_default_tiers jsonb := jsonb_build_array(
    jsonb_build_object('max_minutes', 60, 'amount', 50, 'currency', 'GBP'),
    jsonb_build_object('max_minutes', 180, 'amount', 100, 'currency', 'GBP'),
    jsonb_build_object('max_minutes', 300, 'amount', 150, 'currency', 'GBP'),
    jsonb_build_object('max_minutes', null, 'amount', 250, 'currency', 'GBP')
  );
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_finance');

  select * into v_integration
  from public.artist_integrations i
  where i.artist_id = p_artist_id
    and i.integration_type = 'payments'
    and i.provider = 'monzo_easy_bank_transfer'
  order by i.updated_at desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'configured', false,
      'enabled', false,
      'payment_url', null,
      'deposit_amount', 250,
      'deposit_policy', 'duration_tiered_v1',
      'deposit_tiers', v_default_tiers,
      'currency', 'GBP',
      'default_delivery_channel', 'email',
      'email_status', 'provider_not_connected',
      'sms_status', 'not_configured',
      'monzo_api_status', 'not_connected'
    );
  end if;

  select * into v_policy
  from public.artist_payment_policies p
  where p.artist_id = p_artist_id
    and p.is_active
    and p.deposit_mode = 'per_session_fixed'
    and p.fixed_amount = 250.00
    and p.transfer_allowed
    and p.refund_policy_version = 'monzo-ebt-duration-v1'
    and p.effective_from <= now()
    and (p.effective_until is null or p.effective_until > now())
  order by p.version desc
  limit 1;

  if not found then
    raise exception 'the active duration deposit policy is unavailable'
      using errcode = '22023';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'max_minutes', t.max_minutes,
      'amount', t.amount,
      'currency', t.currency
    ) order by t.tier_order
  ) into v_tiers
  from public.artist_payment_policy_session_tiers t
  where t.policy_id = v_policy.id;

  if jsonb_array_length(coalesce(v_tiers, '[]'::jsonb)) <> 4 then
    raise exception 'the active duration deposit policy is incomplete'
      using errcode = '22023';
  end if;

  return jsonb_build_object(
    'configured', true,
    'enabled', v_integration.is_enabled,
    'payment_url', v_integration.configuration ->> 'payment_url',
    'deposit_amount', 250,
    'deposit_policy', 'duration_tiered_v1',
    'deposit_tiers', v_tiers,
    'currency', 'GBP',
    'default_delivery_channel', 'email',
    'email_status', 'provider_not_connected',
    'sms_status', 'not_configured',
    'monzo_api_status', 'not_connected'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- One-action deposit request, amount derived only from the session duration
-- ---------------------------------------------------------------------------

create or replace function public.request_session_deposit(
  p_session_id uuid,
  p_idempotency_key uuid,
  p_delivery_channel text default 'email'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_session public.sessions%rowtype;
  v_route record;
  v_tier record;
  v_existing public.payment_requests%rowtype;
  v_request_result jsonb;
  v_request_id uuid;
  v_link public.payment_request_links%rowtype;
  v_replayed boolean := false;
begin
  if p_session_id is null or p_idempotency_key is null then
    raise exception 'session and idempotency key are required'
      using errcode = '22023';
  end if;

  p_delivery_channel := lower(btrim(coalesce(p_delivery_channel, '')));
  if p_delivery_channel not in ('email', 'copy_link') then
    if p_delivery_channel = 'sms' then
      raise exception 'SMS deposit delivery is not configured'
        using errcode = '22023';
    end if;
    raise exception 'deposit delivery channel is invalid'
      using errcode = '22023';
  end if;

  select * into v_session
  from public.sessions s
  where s.id = p_session_id
  for update;
  if not found then
    raise exception 'appointment does not exist' using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_session.artist_id, 'manage_finance');
  perform crm_private.require_active_artist(v_session.artist_id);

  if v_session.appointment_type <> 'tattoo_session' or v_session.project_id is null then
    raise exception 'deposit requests are available only for project-backed tattoo sessions'
      using errcode = '22023';
  end if;
  if v_session.status in ('completed', 'cancelled', 'no_show') then
    raise exception 'deposit cannot be requested for a finished appointment'
      using errcode = '22023';
  end if;

  select * into v_route
  from crm_private.resolve_enabled_payment_route(v_session.artist_id);
  if v_route.provider <> 'monzo_easy_bank_transfer' then
    raise exception 'Monzo Easy Bank Transfer is not the enabled payment destination'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('session-deposit:' || p_session_id::text, 0));

  select * into v_tier
  from crm_private.resolve_session_deposit_tier(v_session.artist_id, v_session.id);

  if exists (
    select 1 from public.payment_requests r
    where r.session_id = p_session_id
      and r.purpose = 'deposit'
      and r.status = 'paid'
  ) then
    raise exception 'the appointment deposit is already paid'
      using errcode = '22023';
  end if;

  select * into v_existing
  from public.payment_requests r
  where r.session_id = p_session_id
    and r.purpose = 'deposit'
    and r.status in ('pending', 'partially_paid')
  order by r.created_at desc
  limit 1;

  if found then
    if v_existing.provider <> 'monzo_easy_bank_transfer'
       or v_existing.provider_account_key <> v_route.provider_account_key
       or v_existing.amount <> v_tier.amount
       or v_existing.currency <> v_tier.currency
       or v_existing.policy_id is distinct from v_tier.policy_id
       or v_existing.policy_version is distinct from v_tier.policy_version then
      raise exception 'an existing deposit request uses different payment terms'
        using errcode = '22023';
    end if;
    v_request_id := v_existing.id;
    v_replayed := true;
  else
    v_request_result := public.create_payment_request(
      p_idempotency_key,
      v_session.artist_id,
      v_session.client_id,
      'deposit',
      v_tier.amount,
      v_session.project_id,
      v_session.id,
      v_tier.currency,
      null
    );
    v_request_id := (v_request_result ->> 'payment_request_id')::uuid;
    v_replayed := coalesce((v_request_result ->> 'replayed')::boolean, false);
  end if;

  insert into public.payment_request_links (
    payment_request_id, artist_id, created_by
  ) values (
    v_request_id, v_session.artist_id, auth.uid()
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
      'deposit_email:' || v_request_id::text,
      jsonb_build_object(
        'template', 'deposit_request',
        'template_version', 1,
        'payment_link_id', v_link.id,
        'payment_request_id', v_request_id
      ),
      v_session.artist_id,
      v_session.client_id,
      v_session.project_id,
      v_session.id
    )
    on conflict (dedupe_key) do nothing;
  end if;

  return jsonb_build_object(
    'payment_request_id', v_request_id,
    'payment_link_id', v_link.id,
    'public_path', '/pay-by-bank-transfer/' || v_link.public_id::text,
    'amount', v_tier.amount,
    'currency', v_tier.currency,
    'duration_minutes', v_tier.duration_minutes,
    'tier_max_minutes', v_tier.max_minutes,
    'delivery_channel', p_delivery_channel,
    'delivery_status', case
      when p_delivery_channel = 'email' then 'queued_provider_not_connected'
      else 'link_created'
    end,
    'replayed', v_replayed
  );
end;
$$;

-- Keep the same closed RPC surface. The tier tables and helpers are never
-- directly callable/readable by browser roles.
revoke all on function public.configure_monzo_easy_bank_transfer(uuid,text,boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.get_monzo_easy_bank_transfer_settings(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.request_session_deposit(uuid,uuid,text)
  from public, anon, authenticated, service_role;

grant execute on function public.configure_monzo_easy_bank_transfer(uuid,text,boolean)
  to authenticated;
grant execute on function public.get_monzo_easy_bank_transfer_settings(uuid)
  to authenticated;
grant execute on function public.request_session_deposit(uuid,uuid,text)
  to authenticated;

comment on function public.configure_monzo_easy_bank_transfer(uuid,text,boolean) is
  'Finance-authorised setup for one artist Monzo Easy Bank Transfer route and server-owned GBP duration-tiered session deposit policy. Stores no Monzo API credential.';
comment on function public.get_monzo_easy_bank_transfer_settings(uuid) is
  'Finance-authorised safe Monzo deposit settings including non-secret duration tiers. No provider credential is returned.';
comment on function public.request_session_deposit(uuid,uuid,text) is
  'Creates or replays one artist-scoped Monzo deposit request whose amount is derived server-side from the locked tattoo-session duration.';
