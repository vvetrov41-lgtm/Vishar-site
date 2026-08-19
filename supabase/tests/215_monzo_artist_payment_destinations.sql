-- 215_monzo_artist_payment_destinations.sql
--
-- Synthetic-only validation of the second-artist Monzo destination architecture:
-- artist-scoped reusable destinations, no cross-artist fallback, and a
-- request-specific one-off destination for an uncovered server-priced amount.
-- Grouped deposits are deliberately out of scope and must not appear here.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated, service_role;

create function pg_temp.as_owner() returns void language sql as $$
  select pg_temp.claims('{"sub":"e9111111-1111-4111-8111-111111111111","role":"authenticated"}');
$$;
grant execute on function pg_temp.as_owner() to authenticated, service_role;

insert into auth.users (id, email) values
  ('e9111111-1111-4111-8111-111111111111', 'destinations-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('e9111111-1111-4111-8111-111111111111', 'destinations-owner@example.test',
   'Destinations Owner', 'owner', true);

insert into public.clients (id, full_name, email) values
  ('e9211111-1111-4111-8111-111111111111', 'Vladimir Client', 'dest-v-client@example.test'),
  ('e9222222-2222-4222-8222-222222222222', 'Kristina Client', 'dest-k-client@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values
  ('e9311111-1111-4111-8111-111111111111', 'e9211111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'PENDING',
   'e9411111-1111-4111-8111-111111111111', repeat('a', 64),
   'accepted', 'complete', 'Vladimir Client', 'dest-v-client@example.test',
   '2026-07-29', now()),
  ('e9322222-2222-4222-8222-222222222222', 'e9222222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222', 'PENDING',
   'e9422222-2222-4222-8222-222222222222', repeat('b', 64),
   'accepted', 'complete', 'Kristina Client', 'dest-k-client@example.test',
   '2026-07-29', now());

insert into public.projects (id, client_id, enquiry_id, artist_id, title, status, currency) values
  ('e9511111-1111-4111-8111-111111111111', 'e9211111-1111-4111-8111-111111111111',
   'e9311111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'Vladimir Project', 'active', 'GBP'),
  ('e9522222-2222-4222-8222-222222222222', 'e9222222-2222-4222-8222-222222222222',
   'e9322222-2222-4222-8222-222222222222', 'a2222222-2222-4222-8222-222222222222',
   'Kristina Project', 'active', 'GBP');

-- Vladimir: GBP 50 and GBP 100 sessions.
-- Kristina: GBP 50 and GBP 150 sessions.
insert into public.sessions (id, project_id, artist_id, status, start_at, end_at) values
  ('e9611111-1111-4111-8111-111111111111', 'e9511111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'proposed',
   date_trunc('day', now()) + interval '50 days 10 hours',
   date_trunc('day', now()) + interval '50 days 11 hours'),
  ('e9612222-2222-4222-8222-222222222222', 'e9511111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'proposed',
   date_trunc('day', now()) + interval '51 days 10 hours',
   date_trunc('day', now()) + interval '51 days 13 hours'),
  ('e9622222-2222-4222-8222-222222222222', 'e9522222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222', 'proposed',
   date_trunc('day', now()) + interval '52 days 10 hours',
   date_trunc('day', now()) + interval '52 days 11 hours'),
  ('e9623333-3333-4333-8333-333333333333', 'e9522222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222', 'proposed',
   date_trunc('day', now()) + interval '53 days 10 hours',
   date_trunc('day', now()) + interval '53 days 15 hours');

-- Both artists use the same existing configuration RPC. The synthetic GBP 250
-- URLs below stand in for each artist's own legacy compatibility destination.
set local role authenticated;
select pg_temp.as_owner();
select lives_ok(
  $$select public.configure_monzo_easy_bank_transfer(
      'a1111111-1111-4111-8111-111111111111',
      'https://monzo.com/pay/r/synthetic-v-250', true)$$,
  'Vladimir configures Monzo through the existing artist-scoped finance RPC'
);
select lives_ok(
  $$select public.configure_monzo_easy_bank_transfer(
      'a2222222-2222-4222-8222-222222222222',
      'https://monzo.com/pay/r/synthetic-k-250', true)$$,
  'Kristina configures Monzo through the same RPC with her own destination'
);
reset role;

select isnt(
  (select i.integration_key from public.artist_integrations i
   where i.artist_id = 'a1111111-1111-4111-8111-111111111111'
     and i.provider = 'monzo_easy_bank_transfer'),
  (select i.integration_key from public.artist_integrations i
   where i.artist_id = 'a2222222-2222-4222-8222-222222222222'
     and i.provider = 'monzo_easy_bank_transfer'),
  'each artist derives a different provider account key'
);

select isnt(
  (select i.configuration ->> 'payment_url' from public.artist_integrations i
   where i.artist_id = 'a1111111-1111-4111-8111-111111111111'
     and i.provider = 'monzo_easy_bank_transfer'),
  (select i.configuration ->> 'payment_url' from public.artist_integrations i
   where i.artist_id = 'a2222222-2222-4222-8222-222222222222'
     and i.provider = 'monzo_easy_bank_transfer'),
  'each artist keeps their own legacy GBP 250 URL'
);

-- ---------------------------------------------------------------------------
-- Reusable destinations are artist-scoped and amount-generic
-- ---------------------------------------------------------------------------

select ok(
  to_regclass('public.monzo_easy_bank_transfer_tier_urls') is null
  and to_regclass('public.monzo_payment_destinations') is not null,
  'the existing tier table is renamed in place to the generic destination catalogue'
);

insert into public.monzo_payment_destinations (artist_id, amount, currency, payment_url) values
  ('a1111111-1111-4111-8111-111111111111',  50.00, 'GBP', 'https://monzo.com/pay/r/synthetic-v-50'),
  ('a2222222-2222-4222-8222-222222222222',  50.00, 'GBP', 'https://monzo.com/pay/r/synthetic-k-50'),
  ('a2222222-2222-4222-8222-222222222222', 100.00, 'GBP', 'https://monzo.com/pay/r/synthetic-k-100');

select lives_ok(
  $$insert into public.monzo_payment_destinations (artist_id, amount, currency, payment_url)
    values ('a2222222-2222-4222-8222-222222222222', 600.00, 'GBP',
            'https://monzo.com/pay/r/synthetic-k-600')$$,
  'a future server-authoritative amount can be provisioned as a row without a schema rewrite'
);

select throws_ok(
  $$insert into public.monzo_payment_destinations (artist_id, amount, currency, payment_url)
    values ('a2222222-2222-4222-8222-222222222222', 0.00, 'GBP',
            'https://monzo.com/pay/r/synthetic-k-zero')$$,
  '23514', null,
  'a non-positive reusable amount is rejected'
);

select throws_ok(
  $$insert into public.monzo_payment_destinations (artist_id, amount, currency, payment_url)
    values ('a2222222-2222-4222-8222-222222222222', 500.00, 'GBP',
            'https://example.com/pay/r/not-monzo')$$,
  '23514', null,
  'a reusable destination must be a clean Monzo payment URL'
);

-- ---------------------------------------------------------------------------
-- Single-session requests keep amount and artist authoritative server-side
-- ---------------------------------------------------------------------------

create temporary table dest_results (
  label text primary key,
  payment_request_id uuid not null,
  public_id uuid
);
grant select, insert on dest_results to authenticated;
grant select on dest_results to service_role;

set local role authenticated;
select pg_temp.as_owner();
insert into dest_results (label, payment_request_id) values
  ('vladimir_50', (public.request_session_deposit(
     'e9611111-1111-4111-8111-111111111111',
     'e9711111-1111-4111-8111-111111111111', 'copy_link') ->> 'payment_request_id')::uuid),
  ('vladimir_100', (public.request_session_deposit(
     'e9612222-2222-4222-8222-222222222222',
     'e9712222-2222-4222-8222-222222222222', 'copy_link') ->> 'payment_request_id')::uuid),
  ('kristina_50', (public.request_session_deposit(
     'e9622222-2222-4222-8222-222222222222',
     'e9722222-2222-4222-8222-222222222222', 'copy_link') ->> 'payment_request_id')::uuid),
  ('kristina_150', (public.request_session_deposit(
     'e9623333-3333-4333-8333-333333333333',
     'e9723333-3333-4333-8333-333333333333', 'copy_link') ->> 'payment_request_id')::uuid);
reset role;

select is(
  (select r.amount from public.payment_requests r
   where r.id = (select payment_request_id from dest_results where label = 'vladimir_100')),
  100.00::numeric,
  'Vladimir GBP 100 request amount comes from the session duration'
);
select is(
  (select r.amount from public.payment_requests r
   where r.id = (select payment_request_id from dest_results where label = 'kristina_150')),
  150.00::numeric,
  'Kristina GBP 150 request amount comes from the same duration policy'
);

update dest_results d
set public_id = l.public_id
from public.payment_request_links l
where l.payment_request_id = d.payment_request_id;

set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
select is(
  public.resolve_monzo_deposit_redirect(
    (select public_id from dest_results where label = 'vladimir_50')),
  'https://monzo.com/pay/r/synthetic-v-50',
  'Vladimir GBP 50 request resolves only to Vladimir GBP 50 destination'
);
select is(
  public.resolve_monzo_deposit_redirect(
    (select public_id from dest_results where label = 'kristina_50')),
  'https://monzo.com/pay/r/synthetic-k-50',
  'Kristina GBP 50 request resolves only to Kristina GBP 50 destination'
);

select throws_ok(
  format(
    $$select public.resolve_monzo_deposit_redirect(%L::uuid)$$,
    (select public_id from dest_results where label = 'vladimir_100')),
  '22023', null,
  'Vladimir GBP 100 fails closed even though Kristina has a reusable GBP 100 destination'
);
reset role;

select is(
  crm_private.resolve_monzo_payment_destination(
    'a1111111-1111-4111-8111-111111111111',
    (select payment_request_id from dest_results where label = 'vladimir_50'),
    'monzo_ebt_' || replace('a2222222-2222-4222-8222-222222222222', '-', ''),
    50.00, 'GBP'),
  null,
  'Vladimir cannot resolve through Kristina provider account key'
);

-- ---------------------------------------------------------------------------
-- Request-specific one-off destination
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.as_owner();

select throws_ok(
  format(
    $$select public.attach_monzo_one_off_payment_destination(%L::uuid, %L)$$,
    (select payment_request_id from dest_results where label = 'vladimir_100'),
    'https://example.com/not-monzo'),
  '22023', null,
  'one-off destination rejects a non-Monzo URL'
);

select lives_ok(
  format(
    $$select public.attach_monzo_one_off_payment_destination(%L::uuid, %L)$$,
    (select payment_request_id from dest_results where label = 'vladimir_100'),
    'https://monzo.com/pay/r/synthetic-v-oneoff-100'),
  'Vladimir can attach a one-off URL when his GBP 100 reusable destination is absent'
);

select throws_ok(
  format(
    $$select public.attach_monzo_one_off_payment_destination(%L::uuid, %L)$$,
    (select payment_request_id from dest_results where label = 'vladimir_50'),
    'https://monzo.com/pay/r/synthetic-v-oneoff-50'),
  '22023', null,
  'one-off cannot override Vladimir existing reusable GBP 50 destination'
);

select throws_ok(
  format(
    $$select public.attach_monzo_one_off_payment_destination(%L::uuid, %L)$$,
    (select payment_request_id from dest_results where label = 'kristina_150'),
    'https://monzo.com/pay/r/synthetic-v-oneoff-100'),
  '22023', null,
  'one-off URL already used by Vladimir cannot be reused by Kristina or another request'
);
reset role;

set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
select is(
  public.resolve_monzo_deposit_redirect(
    (select public_id from dest_results where label = 'vladimir_100')),
  'https://monzo.com/pay/r/synthetic-v-oneoff-100',
  'the Vladimir one-off serves exactly the Vladimir GBP 100 request after attachment'
);
reset role;

select is(
  (select d.artist_id from public.payment_request_payment_destinations d
   where d.payment_request_id =
     (select payment_request_id from dest_results where label = 'vladimir_100')),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'the one-off row is bound to the payment request artist'
);
select is(
  (select d.amount from public.payment_request_payment_destinations d
   where d.payment_request_id =
     (select payment_request_id from dest_results where label = 'vladimir_100')),
  100.00::numeric,
  'the one-off row copies the authoritative request amount rather than browser input'
);
select is(
  (select count(*)::int from public.monzo_payment_destinations d
   where d.payment_url = 'https://monzo.com/pay/r/synthetic-v-oneoff-100'),
  0,
  'a one-off URL is never promoted into the reusable catalogue'
);

-- ---------------------------------------------------------------------------
-- Scope and settlement boundaries
-- ---------------------------------------------------------------------------

select ok(
  to_regclass('public.session_deposit_groups') is null
  and to_regclass('public.session_deposit_group_members') is null
  and to_regprocedure('public.request_grouped_session_deposit(uuid[],uuid,text)') is null
  and to_regprocedure('public.get_session_deposit_group(uuid)') is null,
  'grouped deposits remain out of scope for this migration'
);

select is(
  (select count(*)::int from public.payment_transactions t
   where t.artist_id in ('a1111111-1111-4111-8111-111111111111',
                         'a2222222-2222-4222-8222-222222222222')),
  0,
  'creating requests, resolving links and attaching one-off URLs write no ledger entry'
);

select is(
  (select count(*)::int from public.payment_requests r
   where r.id in (select payment_request_id from dest_results)
     and r.status <> 'pending'),
  0,
  'all test payment requests remain pending without explicit Confirm payment'
);

select ok(
  (select bool_and(relrowsecurity and relforcerowsecurity)
   from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in ('monzo_payment_destinations', 'payment_request_payment_destinations')),
  'both destination tables have RLS enabled and forced'
);

select ok(
  not has_table_privilege('authenticated', 'public.monzo_payment_destinations', 'select')
  and not has_table_privilege('service_role', 'public.monzo_payment_destinations', 'select')
  and not has_table_privilege('authenticated', 'public.payment_request_payment_destinations', 'select')
  and not has_table_privilege('service_role', 'public.payment_request_payment_destinations', 'select'),
  'reusable and one-off destination rows have no direct browser or service-role table grants'
);

select ok(
  not has_function_privilege('anon', 'public.attach_monzo_one_off_payment_destination(uuid,text)', 'execute')
  and has_function_privilege('authenticated', 'public.attach_monzo_one_off_payment_destination(uuid,text)', 'execute')
  and not has_function_privilege('service_role', 'public.attach_monzo_one_off_payment_destination(uuid,text)', 'execute'),
  'one-off attachment is authenticated finance surface only'
);

select ok(
  not has_function_privilege('anon', 'crm_private.resolve_monzo_payment_destination(uuid,uuid,text,numeric,text)', 'execute')
  and not has_function_privilege('authenticated', 'crm_private.resolve_monzo_payment_destination(uuid,uuid,text,numeric,text)', 'execute')
  and not has_function_privilege('service_role', 'crm_private.resolve_monzo_payment_destination(uuid,uuid,text,numeric,text)', 'execute'),
  'destination helper remains closed to every API role'
);

select * from finish();
rollback;
