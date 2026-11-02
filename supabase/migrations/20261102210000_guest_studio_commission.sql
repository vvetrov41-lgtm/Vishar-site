-- Optional per-session guest studio terms, separate from permanent home-studio fee rules.
-- No customer/production data is seeded by this schema migration.
create table crm_private.session_studio_fee_overrides (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  fee_percent numeric(6,3) not null check (fee_percent between 0 and 100),
  basis text not null default 'guest_studio' check (basis = 'guest_studio'),
  note text not null check (char_length(btrim(note)) between 1 and 500),
  recorded_at timestamptz not null default now()
);
alter table crm_private.session_studio_fee_overrides enable row level security;
revoke all on table crm_private.session_studio_fee_overrides from public, anon, authenticated, service_role;

-- Explicit guest rate takes precedence over the ordinary capped commission.
-- One-argument helper remains unchanged for its existing consumers.
create or replace function crm_private.studio_fee_for_price(
  p_price numeric, p_percent_override numeric
)
returns numeric language sql immutable
set search_path = pg_catalog, crm_private
as $fee$
  select case
    when p_price is null or p_price < 0 then null
    when p_percent_override is not null and (p_percent_override < 0 or p_percent_override > 100) then null
    when p_percent_override is not null then round(p_price * p_percent_override / 100, 2)
    else crm_private.studio_fee_for_price(p_price)
  end;
$fee$;
revoke all on function crm_private.studio_fee_for_price(numeric,numeric)
  from public, anon, authenticated, service_role;

-- Keep both public.get_statistics and public.gpt_get_statistics on this one core.
-- Private overrides are joined only after the artist and analytics scope filter.
create or replace function crm_private.statistics_studio_share(
  p_artist_id uuid, p_from timestamptz, p_to timestamptz
)
returns jsonb language sql stable security invoker
set search_path = pg_catalog, public, crm_private
as $share$
  with paid_sessions as (
    select s.price, upper(coalesce(s.currency, 'GBP')) as currency, o.fee_percent
    from public.sessions s
    join public.statistics_sessions projected on projected.id = s.id
    left join crm_private.session_studio_fee_overrides o on o.session_id = s.id
    where s.artist_id = p_artist_id
      and s.status::text = 'completed'
      and s.payment_status::text = 'paid'
      and s.appointment_type::text in ('tattoo_session', 'touch_up')
      and s.start_at >= p_from and s.start_at < p_to
  ),
  amounts as (
    select
      count(*) filter (where price is not null and price >= 0 and currency = 'GBP')::int as sessions,
      count(*) filter (where price is null or price < 0 or currency <> 'GBP')::int as incomplete_sessions,
      coalesce(sum(price) filter (where price is not null and price >= 0 and currency = 'GBP'), 0)::numeric as gross,
      coalesce(sum(crm_private.studio_fee_for_price(price, fee_percent)) filter
        (where price is not null and price >= 0 and currency = 'GBP'), 0)::numeric as studio_fee
    from paid_sessions
  ),
  unpaid as (
    select count(*)::int as sessions
    from public.sessions s
    join public.statistics_sessions projected on projected.id = s.id
    where s.artist_id = p_artist_id
      and s.status::text = 'completed'
      and s.payment_status::text <> 'paid'
      and s.appointment_type::text in ('tattoo_session', 'touch_up')
      and s.start_at >= p_from and s.start_at < p_to
  )
  select jsonb_build_object(
    'currency', 'GBP',
    'gross', a.gross,
    'studio_fee', a.studio_fee,
    'artist_net', a.gross - a.studio_fee,
    'effective_percent', case when a.gross > 0 then round(a.studio_fee * 100 / a.gross, 2) else null end,
    'sessions', a.sessions,
    'incomplete_sessions', a.incomplete_sessions,
    'unpaid_sessions', u.sessions
  )
  from amounts a cross join unpaid u;
$share$;


-- Old and new helpers remain private; statistics_core's existing permission
-- boundary is unchanged.
revoke all on function crm_private.statistics_studio_share(uuid,timestamptz,timestamptz)
  from public, anon, authenticated, service_role;
