-- 218_monzo_destination_catalogue_management.sql
--
-- Synthetic validation of migration 0067: the reusable Monzo destination
-- catalogue is managed from CRM, any positive supported GBP amount is an
-- ordinary catalogue row, and every issued payment request keeps the exact
-- destination it was issued with.
--
-- Every URL here is synthetic. No real provider destination appears in Git.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated, service_role;

create function pg_temp.as_owner() returns void language sql as $$
  select pg_temp.claims('{"sub":"f1111111-1111-4111-8111-111111111111","role":"authenticated"}');
$$;
grant execute on function pg_temp.as_owner() to authenticated, service_role;

-- A manager with finance authority for Kristina only.
create function pg_temp.as_kristina_finance() returns void language sql as $$
  select pg_temp.claims('{"sub":"f1222222-2222-4222-8222-222222222222","role":"authenticated"}');
$$;
grant execute on function pg_temp.as_kristina_finance() to authenticated, service_role;

insert into auth.users (id, email) values
  ('f1111111-1111-4111-8111-111111111111', 'catalogue-owner@example.test'),
  ('f1222222-2222-4222-8222-222222222222', 'catalogue-kristina-finance@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('f1111111-1111-4111-8111-111111111111', 'catalogue-owner@example.test',
   'Catalogue Owner', 'owner', true),
  ('f1222222-2222-4222-8222-222222222222', 'catalogue-kristina-finance@example.test',
   'Kristina Finance Manager', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('f1222222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222',
   'manager', true, true, true, false, true)
on conflict do nothing;

insert into public.clients (id, full_name, email) values
  ('f1311111-1111-4111-8111-111111111111', 'Catalogue V Client', 'cat-v@example.test'),
  ('f1322222-2222-4222-8222-222222222222', 'Catalogue K Client', 'cat-k@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values
  ('f1411111-1111-4111-8111-111111111111', 'f1311111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'PENDING',
   'f1511111-1111-4111-8111-111111111111', repeat('c', 64),
   'accepted', 'complete', 'Catalogue V Client', 'cat-v@example.test',
   '2026-07-29', now()),
  ('f1422222-2222-4222-8222-222222222222', 'f1322222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222', 'PENDING',
   'f1522222-2222-4222-8222-222222222222', repeat('d', 64),
   'accepted', 'complete', 'Catalogue K Client', 'cat-k@example.test',
   '2026-07-29', now());

insert into public.projects (id, client_id, enquiry_id, artist_id, title, status, currency) values
  ('f1611111-1111-4111-8111-111111111111', 'f1311111-1111-4111-8111-111111111111',
   'f1411111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'Catalogue V Project', 'active', 'GBP'),
  ('f1622222-2222-4222-8222-222222222222', 'f1322222-2222-4222-8222-222222222222',
   'f1422222-2222-4222-8222-222222222222', 'a2222222-2222-4222-8222-222222222222',
   'Catalogue K Project', 'active', 'GBP');

-- Four one-hour Vladimir sessions all price to the same GBP 50 duration tier,
-- so they differ only in when their deposit request is issued.
insert into public.sessions (id, project_id, artist_id, status, start_at, end_at) values
  ('f1711111-1111-4111-8111-111111111111', 'f1611111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'proposed',
   date_trunc('day', now()) + interval '60 days 10 hours',
   date_trunc('day', now()) + interval '60 days 11 hours'),
  ('f1712222-2222-4222-8222-222222222222', 'f1611111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'proposed',
   date_trunc('day', now()) + interval '61 days 10 hours',
   date_trunc('day', now()) + interval '61 days 11 hours'),
  ('f1713333-3333-4333-8333-333333333333', 'f1611111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'proposed',
   date_trunc('day', now()) + interval '62 days 10 hours',
   date_trunc('day', now()) + interval '62 days 11 hours'),
  ('f1714444-4444-4444-8444-444444444444', 'f1611111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'proposed',
   date_trunc('day', now()) + interval '63 days 10 hours',
   date_trunc('day', now()) + interval '63 days 11 hours'),
  ('f1722222-2222-4222-8222-222222222222', 'f1622222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222', 'proposed',
   date_trunc('day', now()) + interval '64 days 10 hours',
   date_trunc('day', now()) + interval '64 days 11 hours');

set local role authenticated;
select pg_temp.as_owner();
select lives_ok(
  $$select public.configure_monzo_easy_bank_transfer(
      'a1111111-1111-4111-8111-111111111111',
      'https://monzo.com/pay/r/synthetic-cat-v-250', true)$$,
  'Vladimir has his own enabled Monzo route'
);
select lives_ok(
  $$select public.configure_monzo_easy_bank_transfer(
      'a2222222-2222-4222-8222-222222222222',
      'https://monzo.com/pay/r/synthetic-cat-k-250', true)$$,
  'Kristina has her own enabled Monzo route'
);
reset role;

-- ---------------------------------------------------------------------------
-- Arbitrary amounts are ordinary catalogue rows
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.as_owner();

select lives_ok(
  $$select public.upsert_monzo_payment_destination(
      'a1111111-1111-4111-8111-111111111111', 625.00,
      'https://monzo.com/pay/r/synthetic-cat-v-625')$$,
  'GBP 625 needs no schema change and no special case'
);
select lives_ok(
  $$select public.upsert_monzo_payment_destination(
      'a1111111-1111-4111-8111-111111111111', 1135.50,
      'https://monzo.com/pay/r/synthetic-cat-v-1135-50')$$,
  'a non-round arbitrary amount is also an ordinary catalogue row'
);
select lives_ok(
  $$select public.upsert_monzo_payment_destination(
      'a1111111-1111-4111-8111-111111111111', 50.00,
      'https://monzo.com/pay/r/synthetic-cat-v-50-a')$$,
  'the GBP 50 duration-tier amount is managed through the same generic RPC'
);

select throws_ok(
  $$select public.upsert_monzo_payment_destination(
      'a1111111-1111-4111-8111-111111111111', 0,
      'https://monzo.com/pay/r/synthetic-cat-v-zero')$$,
  '22023', null,
  'a non-positive reusable amount is rejected'
);
select throws_ok(
  $$select public.upsert_monzo_payment_destination(
      'a1111111-1111-4111-8111-111111111111', -100.00,
      'https://monzo.com/pay/r/synthetic-cat-v-negative')$$,
  '22023', null,
  'a negative reusable amount is rejected'
);
select throws_ok(
  $$select public.upsert_monzo_payment_destination(
      'a1111111-1111-4111-8111-111111111111', 200.00,
      'https://example.com/pay/r/not-monzo')$$,
  '22023', null,
  'a non-Monzo destination URL is rejected'
);
select throws_ok(
  $$select public.upsert_monzo_payment_destination(
      'a1111111-1111-4111-8111-111111111111', 200.00,
      'https://monzo.com/pay/r/synthetic-cat-v-625')$$,
  '22023', null,
  'one URL cannot serve two catalogue amounts'
);

reset role;

-- Two artists may hold the same amount with different destinations.
set local role authenticated;
select pg_temp.as_kristina_finance();
select lives_ok(
  $$select public.upsert_monzo_payment_destination(
      'a2222222-2222-4222-8222-222222222222', 625.00,
      'https://monzo.com/pay/r/synthetic-cat-k-625')$$,
  'Kristina holds her own GBP 625 destination'
);
select throws_ok(
  $$select public.upsert_monzo_payment_destination(
      'a2222222-2222-4222-8222-222222222222', 700.00,
      'https://monzo.com/pay/r/synthetic-cat-v-625')$$,
  '22023', null,
  'one artist cannot claim another artist URL'
);

-- Cross-artist authorization
select throws_ok(
  $$select public.upsert_monzo_payment_destination(
      'a1111111-1111-4111-8111-111111111111', 900.00,
      'https://monzo.com/pay/r/synthetic-cat-cross-900')$$,
  '42501', null,
  'Kristina finance authority cannot mutate the Vladimir catalogue'
);
select throws_ok(
  $$select public.list_monzo_payment_destinations(
      'a1111111-1111-4111-8111-111111111111')$$,
  '42501', null,
  'Kristina finance authority cannot read the Vladimir catalogue'
);
reset role;

-- Archival is scoped by the destination row's own artist, so restating a scope
-- cannot aim it at another artist either.
create temporary table vladimir_625 as
select id
from public.monzo_payment_destinations
where artist_id = 'a1111111-1111-4111-8111-111111111111'
  and amount = 625.00
  and archived_at is null;
grant select on vladimir_625 to authenticated, service_role;

set local role authenticated;
select pg_temp.as_kristina_finance();
select throws_ok(
  format($$select public.archive_monzo_payment_destination(%L::uuid)$$,
         (select id from vladimir_625)),
  '42501', null,
  'Kristina finance authority cannot archive a Vladimir destination'
);
reset role;

select is(
  (select count(*)::int from public.monzo_payment_destinations
   where id = (select id from vladimir_625) and archived_at is null),
  1,
  'the refused cross-artist archive changed nothing'
);

select isnt(
  (select payment_url from public.monzo_payment_destinations
   where artist_id = 'a1111111-1111-4111-8111-111111111111'
     and amount = 625.00 and archived_at is null),
  (select payment_url from public.monzo_payment_destinations
   where artist_id = 'a2222222-2222-4222-8222-222222222222'
     and amount = 625.00 and archived_at is null),
  'the same amount resolves to a different destination per artist'
);

-- The management read never hands a provider URL to the browser.
set local role authenticated;
select pg_temp.as_owner();
create temporary table catalogue_read as
select public.list_monzo_payment_destinations(
  'a1111111-1111-4111-8111-111111111111') as payload;
grant select on catalogue_read to authenticated, service_role;
reset role;

select ok(
  (select payload::text from catalogue_read) not like '%monzo.com%',
  'the catalogue read returns no provider URL'
);
select is(
  (select jsonb_array_length(payload -> 'destinations')::int from catalogue_read),
  3,
  'the catalogue read lists exactly the live Vladimir destinations'
);

-- ---------------------------------------------------------------------------
-- Request-bound destination snapshots
-- ---------------------------------------------------------------------------

create temporary table cat_results (
  label text primary key,
  payment_request_id uuid not null,
  public_id uuid
);
grant select, insert, update on cat_results to authenticated, service_role;

set local role authenticated;
select pg_temp.as_owner();
insert into cat_results (label, payment_request_id) values
  ('before_replace', (public.request_session_deposit(
     'f1711111-1111-4111-8111-111111111111',
     'f1811111-1111-4111-8111-111111111111', 'copy_link') ->> 'payment_request_id')::uuid);
reset role;

select is(
  (select d.source from public.payment_request_payment_destinations d
   where d.payment_request_id =
     (select payment_request_id from cat_results where label = 'before_replace')),
  'reusable',
  'an issued request snapshots the reusable destination it was issued with'
);
select is(
  (select d.payment_url from public.payment_request_payment_destinations d
   where d.payment_request_id =
     (select payment_request_id from cat_results where label = 'before_replace')),
  'https://monzo.com/pay/r/synthetic-cat-v-50-a',
  'the snapshot copies the exact destination in force at issue time'
);

-- Replace the reusable GBP 50 destination.
set local role authenticated;
select pg_temp.as_owner();
select is(
  (public.upsert_monzo_payment_destination(
     'a1111111-1111-4111-8111-111111111111', 50.00,
     'https://monzo.com/pay/r/synthetic-cat-v-50-b') ->> 'replaced')::boolean,
  true,
  'replacing a reusable destination reports the replacement'
);

insert into cat_results (label, payment_request_id) values
  ('after_replace', (public.request_session_deposit(
     'f1712222-2222-4222-8222-222222222222',
     'f1812222-2222-4222-8222-222222222222', 'copy_link') ->> 'payment_request_id')::uuid);

-- A reusable destination is shared by design: every request for that artist and
-- amount snapshots the same URL. Only a request-specific one-off is exclusive.
insert into cat_results (label, payment_request_id) values
  ('shares_after_replace', (public.request_session_deposit(
     'f1714444-4444-4444-8444-444444444444',
     'f1814444-4444-4444-8444-444444444444', 'copy_link') ->> 'payment_request_id')::uuid);
reset role;

select is(
  (select count(distinct d.payment_request_id)::int
   from public.payment_request_payment_destinations d
   where d.payment_url = 'https://monzo.com/pay/r/synthetic-cat-v-50-b'
     and d.source = 'reusable'),
  2,
  'two requests for the same amount both snapshot the same reusable destination'
);

update cat_results d
set public_id = l.public_id
from public.payment_request_links l
where l.payment_request_id = d.payment_request_id;

set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
select is(
  public.resolve_monzo_deposit_redirect(
    (select public_id from cat_results where label = 'before_replace')),
  'https://monzo.com/pay/r/synthetic-cat-v-50-a',
  'an already issued request still resolves to its original destination'
);
select is(
  public.resolve_monzo_deposit_redirect(
    (select public_id from cat_results where label = 'after_replace')),
  'https://monzo.com/pay/r/synthetic-cat-v-50-b',
  'a request issued after the replacement resolves to the new destination'
);
reset role;

select is(
  (select count(*)::int from public.monzo_payment_destinations
   where artist_id = 'a1111111-1111-4111-8111-111111111111'
     and amount = 50.00 and archived_at is not null),
  1,
  'the superseded destination is archived rather than deleted'
);

select throws_ok(
  $$delete from public.monzo_payment_destinations
    where payment_url = 'https://monzo.com/pay/r/synthetic-cat-v-50-a'$$,
  '42501', null,
  'a reusable destination can never be deleted outright'
);

-- Archiving affects future resolution only. The catalogue table itself is not
-- browser-readable, so the id is captured in the privileged fixture context and
-- handed to the authenticated caller through a temporary table.
create temporary table live_fifty as
select id
from public.monzo_payment_destinations
where artist_id = 'a1111111-1111-4111-8111-111111111111'
  and amount = 50.00
  and archived_at is null;
grant select on live_fifty to authenticated, service_role;

select is((select count(*)::int from live_fifty), 1,
  'exactly one live GBP 50 Vladimir destination remains after the replacement');

set local role authenticated;
select pg_temp.as_owner();
select is(
  (public.archive_monzo_payment_destination(
     (select id from live_fifty)) ->> 'archived')::boolean,
  true,
  'a reusable destination can be withdrawn from future use'
);
insert into cat_results (label, payment_request_id) values
  ('after_archive', (public.request_session_deposit(
     'f1713333-3333-4333-8333-333333333333',
     'f1813333-3333-4333-8333-333333333333', 'copy_link') ->> 'payment_request_id')::uuid);
reset role;

update cat_results d
set public_id = l.public_id
from public.payment_request_links l
where l.payment_request_id = d.payment_request_id
  and d.public_id is null;

select is(
  (select count(*)::int from public.payment_request_payment_destinations
   where payment_request_id =
     (select payment_request_id from cat_results where label = 'after_archive')),
  0,
  'a request issued after archival binds no destination'
);

set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
select is(
  public.resolve_monzo_deposit_redirect(
    (select public_id from cat_results where label = 'before_replace')),
  'https://monzo.com/pay/r/synthetic-cat-v-50-a',
  'archiving never breaks a request that was already issued'
);
select is(
  public.resolve_monzo_deposit_redirect(
    (select public_id from cat_results where label = 'after_replace')),
  'https://monzo.com/pay/r/synthetic-cat-v-50-b',
  'archiving never breaks the most recently issued request either'
);
select throws_ok(
  format($$select public.resolve_monzo_deposit_redirect(%L::uuid)$$,
         (select public_id from cat_results where label = 'after_archive')),
  '22023', null,
  'a request with no bound destination fails closed publicly'
);
reset role;

-- The gap can then be filled with an explicit request-specific one-off.
set local role authenticated;
select pg_temp.as_owner();
select lives_ok(
  format($$select public.attach_monzo_one_off_payment_destination(%L::uuid, %L)$$,
         (select payment_request_id from cat_results where label = 'after_archive'),
         'https://monzo.com/pay/r/synthetic-cat-v-oneoff-50'),
  'an uncovered amount accepts an explicit one-off destination'
);
select throws_ok(
  format($$select public.attach_monzo_one_off_payment_destination(%L::uuid, %L)$$,
         (select payment_request_id from cat_results where label = 'before_replace'),
         'https://monzo.com/pay/r/synthetic-cat-v-oneoff-other'),
  '22023', null,
  'a one-off cannot override a request already issued with a reusable destination'
);
reset role;

-- ---------------------------------------------------------------------------
-- Immutability of the issued snapshot and the request amount
-- ---------------------------------------------------------------------------

select throws_ok(
  format($$update public.payment_request_payment_destinations
           set payment_url = 'https://monzo.com/pay/r/synthetic-cat-v-tamper'
           where payment_request_id = %L::uuid$$,
         (select payment_request_id from cat_results where label = 'before_replace')),
  '23514', null,
  'a catalogue-derived snapshot can never be rewritten in place'
);
select throws_ok(
  format($$update public.payment_request_payment_destinations set amount = 999.00
           where payment_request_id = %L::uuid$$,
         (select payment_request_id from cat_results where label = 'before_replace')),
  '23514', null,
  'a bound snapshot amount is immutable'
);
select throws_ok(
  format($$delete from public.payment_request_payment_destinations
           where payment_request_id = %L::uuid$$,
         (select payment_request_id from cat_results where label = 'before_replace')),
  '42501', null,
  'a bound snapshot is retained evidence'
);
select throws_ok(
  format($$update public.payment_requests set amount = 999.00 where id = %L::uuid$$,
         (select payment_request_id from cat_results where label = 'before_replace')),
  '23514', null,
  'the issued request amount stays immutable'
);

-- ---------------------------------------------------------------------------
-- Cross-artist resolution and settlement boundaries
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.as_owner();
insert into cat_results (label, payment_request_id) values
  ('kristina_50', (public.request_session_deposit(
     'f1722222-2222-4222-8222-222222222222',
     'f1822222-2222-4222-8222-222222222222', 'copy_link') ->> 'payment_request_id')::uuid);
reset role;

select is(
  (select count(*)::int from public.payment_request_payment_destinations
   where payment_request_id =
     (select payment_request_id from cat_results where label = 'kristina_50')),
  0,
  'Kristina never borrows a Vladimir GBP 50 destination'
);

select is(
  crm_private.resolve_monzo_payment_destination(
    'a2222222-2222-4222-8222-222222222222',
    (select payment_request_id from cat_results where label = 'before_replace'),
    'monzo_ebt_' || replace('a2222222-2222-4222-8222-222222222222', '-', ''),
    50.00, 'GBP'),
  null,
  'one artist can never resolve another artist request snapshot'
);

select is(
  (select count(*)::int from public.payment_transactions
   where artist_id in ('a1111111-1111-4111-8111-111111111111',
                       'a2222222-2222-4222-8222-222222222222')),
  0,
  'creating, replacing, archiving, binding and opening destinations settle nothing'
);

select is(
  (select count(*)::int from public.payment_requests
   where status <> 'pending'
     and artist_id in ('a1111111-1111-4111-8111-111111111111',
                       'a2222222-2222-4222-8222-222222222222')),
  0,
  'no catalogue action moved a payment request out of pending'
);

-- ---------------------------------------------------------------------------
-- Table and function ACLs
-- ---------------------------------------------------------------------------

select ok(
  (select bool_and(relrowsecurity and relforcerowsecurity)
   from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in ('monzo_payment_destinations', 'payment_request_payment_destinations')),
  'destination tables keep forced RLS'
);
select ok(
  not has_table_privilege('authenticated', 'public.monzo_payment_destinations', 'select')
  and not has_table_privilege('authenticated', 'public.monzo_payment_destinations', 'insert')
  and not has_table_privilege('authenticated', 'public.monzo_payment_destinations', 'update')
  and not has_table_privilege('service_role', 'public.monzo_payment_destinations', 'select')
  and not has_table_privilege('authenticated', 'public.payment_request_payment_destinations', 'select')
  and not has_table_privilege('service_role', 'public.payment_request_payment_destinations', 'select'),
  'destination rows keep no direct browser or service-role table grants'
);
select ok(
  not has_function_privilege('anon', 'public.upsert_monzo_payment_destination(uuid,numeric,text)', 'execute')
  and not has_function_privilege('anon', 'public.archive_monzo_payment_destination(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.list_monzo_payment_destinations(uuid)', 'execute'),
  'anon has no reusable destination surface at all'
);
select ok(
  not has_function_privilege('anon', 'crm_private.bind_payment_request_destination(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'crm_private.bind_payment_request_destination(uuid)', 'execute')
  and not has_function_privilege('service_role', 'crm_private.bind_payment_request_destination(uuid)', 'execute'),
  'the destination binder stays closed to every API role'
);
select ok(
  not has_function_privilege('authenticated', 'public.resolve_monzo_deposit_redirect(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.resolve_monzo_deposit_redirect(uuid)', 'execute'),
  'public resolution remains backend-only'
);

select * from finish();
rollback;
