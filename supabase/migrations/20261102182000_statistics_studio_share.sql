-- Studio commission for Vladimir and Kristina, session-by-session.
-- Actual settled session value, not the payments ledger (which includes deposits).
-- Never label this as proof that the studio has received the fee.
-- Independent of payment destination: studio-collected payments count once.
create or replace function crm_private.studio_fee_for_price(p_price numeric)
returns numeric language sql immutable
set search_path = pg_catalog
as $fee$
  select case when p_price is null or p_price < 0 then null
              else least(round(p_price * 0.30, 2), 180::numeric)
         end;
$fee$;

revoke all on function crm_private.studio_fee_for_price(numeric)
  from public, anon, authenticated, service_role;

create or replace function crm_private.statistics_studio_share(
  p_artist_id uuid, p_from timestamptz, p_to timestamptz
)
returns jsonb language sql stable security invoker
set search_path = pg_catalog, public, crm_private
as $share$
  with paid_sessions as (
    select s.price, upper(coalesce(s.currency, 'GBP')) as currency
    from public.sessions s
    join public.statistics_sessions projected on projected.id = s.id
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
      coalesce(sum(crm_private.studio_fee_for_price(price)) filter
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

revoke all on function crm_private.statistics_studio_share(uuid,timestamptz,timestamptz)
  from public, anon, authenticated, service_role;

-- Same source for CRM Statistics and GPT Statistics: both call statistics_core.
-- Finance capability is checked by get_statistics/gpt_get_statistics before
-- p_finance=true is passed to this privileged core.
CREATE OR REPLACE FUNCTION crm_private.statistics_core(p_artist_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_now timestamp with time zone, p_finance boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_maturity_cutoff timestamptz := p_now - interval '14 days';
  v_timezone text;
  v_week0 timestamptz;
  v_monday date;
  v_result jsonb;
  v_finance jsonb := null;
  v_own_hosts text[];
  v_pricing crm_private.artist_session_pricing%rowtype;
  v_default_currency text;
begin
  select coalesce(array_agg(distinct crm_private.statistics_host(b.allowed_origin)), '{}')
    into v_own_hosts
  from public.booking_sources b
  where b.artist_id = p_artist_id
    and b.allowed_origin is not null;

  select coalesce(a.timezone, 'Europe/London') into v_timezone
  from public.artists a where a.id = p_artist_id;
  -- Weeks start on the artist's local Monday. Each boundary is built from a
  -- local date and converted on its own, so a clock change inside the
  -- horizon (Europe/London on 2026-10-25) cannot shift a week by an hour.
  v_monday := date_trunc('week', p_now at time zone v_timezone)::date;
  v_week0 := v_monday::timestamp at time zone v_timezone;

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
    -- A consultation counts only once it is known to have taken place
    -- (status completed: confirmed by the operator, or evidenced by a tattoo
    -- booking made after it). A past date alone proves nothing.
    select distinct lineage_enquiry_id as id from sess
    where is_consultation and status::text = 'completed' and lineage_enquiry_id is not null
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
    select g as week_index,
           v_monday + 7 * g as week_date,
           (v_monday + 7 * g)::timestamp at time zone v_timezone as week_start,
           (v_monday + 7 * (g + 1))::timestamp at time zone v_timezone as week_end
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
      'consultations_held', (select count(*) from in_window where is_consultation and status::text = 'completed'),
      'consultations_no_show', (select count(*) from in_window where is_consultation and status::text = 'no_show'),
      'consultations_unverified', (select count(*) from in_window where is_consultation
                                   and status::text = 'confirmed' and end_at <= p_now),
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
          'week_start', to_char(w.week_date, 'YYYY-MM-DD'),
          'tattoo_sessions', (select count(*) from ahead a where a.is_work
                              and a.start_at >= w.week_start and a.start_at < w.week_end),
          'tattoo_hours', (select round(coalesce(sum(a.hours), 0)::numeric, 2) from ahead a where a.is_work
                              and a.start_at >= w.week_start and a.start_at < w.week_end),
          'consultations', (select count(*) from ahead a where a.is_consultation
                              and a.start_at >= w.week_start and a.start_at < w.week_end)
        ) order by w.week_index)
        from weeks w),
      'tattoo_sessions_later', (select count(*) from ahead where is_work
                                and start_at >= (v_monday + 84)::timestamp at time zone v_timezone)
    ),
    -- Every ended consultation still waiting for its outcome, whatever the
    -- window: this is a to-do, not a period figure.
    'consultations_awaiting_outcome', (select count(*) from sess
      where is_consultation and status::text = 'confirmed' and end_at <= p_now),
    'history_start', (select min(created_at) from enq)
  )
  into v_result;

  if p_finance then
    -- The artist's own rates only. An artist without a row has no basis for
    -- an estimate; another artist's rates are never borrowed.
    select * into v_pricing from crm_private.artist_session_pricing p where p.artist_id = p_artist_id;
    select upper(coalesce(a.default_currency, 'GBP')) into v_default_currency
    from public.artists a where a.id = p_artist_id;

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
      -- Upcoming tattoo work that stands. A touch-up enters only with an
      -- explicit price: touch-ups are often free, so no value is estimated
      -- for one. Consultations never enter.
      select s.id,
             s.price,
             upper(coalesce(s.currency, pr.currency, v_default_currency)) as price_currency,
             est.amount as estimate,
             est.currency as estimate_currency,
             est.basis as estimate_basis,
             est.source as estimate_source,
             case
               when s.duration_hours is not null then greatest(s.duration_hours, 0)
               when s.end_at > s.start_at then extract(epoch from s.end_at - s.start_at) / 3600
               else 0
             end as hours
      from public.sessions s
      join public.statistics_sessions v on v.id = s.id
      left join public.projects pr on pr.id = s.project_id
      left join lateral crm_private.session_value_estimate(
        case
          when s.duration_hours is not null then s.duration_hours
          when s.end_at > s.start_at then (extract(epoch from s.end_at - s.start_at) / 3600)::numeric
        end,
        pr.hourly_rate, pr.currency,
        v_pricing.hourly_rate, v_pricing.full_day_rate, v_pricing.full_day_hours, v_pricing.currency
      ) est on s.appointment_type::text = 'tattoo_session'
      where s.artist_id = p_artist_id
        and s.status::text = 'confirmed'
        and s.start_at >= p_now
        and (s.appointment_type::text = 'tattoo_session'
             or (s.appointment_type::text = 'touch_up' and s.price is not null))
    ),
    valued as (
      -- Confirmed value (sessions.price) always wins over an estimate. The
      -- estimate is computed here and never written anywhere.
      select f.id, f.hours,
             case when f.price is not null then 'confirmed'
                  when f.estimate is not null then 'estimated'
                  else 'no_basis' end as kind,
             case when f.price is not null then f.price else f.estimate end as amount,
             case when f.price is not null then f.price_currency else f.estimate_currency end as currency,
             case when f.price is null then f.estimate_basis end as basis,
             case when f.price is null then f.estimate_source end as source
      from future_work f
    ),
    forecast as (
      -- A paid deposit allocated to a session (crm_private.booking_card_deposit_for_session,
      -- the rule booking cards use) is taken off that session's value once,
      -- so what is still to come never includes money already received.
      select v.*,
             coalesce((select sum(d.amount) from crm_private.booking_card_deposit_for_session(v.id) d
                       where upper(d.currency) = v.currency), 0) as deposit
      from valued v
      where v.kind <> 'no_basis'
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
        'sessions', (select count(*) from valued),
        'pricing_configured', v_pricing.artist_id is not null
          and (v_pricing.hourly_rate is not null or v_pricing.full_day_rate is not null),
        'confirmed', jsonb_build_object(
          'sessions', (select count(*) from valued where kind = 'confirmed'),
          'value', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'amount', amount) order by currency)
          from (select currency, sum(amount) as amount from forecast where kind = 'confirmed' group by 1) x), '[]'::jsonb),
          'remaining_after_deposits', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'amount', amount) order by currency)
          from (select currency, sum(greatest(amount - deposit, 0)) as amount from forecast where kind = 'confirmed' group by 1) x), '[]'::jsonb)),
        'estimated', jsonb_build_object(
          'sessions', (select count(*) from valued where kind = 'estimated'),
          'full_day', (select count(*) from valued where kind = 'estimated' and basis = 'full_day'),
          'hourly', (select count(*) from valued where kind = 'estimated' and basis = 'hourly'),
          'from_project_rate', (select count(*) from valued where kind = 'estimated' and source = 'project'),
          'value', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'amount', amount) order by currency)
          from (select currency, sum(amount) as amount from forecast where kind = 'estimated' group by 1) x), '[]'::jsonb)),
        'no_basis', jsonb_build_object(
          'sessions', (select count(*) from valued where kind = 'no_basis'),
          'hours', (select round(coalesce(sum(hours), 0)::numeric, 2) from valued where kind = 'no_basis')),
        'expected_value', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'amount', amount) order by currency)
          from (select currency, sum(amount) as amount from forecast group by 1) x), '[]'::jsonb),
        'deposits_paid', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'amount', amount) order by currency)
          from (select currency, sum(deposit) as amount from forecast where deposit > 0 group by 1) x), '[]'::jsonb),
        'remaining_after_deposits', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'amount', amount) order by currency)
          from (select currency, sum(greatest(amount - deposit, 0)) as amount from forecast group by 1) x), '[]'::jsonb)
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

  if p_finance then
    v_finance := v_finance || jsonb_build_object(
      'studio_share', crm_private.statistics_studio_share(p_artist_id, p_from, p_to)
    );
  end if;

  return v_result || jsonb_build_object('finance', v_finance);
end;
$function$;

revoke all on function crm_private.statistics_core(uuid,timestamptz,timestamptz,timestamptz,boolean)
  from public, anon, authenticated, service_role;
