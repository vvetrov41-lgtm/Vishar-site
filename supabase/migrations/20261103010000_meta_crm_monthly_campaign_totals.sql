-- Extend the backend-only funnel RPC with full-month campaign-level totals.
-- No historical data edits or individual records cross the Worker boundary.
-- Aggregated Meta funnel counts for the Vishar Meta Analytics Worker.
--
-- Contract: docs/integrations/meta-crm-funnel.md (mirrors vishar-meta-analytics
-- docs/crm-funnel.md). Backend-only, read-only, aggregates only:
--   * the ad account selects exactly one artist through the private verified
--     registry crm_private.meta_ad_account_identity; no caller-supplied artist;
--   * only consented Meta attribution rows (crm_private.enquiry_meta_attribution
--     via crm_private.meta_enquiry_reconciliation) whose ad identity came from
--     paid UTM evidence are counted;
--   * enquiries excluded from analytics (tests, operators) are removed;
--   * counts of 1 or 2 are suppressed to null, and the deposit total with them;
--   * no names, emails, phones, enquiry ids, references or free text leave it.
-- No Meta event is sent and no row is written.

create or replace function public.service_meta_crm_funnel(
  p_ad_account_id text,
  p_since date,
  p_until date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist uuid;
  v_rows jsonb;
  v_campaign_totals jsonb;
begin
  if not crm_private.is_service_backend() then
    raise exception 'Meta funnel aggregates are backend-only' using errcode = '42501';
  end if;
  if p_ad_account_id is null or p_ad_account_id !~ '^[0-9]{5,30}$' then
    raise exception 'invalid ad account' using errcode = '22023';
  end if;
  if p_since is null or p_until is null or p_until < p_since or p_until - p_since > 89 then
    raise exception 'invalid date range' using errcode = '22023';
  end if;

  select a.artist_id into v_artist
  from crm_private.meta_ad_account_identity a
  where a.ad_account_id = p_ad_account_id;
  if v_artist is null then
    raise exception 'unknown ad account' using errcode = 'P0002';
  end if;

  with base as (
    select distinct r.enquiry_id, r.meta_account_event_date as day, r.ad_id, r.campaign_id
    from crm_private.meta_enquiry_reconciliation r
    join public.enquiries e on e.id = r.enquiry_id and e.artist_id = v_artist
    where r.artist_id = v_artist
      and r.ad_account_id = p_ad_account_id
      and r.ad_id ~ '^[0-9]{10,25}$'
      and r.meta_account_event_date between p_since and p_until
      and e.excluded_from_analytics = false
  ),
  per_enquiry as (
    select b.*,
      exists (
        select 1 from public.sessions s
        where s.enquiry_id = b.enquiry_id
          and s.appointment_type in ('in_person_consultation', 'video_consultation')
          and s.status in ('confirmed', 'completed')
      ) as consulted,
      exists (
        select 1 from public.projects p
        where p.enquiry_id = b.enquiry_id and p.status in ('active', 'completed')
      ) as confirmed,
      (select sum(round(p.deposit_amount * 100))::bigint from public.projects p
        where p.enquiry_id = b.enquiry_id and p.deposit_status = 'paid'
          and p.currency = 'GBP' and p.deposit_amount > 0) as deposit_minor
    from base b
  ),
  grouped as (
    select day, ad_id, max(campaign_id) as campaign_id,
      count(*)::integer as enquiries,
      count(*) filter (where consulted)::integer as consultations,
      count(*) filter (where confirmed)::integer as confirmed_projects,
      count(*) filter (where deposit_minor is not null)::integer as deposits_count,
      coalesce(sum(deposit_minor), 0)::bigint as deposits_minor
    from per_enquiry
    group by day, ad_id
  ),
  campaign_grouped as (
    -- Separate campaign aggregation before daily cells of size 1-2 are hidden.
    select campaign_id,
      count(*)::integer as enquiries,
      count(*) filter (where consulted)::integer as consultations,
      count(*) filter (where confirmed)::integer as confirmed_projects,
      count(*) filter (where deposit_minor is not null)::integer as deposits_count,
      coalesce(sum(deposit_minor),0)::bigint as deposits_minor
    from per_enquiry
    where campaign_id ~ '^[0-9]{10,25}$'
    group by campaign_id
  ),
  daily_visibility as (
    -- Every daily ad cell can be retrieved via a permitted partial-period query,
    -- so use those cells as the privacy boundary for complementary suppression.
    select campaign_id,
      count(*) filter (where enquiries between 1 and 2)::int as enquiries_hidden,
      coalesce(sum(enquiries) filter (where enquiries not between 1 and 2),0)::bigint as enquiries_visible,
      count(*) filter (where consultations between 1 and 2)::int as consultations_hidden,
      coalesce(sum(consultations) filter (where consultations not between 1 and 2),0)::bigint as consultations_visible,
      count(*) filter (where confirmed_projects between 1 and 2)::int as projects_hidden,
      coalesce(sum(confirmed_projects) filter (where confirmed_projects not between 1 and 2),0)::bigint as projects_visible,
      count(*) filter (where deposits_count between 1 and 2)::int as deposits_hidden,
      coalesce(sum(deposits_count) filter (where deposits_count not between 1 and 2),0)::bigint as deposits_visible
    from grouped
    where campaign_id ~ '^[0-9]{10,25}
    jsonb_build_object(
      'date', to_char(day, 'YYYY-MM-DD'),
      'ad_id', ad_id,
      'enquiries', case when enquiries between 1 and 2 then null else enquiries end,
      'consultations', case when consultations between 1 and 2 then null else consultations end,
      'confirmed_projects', case when confirmed_projects between 1 and 2 then null else confirmed_projects end,
      'deposits_count', case when deposits_count between 1 and 2 then null else deposits_count end,
      'deposits_minor', case when deposits_count between 1 and 2 then null else deposits_minor end
    ) || case when campaign_id ~ '^[0-9]{10,25}$'
              then jsonb_build_object('campaign_id', campaign_id) else '{}'::jsonb end
    order by day, ad_id), '[]'::jsonb) from grouped),
  case when p_since = date_trunc('month',p_since)::date
     and p_until = (date_trunc('month',p_since)+interval '1 month - 1 day')::date
    then coalesce((select jsonb_agg(jsonb_build_object(
      'campaign_id', c.campaign_id,
      'enquiries', case
        when c.enquiries between 1 and 2 then null
        when d.enquiries_hidden = 0 then c.enquiries
        when d.enquiries_hidden >= 2
         and c.enquiries - d.enquiries_visible > d.enquiries_hidden
         and c.enquiries - d.enquiries_visible < 2*d.enquiries_hidden
        then c.enquiries
        else null end,
      'consultations', case
        when c.consultations between 1 and 2 then null
        when d.consultations_hidden = 0 then c.consultations
        when d.consultations_hidden >= 2
         and c.consultations - d.consultations_visible > d.consultations_hidden
         and c.consultations - d.consultations_visible < 2*d.consultations_hidden
        then c.consultations
        else null end,
      'confirmed_projects', case
        when c.confirmed_projects between 1 and 2 then null
        when d.projects_hidden = 0 then c.confirmed_projects
        when d.projects_hidden >= 2
         and c.confirmed_projects - d.projects_visible > d.projects_hidden
         and c.confirmed_projects - d.projects_visible < 2*d.projects_hidden
        then c.confirmed_projects
        else null end,
      'deposits_count', case
        when c.deposits_count between 1 and 2 then null
        when d.deposits_hidden = 0 then c.deposits_count
        when d.deposits_hidden >= 2
         and c.deposits_count - d.deposits_visible > d.deposits_hidden
         and c.deposits_count - d.deposits_visible < 2*d.deposits_hidden
        then c.deposits_count
        else null end,
      'deposits_minor', case
        when c.deposits_count = 0 and d.deposits_hidden=0 then 0
        when c.deposits_count > 2 and
          (d.deposits_hidden = 0 or
           (d.deposits_hidden >= 2
            and c.deposits_count-d.deposits_visible > d.deposits_hidden
            and c.deposits_count-d.deposits_visible < 2*d.deposits_hidden))
          then c.deposits_minor
        else null end
    ) order by c.campaign_id) from campaign_grouped c
      join daily_visibility d on d.campaign_id=c.campaign_id), '[]'::jsonb)
    else null
  end
  into v_rows, v_campaign_totals;

  return jsonb_build_object(
    'version', 1,
    'account_id', 'act_' || p_ad_account_id,
    'currency', 'GBP',
    'date_basis', 'meta_account_local',
    'rows', v_rows
  ) || case when v_campaign_totals is not null
       then jsonb_build_object('campaign_totals',v_campaign_totals)
       else '{}'::jsonb end;
end;
$$;

revoke all on function public.service_meta_crm_funnel(text, date, date)
  from public, anon, authenticated;
grant execute on function public.service_meta_crm_funnel(text, date, date) to service_role;

comment on function public.service_meta_crm_funnel(text, date, date) is
  'Backend-only consented Meta funnel: daily ad suppression and full-calendar-month campaign totals; no personal data.';

    group by campaign_id
  )
  select (select coalesce(jsonb_agg(
    jsonb_build_object(
      'date', to_char(day, 'YYYY-MM-DD'),
      'ad_id', ad_id,
      'enquiries', case when enquiries between 1 and 2 then null else enquiries end,
      'consultations', case when consultations between 1 and 2 then null else consultations end,
      'confirmed_projects', case when confirmed_projects between 1 and 2 then null else confirmed_projects end,
      'deposits_count', case when deposits_count between 1 and 2 then null else deposits_count end,
      'deposits_minor', case when deposits_count between 1 and 2 then null else deposits_minor end
    ) || case when campaign_id ~ '^[0-9]{10,25}$'
              then jsonb_build_object('campaign_id', campaign_id) else '{}'::jsonb end
    order by day, ad_id), '[]'::jsonb) from grouped),
  case when p_since = date_trunc('month',p_since)::date
     and p_until = (date_trunc('month',p_since)+interval '1 month - 1 day')::date
    then coalesce((select jsonb_agg(jsonb_build_object(
      'campaign_id', campaign_id,
      'enquiries', case when enquiries between 1 and 2 then null else enquiries end,
      'consultations', case when consultations between 1 and 2 then null else consultations end,
      'confirmed_projects', case when confirmed_projects between 1 and 2 then null else confirmed_projects end,
      'deposits_count', case when deposits_count between 1 and 2 then null else deposits_count end,
      'deposits_minor', case when deposits_count between 1 and 2 then null else deposits_minor end
    ) order by campaign_id) from campaign_grouped), '[]'::jsonb)
    else null
  end
  into v_rows, v_campaign_totals;

  return jsonb_build_object(
    'version', 1,
    'account_id', 'act_' || p_ad_account_id,
    'currency', 'GBP',
    'date_basis', 'meta_account_local',
    'rows', v_rows
  ) || case when v_campaign_totals is not null
       then jsonb_build_object('campaign_totals',v_campaign_totals)
       else '{}'::jsonb end;
end;
$$;

revoke all on function public.service_meta_crm_funnel(text, date, date)
  from public, anon, authenticated;
grant execute on function public.service_meta_crm_funnel(text, date, date) to service_role;

comment on function public.service_meta_crm_funnel(text, date, date) is
  'Backend-only consented Meta funnel: daily ad suppression and full-calendar-month campaign totals; no personal data.';
