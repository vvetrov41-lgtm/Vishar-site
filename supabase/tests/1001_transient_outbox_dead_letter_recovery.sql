-- 1001_transient_outbox_dead_letter_recovery.sql
--
-- Audit H-1: a job dead-lettered by a genuine backend outage gets exactly one
-- more retry budget when replay is safe. Permanent refusals, stale Calendar
-- versions and repeated sweeps are never revived.

begin;
select no_plan();

select has_function(
  'public', 'service_recover_transient_dead_outbox', array['integer'],
  'transient dead-letter recovery sweep exists'
);
select ok(
  not has_function_privilege('anon', 'public.service_recover_transient_dead_outbox(integer)', 'EXECUTE'),
  'anonymous callers cannot run transient recovery'
);
select ok(
  not has_function_privilege('authenticated', 'public.service_recover_transient_dead_outbox(integer)', 'EXECUTE'),
  'browser sessions cannot run transient recovery'
);
select ok(
  has_function_privilege('service_role', 'public.service_recover_transient_dead_outbox(integer)', 'EXECUTE'),
  'the scheduler service role can run transient recovery'
);
select ok(
  pg_get_functiondef('public.service_recover_transient_dead_outbox(integer)'::regprocedure)
    not ilike '%approved_email%'
  and pg_get_functiondef('public.service_recover_transient_dead_outbox(integer)'::regprocedure)
    not ilike '%whatsapp_message%',
  'customer-facing email and WhatsApp jobs are never replayed'
);
select ok(
  pg_get_functiondef('public.service_recover_telegram_enquiry_outbox(uuid)'::regprocedure)
    ilike '%telegram_delivery_evidence_present%',
  'Telegram replay still refuses when delivery evidence exists'
);

select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok(
  $$select * from public.service_recover_transient_dead_outbox(10)$$,
  '42501', 'Transient outbox recovery is backend-only',
  'recovery refuses a non-service JWT'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select * from public.service_recover_transient_dead_outbox(0)$$,
  '22023', 'Transient outbox recovery limit must be between 1 and 20',
  'recovery limit fails closed below range'
);
select throws_ok(
  $$select * from public.service_recover_transient_dead_outbox(21)$$,
  '22023', 'Transient outbox recovery limit must be between 1 and 20',
  'recovery limit fails closed above range'
);

-- Fixtures: one confirmed future appointment with a Calendar integration.
insert into auth.users (id, email) values
  ('e1011111-1111-4111-8111-111111111111', 'transient-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('e1011111-1111-4111-8111-111111111111', 'transient-owner@example.test',
   'Transient Owner', 'owner', true);
update public.artist_memberships
set access_level = 'owner', can_view_finance = true, can_manage_finance = true,
    can_manage_sessions = true, can_manage_integrations = true, is_active = true
where profile_id = 'e1011111-1111-4111-8111-111111111111'
  and artist_id = 'a1111111-1111-4111-8111-111111111111';

insert into public.artist_integrations (
  id, artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
) values (
  'e1021111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'calendar', 'google', 'google_calendar_vladimir',
  'vvetrov41@gmail.com',
  '{"calendar_id":"primary","oauth_scope":"calendar.events","connection_mode":"worker_oauth"}'::jsonb,
  true
);

insert into public.clients (id, full_name, email) values
  ('e1031111-1111-4111-8111-111111111111', 'Synthetic Transient Client', 'transient-client@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'e1041111-1111-4111-8111-111111111111',
  'e1031111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'PENDING', 'e1051111-1111-4111-8111-111111111111', repeat('e', 64),
  'accepted', 'complete', 'Synthetic Transient Client',
  'transient-client@example.test', '2026-08-05', now()
);

insert into public.projects (
  id, client_id, enquiry_id, artist_id, title, status, currency
) values (
  'e1061111-1111-4111-8111-111111111111',
  'e1031111-1111-4111-8111-111111111111',
  'e1041111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'Transient recovery project', 'active', 'GBP'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"e1011111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

create temporary table t_appt as
select (public.schedule_appointment(
  'a1111111-1111-4111-8111-111111111111',
  'e1031111-1111-4111-8111-111111111111',
  'tattoo_session',
  '2027-03-09T09:00:00Z',
  '2027-03-09T16:00:00Z',
  'confirmed',
  'e1041111-1111-4111-8111-111111111111',
  'e1061111-1111-4111-8111-111111111111',
  'Synthetic transient recovery test'
) ->> 'appointment_id')::uuid as id;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table t_job as
select o.id from public.integration_outbox o
where o.session_id = (select id from t_appt) and o.kind = 'calendar_create';

select is((select count(*)::int from t_job), 1, 'the confirmed appointment enqueued one calendar_create job');

-- Simulate a job that exhausted its budget during a backend outage.
update public.integration_outbox
set status = 'dead', attempt_count = 8, last_error_code = 'database_unavailable'
where id = (select id from t_job);
update public.sessions
set calendar_sync_status = 'failed', calendar_last_error_code = 'database_unavailable'
where id = (select id from t_appt);

select results_eq(
  $$select scanned, recovered from public.service_recover_transient_dead_outbox(10)$$,
  $$values (1, 1)$$,
  'a future, current Calendar job dead-lettered by an outage is revived'
);
select is(
  (select status::text || '/' || attempt_count from public.integration_outbox where id = (select id from t_job)),
  'failed/0',
  'the revived job is due again with a fresh retry budget'
);
select is(
  (select calendar_sync_status::text from public.sessions where id = (select id from t_appt)),
  'retrying',
  'the appointment projection shows retrying instead of failed'
);

-- The same job dying again is never revived a second time.
update public.integration_outbox
set status = 'dead', attempt_count = 8, last_error_code = 'database_unavailable'
where id = (select id from t_job);
select results_eq(
  $$select scanned, recovered from public.service_recover_transient_dead_outbox(10)$$,
  $$values (0, 0)$$,
  'each outbox job is revived at most once'
);
select is(
  (select status::text from public.integration_outbox where id = (select id from t_job)),
  'dead',
  'a second death stays dead'
);

-- A permanent refusal is not an outage.
delete from crm_private.outbox_transient_recovery_marks where outbox_id = (select id from t_job);
update public.integration_outbox set last_error_code = 'database_rejected' where id = (select id from t_job);
select results_eq(
  $$select scanned, recovered from public.service_recover_transient_dead_outbox(10)$$,
  $$values (0, 0)$$,
  'a database_rejected dead letter is never revived'
);

-- A superseded Calendar version is examined once and not replayed.
update public.integration_outbox
set last_error_code = 'database_unavailable',
    payload = jsonb_set(payload, '{calendar_version}', '99'::jsonb)
where id = (select id from t_job);
select results_eq(
  $$select scanned, recovered from public.service_recover_transient_dead_outbox(10)$$,
  $$values (1, 0)$$,
  'a stale Calendar version is examined but not replayed'
);
select is(
  (select status::text from public.integration_outbox where id = (select id from t_job)),
  'dead',
  'the stale Calendar job stays dead'
);

select * from finish(true);
rollback;
