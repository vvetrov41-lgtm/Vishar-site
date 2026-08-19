-- 0064_monzo_artist_payment_destinations.sql
--
-- Prepare Monzo payment destinations for multiple artists without changing any
-- existing provider connection or payment state.
--
-- This migration deliberately does only two product things:
--
--  1. Generalise the existing reusable destination catalogue from the four
--     current duration-tier amounts to an artist + amount + currency catalogue.
--     The table is renamed in place, so existing Vladimir rows and their
--     operator-owned URLs are preserved byte-for-byte.
--
--  2. Allow one request-specific one-off Monzo payment URL when that artist has
--     no reusable destination for the authoritative request amount. The URL is
--     bound to exactly one payment request and is never promoted into the
--     reusable catalogue.
--
-- Grouped deposits are intentionally not implemented here. Opening any payment
-- link remains navigation only; reconciliation remains candidate -> Match ->
-- separate Confirm payment; this migration never settles anything.

-- ---------------------------------------------------------------------------
-- 1. Artist-scoped reusable destination catalogue
-- ---------------------------------------------------------------------------

alter table public.monzo_easy_bank_transfer_tier_urls
  rename to monzo_payment_destinations;

alter table public.monzo_payment_destinations
  rename constraint monzo_easy_bank_transfer_tier_urls_pkey
  to monzo_payment_destinations_pkey;
alter table public.monzo_payment_destinations
  rename constraint monzo_easy_bank_transfer_tier_urls_distinct_url
  to monzo_payment_destinations_distinct_url;
alter table public.monzo_payment_destinations
  rename constraint monzo_easy_bank_transfer_tier_urls_currency_gbp
  to monzo_payment_destinations_currency_gbp;
alter table public.monzo_payment_destinations
  rename constraint monzo_easy_bank_transfer_tier_urls_url_shape
  to monzo_payment_destinations_url_shape;

-- Standard single-session deposits still resolve from the existing duration
-- policy (GBP 50/100/150/250). The catalogue itself is amount-generic so a
-- future server-authoritative amount can be provisioned as a row instead of a
-- schema rewrite. This does not itself create any new payment amount.
alter table public.monzo_payment_destinations
  drop constraint monzo_easy_bank_transfer_tier_urls_amount_allowed;
alter table public.monzo_payment_destinations
  add constraint monzo_payment_destinations_amount_range
  check (amount > 0 and amount <= 100000.00);

comment on table public.monzo_payment_destinations is
  'Closed artist-scoped reusable Monzo Easy Bank Transfer destinations keyed by (artist_id, amount, currency). Existing rows survive migration in place. No provider credential is stored here and one artist can never resolve another artist row.';
comment on column public.monzo_payment_destinations.amount is
  'Exact GBP amount this reusable destination is for. The payment request amount remains authoritative; adding a catalogue row does not create or reprice a request.';

-- ---------------------------------------------------------------------------
-- 2. Request-specific one-off destinations
-- ---------------------------------------------------------------------------

create table public.payment_request_payment_destinations (
  payment_request_id uuid primary key,
  artist_id          uuid not null references public.artists(id) on delete restrict,
  amount             numeric(12,2) not null,
  currency           text not null default 'GBP',
  payment_url        text not null,
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_by         uuid references public.profiles(id) on delete set null,
  updated_at         timestamptz not null default now(),

  constraint payment_request_payment_destinations_request_artist_fkey
    foreign key (payment_request_id, artist_id)
    references public.payment_requests(id, artist_id)
    on delete restrict,
  constraint payment_request_payment_destinations_unique_url
    unique (payment_url),
  constraint payment_request_payment_destinations_amount_range
    check (amount > 0 and amount <= 100000.00),
  constraint payment_request_payment_destinations_currency_gbp
    check (currency = 'GBP'),
  constraint payment_request_payment_destinations_url_shape
    check (payment_url ~ '^https://monzo[.]com/pay/r/[A-Za-z0-9_-]{4,255}$')
);

alter table public.payment_request_payment_destinations enable row level security;
alter table public.payment_request_payment_destinations force row level security;
revoke all on public.payment_request_payment_destinations
  from public, anon, authenticated, service_role;

comment on table public.payment_request_payment_destinations is
  'One-off Monzo destination attached to exactly one payment request by an authorised finance user. It is never promoted into the reusable catalogue, never shared with another request or artist, and attaching it never settles payment.';

-- ---------------------------------------------------------------------------
-- 3. Artist-bound and amount-bound destination resolution
-- ---------------------------------------------------------------------------

create or replace function crm_private.resolve_monzo_payment_destination(
  p_artist_id uuid,
  p_payment_request_id uuid,
  p_provider_account_key text,
  p_amount numeric,
  p_currency text
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_url text;
begin
  -- The exact artist/provider route must still be enabled. There is no
  -- provider-wide or cross-artist fallback.
  if not exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = p_artist_id
      and i.integration_type = 'payments'
      and i.provider = 'monzo_easy_bank_transfer'
      and i.integration_key = p_provider_account_key
      and i.is_enabled
  ) then
    return null;
  end if;

  -- A request-specific one-off is considered first. The attach RPC only allows
  -- it when the same artist has no reusable destination for this amount.
  select d.payment_url into v_url
  from public.payment_request_payment_destinations d
  where d.payment_request_id = p_payment_request_id
    and d.artist_id = p_artist_id
    and d.amount = p_amount
    and d.currency = p_currency;

  if v_url is null then
    select d.payment_url into v_url
    from public.monzo_payment_destinations d
    where d.artist_id = p_artist_id
      and d.amount = p_amount
      and d.currency = p_currency;
  end if;

  -- Legacy compatibility only. Before the catalogue existed, GBP 250 lived in
  -- artist_integrations.configuration.payment_url. Keep that exact same
  -- artist-scoped fallback so Vladimir's existing GBP 250 destination remains
  -- valid even if its catalogue row is temporarily absent.
  if v_url is null and p_amount = 250.00 and p_currency = 'GBP' then
    select i.configuration ->> 'payment_url' into v_url
    from public.artist_integrations i
    where i.artist_id = p_artist_id
      and i.integration_type = 'payments'
      and i.provider = 'monzo_easy_bank_transfer'
      and i.integration_key = p_provider_account_key
      and i.is_enabled;
  end if;

  if v_url is null
     or v_url !~ '^https://monzo[.]com/pay/r/[A-Za-z0-9_-]{4,255}$' then
    return null;
  end if;

  return v_url;
end;
$$;

revoke all on function crm_private.resolve_monzo_payment_destination(uuid,uuid,text,numeric,text)
  from public, anon, authenticated, service_role;

comment on function crm_private.resolve_monzo_payment_destination(uuid,uuid,text,numeric,text) is
  'Artist-bound, request-bound and amount-bound Monzo destination lookup. Fails closed instead of borrowing another artist, another amount or a provider default.';

create or replace function public.resolve_monzo_deposit_redirect(
  p_public_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_link public.payment_request_links%rowtype;
  v_request public.payment_requests%rowtype;
  v_url text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'payment redirect resolution is backend-only'
      using errcode = '42501';
  end if;

  select * into v_link
  from public.payment_request_links l
  where l.public_id = p_public_id
    and l.revoked_at is null
  for update;
  if not found then
    raise exception 'payment link is unavailable' using errcode = '22023';
  end if;

  select * into v_request
  from public.payment_requests r
  where r.id = v_link.payment_request_id
    and r.artist_id = v_link.artist_id
    and r.provider = 'monzo_easy_bank_transfer'
    and r.status in ('pending', 'partially_paid')
    and (r.expires_at is null or r.expires_at > now());
  if not found then
    raise exception 'payment link is unavailable' using errcode = '22023';
  end if;

  if v_request.currency <> 'GBP' then
    raise exception 'payment link is unavailable' using errcode = '22023';
  end if;

  v_url := crm_private.resolve_monzo_payment_destination(
    v_link.artist_id,
    v_request.id,
    v_request.provider_account_key,
    v_request.amount,
    v_request.currency
  );

  if v_url is null then
    raise exception 'payment link is unavailable' using errcode = '22023';
  end if;

  update public.payment_request_links l
  set open_count = l.open_count + 1,
      last_opened_at = now()
  where l.id = v_link.id;

  return v_url;
end;
$$;

revoke all on function public.resolve_monzo_deposit_redirect(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_monzo_deposit_redirect(uuid)
  to service_role;

comment on function public.resolve_monzo_deposit_redirect(uuid) is
  'Backend-only artist/amount-bound redirect resolver. The immutable payment request selects a reusable or request-specific Monzo destination; opening the link never writes the payment ledger or changes payment status.';

-- ---------------------------------------------------------------------------
-- 4. Finance-authorised request-specific one-off destination
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
     or v_request.status not in ('pending', 'partially_paid')
     or v_request.session_id is null
     or v_request.policy_id is null
     or v_request.policy_version is null then
    raise exception 'a one-off Monzo destination applies only to an open server-priced session deposit request'
      using errcode = '22023';
  end if;

  -- The immutable payment request is the authoritative pricing snapshot. Its
  -- amount was guarded against the duration policy when the request was
  -- created. Do not reprice it here from today's appointment duration: a later
  -- reschedule must not silently invalidate an already-issued payment request.
  -- The browser supplies only the URL; it cannot supply artist, amount,
  -- currency, provider account or policy version.

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

  -- A one-off fills a gap; it never overrides a reusable destination.
  if exists (
    select 1
    from public.monzo_payment_destinations d
    where d.artist_id = v_request.artist_id
      and d.amount = v_request.amount
      and d.currency = v_request.currency
  ) or (
    v_request.amount = 250.00
    and exists (
      select 1
      from public.artist_integrations i
      where i.artist_id = v_request.artist_id
        and i.integration_type = 'payments'
        and i.provider = 'monzo_easy_bank_transfer'
        and i.integration_key = v_request.provider_account_key
        and i.is_enabled
        and (i.configuration ->> 'payment_url') is not null
    )
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
      and d.payment_request_id <> v_request.id
  ) then
    raise exception 'this Monzo URL is already attached to another payment request'
      using errcode = '22023';
  end if;

  select true into v_replaced
  from public.payment_request_payment_destinations d
  where d.payment_request_id = v_request.id;

  insert into public.payment_request_payment_destinations (
    payment_request_id, artist_id, amount, currency, payment_url,
    created_by, updated_by
  ) values (
    v_request.id, v_request.artist_id, v_request.amount, v_request.currency,
    p_payment_url, auth.uid(), auth.uid()
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
      'replaced', coalesce(v_replaced, false)
    )
  );

  return jsonb_build_object(
    'payment_request_id', v_request.id,
    'public_path', '/pay-by-bank-transfer/' || v_public_id::text,
    'amount', v_request.amount,
    'currency', v_request.currency,
    'replaced', coalesce(v_replaced, false),
    'confirmed', false
  );
end;
$$;

revoke all on function public.attach_monzo_one_off_payment_destination(uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.attach_monzo_one_off_payment_destination(uuid,text)
  to authenticated;

comment on function public.attach_monzo_one_off_payment_destination(uuid,text) is
  'Attaches one clean Monzo URL to one open server-priced session deposit when that artist has no reusable destination for the immutable request amount. The caller cannot supply amount or artist; attaching the URL never settles payment.';
