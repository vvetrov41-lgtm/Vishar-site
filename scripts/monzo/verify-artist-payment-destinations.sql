-- Read-only verification of one artist's Monzo payment routing.
--
-- Prints no payment URL, provider credential or token material: only amounts,
-- counts and fingerprints. Safe to run against production and safe to paste
-- into a pull request.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v artist_slug="kristina" \
--     -f scripts/monzo/verify-artist-payment-destinations.sql

\set ON_ERROR_STOP on

select a.slug as artist,
       a.is_active,
       i.is_enabled as monzo_enabled,
       i.integration_key = 'monzo_ebt_' || replace(a.id::text, '-', '') as key_is_artist_derived
from public.artists a
left join public.artist_integrations i
  on i.artist_id = a.id
 and i.integration_type = 'payments'
 and i.provider = 'monzo_easy_bank_transfer'
where a.slug = :'artist_slug';

select p.version as policy_version,
       p.deposit_mode,
       p.refund_policy_version,
       count(t.tier_order) as tier_count
from public.artists a
join public.artist_payment_policies p on p.artist_id = a.id and p.is_active
left join public.artist_payment_policy_session_tiers t on t.policy_id = p.id
where a.slug = :'artist_slug'
group by p.version, p.deposit_mode, p.refund_policy_version;

select d.amount,
       d.currency,
       left(md5(d.payment_url), 8) as url_fingerprint,
       d.updated_at
from public.monzo_payment_destinations d
join public.artists a on a.id = d.artist_id
where a.slug = :'artist_slug'
order by d.amount;

select count(*) as cross_artist_url_violations
from public.monzo_payment_destinations mine
join public.artists a on a.id = mine.artist_id
join public.monzo_payment_destinations other
  on other.payment_url = mine.payment_url
 and other.artist_id <> mine.artist_id
where a.slug = :'artist_slug';

select count(*) as one_off_destinations
from public.payment_request_payment_destinations d
join public.artists a on a.id = d.artist_id
where a.slug = :'artist_slug';

-- Multiple Sessions evidence contains only amounts/counts/status, never URLs.
select g.session_count,
       g.total_amount,
       g.currency,
       r.status as payment_request_status,
       count(m.session_id) filter (where m.released_at is null) as live_members,
       count(m.session_id) filter (where m.released_at is not null) as released_members
from public.session_deposit_groups g
join public.artists a on a.id = g.artist_id
join public.payment_requests r on r.id = g.payment_request_id
left join public.session_deposit_group_members m on m.group_id = g.id
where a.slug = :'artist_slug'
group by g.id, g.session_count, g.total_amount, g.currency, r.status, g.created_at
order by g.created_at desc
limit 20;

-- Onboarding/group creation alone must never have settled anything.
select count(*) as provider_ledger_entries
from public.payment_transactions t
join public.artists a on a.id = t.artist_id
where a.slug = :'artist_slug'
  and t.provider = 'monzo_easy_bank_transfer';
