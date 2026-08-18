-- 0063_monzo_tier_specific_deposit_links.sql
--
-- Give each server-owned duration tier its own reusable Monzo Easy Bank
-- Transfer destination without expanding the browser/API RPC inventory.
--
-- The browser never selects the deposit amount. payment_requests.amount is
-- calculated from the appointment duration and is immutable after request
-- creation. The existing backend-only redirect resolver selects the provider
-- URL from that stored amount only.
--
-- Tier destinations are operational server-side configuration. They have no
-- direct API-role table grants and no new public configuration/read RPCs. The
-- existing artist_integrations.configuration.payment_url remains the GBP 250
-- compatibility destination.

create table public.monzo_easy_bank_transfer_tier_urls (
  artist_id    uuid not null references public.artists(id) on delete restrict,
  amount       numeric(12,2) not null,
  currency     text not null default 'GBP',
  payment_url  text not null,
  updated_by   uuid references public.profiles(id) on delete set null,
  updated_at   timestamptz not null default now(),

  constraint monzo_easy_bank_transfer_tier_urls_pkey
    primary key (artist_id, amount, currency),
  constraint monzo_easy_bank_transfer_tier_urls_distinct_url
    unique (artist_id, payment_url),
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
  'Closed artist-scoped reusable Monzo Easy Bank Transfer destinations keyed by immutable server-calculated GBP deposit amount. No provider credential is stored here.';

-- Resolve the provider destination from the immutable request amount, never
-- from browser input or a query parameter. This is the same public function
-- signature that the payment Worker already uses; its ACL remains service-role
-- only and no additional browser-callable function is introduced.
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

revoke all on function public.resolve_monzo_deposit_redirect(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_monzo_deposit_redirect(uuid)
  to service_role;

comment on function public.resolve_monzo_deposit_redirect(uuid) is
  'Backend-only amount-bound redirect resolver. The immutable payment request amount selects the reusable Monzo URL; opening a link never creates a payment transaction or changes payment status.';
