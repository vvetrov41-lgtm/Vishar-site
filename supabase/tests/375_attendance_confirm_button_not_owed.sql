-- 375_attendance_confirm_button_not_owed.sql
--
-- 20261111204748: a client's tap on Meta's "confirm attendance" quick reply is
-- an action, not a message that waits for the artist's reply. Every other
-- inbound message, including another button, still waits. Rolled back.

begin;
select no_plan();

create function pg_temp.client(p_n int) returns uuid language sql as $$
  select format('c3750000-0000-4000-8000-%s', lpad(p_n::text, 12, '0'))::uuid;
$$;
create function pg_temp.conv(p_n int) returns uuid language plpgsql as $$
declare
  v_client uuid := pg_temp.client(p_n);
  v_enquiry uuid := format('e3750000-0000-4000-8000-%s', lpad(p_n::text, 12, '0'))::uuid;
  v_conv uuid := format('d3750000-0000-4000-8000-%s', lpad(p_n::text, 12, '0'))::uuid;
begin
  insert into public.clients (id, full_name, email)
  values (v_client, 'Button ' || p_n, 'button-375-' || p_n || '@example.test');
  insert into public.enquiries (
    id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
    intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at, created_at
  ) values (
    v_enquiry, v_client, 'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-375' || p_n,
    format('e3759999-0000-4000-8000-%s', lpad(p_n::text, 12, '0'))::uuid,
    repeat(to_hex(p_n % 16), 64), 'reviewing', 'complete', 'Button ' || p_n,
    'button-375-' || p_n || '@example.test', '2026-08-05', now(), now() - interval '40 days');
  insert into public.communication_conversations (
    id, artist_id, channel, integration_key, external_contact_id, client_id, enquiry_id, link_state, state,
    last_message_at, last_inbound_at
  ) values (
    v_conv, 'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'button-375',
    '4477003750' || lpad(p_n::text, 2, '0'), v_client, v_enquiry, 'linked', 'open', now(), now());
  -- The appointment was confirmed three days ago, so on its own it is not
  -- evidence that a message arriving today was dealt with.
  insert into public.sessions (
    id, artist_id, client_id, enquiry_id, appointment_type, status, start_at, end_at, created_at)
  values (
    format('f3750000-0000-4000-8000-%s', lpad(p_n::text, 12, '0'))::uuid,
    'a1111111-1111-4111-8111-111111111111', v_client, v_enquiry,
    'in_person_consultation', 'confirmed',
    date_trunc('hour', now()) + interval '30 days',
    date_trunc('hour', now()) + interval '30 days 30 minutes',
    now() - interval '3 days');
  return v_conv;
end;
$$;
create function pg_temp.inbound(p_conv uuid, p_type text, p_recorded_at timestamptz) returns uuid language sql as $$
  insert into public.communication_messages (
    conversation_id, artist_id, channel, direction, origin, status, message_type, body, provider_timestamp, created_at)
  select p_conv, c.artist_id, c.channel, 'inbound', 'contact', 'received', p_type,
         case when p_type = 'text' then 'message 375' end, p_recorded_at - interval '2 seconds', p_recorded_at
  from public.communication_conversations c where c.id = p_conv
  returning id;
$$;
create function pg_temp.respond(p_n int, p_response text) returns void language sql as $$
  update public.sessions
  set client_response = p_response::public.appointment_client_response,
      client_response_at = now(),
      client_response_calendar_version = calendar_version
  where id = format('f3750000-0000-4000-8000-%s', lpad(p_n::text, 12, '0'))::uuid;
$$;

-- The helper is STABLE: it reads the snapshot of the calling statement, so each
-- message is recorded in its own statement before the helper is asked about it.
create temp table msg_375 (n int primary key, id uuid not null);

-- 1. An ordinary message after the confirmation still waits.
insert into msg_375 select 1, pg_temp.inbound(pg_temp.conv(1), 'text', now());
select isnt(
  (select count(*) from public.communication_messages m join msg_375 x on x.id = m.id),
  0::bigint,
  'fixture: the inbound message is recorded');
select is(
  crm_private.inbound_message_handled_by_booking((select id from msg_375 where n = 1)),
  null::timestamptz,
  '1. a text message after the appointment was confirmed is not handled by the booking');

-- 2. The attendance-confirmation button is recorded with the response itself.
select pg_temp.conv(2);
select pg_temp.respond(2, 'attendance_confirmed');
insert into msg_375 select 2, pg_temp.inbound('d3750000-0000-4000-8000-000000000002', 'button', now());
select is(
  crm_private.inbound_message_handled_by_booking((select id from msg_375 where n = 2)),
  now(),
  '2. the attendance-confirmation button is handled at the moment of the response');
select is(
  crm_private.conversation_awaiting_reply_since('d3750000-0000-4000-8000-000000000002'),
  null::timestamptz,
  '2. and the conversation does not wait for a reply');

-- 3. A reschedule request arrives through a button too and must stay owed.
select pg_temp.conv(3);
select pg_temp.respond(3, 'reschedule_requested');
insert into msg_375 select 3, pg_temp.inbound('d3750000-0000-4000-8000-000000000003', 'button', now());
select is(
  crm_private.inbound_message_handled_by_booking((select id from msg_375 where n = 3)),
  null::timestamptz,
  '3. a reschedule-request button is not suppressed');

-- 4. A button that was not recorded together with the confirmation stays owed.
-- It is recorded after the three-day-old confirmation, so only the button rule
-- could suppress it.
select pg_temp.conv(4);
select pg_temp.respond(4, 'attendance_confirmed');
insert into msg_375
select 4, pg_temp.inbound('d3750000-0000-4000-8000-000000000004', 'button', now() - interval '1 hour');
select is(
  crm_private.inbound_message_handled_by_booking((select id from msg_375 where n = 4)),
  null::timestamptz,
  '4. a button recorded at another time than the confirmation is not suppressed');

-- 5. A text message sent in the same instant as a confirmation is still a message.
select pg_temp.conv(5);
select pg_temp.respond(5, 'attendance_confirmed');
insert into msg_375 select 5, pg_temp.inbound('d3750000-0000-4000-8000-000000000005', 'text', now());
select is(
  crm_private.inbound_message_handled_by_booking((select id from msg_375 where n = 5)),
  null::timestamptz,
  '5. only the button itself is treated as the action');

select ok(
  not has_function_privilege('anon', 'crm_private.inbound_message_handled_by_booking(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'crm_private.inbound_message_handled_by_booking(uuid)', 'execute'),
  'the helper stays unavailable to API roles');

select * from finish(true);
rollback;
