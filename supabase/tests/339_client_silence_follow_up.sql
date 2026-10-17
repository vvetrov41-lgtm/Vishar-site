-- 339_client_silence_follow_up.sql
--
-- Client silence follow-up (20261017090000):
--   * the clock starts only from a person's studio message: not a reaction,
--     an automation, a system email or clearing a Today item;
--   * a studio reaction acknowledges the client's message unless it asks
--     something (question mark, or classifier reply_required); the classifier
--     alone never hides a reply;
--   * one acknowledgement per cycle covers the 7-day and the 21-day item;
--     "not now" returns it, a new message from either side starts a new cycle;
--   * a manual follow-up hides the item while open and closes the cycle when
--     completed or cancelled during it;
--   * a proposed appointment, a confirmed one or a reply in another channel
--     means no silence item;
--   * Statistics counts exactly the Today block, per artist scope;
--   * Vladimir's and Kristina's data and decisions stay apart.
-- Everything is rolled back.

begin;
select no_plan();

-- ------------------------------------------------------------------ fixtures

insert into auth.users (id, email) values
  ('c3390000-0000-4000-8000-000000000001', 'silence-owner-339@example.test'),
  ('c3390000-0000-4000-8000-000000000002', 'silence-kristina-339@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('c3390000-0000-4000-8000-000000000001', 'silence-owner-339@example.test', 'Silence Owner', 'owner', true),
  ('c3390000-0000-4000-8000-000000000002', 'silence-kristina-339@example.test', 'Kristina Manager', 'booking_manager', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level, can_manage_sessions, can_manage_integrations, is_active
) values ('c3390000-0000-4000-8000-000000000002', 'a2222222-2222-4222-8222-222222222222',
  'manager', false, false, true);

create temporary table t0 as select now() as at;

-- Client n of an artist: an open enquiry and a linked WhatsApp conversation.
create function pg_temp.client(p_n integer) returns uuid language sql immutable as $$
  select ('d3390000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
$$;
create function pg_temp.conv(p_n integer, p_channel text default 'whatsapp') returns uuid language sql immutable as $$
  select ('d3391000-0000-4000-8000-' || lpad((p_n * 10 + case p_channel when 'whatsapp' then 0 else 1 end)::text, 12, '0'))::uuid;
$$;
create function pg_temp.enquiry(p_n integer, p_k integer default 0) returns uuid language sql immutable as $$
  select ('d3392000-0000-4000-8000-' || lpad((p_n * 10 + p_k)::text, 12, '0'))::uuid;
$$;
create function pg_temp.vlad() returns uuid language sql immutable as $$ select 'a1111111-1111-4111-8111-111111111111'::uuid $$;
create function pg_temp.kris() returns uuid language sql immutable as $$ select 'a2222222-2222-4222-8222-222222222222'::uuid $$;

create function pg_temp.add_enquiry(p_n integer, p_k integer, p_artist uuid) returns void language sql as $$
  insert into public.enquiries (
    id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint,
    status, intake_state, submitted_full_name, submitted_email,
    privacy_notice_version, privacy_acknowledged_at, created_at
  ) values (
    pg_temp.enquiry(p_n, p_k), pg_temp.client(p_n), p_artist,
    'ENQ-2099-339' || lpad((p_n * 10 + p_k)::text, 3, '0'),
    ('d3393000-0000-4000-8000-' || lpad((p_n * 10 + p_k)::text, 12, '0'))::uuid,
    md5('339-' || p_n || '-' || p_k) || md5('silence-' || p_n || '-' || p_k),
    'reviewing', 'complete', 'Silence ' || p_n, 'silence-' || p_n || '@example.test',
    '2026-08-05', now(), (select at from t0) - interval '40 days');
$$;

create function pg_temp.add_client(p_n integer, p_artist uuid default 'a1111111-1111-4111-8111-111111111111') returns void language plpgsql as $$
begin
  insert into public.clients (id, workspace_id, full_name, email) values (
    pg_temp.client(p_n), (select workspace_id from public.artists where id = p_artist),
    'Silence ' || p_n, 'silence-' || p_n || '@example.test');
  perform pg_temp.add_enquiry(p_n, 0, p_artist);
  insert into public.communication_conversations (
    id, artist_id, channel, client_id, link_state, integration_key, external_contact_id, state
  ) values (pg_temp.conv(p_n), p_artist, 'whatsapp', pg_temp.client(p_n), 'linked', 'silence-339',
            '4477003390' || lpad(p_n::text, 2, '0'), 'open');
end;
$$;

-- A message at (t0 + p_offset). Studio messages default to a person's text
-- from the phone; inbound to the client's text.
create function pg_temp.msg(
  p_n integer, p_direction text, p_offset interval, p_body text default 'message 339',
  p_type text default 'text', p_origin text default null, p_channel text default 'whatsapp'
) returns uuid language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
  v_at timestamptz := (select at from t0) + p_offset;
  v_artist uuid;
begin
  select artist_id into v_artist from public.communication_conversations where id = pg_temp.conv(p_n, p_channel);
  insert into public.communication_messages (
    id, conversation_id, artist_id, channel, direction, origin, status, message_type, body,
    provider_timestamp, sent_at, created_at
  ) values (
    v_id, pg_temp.conv(p_n, p_channel), v_artist, p_channel::public.communication_channel,
    p_direction::public.communication_direction,
    coalesce(p_origin, case p_direction when 'inbound' then 'contact' else 'provider_app' end)::public.communication_origin,
    (case p_direction when 'inbound' then 'received' else 'read' end)::public.communication_status,
    p_type, case when p_type = 'text' then p_body end,
    v_at, case when p_direction = 'outbound' then v_at end, v_at);
  return v_id;
end;
$$;

-- Today as the database computes it for one artist at a moment.
create function pg_temp.items(p_artist uuid, p_at interval default interval '0') returns jsonb language sql as $$
  select crm_private.pulse_items(p_artist, false, false, (select at from t0) + p_at);
$$;
create function pg_temp.silent(p_n integer, p_at interval default interval '0',
                               p_artist uuid default 'a1111111-1111-4111-8111-111111111111')
returns jsonb language sql as $$
  select i from jsonb_array_elements(pg_temp.items(p_artist, p_at)) i where i ->> 'key' = 'silent-' || pg_temp.client(p_n);
$$;
create function pg_temp.reply(p_n integer, p_at interval default interval '0') returns jsonb language sql as $$
  select i from jsonb_array_elements(pg_temp.items('a1111111-1111-4111-8111-111111111111', p_at)) i
  where i ->> 'key' = 'reply-' || pg_temp.conv(p_n);
$$;
create function pg_temp.as_profile(p_profile uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_profile, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.cycle(p_n integer, p_artist uuid default 'a1111111-1111-4111-8111-111111111111') returns timestamptz language sql as $$
  select crm_private.client_silence_cycle_at(p_artist, pg_temp.client(p_n));
$$;

-- The operator steps below build their RPC arguments with these helpers.
do $$
begin
  execute format('grant usage on schema %I to authenticated', pg_my_temp_schema()::regnamespace);
  execute format('grant execute on all functions in schema %I to authenticated', pg_my_temp_schema()::regnamespace);
  execute format('grant select on all tables in schema %I to authenticated', pg_my_temp_schema()::regnamespace);
end
$$;

-- ------------------------------------------- 1. the studio's turn starts it

select pg_temp.add_client(1);
select pg_temp.msg(1, 'inbound', interval '-9 days', 'How much would a forearm piece be?');
create temporary table m1 as select pg_temp.msg(1, 'outbound', interval '-8 days', 'Around four sessions, I can send dates') as id;

select is(pg_temp.silent(1) ->> 'kind', 'client_follow_up_due', 'eight days after the artist''s message the client is due a follow-up');
select is(pg_temp.silent(1) ->> 'section', 'waiting_on_clients', 'it sits in the waiting-on-clients block');
select is((pg_temp.silent(1) -> 'acknowledgement' ->> 'kind'), 'client_silence', 'it can be acknowledged as a client silence');
select is((pg_temp.silent(1) -> 'acknowledgement' ->> 'observed_at')::timestamptz, (select at from t0) - interval '8 days',
  'the cycle is the time of the artist''s message');
select is(pg_temp.silent(1) ->> 'href', '/inbox/' || pg_temp.conv(1), 'the row opens the conversation');
select is(pg_temp.silent(1) -> 'context' ->> 'preview', 'Around four sessions, I can send dates',
  'the row shows how the artist''s message began');
select is(pg_temp.silent(1, interval '-2 days'), null, 'six days after the message nothing is due yet');

-- An automation after the person's message does not move the cycle; an
-- automation alone never starts one.
select pg_temp.add_client(2);
select pg_temp.msg(2, 'inbound', interval '-10 days', 'Can you do 12 November?');
select pg_temp.msg(2, 'outbound', interval '-9 days', 'Yes, 12 November works');
select pg_temp.msg(2, 'outbound', interval '-8 days', null, 'template', 'automation');
select is((pg_temp.silent(2) -> 'acknowledgement' ->> 'observed_at')::timestamptz, (select at from t0) - interval '9 days',
  'a booking card after the artist''s message does not move the cycle');

select pg_temp.add_client(3);
select pg_temp.msg(3, 'inbound', interval '-10 days', 'Hello');
select pg_temp.msg(3, 'outbound', interval '-8 days', null, 'template', 'automation');
select is(pg_temp.silent(3), null, 'an automation alone never starts waiting on the client');
select is(pg_temp.silent(3, interval '30 days'), null, 'not even weeks later');

-- System email is not the studio answering; a person's email is.
select pg_temp.add_client(4);
select pg_temp.msg(4, 'inbound', interval '-12 days', 'Any availability?');
-- Fixture only (rolled back): a real system email also links the automation
-- job, payment request or booking card that authorised it.
alter table public.email_messages drop constraint email_messages_approval_required;
insert into public.email_messages (artist_id, client_id, to_email, subject, body, status, created_by_kind, approved_at, sent_at)
values (pg_temp.vlad(), pg_temp.client(4), 'silence-4@example.test', 'Reminder', 'Synthetic reminder', 'sent', 'system',
        (select at from t0) - interval '8 days', (select at from t0) - interval '8 days');
select is(pg_temp.silent(4), null, 'a system email does not start the clock');
insert into public.email_messages (id, artist_id, client_id, to_email, subject, body, status, created_by_kind)
values ('d3395000-0000-4000-8000-000000000004', pg_temp.vlad(), pg_temp.client(4), 'silence-4@example.test',
        'Your dates', 'Synthetic dates', 'draft', 'ai');
update public.email_messages
set status = 'sent', approved_by = 'c3390000-0000-4000-8000-000000000001',
    approved_at = (select at from t0) - interval '9 days', sent_at = (select at from t0) - interval '9 days'
where id = 'd3395000-0000-4000-8000-000000000004';
select is((pg_temp.silent(4) -> 'acknowledgement' ->> 'observed_at')::timestamptz, (select at from t0) - interval '9 days',
  'an approved email the studio sent does start it');
select is(pg_temp.silent(4) ->> 'href', '/inbox/email/client-' || pg_temp.client(4), 'an email cycle opens the email thread');

-- ------------------------------------------------------------- 2. reactions

-- A: "Thank you!" then the artist's reaction: nothing owed, nobody waiting.
select pg_temp.add_client(5);
select pg_temp.msg(5, 'outbound', interval '-12 days', 'See you on the 14th');
select pg_temp.msg(5, 'inbound', interval '-9 days', 'Thank you so much!');
select pg_temp.msg(5, 'outbound', interval '-8 days', null, 'reaction');
select is(pg_temp.reply(5), null, 'a reaction to a thank-you leaves nothing to answer');
select is(pg_temp.silent(5), null, 'and does not start waiting on the client');
select is(pg_temp.silent(5, interval '30 days'), null, 'neither on day 7 nor on day 21');
select is((select reply_state || '/' || reply_state_source
           from crm_private.attention_comm_facts(pg_temp.vlad(), pg_temp.client(5))),
  'handled/studio_reaction', 'the client facts say the reaction handled it');

-- B: a question then a reaction: still owed.
select pg_temp.add_client(6);
select pg_temp.msg(6, 'inbound', interval '-9 days', 'Can I book Saturday?');
select pg_temp.msg(6, 'outbound', interval '-8 days', null, 'reaction');
select isnt(pg_temp.reply(6), null, 'a reaction does not answer a question');
select is(pg_temp.silent(6), null, 'and the client is not the one waited on');

-- The classifier can keep a reply open after a reaction...
select pg_temp.add_client(7);
create temporary table m7 as select pg_temp.msg(7, 'inbound', interval '-9 days', 'Saturday would be ideal') as id;
insert into crm_private.client_reply_marks (artist_id, client_id, message_at, reply_state, source)
values (pg_temp.vlad(), pg_temp.client(7), (select at from t0) - interval '9 days', 'reply_required', 'classifier');
select pg_temp.msg(7, 'outbound', interval '-8 days', null, 'reaction');
select isnt(pg_temp.reply(7), null, 'a reply_required mark keeps the message open after a reaction');

-- ...but never hides one on its own.
select pg_temp.add_client(8);
select pg_temp.msg(8, 'inbound', interval '-2 days', 'thanks');
insert into crm_private.client_reply_marks (artist_id, client_id, message_at, reply_state, source)
values (pg_temp.vlad(), pg_temp.client(8), (select at from t0) - interval '2 days', 'no_reply_needed', 'classifier');
select isnt(pg_temp.reply(8), null, 'a no_reply_needed mark alone does not hide the reply row');

-- D: the artist offered dates, the client reacted: still waiting on a choice.
select pg_temp.add_client(9);
select pg_temp.msg(9, 'outbound', interval '-8 days', 'I can offer Saturday or Sunday. Which works better?');
select pg_temp.msg(9, 'inbound', interval '-7 days', null, 'reaction');
select is(pg_temp.silent(9) ->> 'kind', 'client_follow_up_due', 'a client reaction is not a choice: the follow-up stays');
select is((pg_temp.silent(9) -> 'acknowledgement' ->> 'observed_at')::timestamptz, (select at from t0) - interval '8 days',
  'the cycle is the artist''s message, not the reaction');
select is((pg_temp.silent(9) -> 'context' ->> 'client_reacted')::boolean, true, 'the row says the client reacted');

-- A reaction then a real message: the cycle is the message.
select pg_temp.add_client(10);
select pg_temp.msg(10, 'inbound', interval '-11 days', 'Is the design ready?');
select pg_temp.msg(10, 'outbound', interval '-10 days', null, 'reaction');
select pg_temp.msg(10, 'outbound', interval '-8 days', 'Here it is, let me know what you think');
select is((pg_temp.silent(10) -> 'acknowledgement' ->> 'observed_at')::timestamptz, (select at from t0) - interval '8 days',
  'after a reaction, the artist''s message starts the cycle');

-- A reply_required mark on a later message in another channel does not
-- reopen an older message the artist already acknowledged with a reaction.
select pg_temp.add_client(21);
insert into public.communication_conversations (
  id, artist_id, channel, client_id, link_state, integration_key, external_contact_id, state
) values (pg_temp.conv(21, 'instagram'), pg_temp.vlad(), 'instagram', pg_temp.client(21), 'linked', 'silence-339-ig', '33918000021', 'open');
select pg_temp.msg(21, 'inbound', interval '-9 days', 'Thank you!');
select pg_temp.msg(21, 'outbound', interval '-8 days', null, 'reaction');
select pg_temp.msg(21, 'inbound', interval '-3 days', 'Could you also look at my arm', 'text', null, 'instagram');
insert into crm_private.client_reply_marks (artist_id, client_id, message_at, reply_state, source)
values (pg_temp.vlad(), pg_temp.client(21), (select at from t0) - interval '3 days', 'reply_required', 'classifier');
select is(pg_temp.reply(21), null, 'a mark on a later Instagram message leaves the acknowledged WhatsApp one closed');
select isnt((select i from jsonb_array_elements(pg_temp.items(pg_temp.vlad())) i
             where i ->> 'key' = 'reply-' || pg_temp.conv(21, 'instagram')), null,
  'the Instagram message itself waits for an answer');

-- A cycle started by mail sent from Gmail shows that mail.
select pg_temp.add_client(22);
select pg_temp.msg(22, 'inbound', interval '-10 days', 'Can we talk about the design');
insert into crm_private.gmail_client_ai_excerpts (
  artist_id, workspace_id, client_id, provider_thread_id, provider_message_id, direction, subject, body_excerpt, occurred_at
) values (pg_temp.vlad(), (select workspace_id from public.artists where id = pg_temp.vlad()), pg_temp.client(22),
  'thread-339-22', 'message-339-22', 'outbound', 'Design draft attached', 'Synthetic body', (select at from t0) - interval '8 days');
select is((pg_temp.silent(22) -> 'acknowledgement' ->> 'observed_at')::timestamptz, (select at from t0) - interval '8 days',
  'the Gmail message starts the cycle');
select is(pg_temp.silent(22) -> 'context' ->> 'channel', 'email', 'the row says it was an email');
select is(pg_temp.silent(22) -> 'context' ->> 'preview', 'Design draft attached', 'with its subject');
select is(pg_temp.silent(22) ->> 'href', '/inbox/email/client-' || pg_temp.client(22), 'and opens the email thread');

-- Clearing a Today reply item answers the client but starts no clock.
select pg_temp.add_client(11);
select pg_temp.msg(11, 'inbound', interval '-9 days', 'I will think about it');
insert into public.attention_acknowledgements (artist_id, item_kind, entity_id, observed_at, acknowledged_at)
values (pg_temp.vlad(), 'conversation_reply', pg_temp.conv(11), (select at from t0) - interval '9 days', (select at from t0) - interval '8 days');
select is(pg_temp.reply(11), null, 'the cleared reply row stays cleared');
select is(pg_temp.silent(11), null, 'clearing it does not start waiting on the client');
select is(pg_temp.silent(11, interval '30 days'), null, 'not on day 21 either');

-- ------------------------------------------------- 3. decisions per cycle

select pg_temp.as_profile('c3390000-0000-4000-8000-000000000001');
set local role authenticated;

-- "Don't remind" on day 8 also covers day 22.
select lives_ok(format($$select public.acknowledge_attention_item(%L, 'client_silence', %L, %L)$$,
  pg_temp.vlad(), pg_temp.client(1), (select at from t0) - interval '8 days'), 'the operator chooses "don''t remind"');
select lives_ok(format($$select public.acknowledge_attention_item(%L, 'client_silence', %L, %L)$$,
  pg_temp.vlad(), pg_temp.client(1), (select at from t0) - interval '8 days'), 'repeating it is harmless');
reset role;
select is(pg_temp.silent(1), null, 'the row leaves Today');
select is(pg_temp.silent(1, interval '14 days'), null, 'the 21-day item of the same cycle stays hidden');
select is((select count(*)::integer from public.attention_acknowledgements
           where artist_id = pg_temp.vlad() and item_kind = 'client_silence' and entity_id = pg_temp.client(1)),
  1, 'one acknowledgement row per client and artist');

-- Undo returns it.
set local role authenticated;
select lives_ok(format($$select public.clear_attention_acknowledgement(%L, 'client_silence', %L)$$,
  pg_temp.vlad(), pg_temp.client(1)), 'undo');
reset role;
select isnt(pg_temp.silent(1), null, 'the row is back after undo');

-- "Not now" returns it at the chosen time, as the same cycle.
select pg_temp.add_client(12);
select pg_temp.msg(12, 'outbound', interval '-8 days', 'Here are two dates');
set local role authenticated;
select lives_ok(format($$select public.snooze_attention_item(%L, 'client_silence', %L, %L, %L)$$,
  pg_temp.vlad(), pg_temp.client(12), (select at from t0) - interval '8 days', now() + interval '3 days'),
  'the operator chooses "in three days"');
reset role;
select is(pg_temp.silent(12, interval '1 day'), null, 'hidden while snoozed');
select is(pg_temp.silent(12, interval '4 days') ->> 'kind', 'client_follow_up_due', 'back when the time comes');
select is((select resurface_at from public.attention_acknowledgements
           where artist_id = pg_temp.vlad() and item_kind = 'client_silence' and entity_id = pg_temp.client(12)) is not null,
  true, 'the snooze is stored on the acknowledgement');
set local role authenticated;
select lives_ok(format($$select public.acknowledge_attention_item(%L, 'client_silence', %L, %L)$$,
  pg_temp.vlad(), pg_temp.client(12), (select at from t0) - interval '8 days'), 'then "don''t remind"');
reset role;
select is((select resurface_at from public.attention_acknowledgements
           where artist_id = pg_temp.vlad() and item_kind = 'client_silence' and entity_id = pg_temp.client(12)),
  null, '"don''t remind" replaces the snooze');
select is(pg_temp.silent(12, interval '4 days'), null, 'and it stays hidden');
-- A late decision about an older version does not override the newer one.
set local role authenticated;
select lives_ok(format($$select public.snooze_attention_item(%L, 'client_silence', %L, %L, %L)$$,
  pg_temp.vlad(), pg_temp.client(12), (select at from t0) - interval '20 days', now() + interval '2 days'),
  'a stale screen snoozes an older version');
reset role;
select is((select resurface_at from public.attention_acknowledgements
           where artist_id = pg_temp.vlad() and item_kind = 'client_silence' and entity_id = pg_temp.client(12)),
  null, 'the newer "don''t remind" stands');
select is((select observed_at from public.attention_acknowledgements
           where artist_id = pg_temp.vlad() and item_kind = 'client_silence' and entity_id = pg_temp.client(12)),
  (select at from t0) - interval '8 days', 'the acknowledged version never goes back');

-- Snoozed for a month, the client answers the next day: no stale reminder.
select pg_temp.add_client(13);
select pg_temp.msg(13, 'outbound', interval '-8 days', 'Do you want to go ahead?');
set local role authenticated;
select lives_ok(format($$select public.snooze_attention_item(%L, 'client_silence', %L, %L, %L)$$,
  pg_temp.vlad(), pg_temp.client(13), (select at from t0) - interval '8 days', now() + interval '30 days'), 'snoozed for a month');
reset role;
select pg_temp.msg(13, 'inbound', interval '1 day', 'Yes please, Saturday');
select is(pg_temp.silent(13, interval '31 days'), null, 'after the client wrote, the old snooze never brings it back');
select isnt(pg_temp.reply(13, interval '2 days'), null, 'the client''s message waits for an answer instead');
-- The artist answers; a new cycle starts and the old snooze does not cover it.
select pg_temp.msg(13, 'outbound', interval '2 days', 'Saturday it is, I will send the deposit link');
select is((pg_temp.silent(13, interval '10 days') -> 'acknowledgement' ->> 'observed_at')::timestamptz,
  (select at from t0) + interval '2 days', 'a new cycle starts from the artist''s new message');

-- Validation.
set local role authenticated;
select throws_ok(format($$select public.snooze_attention_item(%L, 'client_silence', %L, %L, %L)$$,
  pg_temp.vlad(), pg_temp.client(9), (select at from t0) - interval '8 days', now() - interval '1 minute'),
  '22023', null, 'a snooze must end in the future');
select throws_ok(format($$select public.snooze_attention_item(%L, 'client_silence', %L, %L, %L)$$,
  pg_temp.vlad(), pg_temp.client(9), (select at from t0) - interval '8 days', now() + interval '400 days'),
  '22023', null, 'a snooze lasts at most a year');
select throws_ok(format($$select public.snooze_attention_item(%L, 'conversation_reply', %L, %L, %L)$$,
  pg_temp.vlad(), pg_temp.conv(6), (select at from t0) - interval '9 days', now() + interval '3 days'),
  '22023', null, 'only a client silence item can be snoozed');
select throws_ok(format($$select public.acknowledge_attention_item(%L, 'client_silence', %L, %L)$$,
  pg_temp.vlad(), pg_temp.client(9), (select at from t0) - interval '1 day'),
  '22023', null, 'a decision cannot claim a newer cycle than exists');
select throws_ok(format($$select public.acknowledge_attention_item(%L, 'client_silence', %L, %L)$$,
  pg_temp.vlad(), pg_temp.client(6), (select at from t0) - interval '8 days'),
  'P0002', null, 'a client the studio is not waiting on has no cycle to acknowledge');
reset role;

-- ------------------------------------------------ 4. manual follow-ups

-- An open follow-up created on the enquiry (no client id on the row).
select pg_temp.add_client(14);
select pg_temp.msg(14, 'outbound', interval '-8 days', 'Let me know about the size');
insert into public.follow_ups (id, artist_id, enquiry_id, subject, due_at)
values ('d3394000-0000-4000-8000-000000000014', pg_temp.vlad(), pg_temp.enquiry(14), 'Chase', (select at from t0) + interval '5 days');
select is(pg_temp.silent(14), null, 'an open manual follow-up hides the automatic item');
update public.follow_ups set status = 'done', completed_at = (select at from t0)
where id = 'd3394000-0000-4000-8000-000000000014';
select is(pg_temp.silent(14), null, 'completing it during the cycle does not bring the old item back');
select is(pg_temp.silent(14, interval '20 days'), null, 'not later in the same cycle either');
select pg_temp.msg(14, 'outbound', interval '1 day', 'Just checking in');
select isnt(pg_temp.silent(14, interval '9 days'), null, 'a new message starts a cycle the old follow-up does not cover');

-- A follow-up closed before the cycle began covers nothing.
select pg_temp.add_client(15);
insert into public.follow_ups (artist_id, client_id, subject, due_at, status, cancelled_at)
values (pg_temp.vlad(), pg_temp.client(15), 'Old', (select at from t0) - interval '25 days', 'cancelled', (select at from t0) - interval '20 days');
select pg_temp.msg(15, 'outbound', interval '-8 days', 'Any thoughts on the sketch');
select isnt(pg_temp.silent(15), null, 'a follow-up closed before the cycle does not hide it');
-- Cancelled during the cycle behaves like completed.
insert into public.follow_ups (artist_id, client_id, subject, due_at, status, cancelled_at)
values (pg_temp.vlad(), pg_temp.client(15), 'Recent', (select at from t0), 'cancelled', (select at from t0) - interval '1 day');
select is(pg_temp.silent(15), null, 'a follow-up cancelled during the cycle closes it');

-- ---------------------------------------- 5. appointments and other channels

-- A proposed consultation has its own row.
select pg_temp.add_client(16);
select pg_temp.msg(16, 'outbound', interval '-8 days', 'I sent you a consultation time');
insert into public.sessions (artist_id, client_id, enquiry_id, appointment_type, status, start_at, end_at)
values (pg_temp.vlad(), pg_temp.client(16), pg_temp.enquiry(16), 'video_consultation', 'proposed',
        date_trunc('hour', now()) + interval '10 days', date_trunc('hour', now()) + interval '10 days 30 minutes');
select is(pg_temp.silent(16), null, 'a proposed appointment means no silence item');
-- A confirmed one is the agreed next step.
select pg_temp.add_client(17);
select pg_temp.msg(17, 'outbound', interval '-8 days', 'Booked you in');
insert into public.sessions (artist_id, client_id, enquiry_id, appointment_type, status, start_at, end_at)
values (pg_temp.vlad(), pg_temp.client(17), pg_temp.enquiry(17), 'video_consultation', 'confirmed',
        date_trunc('hour', now()) + interval '10 days', date_trunc('hour', now()) + interval '10 days 30 minutes');
select is(pg_temp.silent(17), null, 'a confirmed appointment means no silence item');

-- The client answered in Instagram after the artist wrote in WhatsApp.
select pg_temp.add_client(18);
insert into public.communication_conversations (
  id, artist_id, channel, client_id, link_state, integration_key, external_contact_id, state
) values (pg_temp.conv(18, 'instagram'), pg_temp.vlad(), 'instagram', pg_temp.client(18), 'linked', 'silence-339-ig', '33918000018', 'open');
select pg_temp.msg(18, 'outbound', interval '-8 days', 'Sent you the design');
select pg_temp.msg(18, 'inbound', interval '-7 days', 'Love it', 'text', null, 'instagram');
select is(pg_temp.silent(18), null, 'a reply in another channel ends the silence');

-- Two enquiries, one client: one row.
select pg_temp.add_client(19);
select pg_temp.add_enquiry(19, 1, pg_temp.vlad());
select pg_temp.msg(19, 'outbound', interval '-8 days', 'About both pieces');
select is((select count(*)::integer from jsonb_array_elements(pg_temp.items(pg_temp.vlad())) i
           where i ->> 'client_id' = pg_temp.client(19)::text and i ->> 'section' = 'waiting_on_clients'),
  1, 'a client with two enquiries is one row');

-- Two studio messages a minute apart: one cycle, from the later one.
select pg_temp.add_client(20);
select pg_temp.msg(20, 'outbound', interval '-8 days', 'First part');
select pg_temp.msg(20, 'outbound', interval '-8 days' + interval '1 minute', 'Second part');
select is((pg_temp.silent(20) -> 'acknowledgement' ->> 'observed_at')::timestamptz,
  (select at from t0) - interval '8 days' + interval '1 minute', 'consecutive messages are one cycle from the last');

-- ------------------------------------------ 6. Vladimir and Kristina apart

select pg_temp.add_client(30, pg_temp.kris());
select pg_temp.msg(30, 'outbound', interval '-8 days', 'Kristina''s message');

select is(pg_temp.silent(30, interval '0', pg_temp.kris()) ->> 'kind', 'client_follow_up_due', 'Kristina has her own item');
select is((select count(*)::integer from jsonb_array_elements(pg_temp.items(pg_temp.vlad())) i
           where i ->> 'client_id' = pg_temp.client(30)::text), 0, 'Vladimir''s Today never shows it');

select pg_temp.as_profile('c3390000-0000-4000-8000-000000000002');
set local role authenticated;
select is((public.get_waiting_on_clients_count() -> 'artists' -> 0 ->> 'artist_id')::uuid, pg_temp.kris(),
  'Kristina''s manager counts only Kristina');
select is(jsonb_array_length(public.get_waiting_on_clients_count() -> 'artists'), 1, 'and no other artist');
select throws_ok(format($$select public.get_waiting_on_clients_count(%L)$$, pg_temp.vlad()),
  '42501', null, 'asking for Vladimir is refused');
select throws_ok(format($$select public.acknowledge_attention_item(%L, 'client_silence', %L, %L)$$,
  pg_temp.vlad(), pg_temp.client(9), (select at from t0) - interval '8 days'),
  '42501', null, 'Kristina''s manager cannot decide about Vladimir''s client');
select throws_ok(format($$select public.snooze_attention_item(%L, 'client_silence', %L, %L, %L)$$,
  pg_temp.vlad(), pg_temp.client(9), (select at from t0) - interval '8 days', now() + interval '3 days'),
  '42501', null, 'nor snooze it');
select throws_ok(format($$select public.acknowledge_attention_item(%L, 'client_silence', %L, %L)$$,
  pg_temp.kris(), pg_temp.client(9), (select at from t0) - interval '8 days'),
  'P0002', null, 'Vladimir''s client is not in Kristina''s scope');
select lives_ok(format($$select public.acknowledge_attention_item(%L, 'client_silence', %L, %L)$$,
  pg_temp.kris(), pg_temp.client(30), (select at from t0) - interval '8 days'), 'she decides about her own client');
reset role;
select is(pg_temp.silent(30, interval '0', pg_temp.kris()), null, 'Kristina''s item is hidden');
select isnt(pg_temp.silent(9), null, 'Vladimir''s items are untouched');

-- ------------------------------------- 7. Statistics counts the Today block

select pg_temp.as_profile('c3390000-0000-4000-8000-000000000001');
set local role authenticated;
select is((public.get_waiting_on_clients_count(pg_temp.vlad()) ->> 'count')::integer,
  (select count(*)::integer from jsonb_array_elements(public.get_today_pulse(pg_temp.vlad()) -> 'items') i
   where i ->> 'section' = 'waiting_on_clients'),
  'the Statistics counter equals the Today block for the same artist');
select is((public.get_waiting_on_clients_count() ->> 'count')::integer,
  (select count(*)::integer from jsonb_array_elements(public.get_today_pulse() -> 'items') i
   where i ->> 'section' = 'waiting_on_clients'),
  'and across every artist the operator sees');
create temporary table before_snooze as
  select (public.get_waiting_on_clients_count(pg_temp.vlad()) ->> 'count')::integer as n;
select lives_ok(format($$select public.snooze_attention_item(%L, 'client_silence', %L, %L, %L)$$,
  pg_temp.vlad(), pg_temp.client(9), (select at from t0) - interval '8 days', now() + interval '7 days'), 'snooze one');
select is((public.get_waiting_on_clients_count(pg_temp.vlad()) ->> 'count')::integer, (select n from before_snooze) - 1,
  'the counter drops with the Today block');
reset role;

update crm_private.crm_agent_config set today_pulse = false where singleton;
set local role authenticated;
select is(public.get_waiting_on_clients_count() ->> 'status', 'unavailable',
  'without the server pulse there is no number, never a zero');
reset role;
update crm_private.crm_agent_config set today_pulse = true where singleton;

select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$select public.get_waiting_on_clients_count()$$, '42501', null,
  'the counter needs a signed-in operator');

-- ------------------------------------------------ 8. parity and privacy

select is(
  (select count(*)::integer
   from crm_private.pulse_attention_batch(pg_temp.vlad(), (select at from t0)) b
   where b.a ->> 'sla_reason' is distinct from
         crm_private.pulse_client_attention(pg_temp.vlad(), b.client_id, (select at from t0)) ->> 'sla_reason'),
  0, 'the Today batch and the per-client path agree for every client');
select is(
  (select count(*)::integer
   from crm_private.pulse_attention_batch(pg_temp.vlad(), (select at from t0)) b
   where b.a ->> 'last_outbound_at' is distinct from
         crm_private.client_attention(pg_temp.vlad(), b.client_id, (select at from t0)) ->> 'last_outbound_at'),
  0, 'and on the cycle time');
select ok(position('context' in (select prosrc from pg_proc
            where oid = 'public.service_telegram_today_pulse(text,integer)'::regprocedure)) = 0,
  'Telegram /today never forwards the message preview');

select * from finish();
rollback;
