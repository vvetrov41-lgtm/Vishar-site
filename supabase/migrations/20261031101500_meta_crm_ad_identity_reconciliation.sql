-- Additive, consent-scoped Meta ad identity for future CRM reconciliation.
-- Browser cannot nominate the ad account, artist, timezone, or Meta event id.
-- No new events are sent to Meta by this migration.
create table if not exists crm_private.meta_ad_account_identity (
  artist_id uuid primary key references public.artists(id) on delete cascade,
  ad_account_id text not null unique,
  timezone_name text not null,
  verified_at timestamptz not null default statement_timestamp(),
  constraint meta_account_id_digits check (ad_account_id ~ '^[0-9]{5,30}$')
);
alter table crm_private.meta_ad_account_identity enable row level security;
revoke all on crm_private.meta_ad_account_identity from public, anon, authenticated, service_role;

-- The account and its Insights timezone are verified against the owner's
-- Meta connection. Store them here, not in a caller-controlled form field.
insert into crm_private.meta_ad_account_identity (artist_id, ad_account_id, timezone_name)
select a.id, '2128002004809955', 'Africa/Cairo'
from public.artists a where a.slug = 'vladimir'
on conflict (artist_id) do nothing;

alter table crm_private.enquiry_meta_attribution
  add column if not exists ad_account_id text,
  add column if not exists campaign_id text,
  add column if not exists adset_id text,
  add column if not exists ad_id text,
  add column if not exists ad_identity_source text;

alter table crm_private.enquiry_meta_attribution
  add constraint enquiry_meta_ad_campaign_id_check
    check (campaign_id is null or campaign_id ~ '^[0-9]{10,25}$'),
  add constraint enquiry_meta_adset_id_check
    check (adset_id is null or adset_id ~ '^[0-9]{10,25}$'),
  add constraint enquiry_meta_ad_id_check
    check (ad_id is null or ad_id ~ '^[0-9]{10,25}$'),
  add constraint enquiry_meta_identity_source_check
    check (ad_identity_source is null or ad_identity_source in
      ('conversion_utm', 'last_touch_utm', 'first_touch_utm')),
  add constraint enquiry_meta_ad_account_check
    check ((campaign_id is null and ad_account_id is null)
       or (campaign_id is not null and ad_identity_source is not null));

-- Explicit paid social campaign IDs only. A bare fbclid or an Instagram
-- referrer does not prove a paid campaign, and is never promoted to an ad ID.
create or replace function crm_private.meta_paid_utm_ids(
  p_source text, p_medium text, p_campaign text, p_adset text, p_ad text
) returns jsonb
language sql immutable parallel safe
set search_path = pg_catalog
as $$
  select case
    when lower(coalesce(p_source, '')) in ('fb','ig','facebook','instagram')
     and lower(coalesce(p_medium, '')) in ('paid','paid_social','cpc')
     and coalesce(p_campaign, '') ~ '^[0-9]{10,25}$'
    then jsonb_build_object(
      'campaign_id', p_campaign,
      'adset_id', case when coalesce(p_adset, '') ~ '^[0-9]{10,25}$' then p_adset else null end,
      'ad_id', case when coalesce(p_ad, '') ~ '^[0-9]{10,25}$' then p_ad else null end
    )
    else '{}'::jsonb
  end;
$$;
revoke all on function crm_private.meta_paid_utm_ids(text,text,text,text,text)
  from public, anon, authenticated, service_role;

-- Enquiry conversion UTM wins; consented last touch is the next candidate.
-- First touch is labelled explicitly and is NEVER represented as Meta-confirmed
-- attribution. No visitor-history data is recovered without stored consent.
create or replace function crm_private.meta_enquiry_ad_ids(p_enquiry_id uuid)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry public.enquiries%rowtype;
  v_first jsonb;
  v_last jsonb;
  v_ids jsonb;
begin
  select * into v_enquiry from public.enquiries where id = p_enquiry_id;
  if not found then return '{}'::jsonb; end if;

  v_ids := crm_private.meta_paid_utm_ids(
    v_enquiry.utm_source, v_enquiry.utm_medium,
    v_enquiry.utm_campaign, v_enquiry.utm_term, v_enquiry.utm_content);
  if v_ids ? 'campaign_id' then
    return v_ids || '{"source":"conversion_utm"}'::jsonb;
  end if;

  select first_touch, last_touch into v_first, v_last
  from crm_private.enquiry_touch_attribution where enquiry_id = p_enquiry_id;
  v_ids := crm_private.meta_paid_utm_ids(
    v_last->>'utmSource', v_last->>'utmMedium',
    v_last->>'utmCampaign', v_last->>'utmTerm', v_last->>'utmContent');
  if v_ids ? 'campaign_id' then
    return v_ids || '{"source":"last_touch_utm"}'::jsonb;
  end if;

  v_ids := crm_private.meta_paid_utm_ids(
    v_first->>'utmSource', v_first->>'utmMedium',
    v_first->>'utmCampaign', v_first->>'utmTerm', v_first->>'utmContent');
  if v_ids ? 'campaign_id' then
    return v_ids || '{"source":"first_touch_utm"}'::jsonb;
  end if;
  return '{}'::jsonb;
end;
$$;
revoke all on function crm_private.meta_enquiry_ad_ids(uuid)
  from public, anon, authenticated, service_role;

create or replace function crm_private.set_meta_enquiry_ad_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_ids jsonb;
begin
  -- This trigger runs only after the existing service-only Meta-consent RPC
  -- has confirmed the enquiry id and browser/server event-id equality.
  v_ids := crm_private.meta_enquiry_ad_ids(new.enquiry_id);
  if v_ids ? 'campaign_id' then
    new.campaign_id := v_ids->>'campaign_id';
    new.adset_id := v_ids->>'adset_id';
    new.ad_id := v_ids->>'ad_id';
    new.ad_identity_source := v_ids->>'source';
    select a.ad_account_id into new.ad_account_id
    from crm_private.meta_ad_account_identity a
    where a.artist_id = new.artist_id;
  end if;
  return new;
end;
$$;
revoke all on function crm_private.set_meta_enquiry_ad_identity()
  from public, anon, authenticated, service_role;
drop trigger if exists meta_enquiry_ad_identity on crm_private.enquiry_meta_attribution;
create trigger meta_enquiry_ad_identity
  before insert on crm_private.enquiry_meta_attribution
  for each row execute function crm_private.set_meta_enquiry_ad_identity();

-- Backfill ONLY enquiries with a prior explicit Meta measurement consent
-- (presence in this private attribution table). Do not infer consent or
-- construct an ad identity from referrer, fbclid, or account-wide totals.
with proposed as (
  select m.enquiry_id, crm_private.meta_enquiry_ad_ids(m.enquiry_id) as ids,
         a.ad_account_id
  from crm_private.enquiry_meta_attribution m
  left join crm_private.meta_ad_account_identity a on a.artist_id = m.artist_id
)
update crm_private.enquiry_meta_attribution m
set campaign_id = p.ids->>'campaign_id',
    adset_id = p.ids->>'adset_id',
    ad_id = p.ids->>'ad_id',
    ad_identity_source = p.ids->>'source',
    ad_account_id = p.ad_account_id
from proposed p
where p.enquiry_id = m.enquiry_id
  and p.ids ? 'campaign_id'
  and m.campaign_id is null;

create index if not exists enquiry_meta_campaign_reporting_idx
  on crm_private.enquiry_meta_attribution (artist_id, campaign_id, ad_id)
  where campaign_id is not null;

-- Account-date boundaries use the verified IANA timezone, not an assumed
-- UTC+2/UTC+3 offset. London reports separately use Europe/London (BST/GMT).
-- Meta Insights action_report_time=conversion is needed for daily comparison;
-- these rows are CRM-side candidates, NOT a Meta event-level acknowledgement.
create or replace view crm_private.meta_enquiry_reconciliation
with (security_invoker = true) as
select
  m.artist_id,
  m.enquiry_id,
  m.lead_event_id,
  m.ad_account_id,
  m.campaign_id,
  m.adset_id,
  m.ad_id,
  m.ad_identity_source,
  a.timezone_name as meta_timezone,
  e.created_at as enquiry_created_at_utc,
  coalesce(o.event_time_utc, e.created_at) as event_time_utc,
  case when o.event_time_utc is null then 'crm_created_at_fallback'
       else 'outbox_event_time' end as time_basis,
  (coalesce(o.event_time_utc, e.created_at) at time zone 'Europe/London')::date as london_event_date,
  (coalesce(o.event_time_utc, e.created_at) at time zone a.timezone_name)::date as meta_account_event_date,
  o.delivery_status as capi_outbox_status
from crm_private.enquiry_meta_attribution m
join public.enquiries e on e.id = m.enquiry_id and e.artist_id = m.artist_id
left join crm_private.meta_ad_account_identity a
  on a.artist_id = m.artist_id and a.ad_account_id = m.ad_account_id
left join lateral (
  select to_timestamp((outbox.payload->>'event_time')::double precision) as event_time_utc,
         outbox.status::text as delivery_status
  from public.integration_outbox outbox
  where outbox.enquiry_id = m.enquiry_id
    and outbox.kind = 'meta_conversion'
    and outbox.payload->>'event_name' = 'Lead'
    and outbox.payload->>'event_id' = m.lead_event_id
  order by outbox.created_at asc, outbox.id asc limit 1
) o on true;

revoke all on crm_private.meta_enquiry_reconciliation
  from public, anon, authenticated, service_role;
comment on view crm_private.meta_enquiry_reconciliation is
  'Private consented Meta/CRM lead reconciliation. Event dates use IANA account timezone; CRM entries do not prove Meta-attributed conversions.';
