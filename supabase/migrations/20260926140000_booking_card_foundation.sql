-- 20260926140000_booking_card_foundation.sql
--
-- Canonical multichannel booking-card facts. This migration is deliberately
-- inert at the provider boundary: it creates/supersedes private card snapshots
-- but never queues Email or WhatsApp delivery.

create table crm_private.booking_cards (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete restrict,
  artist_id uuid not null references public.artists(id) on delete restrict,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  enquiry_id uuid references public.enquiries(id) on delete restrict,
  project_id uuid references public.projects(id) on delete restrict,
  card_kind text not null check (card_kind in ('tattoo_deposit_paid', 'consultation_booked')),
  appointment_type public.appointment_type not null,
  calendar_version integer not null check (calendar_version >= 0),
  revision integer not null check (revision >= 1),
  start_at timestamptz not null,
  end_at timestamptz not null,
  timezone text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  session_price numeric(12,2),
  deposit_paid numeric(12,2),
  remaining_balance numeric(12,2),
  fact_hash text not null check (fact_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  superseded_at timestamptz,
  constraint booking_cards_time_order check (end_at > start_at),
  constraint booking_cards_financial_shape check (
    (
      card_kind = 'consultation_booked'
      and appointment_type = 'in_person_consultation'::public.appointment_type
      and session_price is null
      and deposit_paid is null
      and remaining_balance is null
    )
    or
    (
      card_kind = 'tattoo_deposit_paid'
      and appointment_type = 'tattoo_session'::public.appointment_type
      and session_price > 0
      and deposit_paid > 0
      and deposit_paid <= session_price
      and remaining_balance = session_price - deposit_paid
    )
  ),
  constraint booking_cards_superseded_after_create
    check (superseded_at is null or superseded_at >= created_at),
  unique (session_id, card_kind, revision),
  unique (session_id, card_kind, fact_hash)
);

create unique index booking_cards_one_current_idx
  on crm_private.booking_cards(session_id, card_kind)
  where superseded_at is null;

create index booking_cards_artist_current_idx
  on crm_private.booking_cards(artist_id, created_at desc)
  where superseded_at is null;

comment on table crm_private.booking_cards is
  'Immutable-enough server snapshots shared by Email and WhatsApp booking cards. Provider rendering may not recalculate these facts.';

create table crm_private.booking_card_deliveries (
  id uuid primary key default gen_random_uuid(),
  booking_card_id uuid not null references crm_private.booking_cards(id) on delete restrict,
  channel public.message_template_channel not null
    check (channel in ('email'::public.message_template_channel, 'whatsapp'::public.message_template_channel)),
  status text not null default 'pending'
    check (status in ('pending', 'skipped', 'queued', 'sent', 'failed', 'superseded')),
  email_message_id uuid references public.email_messages(id) on delete restrict,
  communication_message_id uuid references public.communication_messages(id) on delete restrict,
  skip_reason text check (skip_reason is null or skip_reason ~ '^[a-z][a-z0-9_]{2,63}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  queued_at timestamptz,
  sent_at timestamptz,
  failed_at timestamptz,
  unique (booking_card_id, channel),
  constraint booking_card_delivery_target_shape check (
    (channel = 'email' and communication_message_id is null)
    or (channel = 'whatsapp' and email_message_id is null)
  )
);

comment on table crm_private.booking_card_deliveries is
  'Per-channel delivery state. Retry/failure on one channel never rewrites the sibling channel.';

create table crm_private.booking_card_artist_settings (
  artist_id uuid primary key references public.artists(id) on delete cascade,
  email_enabled boolean not null default false,
  whatsapp_enabled boolean not null default false,
  studio_name text,
  studio_address text,
  studio_map_url text,
  location_latitude numeric(9,6),
  location_longitude numeric(9,6),
  whatsapp_tattoo_template_name text,
  whatsapp_consultation_template_name text,
  whatsapp_template_language text not null default 'en_GB'
    check (whatsapp_template_language ~ '^[a-z]{2}(_[A-Z]{2})?$'),
  appointment_start_from timestamptz,
  client_action_base_url text
    check (client_action_base_url is null
      or (client_action_base_url ~ '^https://[a-z0-9.-]+(/[A-Za-z0-9._~-]+)*/$'
          and char_length(client_action_base_url) <= 200)),
  updated_at timestamptz not null default now(),
  constraint booking_card_settings_location_bounds check (
    (location_latitude is null or location_latitude between -90 and 90)
    and (location_longitude is null or location_longitude between -180 and 180)
  ),
  constraint booking_card_settings_template_names check (
    (whatsapp_tattoo_template_name is null
      or (whatsapp_tattoo_template_name ~ '^[a-z0-9_]+$' and char_length(whatsapp_tattoo_template_name) <= 512))
    and
    (whatsapp_consultation_template_name is null
      or (whatsapp_consultation_template_name ~ '^[a-z0-9_]+$' and char_length(whatsapp_consultation_template_name) <= 512))
  ),
  constraint booking_card_settings_email_ready check (
    not email_enabled
    or (
      client_action_base_url is not null
      and nullif(btrim(studio_name), '') is not null
      and nullif(btrim(studio_address), '') is not null
      and studio_map_url ~ '^https://[^[:space:]]+$' and char_length(studio_map_url) <= 1900
    )
  ),
  constraint booking_card_settings_whatsapp_ready check (
    not whatsapp_enabled
    or (
      nullif(btrim(studio_name), '') is not null
      and nullif(btrim(studio_address), '') is not null
      and studio_map_url ~ '^https://[^[:space:]]+$' and char_length(studio_map_url) <= 1900
      and location_latitude is not null
      and location_longitude is not null
      and whatsapp_tattoo_template_name is not null
      and whatsapp_consultation_template_name is not null
    )
  )
);

comment on table crm_private.booking_card_artist_settings is
  'Fail-closed artist-scoped rollout and studio/template configuration. Both channels default disabled.';
comment on column crm_private.booking_card_artist_settings.client_action_base_url is
  'Server-owned public base URL for one-time client action links (the token is appended). Kept as configuration so no domain is baked into function bodies.';
comment on column crm_private.booking_card_artist_settings.appointment_start_from is
  'Optional earliest appointment start eligible for this artist booking-card location/configuration.';

revoke all on table crm_private.booking_cards
  from public, anon, authenticated, service_role;
revoke all on table crm_private.booking_card_deliveries
  from public, anon, authenticated, service_role;
revoke all on table crm_private.booking_card_artist_settings
  from public, anon, authenticated, service_role;

create or replace function crm_private.booking_card_deposit_for_session(
  p_session_id uuid
)
returns table (
  amount numeric,
  currency text,
  source_kind text,
  source_id uuid
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with allocations as (
    select
      r.amount,
      r.currency,
      'session_request'::text as source_kind,
      r.id as source_id
    from public.payment_requests r
    where r.session_id = p_session_id
      and r.purpose = 'deposit'::public.payment_request_purpose
      and r.status = 'paid'::public.payment_request_status

    union all

    select
      m.amount,
      r.currency,
      'group_request'::text as source_kind,
      g.payment_request_id as source_id
    from public.session_deposit_group_members m
    join public.session_deposit_groups g on g.id = m.group_id
    join public.payment_requests r on r.id = g.payment_request_id
    where m.session_id = p_session_id
      and m.released_at is null
      and r.purpose = 'deposit'::public.payment_request_purpose
      and r.status = 'paid'::public.payment_request_status
  ),
  counted as (
    select a.*, count(*) over () as allocation_count
    from allocations a
  )
  select c.amount, c.currency, c.source_kind, c.source_id
  from counted c
  where c.allocation_count = 1
    and c.amount > 0;
$$;

create or replace function crm_private.sync_booking_card(
  p_session_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private, extensions
as $$
declare
  v_artist_id uuid;
  v_workspace_id uuid;
  v_client_id uuid;
  v_enquiry_id uuid;
  v_project_id uuid;
  v_type public.appointment_type;
  v_status public.session_status;
  v_start_at timestamptz;
  v_end_at timestamptz;
  v_calendar_version integer;
  v_timezone text;
  v_currency text;
  v_price numeric;
  v_client_archived_at timestamptz;
  v_card_kind text;
  v_deposit numeric;
  v_deposit_currency text;
  v_remaining numeric;
  v_fact_hash text;
  v_current_id uuid;
  v_current_hash text;
  v_revision integer;
  v_card_id uuid;
begin
  if p_session_id is null then
    return null;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('booking-card:' || p_session_id::text, 0)
  );

  select
    s.artist_id,
    a.workspace_id,
    s.client_id,
    s.enquiry_id,
    s.project_id,
    s.appointment_type,
    s.status,
    s.start_at,
    s.end_at,
    s.calendar_version,
    a.timezone,
    s.currency,
    s.price,
    c.archived_at
  into
    v_artist_id,
    v_workspace_id,
    v_client_id,
    v_enquiry_id,
    v_project_id,
    v_type,
    v_status,
    v_start_at,
    v_end_at,
    v_calendar_version,
    v_timezone,
    v_currency,
    v_price,
    v_client_archived_at
  from public.sessions s
  join public.artists a on a.id = s.artist_id and a.is_active
  join public.clients c on c.id = s.client_id
  where s.id = p_session_id;

  if not found
     or v_client_archived_at is not null
     or v_status <> 'confirmed'::public.session_status
     or v_start_at <= clock_timestamp() then
    update crm_private.booking_cards
    set superseded_at = coalesce(superseded_at, now())
    where session_id = p_session_id
      and superseded_at is null;
    return null;
  end if;

  if v_type = 'in_person_consultation'::public.appointment_type then
    v_card_kind := 'consultation_booked';
    v_price := null;
    v_deposit := null;
    v_remaining := null;
  elsif v_type = 'tattoo_session'::public.appointment_type then
    if v_price is null or v_price <= 0 then
      update crm_private.booking_cards
      set superseded_at = coalesce(superseded_at, now())
      where session_id = p_session_id
        and superseded_at is null;
      return null;
    end if;

    select d.amount, d.currency
      into v_deposit, v_deposit_currency
    from crm_private.booking_card_deposit_for_session(p_session_id) d;

    if not found
       or v_deposit is null
       or v_deposit <= 0
       or v_deposit_currency is distinct from v_currency
       or v_deposit > v_price then
      update crm_private.booking_cards
      set superseded_at = coalesce(superseded_at, now())
      where session_id = p_session_id
        and superseded_at is null;
      return null;
    end if;

    v_card_kind := 'tattoo_deposit_paid';
    v_remaining := v_price - v_deposit;
  else
    update crm_private.booking_cards
    set superseded_at = coalesce(superseded_at, now())
    where session_id = p_session_id
      and superseded_at is null;
    return null;
  end if;

  v_fact_hash := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'session_id', p_session_id,
          'artist_id', v_artist_id,
          'client_id', v_client_id,
          'card_kind', v_card_kind,
          'calendar_version', v_calendar_version,
          'start_at', v_start_at,
          'end_at', v_end_at,
          'timezone', v_timezone,
          'currency', v_currency,
          'session_price', v_price,
          'deposit_paid', v_deposit,
          'remaining_balance', v_remaining
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  select b.id, b.fact_hash
    into v_current_id, v_current_hash
  from crm_private.booking_cards b
  where b.session_id = p_session_id
    and b.card_kind = v_card_kind
    and b.superseded_at is null
  for update;

  if found and v_current_hash = v_fact_hash then
    return v_current_id;
  end if;

  if v_current_id is not null then
    update crm_private.booking_cards
    set superseded_at = now()
    where id = v_current_id
      and superseded_at is null;
  end if;

  select coalesce(max(b.revision), 0) + 1
    into v_revision
  from crm_private.booking_cards b
  where b.session_id = p_session_id
    and b.card_kind = v_card_kind;

  insert into crm_private.booking_cards (
    session_id,
    artist_id,
    workspace_id,
    client_id,
    enquiry_id,
    project_id,
    card_kind,
    appointment_type,
    calendar_version,
    revision,
    start_at,
    end_at,
    timezone,
    currency,
    session_price,
    deposit_paid,
    remaining_balance,
    fact_hash
  ) values (
    p_session_id,
    v_artist_id,
    v_workspace_id,
    v_client_id,
    v_enquiry_id,
    v_project_id,
    v_card_kind,
    v_type,
    v_calendar_version,
    v_revision,
    v_start_at,
    v_end_at,
    v_timezone,
    v_currency,
    v_price,
    v_deposit,
    v_remaining,
    v_fact_hash
  )
  returning id into v_card_id;

  return v_card_id;
end;
$$;

create or replace function crm_private.refresh_booking_card_from_session()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  begin
    perform crm_private.sync_booking_card(new.id);
  exception when others then
    raise warning 'booking card session sync failed, sqlstate=%', sqlstate;
  end;
  return new;
end;
$$;

create or replace function crm_private.refresh_booking_card_from_payment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_session_id uuid;
begin
  begin
    if new.session_id is not null then
      perform crm_private.sync_booking_card(new.session_id);
    end if;

    for v_session_id in
      select m.session_id
      from public.session_deposit_groups g
      join public.session_deposit_group_members m on m.group_id = g.id
      where g.payment_request_id = new.id
        and m.released_at is null
    loop
      perform crm_private.sync_booking_card(v_session_id);
    end loop;
  exception when others then
    raise warning 'booking card payment sync failed, sqlstate=%', sqlstate;
  end;
  return new;
end;
$$;

create or replace function crm_private.refresh_booking_card_from_group_member()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  begin
    perform crm_private.sync_booking_card(new.session_id);
  exception when others then
    raise warning 'booking card group sync failed, sqlstate=%', sqlstate;
  end;
  return new;
end;
$$;

drop trigger if exists sessions_refresh_booking_card on public.sessions;
create trigger sessions_refresh_booking_card
after insert or update of
  status, start_at, end_at, calendar_version, price, appointment_type
on public.sessions
for each row execute function crm_private.refresh_booking_card_from_session();

drop trigger if exists payment_requests_refresh_booking_card on public.payment_requests;
create trigger payment_requests_refresh_booking_card
after insert or update of status
on public.payment_requests
for each row execute function crm_private.refresh_booking_card_from_payment();

drop trigger if exists session_deposit_group_members_refresh_booking_card
  on public.session_deposit_group_members;
create trigger session_deposit_group_members_refresh_booking_card
after insert or update of released_at
on public.session_deposit_group_members
for each row execute function crm_private.refresh_booking_card_from_group_member();

revoke all on function crm_private.booking_card_deposit_for_session(uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.sync_booking_card(uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.refresh_booking_card_from_session()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.refresh_booking_card_from_payment()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.refresh_booking_card_from_group_member()
  from public, anon, authenticated, service_role;
