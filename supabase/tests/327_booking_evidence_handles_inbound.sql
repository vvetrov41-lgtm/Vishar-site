-- 327_booking_evidence_handles_inbound.sql
--
-- A confirmed booking is evidence the studio dealt with a client's message
-- (20261006120000): crm_private.inbound_message_handled_by_booking, applied by
-- conversation_awaiting_reply_since (Today, reminders, Inbox) and by
-- attention_comm_facts. Everything is rolled back.

begin;
select no_plan();

-- The studio's phone replies are visible from ten days ago on this channel.
create function pg_temp.conv(p_n int, p_channel text default 'whatsapp') returns uuid language plpgsql as $$
declare
  v_client uuid := format('c3270000-0000-4000-8000-%s', lpad(p_n::text, 12, '0'))::uuid;
  v_enquiry uuid := format('e3270000-0000-4000-8000-%s', lpad(p_n::text, 12, '0'))::uuid;
  v_conv uuid := format('d3270000-0000-4000-8000-%s', lpad(p_n::text, 12, '0'))::uuid;
begin
  insert into public.clients (id, full_name, email) values (v_client, 'Booked ' || p_n, 'booked-327-' || p_n || '@example.test');
  insert into public.enquiries (
    id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
    intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at, created_at
  ) values (
    v_enquiry, v_client, 'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-327' || p_n,
    format('e3279999-0000-4000-8000-%s', lpad(p_n::text, 12, '0'))::uuid,
    repeat(to_hex(p_n % 16), 64), 'reviewing', 'complete', 'Booked ' || p_n,
    'booked-327-' || p_n || '@example.test', '2026-08-05', now(), now() - interval '40 days');
  insert into public.communication_conversations (
    id, artist_id, channel, integration_key, external_contact_id, client_id, enquiry_id, link_state, state,
    last_message_at, last_inbound_at
  ) values (
    v_conv, 'a1111111-1111-4111-8111-111111111111', p_channel::public.communication_channel, 'booked-327',
    case when p_channel = 'whatsapp' then '4477003270' || lpad(p_n::text, 2, '0') else '1784032700000' || lpad(p_n::text, 2, '0') end,
    v_client, v_enquiry, 'linked', 'open', now(), now());
  return v_conv;
end;
$$;
create function pg_temp.client(p_n int) returns uuid language sql as $$
  select format('c3270000-0000-4000-8000-%s', lpad(p_n::text, 12, '0'))::uuid;
$$;
create function pg_temp.enquiry(p_n int) returns uuid language sql as $$
  select format('e3270000-0000-4000-8000-%s', lpad(p_n::text, 12, '0'))::uuid;
$$;
create function pg_temp.inbound(p_conv uuid, p_at timestamptz) returns void language sql as $$
  insert into public.communication_messages (
    conversation_id, artist_id, channel, direction, origin, status, message_type, body, provider_timestamp, created_at)
  select p_conv, c.artist_id, c.channel, 'inbound', 'contact', 'received', 'text', 'message 327', p_at, p_at
  from public.communication_conversations c where c.id = p_conv;
$$;
create function pg_temp.appointment(
  p_n int, p_type text, p_created timestamptz, p_status text default 'confirmed', p_enquiry uuid default null
) returns uuid language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
  v_project uuid;
begin
  if p_type = 'tattoo_session' then
    v_project := gen_random_uuid();
    insert into public.projects (id, client_id, artist_id, enquiry_id, title, status, currency)
    values (v_project, pg_temp.client(p_n), 'a1111111-1111-4111-8111-111111111111',
            coalesce(p_enquiry, pg_temp.enquiry(p_n)), 'Project 327', 'active', 'GBP');
  end if;
  insert into public.sessions (
    id, project_id, artist_id, client_id, enquiry_id, appointment_type, status, start_at, end_at, created_at, cancelled_at)
  values (
    v_id, v_project, 'a1111111-1111-4111-8111-111111111111', pg_temp.client(p_n),
    case when p_type = 'tattoo_session' then null else coalesce(p_enquiry, pg_temp.enquiry(p_n)) end,
    p_type::public.appointment_type, p_status::public.session_status,
    date_trunc('hour', now()) + interval '30 days',
    date_trunc('hour', now()) + interval '30 days' + case when p_type = 'tattoo_session' then interval '4 hours' else interval '30 minutes' end,
    p_created, case when p_status = 'cancelled' then p_created + interval '1 hour' end);
  return v_id;
end;
$$;
create function pg_temp.waiting(p_conv uuid) returns boolean language sql as $$
  select crm_private.conversation_awaiting_reply_since(p_conv) is not null;
$$;
create function pg_temp.in_today(p_conv uuid) returns boolean language sql as $$
  select exists (
    select 1 from jsonb_array_elements(crm_private.pulse_items('a1111111-1111-4111-8111-111111111111', false, false)) i
    where i ->> 'key' = 'reply-' || p_conv);
$$;

-- Capture of phone replies on WhatsApp began ten days ago.
select pg_temp.conv(99);
insert into public.communication_messages (
  conversation_id, artist_id, channel, direction, origin, status, message_type, body, provider_timestamp, sent_at, created_at)
values ('d3270000-0000-4000-8000-000000000099', 'a1111111-1111-4111-8111-111111111111', 'whatsapp',
  'outbound', 'provider_app', 'read', 'text', 'capture starts', now() - interval '10 days', now() - interval '10 days',
  now() - interval '10 days');

-- 1. inbound, nothing after it: waits.
select pg_temp.inbound(pg_temp.conv(1), now() - interval '2 days');
select ok(pg_temp.waiting('d3270000-0000-4000-8000-000000000001'), '1. an unanswered message with no action waits');
select ok(pg_temp.in_today('d3270000-0000-4000-8000-000000000001'), '1. and is in Today');

-- 2. inbound, then a confirmed consultation for the same enquiry.
select pg_temp.inbound(pg_temp.conv(2), now() - interval '2 days');
select pg_temp.appointment(2, 'in_person_consultation', now() - interval '1 day');
select ok(not pg_temp.waiting('d3270000-0000-4000-8000-000000000002'), '2. a consultation confirmed after the message handles it');
select ok(not pg_temp.in_today('d3270000-0000-4000-8000-000000000002'), '2. and it is not in Today');

-- 3. inbound, then a confirmed tattoo session (through the enquiry's project).
select pg_temp.inbound(pg_temp.conv(3), now() - interval '2 days');
select pg_temp.appointment(3, 'tattoo_session', now() - interval '1 day');
select ok(not pg_temp.waiting('d3270000-0000-4000-8000-000000000003'), '3. a tattoo session confirmed after the message handles it');

-- 4. the consultation existed before a new (captured) message: it waits.
select pg_temp.conv(4);
select pg_temp.appointment(4, 'in_person_consultation', now() - interval '3 days');
select pg_temp.inbound('d3270000-0000-4000-8000-000000000004', now() - interval '2 days');
select ok(pg_temp.waiting('d3270000-0000-4000-8000-000000000004'), '4. a message after the consultation was confirmed still waits');
select ok(pg_temp.in_today('d3270000-0000-4000-8000-000000000004'), '4. and is in Today');

-- 5. a cancelled appointment proves nothing.
select pg_temp.inbound(pg_temp.conv(5), now() - interval '2 days');
select pg_temp.appointment(5, 'in_person_consultation', now() - interval '1 day', 'cancelled');
select ok(pg_temp.waiting('d3270000-0000-4000-8000-000000000005'), '5. a cancelled appointment is not evidence');

-- 6. another enquiry's or another client's appointment proves nothing.
select pg_temp.inbound(pg_temp.conv(6), now() - interval '2 days');
select pg_temp.conv(7);
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'e3276666-0000-4000-8000-000000000000', pg_temp.client(6), 'a1111111-1111-4111-8111-111111111111',
  'ENQ-2099-32766', 'e3276666-9999-4000-8000-000000000000', repeat('f', 64), 'reviewing', 'complete',
  'Booked 6', 'booked-327-6@example.test', '2026-08-05', now());
select pg_temp.appointment(6, 'in_person_consultation', now() - interval '1 day', 'confirmed', 'e3276666-0000-4000-8000-000000000000');
select pg_temp.appointment(7, 'in_person_consultation', now() - interval '1 day');
select ok(pg_temp.waiting('d3270000-0000-4000-8000-000000000006'),
  '6. an appointment for another enquiry of the client, or for another client, is not evidence');

-- 7. a new real message after the confirmed consultation waits again.
select pg_temp.inbound('d3270000-0000-4000-8000-000000000002', now() - interval '1 hour');
select ok(pg_temp.waiting('d3270000-0000-4000-8000-000000000002'), '7. a new message after the consultation waits again');
select ok(pg_temp.in_today('d3270000-0000-4000-8000-000000000002'), '7. and is back in Today');

-- Mark/Bradley: a message from before the studio's replies were captured,
-- with a confirmed consultation for the same enquiry (confirmed before it).
select pg_temp.conv(8);
select pg_temp.appointment(8, 'in_person_consultation', now() - interval '21 days');
select pg_temp.inbound('d3270000-0000-4000-8000-000000000008', now() - interval '20 days');
select ok(not pg_temp.waiting('d3270000-0000-4000-8000-000000000008'),
  'a pre-capture message with a confirmed booking for the same enquiry is not owed');
select is(crm_private.unanswered_waiting_since('conversation', 'a1111111-1111-4111-8111-111111111111',
  'd3270000-0000-4000-8000-000000000008'), null::timestamptz, 'and sends no Telegram reminder');

-- ... but not on a channel that never captured studio replies.
select pg_temp.conv(9, 'instagram');
select pg_temp.appointment(9, 'in_person_consultation', now() - interval '21 days');
select pg_temp.inbound('d3270000-0000-4000-8000-000000000009', now() - interval '20 days');
select ok(pg_temp.waiting('d3270000-0000-4000-8000-000000000009'),
  'without any captured studio reply on the channel, an earlier booking is not evidence');

-- Confirmation time comes from the audit trail when it has one.
select pg_temp.inbound(pg_temp.conv(10), now() - interval '2 days');
insert into public.activity_log (artist_id, event_type, actor_kind, session_id, client_id, metadata, occurred_at)
select 'a1111111-1111-4111-8111-111111111111', 'appointment.status_changed', 'owner',
  pg_temp.appointment(10, 'in_person_consultation', now() - interval '3 days'), pg_temp.client(10),
  '{"from_status":"proposed","to_status":"confirmed"}'::jsonb, now() - interval '1 day';
select ok(not pg_temp.waiting('d3270000-0000-4000-8000-000000000010'),
  'an appointment proposed earlier and confirmed after the message handles it');

-- ... and so does the project session path's own event.
select pg_temp.inbound(pg_temp.conv(11), now() - interval '2 days');
insert into public.activity_log (artist_id, event_type, actor_kind, session_id, client_id, metadata, occurred_at)
select 'a1111111-1111-4111-8111-111111111111', 'session.status_changed', 'owner',
  pg_temp.appointment(11, 'tattoo_session', now() - interval '3 days'), pg_temp.client(11),
  '{"from_status":"proposed","to_status":"confirmed"}'::jsonb, now() - interval '1 day';
select ok(not pg_temp.waiting('d3270000-0000-4000-8000-000000000011'),
  'a project session confirmed after the message through session.status_changed handles it');

-- The client attention facts read the same evidence.
select is((select reply_state from crm_private.attention_comm_facts('a1111111-1111-4111-8111-111111111111', pg_temp.client(3))),
  'handled', 'attention facts: the booked client''s message is handled');
select is((select reply_state_source from crm_private.attention_comm_facts('a1111111-1111-4111-8111-111111111111', pg_temp.client(3))),
  'booking_evidence', 'attention facts: and say why');
select is((select reply_state from crm_private.attention_comm_facts('a1111111-1111-4111-8111-111111111111', pg_temp.client(1))),
  'unknown', 'attention facts: an unbooked client''s message is not');

select is((select count(*)::int from public.communication_messages where conversation_id::text like 'd3270000-%'), 12,
  'no message was deleted');

select * from finish(true);
rollback;
