-- 20260926220000_booking_card_pricing_and_deposit_allocation.sql
--
-- Completes the booking-card money model against how deposits are actually
-- recorded in production:
--
-- 1. Per-artist session pricing configuration (hourly rate, full-day rate,
--    per-session deposit). The same structure serves every artist; nothing
--    here is specific to one artist except the seeded row for Vladimir.
--    The rates only feed the CRM price suggestion. sessions.price stays the
--    single authoritative session total, exactly as the spec requires.
-- 2. Project-level deposits. Most paid deposits are recorded on the project
--    (manual confirmation, or project deposit status) rather than on one
--    session. A paid project deposit is allocated to the project's booked
--    tattoo sessions in start order, one per-session deposit each. Without a
--    configured per-session deposit, the pool is only attributable when the
--    project has exactly one booked tattoo session.
-- 3. One eligibility function with an explicit reason, used both by
--    sync_booking_card and by a read-only CRM status RPC, so the operator can
--    see why a card was not produced instead of a silent skip.
-- 4. A short send delay for queued card messages, so a combined edit (time
--    then price) supersedes the first revision before anything is sent.
-- 5. Thousands separators in card money.

-- ---------------------------------------------------------------------------
-- 1. Artist session pricing
-- ---------------------------------------------------------------------------

create table crm_private.artist_session_pricing (
  artist_id uuid primary key references public.artists(id) on delete cascade,
  currency text not null default 'GBP' check (currency ~ '^[A-Z]{3}$'),
  hourly_rate numeric(12,2)
    check (hourly_rate is null or (hourly_rate > 0 and hourly_rate <= 10000)),
  full_day_rate numeric(12,2)
    check (full_day_rate is null or (full_day_rate > 0 and full_day_rate <= 100000)),
  full_day_hours numeric(4,2)
    check (full_day_hours is null or (full_day_hours > 0 and full_day_hours <= 16)),
  session_deposit_amount numeric(12,2)
    check (session_deposit_amount is null
      or (session_deposit_amount > 0 and session_deposit_amount <= 100000)),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  constraint artist_session_pricing_full_day_pair
    check ((full_day_rate is null) = (full_day_hours is null))
);

comment on table crm_private.artist_session_pricing is
  'Per-artist session rates and per-session deposit. Rates only suggest sessions.price in the CRM; booking cards never derive a price from them.';

revoke all on table crm_private.artist_session_pricing
  from public, anon, authenticated, service_role;

-- Vladimir's confirmed business rules: £140/hour, £980 for a 7-hour full day,
-- £250 deposit per tattoo session. Other artists configure their own values
-- in the CRM; nothing is assumed for them.
insert into crm_private.artist_session_pricing (
  artist_id, currency, hourly_rate, full_day_rate, full_day_hours, session_deposit_amount
)
select a.id, 'GBP', 140.00, 980.00, 7.00, 250.00
from public.artists a
where a.id = 'a1111111-1111-4111-8111-111111111111'::uuid
on conflict (artist_id) do nothing;

create or replace function public.get_artist_session_pricing(p_artist_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_row crm_private.artist_session_pricing%rowtype;
begin
  if p_artist_id is null then
    raise exception 'an artist id is required' using errcode = '22023';
  end if;
  if not public.can_view_artist_finance(p_artist_id) then
    raise exception 'finance access is required' using errcode = '42501';
  end if;

  select * into v_row
  from crm_private.artist_session_pricing p
  where p.artist_id = p_artist_id;

  if not found then
    return jsonb_build_object(
      'artist_id', p_artist_id,
      'configured', false,
      'currency', 'GBP',
      'hourly_rate', null,
      'full_day_rate', null,
      'full_day_hours', null,
      'session_deposit_amount', null,
      'updated_at', null
    );
  end if;

  return jsonb_build_object(
    'artist_id', p_artist_id,
    'configured', true,
    'currency', v_row.currency,
    'hourly_rate', v_row.hourly_rate,
    'full_day_rate', v_row.full_day_rate,
    'full_day_hours', v_row.full_day_hours,
    'session_deposit_amount', v_row.session_deposit_amount,
    'updated_at', v_row.updated_at
  );
end;
$$;

revoke all on function public.get_artist_session_pricing(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_artist_session_pricing(uuid) to authenticated;

create or replace function crm_private.assert_money_input(
  p_value numeric,
  p_label text,
  p_max numeric
)
returns void
language plpgsql
immutable
set search_path = pg_catalog
as $$
begin
  if p_value is null then
    return;
  end if;
  if p_value <= 0 or p_value > p_max then
    raise exception '% must be between 0.01 and %', p_label, p_max
      using errcode = '22023';
  end if;
  if round(p_value, 2) <> p_value then
    raise exception '% may have at most two decimal places', p_label
      using errcode = '22023';
  end if;
end;
$$;

revoke all on function crm_private.assert_money_input(numeric, text, numeric)
  from public, anon, authenticated, service_role;

create or replace function public.set_artist_session_pricing(
  p_artist_id uuid,
  p_hourly_rate numeric,
  p_full_day_rate numeric,
  p_full_day_hours numeric,
  p_session_deposit_amount numeric,
  p_currency text default 'GBP'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_currency text := upper(btrim(coalesce(p_currency, 'GBP')));
  v_previous jsonb;
  v_session_id uuid;
begin
  if p_artist_id is null then
    raise exception 'an artist id is required' using errcode = '22023';
  end if;

  perform crm_private.require_artist_access(p_artist_id, 'manage_finance');
  perform crm_private.require_active_artist(p_artist_id);

  if v_currency !~ '^[A-Z]{3}$' then
    raise exception 'currency must be a three-letter code' using errcode = '22023';
  end if;
  perform crm_private.assert_money_input(p_hourly_rate, 'hourly rate', 10000);
  perform crm_private.assert_money_input(p_full_day_rate, 'full-day rate', 100000);
  perform crm_private.assert_money_input(p_session_deposit_amount, 'session deposit', 100000);
  if (p_full_day_rate is null) <> (p_full_day_hours is null) then
    raise exception 'a full-day rate needs its full-day length in hours, and vice versa'
      using errcode = '22023';
  end if;
  if p_full_day_hours is not null
     and (p_full_day_hours <= 0 or p_full_day_hours > 16
          or round(p_full_day_hours * 4) <> p_full_day_hours * 4) then
    raise exception 'full-day length must be 0.25 to 16 hours in quarter-hour steps'
      using errcode = '22023';
  end if;

  select jsonb_build_object(
      'currency', p.currency,
      'hourly_rate', p.hourly_rate,
      'full_day_rate', p.full_day_rate,
      'full_day_hours', p.full_day_hours,
      'session_deposit_amount', p.session_deposit_amount)
    into v_previous
  from crm_private.artist_session_pricing p
  where p.artist_id = p_artist_id
  for update;

  insert into crm_private.artist_session_pricing (
    artist_id, currency, hourly_rate, full_day_rate, full_day_hours,
    session_deposit_amount, updated_at, updated_by
  ) values (
    p_artist_id, v_currency, p_hourly_rate, p_full_day_rate, p_full_day_hours,
    p_session_deposit_amount, now(), auth.uid()
  )
  on conflict (artist_id) do update
  set currency = excluded.currency,
      hourly_rate = excluded.hourly_rate,
      full_day_rate = excluded.full_day_rate,
      full_day_hours = excluded.full_day_hours,
      session_deposit_amount = excluded.session_deposit_amount,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by;

  perform crm_private.log_artist_activity(
    p_artist_id,
    'artist.session_pricing_changed',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    null, null, null, null, null,
    jsonb_build_object(
      'previous', v_previous,
      'currency', v_currency,
      'hourly_rate', p_hourly_rate,
      'full_day_rate', p_full_day_rate,
      'full_day_hours', p_full_day_hours,
      'session_deposit_amount', p_session_deposit_amount
    )
  );

  -- The per-session deposit changes how project deposits are attributed, so
  -- current cards are re-evaluated. Card sync never blocks a settings save.
  for v_session_id in
    select s.id
    from public.sessions s
    where s.artist_id = p_artist_id
      and s.appointment_type = 'tattoo_session'::public.appointment_type
      and s.status = 'confirmed'::public.session_status
      and s.start_at > now()
    order by s.start_at, s.id
    limit 200
  loop
    begin
      perform crm_private.sync_booking_card(v_session_id);
    exception when others then
      raise warning 'booking card pricing resync failed, sqlstate=%', sqlstate;
    end;
  end loop;

  return public.get_artist_session_pricing(p_artist_id);
end;
$$;

revoke all on function public.set_artist_session_pricing(uuid, numeric, numeric, numeric, numeric, text)
  from public, anon, authenticated, service_role;
grant execute on function public.set_artist_session_pricing(uuid, numeric, numeric, numeric, numeric, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Deposit attribution: direct allocation first, then project allocation
-- ---------------------------------------------------------------------------

-- A session's own paid deposit (a session-bound request or a deposit-group
-- share). Exactly one is required; two is ambiguous and attributes nothing.
create or replace function crm_private.booking_card_direct_deposits(p_session_id uuid)
returns table (amount numeric, currency text, source_kind text, source_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select r.amount, r.currency, 'session_request'::text, r.id
  from public.payment_requests r
  where r.session_id = p_session_id
    and r.purpose = 'deposit'::public.payment_request_purpose
    and r.status = 'paid'::public.payment_request_status

  union all

  select m.amount, r.currency, 'group_request'::text, g.payment_request_id
  from public.session_deposit_group_members m
  join public.session_deposit_groups g on g.id = m.group_id
  join public.payment_requests r on r.id = g.payment_request_id
  where m.session_id = p_session_id
    and m.released_at is null
    and r.purpose = 'deposit'::public.payment_request_purpose
    and r.status = 'paid'::public.payment_request_status;
$$;

revoke all on function crm_private.booking_card_direct_deposits(uuid)
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
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_direct_count integer;
  v_session record;
  v_project record;
  v_pool numeric;
  v_pool_currency text;
  v_pool_source uuid;
  v_pool_kind text;
  v_ledger_count integer;
  v_ledger_currencies integer;
  v_position integer;
  v_booked integer;
  v_per_session numeric;
  v_per_currency text;
  v_allocated numeric;
begin
  select count(*) into v_direct_count
  from crm_private.booking_card_direct_deposits(p_session_id);

  if v_direct_count = 1 then
    return query
    select d.amount, d.currency, d.source_kind, d.source_id
    from crm_private.booking_card_direct_deposits(p_session_id) d
    where d.amount > 0;
    return;
  elsif v_direct_count > 1 then
    return;
  end if;

  select s.id, s.artist_id, s.project_id, s.appointment_type, s.status
    into v_session
  from public.sessions s
  where s.id = p_session_id;

  if not found
     or v_session.project_id is null
     or v_session.appointment_type <> 'tattoo_session'::public.appointment_type
     or v_session.status <> 'confirmed'::public.session_status then
    return;
  end if;

  select p.id, p.deposit_status, p.deposit_amount, p.currency, p.archived_at
    into v_project
  from public.projects p
  where p.id = v_session.project_id;

  -- Refunded, forfeited, requested or not-required project deposits never
  -- count, whatever the ledger says.
  if not found
     or v_project.archived_at is not null
     or v_project.deposit_status is distinct from 'paid'::public.deposit_status then
    return;
  end if;

  -- Ledger first: paid project-level deposit requests that are neither bound
  -- to one session nor backing a deposit group.
  select sum(r.amount), count(*), count(distinct r.currency), min(r.currency),
         (array_agg(r.id order by r.created_at, r.id))[1]
    into v_pool, v_ledger_count, v_ledger_currencies, v_pool_currency, v_pool_source
  from public.payment_requests r
  where r.project_id = v_project.id
    and r.session_id is null
    and r.purpose = 'deposit'::public.payment_request_purpose
    and r.status = 'paid'::public.payment_request_status
    and not exists (
      select 1 from public.session_deposit_groups g where g.payment_request_id = r.id
    );

  if v_ledger_count > 0 then
    if v_ledger_currencies <> 1 then
      return;
    end if;
    v_pool_kind := 'project_request';
  else
    -- Legacy projects: the CRM project state (deposit marked paid with an
    -- amount) is the only record of the payment. Money already recorded in
    -- the ledger as a session or group deposit of this project is the same
    -- deposit, so it is not attributed twice.
    if v_project.deposit_amount is null or v_project.deposit_amount <= 0 then
      return;
    end if;
    v_pool := v_project.deposit_amount - coalesce((
      select sum(r.amount)
      from public.payment_requests r
      where r.project_id = v_project.id
        and r.purpose = 'deposit'::public.payment_request_purpose
        and r.status = 'paid'::public.payment_request_status
        and r.currency = v_project.currency
    ), 0);
    v_pool_currency := v_project.currency;
    v_pool_source := v_project.id;
    v_pool_kind := 'project_status';
  end if;

  if v_pool is null or v_pool <= 0 then
    return;
  end if;

  -- Booked tattoo sessions of the project that consume the project deposit,
  -- in start order. Sessions with their own direct deposit are paid for
  -- separately and do not consume it.
  select o.position, o.booked
    into v_position, v_booked
  from (
    select s.id,
           row_number() over (order by s.start_at, s.id)::integer as position,
           count(*) over ()::integer as booked
    from public.sessions s
    where s.project_id = v_project.id
      and s.appointment_type = 'tattoo_session'::public.appointment_type
      and s.status in (
        'confirmed'::public.session_status,
        'completed'::public.session_status,
        'no_show'::public.session_status
      )
      and not exists (
        select 1 from crm_private.booking_card_direct_deposits(s.id)
      )
  ) o
  where o.id = p_session_id;

  if not found then
    return;
  end if;

  select sp.session_deposit_amount, sp.currency
    into v_per_session, v_per_currency
  from crm_private.artist_session_pricing sp
  where sp.artist_id = v_session.artist_id;

  if v_per_session is not null and v_per_currency = v_pool_currency then
    v_allocated := least(v_per_session, v_pool - v_per_session * (v_position - 1));
  elsif v_booked = 1 then
    v_allocated := v_pool;
  else
    return;
  end if;

  if v_allocated is null or v_allocated <= 0 then
    return;
  end if;

  return query select v_allocated, v_pool_currency, v_pool_kind, v_pool_source;
end;
$$;

revoke all on function crm_private.booking_card_deposit_for_session(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. One eligibility decision, with a reason
-- ---------------------------------------------------------------------------

create or replace function crm_private.booking_card_eligibility(p_session_id uuid)
returns table (
  eligible boolean,
  reason text,
  card_kind text,
  session_price numeric,
  deposit_paid numeric,
  remaining_balance numeric,
  currency text,
  deposit_source text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_session record;
  v_deposit numeric;
  v_deposit_currency text;
  v_deposit_source text;
begin
  select s.appointment_type, s.status, s.start_at, s.price, s.currency,
         a.is_active as artist_active, a.timezone, c.archived_at as client_archived_at
    into v_session
  from public.sessions s
  join public.artists a on a.id = s.artist_id
  join public.clients c on c.id = s.client_id
  where s.id = p_session_id;

  if not found then
    return query select false, 'session_not_found', null::text, null::numeric,
      null::numeric, null::numeric, null::text, null::text;
    return;
  end if;

  currency := v_session.currency;
  eligible := false;

  if not v_session.artist_active then
    reason := 'artist_inactive';
  elsif v_session.client_archived_at is not null then
    reason := 'client_archived';
  elsif v_session.status <> 'confirmed'::public.session_status then
    reason := 'not_confirmed';
  elsif v_session.start_at <= clock_timestamp() then
    reason := 'appointment_in_past';
  elsif nullif(btrim(coalesce(v_session.timezone, '')), '') is null then
    reason := 'artist_timezone_missing';
  elsif v_session.appointment_type = 'in_person_consultation'::public.appointment_type then
    eligible := true;
    reason := 'ready';
    card_kind := 'consultation_booked';
  elsif v_session.appointment_type <> 'tattoo_session'::public.appointment_type then
    reason := 'appointment_type_without_card';
  elsif v_session.price is null or v_session.price <= 0 then
    reason := 'session_price_missing';
  else
    session_price := v_session.price;

    select d.amount, d.currency, d.source_kind
      into v_deposit, v_deposit_currency, v_deposit_source
    from crm_private.booking_card_deposit_for_session(p_session_id) d;

    if not found or v_deposit is null or v_deposit <= 0 then
      reason := 'deposit_not_paid_for_session';
    elsif v_deposit_currency is distinct from v_session.currency then
      reason := 'deposit_currency_mismatch';
    elsif v_deposit > v_session.price then
      reason := 'deposit_exceeds_price';
      deposit_paid := v_deposit;
    else
      eligible := true;
      reason := 'ready';
      card_kind := 'tattoo_deposit_paid';
      deposit_paid := v_deposit;
      remaining_balance := v_session.price - v_deposit;
      deposit_source := v_deposit_source;
    end if;
  end if;

  return next;
end;
$$;

revoke all on function crm_private.booking_card_eligibility(uuid)
  from public, anon, authenticated, service_role;

-- Facts can legitimately return to an earlier state (a price changed and
-- changed back). Idempotency is already guaranteed against the current card
-- under the per-session advisory lock, so a hash may repeat across
-- superseded revisions.
alter table crm_private.booking_cards
  drop constraint if exists booking_cards_session_id_card_kind_fact_hash_key;

create or replace function crm_private.sync_booking_card(
  p_session_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private, extensions
as $$
declare
  v_facts record;
  v_session record;
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

  select * into v_facts
  from crm_private.booking_card_eligibility(p_session_id);

  if not found or not v_facts.eligible then
    update crm_private.booking_cards
    set superseded_at = coalesce(superseded_at, now())
    where session_id = p_session_id
      and superseded_at is null;
    return null;
  end if;

  select s.artist_id, a.workspace_id, s.client_id, s.enquiry_id, s.project_id,
         s.appointment_type, s.start_at, s.end_at, s.calendar_version, a.timezone
    into v_session
  from public.sessions s
  join public.artists a on a.id = s.artist_id
  where s.id = p_session_id;

  -- Another card kind for the same session (for example a type change) is no
  -- longer current.
  update crm_private.booking_cards
  set superseded_at = coalesce(superseded_at, now())
  where session_id = p_session_id
    and card_kind <> v_facts.card_kind
    and superseded_at is null;

  v_fact_hash := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'session_id', p_session_id,
          'artist_id', v_session.artist_id,
          'client_id', v_session.client_id,
          'card_kind', v_facts.card_kind,
          'calendar_version', v_session.calendar_version,
          'start_at', v_session.start_at,
          'end_at', v_session.end_at,
          'timezone', v_session.timezone,
          'currency', v_facts.currency,
          'session_price', v_facts.session_price,
          'deposit_paid', v_facts.deposit_paid,
          'remaining_balance', v_facts.remaining_balance
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
    and b.card_kind = v_facts.card_kind
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
    and b.card_kind = v_facts.card_kind;

  insert into crm_private.booking_cards (
    session_id, artist_id, workspace_id, client_id, enquiry_id, project_id,
    card_kind, appointment_type, calendar_version, revision, start_at, end_at,
    timezone, currency, session_price, deposit_paid, remaining_balance, fact_hash
  ) values (
    p_session_id, v_session.artist_id, v_session.workspace_id, v_session.client_id,
    v_session.enquiry_id, v_session.project_id, v_facts.card_kind,
    v_session.appointment_type, v_session.calendar_version, v_revision,
    v_session.start_at, v_session.end_at, v_session.timezone, v_facts.currency,
    v_facts.session_price, v_facts.deposit_paid, v_facts.remaining_balance,
    v_fact_hash
  )
  returning id into v_card_id;

  return v_card_id;
end;
$$;

revoke all on function crm_private.sync_booking_card(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Re-evaluation triggers: sibling sessions and project deposit state
-- ---------------------------------------------------------------------------

create or replace function crm_private.sync_project_booking_cards(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_session_id uuid;
begin
  if p_project_id is null then
    return;
  end if;
  for v_session_id in
    select s.id
    from public.sessions s
    where s.project_id = p_project_id
      and s.appointment_type = 'tattoo_session'::public.appointment_type
      and s.start_at > now()
    order by s.start_at, s.id
    limit 50
  loop
    perform crm_private.sync_booking_card(v_session_id);
  end loop;
end;
$$;

revoke all on function crm_private.sync_project_booking_cards(uuid)
  from public, anon, authenticated, service_role;

create or replace function crm_private.refresh_booking_card_from_session()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  begin
    perform crm_private.sync_booking_card(new.id);
    -- Project deposit attribution depends on which sibling sessions are
    -- booked and in what order.
    perform crm_private.sync_project_booking_cards(new.project_id);
    if tg_op = 'UPDATE' and old.project_id is distinct from new.project_id then
      perform crm_private.sync_project_booking_cards(old.project_id);
    end if;
  exception when others then
    raise warning 'booking card session sync failed, sqlstate=%', sqlstate;
  end;
  return new;
end;
$$;

drop trigger if exists sessions_refresh_booking_card on public.sessions;
create trigger sessions_refresh_booking_card
after insert or update of
  status, start_at, end_at, calendar_version, price, appointment_type, project_id, currency
on public.sessions
for each row execute function crm_private.refresh_booking_card_from_session();

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

    if new.session_id is null and new.project_id is not null then
      perform crm_private.sync_project_booking_cards(new.project_id);
    end if;
  exception when others then
    raise warning 'booking card payment sync failed, sqlstate=%', sqlstate;
  end;
  return new;
end;
$$;

create or replace function crm_private.refresh_booking_card_from_project()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  begin
    perform crm_private.sync_project_booking_cards(new.id);
  exception when others then
    raise warning 'booking card project sync failed, sqlstate=%', sqlstate;
  end;
  return new;
end;
$$;

drop trigger if exists projects_refresh_booking_card on public.projects;
create trigger projects_refresh_booking_card
after update of deposit_status, deposit_amount, currency, archived_at
on public.projects
for each row
when (
  old.deposit_status is distinct from new.deposit_status
  or old.deposit_amount is distinct from new.deposit_amount
  or old.currency is distinct from new.currency
  or old.archived_at is distinct from new.archived_at
)
execute function crm_private.refresh_booking_card_from_project();

revoke all on function crm_private.refresh_booking_card_from_session()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.refresh_booking_card_from_payment()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.refresh_booking_card_from_project()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Short send delay so combined edits collapse into one message
-- ---------------------------------------------------------------------------

-- Supersession already cancels a queued card message before a worker claims
-- it. Holding card messages for two minutes means "move the time, then set
-- the price" sends only the final revision.
create or replace function crm_private.delay_booking_card_outbox()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.dedupe_key like 'email:booking_card:%'
     or new.dedupe_key like 'whatsapp:booking_card:%' then
    new.next_attempt_at := greatest(coalesce(new.next_attempt_at, now()), now() + interval '2 minutes');
  end if;
  return new;
end;
$$;

revoke all on function crm_private.delay_booking_card_outbox()
  from public, anon, authenticated, service_role;

drop trigger if exists integration_outbox_delay_booking_card on public.integration_outbox;
create trigger integration_outbox_delay_booking_card
before insert on public.integration_outbox
for each row
when (new.dedupe_key like '%:booking_card:%')
execute function crm_private.delay_booking_card_outbox();

-- ---------------------------------------------------------------------------
-- 6. Money with thousands separators (£1,500, £980, £62.50)
-- ---------------------------------------------------------------------------

create or replace function crm_private.booking_card_money(
  p_amount numeric,
  p_currency text
)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when p_amount is null then null
    when upper(p_currency) = 'GBP'
      then '£' || regexp_replace(to_char(p_amount, 'FM999,999,990.00'), '\.00$', '')
    else regexp_replace(to_char(p_amount, 'FM999,999,990.00'), '\.00$', '')
      || ' ' || upper(p_currency)
  end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Read-only CRM status: will a card go out, and if not, why
-- ---------------------------------------------------------------------------

create or replace function public.get_session_booking_card_status(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_start_at timestamptz;
  v_finance boolean;
  v_facts record;
  v_settings crm_private.booking_card_artist_settings%rowtype;
  v_card crm_private.booking_cards%rowtype;
  v_deliveries jsonb;
  v_channels_on boolean;
  v_in_window boolean;
begin
  if p_session_id is null then
    raise exception 'a session id is required' using errcode = '22023';
  end if;

  select s.artist_id, s.start_at into v_artist_id, v_start_at
  from public.sessions s
  where s.id = p_session_id;

  if not found then
    raise exception 'appointment does not exist' using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_artist_id, 'view_sessions');
  v_finance := public.can_view_artist_finance(v_artist_id);

  select * into v_facts from crm_private.booking_card_eligibility(p_session_id);

  select * into v_settings
  from crm_private.booking_card_artist_settings bs
  where bs.artist_id = v_artist_id;

  v_channels_on := found and (v_settings.email_enabled or v_settings.whatsapp_enabled);
  v_in_window := v_settings.appointment_start_from is null
    or v_start_at >= v_settings.appointment_start_from;

  select * into v_card
  from crm_private.booking_cards b
  where b.session_id = p_session_id
    and b.superseded_at is null
  order by b.created_at desc
  limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
      'channel', d.channel,
      'status', d.status,
      'skip_reason', d.skip_reason,
      'queued_at', d.queued_at,
      'sent_at', d.sent_at,
      'failed_at', d.failed_at
    ) order by d.channel), '[]'::jsonb)
    into v_deliveries
  from crm_private.booking_card_deliveries d
  where v_card.id is not null
    and d.booking_card_id = v_card.id;

  return jsonb_build_object(
    'session_id', p_session_id,
    'eligible', coalesce(v_facts.eligible, false),
    'reason', v_facts.reason,
    'card_kind', v_facts.card_kind,
    'currency', v_facts.currency,
    'session_price', case when v_finance then v_facts.session_price end,
    'deposit_paid', case when v_finance then v_facts.deposit_paid end,
    'remaining_balance', case when v_finance then v_facts.remaining_balance end,
    'deposit_source', case when v_finance then v_facts.deposit_source end,
    'email_enabled', coalesce(v_settings.email_enabled, false),
    'whatsapp_enabled', coalesce(v_settings.whatsapp_enabled, false),
    'channels_enabled', coalesce(v_channels_on, false),
    'in_rollout_window', coalesce(v_in_window, false),
    'rollout_starts_at', v_settings.appointment_start_from,
    'card', case when v_card.id is null then null else jsonb_build_object(
      'revision', v_card.revision,
      'created_at', v_card.created_at,
      'card_kind', v_card.card_kind
    ) end,
    'deliveries', v_deliveries
  );
end;
$$;

revoke all on function public.get_session_booking_card_status(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_session_booking_card_status(uuid) to authenticated;
