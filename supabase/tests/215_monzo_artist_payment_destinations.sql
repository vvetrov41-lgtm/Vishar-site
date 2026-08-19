-- 215_monzo_artist_payment_destinations.sql
--
-- Synthetic validation of the artist-scoped reusable and request-specific
-- one-off Monzo destination layer. Multiple Sessions has separate coverage in
-- 216; this file intentionally remains focused on destination isolation.

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

set local role authenticated;
select pg_temp.as_owner();
select lives_ok(
  $$select public.configure_monzo_easy_bank_transfer(
      'a1111111-1111-4111-8111-111111111111',
      'https://monzo.com/pay/r/synthetic-v-250', true)$$,
  'Vladimir configures his own Monzo route'
);
select lives_ok(
  $$select public.configure_monzo_easy_bank_transfer(
      'a2222222-2222-4222-8222-222222222222',
      'https://monzo.com/pay/r/synthetic-k-250', true)$$,
  'Kristina configures her own Monzo route through the same RPC'
);
reset role;

select isnt(
  (select integration_key from public.artist_integrations
   where artist_id = 'a1111111-1111-4111-8111-111111111111'
     and provider = 'monzo_easy_bank_transfer'),
  (select integration_key from public.artist_integrations
   where artist_id = 'a2222222-2222-4222-8222-222222222222'
     and provider = 'monzo_easy_bank_transfer'),
  'provider account keys remain artist-specific'
);

select ok(
  to_regclass('public.monzo_easy_bank_transfer_tier_urls') is null
  and to_regclass('public.monzo_payment_destinations') is not null,
  'the reusable catalogue uses the generic artist/amount table'
);

insert into public.monzo_payment_destinations (artist_id, amount, currency, payment_url) values
  ('a1111111-1111-4111-8111-111111111111',  50.00, 'GBP', 'https://monzo.com/pay/r/synthetic-v-50'),
  ('a2222222-2222-4222-8222-222222222222',  50.00, 'GBP', 'https://monzo.com/pay/r/synthetic-k-50'),
  ('a2222222-2222-4222-8222-222222222222', 100.00, 'GBP', 'https://monzo.com/pay/r/synthetic-k-100');

select lives_ok(
  $$insert into public.monzo_payment_destinations (artist_id, amount, currency, payment_url)
    values ('a2222222-2222-4222-8222-222222222222', 600.00, 'GBP',
            'https://monzo.com/pay/r/synthetic-k-600')$$,
  'a new exact amount is an ordinary artist-scoped catalogue row'
);

select throws_ok(
  $$insert into public.monzo_payment_destinations (artist_id, amount, currency, payment_url)
    values ('a2222222-2222-4222-8222-222222222222', 500.00, 'GBP',
            'https://example.com/pay/r/not-monzo')$$,
  '23514', null,
  'a reusable destination must be a clean Monzo URL'
);

create temporary table dest_results (
  label text primary key,
  payment_request_id uuid not null,
  public_id uuid
);
grant select, insert, update on dest_results to authenticated;
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

update dest_results d
set public_id = l.public_id
from public.payment_request_links l
where l.payment_request_id = d.payment_request_id;

select is(
  (select amount from public.payment_requests
   where id = (select payment_request_id from dest_results where label = 'vladimir_100')),
  100.00::numeric,
  'Vladimir request amount is server-derived from duration'
);
select is(
  (select amount from public.payment_requests
   where id = (select payment_request_id from dest_results where label = 'kristina_150')),
  150.00::numeric,
  'Kristina request uses the same server-owned duration policy'
);

set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
select is(
  public.resolve_monzo_deposit_redirect(
    (select public_id from dest_results where label = 'vladimir_50')),
  'https://monzo.com/pay/r/synthetic-v-50',
  'Vladimir GBP 50 resolves only to Vladimir destination'
);
select is(
  public.resolve_monzo_deposit_redirect(
    (select public_id from dest_results where label = 'kristina_50')),
  'https://monzo.com/pay/r/synthetic-k-50',
  'Kristina GBP 50 resolves only to Kristina destination'
);
select throws_ok(
  format($$select public.resolve_monzo_deposit_redirect(%L::uuid)$$,
         (select public_id from dest_results where label = 'vladimir_100')),
  '22023', null,
  'Vladimir missing GBP 100 fails closed despite Kristina GBP 100 row'
);
reset role;

select is(
  crm_private.resolve_monzo_payment_destination(
    'a1111111-1111-4111-8111-111111111111',
    (select payment_request_id from dest_results where label = 'vladimir_50'),
    'monzo_ebt_' || replace('a2222222-2222-4222-8222-222222222222', '-', ''),
    50.00, 'GBP'),
  null,
  'Vladimir cannot resolve through Kristina provider key'
);

set local role authenticated;
select pg_temp.as_owner();
select lives_ok(
  format(
    $$select public.attach_monzo_one_off_payment_destination(%L::uuid, %L)$$,
    (select payment_request_id from dest_results where label = 'vladimir_100'),
    'https://monzo.com/pay/r/synthetic-v-oneoff-100'),
  'Vladimir can attach one-off only for his uncovered exact amount'
);
select throws_ok(
  format(
    $$select public.attach_monzo_one_off_payment_destination(%L::uuid, %L)$$,
    (select payment_request_id from dest_results where label = 'vladimir_50'),
    'https://monzo.com/pay/r/synthetic-v-oneoff-50'),
  '22023', null,
  'one-off cannot override an existing reusable destination'
);
select throws_ok(
  format(
    $$select public.attach_monzo_one_off_payment_destination(%L::uuid, %L)$$,
    (select payment_request_id from dest_results where label = 'kristina_150'),
    'https://monzo.com/pay/r/synthetic-v-oneoff-100'),
  '22023', null,
  'one-off URL cannot be reused by another artist/request'
);
reset role;

set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
select is(
  public.resolve_monzo_deposit_redirect(
    (select public_id from dest_results where label = 'vladimir_100')),
  'https://monzo.com/pay/r/synthetic-v-oneoff-100',
  'one-off serves exactly its Vladimir request'
);
reset role;

select is(
  (select artist_id from public.payment_request_payment_destinations
   where payment_request_id =
     (select payment_request_id from dest_results where label = 'vladimir_100')),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'one-off row copies authoritative request artist'
);
select is(
  (select amount from public.payment_request_payment_destinations
   where payment_request_id =
     (select payment_request_id from dest_results where label = 'vladimir_100')),
  100.00::numeric,
  'one-off row copies immutable request amount'
);
select is(
  (select count(*)::int from public.monzo_payment_destinations
   where payment_url = 'https://monzo.com/pay/r/synthetic-v-oneoff-100'),
  0,
  'one-off is never promoted into reusable catalogue'
);

select is(
  (select count(*)::int from public.payment_transactions
   where artist_id in ('a1111111-1111-4111-8111-111111111111',
                       'a2222222-2222-4222-8222-222222222222')),
  0,
  'creating/opening destinations and attaching one-off writes no ledger entry'
);

select ok(
  (select bool_and(relrowsecurity and relforcerowsecurity)
   from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in ('monzo_payment_destinations', 'payment_request_payment_destinations')),
  'destination tables keep forced RLS'
);
select ok(
  not has_table_privilege('authenticated', 'public.monzo_payment_destinations', 'select')
  and not has_table_privilege('service_role', 'public.monzo_payment_destinations', 'select')
  and not has_table_privilege('authenticated', 'public.payment_request_payment_destinations', 'select')
  and not has_table_privilege('service_role', 'public.payment_request_payment_destinations', 'select'),
  'destination rows have no direct browser/service-role reads'
);
select ok(
  not has_function_privilege('anon', 'public.attach_monzo_one_off_payment_destination(uuid,text)', 'execute')
  and has_function_privilege('authenticated', 'public.attach_monzo_one_off_payment_destination(uuid,text)', 'execute')
  and not has_function_privilege('service_role', 'public.attach_monzo_one_off_payment_destination(uuid,text)', 'execute'),
  'one-off attachment remains authenticated finance surface only'
);
select ok(
  not has_function_privilege('anon', 'crm_private.resolve_monzo_payment_destination(uuid,uuid,text,numeric,text)', 'execute')
  and not has_function_privilege('authenticated', 'crm_private.resolve_monzo_payment_destination(uuid,uuid,text,numeric,text)', 'execute')
  and not has_function_privilege('service_role', 'crm_private.resolve_monzo_payment_destination(uuid,uuid,text,numeric,text)', 'execute'),
  'private destination helper stays closed to API roles'
);

select * from finish();
rollback;
