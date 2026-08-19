-- 0064_monzo_artist_payment_destinations.sql
--
-- Make the Monzo payment architecture artist-generic and amount-generic so a
-- second Monzo artist is a configuration task, and so grouped deposits do not
-- need another schema redesign later.
--
-- Three changes, all forward-only and none of them provider-connecting:
--
--  1. The reusable Monzo destination catalogue stops being a four-value tier
--     table and becomes an artist-scoped catalogue keyed by
--     (artist_id, amount, currency). Existing rows and their operator-owned
--     URLs are preserved by renaming rather than recreating the table, so no
--     live destination is touched by this migration.
--
--  2. A payment request may carry one request-specific one-off destination for
--     a legitimate amount the artist has no reusable link for. It is bound to
--     exactly one payment request and one artist, is never promoted into the
--     catalogue, and is never reachable from another request.
--
--  3. Several tattoo sessions of one project may be covered by one deposit
--     payment through a normalized group relation. The group total is the sum
--     of the same server-derived per-session duration amounts; the browser
--     still supplies no amount anywhere.
--
-- Nothing here settles a payment. Opening a link is still navigation only, a
-- reconciliation candidate is still not settlement, and only the existing
-- explicit human Confirm payment writes the immutable ledger.

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

-- The four standard per-session amounts stay the only ones a single-session
-- deposit can produce, but the catalogue itself must be able to hold any
-- legitimate server-calculated total (for example a grouped GBP 600 deposit)
-- without another schema change. The bound below is an anti-typo guard, not a
-- business rule.
alter table public.monzo_payment_destinations
  drop constraint monzo_easy_bank_transfer_tier_urls_amount_allowed;
alter table public.monzo_payment_destinations
  add constraint monzo_payment_destinations_amount_range
  check (amount > 0 and amount <= 100000.00);

comment on table public.monzo_payment_destinations is
  'Closed artist-scoped reusable Monzo Easy Bank Transfer destinations keyed by (artist_id, amount, currency). Selected only from an immutable server-calculated payment request amount. No provider credential is stored here, and one artist can never resolve to another artist row.';
comment on column public.monzo_payment_destinations.amount is
  'Exact GBP amount this reusable destination is for. New supported amounts are added as rows, never as a schema change.';

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
  -- A one-off URL belongs to exactly one payment request. It can therefore
  -- never be handed to a second client, and never to a second artist.
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
  'One-off Monzo destination attached to exactly one payment request by an authorised finance user. Never promoted into the reusable catalogue, never shared with another request, artist or client. Attaching one does not settle anything.';

-- ---------------------------------------------------------------------------
-- 3. Grouped session deposits
-- ---------------------------------------------------------------------------

create table public.session_deposit_groups (
  id                 uuid primary key default gen_random_uuid(),
  artist_id          uuid not null references public.artists(id) on delete restrict,
  client_id          uuid not null references public.clients(id) on delete restrict,
  project_id         uuid not null,
  payment_request_id uuid not null,
  idempotency_key    uuid not null,
  currency           text not null default 'GBP',
  total_amount       numeric(12,2) not null,
  session_count      integer not null,
  policy_id          uuid not null,
  policy_version     integer not null,
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),

  constraint session_deposit_groups_idempotency_key_key unique (idempotency_key),
  constraint session_deposit_groups_request_key unique (payment_request_id),
  constraint session_deposit_groups_id_artist_key unique (id, artist_id),
  constraint session_deposit_groups_request_artist_fkey
    foreign key (payment_request_id, artist_id)
    references public.payment_requests(id, artist_id)
    on delete restrict,
  constraint session_deposit_groups_project_artist_fkey
    foreign key (project_id, artist_id)
    references public.projects(id, artist_id)
    on delete restrict,
  constraint session_deposit_groups_policy_artist_version_fkey
    foreign key (policy_id, artist_id, policy_version)
    references public.artist_payment_policies(id, artist_id, version)
    on delete restrict,
  constraint session_deposit_groups_currency_gbp check (currency = 'GBP'),
  constraint session_deposit_groups_positive_total check (total_amount > 0),
  constraint session_deposit_groups_session_count_range
    check (session_count between 2 and 12)
);

create index session_deposit_groups_project_idx
  on public.session_deposit_groups (project_id, created_at desc);

alter table public.session_deposit_groups enable row level security;
alter table public.session_deposit_groups force row level security;
revoke all on public.session_deposit_groups
  from public, anon, authenticated, service_role;

comment on table public.session_deposit_groups is
  'One deposit payment request covering several tattoo sessions of one project. The total is the sum of the same server-derived per-session duration amounts; no browser input contributes to it.';

create table public.session_deposit_group_members (
  group_id         uuid not null,
  session_id       uuid not null,
  artist_id        uuid not null,
  amount           numeric(12,2) not null,
  currency         text not null default 'GBP',
  duration_minutes integer not null,
  tier_max_minutes integer,
  created_at       timestamptz not null default now(),
  released_at      timestamptz,

  constraint session_deposit_group_members_pkey primary key (group_id, session_id),
  constraint session_deposit_group_members_group_artist_fkey
    foreign key (group_id, artist_id)
    references public.session_deposit_groups(id, artist_id)
    on delete restrict,
  constraint session_deposit_group_members_session_artist_fkey
    foreign key (session_id, artist_id)
    references public.sessions(id, artist_id)
    on delete restrict,
  constraint session_deposit_group_members_currency_gbp check (currency = 'GBP'),
  constraint session_deposit_group_members_positive_amount check (amount > 0),
  constraint session_deposit_group_members_positive_duration
    check (duration_minutes > 0)
);

-- No session may be financially allocated to two live groups at once. A group
-- whose request is cancelled or expired releases its sessions, so they can be
-- grouped again without ever double-counting a live deposit.
create unique index session_deposit_group_members_live_session_idx
  on public.session_deposit_group_members (session_id)
  where released_at is null;

alter table public.session_deposit_group_members enable row level security;
alter table public.session_deposit_group_members force row level security;
revoke all on public.session_deposit_group_members
  from public, anon, authenticated, service_role;

comment on table public.session_deposit_group_members is
  'Which sessions one grouped deposit covers, and the server-derived amount and duration each contributed. Answers coverage and allocation questions without hiding them in JSON.';
comment on column public.session_deposit_group_members.released_at is
  'Set when the grouped payment request is cancelled or expired. Historical membership and its calculated amount are retained as audit evidence.';

create or replace function crm_private.release_session_deposit_group_members()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.status not in ('cancelled', 'expired') then
    return new;
  end if;

  update public.session_deposit_group_members m
  set released_at = now()
  from public.session_deposit_groups g
  where g.payment_request_id = new.id
    and m.group_id = g.id
    and m.released_at is null;

  return new;
end;
$$;

revoke all on function crm_private.release_session_deposit_group_members()
  from public, anon, authenticated, service_role;

drop trigger if exists payment_requests_release_deposit_group
  on public.payment_requests;
create trigger payment_requests_release_deposit_group
  after update of status on public.payment_requests
  for each row execute function crm_private.release_session_deposit_group_members();

-- ---------------------------------------------------------------------------
-- 4. Amount-bound, artist-bound destination resolution
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
  -- The artist must still have this exact enabled Monzo route. Without it no
  -- destination resolves at all: there is deliberately no cross-artist and no
  -- provider-level fallback.
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

  -- A one-off destination is request-specific and outranks nothing else,
  -- because it may only exist when the catalogue has no row for this amount.
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

  -- Legacy compatibility only: the artist_integrations payment_url is the
  -- GBP 250 destination from before the catalogue existed.
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
  'Artist-bound, amount-bound destination lookup. Fails closed to NULL rather than falling back to another artist, another amount or a provider default.';

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
  'Backend-only amount-bound redirect resolver for single and grouped deposits. The immutable payment request amount selects the artist destination; opening a link never creates a payment transaction or changes payment status.';

-- ---------------------------------------------------------------------------
-- 5. Grouped deposit request
-- ---------------------------------------------------------------------------

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

  -- Replay before any lock or write, so a retried request never creates a
  -- second group or a second payment request.
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

    return jsonb_build_object(
      'deposit_group_id', v_group.id,
      'payment_request_id', v_group.payment_request_id,
      'payment_link_id', v_link.id,
      'public_path', '/pay-by-bank-transfer/' || v_link.public_id::text,
      'amount', v_group.total_amount,
      'currency', v_group.currency,
      'session_count', v_group.session_count,
      'delivery_channel', p_delivery_channel,
      'replayed', true
    );
  end if;

  -- Locking every session row first serialises concurrent grouping attempts
  -- that share any appointment.
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

    -- One artist, one client and one project per grouped deposit. This keeps
    -- the aggregate request answerable and prevents a cross-artist total.
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

    -- No appointment may be financially allocated twice: not through its own
    -- single-session deposit and not through a second live group.
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
-- 6. Finance-scoped grouped deposit evidence
-- ---------------------------------------------------------------------------

create or replace function public.get_session_deposit_group(
  p_payment_request_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_request public.payment_requests%rowtype;
  v_group public.session_deposit_groups%rowtype;
  v_net numeric(12,2);
  v_status public.payment_request_status;
begin
  select * into v_request
  from public.payment_requests r
  where r.id = p_payment_request_id;
  if not found then
    raise exception 'payment request % does not exist', p_payment_request_id
      using errcode = '23503';
  end if;

  -- Authorise on the request artist before revealing anything, including
  -- whether this request is a grouped deposit at all.
  perform crm_private.require_artist_access(v_request.artist_id, 'view_finance');

  select * into v_group
  from public.session_deposit_groups g
  where g.payment_request_id = p_payment_request_id;
  if not found then
    return null;
  end if;

  v_status := v_request.status;
  v_net := crm_private.payment_request_net_paid(v_group.payment_request_id);

  return jsonb_build_object(
    'deposit_group_id', v_group.id,
    'payment_request_id', v_group.payment_request_id,
    'project_id', v_group.project_id,
    'currency', v_group.currency,
    'total_amount', v_group.total_amount,
    'net_paid', v_net,
    'outstanding_amount', greatest(v_group.total_amount - v_net, 0::numeric),
    'payment_request_status', v_status::text,
    'session_count', v_group.session_count,
    'sessions', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'session_id', m.session_id,
          'amount', m.amount,
          'currency', m.currency,
          'duration_minutes', m.duration_minutes,
          'session_status', s.status,
          'start_at', s.start_at,
          'end_at', s.end_at,
          'released', m.released_at is not null
        ) order by s.start_at
      ), '[]'::jsonb)
      from public.session_deposit_group_members m
      join public.sessions s on s.id = m.session_id
      where m.group_id = v_group.id
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. One-off destination for an uncovered legitimate amount
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
    raise exception 'a one-off Monzo destination applies only to an open GBP Monzo deposit request'
      using errcode = '22023';
  end if;

  -- The amount must already be server-authoritative: either a duration-guarded
  -- single-session deposit or a grouped deposit whose total this database
  -- calculated. A finance user therefore cannot invent an arbitrary amount and
  -- then give it a working public payment link.
  if v_request.session_id is null and not exists (
    select 1 from public.session_deposit_groups g
    where g.payment_request_id = v_request.id
  ) then
    raise exception 'a one-off Monzo destination applies only to a server-calculated session or grouped deposit'
      using errcode = '22023';
  end if;

  -- The artist must still own this exact enabled Monzo route.
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

  -- A one-off link exists only for an amount the artist has no reusable
  -- destination for. Reusable routing is never overridden per request.
  if exists (
    select 1
    from public.monzo_payment_destinations d
    where d.artist_id = v_request.artist_id
      and d.amount = v_request.amount
      and d.currency = v_request.currency
  ) or (v_request.amount = 250.00 and exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = v_request.artist_id
      and i.integration_type = 'payments'
      and i.provider = 'monzo_easy_bank_transfer'
      and i.integration_key = v_request.provider_account_key
      and i.is_enabled
      and (i.configuration ->> 'payment_url') is not null
  )) then
    raise exception 'this amount already has a reusable Monzo destination'
      using errcode = '22023';
  end if;

  -- A one-off URL is never reused as a reusable destination, and never for a
  -- second payment request. Both directions are checked for every artist.
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
    'public_path', '/pay-by-bank-transfer/' || (
      select l.public_id::text
      from public.payment_request_links l
      where l.payment_request_id = v_request.id
    ),
    'amount', v_request.amount,
    'currency', v_request.currency,
    'replaced', coalesce(v_replaced, false),
    'confirmed', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Closed RPC surface
-- ---------------------------------------------------------------------------

revoke all on function public.request_grouped_session_deposit(uuid[],uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.get_session_deposit_group(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.attach_monzo_one_off_payment_destination(uuid,text)
  from public, anon, authenticated, service_role;

grant execute on function public.request_grouped_session_deposit(uuid[],uuid,text)
  to authenticated;
grant execute on function public.get_session_deposit_group(uuid)
  to authenticated;
grant execute on function public.attach_monzo_one_off_payment_destination(uuid,text)
  to authenticated;

comment on function public.request_grouped_session_deposit(uuid[],uuid,text) is
  'Creates or replays one Monzo deposit request covering several tattoo sessions of one project. Every per-session amount is derived from the locked appointment duration; the caller supplies no amount and no destination.';
comment on function public.get_session_deposit_group(uuid) is
  'Finance-scoped safe coverage evidence for one grouped deposit. Returns no provider credential, destination URL or provider identifier.';
comment on function public.attach_monzo_one_off_payment_destination(uuid,text) is
  'Attaches one Monzo URL to exactly one open deposit request whose amount has no reusable destination. It never changes the authoritative amount, never enters the reusable catalogue and never settles anything.';

-- ---------------------------------------------------------------------------
-- 9. Single-session deposits respect grouped allocation
-- ---------------------------------------------------------------------------
--
-- Unchanged from the duration-tiered definition apart from one added guard:
-- an appointment already covered by a live grouped deposit cannot also raise
-- its own single-session deposit request.

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

  -- An appointment covered by a live grouped deposit is already financially
  -- allocated. Allowing a second single-session request would double-charge the
  -- same appointment.
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

revoke all on function public.request_session_deposit(uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.request_session_deposit(uuid,uuid,text)
  to authenticated;

comment on function public.request_session_deposit(uuid,uuid,text) is
  'Creates or replays one artist-scoped Monzo deposit request whose amount is derived server-side from the locked tattoo-session duration, and never for an appointment already covered by a live grouped deposit.';
