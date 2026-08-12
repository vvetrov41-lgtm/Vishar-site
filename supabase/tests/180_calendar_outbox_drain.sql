-- 180_calendar_outbox_drain.sql
--
-- Durable calendar leasing, exact artist projection, retry acknowledgement,
-- stale version retirement and cancellation semantics. No Google API is called.

begin;
select no_plan();

select has_function(
  'public', 'claim_calendar_outbox',
  array['text','integer','integer'],
  'calendar drain has a backend-only leasing RPC'
);
select has_function(
  'public', 'record_calendar_outbox_result',
  array['uuid','text','integer','boolean','text','text'],
  'calendar drain has a backend-only result RPC'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.claim_calendar_outbox(text,integer,integer)', 'EXECUTE'
  ),
  'browser sessions cannot lease calendar jobs'
);
select ok(
  has_function_privilege(
    'service_role', 'public.claim_calendar_outbox(text,integer,integer)', 'EXECUTE'
  ),
  'service role can lease calendar jobs'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.record_calendar_outbox_result(uuid,text,integer,boolean,text,text)',
    'EXECUTE'
  ),
  'browser sessions cannot acknowledge calendar jobs'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.record_calendar_outbox_result(uuid,text,integer,boolean,text,text)',
    'EXECUTE'
  ),
  'service role can acknowledge calendar jobs'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('d8111111-1111-4111-8111-111111111111', 'calendar-drain-owner@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('d8111111-1111-4111-8111-111111111111', 'calendar-drain-owner@example.test',
   'Calendar Drain Owner', 'owner', true);

update public.artist_memberships
set access_level = 'owner',
    can_view_finance = true,
    can_manage_finance = true,
    can_manage_sessions = true,
    can_manage_integrations = true,
    is_active = true
where profile_id = 'd8111111-1111-4111-8111-111111111111'
  and artist_id = 'a1111111-1111-4111-8111-111111111111';

insert into public.artist_integrations (
  id, artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
) values (
  'd8211111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'calendar', 'google', 'google_calendar_vladimir',
  'vvetrov41@gmail.com',
  '{"calendar_id":"primary","oauth_scope":"calendar.events","connection_mode":"worker_oauth"}'::jsonb,
  true
);

insert into public.clients (id, full_name, email) values
  ('d8311111-1111-4111-8111-111111111111',
   'Synthetic Calendar Drain Client', 'calendar-drain-client@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'd8411111-1111-4111-8111-111111111111',
  'd8311111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'PENDING', 'd8511111-1111-4111-8111-111111111111', repeat('d', 64),
  'accepted', 'complete', 'Synthetic Calendar Drain Client',
  'calendar-drain-client@example.test', '2026-08-05', now()
);

insert into public.projects (
  id, client_id, enquiry_id, artist_id, title, status, currency
) values (
  'd8611111-1111-4111-8111-111111111111',
  'd8311111-1111-4111-8111-111111111111',
  'd8411111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'Calendar drain project', 'active', 'GBP'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"d8111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

create temporary table drain_appointment as
select (public.schedule_appointment(
  'a1111111-1111-4111-8111-111111111111',
  'd8311111-1111-4111-8111-111111111111',
  'tattoo_session',
  '2026-11-10T09:00:00Z',
  '2026-11-10T16:00:00Z',
  'confirmed',
  'd8411111-1111-4111-8111-111111111111',
  'd8611111-1111-4111-8111-111111111111',
  'Synthetic calendar drain test'
) ->> 'appointment_id')::uuid as id;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table first_claim as
select * from public.claim_calendar_outbox('calendar-worker-first', 10, 120);

select is((select count(*)::int from first_claim), 1,
          'one confirmed appointment leases one calendar job');
select is((select kind::text from first_claim), 'calendar_create',
          'the first leased operation is calendar_create');
select is((select artist_id from first_claim),
          'a1111111-1111-4111-8111-111111111111'::uuid,
          'the leased job retains the authoritative artist');
select is((select client_display_name from first_claim),
          'Synthetic Calendar Drain Client',
          'the backend receives the bounded calendar display name');
select ok((select job_valid from first_claim),
          'the database validates the create payload against the appointment');
select ok(not (select obsolete from first_claim),
          'the initial calendar job is current');
select is(
  (select calendar_sync_status::text from public.sessions
   where id = (select id from drain_appointment)),
  'retrying',
  'leasing a current valid operation marks the projection retrying'
);

select throws_ok(
  format(
    'select public.record_calendar_outbox_result(%L::uuid,%L,0,true,%L,null)',
    (select outbox_id from first_claim),
    'calendar-worker-wrong',
    'wrong-worker-event'
  ),
  '42501',
  'calendar outbox lease is not owned by this worker',
  'a different worker cannot acknowledge the lease'
);

select ok(
  (public.record_calendar_outbox_result(
    (select outbox_id from first_claim),
    'calendar-worker-first',
    0,
    true,
    'synthetic-google-event',
    null
  ) ->> 'changed')::boolean,
  'the owning worker records a successful create'
);
select is(
  (select status::text from public.integration_outbox
   where id = (select outbox_id from first_claim)),
  'succeeded',
  'successful provider acknowledgement completes the outbox row'
);
select is(
  (select calendar_event_id from public.sessions
   where id = (select id from drain_appointment)),
  'synthetic-google-event',
  'successful create stores the provider event id'
);
select is(
  (select calendar_sync_status::text from public.sessions
   where id = (select id from drain_appointment)),
  'synced',
  'successful create marks the current appointment synced'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"d8111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
select ok(
  (public.reschedule_appointment(
    (select id from drain_appointment),
    '2026-11-11T10:00:00Z',
    '2026-11-11T17:00:00Z'
  ) ->> 'changed')::boolean,
  'a synced appointment queues an update when rescheduled'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table stale_claim as
select * from public.claim_calendar_outbox('calendar-worker-stale', 10, 120);

select is((select kind::text from stale_claim), 'calendar_update',
          'the synced reschedule leases a calendar_update');
select is((select calendar_version from stale_claim), 1,
          'the first update carries version one');

select set_config(
  'request.jwt.claims',
  '{"sub":"d8111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
select ok(
  (public.reschedule_appointment(
    (select id from drain_appointment),
    '2026-11-12T10:00:00Z',
    '2026-11-12T17:00:00Z'
  ) ->> 'changed')::boolean,
  'a newer reschedule advances the authoritative version while the old job is leased'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok(
  (public.record_calendar_outbox_result(
    (select outbox_id from stale_claim),
    'calendar-worker-stale',
    1,
    true,
    'stale-provider-event',
    null
  ) ->> 'stale')::boolean,
  'an old provider response is retired as stale'
);
select is(
  (select calendar_event_id from public.sessions
   where id = (select id from drain_appointment)),
  'synthetic-google-event',
  'a stale acknowledgement cannot overwrite the current provider event id'
);
select is(
  (select calendar_sync_status::text from public.sessions
   where id = (select id from drain_appointment)),
  'queued',
  'a stale acknowledgement cannot overwrite the newer queued state'
);

create temporary table current_claim as
select * from public.claim_calendar_outbox('calendar-worker-current', 10, 120);

select is((select calendar_version from current_claim), 2,
          'the next lease selects the current version');
select ok((select job_valid from current_claim),
          'the current update remains valid');

select is(
  (public.record_calendar_outbox_result(
    (select outbox_id from current_claim),
    'calendar-worker-current',
    2,
    false,
    null,
    'calendar_provider_unavailable'
  ) ->> 'status'),
  'failed',
  'a retryable provider failure leaves the job failed rather than lost'
);
select is(
  (select attempt_count from public.integration_outbox
   where id = (select outbox_id from current_claim)),
  1,
  'a failed provider attempt increments the durable counter once'
);
select ok(
  (select next_attempt_at > now() from public.integration_outbox
   where id = (select outbox_id from current_claim)),
  'a failed provider attempt receives bounded backoff'
);
select is(
  (select calendar_last_error_code from public.sessions
   where id = (select id from drain_appointment)),
  'calendar_provider_unavailable',
  'the CRM stores only the safe provider error code'
);

update public.integration_outbox
set next_attempt_at = now()
where id = (select outbox_id from current_claim);

create temporary table retry_claim as
select * from public.claim_calendar_outbox('calendar-worker-retry', 10, 120);
select is((select outbox_id from retry_claim), (select outbox_id from current_claim),
          'the same durable job is leased again after backoff');

select is(
  (public.record_calendar_outbox_result(
    (select outbox_id from retry_claim),
    'calendar-worker-retry',
    2,
    true,
    'synthetic-google-event',
    null
  ) ->> 'status'),
  'succeeded',
  'a later successful retry completes the original job'
);
select is(
  (select attempt_count from public.integration_outbox
   where id = (select outbox_id from retry_claim)),
  2,
  'the successful retry preserves the full attempt count'
);
select is(
  (select calendar_last_synced_version from public.sessions
   where id = (select id from drain_appointment)),
  2,
  'the successful retry acknowledges exactly the current version'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"d8111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
select ok(
  (public.set_appointment_status(
    (select id from drain_appointment), 'cancelled'
  ) ->> 'changed')::boolean,
  'cancelling a synced appointment queues provider deletion'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table cancel_claim as
select * from public.claim_calendar_outbox('calendar-worker-cancel', 10, 120);
select is((select kind::text from cancel_claim), 'calendar_cancel',
          'the cancellation leases the delete operation');
select is((select calendar_version from cancel_claim), 3,
          'the delete operation carries the cancellation version');

select is(
  (public.record_calendar_outbox_result(
    (select outbox_id from cancel_claim),
    'calendar-worker-cancel',
    3,
    true,
    null,
    null
  ) ->> 'status'),
  'succeeded',
  'an idempotent provider delete completes the cancellation job'
);
select is(
  (select calendar_provider::text from public.sessions
   where id = (select id from drain_appointment)),
  'none',
  'successful cancellation clears the provider projection'
);
select is(
  (select calendar_event_id from public.sessions
   where id = (select id from drain_appointment)),
  null,
  'successful cancellation removes the provider event id'
);
select is(
  (select calendar_last_synced_version from public.sessions
   where id = (select id from drain_appointment)),
  3,
  'successful cancellation records the exact deleted version'
);
select is(
  (select count(*)::int
   from public.claim_calendar_outbox('calendar-worker-empty', 10, 120)),
  0,
  'a completed queue has nothing left to lease'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"d8111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
create temporary table permanent_appointment as
select (public.schedule_appointment(
  'a1111111-1111-4111-8111-111111111111',
  'd8311111-1111-4111-8111-111111111111',
  'tattoo_session',
  '2026-11-20T09:00:00Z',
  '2026-11-20T16:00:00Z',
  'confirmed',
  'd8411111-1111-4111-8111-111111111111',
  'd8611111-1111-4111-8111-111111111111',
  'Synthetic permanent Calendar failure test'
) ->> 'appointment_id')::uuid as id;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table permanent_claim as
select * from public.claim_calendar_outbox('calendar-worker-permanent', 10, 120);

select is((select count(*)::int from permanent_claim), 1,
          'the permanent-failure fixture leases one current Calendar job');
select is(
  (public.record_calendar_outbox_result(
    (select outbox_id from permanent_claim),
    'calendar-worker-permanent',
    0,
    false,
    null,
    'calendar_oauth_expired'
  ) ->> 'status'),
  'dead',
  'an expired OAuth grant is dead-lettered after the first proved attempt'
);
select is(
  (select attempt_count from public.integration_outbox
   where id = (select outbox_id from permanent_claim)),
  1,
  'a permanent failure records exactly one provider attempt'
);
select is(
  (select calendar_last_error_code from public.sessions
   where id = (select id from permanent_appointment)),
  'calendar_oauth_expired',
  'the CRM retains the safe reconnect-required error code'
);
select is(
  (select count(*)::int
   from public.claim_calendar_outbox('calendar-worker-no-permanent-retry', 10, 120)),
  0,
  'a permanent Calendar failure is never leased again automatically'
);

select * from finish(true);
rollback;
