-- 0067_monzo_destination_catalogue_management.sql
--
-- Make the reusable Monzo destination catalogue an artist-managed CRM surface
-- and make every payment request keep the destination it was issued with.
--
-- Two product changes:
--
--  1. The reusable catalogue gains a surrogate key, archival semantics and a
--     narrow finance-authorised management RPC surface. Any positive supported
--     GBP amount is an ordinary catalogue row; GBP 50/100/150/250 stop being
--     structurally special. No management RPC ever returns a provider URL to
--     the browser.
--
--  2. public.payment_request_payment_destinations becomes the single
--     request-bound destination snapshot for every Monzo deposit request,
--     rather than a one-off gap filler. The snapshot copies the destination at
--     issue time, so replacing or archiving a reusable catalogue entry can only
--     affect requests issued afterwards.
--
-- Opening a link remains navigation only. Creating, replacing or archiving a
-- catalogue entry writes no payment transaction and changes no payment status.
-- This migration provisions no destination and prints no provider URL.

-- ---------------------------------------------------------------------------
-- 1. Reusable catalogue: surrogate identity, archival, audit columns
-- ---------------------------------------------------------------------------

alter table public.monzo_payment_destinations
  add column if not exists id uuid not null default gen_random_uuid(),
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references public.profiles(id) on delete set null,
  add column if not exists created_by uuid references public.profiles(id) on delete set null,
  add column if not exists created_at timestamptz not null default now();

-- Existing operator-owned rows keep their payment_url byte-for-byte. Only the
-- key shape around them changes.
alter table public.monzo_payment_destinations
  drop constraint monzo_payment_destinations_pkey;
alter table public.monzo_payment_destinations
  add constraint monzo_payment_destinations_pkey primary key (id);
alter table public.monzo_payment_destinations
  add constraint monzo_payment_destinations_id_artist_key unique (id, artist_id);

-- One live destination per artist/amount/currency. Superseded rows are kept as
-- financial history instead of being deleted.
create unique index monzo_payment_destinations_live_amount_idx
  on public.monzo_payment_destinations (artist_id, amount, currency)
  where archived_at is null;

create index monzo_payment_destinations_artist_idx
  on public.monzo_payment_destinations (artist_id, amount);

-- A provider URL belongs to exactly one artist and exactly one catalogue row,
-- live or archived. The previous constraint was only unique per artist.
alter table public.monzo_payment_destinations
  drop constraint monzo_payment_destinations_distinct_url;
alter table public.monzo_payment_destinations
  add constraint monzo_payment_destinations_unique_url unique (payment_url);

comment on table public.monzo_payment_destinations is
  'Artist-scoped reusable Monzo Easy Bank Transfer destinations keyed by (artist_id, amount, currency) while live. Any positive supported GBP amount is an ordinary row. Superseded rows are archived, never deleted, and one artist can never read or mutate another artist row.';
comment on column public.monzo_payment_destinations.archived_at is
  'Set when the entry is withdrawn from future resolution. Payment requests already issued against it keep their own immutable destination snapshot.';

-- The catalogue is never deleted from: an archived row may still be the bound
-- destination of an issued payment request, and financial history is retained.
create or replace function crm_private.block_monzo_payment_destination_delete()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  raise exception 'reusable payment destinations are archived, never deleted'
    using errcode = '42501';
end;
$$;

revoke all on function crm_private.block_monzo_payment_destination_delete()
  from public, anon, authenticated, service_role;

drop trigger if exists monzo_payment_destinations_block_delete
  on public.monzo_payment_destinations;
create trigger monzo_payment_destinations_block_delete
  before delete on public.monzo_payment_destinations
  for each row execute function crm_private.block_monzo_payment_destination_delete();

-- ---------------------------------------------------------------------------
-- 2. Request-bound destination snapshot
-- ---------------------------------------------------------------------------

alter table public.payment_request_payment_destinations
  add column if not exists source text not null default 'one_off',
  add column if not exists catalogue_destination_id uuid,
  add column if not exists bound_at timestamptz not null default now();

alter table public.payment_request_payment_destinations
  add constraint payment_request_payment_destinations_source_values
    check (source in ('reusable', 'one_off', 'legacy_integration')),
  add constraint payment_request_payment_destinations_catalogue_link
    check (
      (source = 'reusable' and catalogue_destination_id is not null)
      or (source <> 'reusable' and catalogue_destination_id is null)
    ),
  add constraint payment_request_payment_destinations_catalogue_artist_fkey
    foreign key (catalogue_destination_id, artist_id)
    references public.monzo_payment_destinations(id, artist_id)
    on delete restrict;

create index payment_request_payment_destinations_catalogue_idx
  on public.payment_request_payment_destinations (catalogue_destination_id)
  where catalogue_destination_id is not null;

comment on table public.payment_request_payment_destinations is
  'Immutable destination snapshot bound to exactly one payment request. It copies the artist, the authoritative request amount, the currency and the provider URL in force when the request was issued. Later catalogue edits and archival never rewrite an issued snapshot, and binding a destination never settles payment.';
comment on column public.payment_request_payment_destinations.source is
  'reusable = copied from the artist catalogue at issue time; one_off = request-specific URL attached by an authorised finance user; legacy_integration = copied from the pre-catalogue artist_integrations destination.';
comment on column public.payment_request_payment_destinations.catalogue_destination_id is
  'Audit link to the catalogue row the snapshot was copied from. The snapshot keeps serving its own payment_url even after that row is replaced or archived.';

create or replace function crm_private.guard_payment_request_destination()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_request public.payment_requests%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'an issued payment destination snapshot is retained evidence'
      using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    if new.payment_request_id is distinct from old.payment_request_id
       or new.artist_id is distinct from old.artist_id
       or new.amount is distinct from old.amount
       or new.currency is distinct from old.currency
       or new.catalogue_destination_id is distinct from old.catalogue_destination_id
       or new.created_at is distinct from old.created_at then
      raise exception 'a bound payment destination snapshot is immutable'
        using errcode = '23514';
    end if;

    -- A catalogue-derived snapshot can never be rewritten in place: that is
    -- exactly the reroute this migration exists to prevent. Only an explicit
    -- authorised re-attach of a request-specific one-off may replace a URL.
    if new.payment_url is distinct from old.payment_url
       and not (old.source = 'one_off' and new.source = 'one_off') then
      raise exception 'only a request-specific one-off destination may be replaced'
        using errcode = '23514';
    end if;

    if new.source is distinct from old.source then
      raise exception 'a bound payment destination snapshot keeps its source'
        using errcode = '23514';
    end if;

    return new;
  end if;

  select * into v_request
  from public.payment_requests r
  where r.id = new.payment_request_id;
  if not found then
    raise exception 'payment request % does not exist', new.payment_request_id
      using errcode = '23503';
  end if;

  -- The payment request is the authoritative financial record. A snapshot may
  -- only ever copy it, never restate it with different terms.
  if new.artist_id is distinct from v_request.artist_id
     or new.amount is distinct from v_request.amount
     or new.currency is distinct from v_request.currency then
    raise exception 'a payment destination snapshot must copy the immutable request terms'
      using errcode = '23514';
  end if;

  if v_request.provider is distinct from 'monzo_easy_bank_transfer'
     or v_request.purpose <> 'deposit' then
    raise exception 'payment destinations bind only to Monzo deposit requests'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

revoke all on function crm_private.guard_payment_request_destination()
  from public, anon, authenticated, service_role;

drop trigger if exists payment_request_payment_destinations_guard
  on public.payment_request_payment_destinations;
create trigger payment_request_payment_destinations_guard
  before insert or update or delete on public.payment_request_payment_destinations
  for each row execute function crm_private.guard_payment_request_destination();

-- ---------------------------------------------------------------------------
-- 3. Bind a destination at issue time
-- ---------------------------------------------------------------------------

-- Called by the deposit workflows immediately after a request exists. It copies
-- whichever destination is in force for that artist and that authoritative
-- amount right now. It never chooses or changes an amount, never creates a
-- catalogue row, and never writes the payment ledger.
create or replace function crm_private.bind_payment_request_destination(
  p_payment_request_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_request public.payment_requests%rowtype;
  v_destination public.monzo_payment_destinations%rowtype;
  v_legacy_url text;
begin
  select * into v_request
  from public.payment_requests r
  where r.id = p_payment_request_id;
  if not found then
    raise exception 'payment request % does not exist', p_payment_request_id
      using errcode = '23503';
  end if;

  if v_request.provider is distinct from 'monzo_easy_bank_transfer'
     or v_request.purpose <> 'deposit' then
    return null;
  end if;

  -- Already bound: the issued snapshot wins, always.
  if exists (
    select 1 from public.payment_request_payment_destinations d
    where d.payment_request_id = v_request.id
  ) then
    return (
      select d.source from public.payment_request_payment_destinations d
      where d.payment_request_id = v_request.id
    );
  end if;

  -- The exact artist/provider route must still be enabled. There is no
  -- provider-wide or cross-artist fallback.
  if not exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = v_request.artist_id
      and i.integration_type = 'payments'
      and i.provider = 'monzo_easy_bank_transfer'
      and i.integration_key = v_request.provider_account_key
      and i.is_enabled
  ) then
    return null;
  end if;

  select * into v_destination
  from public.monzo_payment_destinations d
  where d.artist_id = v_request.artist_id
    and d.amount = v_request.amount
    and d.currency = v_request.currency
    and d.archived_at is null;

  if found then
    insert into public.payment_request_payment_destinations (
      payment_request_id, artist_id, amount, currency, payment_url,
      source, catalogue_destination_id, created_by, updated_by
    ) values (
      v_request.id, v_request.artist_id, v_request.amount, v_request.currency,
      v_destination.payment_url, 'reusable', v_destination.id,
      auth.uid(), auth.uid()
    );
    return 'reusable';
  end if;

  -- Pre-catalogue compatibility only. Before the catalogue existed, GBP 250
  -- lived in artist_integrations.configuration.payment_url. That artist-scoped
  -- destination is snapshotted here rather than resolved again on every open.
  if v_request.amount = 250.00 and v_request.currency = 'GBP' then
    select i.configuration ->> 'payment_url' into v_legacy_url
    from public.artist_integrations i
    where i.artist_id = v_request.artist_id
      and i.integration_type = 'payments'
      and i.provider = 'monzo_easy_bank_transfer'
      and i.integration_key = v_request.provider_account_key
      and i.is_enabled;

    if v_legacy_url is not null
       and v_legacy_url ~ '^https://monzo[.]com/pay/r/[A-Za-z0-9_-]{4,255}$' then
      insert into public.payment_request_payment_destinations (
        payment_request_id, artist_id, amount, currency, payment_url,
        source, created_by, updated_by
      ) values (
        v_request.id, v_request.artist_id, v_request.amount, v_request.currency,
        v_legacy_url, 'legacy_integration', auth.uid(), auth.uid()
      );
      return 'legacy_integration';
    end if;
  end if;

  -- No destination exists for this authoritative amount. The request stays
  -- open and fails closed publicly until a one-off is attached or a reusable
  -- entry is created and the request is reissued.
  return null;
end;
$$;

revoke all on function crm_private.bind_payment_request_destination(uuid)
  from public, anon, authenticated, service_role;

comment on function crm_private.bind_payment_request_destination(uuid) is
  'Copies the destination in force for one artist and one immutable request amount into a request-bound snapshot. Never selects an amount, never creates a catalogue row and never settles payment.';

-- ---------------------------------------------------------------------------
-- 4. Public resolution reads the snapshot only
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

  -- Only the destination this request was issued with is served. The live
  -- catalogue is deliberately not consulted here, so replacing or archiving a
  -- reusable entry can never reroute or break an already issued request.
  select d.payment_url into v_url
  from public.payment_request_payment_destinations d
  where d.payment_request_id = p_payment_request_id
    and d.artist_id = p_artist_id
    and d.amount = p_amount
    and d.currency = p_currency;

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
  'Artist-bound, request-bound and amount-bound lookup of the immutable destination snapshot. Fails closed instead of borrowing another artist, another amount, a provider default or a newer catalogue entry.';

-- ---------------------------------------------------------------------------
-- 5. Backfill snapshots for every already issued open Monzo deposit
-- ---------------------------------------------------------------------------

-- Requests issued before this migration resolved the live catalogue on every
-- open. Freeze what each of them resolves to today so that catalogue
-- management cannot retroactively change an issued request. Byte-for-byte
-- copies only: no URL is created, rotated or printed.
insert into public.payment_request_payment_destinations (
  payment_request_id, artist_id, amount, currency, payment_url,
  source, catalogue_destination_id
)
select r.id, r.artist_id, r.amount, r.currency, d.payment_url,
       'reusable', d.id
from public.payment_requests r
join public.artist_integrations i
  on i.artist_id = r.artist_id
 and i.integration_type = 'payments'
 and i.provider = 'monzo_easy_bank_transfer'
 and i.integration_key = r.provider_account_key
 and i.is_enabled
join public.monzo_payment_destinations d
  on d.artist_id = r.artist_id
 and d.amount = r.amount
 and d.currency = r.currency
 and d.archived_at is null
where r.provider = 'monzo_easy_bank_transfer'
  and r.purpose = 'deposit'
  and r.status in ('pending', 'partially_paid')
  and not exists (
    select 1 from public.payment_request_payment_destinations e
    where e.payment_request_id = r.id
  );

insert into public.payment_request_payment_destinations (
  payment_request_id, artist_id, amount, currency, payment_url, source
)
select r.id, r.artist_id, r.amount, r.currency,
       i.configuration ->> 'payment_url', 'legacy_integration'
from public.payment_requests r
join public.artist_integrations i
  on i.artist_id = r.artist_id
 and i.integration_type = 'payments'
 and i.provider = 'monzo_easy_bank_transfer'
 and i.integration_key = r.provider_account_key
 and i.is_enabled
where r.provider = 'monzo_easy_bank_transfer'
  and r.purpose = 'deposit'
  and r.status in ('pending', 'partially_paid')
  and r.amount = 250.00
  and r.currency = 'GBP'
  and (i.configuration ->> 'payment_url')
        ~ '^https://monzo[.]com/pay/r/[A-Za-z0-9_-]{4,255}$'
  and not exists (
    select 1 from public.payment_request_payment_destinations e
    where e.payment_request_id = r.id
  );

-- ---------------------------------------------------------------------------
-- 6. Bind the snapshot from the existing deposit workflows
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
  v_destination_source text;
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

  if exists (
    select 1 from public.session_deposit_group_members m
    where m.session_id = p_session_id
      and m.released_at is null
  ) then
    raise exception 'the appointment is already covered by a grouped deposit'
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

  -- Freeze the destination this request is issued with. A replay keeps the
  -- snapshot it already has.
  v_destination_source := crm_private.bind_payment_request_destination(v_request_id);

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
    'destination_source', v_destination_source,
    'destination_ready', v_destination_source is not null,
    'delivery_channel', p_delivery_channel,
    'delivery_status', case
      when p_delivery_channel = 'email' then 'queued_provider_not_connected'
      else 'link_created'
    end,
    'replayed', v_replayed
  );
end;
$$;

create or replace function public.request_grouped_session_deposit(
  p_session_ids uuid[],
  p_idempotency_key uuid,
  p_delivery_channel text default 'copy_link'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_ids uuid[];
  v_session_id uuid;
  v_session public.sessions%rowtype;
  v_first public.sessions%rowtype;
  v_route record;
  v_tier record;
  v_policy_id uuid;
  v_policy_version integer;
  v_currency text;
  v_total numeric(12,2) := 0;
  v_group public.session_deposit_groups%rowtype;
  v_existing_ids uuid[];
  v_request_result jsonb;
  v_request_id uuid;
  v_group_id uuid;
  v_link public.payment_request_links%rowtype;
  v_breakdown jsonb := '[]'::jsonb;
  v_destination_source text;
begin
  if p_idempotency_key is null then
    raise exception 'idempotency key is required' using errcode = '22023';
  end if;

  p_delivery_channel := lower(btrim(coalesce(p_delivery_channel, '')));
  if p_delivery_channel not in ('email', 'copy_link') then
    raise exception 'deposit delivery channel is invalid' using errcode = '22023';
  end if;

  select array_agg(distinct id order by id) into v_ids
  from unnest(coalesce(p_session_ids, array[]::uuid[])) as id
  where id is not null;

  if v_ids is null or array_length(v_ids, 1) < 2 or array_length(v_ids, 1) > 12 then
    raise exception 'a grouped deposit must cover between 2 and 12 distinct appointments'
      using errcode = '22023';
  end if;

  -- Replay the exact normalized appointment set before creating any new row.
  select * into v_group
  from public.session_deposit_groups g
  where g.idempotency_key = p_idempotency_key;

  if found then
    perform crm_private.require_artist_access(v_group.artist_id, 'manage_finance');

    select array_agg(m.session_id order by m.session_id) into v_existing_ids
    from public.session_deposit_group_members m
    where m.group_id = v_group.id;

    if v_existing_ids is distinct from v_ids then
      raise exception 'grouped deposit idempotency key was reused with different appointments'
        using errcode = '22023';
    end if;

    select * into v_link
    from public.payment_request_links l
    where l.payment_request_id = v_group.payment_request_id;

    select d.source into v_destination_source
    from public.payment_request_payment_destinations d
    where d.payment_request_id = v_group.payment_request_id;

    return jsonb_build_object(
      'deposit_group_id', v_group.id,
      'payment_request_id', v_group.payment_request_id,
      'payment_link_id', v_link.id,
      'public_path', '/pay-by-bank-transfer/' || v_link.public_id::text,
      'amount', v_group.total_amount,
      'currency', v_group.currency,
      'session_count', v_group.session_count,
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

  -- UUID ordering above gives every concurrent group attempt a stable lock
  -- order, avoiding two overlapping groups locking sessions in reverse order.
  foreach v_session_id in array v_ids loop
    select * into v_session
    from public.sessions s
    where s.id = v_session_id
    for update;
    if not found then
      raise exception 'appointment does not exist' using errcode = '23503';
    end if;

    if v_first.id is null then
      v_first := v_session;
      perform crm_private.require_artist_access(v_first.artist_id, 'manage_finance');
      perform crm_private.require_active_artist(v_first.artist_id);
    end if;

    if v_session.artist_id <> v_first.artist_id
       or v_session.client_id <> v_first.client_id
       or v_session.project_id is distinct from v_first.project_id then
      raise exception 'a grouped deposit must cover one artist, one client and one project'
        using errcode = '22023';
    end if;

    if v_session.appointment_type <> 'tattoo_session' or v_session.project_id is null then
      raise exception 'grouped deposits are available only for project-backed tattoo sessions'
        using errcode = '22023';
    end if;
    if v_session.status in ('completed', 'cancelled', 'no_show') then
      raise exception 'a grouped deposit cannot include a finished appointment'
        using errcode = '22023';
    end if;

    if exists (
      select 1 from public.payment_requests r
      where r.session_id = v_session.id
        and r.purpose = 'deposit'
        and r.status in ('pending', 'partially_paid', 'paid')
    ) then
      raise exception 'an appointment already has its own deposit request'
        using errcode = '22023';
    end if;

    if exists (
      select 1 from public.session_deposit_group_members m
      where m.session_id = v_session.id
        and m.released_at is null
    ) then
      raise exception 'an appointment is already covered by another grouped deposit'
        using errcode = '22023';
    end if;

    select * into v_tier
    from crm_private.resolve_session_deposit_tier(v_session.artist_id, v_session.id);

    if v_policy_id is null then
      v_policy_id := v_tier.policy_id;
      v_policy_version := v_tier.policy_version;
      v_currency := v_tier.currency;
    elsif v_policy_id <> v_tier.policy_id
          or v_policy_version <> v_tier.policy_version
          or v_currency <> v_tier.currency then
      raise exception 'grouped appointments must share one active deposit policy version'
        using errcode = '22023';
    end if;

    v_total := v_total + v_tier.amount;
    v_breakdown := v_breakdown || jsonb_build_object(
      'session_id', v_session.id,
      'amount', v_tier.amount,
      'currency', v_tier.currency,
      'duration_minutes', v_tier.duration_minutes,
      'tier_max_minutes', v_tier.max_minutes
    );
  end loop;

  select * into v_route
  from crm_private.resolve_enabled_payment_route(v_first.artist_id);
  if v_route.provider <> 'monzo_easy_bank_transfer' then
    raise exception 'Monzo Easy Bank Transfer is not the enabled payment destination'
      using errcode = '22023';
  end if;

  -- create_payment_request independently binds the same artist's enabled route
  -- and active policy, and rejects an idempotency replay with different terms.
  v_request_result := public.create_payment_request(
    p_idempotency_key,
    v_first.artist_id,
    v_first.client_id,
    'deposit',
    v_total,
    v_first.project_id,
    null,
    v_currency,
    null
  );
  v_request_id := (v_request_result ->> 'payment_request_id')::uuid;

  insert into public.session_deposit_groups (
    artist_id, client_id, project_id, payment_request_id, idempotency_key,
    currency, total_amount, session_count, policy_id, policy_version, created_by
  ) values (
    v_first.artist_id, v_first.client_id, v_first.project_id, v_request_id,
    p_idempotency_key, v_currency, v_total, array_length(v_ids, 1),
    v_policy_id, v_policy_version, auth.uid()
  )
  returning id into v_group_id;

  insert into public.session_deposit_group_members (
    group_id, session_id, artist_id, amount, currency, duration_minutes, tier_max_minutes
  )
  select v_group_id,
         (item ->> 'session_id')::uuid,
         v_first.artist_id,
         (item ->> 'amount')::numeric,
         item ->> 'currency',
         (item ->> 'duration_minutes')::integer,
         nullif(item ->> 'tier_max_minutes', '')::integer
  from jsonb_array_elements(v_breakdown) as item;

  -- The grouped total is an ordinary artist + amount + currency lookup. There
  -- is nothing session-count specific about the destination.
  v_destination_source := crm_private.bind_payment_request_destination(v_request_id);

  insert into public.payment_request_links (
    payment_request_id, artist_id, created_by
  ) values (
    v_request_id, v_first.artist_id, auth.uid()
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
      'deposit_group_email:' || v_request_id::text,
      jsonb_build_object(
        'template', 'deposit_request',
        'template_version', 1,
        'payment_link_id', v_link.id,
        'payment_request_id', v_request_id
      ),
      v_first.artist_id,
      v_first.client_id,
      v_first.project_id,
      null
    )
    on conflict (dedupe_key) do nothing;
  end if;

  perform crm_private.log_artist_activity(
    v_first.artist_id,
    'payment.deposit_group_requested',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_first.client_id, null, v_first.project_id, null, null,
    jsonb_build_object(
      'deposit_group_id', v_group_id,
      'payment_request_id', v_request_id,
      'session_count', array_length(v_ids, 1),
      'currency', v_currency
    )
  );

  return jsonb_build_object(
    'deposit_group_id', v_group_id,
    'payment_request_id', v_request_id,
    'payment_link_id', v_link.id,
    'public_path', '/pay-by-bank-transfer/' || v_link.public_id::text,
    'amount', v_total,
    'currency', v_currency,
    'session_count', array_length(v_ids, 1),
    'sessions', v_breakdown,
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
-- 7. One-off attachment now works against the snapshot, not the live catalogue
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
  else
    -- A project-level request is accepted only when the normalized group proves
    -- exactly which sessions produced this immutable request amount.
    select * into v_group
    from public.session_deposit_groups g
    where g.payment_request_id = v_request.id
      and g.artist_id = v_request.artist_id
      and g.client_id = v_request.client_id
      and g.project_id = v_request.project_id
      and g.total_amount = v_request.amount
      and g.currency = v_request.currency;
    if not found then
      raise exception 'a one-off Monzo destination requires a single-session or grouped deposit request'
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
-- 8. Finance-authorised catalogue management
-- ---------------------------------------------------------------------------

-- Safe non-reversible identity for one destination. It lets an operator see
-- that two entries differ, and that an entry did not silently change, without
-- the browser or an audit record ever holding the provider URL.
create or replace function crm_private.payment_destination_fingerprint(
  p_payment_url text
)
returns text
language sql
immutable
set search_path = pg_catalog, public, crm_private
as $$
  select left(
    encode(
      sha256(convert_to('vishar-monzo-destination:' || coalesce(p_payment_url, ''), 'UTF8')),
      'hex'
    ),
    12
  );
$$;

revoke all on function crm_private.payment_destination_fingerprint(text)
  from public, anon, authenticated, service_role;

create or replace function public.list_monzo_payment_destinations(
  p_artist_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_rows jsonb;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_finance');

  select coalesce(jsonb_agg(live.entry order by live.amount), '[]'::jsonb)
    into v_rows
  from (
    select d.amount,
           jsonb_build_object(
             'destination_id', d.id,
             'amount', d.amount,
             'currency', d.currency,
             'configured', true,
             'fingerprint', crm_private.payment_destination_fingerprint(d.payment_url),
             'created_at', d.created_at,
             'updated_at', d.updated_at,
             'issued_request_count', (
               select count(*)
               from public.payment_request_payment_destinations b
               where b.catalogue_destination_id = d.id
             )
           ) as entry
    from public.monzo_payment_destinations d
    where d.artist_id = p_artist_id
      and d.archived_at is null
  ) live;

  return jsonb_build_object(
    'artist_id', p_artist_id,
    'currency', 'GBP',
    'destinations', v_rows
  );
end;
$$;

-- Create or replace one reusable destination for one exact amount. The browser
-- supplies the amount and URL because it is deliberately configuring a
-- catalogue entry, and the server authorises the artist scope. That amount is
-- catalogue configuration only: it never becomes the amount of a client
-- payment request, which is derived separately from the deposit policy.
create or replace function public.upsert_monzo_payment_destination(
  p_artist_id uuid,
  p_amount numeric,
  p_payment_url text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_amount numeric(12,2);
  v_existing public.monzo_payment_destinations%rowtype;
  v_replaced boolean := false;
  v_id uuid;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_finance');
  perform crm_private.require_active_artist(p_artist_id);

  if p_amount is null then
    raise exception 'a reusable payment destination needs an amount'
      using errcode = '22023';
  end if;

  v_amount := round(p_amount::numeric, 2);
  if v_amount <> p_amount then
    raise exception 'a reusable payment destination amount may not have sub-penny precision'
      using errcode = '22023';
  end if;
  if v_amount <= 0 or v_amount > 100000.00 then
    raise exception 'a reusable payment destination amount must be between 0.01 and 100000.00'
      using errcode = '22023';
  end if;

  p_payment_url := btrim(coalesce(p_payment_url, ''));
  if p_payment_url !~ '^https://monzo[.]com/pay/r/[A-Za-z0-9_-]{4,255}$' then
    raise exception 'Monzo payment URL is invalid' using errcode = '22023';
  end if;

  -- The artist must actually have an enabled Monzo Easy Bank Transfer route.
  -- A second artist never inherits the first artist's configuration.
  if not exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = p_artist_id
      and i.integration_type = 'payments'
      and i.provider = 'monzo_easy_bank_transfer'
      and i.is_enabled
  ) then
    raise exception 'Monzo Easy Bank Transfer is not the enabled payment destination'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('monzo-destination:' || p_artist_id::text || ':' || v_amount::text, 0)
  );

  -- A URL is owned by exactly one catalogue entry, live or archived, and by
  -- exactly one artist. It can also never double as a request-specific one-off.
  if exists (
    select 1 from public.monzo_payment_destinations d
    where d.payment_url = p_payment_url
      and not (d.artist_id = p_artist_id and d.amount = v_amount
               and d.currency = 'GBP' and d.archived_at is null)
  ) then
    raise exception 'this Monzo URL is already used by another payment destination'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.payment_request_payment_destinations d
    where d.payment_url = p_payment_url
  ) then
    raise exception 'this Monzo URL is already bound to a payment request'
      using errcode = '22023';
  end if;

  select * into v_existing
  from public.monzo_payment_destinations d
  where d.artist_id = p_artist_id
    and d.amount = v_amount
    and d.currency = 'GBP'
    and d.archived_at is null
  for update;

  if found then
    if v_existing.payment_url = p_payment_url then
      return jsonb_build_object(
        'destination_id', v_existing.id,
        'artist_id', p_artist_id,
        'amount', v_amount,
        'currency', 'GBP',
        'fingerprint', crm_private.payment_destination_fingerprint(v_existing.payment_url),
        'replaced', false,
        'unchanged', true,
        'confirmed', false
      );
    end if;

    -- Replacement is archival plus a new entry. Requests already issued keep
    -- pointing at the archived row through their own immutable snapshot.
    update public.monzo_payment_destinations d
    set archived_at = now(),
        archived_by = auth.uid(),
        updated_by = auth.uid(),
        updated_at = now()
    where d.id = v_existing.id;
    v_replaced := true;
  end if;

  insert into public.monzo_payment_destinations (
    artist_id, amount, currency, payment_url, created_by, updated_by
  ) values (
    p_artist_id, v_amount, 'GBP', p_payment_url, auth.uid(), auth.uid()
  )
  returning id into v_id;

  -- The URL is deliberately absent from the audit record.
  perform crm_private.log_artist_activity(
    p_artist_id,
    case when v_replaced then 'payment.destination_replaced' else 'payment.destination_created' end,
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    null, null, null, null, null,
    jsonb_build_object(
      'destination_id', v_id,
      'currency', 'GBP',
      'fingerprint', crm_private.payment_destination_fingerprint(p_payment_url),
      'replaced', v_replaced
    )
  );

  return jsonb_build_object(
    'destination_id', v_id,
    'artist_id', p_artist_id,
    'amount', v_amount,
    'currency', 'GBP',
    'fingerprint', crm_private.payment_destination_fingerprint(p_payment_url),
    'replaced', v_replaced,
    'unchanged', false,
    'confirmed', false
  );
end;
$$;

create or replace function public.archive_monzo_payment_destination(
  p_destination_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_destination public.monzo_payment_destinations%rowtype;
begin
  select * into v_destination
  from public.monzo_payment_destinations d
  where d.id = p_destination_id
  for update;
  if not found then
    raise exception 'payment destination % does not exist', p_destination_id
      using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_destination.artist_id, 'manage_finance');
  perform crm_private.require_active_artist(v_destination.artist_id);

  if v_destination.archived_at is not null then
    return jsonb_build_object(
      'destination_id', v_destination.id,
      'artist_id', v_destination.artist_id,
      'amount', v_destination.amount,
      'currency', v_destination.currency,
      'archived', true,
      'unchanged', true
    );
  end if;

  update public.monzo_payment_destinations d
  set archived_at = now(),
      archived_by = auth.uid(),
      updated_by = auth.uid(),
      updated_at = now()
  where d.id = v_destination.id;

  perform crm_private.log_artist_activity(
    v_destination.artist_id,
    'payment.destination_archived',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    null, null, null, null, null,
    jsonb_build_object(
      'destination_id', v_destination.id,
      'currency', v_destination.currency,
      'fingerprint', crm_private.payment_destination_fingerprint(v_destination.payment_url)
    )
  );

  return jsonb_build_object(
    'destination_id', v_destination.id,
    'artist_id', v_destination.artist_id,
    'amount', v_destination.amount,
    'currency', v_destination.currency,
    'archived', true,
    'unchanged', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Closed API surface
-- ---------------------------------------------------------------------------

revoke all on function public.list_monzo_payment_destinations(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.upsert_monzo_payment_destination(uuid,numeric,text)
  from public, anon, authenticated, service_role;
revoke all on function public.archive_monzo_payment_destination(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.request_session_deposit(uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.request_grouped_session_deposit(uuid[],uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.attach_monzo_one_off_payment_destination(uuid,text)
  from public, anon, authenticated, service_role;

grant execute on function public.list_monzo_payment_destinations(uuid)
  to authenticated;
grant execute on function public.upsert_monzo_payment_destination(uuid,numeric,text)
  to authenticated;
grant execute on function public.archive_monzo_payment_destination(uuid)
  to authenticated;
grant execute on function public.request_session_deposit(uuid,uuid,text)
  to authenticated;
grant execute on function public.request_grouped_session_deposit(uuid[],uuid,text)
  to authenticated;
grant execute on function public.attach_monzo_one_off_payment_destination(uuid,text)
  to authenticated;

comment on function public.list_monzo_payment_destinations(uuid) is
  'Finance-scoped reusable destination catalogue for one artist. Returns amounts and a non-reversible fingerprint only; it never returns a provider URL, credential or bank account id.';
comment on function public.upsert_monzo_payment_destination(uuid,numeric,text) is
  'Creates or replaces one reusable Monzo destination for one exact artist amount. Replacement archives the previous entry; already issued payment requests keep their own immutable destination snapshot. Never creates, reprices or settles a payment request.';
comment on function public.archive_monzo_payment_destination(uuid) is
  'Withdraws one reusable Monzo destination from future resolution. Payment requests already issued against it keep resolving to their immutable snapshot. Never settles payment.';
comment on function public.request_session_deposit(uuid,uuid,text) is
  'Creates or replays one artist-scoped server-priced session deposit, binds its immutable destination snapshot, and refuses an appointment already allocated to a live grouped deposit.';
comment on function public.request_grouped_session_deposit(uuid[],uuid,text) is
  'Creates or replays one artist-scoped deposit request covering 2-12 tattoo sessions of one project. Every component amount is server-derived and the grouped total resolves its destination as an ordinary artist + amount + currency lookup.';
comment on function public.attach_monzo_one_off_payment_destination(uuid,text) is
  'Attaches one clean Monzo URL to one open deposit request that has no bound destination and no live reusable entry for its immutable amount. Never settles payment.';
