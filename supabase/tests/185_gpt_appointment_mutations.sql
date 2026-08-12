-- 185_gpt_appointment_mutations.sql
--
-- Full synthetic Kristina GPT appointment lifecycle: create, reschedule,
-- optimistic-concurrency rejection, cancel and idempotent replay.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('e1011111-1111-4111-8111-111111111111', 'gpt-mutation-manager@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  (
    'e1011111-1111-4111-8111-111111111111',
    'gpt-mutation-manager@example.test',
    'GPT Mutation Manager',
    'booking_manager',
    true
  );

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values (
  'e1011111-1111-4111-8111-111111111111',
  'a2222222-2222-4222-8222-222222222222',
  'manager', false, false, true, false, true
);

create function pg_temp.gpt_mutation_claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.gpt_mutation_claims(text)
  to authenticated, service_role;

insert into public.clients (id, full_name, email) values (
  'e2011111-1111-4111-8111-111111111111',
  'Kristina GPT Mutation Client',
  'gpt-mutation-client@example.test'
);

-- Establish the client's existing Kristina relationship without introducing a
-- project or real client data.
insert into public.sessions (
  id, project_id, client_id, artist_id, appointment_type,
  status, start_at, end_at, duration_hours, notes
) values (
  'e3011111-1111-4111-8111-111111111111',
  null,
  'e2011111-1111-4111-8111-111111111111',
  'a2222222-2222-4222-8222-222222222222',
  'video_consultation',
  'completed',
  '2026-11-01T10:00:00Z',
  '2026-11-01T10:30:00Z',
  0.50,
  'Synthetic relationship fixture'
);

update crm_private.gpt_action_clients
set oauth_client_id = 'oauth-kristina-mutation-client',
    can_read_appointments = true,
    can_manage_appointments = true,
    is_active = true
where integration_key = 'kristina-gpt-actions';

set local role authenticated;
select pg_temp.gpt_mutation_claims(
  '{"sub":"e1011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-kristina-mutation-client"}'
);

create temporary table gpt_mutation_schedule_result as
select public.gpt_schedule_appointment(
  'e4011111-1111-4111-8111-111111111111',
  'e2011111-1111-4111-8111-111111111111',
  'in_person_consultation',
  '2026-11-02T10:00:00Z',
  '2026-11-02T10:30:00Z',
  'proposed',
  null,
  null,
  'Synthetic GPT mutation appointment'
) as result;
grant select on gpt_mutation_schedule_result to authenticated, service_role;

select is(
  (select result ->> 'calendar_version' from gpt_mutation_schedule_result),
  '0',
  'new GPT appointment starts at calendar version zero'
);
select is(
  (select result ->> 'idempotent_replay' from gpt_mutation_schedule_result),
  'false',
  'initial GPT appointment creation is not a replay'
);

create temporary table gpt_mutation_reschedule_result as
select public.gpt_reschedule_appointment(
  'e4022222-2222-4222-8222-222222222222',
  (select (result ->> 'appointment_id')::uuid from gpt_mutation_schedule_result),
  0,
  '2026-11-02T11:00:00Z',
  '2026-11-02T11:30:00Z'
) as result;
grant select on gpt_mutation_reschedule_result to authenticated, service_role;

select is(
  (select result ->> 'changed' from gpt_mutation_reschedule_result),
  'true',
  'GPT reschedule reports a real change'
);
select is(
  (select result ->> 'calendar_version' from gpt_mutation_reschedule_result),
  '1',
  'GPT reschedule increments calendar version atomically'
);
select is(
  (select start_at from public.sessions
   where id = (select (result ->> 'appointment_id')::uuid
               from gpt_mutation_schedule_result)),
  '2026-11-02T11:00:00Z'::timestamptz,
  'GPT reschedule stores the requested aligned start time'
);
select is(
  (select public.gpt_reschedule_appointment(
    'e4022222-2222-4222-8222-222222222222',
    (select (result ->> 'appointment_id')::uuid from gpt_mutation_schedule_result),
    0,
    '2026-11-02T11:00:00Z',
    '2026-11-02T11:30:00Z'
  ) ->> 'idempotent_replay'),
  'true',
  'an exact reschedule retry returns the stored result before reapplying it'
);
select throws_ok(
  format(
    $$select public.gpt_reschedule_appointment(
        'e4033333-3333-4333-8333-333333333333',
        %L,
        0,
        '2026-11-02T12:00:00Z',
        '2026-11-02T12:30:00Z'
      )$$,
    (select result ->> 'appointment_id' from gpt_mutation_schedule_result)
  ),
  '40001',
  null,
  'a stale calendar version cannot overwrite a newer GPT reschedule'
);

create temporary table gpt_mutation_cancel_result as
select public.gpt_cancel_appointment(
  'e4044444-4444-4444-8444-444444444444',
  (select (result ->> 'appointment_id')::uuid from gpt_mutation_schedule_result),
  1
) as result;
grant select on gpt_mutation_cancel_result to authenticated, service_role;

select is(
  (select result ->> 'to_status' from gpt_mutation_cancel_result),
  'cancelled',
  'GPT cancellation uses the canonical appointment status transition'
);
select is(
  (select result ->> 'calendar_version' from gpt_mutation_cancel_result),
  '2',
  'GPT cancellation returns the actual post-transition calendar version'
);
select is(
  (select result ->> 'idempotent_replay' from gpt_mutation_cancel_result),
  'false',
  'initial GPT cancellation is not a replay'
);
select is(
  (select status::text from public.sessions
   where id = (select (result ->> 'appointment_id')::uuid
               from gpt_mutation_schedule_result)),
  'cancelled',
  'GPT cancellation updates the authoritative appointment row'
);
select ok(
  (select cancelled_at is not null from public.sessions
   where id = (select (result ->> 'appointment_id')::uuid
               from gpt_mutation_schedule_result)),
  'GPT cancellation records the canonical cancellation timestamp'
);
select is(
  (select public.gpt_cancel_appointment(
    'e4044444-4444-4444-8444-444444444444',
    (select (result ->> 'appointment_id')::uuid from gpt_mutation_schedule_result),
    1
  ) ->> 'idempotent_replay'),
  'true',
  'an exact cancellation retry does not run the transition twice'
);
select throws_ok(
  format(
    $$select public.gpt_cancel_appointment(
        'e4055555-5555-4555-8555-555555555555',
        %L,
        1
      )$$,
    (select result ->> 'appointment_id' from gpt_mutation_schedule_result)
  ),
  '40001',
  null,
  'a stale version cannot issue a second cancellation action'
);
reset role;

select is(
  (select count(*)::int
   from public.sessions
   where notes = 'Synthetic GPT mutation appointment'),
  1,
  'idempotent retries never duplicate the appointment row'
);
select is(
  (select count(*)::int
   from crm_private.gpt_action_receipts
   where actor_profile_id = 'e1011111-1111-4111-8111-111111111111'),
  3,
  'one receipt is stored for create, reschedule and cancel'
);
select is(
  (select count(*)::int
   from public.activity_log
   where actor_profile_id = 'e1011111-1111-4111-8111-111111111111'
     and actor_kind = 'ai'
     and artist_id = 'a2222222-2222-4222-8222-222222222222'
     and event_type in (
       'appointment.ai_scheduled',
       'appointment.ai_rescheduled',
       'appointment.ai_cancelled'
     )),
  3,
  'all three GPT mutations are AI-audited against Kristina and the human actor'
);

select * from finish();
rollback;
