-- 0042_monzo_easy_bank_transfer_deposits.sql
--
-- Fixed GBP 250 deposit requests backed by an artist-scoped Monzo Business
-- Easy Bank Transfer reusable payment link. This migration does not connect to
-- Monzo, register a live webhook, send email/SMS, or deploy a public route.
--
-- A payment-link open is navigation only. Only the existing immutable payment
-- ledger may prove that money moved. Future Monzo API ingestion records a
-- reconciliation candidate and never settles a request automatically.
--
-- Forward-only.

-- ---------------------------------------------------------------------------
-- Opaque per-request public redirect identifiers
-- ---------------------------------------------------------------------------

create table public.payment_request_links (
  id                 uuid primary key default gen_random_uuid(),
  payment_request_id uuid not null,
  artist_id          uuid not null references public.artists(id) on delete restrict,
  public_id          uuid not null default gen_random_uuid(),
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  last_opened_at     timestamptz,
  open_count         integer not null default 0,
  revoked_at         timestamptz,

  constraint payment_request_links_request_key unique (payment_request_id),
  constraint payment_request_links_public_key unique (public_id),
  constraint payment_request_links_open_count_non_negative check (open_count >= 0),
  constraint payment_request_links_request_artist_fkey
    foreign key (payment_request_id, artist_id)
    references public.payment_requests(id, artist_id)
    on delete restrict
);

alter table public.payment_request_links enable row level security;
alter table public.payment_request_links force row level security;
revoke all on public.payment_request_links from public, anon, authenticated, service_role;

comment on table public.payment_request_links is
  'Opaque public redirect identifiers for payment requests. A link open never proves payment and never changes the payment ledger.';
comment on column public.payment_request_links.public_id is
  'Unprivileged opaque redirect id. It identifies no artist/client in the URL and grants only a redirect to the configured reusable payment destination.';

-- ---------------------------------------------------------------------------
-- Future Monzo API reconciliation candidates
-- ---------------------------------------------------------------------------

create table public.payment_reconciliation_candidates (
  id                           uuid primary key default gen_random_uuid(),
  artist_id                    uuid not null references public.artists(id) on delete restrict,
  provider                     text not null,
  provider_account_key         text not null,
  provider_event_id            text not null,
  provider_transaction_id      text not null,
  amount                       numeric(12,2) not null,
  currency                     text not null,
  occurred_at                  timestamptz not null,
  status                       text not null,
  suggested_payment_request_id uuid,
  matched_payment_request_id   uuid,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),

  constraint payment_reconciliation_candidates_transaction_key
    unique (provider, provider_account_key, provider_transaction_id),
  constraint payment_reconciliation_candidates_provider_shape
    check (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  constraint payment_reconciliation_candidates_account_shape
    check (provider_account_key ~ '^[a-z][a-z0-9_-]{2,79}$'),
  constraint payment_reconciliation_candidates_event_length
    check (btrim(provider_event_id) <> '' and char_length(provider_event_id) <= 255),
  constraint payment_reconciliation_candidates_transaction_length
    check (btrim(provider_transaction_id) <> '' and char_length(provider_transaction_id) <= 255),
  constraint payment_reconciliation_candidates_positive_amount check (amount > 0),
  constraint payment_reconciliation_candidates_currency_iso check (currency ~ '^[A-Z]{3}$'),
  constraint payment_reconciliation_candidates_status_allowed
    check (status in ('unmatched', 'candidate', 'ambiguous', 'matched', 'ignored')),
  constraint payment_reconciliation_candidates_suggestion_state check (
    (status = 'candidate' and suggested_payment_request_id is not null and matched_payment_request_id is null)
    or (status = 'matched' and matched_payment_request_id is not null)
    or (status in ('unmatched', 'ambiguous', 'ignored') and matched_payment_request_id is null)
  ),
  constraint payment_reconciliation_candidates_suggested_artist_fkey
    foreign key (suggested_payment_request_id, artist_id)
    references public.payment_requests(id, artist_id)
    on delete restrict,
  constraint payment_reconciliation_candidates_matched_artist_fkey
    foreign key (matched_payment_request_id, artist_id)
    references public.payment_requests(id, artist_id)
    on delete restrict
);

create index payment_reconciliation_candidates_artist_status_idx
  on public.payment_reconciliation_candidates (artist_id, status, occurred_at desc);

alter table public.payment_reconciliation_candidates enable row level security;
alter table public.payment_reconciliation_candidates force row level security;
revoke all on public.payment_reconciliation_candidates from public, anon, authenticated, service_role;

comment on table public.payment_reconciliation_candidates is
  'Safe metadata from independently verified provider transactions. Candidate rows never create a payment transaction or settle a request by themselves.';

-- ---------------------------------------------------------------------------
-- Artist-scoped fixed-deposit configuration
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
  v_result jsonb;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_finance');
  perform crm_private.require_active_artist(p_artist_id);

  p_payment_url := btrim(coalesce(p_payment_url, ''));
  if p_payment_url !~ '^https://monzo[.]com/pay/r/[A-Za-z0-9_-]{4,256}$' then
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

  v_result := public.configure_artist_integration(
    p_artist_id,
    'payments',
    'monzo_easy_bank_transfer',
    v_integration_key,
    'Monzo Business Easy Bank Transfer',
    jsonb_build_object(
      'payment_url', p_payment_url,
      'deposit_amount', 250,
      'currency', 'GBP',
      'default_delivery_channel', 'email',
      'email_status', 'provider_not_connected',
      'sms_status', 'not_configured',
      'monzo_api_status', 'not_connected'
    ),
    p_is_enabled
  );

  select * into v_policy
  from public.artist_payment_policies p
  where p.artist_id = p_artist_id
    and p.is_active
    and p.effective_from <= now()
    and (p.effective_until is null or p.effective_until > now())
  order by p.version desc
  limit 1;

  if not found
     or v_policy.deposit_mode <> 'fixed'
     or v_policy.fixed_amount <> 250.00
     or not v_policy.transfer_allowed then
    select coalesce(max(p.version), 0) + 1 into v_next_version
    from public.artist_payment_policies p
    where p.artist_id = p_artist_id;

    perform public.create_artist_payment_policy(
      p_artist_id,
      v_next_version,
      'fixed',
      250.00,
      null,
      72,
      true,
      'monzo-ebt-v1',
      now()
    );
  end if;

  return v_result || jsonb_build_object(
    'deposit_amount', 250,
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
      'currency', 'GBP',
      'default_delivery_channel', 'email',
      'email_status', 'provider_not_connected',
      'sms_status', 'not_configured',
      'monzo_api_status', 'not_connected'
    );
  end if;

  return jsonb_build_object(
    'configured', true,
    'enabled', v_integration.is_enabled,
    'payment_url', v_integration.configuration ->> 'payment_url',
    'deposit_amount', 250,
    'currency', 'GBP',
    'default_delivery_channel', 'email',
    'email_status', 'provider_not_connected',
    'sms_status', 'not_configured',
    'monzo_api_status', 'not_connected'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- One-action session deposit request
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
  v_policy public.artist_payment_policies%rowtype;
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
  where s.id = p_session_id;
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

  select * into v_policy
  from public.artist_payment_policies p
  where p.artist_id = v_session.artist_id
    and p.is_active
    and p.effective_from <= now()
    and (p.effective_until is null or p.effective_until > now())
  order by p.version desc
  limit 1;

  if not found
     or v_policy.deposit_mode <> 'fixed'
     or v_policy.fixed_amount <> 250.00
     or not v_policy.transfer_allowed then
    raise exception 'the active deposit policy must be a GBP 250 transfer deposit'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('session-deposit:' || p_session_id::text, 0));

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
       or v_existing.amount <> 250.00
       or v_existing.currency <> 'GBP' then
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
      250.00,
      v_session.project_id,
      v_session.id,
      'GBP',
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
    'amount', 250,
    'currency', 'GBP',
    'delivery_channel', p_delivery_channel,
    'delivery_status', case
      when p_delivery_channel = 'email' then 'queued_provider_not_connected'
      else 'link_created'
    end,
    'replayed', v_replayed
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Backend-only redirect resolution
-- ---------------------------------------------------------------------------

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

  select i.configuration ->> 'payment_url' into v_url
  from public.artist_integrations i
  where i.artist_id = v_link.artist_id
    and i.integration_type = 'payments'
    and i.provider = 'monzo_easy_bank_transfer'
    and i.integration_key = v_request.provider_account_key
    and i.is_enabled;

  if v_url is null
     or v_url !~ '^https://monzo[.]com/pay/r/[A-Za-z0-9_-]{4,256}$' then
    raise exception 'payment link is unavailable' using errcode = '22023';
  end if;

  update public.payment_request_links l
  set open_count = l.open_count + 1,
      last_opened_at = now()
  where l.id = v_link.id;

  return v_url;
end;
$$;

-- ---------------------------------------------------------------------------
-- Backend-only verified Monzo transaction candidate registration
-- ---------------------------------------------------------------------------

create or replace function public.register_monzo_reconciliation_candidate(
  p_provider_account_key text,
  p_provider_event_id text,
  p_provider_transaction_id text,
  p_amount numeric,
  p_currency text,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_existing public.payment_reconciliation_candidates%rowtype;
  v_candidate_count integer;
  v_suggested_request_id uuid;
  v_status text;
  v_candidate_id uuid;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Monzo reconciliation registration is backend-only'
      using errcode = '42501';
  end if;

  p_provider_account_key := btrim(coalesce(p_provider_account_key, ''));
  p_provider_event_id := btrim(coalesce(p_provider_event_id, ''));
  p_provider_transaction_id := btrim(coalesce(p_provider_transaction_id, ''));
  p_currency := upper(btrim(coalesce(p_currency, '')));

  if p_provider_account_key !~ '^[a-z][a-z0-9_-]{2,79}$'
     or p_provider_event_id = '' or char_length(p_provider_event_id) > 255
     or p_provider_transaction_id = '' or char_length(p_provider_transaction_id) > 255
     or p_amount is null or p_amount <= 0
     or p_currency <> 'GBP'
     or p_occurred_at is null then
    raise exception 'Monzo reconciliation metadata is invalid'
      using errcode = '22023';
  end if;

  v_artist_id := crm_private.resolve_payment_route_owner(
    'monzo_easy_bank_transfer', p_provider_account_key
  );

  perform pg_advisory_xact_lock(hashtextextended(
    'monzo-transaction:' || p_provider_account_key || ':' || p_provider_transaction_id, 0
  ));

  select * into v_existing
  from public.payment_reconciliation_candidates c
  where c.provider = 'monzo_easy_bank_transfer'
    and c.provider_account_key = p_provider_account_key
    and c.provider_transaction_id = p_provider_transaction_id;

  if found then
    if v_existing.artist_id <> v_artist_id
       or v_existing.provider_event_id <> p_provider_event_id
       or v_existing.amount <> p_amount
       or v_existing.currency <> p_currency
       or v_existing.occurred_at <> p_occurred_at then
      raise exception 'Monzo transaction id was reused with different metadata'
        using errcode = '22023';
    end if;

    return jsonb_build_object(
      'candidate_id', v_existing.id,
      'artist_id', v_existing.artist_id,
      'status', v_existing.status,
      'replayed', true
    );
  end if;

  select count(*)::integer,
         min(r.id) filter (where true)
    into v_candidate_count, v_suggested_request_id
  from public.payment_requests r
  where r.artist_id = v_artist_id
    and r.provider = 'monzo_easy_bank_transfer'
    and r.provider_account_key = p_provider_account_key
    and r.purpose = 'deposit'
    and r.status in ('pending', 'partially_paid')
    and r.amount = p_amount
    and r.currency = p_currency
    and (r.expires_at is null or r.expires_at > p_occurred_at);

  v_status := case
    when v_candidate_count = 0 then 'unmatched'
    when v_candidate_count = 1 then 'candidate'
    else 'ambiguous'
  end;
  if v_candidate_count <> 1 then
    v_suggested_request_id := null;
  end if;

  insert into public.payment_webhook_events (
    artist_id, provider, provider_account_key, provider_event_id,
    processing_status, processed_at
  ) values (
    v_artist_id, 'monzo_easy_bank_transfer', p_provider_account_key,
    p_provider_event_id, 'succeeded', now()
  )
  on conflict (provider, provider_event_id) do nothing;

  insert into public.payment_reconciliation_candidates (
    artist_id, provider, provider_account_key,
    provider_event_id, provider_transaction_id,
    amount, currency, occurred_at, status,
    suggested_payment_request_id
  ) values (
    v_artist_id, 'monzo_easy_bank_transfer', p_provider_account_key,
    p_provider_event_id, p_provider_transaction_id,
    p_amount, p_currency, p_occurred_at, v_status,
    v_suggested_request_id
  )
  returning id into v_candidate_id;

  return jsonb_build_object(
    'candidate_id', v_candidate_id,
    'artist_id', v_artist_id,
    'status', v_status,
    'replayed', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Closed RPC surface
-- ---------------------------------------------------------------------------

revoke all on function public.configure_monzo_easy_bank_transfer(uuid,text,boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.get_monzo_easy_bank_transfer_settings(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.request_session_deposit(uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.resolve_monzo_deposit_redirect(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.register_monzo_reconciliation_candidate(text,text,text,numeric,text,timestamptz)
  from public, anon, authenticated, service_role;

grant execute on function public.configure_monzo_easy_bank_transfer(uuid,text,boolean)
  to authenticated;
grant execute on function public.get_monzo_easy_bank_transfer_settings(uuid)
  to authenticated;
grant execute on function public.request_session_deposit(uuid,uuid,text)
  to authenticated;
grant execute on function public.resolve_monzo_deposit_redirect(uuid)
  to service_role;
grant execute on function public.register_monzo_reconciliation_candidate(text,text,text,numeric,text,timestamptz)
  to service_role;

comment on function public.configure_monzo_easy_bank_transfer(uuid,text,boolean) is
  'Finance-authorised setup for one artist reusable Monzo Easy Bank Transfer URL and fixed GBP 250 deposit policy. Stores no Monzo API credential.';
comment on function public.request_session_deposit(uuid,uuid,text) is
  'Creates or reuses one pending GBP 250 Monzo deposit request for a tattoo appointment and creates an opaque public redirect. Email is queued but cannot send until a provider is connected; SMS is deliberately unavailable.';
comment on function public.resolve_monzo_deposit_redirect(uuid) is
  'Backend-only redirect resolver. Opening a link never changes payment status or creates a transaction.';
comment on function public.register_monzo_reconciliation_candidate(text,text,text,numeric,text,timestamptz) is
  'Backend-only registration of metadata from a transaction independently verified through the future Monzo API adapter. Never settles a payment request automatically.';
