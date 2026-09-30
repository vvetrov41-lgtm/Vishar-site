-- 1004_unanswered_client_reminders.sql
-- A client waiting on a reply is pushed once at 6 h and once finally at 24 h,
-- never overnight in London, never for a message older than 72 h, and never
-- after the artist replied or marked it handled.
begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select has_function('public', 'service_sweep_unanswered_client_reminders',
  array['integer', 'timestamp with time zone'], 'the sweep exists');
select ok(not has_function_privilege('anon',
  'public.service_sweep_unanswered_client_reminders(integer,timestamptz)', 'EXECUTE'),
  'anon cannot run the sweep');
select ok(not has_function_privilege('authenticated',
  'public.service_sweep_unanswered_client_reminders(integer,timestamptz)', 'EXECUTE'),
  'authenticated cannot run the sweep');

insert into auth.users(id, email)
values ('f1004000-0000-4000-8000-000000000001', 'reminder-artist@example.test');
insert into public.profiles(id, email, display_name, role, is_active)
values ('f1004000-0000-4000-8000-000000000001', 'reminder-artist@example.test', 'Reminder Artist', 'owner', true);
insert into public.artist_memberships(
  profile_id, artist_id, access_level, can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values (
  'f1004000-0000-4000-8000-000000000001', 'a1111111-1111-4111-8111-111111111111',
  'artist', false, false, true, true, true
)
on conflict (profile_id, artist_id) do update
set access_level = excluded.access_level, is_active = true;
insert into crm_private.telegram_destinations(
  id, destination_kind, profile_id, chat_id, chat_type, safe_label, is_active, connected_by_profile_id
) values (
  'f1004100-0000-4000-8000-000000000001', 'profile',
  'f1004000-0000-4000-8000-000000000001', '7001004', 'private', 'Telegram', true,
  'f1004000-0000-4000-8000-000000000001'
);
insert into public.notification_preferences(profile_id, channel, is_enabled)
values ('f1004000-0000-4000-8000-000000000001', 'telegram', true);

insert into public.clients(id, workspace_id, full_name, email)
select 'f1004200-0000-4000-8000-000000000001', a.workspace_id, 'Kamal Waiting', 'kamal-waiting@example.test'
from public.artists a where a.id = 'a1111111-1111-4111-8111-111111111111';

-- 12:00 BST on a weekday: outside quiet hours.
create function pg_temp.t0() returns timestamptz language sql immutable as
  $$ select '2026-10-01 12:00:00+01'::timestamptz $$;

insert into public.communication_conversations(
  id, artist_id, channel, integration_key, external_contact_id, client_id, link_state, state,
  last_message_at, last_inbound_at
) values (
  'f1004300-0000-4000-8000-000000000001', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'whatsapp_main', '447700900123', 'f1004200-0000-4000-8000-000000000001',
  'linked', 'open', pg_temp.t0() - interval '5 hours', pg_temp.t0() - interval '5 hours'
);
insert into public.communication_messages(
  conversation_id, artist_id, channel, direction, origin, status, body, created_at
) values (
  'f1004300-0000-4000-8000-000000000001', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'inbound', 'contact', 'received', 'Can you do   November 14?',
  pg_temp.t0() - interval '5 hours'
);

create function pg_temp.reminders() returns integer language sql as $$
  select count(*)::int from public.notifications
  where notification_type = 'client.reply_overdue'
    and entity_id = 'f1004300-0000-4000-8000-000000000001'
$$;

select is(public.service_sweep_unanswered_client_reminders(50, pg_temp.t0()), 0,
  'five hours of waiting is not yet a reminder');

select is(public.service_sweep_unanswered_client_reminders(50, pg_temp.t0() + interval '2 hours'), 1,
  'seven hours of waiting creates the first reminder');
select is(
  (select title || E'\n' || body from public.notifications
   where notification_type = 'client.reply_overdue'
     and entity_id = 'f1004300-0000-4000-8000-000000000001'),
  E'Waiting 7 h for your reply: Kamal Waiting\nWhatsApp\n«Can you do November 14?»',
  'the reminder names the client, the channel and the last message');
select is(
  (select entity_type from public.notifications
   where notification_type = 'client.reply_overdue'
     and entity_id = 'f1004300-0000-4000-8000-000000000001'),
  'conversation', 'the reminder deep-links to the conversation');

select is(public.service_sweep_unanswered_client_reminders(50, pg_temp.t0() + interval '3 hours'), 0,
  'the next sweep does not repeat it');

-- 23:30 London the next day: 24 h are due, but it is quiet time.
select is(public.service_sweep_unanswered_client_reminders(50, '2026-10-01 23:30:00+01'::timestamptz), 0,
  'nothing is sent between 22:00 and 08:00 London time');
select is(public.service_sweep_unanswered_client_reminders(50, '2026-10-02 07:59:00+01'::timestamptz), 0,
  'still quiet at 07:59');
select is(public.service_sweep_unanswered_client_reminders(50, '2026-10-02 08:05:00+01'::timestamptz), 1,
  'the final reminder is created by the first sweep after 08:00');
select ok(
  (select title from public.notifications
   where notification_type = 'client.reply_overdue'
     and entity_id = 'f1004300-0000-4000-8000-000000000001'
     and dedupe_key like '%:24h:%') like 'Waiting over a day for your reply:%',
  'the final reminder says it has been over a day');
select is(public.service_sweep_unanswered_client_reminders(50, '2026-10-02 18:00:00+01'::timestamptz), 0,
  'there is nothing after the final reminder');
select is(pg_temp.reminders(), 2, 'exactly two reminders for one unanswered message');

-- A newer client message restarts the clock.
insert into public.communication_messages(
  conversation_id, artist_id, channel, direction, origin, status, body, created_at
) values (
  'f1004300-0000-4000-8000-000000000001', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'inbound', 'contact', 'received', 'Hello?', '2026-10-02 09:00:00+01'
);
update public.communication_conversations
set last_inbound_at = '2026-10-02 09:00:00+01', last_message_at = '2026-10-02 09:00:00+01'
where id = 'f1004300-0000-4000-8000-000000000001';
select is(public.service_sweep_unanswered_client_reminders(50, '2026-10-02 15:30:00+01'::timestamptz), 1,
  'a new unanswered message gets its own first reminder');

-- Marking it handled in Today silences the final reminder.
insert into public.attention_acknowledgements(artist_id, item_kind, entity_id, observed_at, acknowledged_at)
values ('a1111111-1111-4111-8111-111111111111', 'conversation_reply',
        'f1004300-0000-4000-8000-000000000001', '2026-10-02 09:00:00+01', '2026-10-02 09:00:00+01');
select is(public.service_sweep_unanswered_client_reminders(50, '2026-10-03 10:00:00+01'::timestamptz), 0,
  'an acknowledged conversation is not reminded');
delete from public.attention_acknowledgements
where entity_id = 'f1004300-0000-4000-8000-000000000001';

-- The artist replied: nothing is due.
insert into public.communication_messages(
  conversation_id, artist_id, channel, direction, origin, status, body, created_at
) values (
  'f1004300-0000-4000-8000-000000000001', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'outbound', 'provider_app', 'sent', 'Yes, see you then', '2026-10-02 16:00:00+01'
);
update public.communication_conversations
set last_outbound_at = '2026-10-02 16:00:00+01', last_message_at = '2026-10-02 16:00:00+01'
where id = 'f1004300-0000-4000-8000-000000000001';
select is(public.service_sweep_unanswered_client_reminders(50, '2026-10-03 10:00:00+01'::timestamptz), 0,
  'a conversation the artist answered is not reminded');

-- A message older than 72 hours is history, not a reminder.
insert into public.communication_messages(
  conversation_id, artist_id, channel, direction, origin, status, body, created_at
) values (
  'f1004300-0000-4000-8000-000000000001', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'inbound', 'contact', 'received', 'Thanks!', '2026-10-02 17:00:00+01'
);
update public.communication_conversations
set last_inbound_at = '2026-10-02 17:00:00+01', last_message_at = '2026-10-02 17:00:00+01'
where id = 'f1004300-0000-4000-8000-000000000001';
select is(public.service_sweep_unanswered_client_reminders(50, '2026-10-06 12:00:00+01'::timestamptz), 0,
  'nothing is created for a message older than 72 hours');

-- The first reminder is skipped, not sent late, once the final one is due.
select is(public.service_sweep_unanswered_client_reminders(50, '2026-10-03 18:00:00+01'::timestamptz), 1,
  'a message first seen at 25 h gets one reminder');
select is(
  (select count(*)::int from public.notifications
   where notification_type = 'client.reply_overdue'
     and dedupe_key like 'unanswered:conversation:f1004300-0000-4000-8000-000000000001:'
       || floor(extract(epoch from '2026-10-02 17:00:00+01'::timestamptz))::bigint || ':%'),
  1, 'and it is the final one only');
select is(public.service_sweep_unanswered_client_reminders(50, '2026-10-03 19:00:00+01'::timestamptz), 0,
  'the skipped first reminder is not sent afterwards');

-- Russian-speaking recipients get Russian copy.
update public.profiles set ui_language = 'ru' where id = 'f1004000-0000-4000-8000-000000000001';
insert into public.communication_messages(
  conversation_id, artist_id, channel, direction, origin, status, body, attachments, created_at
) values (
  'f1004300-0000-4000-8000-000000000001', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'inbound', 'contact', 'received', null, '[{"kind":"image"}]'::jsonb,
  '2026-10-04 09:00:00+01'
);
update public.communication_conversations
set last_inbound_at = '2026-10-04 09:00:00+01', last_message_at = '2026-10-04 09:00:00+01'
where id = 'f1004300-0000-4000-8000-000000000001';
select is(public.service_sweep_unanswered_client_reminders(50, '2026-10-04 16:00:00+01'::timestamptz), 1,
  'a Russian-speaking recipient is reminded');
select is(
  (select title || E'\n' || body from public.notifications
   where notification_type = 'client.reply_overdue'
   order by created_at desc, scheduled_at desc limit 1),
  E'Ждёт ответа 7 ч: Kamal Waiting\nWhatsApp\n[вложение]',
  'in Russian, with an attachment marker when the message has no text');

-- A website enquiry nobody engaged with is reminded too.
insert into public.clients(id, workspace_id, full_name, email)
select 'f1004200-0000-4000-8000-000000000002', a.workspace_id, 'Form Client', 'form-client@example.test'
from public.artists a where a.id = 'a1111111-1111-4111-8111-111111111111';
insert into public.enquiries(
  id, client_id, idempotency_key, intake_fingerprint, status, intake_state,
  submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at,
  artist_id, project_type, placement, approximate_size, idea, created_at
) values (
  'f1004400-0000-4000-8000-000000000001', 'f1004200-0000-4000-8000-000000000002',
  'f1004500-0000-4000-8000-000000000001', repeat('c', 64), 'new', 'complete',
  'Form Client', 'form-client@example.test', '2026-07-29', now(),
  'a1111111-1111-4111-8111-111111111111', 'Portrait', 'Upper arm', '15 cm', 'Portrait of my dog',
  '2026-10-04 08:30:00+01'
);
select is(public.service_sweep_unanswered_client_reminders(50, '2026-10-04 16:00:00+01'::timestamptz), 1,
  'an untouched website enquiry is reminded after six hours');
select is(
  (select title || E'\n' || body from public.notifications
   where notification_type = 'client.reply_overdue'
     and entity_id = 'f1004400-0000-4000-8000-000000000001'),
  E'Ждёт ответа 7 ч: Form Client\nНовая заявка без ответа\n«Portrait · Upper arm»',
  'the enquiry reminder links to the enquiry and names what was asked');

-- A final reminder supersedes a first one still queued (e.g. Telegram was down).
select is(public.service_sweep_unanswered_client_reminders(50, '2026-10-05 10:00:00+01'::timestamptz), 2,
  'the final reminders fall due for the waiting conversation and enquiry');
create function pg_temp.reminder(p_entity uuid, p_stage text) returns public.notifications language sql as $$
  select n.* from public.notifications n
  where n.notification_type = 'client.reply_overdue' and n.entity_id = p_entity
    and n.dedupe_key like '%:' || p_stage || ':%'
  order by n.created_at desc, n.scheduled_at desc limit 1
$$;
select ok(
  not crm_private.unanswered_reminder_is_current(
    pg_temp.reminder('f1004300-0000-4000-8000-000000000001', '6h'), '2026-10-05 10:05:00+01'),
  'a queued first reminder is not sent once the final one exists');
select ok(
  crm_private.unanswered_reminder_is_current(
    pg_temp.reminder('f1004300-0000-4000-8000-000000000001', '24h'), '2026-10-05 10:05:00+01'),
  'the final reminder is current while the client is still waiting');
select ok(
  not crm_private.unanswered_reminder_is_current(
    pg_temp.reminder('f1004300-0000-4000-8000-000000000001', '24h'), '2026-10-05 23:00:00+01'),
  'a queued reminder is not sent during quiet hours');
select ok(
  not crm_private.unanswered_reminder_is_current(
    pg_temp.reminder('f1004300-0000-4000-8000-000000000001', '24h'), '2026-10-08 10:00:00+01'),
  'a reminder older than 72 hours is not sent after an outage');

-- Answered after the reminder was queued: the claim drops it.
update public.communication_conversations
set last_outbound_at = '2026-10-05 10:02:00+01'
where id = 'f1004300-0000-4000-8000-000000000001';
select ok(
  not crm_private.unanswered_reminder_is_current(
    pg_temp.reminder('f1004300-0000-4000-8000-000000000001', '24h'), '2026-10-05 10:05:00+01'),
  'a reminder queued before the artist replied is not sent');
update public.communication_conversations
set last_outbound_at = '2026-10-02 16:00:00+01'
where id = 'f1004300-0000-4000-8000-000000000001';

-- Acknowledged in Today after it was queued: the claim drops it.
insert into public.attention_acknowledgements(artist_id, item_kind, entity_id, observed_at, acknowledged_at)
values ('a1111111-1111-4111-8111-111111111111', 'new_enquiry',
        'f1004400-0000-4000-8000-000000000001', '2026-10-04 08:30:00+01', '2026-10-05 10:03:00+01');
select ok(
  not crm_private.unanswered_reminder_is_current(
    pg_temp.reminder('f1004400-0000-4000-8000-000000000001', '24h'), '2026-10-05 10:05:00+01'),
  'a reminder for an enquiry marked handled is not sent');
delete from public.attention_acknowledgements
where entity_id = 'f1004400-0000-4000-8000-000000000001';

-- A late webhook for an older client message cannot reopen an answered chat:
-- event timestamps decide, not insertion order.
insert into public.communication_conversations(
  id, artist_id, channel, integration_key, external_contact_id, client_id, link_state, state,
  last_message_at, last_inbound_at, last_outbound_at
) values (
  'f1004300-0000-4000-8000-000000000002', 'a1111111-1111-4111-8111-111111111111',
  'instagram', 'instagram_main', '1784000001', 'f1004200-0000-4000-8000-000000000002',
  'linked', 'open', '2026-10-05 09:00:00+01', '2026-10-05 08:00:00+01', '2026-10-05 09:00:00+01'
);
insert into public.communication_messages(
  conversation_id, artist_id, channel, direction, origin, status, body, provider_timestamp, created_at
) values
  ('f1004300-0000-4000-8000-000000000002', 'a1111111-1111-4111-8111-111111111111',
   'instagram', 'outbound', 'provider_app', 'sent', 'Sure, Friday works', '2026-10-05 09:00:00+01', '2026-10-05 09:00:00+01'),
  ('f1004300-0000-4000-8000-000000000002', 'a1111111-1111-4111-8111-111111111111',
   'instagram', 'inbound', 'contact', 'received', 'Is Friday ok?', '2026-10-05 08:00:00+01', '2026-10-05 09:30:00+01');
select is(public.service_sweep_unanswered_client_reminders(50, '2026-10-05 16:00:00+01'::timestamptz), 0,
  'an out-of-order inbound webhook does not create a reminder for an answered chat');

-- The Telegram claim applies the same live check. The sweeps above ran at
-- fixed future instants; bring the reminders due at the real clock.
update public.notifications set scheduled_at = now()
where notification_type = 'client.reply_overdue';
set local role service_role;
create temporary table reminder_claim as
select * from public.service_claim_telegram_notifications('reminder-test-worker', 50, 120);
reset role;
select is(
  (select count(*)::int from reminder_claim c
   join public.notifications n on n.id = c.notification_id
   where n.notification_type = 'client.reply_overdue'),
  -- The enquiry's reminder is no longer current: the Instagram chat above
  -- with the same client counts as engagement with that enquiry.
  case when crm_private.unanswered_reminder_quiet(now()) then 0 else 1 end,
  'only the still-current final reminder is claimed, and none during London quiet hours');
select is(
  (select count(*)::int from reminder_claim c
   join public.notifications n on n.id = c.notification_id
   where n.notification_type = 'client.reply_overdue' and n.dedupe_key like '%:6h:%'),
  0,
  'no superseded or stale first reminder is claimed');

select * from finish();
rollback;
