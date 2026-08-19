-- Guarded provisioning of one artist's reusable Monzo payment destinations.
--
-- WHY THIS FILE EXISTS
--
-- public.monzo_payment_destinations is closed: it has no browser grant, no
-- service-role grant and deliberately no configuration RPC, because these rows
-- are operator-owned routing configuration rather than CRM data. Provisioning
-- therefore runs as the migration owner through the protected production
-- database gate, and this file is the reviewable statement it runs.
--
-- WHAT MUST NOT BE COMMITTED
--
-- Real reusable Monzo payment URLs are never committed to this repository and
-- never pasted into a pull request body or chat transcript. They are supplied
-- at run time through the psql variables below.
--
-- HOW TO RUN
--
--   psql "$DATABASE_URL" \
--     -v ON_ERROR_STOP=1 \
--     -v artist_slug="kristina" \
--     -v destinations="$(cat destinations.json)" \
--     -f scripts/monzo/provision-artist-payment-destinations.sql
--
-- destinations.json is validated offline first:
--
--   node scripts/validate-monzo-destination-plan.mjs destinations.json
--
-- and has the shape:
--
--   [{"amount": 50, "payment_url": "https://monzo.com/pay/r/..."}, ...]
--
-- The operation is idempotent: rerunning it with the same plan changes
-- nothing, and rerunning it with a corrected URL updates only that row. It
-- never touches another artist, never disables an integration, never creates a
-- payment request and never writes the payment ledger.

\set ON_ERROR_STOP on
\timing off

begin;

create temporary table provisioning_input (
  artist_slug  text not null,
  destinations jsonb not null
) on commit drop;

insert into provisioning_input (artist_slug, destinations)
values (:'artist_slug', (:'destinations')::jsonb);

do $$
declare
  v_input record;
  v_artist_id uuid;
  v_item jsonb;
  v_amount numeric(12,2);
  v_url text;
  v_urls text[] := array[]::text[];
  v_amounts numeric[] := array[]::numeric[];
  v_written integer := 0;
begin
  select * into v_input from provisioning_input;

  select a.id into v_artist_id
  from public.artists a
  where a.slug = v_input.artist_slug and a.is_active;
  if not found then
    raise exception 'no active artist has slug %', v_input.artist_slug;
  end if;

  -- The artist must already own an enabled Monzo Easy Bank Transfer route
  -- under its own deterministic provider account key. Provisioning
  -- destinations for an artist that is not connected would create a dormant
  -- routing table nobody can reach.
  if not exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = v_artist_id
      and i.integration_type = 'payments'
      and i.provider = 'monzo_easy_bank_transfer'
      and i.integration_key = 'monzo_ebt_' || replace(v_artist_id::text, '-', '')
      and i.is_enabled
  ) then
    raise exception 'artist % has no enabled Monzo Easy Bank Transfer integration',
      v_input.artist_slug;
  end if;

  if jsonb_typeof(v_input.destinations) <> 'array'
     or jsonb_array_length(v_input.destinations) = 0
     or jsonb_array_length(v_input.destinations) > 32 then
    raise exception 'destinations must be a JSON array of 1 to 32 entries';
  end if;

  for v_item in select * from jsonb_array_elements(v_input.destinations) loop
    v_amount := (v_item ->> 'amount')::numeric(12,2);
    v_url := btrim(coalesce(v_item ->> 'payment_url', ''));

    if v_amount is null or v_amount <= 0 or v_amount > 100000.00 then
      raise exception 'destination amount is out of range';
    end if;
    if v_url !~ '^https://monzo[.]com/pay/r/[A-Za-z0-9_-]{4,255}$' then
      raise exception 'destination % is not an exact Monzo payment URL', v_amount;
    end if;
    if v_amount = any (v_amounts) then
      raise exception 'destination amount % appears twice in the plan', v_amount;
    end if;
    if v_url = any (v_urls) then
      raise exception 'the same Monzo URL appears twice in the plan';
    end if;

    -- A URL already used by another artist, or already attached to a payment
    -- request as a one-off, must never become this artist's reusable link.
    if exists (
      select 1 from public.monzo_payment_destinations d
      where d.payment_url = v_url and d.artist_id <> v_artist_id
    ) then
      raise exception 'a Monzo URL in the plan already belongs to another artist';
    end if;
    if exists (
      select 1 from public.payment_request_payment_destinations d
      where d.payment_url = v_url
    ) then
      raise exception 'a Monzo URL in the plan is already a one-off request destination';
    end if;

    v_amounts := v_amounts || v_amount;
    v_urls := v_urls || v_url;

    insert into public.monzo_payment_destinations (
      artist_id, amount, currency, payment_url, updated_at
    ) values (
      v_artist_id, v_amount, 'GBP', v_url, now()
    )
    on conflict (artist_id, amount, currency) do update
    set payment_url = excluded.payment_url,
        updated_at = now()
    where public.monzo_payment_destinations.payment_url is distinct from excluded.payment_url;

    v_written := v_written + 1;
  end loop;

  raise notice 'artist % now has % planned destination(s)', v_input.artist_slug, v_written;
end $$;

-- Safe verification. Amounts and counts are printed; URLs never are.
select a.slug as artist,
       d.amount,
       d.currency,
       left(md5(d.payment_url), 8) as url_fingerprint,
       d.updated_at
from public.monzo_payment_destinations d
join public.artists a on a.id = d.artist_id
where a.slug = (select artist_slug from provisioning_input)
order by d.amount;

select count(*) as destination_count,
       count(distinct payment_url) as distinct_url_count
from public.monzo_payment_destinations d
join public.artists a on a.id = d.artist_id
where a.slug = (select artist_slug from provisioning_input);

-- Cross-artist leak check: no reusable URL may be shared by two artists.
select count(*) as shared_url_violations
from (
  select payment_url
  from public.monzo_payment_destinations
  group by payment_url
  having count(distinct artist_id) > 1
) q;

commit;
