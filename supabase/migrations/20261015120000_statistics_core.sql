-- Statistics 2.0, stage S2-1: one server-side definition of every Statistics
-- figure (specs/statistics-2).
--
-- Until now the CRM screen computed Statistics in the browser from paged raw
-- rows, and gpt_get_statistics answered the same questions with different
-- rules. This migration adds:
--
-- * crm_private.enquiry_channel      - the technical acquisition channel;
-- * crm_private.statistics_core      - every figure for one artist and window;
-- * public.get_statistics            - the authorized entry point for the CRM.
--
-- The definitions are the corrected ones from PR #1095 (2026-10-15 audit):
-- tattoo work and consultations are never added together; conversion means a
-- tattoo booking that stands, over enquiries at least 14 days old; a returning
-- client has two different tattoo projects; money received, refunded, still
-- owed and forecast are never added together. Response time reuses
-- crm_private.enquiry_reply_state, the same evidence Today's pulse reads, so
-- the two screens cannot disagree about who has been answered.
--
-- Nothing here writes. No table, policy or existing function changes.
--
-- Security:
-- * statistics_core is private (no grant to any browser or service role);
-- * get_statistics checks crm_private.has_artist_capability(artist, 'view')
--   for every artist it answers for, before any read, and asks for finance
--   only where the caller holds 'view_finance'. has_artist_capability itself
--   requires an active profile, an active membership and MFA;
-- * an artist id the caller may not view is an error, never an empty answer
--   that could be mistaken for "no business";
-- * only aggregates leave: no client, enquiry or session identifiers.

-- ---------------------------------------------------------------------------
-- 1. Channel
-- ---------------------------------------------------------------------------

create or replace function crm_private.statistics_host(p_referrer text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select nullif(
    regexp_replace(
      lower(substring(coalesce(p_referrer, '') from '^[A-Za-z][A-Za-z0-9+.-]*://([^/:?#@]+)')),
      '^www\.', ''),
    '');
$$;

-- Mirrors channelFor() in admin/src/lib/statistics.ts (PR #1095). The browser
-- copy is retired by stage S2-3; until then both are pinned by tests.
create or replace function crm_private.enquiry_channel(
  p_communication_channel text,
  p_source text,
  p_utm_source text,
  p_utm_medium text,
  p_referrer text,
  p_own_hosts text[]
)
returns table (key text, kind text, value text)
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_conversation text := nullif(btrim(coalesce(p_communication_channel, '')), '');
  v_source text := nullif(btrim(coalesce(p_source, '')), '');
  v_utm_source text := nullif(lower(btrim(coalesce(p_utm_source, ''))), '');
  v_medium text := nullif(lower(btrim(coalesce(p_utm_medium, ''))), '');
  v_host text := crm_private.statistics_host(p_referrer);
  v_platform text;
begin
  if v_conversation is not null then
    return query select 'conversation:' || v_conversation, 'conversation', v_conversation;
    return;
  end if;
  if v_source = 'crm_manual' then
    return query select 'manual'::text, 'manual'::text, null::text;
    return;
  end if;

  v_platform := case v_utm_source
    when 'fb' then 'facebook' when 'facebook' then 'facebook'
    when 'ig' then 'instagram' when 'instagram' then 'instagram'
    when 'meta' then 'meta'
    when 'google' then 'google' when 'adwords' then 'google' when 'googleads' then 'google'
    when 'tiktok' then 'tiktok'
    when 'chatgpt' then 'chatgpt' when 'chatgpt.com' then 'chatgpt'
    else v_utm_source
  end;

  if v_medium in ('paid', 'cpc', 'ppc', 'cpm', 'cpv', 'paidsocial', 'paid_social', 'paid-social',
                  'paid_search', 'paid-search', 'paidsearch', 'ads', 'ad', 'display', 'sponsored') then
    v_platform := case
      when v_platform is null then 'other'
      when v_platform in ('instagram', 'facebook') then 'meta'
      else v_platform
    end;
    return query select 'paid:' || v_platform, 'paid', v_platform;
    return;
  end if;
  if v_platform is not null then
    return query select 'campaign:' || v_platform, 'campaign', v_platform;
    return;
  end if;

  if v_host is null then
    return query select 'direct'::text, 'direct'::text, null::text;
    return;
  end if;
  -- The studio's own sites come from the booking source registry
  -- (allowed_origin), never from a list written into this function.
  if exists (select 1 from unnest(coalesce(p_own_hosts, '{}')) own
             where own is not null and (v_host = own or v_host like '%.' || own)) then
    return query select 'internal'::text, 'internal'::text, null::text;
  elsif v_host = 'instagram.com' or v_host like '%.instagram.com' then
    return query select 'social:instagram'::text, 'social'::text, 'instagram'::text;
  elsif v_host = 'facebook.com' or v_host like '%.facebook.com' or v_host in ('fb.com', 'fb.me') then
    return query select 'social:facebook'::text, 'social'::text, 'facebook'::text;
  elsif v_host = 'tiktok.com' or v_host like '%.tiktok.com' then
    return query select 'social:tiktok'::text, 'social'::text, 'tiktok'::text;
  elsif v_host = 'pinterest.com' or v_host like '%.pinterest.com' then
    return query select 'social:pinterest'::text, 'social'::text, 'pinterest'::text;
  elsif v_host = 'chatgpt.com' or v_host like '%.chatgpt.com' or v_host = 'openai.com' or v_host like '%.openai.com' then
    return query select 'ai:chatgpt'::text, 'ai'::text, 'chatgpt'::text;
  elsif v_host = 'perplexity.ai' or v_host like '%.perplexity.ai' then
    return query select 'ai:perplexity'::text, 'ai'::text, 'perplexity'::text;
  elsif v_host = 'claude.ai' or v_host like '%.claude.ai' then
    return query select 'ai:claude'::text, 'ai'::text, 'claude'::text;
  elsif v_host = 'gemini.google.com' then
    return query select 'ai:gemini'::text, 'ai'::text, 'gemini'::text;
  elsif v_host = 'copilot.microsoft.com' or v_host like '%.copilot.microsoft.com' then
    return query select 'ai:copilot'::text, 'ai'::text, 'copilot'::text;
  elsif v_host ~ '(^|\.)google\.[a-z.]+$' then
    return query select 'search:google'::text, 'search'::text, 'google'::text;
  elsif v_host = 'bing.com' or v_host like '%.bing.com' then
    return query select 'search:bing'::text, 'search'::text, 'bing'::text;
  elsif v_host = 'duckduckgo.com' or v_host like '%.duckduckgo.com' then
    return query select 'search:duckduckgo'::text, 'search'::text, 'duckduckgo'::text;
  else
    return query select 'referral:' || v_host, 'referral'::text, v_host;
  end if;
end;
$$;

revoke all on function crm_private.statistics_host(text) from public, anon, authenticated, service_role;
revoke all on function crm_private.enquiry_channel(text, text, text, text, text, text[])
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Core
-- ---------------------------------------------------------------------------

create or replace function crm_private.statistics_core(
  p_artist_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_now timestamptz,
  p_finance boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_maturity_cutoff timestamptz := p_now - interval '14 days';
  v_timezone text;
  v_week0 timestamptz;
  v_result jsonb;
  v_finance jsonb := null;
  v_own_hosts text[];
begin
  select coalesce(array_agg(distinct crm_private.statistics_host(b.allowed_origin)), '{}')
    into v_own_hosts
  from public.booking_sources b
  where b.allowed_origin is not null;

  select coalesce(a.timezone, 'Europe/London') into v_timezone
  from public.artists a where a.id = p_artist_id;
  -- Weeks start on the artist's local Monday.
  v_week0 := (date_trunc('week', p_now at time zone v_timezone)) at time zone v_timezone;

  with
  enq as (
    select e.id, e.client_id, e.created_at,
           ch.key as channel_key, ch.kind as channel_kind, ch.value as channel_value
    from public.enquiries e
    cross join lateral crm_private.enquiry_channel(
      e.communication_channel::text, e.source, e.utm_source, e.utm_medium, e.referrer, v_own_hosts) ch
    where e.artist_id = p_artist_id
      and e.excluded_from_analytics = false
      and e.archived_at is null
      and e.intake_state = 'complete'
  ),
  cohort as (
    select * from enq where created_at >= p_from and created_at < p_to
  ),
  proj as (
    select p.id, p.enquiry_id, p.created_at
    from public.statistics_projects p
    where p.artist_id = p_artist_id
  ),
  sess as (
    select s.*,
           coalesce(s.enquiry_id, pr.enquiry_id) as lineage_enquiry_id,
           s.appointment_type::text in ('tattoo_session', 'touch_up') as is_work,
           s.appointment_type::text in ('in_person_consultation', 'video_consultation') as is_consultation,
           -- When the booking was made: the first time the session left
           -- draft, where the activity log recorded it, else the row's
           -- creation. A draft confirmed weeks later is that later day's
           -- booking, not the day the draft was typed (review on #1095).
           coalesce((
             select min(l.occurred_at) from public.activity_log l
             where l.session_id = s.id
               and l.event_type = 'appointment.status_changed'
               and l.metadata ->> 'from_status' = 'draft'
               and coalesce(l.metadata ->> 'to_status', '') <> 'draft'
           ), s.created_at) as booked_at,
           case
             when s.duration_hours is not null then greatest(s.duration_hours, 0)
             when s.end_at > s.start_at then extract(epoch from s.end_at - s.start_at) / 3600
             else 0
           end as hours
    from public.statistics_sessions s
    left join proj pr on pr.id = s.project_id
    where s.artist_id = p_artist_id
  ),
  booked_ids as (
    select distinct lineage_enquiry_id as id from sess
    where is_work and status::text not in ('draft', 'cancelled') and lineage_enquiry_id is not null
  ),
  consulted_ids as (
    select distinct lineage_enquiry_id as id from sess
    where is_consultation and status::text not in ('draft', 'cancelled') and lineage_enquiry_id is not null
  ),
  done_ids as (
    select distinct lineage_enquiry_id as id from sess
    where is_work and status::text = 'completed' and lineage_enquiry_id is not null
  ),
  cohort_flags as (
    select c.*,
           c.created_at <= v_maturity_cutoff as mature,
           exists (select 1 from booked_ids b where b.id = c.id) as booked,
           exists (select 1 from consulted_ids b where b.id = c.id) as consulted,
           exists (select 1 from done_ids b where b.id = c.id) as done
    from cohort c
  ),
  first_booking as (
    select lineage_enquiry_id as id, min(booked_at) as at from sess
    where is_work and status::text not in ('draft', 'cancelled') and lineage_enquiry_id is not null
    group by 1
  ),
  reply as (
    select c.id, c.created_at, st.answered, st.first_reply_at
    from cohort c
    cross join lateral crm_private.enquiry_reply_state(c.id, p_now) st
  ),
  in_window as (
    select * from sess
    where status::text <> 'draft' and start_at >= p_from and start_at < p_to
  ),
  live_work as (
    select * from sess where is_work and status::text in ('proposed', 'confirmed', 'completed')
  ),
  active_clients as (
    select distinct client_id from live_work where start_at >= p_from and start_at < p_to
  ),
  ahead as (
    select * from sess
    where status::text in ('proposed', 'confirmed') and start_at >= p_now
  ),
  weeks as (
    select g as week_index, v_week0 + make_interval(days => 7 * g) as week_start
    from generate_series(0, 11) g
  )
  select jsonb_build_object(
    'enquiries', (select count(*) from cohort),
    -- What the client said in the form, raw; the browser maps legacy aliases
    -- through config/discovery-sources.json for labels only.
    'discovery', coalesce((
      select jsonb_object_agg(src, n) from (
        select coalesce(nullif(btrim(e.discovery_source), ''), 'not_recorded') as src, count(*) as n
        from public.enquiries e
        where e.artist_id = p_artist_id and e.excluded_from_analytics = false
          and e.archived_at is null and e.intake_state = 'complete'
          and e.created_at >= p_from and e.created_at < p_to
        group by 1) d), '{}'::jsonb),
    'unique_clients', (select count(distinct client_id) from cohort),
    'bookings_made', jsonb_build_object(
      'tattoo', (select count(*) from sess where is_work and status::text <> 'draft'
                   and booked_at >= p_from and booked_at < p_to),
      'tattoo_cancelled', (select count(*) from sess where is_work and status::text = 'cancelled'
                   and booked_at >= p_from and booked_at < p_to),
      'consultations', (select count(*) from sess where is_consultation and status::text <> 'draft'
                   and booked_at >= p_from and booked_at < p_to)
    ),
    'conversion', jsonb_build_object(
      'cohort', (select count(*) from cohort_flags),
      'mature', (select count(*) from cohort_flags where mature),
      'converted', (select count(*) from cohort_flags where mature and booked),
      'pending', (select count(*) from cohort_flags where not mature),
      'pending_converted', (select count(*) from cohort_flags where not mature and booked),
      'median_days_to_booking', (
        select round((percentile_cont(0.5) within group (
          order by extract(epoch from fb.at - c.created_at) / 86400))::numeric, 1)
        from cohort c join first_booking fb on fb.id = c.id and fb.at >= c.created_at)
    ),
    'funnel', jsonb_build_object(
      'enquiries', (select count(*) from cohort_flags),
      'answered', (select count(*) from reply where answered),
      'consultations', (select count(*) from cohort_flags where consulted),
      'booked', (select count(*) from cohort_flags where booked),
      'completed', (select count(*) from cohort_flags where done)
    ),
    'reply', jsonb_build_object(
      'median_first_reply_hours', (
        select round((percentile_cont(0.5) within group (
          order by extract(epoch from r.first_reply_at - r.created_at)) / 3600)::numeric, 1)
        from reply r where r.first_reply_at is not null),
      'timed', (select count(*) from reply where first_reply_at is not null),
      'answered_without_time', (select count(*) from reply where answered and first_reply_at is null),
      'unanswered', (select count(*) from reply where not answered)
    ),
    'channels', coalesce((
      select jsonb_agg(row_to_json(c) order by c.enquiries desc, c.key)
      from (
        select channel_key as key, channel_kind as kind, channel_value as value,
               count(*) as enquiries,
               count(*) filter (where consulted) as consulted,
               count(*) filter (where booked) as booked,
               count(*) filter (where mature) as matured,
               count(*) filter (where mature and booked) as matured_booked
        from cohort_flags
        group by 1, 2, 3
      ) c), '[]'::jsonb),
    'sessions', jsonb_build_object(
      'booked', (select count(*) from in_window where is_work),
      'completed', (select count(*) from in_window where is_work and status::text = 'completed'),
      'planned', (select count(*) from in_window where is_work and status::text in ('proposed', 'confirmed')),
      'cancelled', (select count(*) from in_window where is_work and status::text = 'cancelled'),
      'no_show', (select count(*) from in_window where is_work and status::text = 'no_show'),
      'hours', (select round(coalesce(sum(hours), 0)::numeric, 2) from in_window
                where is_work and status::text = 'completed'),
      'consultations_held', (select count(*) from in_window where is_consultation and status::text <> 'cancelled'),
      'consultations_cancelled', (select count(*) from in_window where is_consultation and status::text = 'cancelled')
    ),
    'returning_clients', jsonb_build_object(
      'active', (select count(*) from active_clients),
      'returning', (
        select count(*) from active_clients ac
        where (select count(distinct lw.project_id) from live_work lw
               where lw.client_id = ac.client_id and lw.project_id is not null) >= 2)
    ),
    'upcoming', jsonb_build_object(
      'weeks', (
        select jsonb_agg(jsonb_build_object(
          'week_start', to_char(w.week_start at time zone v_timezone, 'YYYY-MM-DD'),
          'tattoo_sessions', (select count(*) from ahead a where a.is_work
                              and a.start_at >= w.week_start and a.start_at < w.week_start + interval '7 days'),
          'tattoo_hours', (select round(coalesce(sum(a.hours), 0)::numeric, 2) from ahead a where a.is_work
                              and a.start_at >= w.week_start and a.start_at < w.week_start + interval '7 days'),
          'consultations', (select count(*) from ahead a where a.is_consultation
                              and a.start_at >= w.week_start and a.start_at < w.week_start + interval '7 days')
        ) order by w.week_index)
        from weeks w),
      'tattoo_sessions_later', (select count(*) from ahead where is_work
                                and start_at >= v_week0 + interval '84 days')
    ),
    'history_start', (select min(created_at) from enq)
  )
  into v_result;

  if p_finance then
    with
    txn as (
      select t.* from public.statistics_payment_transactions t
      where t.artist_id = p_artist_id and t.status::text = 'succeeded'
        and t.occurred_at >= p_from and t.occurred_at < p_to
    ),
    open_req as (
      select r.* from public.statistics_payment_requests r
      where r.artist_id = p_artist_id and r.status::text = 'pending'
        and (r.expires_at is null or r.expires_at > p_now)
    ),
    future_work as (
      select s.id, s.price, upper(coalesce(s.currency, 'GBP')) as currency
      from public.sessions s
      join public.statistics_sessions v on v.id = s.id
      where s.artist_id = p_artist_id
        and s.appointment_type::text in ('tattoo_session', 'touch_up')
        and s.status::text = 'confirmed'
        and s.start_at >= p_now
    ),
    forecast as (
      select f.currency, f.price,
             coalesce((select sum(d.amount) from crm_private.booking_card_deposit_for_session(f.id) d
                       where upper(d.currency) = f.currency), 0) as deposit
      from future_work f
      where f.price is not null
    )
    select jsonb_build_object(
      'received', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'amount', amount, 'count', n) order by currency)
        from (select upper(currency) as currency, sum(amount) as amount, count(*) as n from txn
              where direction::text = 'credit' and transaction_type::text not in ('refund', 'partial_refund')
              group by 1) x), '[]'::jsonb),
      'refunded', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'amount', amount, 'count', n) order by currency)
        from (select upper(currency) as currency, sum(amount) as amount, count(*) as n from txn
              where direction::text = 'debit' or transaction_type::text in ('refund', 'partial_refund')
              group by 1) x), '[]'::jsonb),
      'open', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'amount', amount, 'count', n) order by currency)
        from (select upper(currency) as currency, sum(amount) as amount, count(*) as n from open_req group by 1) x), '[]'::jsonb),
      'partially_paid', (select count(*) from public.statistics_payment_requests r
                         where r.artist_id = p_artist_id and r.status::text = 'partially_paid'
                           and (r.expires_at is null or r.expires_at > p_now)),
      'forecast', jsonb_build_object(
        'confirmed_sessions', (select count(*) from future_work),
        'priced_sessions', (select count(*) from future_work where price is not null),
        'booked_value', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'amount', amount) order by currency)
          from (select currency, sum(price) as amount from forecast group by 1) x), '[]'::jsonb),
        'remaining_after_deposits', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'amount', amount) order by currency)
          from (select currency, sum(greatest(price - deposit, 0)) as amount from forecast group by 1) x), '[]'::jsonb)
      ),
      'deposits_paid_by_channel', coalesce((
        select jsonb_object_agg(channel_key, n) from (
          select e.channel_key, count(distinct e.id) as n
          from (
            select ee.id, ch.key as channel_key
            from public.enquiries ee
            cross join lateral crm_private.enquiry_channel(
              ee.communication_channel::text, ee.source, ee.utm_source, ee.utm_medium, ee.referrer, v_own_hosts) ch
            where ee.artist_id = p_artist_id and ee.excluded_from_analytics = false
              and ee.archived_at is null and ee.intake_state = 'complete'
              and ee.created_at >= p_from and ee.created_at < p_to
          ) e
          join public.statistics_projects p on p.enquiry_id = e.id
          join public.statistics_payment_requests r on r.project_id = p.id
          where r.purpose::text = 'deposit' and r.status::text = 'paid'
          group by 1) x), '{}'::jsonb)
    ) into v_finance;
  end if;

  return v_result || jsonb_build_object('finance', v_finance);
end;
$$;

revoke all on function crm_private.statistics_core(uuid, timestamptz, timestamptz, timestamptz, boolean)
  from public, anon, authenticated, service_role;

comment on function crm_private.statistics_core(uuid, timestamptz, timestamptz, timestamptz, boolean) is
  'Every Statistics figure for one artist and window. Private: callers must authorize the artist first (public.get_statistics). Aggregates only.';

-- ---------------------------------------------------------------------------
-- 3. Authorized entry point
-- ---------------------------------------------------------------------------

create or replace function public.get_statistics(
  p_artist_ids uuid[],
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_previous_from timestamptz;
  v_artist uuid;
  v_artists uuid[];
  v_finance boolean;
  v_current jsonb;
  v_previous jsonb;
  v_history timestamptz;
  v_out jsonb := '[]'::jsonb;
begin
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'statistics need a range of at most 400 days' using errcode = '22023';
  end if;
  v_previous_from := p_from - (p_to - p_from);

  if p_artist_ids is null then
    select coalesce(array_agg(a.id order by a.display_name), '{}')
      into v_artists
    from public.artists a
    where crm_private.has_artist_capability(a.id, 'view');
  else
    select coalesce(array_agg(distinct x), '{}') into v_artists from unnest(p_artist_ids) x where x is not null;
    if cardinality(v_artists) > 20 then
      raise exception 'too many artists' using errcode = '22023';
    end if;
  end if;

  foreach v_artist in array v_artists loop
    -- Authorize before reading anything for this artist.
    if not crm_private.has_artist_capability(v_artist, 'view') then
      raise exception 'not allowed to view statistics for this artist' using errcode = '42501';
    end if;
    v_finance := crm_private.has_artist_capability(v_artist, 'view_finance');
    v_current := crm_private.statistics_core(v_artist, p_from, p_to, v_now, v_finance);
    v_previous := crm_private.statistics_core(v_artist, v_previous_from, p_from, v_now, v_finance);
    v_history := (v_current ->> 'history_start')::timestamptz;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'artist_id', v_artist,
      'finance', v_finance,
      'history_start', v_history,
      'comparable', v_history is not null and v_history <= v_previous_from,
      'current', v_current - 'history_start',
      'previous', v_previous - 'history_start'
    ));
  end loop;

  return jsonb_build_object(
    'generated_at', v_now,
    'from', p_from,
    'to', p_to,
    'previous_from', v_previous_from,
    'maturity_days', 14,
    'artists', v_out
  );
end;
$$;

revoke all on function public.get_statistics(uuid[], timestamptz, timestamptz) from public, anon, service_role;
grant execute on function public.get_statistics(uuid[], timestamptz, timestamptz) to authenticated;

comment on function public.get_statistics(uuid[], timestamptz, timestamptz) is
  'Statistics 2.0: per-artist aggregates for a window and the equal window before it. Each artist is authorized with has_artist_capability(view); finance only with view_finance. Aggregates only.';

-- ---------------------------------------------------------------------------
-- 4. GPT reads the same core
-- ---------------------------------------------------------------------------
--
-- gpt_get_statistics answered with its own rules (no intake filter, drafts in
-- session totals, money summed across currencies, discovery_source before the
-- technical source). It now returns the core's figures. Existing top-level
-- keys are kept so a GPT prompt that names them still finds them; their values
-- follow the corrected definitions, and the full core result is under
-- `statistics`.

create or replace function public.gpt_get_statistics(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_ctx record;
  v_finance boolean;
  v_core jsonb;
  v_result jsonb;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('crm_read', 'view_enquiries');
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'statistics need a range of at most 400 days' using errcode = '22023';
  end if;
  v_finance := crm_private.has_artist_capability(v_ctx.artist_id, 'view_finance');
  v_core := crm_private.statistics_core(v_ctx.artist_id, p_from, p_to, clock_timestamp(), v_finance);

  v_result := jsonb_build_object(
    'artist_id', v_ctx.artist_id,
    'from', p_from,
    'to', p_to,
    'definitions', 'Tattoo work and consultations are never added together. Conversion counts only enquiries at least 14 days old and only tattoo bookings that stand. Money is per currency and never summed across currencies.',
    'enquiries', jsonb_build_object(
      'total', v_core -> 'enquiries',
      'by_status', coalesce((select jsonb_object_agg(status, n) from (
          select e.status::text as status, count(*) as n from public.statistics_enquiries e
          where e.artist_id = v_ctx.artist_id and e.archived_at is null and e.intake_state = 'complete'
            and e.created_at >= p_from and e.created_at < p_to group by 1) s), '{}'::jsonb),
      'by_source', coalesce((select jsonb_object_agg(c ->> 'key', (c ->> 'enquiries')::int)
          from jsonb_array_elements(v_core -> 'channels') c), '{}'::jsonb),
      'by_discovery_source', coalesce((select jsonb_object_agg(src, n) from (
          select coalesce(e.discovery_source, 'not_recorded') as src, count(*) as n from public.statistics_enquiries e
          where e.artist_id = v_ctx.artist_id and e.archived_at is null and e.intake_state = 'complete'
            and e.created_at >= p_from and e.created_at < p_to group by 1) s), '{}'::jsonb)),
    'projects', jsonb_build_object(
      'created', (select count(*) from public.statistics_projects p
                  where p.artist_id = v_ctx.artist_id and p.archived_at is null
                    and p.created_at >= p_from and p.created_at < p_to)),
    'sessions', jsonb_build_object(
      'total', v_core -> 'sessions' -> 'booked',
      'completed', v_core -> 'sessions' -> 'completed',
      'cancelled', v_core -> 'sessions' -> 'cancelled',
      'no_show', v_core -> 'sessions' -> 'no_show',
      'hours_completed', v_core -> 'sessions' -> 'hours',
      'consultations_held', v_core -> 'sessions' -> 'consultations_held'),
    'statistics', v_core - 'history_start'
  );

  if v_finance then
    v_result := v_result || jsonb_build_object(
      'payments', jsonb_build_object(
        'received', v_core -> 'finance' -> 'received',
        'refunded', v_core -> 'finance' -> 'refunded',
        'open', v_core -> 'finance' -> 'open'));
  else
    v_result := v_result || jsonb_build_object('finance_hidden', true);
  end if;
  return v_result;
end;
$$;

revoke all on function public.gpt_get_statistics(timestamptz, timestamptz) from public, anon, service_role;
grant execute on function public.gpt_get_statistics(timestamptz, timestamptz) to authenticated;
