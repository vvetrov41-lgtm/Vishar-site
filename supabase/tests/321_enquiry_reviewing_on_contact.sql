-- 321_enquiry_reviewing_on_contact.sql
--
-- An enquiry leaves `new` once the artist has acted on it: a consultation is
-- booked, the client is written to from the CRM, or Gmail shows the artist
-- replied. Only `new` moves, and only to `reviewing`. Today ranks a record
-- contradiction below an unanswered new enquiry.

begin;
select no_plan();

insert into public.clients (id, full_name, email) values
  ('f3211111-1111-4111-8111-111111111111', 'Consult Client', 'consult-321@example.test'),
  ('f3212222-2222-4222-8222-222222222222', 'Two Enquiries', 'two-321@example.test'),
  ('f3213333-3333-4333-8333-333333333333', 'Messaged Client', 'messaged-321@example.test'),
  ('f3214444-4444-4444-8444-444444444444', 'Emailed Client', 'emailed-321@example.test'),
  ('f3215555-5555-4555-8555-555555555555', 'Waiting Client', 'waiting-321@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at, created_at
) values
  ('e3211111-1111-4111-8111-111111111111', 'f3211111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-3211', 'e3219111-1111-4111-8111-111111111111',
   repeat('a', 64), 'new', 'complete', 'Consult Client', 'consult-321@example.test', '2026-08-05', now(), now() - interval '2 days'),
  ('e3212222-2222-4222-8222-222222222222', 'f3212222-2222-4222-8222-222222222222',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-3212', 'e3219222-2222-4222-8222-222222222222',
   repeat('b', 64), 'new', 'complete', 'Two Enquiries', 'two-321@example.test', '2026-08-05', now(), now() - interval '3 days'),
  ('e3212223-2222-4222-8222-222222222222', 'f3212222-2222-4222-8222-222222222222',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-3213', 'e3219223-2222-4222-8222-222222222222',
   repeat('c', 64), 'new', 'complete', 'Two Enquiries', 'two-321@example.test', '2026-08-05', now(), now() - interval '2 days'),
  ('e3213333-3333-4333-8333-333333333333', 'f3213333-3333-4333-8333-333333333333',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-3214', 'e3219333-3333-4333-8333-333333333333',
   repeat('d', 64), 'new', 'complete', 'Messaged Client', 'messaged-321@example.test', '2026-08-05', now(), now() - interval '2 days'),
  ('e3214444-4444-4444-8444-444444444444', 'f3214444-4444-4444-8444-444444444444',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-3215', 'e3219444-4444-4444-8444-444444444444',
   repeat('e', 64), 'new', 'complete', 'Emailed Client', 'emailed-321@example.test', '2026-08-05', now(), now() - interval '2 days'),
  ('e3215555-5555-4555-8555-555555555555', 'f3215555-5555-4555-8555-555555555555',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-3216', 'e3219555-5555-4555-8555-555555555555',
   repeat('f', 64), 'waiting_for_client', 'complete', 'Waiting Client', 'waiting-321@example.test', '2026-08-05', now(), now() - interval '2 days');

-- Consultation booked with no enquiry link (the GPT path): linked and reviewing.
insert into public.sessions (id, artist_id, client_id, appointment_type, status, start_at, end_at, duration_hours)
values ('e3216111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
  'f3211111-1111-4111-8111-111111111111', 'in_person_consultation', 'confirmed',
  date_trunc('hour', now()) + interval '20 days', date_trunc('hour', now()) + interval '20 days 30 minutes', 0.5);

select is((select status::text from public.enquiries where id = 'e3211111-1111-4111-8111-111111111111'),
  'reviewing', 'a booked consultation moves the new enquiry to reviewing');
select is((select enquiry_id from public.sessions where id = 'e3216111-1111-4111-8111-111111111111'),
  'e3211111-1111-4111-8111-111111111111'::uuid, 'the consultation is linked to the only open new enquiry');
select ok(exists (
  select 1 from public.activity_log a
  where a.enquiry_id = 'e3211111-1111-4111-8111-111111111111'
    and a.event_type = 'enquiry.status_changed'
    and a.metadata ->> 'reason' = 'consultation_booked'),
  'the move is recorded in the activity log with its reason');

-- Two new enquiries: both move, the session is not guessed onto either.
insert into public.sessions (id, artist_id, client_id, appointment_type, status, start_at, end_at, duration_hours)
values ('e3216222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111',
  'f3212222-2222-4222-8222-222222222222', 'video_consultation', 'proposed',
  date_trunc('hour', now()) + interval '21 days', date_trunc('hour', now()) + interval '21 days 30 minutes', 0.5);
select is((select count(*)::int from public.enquiries
           where client_id = 'f3212222-2222-4222-8222-222222222222' and status = 'reviewing'),
  2, 'every new enquiry of that client moves');
select is((select enquiry_id from public.sessions where id = 'e3216222-2222-4222-8222-222222222222'),
  null::uuid, 'an ambiguous consultation is not linked to a guessed enquiry');

-- An outbound CRM message after the enquiry arrived.
insert into public.communication_conversations (
  id, artist_id, channel, client_id, link_state, integration_key, external_contact_id
) values ('e3217333-3333-4333-8333-333333333333', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'f3213333-3333-4333-8333-333333333333', 'linked', 'vladimir-production', '447700932133');
insert into public.communication_messages (conversation_id, artist_id, channel, direction, origin, status, body)
values ('e3217333-3333-4333-8333-333333333333', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'inbound', 'contact', 'received', 'Hello');
select is((select status::text from public.enquiries where id = 'e3213333-3333-4333-8333-333333333333'),
  'new', 'an inbound message alone does not move the enquiry');
insert into public.communication_messages (conversation_id, artist_id, channel, direction, origin, status, body)
values ('e3217333-3333-4333-8333-333333333333', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'outbound', 'crm', 'queued', 'Thanks, let us talk');
select is((select status::text from public.enquiries where id = 'e3213333-3333-4333-8333-333333333333'),
  'new', 'a CRM message still queued has not reached the client');
update public.communication_messages set status = 'failed', error_code = 'provider_rejected'
where conversation_id = 'e3217333-3333-4333-8333-333333333333' and direction = 'outbound';
select is((select status::text from public.enquiries where id = 'e3213333-3333-4333-8333-333333333333'),
  'new', 'a failed send does not move the enquiry');
update public.communication_messages set status = 'sent', error_code = null, sent_at = now()
where conversation_id = 'e3217333-3333-4333-8333-333333333333' and direction = 'outbound';
select is((select status::text from public.enquiries where id = 'e3213333-3333-4333-8333-333333333333'),
  'reviewing', 'once the provider accepted the CRM message the enquiry moves to reviewing');

-- Gmail's newest-message record alone (a scheduled mail looks the same) is
-- not a reply; a SENT message is.
insert into crm_private.gmail_client_email_activity (artist_id, client_id, last_message_at, last_direction, history_checked_at)
values ('a1111111-1111-4111-8111-111111111111', 'f3214444-4444-4444-8444-444444444444',
  now() - interval '1 hour', 'outbound', now());
select is((select status::text from public.enquiries where id = 'e3214444-4444-4444-8444-444444444444'),
  'new', 'an outbound newest-message record alone does not move the enquiry');
select crm_private.note_gmail_client_outbound('a1111111-1111-4111-8111-111111111111',
  'f3214444-4444-4444-8444-444444444444', now() - interval '1 hour');
select is((select status::text from public.enquiries where id = 'e3214444-4444-4444-8444-444444444444'),
  'reviewing', 'a SENT Gmail reply after the enquiry moves it to reviewing');

-- Nothing but `new` ever moves.
insert into public.sessions (id, artist_id, client_id, appointment_type, status, start_at, end_at, duration_hours)
values ('e3216555-5555-4555-8555-555555555555', 'a1111111-1111-4111-8111-111111111111',
  'f3215555-5555-4555-8555-555555555555', 'in_person_consultation', 'confirmed',
  date_trunc('hour', now()) + interval '22 days', date_trunc('hour', now()) + interval '22 days 30 minutes', 0.5);
select is((select status::text from public.enquiries where id = 'e3215555-5555-4555-8555-555555555555'),
  'waiting_for_client', 'an enquiry in any other status is left alone');

-- A returning client's later enquiry is not swept up by an older booking.
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at, created_at
) values ('e3211112-1111-4111-8111-111111111111', 'f3211111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-3217', 'e3219112-1111-4111-8111-111111111111',
  repeat('1', 64), 'new', 'complete', 'Consult Client', 'consult-321@example.test', '2026-08-05', now(), now() + interval '1 minute');
update public.sessions set status = 'proposed' where id = 'e3216111-1111-4111-8111-111111111111';
select is((select status::text from public.enquiries where id = 'e3211112-1111-4111-8111-111111111111'),
  'new', 'a later enquiry stays new when an older consultation is edited');

-- A CRM email counts as soon as it is recorded as sent.
insert into public.clients (id, full_name, email) values
  ('f3216666-6666-4666-8666-666666666666', 'Mailed Client', 'mailed-321@example.test'),
  ('f3217777-7777-4777-8777-777777777777', 'Linked Later', 'linked-321@example.test');
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at, created_at
) values
  ('e3216666-6666-4666-8666-666666666666', 'f3216666-6666-4666-8666-666666666666',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-3218', 'e3219666-6666-4666-8666-666666666666',
   repeat('2', 64), 'new', 'complete', 'Mailed Client', 'mailed-321@example.test', '2026-08-05', now(), now() - interval '2 days'),
  ('e3217777-7777-4777-8777-777777777777', 'f3217777-7777-4777-8777-777777777777',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-3219', 'e3219777-7777-4777-8777-777777777777',
   repeat('3', 64), 'new', 'complete', 'Linked Later', 'linked-321@example.test', '2026-08-05', now(), now() - interval '2 days');

select is((select status::text from public.enquiries where id = 'e3216666-6666-4666-8666-666666666666'),
  'new', 'no email yet');
select ok(exists (
  select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
  where c.relname = 'email_messages' and t.tgname = 'email_messages_mark_enquiry_reviewing'),
  'a sent CRM email is watched');
select ok(exists (
  select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
  where c.relname = 'communication_conversations' and t.tgname = 'communication_conversations_mark_enquiry_reviewing'),
  'linking a conversation re-checks earlier replies');

-- A reply sent while the conversation was unmatched counts once it is linked.
insert into public.communication_conversations (
  id, artist_id, channel, client_id, link_state, integration_key, external_contact_id
) values ('e3217778-7777-4777-8777-777777777777', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', null, 'unmatched', 'vladimir-production', '447700932177');
insert into public.communication_messages (conversation_id, artist_id, channel, direction, origin, status, body)
values ('e3217778-7777-4777-8777-777777777777', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'outbound', 'provider_app', 'delivered', 'Replied before linking');
select is((select status::text from public.enquiries where id = 'e3217777-7777-4777-8777-777777777777'),
  'new', 'an unmatched reply cannot move an enquiry yet');
update public.communication_conversations
set client_id = 'f3217777-7777-4777-8777-777777777777', link_state = 'linked'
where id = 'e3217778-7777-4777-8777-777777777777';
select is((select status::text from public.enquiries where id = 'e3217777-7777-4777-8777-777777777777'),
  'reviewing', 'linking the conversation counts the earlier reply');

-- Today: a new enquiry outranks a record contradiction.
select ok(crm_private.pulse_rank('new_enquiry') < crm_private.pulse_rank('conflict'),
  'an unanswered new enquiry ranks above a record contradiction');

select * from finish();
rollback;
