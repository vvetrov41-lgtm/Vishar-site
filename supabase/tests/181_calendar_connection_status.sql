-- 181_calendar_connection_status.sql
--
-- Metadata-only Calendar Connections read model. The database, not the CRM
-- navigation, decides which artist rows each active profile may see.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('81111111-1111-4111-8111-111111111111', 'calendar-owner@example.test'),
  ('82222222-2222-4222-8222-222222222222', 'calendar-manager@example.test'),
  ('83333333-3333-4333-8333-333333333333', 'calendar-reader@example.test'),
  ('84444444-4444-4444-8444-444444444444', 'calendar-no-profile@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('81111111-1111-4111-8111-111111111111', 'calendar-owner@example.test', 'Calendar owner', 'owner', true),
  ('82222222-2222-4222-8222-222222222222', 'calendar-manager@example.test', 'Calendar manager', 'booking_manager', true),
  ('83333333-3333-4333-8333-333333333333', 'calendar-reader@example.test', 'Calendar reader', 'read_only', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('82222222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, true, true),
  ('83333333-3333-4333-8333-333333333333', 'a1111111-1111-4111-8111-111111111111',
   'read_only', false, false, false, false, true);

insert into public.artist_integrations (
  artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled, updated_at
) values
  ('a1111111-1111-4111-8111-111111111111', 'calendar', 'google',
   'google_calendar_vladimir', 'vladimir-calendar@example.test',
   '{"calendar_id":"primary","connection_mode":"worker_oauth"}'::jsonb, true,
   '2026-08-05 12:00:00+00'),
  ('a2222222-2222-4222-8222-222222222222', 'calendar', 'google',
   'google_calendar_kristina', 'kristina-calendar@example.test',
   '{"calendar_id":"primary","connection_mode":"worker_oauth"}'::jsonb, false,
   '2026-08-05 12:05:00+00')
on conflict (artist_id, integration_type, integration_key) do update
set external_account_label = excluded.external_account_label,
    configuration = excluded.configuration,
    is_enabled = excluded.is_enabled,
    updated_at = excluded.updated_at;

insert into public.integration_outbox (
  id, artist_id, kind, dedupe_key, status, payload,
  attempt_count, max_attempts, next_attempt_at,
  leased_by, leased_at, lease_expires_at,
  last_error_code, created_at, updated_at
) values
  ('91111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'calendar_create', 'calendar:test:status:pending', 'pending', '{}'::jsonb,
   0, 8, now(), null, null, null, null, now() - interval '3 minutes', now() - interval '3 minutes'),
  ('92222222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111',
   'calendar_update', 'calendar:test:status:leased', 'leased', '{}'::jsonb,
   1, 8, now(), 'calendar-worker-test', now(), now() + interval '2 minutes', null,
   now() - interval '2 minutes', now() - interval '2 minutes'),
  ('93333333-3333-4333-8333-333333333333', 'a1111111-1111-4111-8111-111111111111',
   'calendar_cancel', 'calendar:test:status:failed', 'failed', '{}'::jsonb,
   2, 8, now(), null, null, null, 'google_rate_limited',
   now() - interval '1 minute', now() - interval '1 minute'),
  ('94444444-4444-4444-8444-444444444444', 'a2222222-2222-4222-8222-222222222222',
   'calendar_create', 'calendar:test:status:dead', 'dead', '{}'::jsonb,
   8, 8, now(), null, null, null, 'google_token_revoked',
   now(), now());

create function pg_temp.calendar_claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.calendar_claims(text)
  to anon, authenticated, service_role;

select ok(
  not has_function_privilege('anon', 'public.list_calendar_connection_status()', 'EXECUTE'),
  'anon cannot execute the Calendar Connections status RPC'
);
select ok(
  has_function_privilege('authenticated', 'public.list_calendar_connection_status()', 'EXECUTE'),
  'authenticated receives the narrow status RPC explicitly'
);
select ok(
  not has_function_privilege('service_role', 'public.list_calendar_connection_status()', 'EXECUTE'),
  'the browser status RPC is not added to the Worker surface'
);

set local role anon;
select pg_temp.calendar_claims('{"role":"anon"}');
select throws_ok(
  $$select * from public.list_calendar_connection_status()$$,
  '42501', null,
  'anonymous callers cannot inspect integration metadata'
);
reset role;

set local role authenticated;
select pg_temp.calendar_claims('{"sub":"84444444-4444-4444-8444-444444444444","role":"authenticated"}');
select is(
  (select count(*)::int from public.list_calendar_connection_status()),
  0,
  'an authenticated account without a CRM profile receives no artist rows'
);
reset role;

set local role authenticated;
select pg_temp.calendar_claims('{"sub":"83333333-3333-4333-8333-333333333333","role":"authenticated"}');
select is(
  (select count(*)::int from public.list_calendar_connection_status()),
  0,
  'read-only artist access does not expose Calendar Connections metadata'
);
reset role;

set local role authenticated;
select pg_temp.calendar_claims('{"sub":"82222222-2222-4222-8222-222222222222","role":"authenticated"}');
select is(
  (select count(*)::int from public.list_calendar_connection_status()),
  1,
  'a manager sees only the artist scope with can_manage_integrations'
);
select is(
  (select artist_slug from public.list_calendar_connection_status()),
  'vladimir',
  'the manager cannot widen the result to Kristina'
);
select is(
  (select connected from public.list_calendar_connection_status()),
  true,
  'enabled metadata is reported as connected'
);
select is(
  (select queued_jobs from public.list_calendar_connection_status()),
  1,
  'pending calendar jobs are counted as queued'
);
select is(
  (select retrying_jobs from public.list_calendar_connection_status()),
  1,
  'leased calendar jobs are counted as retrying'
);
select is(
  (select failed_jobs from public.list_calendar_connection_status()),
  1,
  'failed and dead calendar jobs are counted safely'
);
select is(
  (select last_error_code from public.list_calendar_connection_status()),
  'google_rate_limited',
  'only the latest constrained machine error code is returned'
);
select ok(
  (select to_jsonb(s) from public.list_calendar_connection_status() s limit 1)
    ?& array['artist_id','artist_slug','artist_display_name','provider','integration_key',
             'connected','external_account_label','connection_updated_at',
             'last_successful_sync_at','queued_jobs','retrying_jobs','failed_jobs','last_error_code'],
  'the explicit status shape is complete'
);
select ok(
  not ((select to_jsonb(s) from public.list_calendar_connection_status() s limit 1)
    ?| array['configuration','token','access_token','refresh_token','client_secret','kv_key']),
  'the RPC exposes no configuration, credential or KV field'
);
reset role;

set local role authenticated;
select pg_temp.calendar_claims('{"sub":"81111111-1111-4111-8111-111111111111","role":"authenticated"}');
select is(
  (select count(*)::int from public.list_calendar_connection_status()),
  2,
  'the owner sees Vladimir and Kristina as separate connections'
);
select is(
  (select count(*)::int from public.list_calendar_connection_status() where connected),
  1,
  'one artist can be connected while the other remains disconnected'
);
select is(
  (select failed_jobs from public.list_calendar_connection_status() where artist_slug = 'kristina'),
  1,
  'Kristina queue state remains independent from Vladimir'
);
reset role;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.artist_integrations
set updated_at = now() + interval '1 minute'
where artist_id = 'a1111111-1111-4111-8111-111111111111'
  and integration_type = 'calendar'
  and integration_key = 'google_calendar_vladimir';

set local role authenticated;
select pg_temp.calendar_claims('{"sub":"81111111-1111-4111-8111-111111111111","role":"authenticated"}');
select is(
  (select failed_jobs from public.list_calendar_connection_status() where artist_slug = 'vladimir'),
  0,
  'a successful reconnect clears historical failed-job warnings from the current status'
);
select is(
  (select last_error_code from public.list_calendar_connection_status() where artist_slug = 'vladimir'),
  null,
  'a successful reconnect clears the historical current-error label'
);
select is(
  (select queued_jobs + retrying_jobs from public.list_calendar_connection_status() where artist_slug = 'vladimir'),
  0,
  'the current queue view excludes work from the previous connection generation'
);
reset role;

select * from finish();

rollback;
