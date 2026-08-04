-- 160_appointment_types.sql
--
-- Appointment types, projectless consultations, relationship consistency,
-- active overlap discovery and backwards-compatible session RPCs.

begin;
select no_plan();

select has_type('public', 'appointment_type', 'appointment_type enum exists');
select is(
  (select enum_range(null::public.appointment_type)::text),
  '{tattoo_session,in_person_consultation,video_consultation,touch_up}',
  'appointment type vocabulary is closed and ordered'
);
select has_column('public', 'sessions', 'appointment_type', 'sessions stores appointment type');
select has_column('public', 'sessions', 'client_id', 'sessions stores authoritative client');
select has_column('public', 'sessions', 'enquiry_id', 'sessions may link an enquiry');
select ok(
  not (select a.attnotnull from pg_attribute a
       where a.attrelid = 'public.sessions'::regclass
         and a.attname = 'project_id' and not a.attisdropped),
  'project_id is nullable for pre-project consultations'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.schedule_appointment(uuid,uuid,public.appointment_type,timestamptz,timestamptz,public.session_status,uuid,uuid,text)',
    'EXECUTE'
  ),
  'authenticated CRM users can call the protected appointment RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.schedule_appointment(uuid,uuid,public.appointment_type,timestamptz,timestamptz,public.session_status,uuid,uuid,text)',
    'EXECUTE'
  ),
  'anonymous callers cannot schedule appointments'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.list_appointment_conflicts(uuid,timestamptz,timestamptz,uuid)',
    'EXECUTE'
  ),
  'authenticated CRM users can request RLS-filtered conflicts'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('b8111111-1111-4111-8111-111111111111', 'appointment-manager@example.test'),
  ('b8122222-2222-4222-8222-222222222222', 'appointment-reader@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('b8111111-1111-4111-8111-111111111111', 'appointment-manager@example.test',
   'Appointment Manager', 'booking_manager', true),
  ('b8122222-2222-4222-8222-222222222222', 'appointment-reader@example.test',
   'Appointment Reader', 'read_only', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('b8111111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, false, true),
  ('b8122222-2222-4222-8222-222222222222',
   'a1111111-1111-4111-8111-111111111111',
   'read_only', false, false, false, false, true);

create function pg_temp.appointment_claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.appointment_claims(text) to authenticated, service_role;

insert into public.clients (id, full_name, email) values
  ('b8211111-1111-4111-8111-111111111111', 'Appointment Client', 'appointment-client@example.test'),
  ('b8222222-2222-4222-8222-222222222222', 'Other Appointment Client', 'other-appointment@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key,
  intake_fingerprint, status, intake_state, submitted_full_name,
  submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'b8311111-1111-4111-8111-111111111111',
  'b8211111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'PENDING', 'b8411111-1111-4111-8111-111111111111', repeat('b', 64),
  'accepted', 'complete', 'Appointment Client',
  'appointment-client@example.test', '2026-07-29', now()
);

insert into public.projects (
  id, client_id, enquiry_id, artist_id, title, status, currency
) values (
  'b8511111-1111-4111-8111-111111111111',
  'b8211111-1111-4111-8111-111111111111',
  'b8311111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'Appointment compatibility project', 'active', 'GBP'
);

-- An old-shape direct insert still succeeds: the compatibility trigger derives
-- client/enquiry, and the type defaults to tattoo_session.
insert into public.sessions (
  id, project_id, artist_id, status, start_at, end_at
) values (
  'b8611111-1111-4111-8111-111111111111',
  'b8511111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'proposed', '2026-09-10T09:00:00Z', '2026-09-10T16:00:00Z'
);

select is(
  (select appointment_type::text from public.sessions
   where id = 'b8611111-1111-4111-8111-111111111111'),
  'tattoo_session',
  'legacy session rows default to tattoo_session'
);
select is(
  (select client_id from public.sessions
   where id = 'b8611111-1111-4111-8111-111111111111'),
  'b8211111-1111-4111-8111-111111111111'::uuid,
  'legacy session rows inherit the project client'
);
select is(
  (select enquiry_id from public.sessions
   where id = 'b8611111-1111-4111-8111-111111111111'),
  'b8311111-1111-4111-8111-111111111111'::uuid,
  'legacy session rows inherit the project enquiry'
);

set local role authenticated;
select pg_temp.appointment_claims(
  '{"sub":"b8111111-1111-4111-8111-111111111111","role":"authenticated"}'
);

create temporary table video_result as
select public.schedule_appointment(
  'a1111111-1111-4111-8111-111111111111',
  'b8211111-1111-4111-8111-111111111111',
  'video_consultation',
  '2026-09-10T10:00:00Z',
  '2026-09-10T10:30:00Z',
  'proposed',
  'b8311111-1111-4111-8111-111111111111',
  null,
  'Synthetic video consultation'
) as result;
grant select on video_result to authenticated, service_role;

select is(
  (select appointment_type::text from public.sessions
   where id = (select (result ->> 'appointment_id')::uuid from video_result)),
  'video_consultation',
  'a video consultation is stored with its explicit type'
);
select is(
  (select project_id from public.sessions
   where id = (select (result ->> 'appointment_id')::uuid from video_result)),
  null::uuid,
  'a consultation can exist before project conversion'
);
select is(
  (select duration_hours from public.sessions
   where id = (select (result ->> 'appointment_id')::uuid from video_result)),
  0.50::numeric,
  'consultation duration is derived from its time range'
);

select lives_ok(
  $$select public.schedule_appointment(
      'a1111111-1111-4111-8111-111111111111',
      'b8211111-1111-4111-8111-111111111111',
      'in_person_consultation',
      '2026-09-12T12:00:00Z', '2026-09-12T12:45:00Z',
      'proposed', null, null, 'Synthetic client-only consultation'
    )$$,
  'an in-person consultation may be linked only to the shared client'
);

select throws_ok(
  $$select public.schedule_appointment(
      'a1111111-1111-4111-8111-111111111111',
      'b8211111-1111-4111-8111-111111111111',
      'tattoo_session',
      '2026-09-13T09:00:00Z', '2026-09-13T16:00:00Z',
      'proposed', 'b8311111-1111-4111-8111-111111111111', null, null
    )$$,
  '22023', null,
  'a tattoo session cannot be created without a project'
);

select throws_ok(
  $$select public.schedule_appointment(
      'a1111111-1111-4111-8111-111111111111',
      'b8222222-2222-4222-8222-222222222222',
      'video_consultation',
      '2026-09-14T10:00:00Z', '2026-09-14T10:30:00Z',
      'proposed', 'b8311111-1111-4111-8111-111111111111', null, null
    )$$,
  '23514', null,
  'a browser-selected client cannot contradict the enquiry client'
);

select lives_ok(
  $$select public.schedule_appointment(
      'a1111111-1111-4111-8111-111111111111',
      'b8211111-1111-4111-8111-111111111111',
      'touch_up',
      '2026-09-10T12:00:00Z', '2026-09-10T14:00:00Z',
      'proposed', 'b8311111-1111-4111-8111-111111111111',
      'b8511111-1111-4111-8111-111111111111', null
    )$$,
  'a touch-up may be scheduled against its source project'
);

select is(
  (select count(*)::int
   from public.list_appointment_conflicts(
     'a1111111-1111-4111-8111-111111111111',
     '2026-09-10T10:15:00Z', '2026-09-10T10:20:00Z', null
   )),
  2,
  'one authoritative conflict query sees tattoo and consultation overlaps'
);

select is(
  (select count(distinct appointment_type)::int
   from public.list_appointment_conflicts(
     'a1111111-1111-4111-8111-111111111111',
     '2026-09-10T10:15:00Z', '2026-09-10T10:20:00Z', null
   )),
  2,
  'the active conflict domain spans appointment types'
);

select lives_ok(
  format(
    $$select public.set_appointment_status(%L, 'confirmed')$$,
    (select result ->> 'appointment_id' from video_result)
  ),
  'a projectless consultation can be confirmed'
);

-- Managers intentionally cannot read integration_outbox. Verify the durable
-- projection boundary through the same backend-only RLS context used by the
-- outbox drain, rather than widening operational CRM visibility.
reset role;
select pg_temp.appointment_claims('{"role":"service_role"}');
select is(
  (select count(*)::int from public.integration_outbox
   where session_id = (select (result ->> 'appointment_id')::uuid from video_result)
     and kind = 'calendar_create'),
  1,
  'confirming a consultation queues the same future calendar projection boundary'
);
select is(
  (select count(*)::int from public.activity_log
   where session_id = (select (result ->> 'appointment_id')::uuid from video_result)
     and event_type = 'appointment.status_changed'),
  1,
  'appointment status changes are recorded in the append-only log'
);

set local role authenticated;
select pg_temp.appointment_claims(
  '{"sub":"b8111111-1111-4111-8111-111111111111","role":"authenticated"}'
);
select lives_ok(
  $$select public.schedule_session(
      'b8511111-1111-4111-8111-111111111111',
      '2026-09-20T09:00:00Z', '2026-09-20T16:00:00Z',
      'proposed', 'Compatibility RPC'
    )$$,
  'the legacy schedule_session RPC remains callable'
);
select is(
  (select appointment_type::text from public.sessions
   where notes = 'Compatibility RPC'),
  'tattoo_session',
  'the legacy RPC creates a tattoo_session appointment'
);

select pg_temp.appointment_claims(
  '{"sub":"b8122222-2222-4222-8222-222222222222","role":"authenticated"}'
);
select throws_ok(
  $$select public.schedule_appointment(
      'a1111111-1111-4111-8111-111111111111',
      'b8211111-1111-4111-8111-111111111111',
      'video_consultation',
      '2026-09-25T10:00:00Z', '2026-09-25T10:30:00Z',
      'proposed', 'b8311111-1111-4111-8111-111111111111', null, null
    )$$,
  '42501', null,
  'read-only membership cannot schedule appointments'
);

reset role;
select * from finish(true);
rollback;