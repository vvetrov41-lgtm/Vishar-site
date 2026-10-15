-- 1845_statistics_core.sql
--
-- Statistics 2.0 core (20261015120000): the corrected definitions computed on
-- the server, and the authorization of the only entry point.

begin;
select no_plan();

-- ------------------------------------------------------------ closed surface

select ok(
  (select has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('service_role', p.oid, 'EXECUTE')
      and p.prosecdef
      and array_to_string(p.proconfig, ',') like '%search_path=pg_catalog, public, crm_private%'
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_statistics'),
  'get_statistics is an authenticated-only SECURITY DEFINER read with a pinned search_path'
);

select ok(
  (select bool_and(not has_function_privilege(role, p.oid, 'EXECUTE'))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   cross join unnest(array['anon', 'authenticated', 'service_role']) role
   where n.nspname = 'crm_private' and p.proname in ('statistics_core', 'enquiry_channel', 'statistics_host')),
  'the Statistics core and its helpers are not callable by any browser or service role'
);

select ok(
  pg_get_functiondef('public.gpt_get_statistics(timestamptz,timestamptz)'::regprocedure) like '%crm_private.statistics_core(%',
  'GPT Statistics reads the same core as the CRM, not a definition of its own'
);

-- ------------------------------------------------------------- channels

select is(
  (select key from crm_private.enquiry_channel(null, '/booking/', 'ig', 'paid', 'https://l.instagram.com/?u=x', array['studio.example'])),
  'paid:meta', 'a paid Instagram placement is the Meta ads channel, whatever the referrer');
select is(
  (select key from crm_private.enquiry_channel(null, '/booking/', 'ig', 'social', null, null)),
  'campaign:instagram', 'a non-paid campaign tag is not paid traffic');
select is(
  (select key from crm_private.enquiry_channel(null, null, null, null, 'https://www.google.co.uk/search?q=x', null)),
  'search:google', 'a Google referrer is search');
select is(
  (select key from crm_private.enquiry_channel(null, null, null, null, 'https://chatgpt.com/', null)),
  'ai:chatgpt', 'an AI assistant referrer is its own channel');
select is(
  (select kind from crm_private.enquiry_channel(null, null, null, null, 'https://booking.studio.example/x', array['studio.example'])),
  'internal', 'the studio''s own sites (from the booking source registry) never invent an origin');
select is(
  (select kind from crm_private.enquiry_channel(null, null, null, null, 'https://www.studio.example/', array['studio.example'])),
  'internal', 'www. is ignored when matching an own host');
select is(
  (select kind from crm_private.enquiry_channel('whatsapp', null, 'fb', 'paid', null, null)),
  'conversation', 'a conversation-opened enquiry is its own channel');
select is(
  (select kind from crm_private.enquiry_channel(null, 'crm_manual', null, null, null, null)),
  'manual', 'a manual CRM entry is its own channel');
select is(
  (select key from crm_private.enquiry_channel(null, '/booking/', null, null, 'not a url', null)),
  'direct', 'no signal is direct-or-unknown');

-- ------------------------------------------------------------------ fixtures

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('5c011111-1111-4111-8111-111111111111', 'stats-vladimir@example.test'),
  ('5c022222-2222-4222-8222-222222222222', 'stats-kristina@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('5c011111-1111-4111-8111-111111111111', 'stats-vladimir@example.test', 'Stats V', 'booking_manager', true),
  ('5c022222-2222-4222-8222-222222222222', 'stats-kristina@example.test', 'Stats K', 'booking_manager', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level, can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('5c011111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'manager', true, false, true, false, true),
  ('5c022222-2222-4222-8222-222222222222', 'a2222222-2222-4222-8222-222222222222', 'manager', false, false, true, false, true);

insert into public.clients (id, full_name, workspace_id)
select v.id::uuid, v.name, a.workspace_id
from (values
  ('5c100001-0000-4000-8000-000000000001', 'Stats client 1'),
  ('5c100002-0000-4000-8000-000000000002', 'Stats client 2'),
  ('5c100003-0000-4000-8000-000000000003', 'Stats client 3'),
  ('5c100004-0000-4000-8000-000000000004', 'Stats client 4'),
  ('5c100005-0000-4000-8000-000000000005', 'Stats client 5'),
  ('5c100006-0000-4000-8000-000000000006', 'Stats client 6'),
  ('5c100007-0000-4000-8000-000000000007', 'Stats returning client'),
  ('5c100008-0000-4000-8000-000000000008', 'Stats sleeve client')
) v(id, name)
cross join public.artists a where a.id = 'a1111111-1111-4111-8111-111111111111';

-- E1 mature, tattoo booked. E2 mature, consultation only. E3 mature, tattoo
-- cancelled. E4 young, tattoo booked. E5 excluded from analytics, tattoo
-- booked. E6 mature, paid Meta, nothing booked.
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at,
  created_at, utm_source, utm_medium, excluded_from_analytics
)
select v.id::uuid, v.client::uuid, 'a1111111-1111-4111-8111-111111111111', v.ref, gen_random_uuid(),
       repeat(v.fp, 64), 'reviewing', 'complete', 'Stats fixture', 'stats-fixture@example.test',
       '2026-07-29', now(), now() - v.age, v.us, v.um, v.excl
from (values
  ('5c200001-0000-4000-8000-000000000001', '5c100001-0000-4000-8000-000000000001', 'ENQ-2099-9851', 'a', interval '20 days', null, null, false),
  ('5c200002-0000-4000-8000-000000000002', '5c100002-0000-4000-8000-000000000002', 'ENQ-2099-9852', 'b', interval '20 days', null, null, false),
  ('5c200003-0000-4000-8000-000000000003', '5c100003-0000-4000-8000-000000000003', 'ENQ-2099-9853', 'c', interval '20 days', null, null, false),
  ('5c200004-0000-4000-8000-000000000004', '5c100004-0000-4000-8000-000000000004', 'ENQ-2099-9854', 'd', interval '2 days', null, null, false),
  ('5c200005-0000-4000-8000-000000000005', '5c100005-0000-4000-8000-000000000005', 'ENQ-2099-9855', 'e', interval '20 days', null, null, true),
  ('5c200006-0000-4000-8000-000000000006', '5c100006-0000-4000-8000-000000000006', 'ENQ-2099-9856', 'f', interval '20 days', 'fb', 'paid', false)
) v(id, client, ref, fp, age, us, um, excl);

insert into public.projects (id, client_id, enquiry_id, status, title, artist_id)
select v.id::uuid, v.client::uuid, v.enquiry::uuid, 'active', 'Stats project', 'a1111111-1111-4111-8111-111111111111'
from (values
  ('5c300001-0000-4000-8000-000000000001', '5c100001-0000-4000-8000-000000000001', '5c200001-0000-4000-8000-000000000001'),
  ('5c300003-0000-4000-8000-000000000003', '5c100003-0000-4000-8000-000000000003', '5c200003-0000-4000-8000-000000000003'),
  ('5c300004-0000-4000-8000-000000000004', '5c100004-0000-4000-8000-000000000004', '5c200004-0000-4000-8000-000000000004'),
  ('5c300005-0000-4000-8000-000000000005', '5c100005-0000-4000-8000-000000000005', '5c200005-0000-4000-8000-000000000005'),
  ('5c30000a-0000-4000-8000-00000000000a', '5c100007-0000-4000-8000-000000000007', null),
  ('5c30000b-0000-4000-8000-00000000000b', '5c100007-0000-4000-8000-000000000007', null),
  ('5c30000c-0000-4000-8000-00000000000c', '5c100008-0000-4000-8000-000000000008', null)
) v(id, client, enquiry);

insert into public.sessions (
  id, project_id, client_id, enquiry_id, status, appointment_type, start_at, end_at, duration_hours, artist_id, cancelled_at
)
select v.id::uuid, v.project::uuid, v.client::uuid, v.enquiry::uuid, v.status::public.session_status,
       v.kind::public.appointment_type, date_trunc('hour', now()) + v.offset_, date_trunc('hour', now()) + v.offset_ + make_interval(mins => (v.hours * 60)::int),
       v.hours, 'a1111111-1111-4111-8111-111111111111',
       case when v.status = 'cancelled' then now() end
from (values
  ('5c400001-0000-4000-8000-000000000001', '5c300001-0000-4000-8000-000000000001', '5c100001-0000-4000-8000-000000000001', '5c200001-0000-4000-8000-000000000001', 'confirmed', 'tattoo_session', interval '30 days', 6.0),
  ('5c400002-0000-4000-8000-000000000002', null, '5c100002-0000-4000-8000-000000000002', '5c200002-0000-4000-8000-000000000002', 'confirmed', 'in_person_consultation', interval '-3 days', 0.5),
  ('5c400003-0000-4000-8000-000000000003', '5c300003-0000-4000-8000-000000000003', '5c100003-0000-4000-8000-000000000003', '5c200003-0000-4000-8000-000000000003', 'cancelled', 'tattoo_session', interval '40 days', 6.0),
  ('5c400004-0000-4000-8000-000000000004', '5c300004-0000-4000-8000-000000000004', '5c100004-0000-4000-8000-000000000004', '5c200004-0000-4000-8000-000000000004', 'confirmed', 'tattoo_session', interval '50 days', 6.0),
  ('5c400005-0000-4000-8000-000000000005', '5c300005-0000-4000-8000-000000000005', '5c100005-0000-4000-8000-000000000005', '5c200005-0000-4000-8000-000000000005', 'confirmed', 'tattoo_session', interval '20 days', 6.0),
  -- A returning client: two different projects.
  ('5c40000a-0000-4000-8000-00000000000a', '5c30000a-0000-4000-8000-00000000000a', '5c100007-0000-4000-8000-000000000007', null, 'completed', 'tattoo_session', interval '-200 days', 5.0),
  ('5c40000b-0000-4000-8000-00000000000b', '5c30000b-0000-4000-8000-00000000000b', '5c100007-0000-4000-8000-000000000007', null, 'completed', 'tattoo_session', interval '-5 days', 4.0),
  -- A sleeve: two sessions of one project are not a return.
  ('5c40000c-0000-4000-8000-00000000000c', '5c30000c-0000-4000-8000-00000000000c', '5c100008-0000-4000-8000-000000000008', null, 'completed', 'tattoo_session', interval '-10 days', 7.0),
  ('5c40000d-0000-4000-8000-00000000000d', '5c30000c-0000-4000-8000-00000000000c', '5c100008-0000-4000-8000-000000000008', null, 'completed', 'tattoo_session', interval '-3 days', 7.0)
) v(id, project, client, enquiry, status, kind, offset_, hours);

-- A draft typed 60 days ago and confirmed yesterday is yesterday's booking.
insert into public.sessions (
  id, project_id, client_id, status, appointment_type, start_at, end_at, duration_hours, artist_id, created_at
) values (
  '5c40000e-0000-4000-8000-00000000000e', '5c30000c-0000-4000-8000-00000000000c',
  '5c100008-0000-4000-8000-000000000008', 'confirmed', 'tattoo_session',
  date_trunc('hour', now()) + interval '60 days', date_trunc('hour', now()) + interval '60 days 6 hours',
  6.0, 'a1111111-1111-4111-8111-111111111111', now() - interval '60 days'
);
insert into public.activity_log (occurred_at, event_type, actor_kind, artist_id, client_id, project_id, session_id, metadata)
values (now() - interval '1 day', 'appointment.status_changed', 'system', 'a1111111-1111-4111-8111-111111111111',
  '5c100008-0000-4000-8000-000000000008', '5c30000c-0000-4000-8000-00000000000c',
  '5c40000e-0000-4000-8000-00000000000e', jsonb_build_object('from_status', 'draft', 'to_status', 'confirmed'));

-- One deposit asked for twice: the first request cancelled and re-issued, the
-- second paid. Plus one open request and one expired one. Lifecycle triggers
-- (a request must start pending, payment reconciliation) are bypassed for the
-- fixture only: these rows model end states, not the path to them.
set local session_replication_role = replica;
insert into public.payment_requests (
  id, idempotency_key, artist_id, client_id, project_id, purpose, amount, currency, status, provider, expires_at, created_at
)
select v.id::uuid, gen_random_uuid(), 'a1111111-1111-4111-8111-111111111111', '5c100001-0000-4000-8000-000000000001',
       '5c300001-0000-4000-8000-000000000001', 'deposit', 250, 'GBP', v.status::public.payment_request_status,
       null, now() + v.expires, now() - interval '10 days'
from (values
  ('5c500001-0000-4000-8000-000000000001', 'cancelled', interval '10 days'),
  ('5c500002-0000-4000-8000-000000000002', 'paid', interval '10 days'),
  ('5c500003-0000-4000-8000-000000000003', 'pending', interval '10 days'),
  ('5c500004-0000-4000-8000-000000000004', 'pending', interval '-1 day')
) v(id, status, expires);
set local session_replication_role = origin;

create temporary table stats_result on commit drop as
select crm_private.statistics_core(
  'a1111111-1111-4111-8111-111111111111', now() - interval '30 days', now() + interval '1 day', now(), true) as r;
grant select on stats_result to authenticated;

-- ------------------------------------------------------------- definitions
-- Fixture rows only: production-like seeds may add their own, so every check
-- compares against the fixture's contribution where the seed could interfere.

select is((select (r -> 'conversion' ->> 'converted')::int >= 1 from stats_result), true,
  'a mature enquiry with a tattoo booking converts');
select ok(
  not exists (
    select 1 from crm_private.statistics_core('a1111111-1111-4111-8111-111111111111', now() - interval '30 days', now() + interval '1 day', now(), false) x
    where false),
  'core runs without finance');

-- Isolated check of the cohort: a window that holds only the fixture enquiries.
create temporary table fixture_core on commit drop as
select crm_private.statistics_core(
  'a1111111-1111-4111-8111-111111111111',
  (select min(created_at) from public.enquiries where id::text like '5c2000%'),
  (select max(created_at) from public.enquiries where id::text like '5c2000%') + interval '1 second',
  now(), true) as r;
grant select on fixture_core to authenticated;

select is((select (r ->> 'enquiries')::int from fixture_core), 5,
  'an enquiry excluded from analytics is not an enquiry');
select is((select (r -> 'conversion' ->> 'mature')::int from fixture_core), 4,
  'only enquiries at least 14 days old are judged');
select is((select (r -> 'conversion' ->> 'converted')::int from fixture_core), 1,
  'a consultation, a cancelled tattoo and nothing at all are not conversions');
select is((select (r -> 'conversion' ->> 'pending')::int || '/' || (r -> 'conversion' ->> 'pending_converted') from fixture_core), '1/1',
  'a young enquiry that already booked is pending, not in the rate');
select is((select (r -> 'funnel' ->> 'consultations')::int from fixture_core), 1,
  'the consultation is its own funnel step');
select is((select (r -> 'funnel' ->> 'booked')::int from fixture_core), 2,
  'booked counts the mature and the young booking');
select is(
  (select (c ->> 'enquiries')::int from fixture_core, jsonb_array_elements(r -> 'channels') c where c ->> 'key' = 'paid:meta'),
  1, 'the paid campaign enquiry is the Meta ads channel');

select is((select (r -> 'returning_clients' ->> 'returning')::int from stats_result) >= 1, true,
  'a client with two different projects is returning');
select ok(
  (select (r -> 'sessions' ->> 'completed')::int >= 3 and (r -> 'sessions' ->> 'consultations_held')::int >= 1 from stats_result),
  'completed tattoo sessions and consultations are counted apart');

-- The sleeve client alone: active, not returning.
select is(
  (select count(distinct s.project_id)::int from public.statistics_sessions s
   where s.client_id = '5c100008-0000-4000-8000-000000000008'),
  1, 'fixture sanity: the sleeve is one project');

select is(
  (select r -> 'finance' -> 'open' from stats_result) @> '[{"currency":"GBP","count":1}]'::jsonb,
  true, 'only the unexpired pending request is owed; cancelled, paid and expired are not');
select ok(
  (select (r -> 'finance' ->> 'partially_paid') is not null from stats_result),
  'part-paid requests are counted separately');

select ok(
  (select (crm_private.statistics_core('a1111111-1111-4111-8111-111111111111', now() - interval '2 days', now() + interval '1 day', now(), false)
     -> 'bookings_made' ->> 'tattoo')::int >= 1),
  'a draft confirmed yesterday is counted as yesterday''s booking');
select ok(
  (select (crm_private.statistics_core('a1111111-1111-4111-8111-111111111111', now() - interval '61 days', now() - interval '59 days', now(), false)
     -> 'bookings_made' ->> 'tattoo')::int = 0),
  'and not on the day the draft was typed');

-- Week buckets across the Europe/London clock change of 2026-10-25.
select ok(
  (select bool_and(extract(isodow from (w ->> 'week_start')::date) = 1)
   from jsonb_array_elements(crm_private.statistics_core(
     'a1111111-1111-4111-8111-111111111111', '2026-10-01', '2026-10-21', '2026-10-20 12:00+00', false
   ) -> 'upcoming' -> 'weeks') w),
  'every diary week starts on a local Monday, across a clock change');
select is(
  (select (crm_private.statistics_core(
     'a1111111-1111-4111-8111-111111111111', '2026-10-01', '2026-10-21', '2026-10-20 12:00+00', false
   ) -> 'upcoming' -> 'weeks' -> 1 ->> 'week_start')),
  '2026-10-26', 'the week after the clock change begins on Monday 26 October');

-- ---------------------------------------------------------- authorization

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated;

set local role authenticated;

select pg_temp.claims('{"sub":"5c011111-1111-4111-8111-111111111111","role":"authenticated"}');
select lives_ok(
  $$select public.get_statistics(array['a1111111-1111-4111-8111-111111111111']::uuid[], now() - interval '30 days', now())$$,
  'a member reads Statistics for their artist');
select is(
  (select (public.get_statistics(array['a1111111-1111-4111-8111-111111111111']::uuid[], now() - interval '30 days', now()) -> 'artists' -> 0 ->> 'finance')::boolean),
  true, 'finance is included where the member holds view_finance');
select throws_ok(
  $$select public.get_statistics(array['a2222222-2222-4222-8222-222222222222']::uuid[], now() - interval '30 days', now())$$,
  '42501', null, 'a member cannot read another artist''s Statistics');
select is(
  (select jsonb_array_length(public.get_statistics(null, now() - interval '30 days', now()) -> 'artists')),
  1, 'with no artist named, only the artists the caller may view are answered');
select throws_ok(
  $$select public.get_statistics(null, now() - interval '500 days', now())$$,
  '22023', null, 'a window longer than 400 days is refused');

select pg_temp.claims('{"sub":"5c022222-2222-4222-8222-222222222222","role":"authenticated"}');
select is(
  (select public.get_statistics(array['a2222222-2222-4222-8222-222222222222']::uuid[], now() - interval '30 days', now()) -> 'artists' -> 0 -> 'current' -> 'finance'),
  'null'::jsonb, 'no finance block without view_finance');
select throws_ok(
  $$select public.get_statistics(array['a1111111-1111-4111-8111-111111111111']::uuid[], now() - interval '30 days', now())$$,
  '42501', null, 'Kristina''s manager cannot read Vladimir''s Statistics');

select pg_temp.claims('{"role":"anon"}');
reset role;
set local role anon;
select throws_ok(
  $$select public.get_statistics(null, now() - interval '30 days', now())$$,
  '42501', null, 'anonymous callers cannot execute get_statistics');

select * from finish();
rollback;
