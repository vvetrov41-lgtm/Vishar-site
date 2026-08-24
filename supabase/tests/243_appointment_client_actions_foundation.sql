-- 243_appointment_client_actions_foundation.sql
--
-- Client appointment capabilities are intentionally inert until a later
-- lifecycle-template activation calls the private minting primitive. This test
-- proves the foundation itself: capability secrecy, scanner-safe readback,
-- attendance/reschedule response semantics, stale-version invalidation and the
-- existing Calendar cancellation path.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select has_table('crm_private', 'appointment_client_action_tokens',
  'private appointment action capability table exists');
select hasnt_column('crm_private', 'appointment_client_action_tokens', 'raw_token',
  'raw appointment action token has no storage column');
select has_column('crm_private', 'appointment_client_action_tokens', 'token_hash',
  'only an appointment action token hash is persisted');

select ok(not has_table_privilege('anon',
  'crm_private.appointment_client_action_tokens', 'SELECT'),
  'anon cannot inspect appointment action capabilities');
select ok(not has_table_privilege('authenticated',
  'crm_private.appointment_client_action_tokens', 'SELECT'),
  'browser cannot inspect appointment action capabilities');
select ok(not has_table_privilege('service_role',
  'crm_private.appointment_client_action_tokens', 'SELECT'),
  'backend reaches capabilities only through narrow RPCs');

select ok(not has_function_privilege('anon',
  'public.service_resolve_appointment_client_action(text)', 'EXECUTE'),
  'anon cannot resolve appointment capabilities directly');
select ok(not has_function_privilege('authenticated',
  'public.service_resolve_appointment_client_action(text)', 'EXECUTE'),
  'browser cannot resolve appointment capabilities directly');
select ok(has_function_privilege('service_role',
  'public.service_resolve_appointment_client_action(text)', 'EXECUTE'),
  'service backend may resolve a capability through the narrow readback RPC');
select ok(not has_function_privilege('authenticated',
  'public.service_apply_appointment_client_action(text)', 'EXECUTE'),
  'browser cannot apply appointment capabilities directly');
select ok(has_function_privilege('service_role',
  'public.service_apply_appointment_client_action(text)', 'EXECUTE'),
  'service backend may apply a capability through the narrow mutation RPC');
select ok(not has_function_privilege('service_role',
  'crm_private.issue_appointment_client_actions(uuid)', 'EXECUTE'),
  'public Worker service role cannot mint arbitrary client capabilities');

create temporary table t_artist as
select a.id, a.workspace_id, a.display_name
from public.artists a
join crm_private.artist_state s on s.artist_id = a.id and s.is_active
where a.slug = 'vladimir';
grant select on t_artist to service_role;

select is((select count(*)::int from t_artist), 1,
  'canonical test install has exactly one active Vladimir artist');
select ok(
  (select count(*) > 0
   from crm_private.automation_notification_recipients((select id from t_artist))),
  'active artist has at least one internal notification recipient');

insert into public.clients (id, full_name, email) values
  ('e9011111-1111-4111-8111-111111111111', 'Client Action Fixture', 'client-action@example.test');

-- Projectless consultations keep this fixture focused on appointment lifecycle
-- rather than project conversion. Each is 30 minutes, inside the domain bounds.
-- date_trunc keeps fixtures on the canonical five-minute appointment grid.
insert into public.sessions (
  id, artist_id, client_id, appointment_type, status, start_at, end_at,
  calendar_event_id
) values
  ('e9022222-2222-4222-8222-222222222221', (select id from t_artist),
   'e9011111-1111-4111-8111-111111111111', 'in_person_consultation', 'confirmed',
   date_trunc('hour', now()) + interval '5 days',
   date_trunc('hour', now()) + interval '5 days 30 minutes', null),
  ('e9022222-2222-4222-8222-222222222222', (select id from t_artist),
   'e9011111-1111-4111-8111-111111111111', 'in_person_consultation', 'confirmed',
   date_trunc('hour', now()) + interval '6 days',
   date_trunc('hour', now()) + interval '6 days 30 minutes', null),
  ('e9022222-2222-4222-8222-222222222223', (select id from t_artist),
   'e9011111-1111-4111-8111-111111111111', 'in_person_consultation', 'confirmed',
   date_trunc('hour', now()) + interval '7 days',
   date_trunc('hour', now()) + interval '7 days 30 minutes', null),
  ('e9022222-2222-4222-8222-222222222224', (select id from t_artist),
   'e9011111-1111-4111-8111-111111111111', 'in_person_consultation', 'confirmed',
   date_trunc('hour', now()) + interval '6 days 12 hours',
   date_trunc('hour', now()) + interval '6 days 12 hours 30 minutes', 'client-action-calendar-event');

create temporary table t_tokens (
  fixture text not null,
  session_id uuid not null,
  action public.appointment_client_action not null,
  raw_token text not null,
  expires_at timestamptz not null,
  primary key (fixture, action)
);
grant select on t_tokens to service_role;

insert into t_tokens
select 'confirm', 'e9022222-2222-4222-8222-222222222221'::uuid,
       x.action, x.raw_token, x.expires_at
from crm_private.issue_appointment_client_actions(
  'e9022222-2222-4222-8222-222222222221'::uuid) x;
insert into t_tokens
select 'reschedule', 'e9022222-2222-4222-8222-222222222222'::uuid,
       x.action, x.raw_token, x.expires_at
from crm_private.issue_appointment_client_actions(
  'e9022222-2222-4222-8222-222222222222'::uuid) x;
insert into t_tokens
select 'stale', 'e9022222-2222-4222-8222-222222222223'::uuid,
       x.action, x.raw_token, x.expires_at
from crm_private.issue_appointment_client_actions(
  'e9022222-2222-4222-8222-222222222223'::uuid) x;
insert into t_tokens
select 'cancel', 'e9022222-2222-4222-8222-222222222224'::uuid,
       x.action, x.raw_token, x.expires_at
from crm_private.issue_appointment_client_actions(
  'e9022222-2222-4222-8222-222222222224'::uuid) x;

select is((select count(*)::int from t_tokens), 12,
  'each eligible appointment receives exactly three action capabilities');
select ok((select bool_and(length(raw_token) = 64 and raw_token ~ '^[0-9a-f]{64}$') from t_tokens),
  'raw capabilities are 256-bit lowercase hex values');
select ok((select bool_and(expires_at <= (select start_at from public.sessions s where s.id=t.session_id)) from t_tokens t),
  'capabilities never outlive their appointment');
select is(
  (select token_hash from crm_private.appointment_client_action_tokens
   where session_id='e9022222-2222-4222-8222-222222222221'
     and action='confirm_attendance'),
  encode(extensions.digest(
    (select raw_token from t_tokens where fixture='confirm' and action='confirm_attendance'),
    'sha256'), 'hex'),
  'only the SHA-256 digest of the returned raw capability is stored');
select isnt(
  (select token_hash from crm_private.appointment_client_action_tokens
   where session_id='e9022222-2222-4222-8222-222222222221'
     and action='confirm_attendance'),
  (select raw_token from t_tokens where fixture='confirm' and action='confirm_attendance'),
  'raw capability is not persisted as its hash');

-- ---------------------------------------------------------------------------
-- Scanner-safe resolution and attendance confirmation
-- ---------------------------------------------------------------------------

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select action::text from public.service_resolve_appointment_client_action(
    (select raw_token from t_tokens where fixture='confirm' and action='confirm_attendance'))),
  'confirm_attendance',
  'backend GET/readback resolves the action without consuming it');
select is(
  (select artist_display_name from public.service_resolve_appointment_client_action(
    (select raw_token from t_tokens where fixture='confirm' and action='confirm_attendance'))),
  (select display_name from t_artist),
  'readback exposes only the safe artist label alongside the action');
select lives_ok(
  $$select public.service_apply_appointment_client_action(
      (select raw_token from t_tokens where fixture='confirm' and action='confirm_attendance'))$$,
  'attendance capability applies once');
reset role;

select is((select status::text from public.sessions where id='e9022222-2222-4222-8222-222222222221'),
  'confirmed', 'attendance confirmation does not rewrite booking status');
select is((select calendar_version from public.sessions where id='e9022222-2222-4222-8222-222222222221'),
  0, 'attendance confirmation does not create a Calendar mutation');
select is((select client_response::text from public.sessions where id='e9022222-2222-4222-8222-222222222221'),
  'attendance_confirmed', 'attendance confirmation is stored separately from booking status');
select is((select client_response_calendar_version from public.sessions where id='e9022222-2222-4222-8222-222222222221'),
  0, 'attendance confirmation is bound to the current appointment version');
select is((select count(*)::int from crm_private.appointment_client_action_tokens
           where session_id='e9022222-2222-4222-8222-222222222221'
             and consumed_at is not null),
  1, 'chosen attendance capability is consumed');
select is((select count(*)::int from crm_private.appointment_client_action_tokens
           where session_id='e9022222-2222-4222-8222-222222222221'
             and invalidated_at is not null),
  2, 'contradictory sibling capabilities are invalidated atomically');
select is((select count(*)::int from public.activity_log
           where session_id='e9022222-2222-4222-8222-222222222221'
             and event_type='appointment.client_response'
             and metadata->>'response'='attendance_confirmed'
             and metadata->>'source'='client_action_link'),
  1, 'attendance response has auditable worker provenance');
select is((select count(*)::int from public.notifications
           where entity_type='session'
             and entity_id='e9022222-2222-4222-8222-222222222221'
             and notification_type='appointment.attendance_confirmed'),
  (select count(*)::int from crm_private.automation_notification_recipients((select id from t_artist)),
  'attendance confirmation notifies exactly the current artist recipients');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.service_apply_appointment_client_action(
      (select raw_token from t_tokens where fixture='confirm' and action='confirm_attendance'))$$,
  '42501', null,
  'consumed attendance capability cannot be replayed');
reset role;

-- A later schedule mutation makes the response stale and clears it.
update public.sessions
set start_at = start_at + interval '1 day',
    end_at = end_at + interval '1 day',
    calendar_version = calendar_version + 1
where id='e9022222-2222-4222-8222-222222222221';
select is((select client_response::text from public.sessions where id='e9022222-2222-4222-8222-222222222221'),
  null, 'rescheduling clears the old attendance response');
select is((select client_response_at from public.sessions where id='e9022222-2222-4222-8222-222222222221'),
  null, 'rescheduling clears the old response timestamp');

-- ---------------------------------------------------------------------------
-- Reschedule request is a request, never a slot mutation
-- ---------------------------------------------------------------------------

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.service_apply_appointment_client_action(
      (select raw_token from t_tokens where fixture='reschedule' and action='request_reschedule'))$$,
  'reschedule request capability applies once');
reset role;

select is((select status::text from public.sessions where id='e9022222-2222-4222-8222-222222222222'),
  'confirmed', 'reschedule request leaves the current appointment confirmed');
select is((select calendar_version from public.sessions where id='e9022222-2222-4222-8222-222222222222'),
  0, 'reschedule request does not mutate Calendar version');
select is((select client_response::text from public.sessions where id='e9022222-2222-4222-8222-222222222222'),
  'reschedule_requested', 'reschedule request is represented explicitly');
select is((select count(*)::int from public.integration_outbox
           where session_id='e9022222-2222-4222-8222-222222222222'),
  0, 'reschedule request cannot enqueue a Calendar move by itself');
select is((select count(*)::int from public.notifications
           where entity_type='session'
             and entity_id='e9022222-2222-4222-8222-222222222222'
             and notification_type='appointment.reschedule_requested'
             and priority='high'),
  (select count(*)::int from crm_private.automation_notification_recipients((select id from t_artist)),
  'reschedule request creates a high-priority internal notification');

-- ---------------------------------------------------------------------------
-- Unconsumed links are version-bound and stale after a real schedule change
-- ---------------------------------------------------------------------------

update public.sessions
set start_at = start_at + interval '1 day',
    end_at = end_at + interval '1 day',
    calendar_version = calendar_version + 1
where id='e9022222-2222-4222-8222-222222222223';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select * from public.service_resolve_appointment_client_action(
      (select raw_token from t_tokens where fixture='stale' and action='cancel'))$$,
  '42501', null,
  'GET/readback rejects a token from an older appointment version');
select throws_ok(
  $$select public.service_apply_appointment_client_action(
      (select raw_token from t_tokens where fixture='stale' and action='cancel'))$$,
  '42501', null,
  'POST rejects a token from an older appointment version');
select throws_ok(
  $$select public.service_resolve_appointment_client_action('not-a-token')$$,
  '42501', null,
  'malformed capability is rejected generically');
reset role;

-- ---------------------------------------------------------------------------
-- Client cancellation preserves status, activity and Calendar outbox invariants
-- ---------------------------------------------------------------------------

-- Prove cancellation also clears a previously recorded response for the same
-- version. This direct fixture represents an already-confirmed attendance flag.
update public.sessions
set client_response='attendance_confirmed',
    client_response_at=now(),
    client_response_calendar_version=calendar_version
where id='e9022222-2222-4222-8222-222222222224';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.service_apply_appointment_client_action(
      (select raw_token from t_tokens where fixture='cancel' and action='cancel'))$$,
  'client cancellation capability applies once');
reset role;

select is((select status::text from public.sessions where id='e9022222-2222-4222-8222-222222222224'),
  'cancelled', 'client cancellation reaches the canonical terminal status');
select ok((select cancelled_at is not null from public.sessions where id='e9022222-2222-4222-8222-222222222224'),
  'client cancellation records cancelled_at');
select is((select calendar_version from public.sessions where id='e9022222-2222-4222-8222-222222222224'),
  1, 'client cancellation increments Calendar version exactly once');
select is((select client_response::text from public.sessions where id='e9022222-2222-4222-8222-222222222224'),
  null, 'terminal cancellation clears any earlier client response');
select is((select count(*)::int from public.activity_log
           where session_id='e9022222-2222-4222-8222-222222222224'
             and event_type='appointment.status_changed'
             and metadata->>'from_status'='confirmed'
             and metadata->>'to_status'='cancelled'
             and metadata->>'source'='client_action_link'
             and actor_kind='worker'),
  1, 'client cancellation records the normal status event with worker provenance');
select is((select count(*)::int from public.integration_outbox
           where kind='calendar_cancel'
             and session_id='e9022222-2222-4222-8222-222222222224'
             and dedupe_key=public.calendar_outbox_dedupe_key(
               'cancel', 'e9022222-2222-4222-8222-222222222224'::uuid, 1)),
  1, 'client cancellation reaches the existing Calendar cancellation outbox exactly once');
select is((select payload->>'calendar_version' from public.integration_outbox
           where kind='calendar_cancel'
             and session_id='e9022222-2222-4222-8222-222222222224'),
  '1', 'Calendar cancellation payload carries the new authoritative version');
select is((select count(*)::int from public.notifications
           where entity_type='session'
             and entity_id='e9022222-2222-4222-8222-222222222224'
             and notification_type='appointment.cancelled_by_client'
             and priority='high'),
  (select count(*)::int from crm_private.automation_notification_recipients((select id from t_artist)),
  'client cancellation creates a high-priority internal notification');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.service_apply_appointment_client_action(
      (select raw_token from t_tokens where fixture='cancel' and action='cancel'))$$,
  '42501', null,
  'client cancellation capability cannot be replayed');
reset role;

-- Unknown appointment.client_response activity is deliberately outside the
-- automation trigger catalogue and therefore cannot recursively create jobs.
select is((select count(*)::int from public.automation_events ae
           join public.activity_log al on al.id=ae.activity_id
           where al.event_type='appointment.client_response'),
  0, 'client response activity does not project into lifecycle automation events');

select finish();
rollback;
