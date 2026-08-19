-- 219_project_deposit_policy.sql
--
-- Synthetic validation of migration 0067: the project deposit amount is
-- calculated server-side from project facts, the artist policy and an
-- authorised override, and only that authoritative amount can become an
-- immutable payment request.
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
  select pg_temp.claims('{"sub":"f2111111-1111-4111-8111-111111111111","role":"authenticated"}');
$$;
grant execute on function pg_temp.as_owner() to authenticated, service_role;

-- Sessions authority for Vladimir but deliberately no finance authority.
create function pg_temp.as_no_finance() returns void language sql as $$
  select pg_temp.claims('{"sub":"f2222222-2222-4222-8222-222222222222","role":"authenticated"}');
$$;
grant execute on function pg_temp.as_no_finance() to authenticated, service_role;

insert into auth.users (id, email) values
  ('f2111111-1111-4111-8111-111111111111', 'project-deposit-owner@example.test'),
  ('f2222222-2222-4222-8222-222222222222', 'project-deposit-no-finance@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('f2111111-1111-4111-8111-111111111111', 'project-deposit-owner@example.test',
   'Project Deposit Owner', 'owner', true),
  ('f2222222-2222-4222-8222-222222222222', 'project-deposit-no-finance@example.test',
   'Sessions Only Manager', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('f2222222-2222-4222-8222-222222222222',
   'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, false, true)
on conflict do nothing;

insert into public.clients (id, full_name, email) values
  ('f2311111-1111-4111-8111-111111111111', 'Project V Client', 'pd-v@example.test'),
  ('f2322222-2222-4222-8222-222222222222', 'Project K Client', 'pd-k@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values
  ('f2411111-1111-4111-8111-111111111111', 'f2311111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'PENDING',
   'f2511111-1111-4111-8111-111111111111', repeat('e', 64),
   'accepted', 'complete', 'Project V Client', 'pd-v@example.test',
   '2026-07-29', now()),
  ('f2422222-2222-4222-8222-222222222222', 'f2322222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222', 'PENDING',
   'f2522222-2222-4222-8222-222222222222', repeat('f', 64),
   'accepted', 'complete', 'Project K Client', 'pd-k@example.test',
   '2026-07-29', now());

-- Seven planned hours at an hourly rate produced these estimates. Hours and
-- planned session counts feed the estimate; they never touch the destination.
insert into public.projects (
  id, client_id, enquiry_id, artist_id, title, status, currency,
  estimated_sessions, estimated_hours, hourly_rate, estimate_total
) values
  ('f2611111-1111-4111-8111-111111111111', 'f2311111-1111-4111-8111-111111111111',
   'f2411111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'Percentage Project', 'active', 'GBP', 3, 7.00, 400.00, 2800.00),
  ('f2612222-2222-4222-8222-222222222222', 'f2311111-1111-4111-8111-111111111111',
   null, 'a1111111-1111-4111-8111-111111111111',
   'Second Percentage Project', 'active', 'GBP', 2, 6.80, 400.00, 2720.00),
  ('f2613333-3333-4333-8333-333333333333', 'f2311111-1111-4111-8111-111111111111',
   null, 'a1111111-1111-4111-8111-111111111111',
   'Override Project', 'active', 'GBP', 2, 5.00, 400.00, 2000.00),
  ('f2614444-4444-4444-8444-444444444444', 'f2311111-1111-4111-8111-111111111111',
   null, 'a1111111-1111-4111-8111-111111111111',
   'No Destination Project', 'active', 'GBP', 1, 3.00, 400.00, 1200.00),
  ('f2622222-2222-4222-8222-222222222222', 'f2322222-2222-4222-8222-222222222222',
   'f2422222-2222-4222-8222-222222222222', 'a2222222-2222-4222-8222-222222222222',
   'Kristina Project', 'active', 'GBP', 2, 4.00, 300.00, 1200.00);

set local role authenticated;
select pg_temp.as_owner();
select lives_ok(
  $$select public.configure_monzo_easy_bank_transfer(
      'a1111111-1111-4111-8111-111111111111',
      'https://monzo.com/pay/r/synthetic-pd-v-250', true)$$,
  'Vladimir has his own enabled Monzo route'
);
select lives_ok(
  $$select public.configure_monzo_easy_bank_transfer(
      'a2222222-2222-4222-8222-222222222222',
      'https://monzo.com/pay/r/synthetic-pd-k-250', true)$$,
  'Kristina has her own enabled Monzo route'
);

-- ---------------------------------------------------------------------------
-- Policy configuration and arbitrary calculated amounts
-- ---------------------------------------------------------------------------

select lives_ok(
  $$select public.preview_project_deposit('f2611111-1111-4111-8111-111111111111')$$,
  'a preview is available before a policy exists'
);

select is(
  (public.get_project_deposit_policy('a1111111-1111-4111-8111-111111111111')
     ->> 'configured')::boolean,
  false,
  'an artist starts with no project deposit policy'
);

select is(
  (public.preview_project_deposit('f2611111-1111-4111-8111-111111111111')
     ->> 'calculable')::boolean,
  false,
  'no policy means no calculable project deposit'
);

select lives_ok(
  $$select public.configure_project_deposit_policy(
      'a1111111-1111-4111-8111-111111111111',
      'percentage_of_estimate', null, 25.00, null, 1.00)$$,
  'Vladimir configures a 25 percent project deposit policy'
);

select is(
  (public.preview_project_deposit('f2611111-1111-4111-8111-111111111111')
     ->> 'amount')::numeric,
  700.00::numeric,
  '25 percent of a GBP 2800 estimate is a GBP 700 deposit'
);
select is(
  (public.preview_project_deposit('f2612222-2222-4222-8222-222222222222')
     ->> 'amount')::numeric,
  680.00::numeric,
  'the same policy produces an arbitrary GBP 680 deposit from a different estimate'
);
select is(
  (public.preview_project_deposit('f2611111-1111-4111-8111-111111111111')
     ->> 'suggested_amount')::numeric,
  700.00::numeric,
  'the suggested amount is reported separately from the final amount'
);
select is(
  (public.preview_project_deposit('f2611111-1111-4111-8111-111111111111')
     ->> 'estimated_hours')::numeric,
  7.00::numeric,
  'planned hours remain an estimate input rather than a payment input'
);

-- Kristina keeps a completely independent policy.
select lives_ok(
  $$select public.configure_project_deposit_policy(
      'a2222222-2222-4222-8222-222222222222',
      'fixed', 325.00, null, null, 1.00)$$,
  'Kristina configures an independent fixed project deposit policy'
);
select is(
  (public.preview_project_deposit('f2622222-2222-4222-8222-222222222222')
     ->> 'amount')::numeric,
  325.00::numeric,
  'a fixed policy produces its own arbitrary amount for the other artist'
);

reset role;

-- ---------------------------------------------------------------------------
-- The override is permission protected
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.as_no_finance();
select throws_ok(
  $$select public.set_project_deposit_override(
      'f2613333-3333-4333-8333-333333333333', 980.00)$$,
  '42501', null,
  'sessions authority without finance authority cannot set a project override'
);
select throws_ok(
  $$select public.request_project_deposit(
      'f2613333-3333-4333-8333-333333333333',
      'f2911111-1111-4111-8111-111111111111', 'copy_link')$$,
  '42501', null,
  'sessions authority without finance authority cannot request a project deposit'
);
reset role;

set local role authenticated;
select pg_temp.as_owner();
select lives_ok(
  $$select public.set_project_deposit_override(
      'f2613333-3333-4333-8333-333333333333', 980.00)$$,
  'finance authority may set an authorised project override'
);
select is(
  (public.preview_project_deposit('f2613333-3333-4333-8333-333333333333')
     ->> 'amount')::numeric,
  980.00::numeric,
  'an authorised override replaces the policy suggestion'
);
select is(
  (public.preview_project_deposit('f2613333-3333-4333-8333-333333333333')
     ->> 'suggested_amount')::numeric,
  500.00::numeric,
  'the policy suggestion is still reported alongside the override'
);
reset role;

-- ---------------------------------------------------------------------------
-- Reusable destinations for the calculated amounts
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.as_owner();
select lives_ok(
  $$select public.upsert_monzo_payment_destination(
      'a1111111-1111-4111-8111-111111111111', 700.00,
      'https://monzo.com/pay/r/synthetic-pd-v-700')$$,
  'the artist adds a reusable destination for the calculated GBP 700'
);
select lives_ok(
  $$select public.upsert_monzo_payment_destination(
      'a1111111-1111-4111-8111-111111111111', 980.00,
      'https://monzo.com/pay/r/synthetic-pd-v-980')$$,
  'the artist adds a reusable destination for the overridden GBP 980'
);
select is(
  (public.preview_project_deposit('f2611111-1111-4111-8111-111111111111')
     ->> 'reusable_destination_configured')::boolean,
  true,
  'the preview reports that an exact reusable destination exists'
);
select is(
  (public.preview_project_deposit('f2614444-4444-4444-8444-444444444444')
     ->> 'reusable_destination_configured')::boolean,
  false,
  'the preview reports when no exact reusable destination exists'
);
select ok(
  public.preview_project_deposit('f2611111-1111-4111-8111-111111111111')::text
    not like '%monzo.com%',
  'the project deposit preview never returns a provider URL'
);

-- ---------------------------------------------------------------------------
-- Issuing the authoritative request
-- ---------------------------------------------------------------------------

create temporary table pd_results (
  label text primary key,
  payment_request_id uuid not null,
  public_id uuid
);
grant select, insert, update on pd_results to authenticated, service_role;

insert into pd_results (label, payment_request_id) values
  ('percentage_700', (public.request_project_deposit(
     'f2611111-1111-4111-8111-111111111111',
     'f2811111-1111-4111-8111-111111111111', 'copy_link') ->> 'payment_request_id')::uuid),
  ('override_980', (public.request_project_deposit(
     'f2613333-3333-4333-8333-333333333333',
     'f2813333-3333-4333-8333-333333333333', 'copy_link') ->> 'payment_request_id')::uuid),
  ('no_destination_300', (public.request_project_deposit(
     'f2614444-4444-4444-8444-444444444444',
     'f2814444-4444-4444-8444-444444444444', 'copy_link') ->> 'payment_request_id')::uuid);
reset role;

update pd_results d
set public_id = l.public_id
from public.payment_request_links l
where l.payment_request_id = d.payment_request_id;

select is(
  (select amount from public.payment_requests
   where id = (select payment_request_id from pd_results where label = 'percentage_700')),
  700.00::numeric,
  'the issued request carries the server-calculated percentage amount'
);
select is(
  (select amount from public.payment_requests
   where id = (select payment_request_id from pd_results where label = 'override_980')),
  980.00::numeric,
  'the issued request carries the authorised override amount'
);
select is(
  (select session_id from public.payment_requests
   where id = (select payment_request_id from pd_results where label = 'percentage_700')),
  null,
  'a project deposit request is project scoped rather than session scoped'
);
select is(
  (select suggested_amount from public.project_deposit_requests
   where payment_request_id =
     (select payment_request_id from pd_results where label = 'override_980')),
  500.00::numeric,
  'the pricing snapshot retains what the policy alone would have suggested'
);
select is(
  (select estimate_total from public.project_deposit_requests
   where payment_request_id =
     (select payment_request_id from pd_results where label = 'percentage_700')),
  2800.00::numeric,
  'the pricing snapshot retains the estimate that produced the amount'
);

set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
select is(
  public.resolve_monzo_deposit_redirect(
    (select public_id from pd_results where label = 'percentage_700')),
  'https://monzo.com/pay/r/synthetic-pd-v-700',
  'the exact reusable destination serves the calculated project deposit'
);
select is(
  public.resolve_monzo_deposit_redirect(
    (select public_id from pd_results where label = 'override_980')),
  'https://monzo.com/pay/r/synthetic-pd-v-980',
  'the exact reusable destination serves the overridden project deposit'
);
select throws_ok(
  format($$select public.resolve_monzo_deposit_redirect(%L::uuid)$$,
         (select public_id from pd_results where label = 'no_destination_300')),
  '22023', null,
  'a calculated amount with no exact reusable destination fails closed'
);
reset role;

set local role authenticated;
select pg_temp.as_owner();
select lives_ok(
  format($$select public.attach_monzo_one_off_payment_destination(%L::uuid, %L)$$,
         (select payment_request_id from pd_results where label = 'no_destination_300'),
         'https://monzo.com/pay/r/synthetic-pd-v-oneoff-300'),
  'a project deposit with no reusable destination accepts an explicit one-off'
);
reset role;

set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
select is(
  public.resolve_monzo_deposit_redirect(
    (select public_id from pd_results where label = 'no_destination_300')),
  'https://monzo.com/pay/r/synthetic-pd-v-oneoff-300',
  'the explicit one-off serves exactly that project deposit request'
);
reset role;

-- ---------------------------------------------------------------------------
-- Later policy and override changes never reprice an issued request
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.as_owner();
select lives_ok(
  $$select public.configure_project_deposit_policy(
      'a1111111-1111-4111-8111-111111111111',
      'percentage_of_estimate', null, 50.00, null, 1.00)$$,
  'the artist raises the project deposit policy to 50 percent'
);
select lives_ok(
  $$select public.set_project_deposit_override(
      'f2613333-3333-4333-8333-333333333333', null)$$,
  'the authorised override can be cleared'
);
reset role;

select is(
  (select amount from public.payment_requests
   where id = (select payment_request_id from pd_results where label = 'percentage_700')),
  700.00::numeric,
  'a later policy version never reprices an already issued request'
);
select is(
  (select amount from public.payment_requests
   where id = (select payment_request_id from pd_results where label = 'override_980')),
  980.00::numeric,
  'clearing the override never reprices an already issued request'
);
select throws_ok(
  format($$update public.payment_requests set amount = 100.00 where id = %L::uuid$$,
         (select payment_request_id from pd_results where label = 'percentage_700')),
  '23514', null,
  'the issued project deposit amount is immutable'
);
select throws_ok(
  format($$update public.project_deposit_requests set amount = 100.00
           where payment_request_id = %L::uuid$$,
         (select payment_request_id from pd_results where label = 'percentage_700')),
  '42501', null,
  'the issued project deposit pricing snapshot is immutable'
);

set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
select is(
  public.resolve_monzo_deposit_redirect(
    (select public_id from pd_results where label = 'percentage_700')),
  'https://monzo.com/pay/r/synthetic-pd-v-700',
  'a later policy version never reroutes an already issued request'
);
reset role;

-- ---------------------------------------------------------------------------
-- A browser-chosen project deposit amount is refused
-- ---------------------------------------------------------------------------

-- The guard is deferred so the workflow can write its pricing evidence after
-- the request row. Making it immediate proves what it rejects at commit.
set constraints payment_requests_project_deposit_guard immediate;

set local role authenticated;
select pg_temp.as_owner();
select throws_ok(
  $$select public.create_payment_request(
      'f2911112-1111-4111-8111-111111111111',
      'a1111111-1111-4111-8111-111111111111',
      'f2311111-1111-4111-8111-111111111111',
      'deposit', 1.00,
      'f2612222-2222-4222-8222-222222222222',
      null, 'GBP', null)$$,
  '22023', 'a project deposit amount must come from the server-side project deposit workflow',
  'the lower-level payment RPC cannot invent a project deposit amount'
);
reset role;

set constraints payment_requests_project_deposit_guard deferred;

set local role authenticated;
select pg_temp.as_owner();
select throws_ok(
  $$select public.request_project_deposit(
      'f2611111-1111-4111-8111-111111111111',
      'f2911113-1111-4111-8111-111111111111', 'copy_link')$$,
  '22023', null,
  'a project cannot hold two open project deposit requests at once'
);
-- Kristina has her own policy and her own enabled route, so her project deposit
-- is issued normally. She simply has no reusable GBP 325 destination yet, and
-- must never silently borrow a Vladimir one.
create temporary table kristina_project_deposit as
select public.request_project_deposit(
  'f2622222-2222-4222-8222-222222222222',
  'f2911114-1111-4111-8111-111111111111', 'copy_link') as result;
grant select on kristina_project_deposit to authenticated, service_role;
reset role;

select is(
  (select (result ->> 'amount')::numeric from kristina_project_deposit),
  325.00::numeric,
  'Kristina issues her own independently calculated project deposit'
);
select is(
  (select (result ->> 'destination_ready')::boolean from kristina_project_deposit),
  false,
  'Kristina never borrows a Vladimir destination for her own amount'
);
select is(
  (select count(*)::int from public.payment_request_payment_destinations
   where payment_request_id =
     (select (result ->> 'payment_request_id')::uuid from kristina_project_deposit)),
  0,
  'an artist with no matching destination binds nothing at all'
);

-- ---------------------------------------------------------------------------
-- Nothing settled and nothing leaked
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from public.payment_transactions
   where artist_id in ('a1111111-1111-4111-8111-111111111111',
                       'a2222222-2222-4222-8222-222222222222')),
  0,
  'calculating, previewing, overriding and issuing settle nothing'
);
select is(
  (select count(*)::int from public.payment_requests
   where status <> 'pending'
     and artist_id in ('a1111111-1111-4111-8111-111111111111',
                       'a2222222-2222-4222-8222-222222222222')),
  0,
  'no project deposit action moved a request out of pending'
);

select ok(
  (select bool_and(relrowsecurity and relforcerowsecurity)
   from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in ('artist_project_deposit_policies', 'project_deposit_requests')),
  'project deposit tables keep forced RLS'
);
select ok(
  not has_table_privilege('authenticated', 'public.artist_project_deposit_policies', 'select')
  and not has_table_privilege('authenticated', 'public.artist_project_deposit_policies', 'insert')
  and not has_table_privilege('service_role', 'public.artist_project_deposit_policies', 'select')
  and not has_table_privilege('authenticated', 'public.project_deposit_requests', 'select')
  and not has_table_privilege('authenticated', 'public.project_deposit_requests', 'insert')
  and not has_table_privilege('service_role', 'public.project_deposit_requests', 'select'),
  'project deposit rows keep no direct browser or service-role table grants'
);
select ok(
  not has_function_privilege('anon', 'public.request_project_deposit(uuid,uuid,text)', 'execute')
  and has_function_privilege('authenticated', 'public.request_project_deposit(uuid,uuid,text)', 'execute')
  and not has_function_privilege('service_role', 'public.request_project_deposit(uuid,uuid,text)', 'execute')
  and not has_function_privilege('anon', 'public.set_project_deposit_override(uuid,numeric)', 'execute')
  and not has_function_privilege('anon', 'public.configure_project_deposit_policy(uuid,text,numeric,numeric,numeric,numeric)', 'execute')
  and not has_function_privilege('anon', 'public.preview_project_deposit(uuid)', 'execute'),
  'the project deposit surface is authenticated finance only'
);
select ok(
  not has_function_privilege('anon', 'crm_private.resolve_project_deposit(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'crm_private.resolve_project_deposit(uuid)', 'execute')
  and not has_function_privilege('service_role', 'crm_private.resolve_project_deposit(uuid)', 'execute'),
  'the canonical deposit calculation stays closed to every API role'
);

select * from finish();
rollback;
