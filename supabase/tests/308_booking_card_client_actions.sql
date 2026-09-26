-- 308_booking_card_client_actions.sql

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.clients (id, full_name, email) values (
  'fb211111-1111-4111-8111-111111111111',
  'Booking Action Client',
  'booking-action@example.test'
);

insert into public.sessions (
  id, project_id, client_id, artist_id, appointment_type,
  status, start_at, end_at, duration_hours, currency
) values (
  'fb611111-1111-4111-8111-111111111111',
  null,
  'fb211111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'in_person_consultation',
  'confirmed',
  now() + interval '30 days',
  now() + interval '30 days 30 minutes',
  0.5,
  'GBP'
);

select is(
  (select count(*)::int
   from crm_private.booking_cards
   where session_id = 'fb611111-1111-4111-8111-111111111111'
     and superseded_at is null),
  1,
  'the confirmed consultation has one canonical booking card'
);

create temporary table issued_actions as
select *
from crm_private.issue_booking_card_client_actions(
  (select id
   from crm_private.booking_cards
   where session_id = 'fb611111-1111-4111-8111-111111111111'
     and superseded_at is null)
);

select is(
  (select count(*)::int from issued_actions),
  2,
  'a booking card mints exactly two client actions'
);

select results_eq(
  $$ select action::text from issued_actions order by action::text $$,
  $$ values ('confirm_attendance'::text), ('request_reschedule'::text) $$,
  'booking cards contain confirm and reschedule only'
);

select is(
  (select count(*)::int
   from crm_private.appointment_client_action_tokens
   where session_id = 'fb611111-1111-4111-8111-111111111111'
     and action = 'cancel'
     and consumed_at is null
     and invalidated_at is null),
  0,
  'booking cards never mint a live cancel capability'
);

select ok(
  (select bool_and(raw_token ~ '^[0-9a-f]{64}

select ok(
  not exists (
    select 1
    from issued_actions a
    join crm_private.appointment_client_action_tokens t
      on t.token_hash = a.raw_token
  ),
  'raw capabilities are not stored as token hashes'
);

select is(
  (select min(expires_at) from issued_actions),
  now() + interval '7 days',
  'booking-card actions are bounded to seven days even for a distant appointment'
);

create temporary table issued_actions_second as
select *
from crm_private.issue_booking_card_client_actions(
  (select id
   from crm_private.booking_cards
   where session_id = 'fb611111-1111-4111-8111-111111111111'
     and superseded_at is null)
);

select is(
  (select count(*)::int
   from crm_private.appointment_client_action_tokens
   where session_id = 'fb611111-1111-4111-8111-111111111111'
     and consumed_at is null
     and invalidated_at is null),
  4,
  'a second delivery channel gets its own pair without invalidating the first'
);

select ok(
  not exists (
    select 1
    from issued_actions a
    join crm_private.appointment_client_action_tokens t
      on t.token_hash = encode(extensions.digest(a.raw_token, 'sha256'), 'hex')
    where t.invalidated_at is not null
       or t.consumed_at is not null
  ),
  'previously issued channel capabilities remain live until one response wins'
);

select ok(
  not has_function_privilege(
    'service_role',
    'crm_private.issue_booking_card_client_actions(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'crm_private.issue_booking_card_client_actions(uuid)',
    'EXECUTE'
  ),
  'no API role can mint booking-card capabilities'
);

select * from finish(true);
rollback;
) from issued_actions),
  'raw capabilities have the expected 256-bit shape'
);

select ok(
  (select bool_and(t.booking_card_id = b.id)
   from issued_actions a
   join crm_private.appointment_client_action_tokens t
     on t.token_hash = encode(extensions.digest(a.raw_token, 'sha256'), 'hex')
   join crm_private.booking_cards b
     on b.id = t.booking_card_id
   where b.session_id = 'fb611111-1111-4111-8111-111111111111'),
  'booking-card capabilities are explicitly bound to their source card'
);

select ok(
  not exists (
    select 1
    from issued_actions a
    join crm_private.appointment_client_action_tokens t
      on t.token_hash = a.raw_token
  ),
  'raw capabilities are not stored as token hashes'
);

select is(
  (select min(expires_at) from issued_actions),
  now() + interval '7 days',
  'booking-card actions are bounded to seven days even for a distant appointment'
);

create temporary table issued_actions_second as
select *
from crm_private.issue_booking_card_client_actions(
  (select id
   from crm_private.booking_cards
   where session_id = 'fb611111-1111-4111-8111-111111111111'
     and superseded_at is null)
);

select is(
  (select count(*)::int
   from crm_private.appointment_client_action_tokens
   where session_id = 'fb611111-1111-4111-8111-111111111111'
     and consumed_at is null
     and invalidated_at is null),
  4,
  'a second delivery channel gets its own pair without invalidating the first'
);

select ok(
  not exists (
    select 1
    from issued_actions a
    join crm_private.appointment_client_action_tokens t
      on t.token_hash = encode(extensions.digest(a.raw_token, 'sha256'), 'hex')
    where t.invalidated_at is not null
       or t.consumed_at is not null
  ),
  'previously issued channel capabilities remain live until one response wins'
);

select ok(
  not has_function_privilege(
    'service_role',
    'crm_private.issue_booking_card_client_actions(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'crm_private.issue_booking_card_client_actions(uuid)',
    'EXECUTE'
  ),
  'no API role can mint booking-card capabilities'
);

select * from finish(true);
rollback;
