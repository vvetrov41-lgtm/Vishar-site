-- 0062_monzo_tier_specific_deposit_links.sql
--
-- Give each server-owned duration tier its own reusable Monzo Easy Bank
-- Transfer destination. The browser still never selects the deposit amount:
-- payment_requests.amount is calculated from the appointment duration and is
-- immutable after request creation. The redirect resolver chooses the provider
-- URL from that stored amount only.
--
-- The existing artist_integrations.configuration.payment_url remains the GBP
-- 250 compatibility destination. Lower tiers fail closed until all four tier
-- URLs are configured through the finance-authorised RPC below.

create table public.monzo_easy_bank_transfer_tier_urls (
  artist_id    uuid not null references public.artists(id) on delete restrict,
  amount       numeric(12,2) not null,
  currency     text not null default 'GBP',
  payment_url  text not null,
  updated_by   uuid references public.profiles(id) on delete set null,
  updated_at   timestamptz not null default now(),

  constraint monzo_easy_bank_transfer_tier_urls_pkey
    primary key (artist_id, amount, currency),
  constraint monzo_easy_bank_transfer_tier_urls_amount_allowed
    check (amount in (50.00, 100.00, 150.00, 250.00)),
  constraint monzo_easy_bank_transfer_tier_urls_currency_gbp
    check (currency = 'GBP'),
  constraint monzo_easy_bank_transfer_tier_urls_url_shape
    check (payment_url ~ '^https://monzo[.]com/pay/r/[A-Za-z0-9_-]{4,255}$')
);

alter table public.monzo_easy_bank_transfer_tier_urls enable row level security;
alter table public.monzo_easy_bank_transfer_tier_urls force row level security;
revoke all on public.monzo_easy_bank_transfer_tier_urls
  from public, anon, authenticated, service_role;

comment on table public.monzo_easy_bank_transfer_tier_urls is
  'Artist-scoped reusable Monzo Easy Bank Transfer destinations keyed by the immutable server-calculated GBP deposit amount. No provider credential is stored here.';

create or replace function public.configure_monzo_easy_bank_transfer_tier_urls(
  p_artist_id uuid,
  p_payment_url_50 text,
  p_payment_url_100 text,
  p_payment_url_150 text,
  p_payment_url_250 text,
  p_is_enabled boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_base jsonb;
  v_urls text[];
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_finance');
  perform crm_private.require_active_artist(p_artist_id);

  p_payment_url_50 := btrim(coalesce(p_payment_url_50, ''));
  p_payment_url_100 := btrim(coalesce(p_payment_url_100, ''));
  p_payment_url_150 := btrim(coalesce(p_payment_url_150, ''));
  p_payment_url_250 := btrim(coalesce(p_payment_url_250, ''));

  v_urls := array[
    p_payment_url_50,
    p_payment_url_100,
    p_payment_url_150,
    p_payment_url_250
  ];

  if exists (
    select 1
    from unnest(v_urls) as u(url)
    where u.url !~ '^https://monzo[.]com/pay/r/[A-Za-z0-9_-]{4,255}$'
  ) then
    raise exception 'every Monzo Easy Bank Transfer tier URL must be valid'
      using errcode = '22023';
  end if;

  if (select count(distinct u.url) from unnest(v_urls) as u(url)) <> 4 then
    raise exception 'each deposit tier must use a distinct Monzo Easy Bank Transfer URL'
      using errcode = '22023';
  end if;

  -- Preserve the established integration key, duration policy, enabled state
  -- and GBP 250 compatibility field through the canonical configuration RPC.
  v_base := public.configure_monzo_easy_bank_transfer(
    p_artist_id,
    p_payment_url_250,
    p_is_enabled
  );

  insert into public.monzo_easy_bank_transfer_tier_urls (
    artist_id, amount, currency, payment_url, updated_by, updated_at
  ) values
    (p_artist_id,  50.00, 'GBP', p_payment_url_50,  auth.uid(), now()),
    (p_artist_id, 100.00, 'GBP', p_payment_url_100, auth.uid(), now()),
    (p_artist_id, 150.00, 'GBP', p_payment_url_150, auth.uid(), now()),
    (p_artist_id, 250.00, 'GBP', p_payment_url_250, auth.uid(), now())
  on conflict (artist_id, amount, currency) do update
    set payment_url = excluded.payment_url,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

  return v_base || jsonb_build_object(
    'payment_urls', jsonb_build_object(
      '50', p_payment_url_50,
      '100', p_payment_url_100,
      '150', p_payment_url_150,
      '250', p_payment_url_250
    )
  );
end;
$$;

create or replace function public.get_monzo_easy_bank_transfer_tier_urls(
  p_artist_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_legacy_250 text;
  v_50 text;
  v_100 text;
  v_150 text;
  v_250 text;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_finance');

  select i.configuration ->> 'payment_url'
    into v_legacy_250
  from public.artist_integrations i
  where i.artist_id = p_artist_id
    and i.integration_type = 'payments'
    and i.provider = 'monzo_easy_bank_transfer'
  order by i.updated_at desc
  limit 1;

  select
    max(t.payment_url) filter (where t.amount = 50.00),
    max(t.payment_url) filter (where t.amount = 100.00),
    max(t.payment_url) filter (where t.amount = 150.00),
    max(t.payment_url) filter (where t.amount = 250.00)
  into v_50, v_100, v_150, v_250
  from public.monzo_easy_bank_transfer_tier_urls t
  where t.artist_id = p_artist_id
    and t.currency = 'GBP';

  return jsonb_build_object(
    '50', v_50,
    '100', v_100,
    '150', v_150,
    '250', coalesce(v_250, v_legacy_250)
  );
end;
$$;

-- Resolve the provider destination from the immutable request amount, never
-- from browser input or a query parameter. Only the existing backend Worker
-- role may call this function.
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

  if v_request.currency <> 'GBP'
     or v_request.amount not in (50.00, 100.00, 150.00, 250.00) then
    raise exception 'payment link is unavailable' using errcode = '22023';
  end if;

  select coalesce(
           t.payment_url,
           case when v_request.amount = 250.00
             then i.configuration ->> 'payment_url'
             else null
           end
         )
    into v_url
  from public.artist_integrations i
  left join public.monzo_easy_bank_transfer_tier_urls t
    on t.artist_id = i.artist_id
   and t.amount = v_request.amount
   and t.currency = v_request.currency
  where i.artist_id = v_link.artist_id
    and i.integration_type = 'payments'
    and i.provider = 'monzo_easy_bank_transfer'
    and i.integration_key = v_request.provider_account_key
    and i.is_enabled;

  if v_url is null
     or v_url !~ '^https://monzo[.]com/pay/r/[A-Za-z0-9_-]{4,255}$' then
    raise exception 'payment link is unavailable' using errcode = '22023';
  end if;

  update public.payment_request_links l
  set open_count = l.open_count + 1,
      last_opened_at = now()
  where l.id = v_link.id;

  return v_url;
end;
$$;

revoke all on function public.configure_monzo_easy_bank_transfer_tier_urls(uuid,text,text,text,text,boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.get_monzo_easy_bank_transfer_tier_urls(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.resolve_monzo_deposit_redirect(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.configure_monzo_easy_bank_transfer_tier_urls(uuid,text,text,text,text,boolean)
  to authenticated;
grant execute on function public.get_monzo_easy_bank_transfer_tier_urls(uuid)
  to authenticated;
grant execute on function public.resolve_monzo_deposit_redirect(uuid)
  to service_role;

comment on function public.configure_monzo_easy_bank_transfer_tier_urls(uuid,text,text,text,text,boolean) is
  'Finance-authorised configuration of four distinct reusable Monzo Easy Bank Transfer destinations for the server-owned GBP 50/100/150/250 duration tiers.';
comment on function public.get_monzo_easy_bank_transfer_tier_urls(uuid) is
  'Finance-authorised safe read of non-secret tier payment destinations. The GBP 250 legacy integration URL remains a compatibility fallback.';
comment on function public.resolve_monzo_deposit_redirect(uuid) is
  'Backend-only amount-bound redirect resolver. The immutable payment request amount selects the reusable Monzo URL; opening a link never creates a payment transaction or changes payment status.';
