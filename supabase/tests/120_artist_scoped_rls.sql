-- 120_artist_scoped_rls.sql
--
-- Multi-artist row visibility with one shared manager. A single CRM profile may
-- hold memberships for Vladimir and Kristina, while finance and integration
-- capabilities remain independently configurable for each artist.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('61111111-1111-4111-8111-111111111111', 'owner.scope@example.test'),
  ('62222222-2222-4222-8222-222222222222', 'shared.manager@example.test'),
  ('63333333-3333-4333-8333-333333333333', 'kristina.reader@example.test'),
  ('64444444-4444-4444-8444-444444444444', 'no.profile@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('61111111-1111-4111-8111-111111111111', 'owner.scope@example.test', 'Owner', 'owner', true),
  ('62222222-2222-4222-8222-222222222222', 'shared.manager@example.test', 'Shared Manager', 'booking_manager', true),
  ('63333333-3333-4333-8333-333333333333', 'kristina.reader@example.test', 'Kristina Reader', 'read_only', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  -- Same shared manager, both artists. Capabilities deliberately differ so
  -- the test proves they are evaluated per membership rather than per profile.
  ('62222222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111',
   'manager', true, false, true, true, true),
  ('62222222-2222-4222-8222-222222222222', 'a2222222-2222-4222-8222-222222222222',
   'manager', false, false, true, false, true),
  ('63333333-3333-4333-8333-333333333333', 'a2222222-2222-4222-8222-222222222222',
   'read_only', false, false, false, false, true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated;

-- Two separate client histories, one for each artist.
insert into public.clients (id, full_name, email) values
  ('c1111111-1111-4111-8111-111111111111', 'Vladimir Client', 'vladimir.client@example.test'),
  ('c2222222-2222-4222-8222-222222222222', 'Kristina Client', 'kristina.client@example.test');

insert into public.enquiries (
  id, client_id, reference_number, idempotency_key, intake_fingerprint,
  intake_state, submitted_full_name, submitted_email, idea, source,
  privacy_notice_version, privacy_acknowledged_at, artist_id
) values
  ('e1111111-1111-4111-8111-111111111111',
   'c1111111-1111-4111-8111-111111111111', 'placeholder',
   '71111111-1111-4111-8111-111111111111', repeat('a', 64),
   'complete', 'Vladimir Client', 'vladimir.client@example.test',
   'Synthetic Vladimir enquiry', 'pgtap', '2026-07-29', now(),
   'a1111111-1111-4111-8111-111111111111'),
  ('e2222222-2222-4222-8222-222222222222',
   'c2222222-2222-4222-8222-222222222222', 'placeholder',
   '72222222-2222-4222-8222-222222222222', repeat('b', 64),
   'complete', 'Kristina Client', 'kristina.client@example.test',
   'Synthetic Kristina enquiry', 'pgtap', '2026-07-29', now(),
   'a2222222-2222-4222-8222-222222222222');

insert into public.projects (
  id, client_id, enquiry_id, status, title,
  hourly_rate, estimate_total, currency, artist_id
) values
  ('b1111111-1111-4111-8111-111111111111',
   'c1111111-1111-4111-8111-111111111111',
   'e1111111-1111-4111-8111-111111111111',
   'active', 'Vladimir Project', 140.00, 980.00, 'GBP',
   'a1111111-1111-4111-8111-111111111111'),
  ('b2222222-2222-4222-8222-222222222222',
   'c2222222-2222-4222-8222-222222222222',
   'e2222222-2222-4222-8222-222222222222',
   'active', 'Kristina Project', 150.00, 1050.00, 'GBP',
   'a2222222-2222-4222-8222-222222222222');

insert into public.sessions (
  id, project_id, status, start_at, end_at, price, currency, artist_id
) values
  ('d1111111-1111-4111-8111-111111111111',
   'b1111111-1111-4111-8111-111111111111', 'proposed',
   now() + interval '10 days', now() + interval '10 days 7 hours',
   980.00, 'GBP', 'a1111111-1111-4111-8111-111111111111'),
  ('d2222222-2222-4222-8222-222222222222',
   'b2222222-2222-4222-8222-222222222222', 'proposed',
   now() + interval '11 days', now() + interval '11 days 7 hours',
   1050.00, 'GBP', 'a2222222-2222-4222-8222-222222222222');

insert into public.follow_ups (
  id, due_at, subject, client_id, enquiry_id, artist_id
) values
  ('f1111111-1111-4111-8111-111111111111', now() + interval '1 day',
   'Vladimir follow-up', 'c1111111-1111-4111-8111-111111111111',
   'e1111111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111'),
  ('f2222222-2222-4222-8222-222222222222', now() + interval '1 day',
   'Kristina follow-up', 'c2222222-2222-4222-8222-222222222222',
   'e2222222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222');

insert into public.email_messages (
  id, client_id, enquiry_id, to_email, subject, body,
  created_by_kind, artist_id
) values
  ('91111111-1111-4111-8111-111111111111',
   'c1111111-1111-4111-8111-111111111111',
   'e1111111-1111-4111-8111-111111111111',
   'vladimir.client@example.test', 'Vladimir draft', 'Synthetic draft',
   'system', 'a1111111-1111-4111-8111-111111111111'),
  ('92222222-2222-4222-8222-222222222222',
   'c2222222-2222-4222-8222-222222222222',
   'e2222222-2222-4222-8222-222222222222',
   'kristina.client@example.test', 'Kristina draft', 'Synthetic draft',
   'system', 'a2222222-2222-4222-8222-222222222222');

insert into public.integration_outbox (
  id, kind, dedupe_key, payload, client_id, enquiry_id, artist_id
) values
  ('81111111-1111-4111-8111-111111111111', 'reconciliation',
   'reconciliation:rls_vladimir', '{}'::jsonb,
   'c1111111-1111-4111-8111-111111111111',
   'e1111111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111'),
  ('82222222-2222-4222-8222-222222222222', 'reconciliation',
   'reconciliation:rls_kristina', '{}'::jsonb,
   'c2222222-2222-4222-8222-222222222222',
   'e2222222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222');

-- Operational, finance and integration events are separated by event prefix.
insert into public.activity_log (
  event_type, actor_kind, client_id, enquiry_id, artist_id, metadata
) values
  ('enquiry.created', 'system',
   'c1111111-1111-4111-8111-111111111111',
   'e1111111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', '{}'::jsonb),
  ('enquiry.created', 'system',
   'c2222222-2222-4222-8222-222222222222',
   'e2222222-2222-4222-8222-222222222222',
   'a2222222-2222-4222-8222-222222222222', '{}'::jsonb),
  ('payment.recorded', 'system', null, null,
   'a1111111-1111-4111-8111-111111111111', '{}'::jsonb),
  ('payment.recorded', 'system', null, null,
   'a2222222-2222-4222-8222-222222222222', '{}'::jsonb),
  ('integration.queued', 'system', null, null,
   'a1111111-1111-4111-8111-111111111111', '{}'::jsonb),
  ('integration.queued', 'system', null, null,
   'a2222222-2222-4222-8222-222222222222', '{}'::jsonb);

insert into public.activity_log (
  event_type, actor_kind, profile_id, artist_id, metadata
) values
  ('profile.updated', 'system',
   '62222222-2222-4222-8222-222222222222', null, '{}'::jsonb);

-- ---------------------------------------------------------------------------
-- Shared manager: operational access to both artists, per-artist capabilities
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"62222222-2222-4222-8222-222222222222","role":"authenticated"}');

select is((select count(*)::int from public.artists), 2,
          'one shared manager can access both artist identities');
select ok(public.can_manage_artist('a1111111-1111-4111-8111-111111111111'),
          'the shared manager can manage Vladimir');
select ok(public.can_manage_artist('a2222222-2222-4222-8222-222222222222'),
          'the shared manager can manage Kristina');
select ok(public.can_manage_artist_sessions('a1111111-1111-4111-8111-111111111111'),
          'the shared manager can manage Vladimir sessions');
select ok(public.can_manage_artist_sessions('a2222222-2222-4222-8222-222222222222'),
          'the shared manager can manage Kristina sessions');

select is((select count(*)::int from public.clients), 2,
          'the shared manager sees clients for both artists');
select is((select count(*)::int from public.enquiries), 2,
          'the shared manager sees enquiries for both artists');
select is((select count(*)::int from public.projects), 2,
          'the shared manager sees projects for both artists');
select is((select count(*)::int from public.sessions), 2,
          'the shared manager sees sessions for both artists');
select is((select count(*)::int from public.follow_ups), 2,
          'the shared manager sees follow-ups for both artists');
select is((select count(*)::int from public.email_messages), 2,
          'the shared manager sees managed email drafts for both artists');

select ok(public.can_view_artist_finance('a1111111-1111-4111-8111-111111111111'),
          'Vladimir finance can be enabled for the shared manager');
select ok(not public.can_view_artist_finance('a2222222-2222-4222-8222-222222222222'),
          'Kristina finance can remain disabled for the same manager');
select is((select count(*)::int from public.projects_finance), 1,
          'the project finance view returns only the enabled artist');
select is((select count(*)::int from public.projects_finance
           where artist_id = 'a1111111-1111-4111-8111-111111111111'), 1,
          'the visible project finance row belongs to Vladimir');
select is((select count(*)::int from public.sessions_finance), 1,
          'the session finance view returns only the enabled artist');

select ok(public.can_manage_artist_integrations('a1111111-1111-4111-8111-111111111111'),
          'Vladimir integrations can be enabled for the shared manager');
select ok(not public.can_manage_artist_integrations('a2222222-2222-4222-8222-222222222222'),
          'Kristina integrations can remain disabled for the same manager');
select is((select count(*)::int from public.integration_outbox), 1,
          'the manager sees only the enabled artist integration job');
select is((select count(*)::int from public.integration_outbox
           where artist_id = 'a1111111-1111-4111-8111-111111111111'), 1,
          'the visible integration job belongs to Vladimir');

select is((select count(*)::int from public.activity_log), 4,
          'the manager sees both operational events plus only permitted finance and integration events');
select is((select count(*)::int from public.activity_log
           where artist_id = 'a2222222-2222-4222-8222-222222222222'
             and event_type in ('payment.recorded', 'integration.queued')), 0,
          'disabled Kristina finance and integration activity remains hidden');
select is((select count(*)::int from public.activity_log
           where event_type = 'profile.updated'), 0,
          'global profile activity remains owner-only');
reset role;

-- ---------------------------------------------------------------------------
-- Kristina read-only membership
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"63333333-3333-4333-8333-333333333333","role":"authenticated"}');

select is((select count(*)::int from public.artists), 1,
          'a Kristina-only reader sees one artist');
select ok(public.can_access_artist('a2222222-2222-4222-8222-222222222222'),
          'the reader can access Kristina');
select ok(not public.can_access_artist('a1111111-1111-4111-8111-111111111111'),
          'the reader cannot access Vladimir');
select ok(not public.can_manage_artist('a2222222-2222-4222-8222-222222222222'),
          'read-only membership cannot manage Kristina');
select is((select count(*)::int from public.clients), 1,
          'the reader sees only Kristina client history');
select is((select count(*)::int from public.enquiries), 1,
          'the reader sees only Kristina enquiries');
select is((select count(*)::int from public.projects), 1,
          'the reader sees only Kristina projects');
select is((select count(*)::int from public.sessions), 1,
          'the reader sees only Kristina sessions');
select is((select count(*)::int from public.follow_ups), 1,
          'the reader sees only Kristina follow-ups');
select is((select count(*)::int from public.email_messages), 0,
          'read-only membership sees no email contents');
select is((select count(*)::int from public.integration_outbox), 0,
          'read-only membership sees no integration jobs');
select is((select count(*)::int from public.projects_finance), 0,
          'read-only membership sees no project finance');
select is((select count(*)::int from public.sessions_finance), 0,
          'read-only membership sees no session finance');
select is((select count(*)::int from public.activity_log), 0,
          'read-only membership sees no activity log');
reset role;

-- ---------------------------------------------------------------------------
-- Auth user without a profile
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"64444444-4444-4444-8444-444444444444","role":"authenticated"}');
select is((select count(*)::int from public.artists), 0,
          'an auth user without a profile sees no artists');
select is((select count(*)::int from public.clients), 0,
          'an auth user without a profile sees no clients');
select is((select count(*)::int from public.enquiries), 0,
          'an auth user without a profile sees no enquiries');
select is((select count(*)::int from public.projects_finance), 0,
          'an auth user without a profile sees no finance');
reset role;

-- ---------------------------------------------------------------------------
-- Owner retains the complete cross-artist view
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"61111111-1111-4111-8111-111111111111","role":"authenticated"}');
select is((select count(*)::int from public.artists), 2,
          'the owner sees both artists');
select is((select count(*)::int from public.clients), 2,
          'the owner sees both client histories');
select is((select count(*)::int from public.enquiries), 2,
          'the owner sees both enquiries');
select is((select count(*)::int from public.projects), 2,
          'the owner sees both projects');
select is((select count(*)::int from public.sessions), 2,
          'the owner sees both sessions');
select is((select count(*)::int from public.projects_finance), 2,
          'the owner sees finance for both artists');
select is((select count(*)::int from public.sessions_finance), 2,
          'the owner sees session finance for both artists');
select is((select count(*)::int from public.integration_outbox), 2,
          'the owner sees integration jobs for both artists');
select is((select count(*)::int from public.activity_log), 7,
          'the owner sees artist-scoped and global activity');
reset role;

select * from finish(true);
rollback;