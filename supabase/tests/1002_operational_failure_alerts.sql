-- 1002_operational_failure_alerts.sql
--
-- Audit H-5: dead outbox jobs and failed AI jobs become one daily, deduplicated
-- internal alert per artist and recipient. Deliberate outcomes never alert.

begin;
select no_plan();

select has_function('public', 'service_sweep_operational_failure_alerts', array['integer'],
  'operational failure alert sweep exists');
select ok(not has_function_privilege('anon', 'public.service_sweep_operational_failure_alerts(integer)', 'EXECUTE'),
  'anonymous callers cannot run the alert sweep');
select ok(not has_function_privilege('authenticated', 'public.service_sweep_operational_failure_alerts(integer)', 'EXECUTE'),
  'browser sessions cannot run the alert sweep');
select ok(has_function_privilege('service_role', 'public.service_sweep_operational_failure_alerts(integer)', 'EXECUTE'),
  'the scheduler service role can run the alert sweep');

select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$select public.service_sweep_operational_failure_alerts(10)$$,
  '42501', 'operational failure alerts are backend-only', 'the sweep refuses a non-service JWT');
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$select public.service_sweep_operational_failure_alerts(0)$$,
  '22023', 'alert limit must be between 1 and 100', 'the sweep limit fails closed');

-- Fixtures: one confirmed future appointment with a Calendar integration.
insert into auth.users (id, email) values
  ('e2011111-1111-4111-8111-111111111111', 'alerts-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('e2011111-1111-4111-8111-111111111111', 'alerts-owner@example.test',
   'Alerts Owner', 'owner', true);
update public.artist_memberships
set access_level = 'owner', can_view_finance = true, can_manage_finance = true,
    can_manage_sessions = true, can_manage_integrations = true, is_active = true
where profile_id = 'e2011111-1111-4111-8111-111111111111'
  and artist_id = 'a1111111-1111-4111-8111-111111111111';

insert into public.artist_integrations (
  id, artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
) values (
  'e2021111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'calendar', 'google', 'google_calendar_vladimir',
  'vvetrov41@gmail.com',
  '{"calendar_id":"primary","oauth_scope":"calendar.events","connection_mode":"worker_oauth"}'::jsonb,
  true
);

insert into public.clients (id, full_name, email) values
  ('e2031111-1111-4111-8111-111111111111', 'Synthetic Alerts Client', 'alerts-client@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'e2041111-1111-4111-8111-111111111111',
  'e2031111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'PENDING', 'e2051111-1111-4111-8111-111111111111', repeat('f', 64),
  'accepted', 'complete', 'Synthetic Alerts Client',
  'alerts-client@example.test', '2026-08-05', now()
);

insert into public.projects (
  id, client_id, enquiry_id, artist_id, title, status, currency
) values (
  'e2061111-1111-4111-8111-111111111111',
  'e2031111-1111-4111-8111-111111111111',
  'e2041111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'Alerts project', 'active', 'GBP'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"e2011111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

create temporary table t_appt as
select (public.schedule_appointment(
  'a1111111-1111-4111-8111-111111111111',
  'e2031111-1111-4111-8111-111111111111',
  'tattoo_session',
  '2027-03-16T09:00:00Z',
  '2027-03-16T16:00:00Z',
  'confirmed',
  'e2041111-1111-4111-8111-111111111111',
  'e2061111-1111-4111-8111-111111111111',
  'Synthetic alerts test'
) ->> 'appointment_id')::uuid as id;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);


create temporary table t_job as
select o.id from public.integration_outbox o
where o.session_id = (select id from t_appt) and o.kind = 'calendar_create';

-- A deliberate cancellation is not a failure.
update public.integration_outbox
set status = 'dead', attempt_count = 1, last_error_code = 'operator_cancelled', updated_at = now()
where id = (select id from t_job);
select is(public.service_sweep_operational_failure_alerts(100), 0,
  'an operator-cancelled job raises no alert');

update public.integration_outbox
set last_error_code = 'database_unavailable', attempt_count = 8, updated_at = now()
where id = (select id from t_job);

select ok(public.service_sweep_operational_failure_alerts(100) >= 1,
  'a job that stopped retrying raises an alert');
select ok(
  exists (
    select 1 from public.notifications n
    where n.artist_id = 'a1111111-1111-4111-8111-111111111111'
      and n.notification_type = 'system.integration_delivery_failed'
      and n.dedupe_key like 'operational_failure:a1111111-1111-4111-8111-111111111111:outbox_dead:%'
      and n.body !~* 'synthetic alerts client|alerts-client@'
  ),
  'the alert names the artist and category without client data'
);
select is(public.service_sweep_operational_failure_alerts(100), 0,
  'the same failure alerts each recipient at most once per day');

select * from finish(true);
rollback;
