-- 215_monzo_artist_payment_destinations.sql
--
-- Synthetic-only validation of the second-artist payment architecture:
-- artist-scoped reusable destinations with no cross-artist fallback, grouped
-- session deposits whose total is server-derived, and a request-specific
-- one-off destination that never enters the reusable catalogue.
--
-- Nothing here settles a payment. Every assertion that touches money proves
-- the opposite: links, candidates and matches leave the ledger empty.

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

-- Two clients, one per artist, so no fixture accidentally shares a client.
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

-- Vladimir: one 60-minute session (GBP 50).
-- Kristina: one 60-minute session (GBP 50) plus three full-day sessions
--           (GBP 250 each) used for the grouped-deposit assertions.
insert into public.sessions (id, project_id, artist_id, status, start_at, end_at) values
  ('e9611111-1111-4111-8111-111111111111', 'e9511111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'proposed',
   date_trunc('day', now()) + interval '50 days 10 hours',
   date_trunc('day', now()) + interval '50 days 11 hours'),
  ('e9622222-2222-4222-8222-222222222222', 'e9522222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222', 'proposed',
   date_trunc('day', now()) + interval '51 days 10 hours',
   date_trunc('day', now()) + interval '51 days 11 hours'),
  ('e9633333-3333-4333-8333-333333333333', 'e9522222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222', 'proposed',
   date_trunc('day', now()) + interval '52 days 9 hours',
   date_trunc('day', now()) + interval '52 days 19 hours'),
  ('e9644444-4444-4444-8444-444444444444', 'e9522222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222', 'proposed',
   date_trunc('day', now()) + interval '53 days 9 hours',
   date_trunc('day', now()) + interval '53 days 19 hours'),
  ('e9655555-5555-4555-8555-555555555555', 'e9522222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222', 'proposed',
   date_trunc('day', now()) + interval '54 days 9 hours',
   date_trunc('day', now()) + interval '54 days 19 hours');

-- Both artists are configured through the same existing finance RPC. Nothing
-- in this suite treats one artist as the default.
set local role authenticated;
select pg_temp.as_owner();
select lives_ok(
  $$select public.configure_monzo_easy_bank_transfer(
      'a1111111-1111-4111-8111-111111111111',
      'https://monzo.com/pay/r/synthetic-v-250', true)$$,
  'the first artist configures Monzo through the existing finance RPC'
);
select lives_ok(
  $$select public.configure_monzo_easy_bank_transfer(
      'a2222222-2222-4222-8222-222222222222',
      'https://monzo.com/pay/r/synthetic-k-250', true)$$,
  'a second artist configures Monzo through the same RPC with no code change'
);
reset role;

select isnt(
  (select i.integration_key from public.artist_integrations i
   where i.artist_id = 'a1111111-1111-4111-8111-111111111111'
     and i.provider = 'monzo_easy_bank_transfer'),
  (select i.integration_key from public.artist_integrations i
   where i.artist_id = 'a2222222-2222-4222-8222-222222222222'
     and i.provider = 'monzo_easy_bank_transfer'),
  'each artist derives its own deterministic provider account key'
);

-- ---------------------------------------------------------------------------
-- Reusable destinations are artist-scoped and amount-generic
-- ---------------------------------------------------------------------------

insert into public.monzo_payment_destinations (artist_id, amount, currency, payment_url) values
  ('a1111111-1111-4111-8111-111111111111',  50.00, 'GBP', 'https://monzo.com/pay/r/synthetic-v-50'),
  ('a2222222-2222-4222-8222-222222222222',  50.00, 'GBP', 'https://monzo.com/pay/r/synthetic-k-50'),
  ('a2222222-2222-4222-8222-222222222222', 250.00, 'GBP', 'https://monzo.com/pay/r/synthetic-k-250-tier'),
  -- A grouped total is an ordinary catalogue row, not a schema change.
  ('a2222222-2222-4222-8222-222222222222', 750.00, 'GBP', 'https://monzo.com/pay/r/synthetic-k-750');

select lives_ok(
  $$insert into public.monzo_payment_destinations (artist_id, amount, currency, payment_url)
    values ('a2222222-2222-4222-8222-222222222222', 600.00, 'GBP',
            'https://monzo.com/pay/r/synthetic-k-600')$$,
  'a new supported amount is added as a row, with no migration to the catalogue shape'
);

select throws_ok(
  $$insert into public.monzo_payment_destinations (artist_id, amount, currency, payment_url)
    values ('a2222222-2222-4222-8222-222222222222', 0.00, 'GBP',
            'https://monzo.com/pay/r/synthetic-k-zero')$$,
  '23514', null,
  'a non-positive reusable amount is still rejected'
);

select throws_ok(
  $$insert into public.monzo_payment_destinations (artist_id, amount, currency, payment_url)
    values ('a2222222-2222-4222-8222-222222222222', 500.00, 'GBP',
            'https://example.com/pay/r/not-monzo')$$,
  '23514', null,
  'a destination that is not an exact Monzo payment URL is rejected'
);

-- ---------------------------------------------------------------------------
-- Single-session deposits: server-derived amount, artist-bound destination
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
  ('kristina_50', (public.request_session_deposit(
     'e9622222-2222-4222-8222-222222222222',
     'e9722222-2222-4222-8222-222222222222', 'copy_link') ->> 'payment_request_id')::uuid);
reset role;

select is(
  (select r.amount from public.payment_requests r
   where r.id = (select payment_request_id from dest_results where label = 'kristina_50')),
  50.00::numeric,
  'the second artist deposit amount is derived from the session duration, not supplied'
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
  'the first artist GBP 50 request resolves only to its own destination'
);
select is(
  public.resolve_monzo_deposit_redirect(
    (select public_id from dest_results where label = 'kristina_50')),
  'https://monzo.com/pay/r/synthetic-k-50',
  'the second artist GBP 50 request resolves only to its own destination'
);
reset role;

select isnt(
  (select d.payment_url from public.monzo_payment_destinations d
   where d.artist_id = 'a1111111-1111-4111-8111-111111111111' and d.amount = 50.00),
  (select d.payment_url from public.monzo_payment_destinations d
   where d.artist_id = 'a2222222-2222-4222-8222-222222222222' and d.amount = 50.00),
  'the two artists hold completely separate URLs for the same amount'
);

-- An artist with no destination for an amount fails closed. It must never
-- borrow the other artist's URL, and it must never fall back to the legacy
-- GBP 250 compatibility destination for a different amount.
select is(
  crm_private.resolve_monzo_payment_destination(
    'a1111111-1111-4111-8111-111111111111',
    (select payment_request_id from dest_results where label = 'vladimir_50'),
    'monzo_ebt_' || replace('a1111111-1111-4111-8111-111111111111', '-', ''),
    750.00, 'GBP'),
  null,
  'an artist with no destination for an amount fails closed instead of borrowing one'
);
select is(
  crm_private.resolve_monzo_payment_destination(
    'a1111111-1111-4111-8111-111111111111',
    (select payment_request_id from dest_results where label = 'vladimir_50'),
    'monzo_ebt_' || replace('a2222222-2222-4222-8222-222222222222', '-', ''),
    50.00, 'GBP'),
  null,
  'one artist cannot resolve a destination through the other artist provider account key'
);

-- ---------------------------------------------------------------------------
-- Grouped deposits
-- ---------------------------------------------------------------------------

create temporary table group_results (
  label text primary key,
  payload jsonb not null
);
grant select, insert on group_results to authenticated;
grant select on group_results to service_role;

set local role authenticated;
select pg_temp.as_owner();

-- Three full days for one artist, one client and one project: GBP 750.
insert into group_results (label, payload) values
  ('kristina_750', public.request_grouped_session_deposit(
     array['e9633333-3333-4333-8333-333333333333',
           'e9644444-4444-4444-8444-444444444444',
           'e9655555-5555-4555-8555-555555555555']::uuid[],
     'e9811111-1111-4111-8111-111111111111', 'copy_link'));

select is(
  (select (payload ->> 'amount')::numeric from group_results where label = 'kristina_750'),
  750.00::numeric,
  'a grouped deposit total is the sum of the server-derived per-session amounts'
);
select is(
  (select (payload ->> 'session_count')::integer from group_results where label = 'kristina_750'),
  3,
  'the grouped deposit records exactly the requested appointments'
);

-- Replaying the same idempotency key returns the same group and request.
select is(
  (public.request_grouped_session_deposit(
     array['e9655555-5555-4555-8555-555555555555',
           'e9633333-3333-4333-8333-333333333333',
           'e9644444-4444-4444-8444-444444444444']::uuid[],
     'e9811111-1111-4111-8111-111111111111', 'copy_link') ->> 'payment_request_id')::uuid,
  (select (payload ->> 'payment_request_id')::uuid from group_results where label = 'kristina_750'),
  'grouped deposit creation is idempotent regardless of appointment order'
);

select throws_ok(
  $$select public.request_grouped_session_deposit(
      array['e9633333-3333-4333-8333-333333333333',
            'e9644444-4444-4444-8444-444444444444']::uuid[],
      'e9822222-2222-4222-8222-222222222222', 'copy_link')$$,
  '22023', null,
  'an appointment already covered by a live group cannot be grouped again'
);

select throws_ok(
  $$select public.request_grouped_session_deposit(
      array['e9611111-1111-4111-8111-111111111111',
            'e9622222-2222-4222-8222-222222222222']::uuid[],
      'e9833333-3333-4333-8333-333333333333', 'copy_link')$$,
  '22023', null,
  'appointments from two artists and two clients cannot share one grouped deposit'
);

select throws_ok(
  $$select public.request_grouped_session_deposit(
      array['e9622222-2222-4222-8222-222222222222']::uuid[],
      'e9844444-4444-4444-8444-444444444444', 'copy_link')$$,
  '22023', null,
  'a grouped deposit needs at least two distinct appointments'
);
reset role;

select is(
  (select count(*)::int from public.session_deposit_group_members m
   join public.session_deposit_groups g on g.id = m.group_id
   where g.payment_request_id =
     (select (payload ->> 'payment_request_id')::uuid from group_results where label = 'kristina_750')),
  3,
  'coverage is normalized: one member row per covered appointment'
);
select is(
  (select sum(m.amount) from public.session_deposit_group_members m
   join public.session_deposit_groups g on g.id = m.group_id
   where g.payment_request_id =
     (select (payload ->> 'payment_request_id')::uuid from group_results where label = 'kristina_750')),
  750.00::numeric,
  'member amounts reconcile exactly to the grouped total'
);
select is(
  (select r.session_id from public.payment_requests r
   where r.id = (select (payload ->> 'payment_request_id')::uuid
                 from group_results where label = 'kristina_750')),
  null,
  'a grouped deposit is a project-level request, not a single-session request'
);

-- Opaque link ids are captured by the privileged migration owner, because the
-- backend role deliberately has no direct table grant anywhere.
create temporary table group_links (label text primary key, public_id uuid not null);
grant select on group_links to service_role;

insert into group_links (label, public_id)
select g.label, l.public_id
from group_results g
join public.payment_request_links l
  on l.payment_request_id = (g.payload ->> 'payment_request_id')::uuid;

-- The grouped total resolves to the artist reusable GBP 750 destination.
set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
select is(
  public.resolve_monzo_deposit_redirect(
    (select public_id from group_links where label = 'kristina_750')),
  'https://monzo.com/pay/r/synthetic-k-750',
  'a grouped GBP 750 deposit resolves to that artist GBP 750 destination'
);
reset role;

-- A session covered by a live group cannot also get its own deposit request.
set local role authenticated;
select pg_temp.as_owner();
select throws_ok(
  $$select public.request_session_deposit(
      'e9633333-3333-4333-8333-333333333333',
      'e9855555-5555-4555-8555-555555555555', 'copy_link')$$,
  '22023', null,
  'a grouped appointment cannot also raise its own single-session deposit'
);
reset role;

-- ---------------------------------------------------------------------------
-- One-off destination for an uncovered legitimate amount
-- ---------------------------------------------------------------------------

-- Two full days plus one hour is GBP 550, an amount with no reusable row.
insert into public.sessions (id, project_id, artist_id, status, start_at, end_at) values
  ('e9666666-6666-4666-8666-666666666666', 'e9522222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222', 'proposed',
   date_trunc('day', now()) + interval '60 days 9 hours',
   date_trunc('day', now()) + interval '60 days 19 hours'),
  ('e9677777-7777-4777-8777-777777777777', 'e9522222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222', 'proposed',
   date_trunc('day', now()) + interval '61 days 9 hours',
   date_trunc('day', now()) + interval '61 days 19 hours'),
  ('e9688888-8888-4888-8888-888888888888', 'e9522222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222', 'proposed',
   date_trunc('day', now()) + interval '62 days 10 hours',
   date_trunc('day', now()) + interval '62 days 11 hours');

set local role authenticated;
select pg_temp.as_owner();
insert into group_results (label, payload) values
  ('kristina_550', public.request_grouped_session_deposit(
     array['e9666666-6666-4666-8666-666666666666',
           'e9677777-7777-4777-8777-777777777777',
           'e9688888-8888-4888-8888-888888888888']::uuid[],
     'e9911111-1111-4111-8111-111111111111', 'copy_link'));
reset role;

select is(
  (select (payload ->> 'amount')::numeric from group_results where label = 'kristina_550'),
  550.00::numeric,
  'mixed durations produce a legitimate total with no reusable destination'
);

insert into group_links (label, public_id)
select g.label, l.public_id
from group_results g
join public.payment_request_links l
  on l.payment_request_id = (g.payload ->> 'payment_request_id')::uuid
where g.label = 'kristina_550';

-- Before a one-off is attached the link fails closed rather than routing to a
-- different amount or to the legacy GBP 250 compatibility URL.
set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
select throws_ok(
  format(
    $$select public.resolve_monzo_deposit_redirect(%L::uuid)$$,
    (select public_id from group_links where label = 'kristina_550')),
  '22023', null,
  'an uncovered amount fails closed instead of routing to a mismatched destination'
);
reset role;

set local role authenticated;
select pg_temp.as_owner();
select lives_ok(
  format(
    $$select public.attach_monzo_one_off_payment_destination(%L::uuid, %L)$$,
    (select (payload ->> 'payment_request_id')::uuid from group_results where label = 'kristina_550'),
    'https://monzo.com/pay/r/synthetic-k-oneoff-550'),
  'an authorised finance user may attach a one-off destination to that request'
);

-- A one-off may not override an amount the catalogue already covers.
select throws_ok(
  format(
    $$select public.attach_monzo_one_off_payment_destination(%L::uuid, %L)$$,
    (select (payload ->> 'payment_request_id')::uuid from group_results where label = 'kristina_750'),
    'https://monzo.com/pay/r/synthetic-k-oneoff-750'),
  '22023', null,
  'a one-off cannot override an amount that already has a reusable destination'
);

-- The one-off URL may not be reused for any other request.
select throws_ok(
  format(
    $$select public.attach_monzo_one_off_payment_destination(%L::uuid, %L)$$,
    (select payment_request_id from dest_results where label = 'kristina_50'),
    'https://monzo.com/pay/r/synthetic-k-oneoff-550'),
  '22023', null,
  'a one-off URL cannot be attached to a second payment request'
);
reset role;

set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
select is(
  public.resolve_monzo_deposit_redirect(
    (select public_id from group_links where label = 'kristina_550')),
  'https://monzo.com/pay/r/synthetic-k-oneoff-550',
  'the one-off destination serves only its own payment request'
);
reset role;

select is(
  (select count(*)::int from public.monzo_payment_destinations d
   where d.payment_url = 'https://monzo.com/pay/r/synthetic-k-oneoff-550'),
  0,
  'a one-off destination is never promoted into the reusable catalogue'
);

-- ---------------------------------------------------------------------------
-- Nothing above settled anything
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from public.payment_transactions t
   where t.artist_id in ('a1111111-1111-4111-8111-111111111111',
                         'a2222222-2222-4222-8222-222222222222')),
  0,
  'requesting deposits, opening links and attaching a one-off write no ledger entry'
);
select is(
  (select count(*)::int from public.payment_requests r
   where r.artist_id in ('a1111111-1111-4111-8111-111111111111',
                         'a2222222-2222-4222-8222-222222222222')
     and r.status <> 'pending'),
  0,
  'no payment request left pending status without an explicit human confirmation'
);
select ok(
  (select l.open_count from public.payment_request_links l
   where l.payment_request_id = (select payment_request_id from dest_results where label = 'kristina_50')) > 0,
  'opening a link records only navigation metadata'
);

-- ---------------------------------------------------------------------------
-- Closed surfaces
-- ---------------------------------------------------------------------------

select ok(
  (select bool_and(relrowsecurity and relforcerowsecurity)
   from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in (
       'monzo_payment_destinations',
       'payment_request_payment_destinations',
       'session_deposit_groups',
       'session_deposit_group_members')),
  'every new payment routing table has row level security enabled and forced'
);

select ok(
  not has_table_privilege('authenticated', 'public.payment_request_payment_destinations', 'select')
  and not has_table_privilege('service_role', 'public.payment_request_payment_destinations', 'select')
  and not has_table_privilege('authenticated', 'public.session_deposit_groups', 'select')
  and not has_table_privilege('service_role', 'public.session_deposit_groups', 'select')
  and not has_table_privilege('authenticated', 'public.session_deposit_group_members', 'select')
  and not has_table_privilege('service_role', 'public.session_deposit_group_members', 'select'),
  'no new routing table is directly readable by a browser or backend API role'
);

select ok(
  not has_function_privilege('anon', 'public.request_grouped_session_deposit(uuid[],uuid,text)', 'execute')
  and has_function_privilege('authenticated', 'public.request_grouped_session_deposit(uuid[],uuid,text)', 'execute')
  and not has_function_privilege('service_role', 'public.request_grouped_session_deposit(uuid[],uuid,text)', 'execute')
  and not has_function_privilege('anon', 'public.attach_monzo_one_off_payment_destination(uuid,text)', 'execute')
  and has_function_privilege('authenticated', 'public.attach_monzo_one_off_payment_destination(uuid,text)', 'execute')
  and not has_function_privilege('service_role', 'public.attach_monzo_one_off_payment_destination(uuid,text)', 'execute'),
  'the new finance RPCs are authenticated-only and never backend-callable'
);

select ok(
  not has_function_privilege('anon', 'crm_private.resolve_monzo_payment_destination(uuid,uuid,text,numeric,text)', 'execute')
  and not has_function_privilege('authenticated', 'crm_private.resolve_monzo_payment_destination(uuid,uuid,text,numeric,text)', 'execute')
  and not has_function_privilege('service_role', 'crm_private.resolve_monzo_payment_destination(uuid,uuid,text,numeric,text)', 'execute'),
  'destination resolution itself stays out of every API role'
);

select * from finish();
rollback;
