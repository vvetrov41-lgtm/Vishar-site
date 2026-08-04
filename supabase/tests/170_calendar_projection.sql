-- 170_calendar_projection.sql
--
-- Calendar projection state, atomic rescheduling, versioned outbox work and
-- stale provider acknowledgement protection. No real provider is contacted.

begin;
select no_plan();

select has_type('public', 'calendar_sync_status', 'calendar sync status enum exists');
select has_column('public', 'sessions', 'calendar_sync_status', 'sessions expose calendar sync status');
select has_column('public', 'sessions', 'calendar_last_synced_version', 'sessions store the last synced version');
select has_column('public', 'sessions', 'calendar_last_synced_at', 'sessions store the last successful sync time');
select has_column('public', 'sessions', 'calendar_last_error_code', 'sessions store a safe calendar error code');
select has_function(
  'public', 'reschedule_appointment',
  array['uuid','timestamp with time zone','timestamp with time zone'],
  'reschedule workflow primitive exists'
);
select has_function(
  'public', 'record_calendar_sync_result',
  array['uuid','integer','boolean','calendar_provider','text','text'],
  'provider acknowledgement primitive exists'
);

select ok(
  not has_function_privilege(
    'anon', 'public.reschedule_appointment(uuid,timestamptz,timestamptz)', 'EXECUTE'
  ),
  'anonymous callers cannot reschedule appointments'
);
select ok(
  has_function_privilege(
    'authenticated', 'public.reschedule_appointment(uuid,timestamptz,timestamptz)', 'EXECUTE'
  ),
  'authenticated CRM users can call the protected reschedule RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.record_calendar_sync_result(uuid,integer,boolean,public.calendar_provider,text,text)',
    'EXECUTE'
  ),
  'service role can acknowledge provider results through the backend-only RPC'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('c8111111-1111-4111-8111-111111111111', 'calendar-owner@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('c8111111-1111-4111-8111-111111111111', 'calendar-owner@example.test',
   'Calendar Owner', 'owner', true);

insert into public.clients (id, full_name, email) values
  ('c8211111-1111-4111-8111-111111111111', 'Calendar Client', 'calendar-client@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'c8311111-1111-4111-8111-111111111111',
  'c8211111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'PENDING', 'c8411111-1111-4111-8111-111111111111', repeat('c', 64),
  'accepted', 'complete', 'Calendar Client',
  'calendar-client@example.test', '2026-07-29', now()
);

insert into public.projects (
  id, client_id, enquiry_id, artist_id, title, status, currency
) values (
  'c8511111-1111-4111-8111-111111111111',
  'c8211111-1111-4111-8111-111111111111',
  'c8311111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'Calendar projection project', 'active', 'GBP'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"c8111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

create temporary table calendar_appointment as
select (public.schedule_appointment(
  'a1111111-1111-4111-8111-111111111111',
  'c8211111-1111-4111-8111-111111111111',
  'tattoo_session',
  '2026-10-10T09:00:00Z',
  '2026-10-10T16:00:00Z',
  'confirmed',
  'c8311111-1111-4111-8111-111111111111',
  'c8511111-1111-4111-8111-111111111111',
  'Synthetic calendar projection test'
) ->> 'appointment_id')::uuid as id;

select is(
  (select calendar_sync_status::text from public.sessions
   where id = (select id from calendar_appointment)),
  'not_connected',
  'a confirmed appointment remains authoritative even before a provider is connected'
);
select is(
  (select count(*)::int from public.integration_outbox
   where session_id = (select id from calendar_appointment)
     and kind = 'calendar_create'),
  1,
  'confirmation queues one versioned calendar create operation'
);

select ok(
  (public.reschedule_appointment(
    (select id from calendar_appointment),
    '2026-10-11T10:00:00Z',
    '2026-10-11T17:00:00Z'
  ) ->> 'changed')::boolean,
  'reschedule atomically changes an active appointment'
);
select is(
  (select start_at from public.sessions where id = (select id from calendar_appointment)),
  '2026-10-11T10:00:00Z'::timestamptz,
  'reschedule stores the new start time'
);
select is(
  (select end_at from public.sessions where id = (select id from calendar_appointment)),
  '2026-10-11T17:00:00Z'::timestamptz,
  'reschedule stores the new end time'
);
select is(
  (select calendar_version from public.sessions where id = (select id from calendar_appointment)),
  1,
  'reschedule increments the calendar version exactly once'
);
select is(
  (select calendar_sync_status::text from public.sessions
   where id = (select id from calendar_appointment)),
  'queued',
  'an eligible reschedule becomes queued for projection'
);
select is(
  (select count(*)::int from public.integration_outbox
   where session_id = (select id from calendar_appointment)
     and kind = 'calendar_create'),
  2,
  'a reschedule without an existing provider event queues a new-version create operation'
);
select is(
  (select count(*)::int from public.activity_log
   where session_id = (select id from calendar_appointment)
     and event_type = 'appointment.rescheduled'),
  1,
  'reschedule appends one activity event'
);

select is(
  (public.reschedule_appointment(
    (select id from calendar_appointment),
    '2026-10-11T10:00:00Z',
    '2026-10-11T17:00:00Z'
  ) ->> 'changed')::boolean,
  false,
  'repeating the same reschedule is idempotent'
);
select is(
  (select calendar_version from public.sessions where id = (select id from calendar_appointment)),
  1,
  'an idempotent reschedule does not increment the version again'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok(
  (public.record_calendar_sync_result(
    (select id from calendar_appointment), 1, true, 'google', 'synthetic-event-id', null
  ) ->> 'applied')::boolean,
  'a current successful provider result is applied'
);
select is(
  (select calendar_sync_status::text from public.sessions
   where id = (select id from calendar_appointment)),
  'synced',
  'successful acknowledgement marks the projection synced'
);
select is(
  (select calendar_last_synced_version from public.sessions
   where id = (select id from calendar_appointment)),
  1,
  'successful acknowledgement stores the exact synced version'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"c8111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
select ok(
  (public.reschedule_appointment(
    (select id from calendar_appointment),
    '2026-10-12T10:00:00Z',
    '2026-10-12T17:00:00Z'
  ) ->> 'changed')::boolean,
  'a synced appointment can be rescheduled again'
);
select is(
  (select count(*)::int from public.integration_outbox
   where session_id = (select id from calendar_appointment)
     and kind = 'calendar_update'),
  1,
  'a reschedule with an existing event queues one calendar update'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok(
  (public.record_calendar_sync_result(
    (select id from calendar_appointment), 1, false, 'google', null, 'stale_failure'
  ) ->> 'stale')::boolean,
  'a stale provider response is recognised'
);
select is(
  (select calendar_sync_status::text from public.sessions
   where id = (select id from calendar_appointment)),
  'queued',
  'a stale response cannot overwrite the newer queued state'
);

select * from finish(true);
rollback;
