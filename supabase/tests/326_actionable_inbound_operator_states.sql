-- 326_actionable_inbound_operator_states.sql
--
-- What an inbound message asks of the studio, and the two operator states
-- for conversations the CRM cannot answer for (20261004180000):
--   * reaction / unsupported / edit / revoke never create a Today item; any
--     other type does, unknown ones included (fail open);
--   * the studio's turn is a provider-accepted reply, not a queued or failed
--     send and not an automation;
--   * not_crm hides a personal unlinked conversation until cleared, and never
--     hides a linked client's messages;
--   * handled outside the CRM (the Today acknowledgement) covers only the
--     actionable inbound it saw, and can be undone;
--   * archive does not hide a new actionable inbound;
--   * exact WhatsApp linking also runs from the client side, fail closed;
--   * no message is deleted by any of it.
-- Everything is rolled back.

begin;
select no_plan();

insert into auth.users (id, email) values
  ('c3260000-0000-4000-8000-000000000001', 'states-owner-326@example.test'),
  ('c3260000-0000-4000-8000-000000000002', 'states-reader-326@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('c3260000-0000-4000-8000-000000000001', 'states-owner-326@example.test', 'States Owner', 'owner', true),
  ('c3260000-0000-4000-8000-000000000002', 'states-reader-326@example.test', 'States Reader', 'read_only', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level, can_manage_sessions, can_manage_integrations, is_active
) values ('c3260000-0000-4000-8000-000000000002', 'a1111111-1111-4111-8111-111111111111',
  'read_only', false, false, true);

create function pg_temp.unmatched_waiting() returns integer language sql as $$
  select coalesce((
    select (i ->> 'detail')::int
    from jsonb_array_elements(crm_private.pulse_items('a1111111-1111-4111-8111-111111111111', false, false)) i
    where i ->> 'kind' = 'unmatched_inbound'), 0);
$$;
create function pg_temp.reply_item(p uuid) returns jsonb language sql as $$
  select i from jsonb_array_elements(crm_private.pulse_items('a1111111-1111-4111-8111-111111111111', false, false)) i
  where i ->> 'key' = 'reply-' || p;
$$;
create function pg_temp.conv(p_id uuid, p_contact text, p_state text default 'open', p_channel text default 'whatsapp')
returns void language sql as $$
  insert into public.communication_conversations (
    id, artist_id, channel, integration_key, external_contact_id, link_state, state, last_message_at, last_inbound_at
  ) values (
    p_id, 'a1111111-1111-4111-8111-111111111111', p_channel::public.communication_channel,
    'states-326', p_contact, 'unmatched', p_state::public.communication_conversation_state, now(), now()
  );
$$;
create function pg_temp.msg(
  p_conv uuid, p_direction text, p_type text, p_at timestamptz,
  p_status text default null, p_origin text default null
) returns void language sql as $$
  insert into public.communication_messages (
    conversation_id, artist_id, channel, direction, origin, status, message_type, body,
    provider_timestamp, sent_at, error_code, created_at
  )
  select p_conv, c.artist_id, c.channel, p_direction::public.communication_direction,
    coalesce(p_origin, case p_direction when 'inbound' then 'contact' else 'provider_app' end)::public.communication_origin,
    coalesce(p_status, case p_direction when 'inbound' then 'received' else 'read' end)::public.communication_status,
    p_type, case when p_type = 'text' then 'message 326' end,
    case when p_direction = 'inbound' or coalesce(p_origin, 'provider_app') = 'provider_app' then p_at end,
    case when p_direction = 'outbound' and coalesce(p_status, 'read') in ('sent', 'delivered', 'read') then p_at end,
    case when p_status = 'failed' then 'send_failed' end,
    p_at
  from public.communication_conversations c where c.id = p_conv;
$$;

create temporary table baseline as select pg_temp.unmatched_waiting() as waiting;

-- ------------------------------------------------------- 1. actionability

select ok(not crm_private.communication_event_is_actionable(t), t || ' asks nothing of the studio')
from unnest(array['reaction', 'unsupported', 'edit', 'revoke']) t;
select ok(crm_private.communication_event_is_actionable(t), t || ' is actionable')
from unnest(array['text', 'image', 'audio', 'video', 'document', 'sticker', 'button', 'ig_reel']) t;
select ok(crm_private.communication_event_is_actionable('location_v9'),
  'an unknown provider type fails open');

-- A: a text 5 h ago, then only a reaction: still waiting since the text.
select pg_temp.conv('d3260000-0000-4000-8000-00000000000a', '447700326001');
select pg_temp.msg('d3260000-0000-4000-8000-00000000000a', 'inbound', 'text', now() - interval '5 hours');
select pg_temp.msg('d3260000-0000-4000-8000-00000000000a', 'inbound', 'reaction', now() - interval '1 hour');
-- B: reactions, unsupported, edit and revoke only.
select pg_temp.conv('d3260000-0000-4000-8000-00000000000b', '447700326002');
select pg_temp.msg('d3260000-0000-4000-8000-00000000000b', 'inbound', t, now() - interval '2 hours')
from unnest(array['reaction', 'unsupported', 'edit', 'revoke']) t;
-- C: answered from the phone, then a queued and a failed CRM send.
select pg_temp.conv('d3260000-0000-4000-8000-00000000000c', '447700326003');
select pg_temp.msg('d3260000-0000-4000-8000-00000000000c', 'inbound', 'image', now() - interval '6 hours');
select pg_temp.msg('d3260000-0000-4000-8000-00000000000c', 'outbound', 'text', now() - interval '5 hours');
-- D: only a failed CRM send and an automation after the client.
select pg_temp.conv('d3260000-0000-4000-8000-00000000000d', '447700326004');
select pg_temp.msg('d3260000-0000-4000-8000-00000000000d', 'inbound', 'audio', now() - interval '6 hours');
select pg_temp.msg('d3260000-0000-4000-8000-00000000000d', 'outbound', 'text', now() - interval '5 hours', 'failed', 'crm');
select pg_temp.msg('d3260000-0000-4000-8000-00000000000d', 'outbound', 'template', now() - interval '4 hours', 'read', 'automation');
-- E: an unknown provider type.
select pg_temp.conv('d3260000-0000-4000-8000-00000000000e', '447700326005');
select pg_temp.msg('d3260000-0000-4000-8000-00000000000e', 'inbound', 'location_v9', now() - interval '3 hours');

select is(crm_private.conversation_awaiting_reply_since('d3260000-0000-4000-8000-00000000000a'),
  (select max(provider_timestamp) from public.communication_messages
   where conversation_id = 'd3260000-0000-4000-8000-00000000000a' and message_type = 'text'),
  'a reaction after a question neither answers it nor restarts the clock');
select is(crm_private.conversation_awaiting_reply_since('d3260000-0000-4000-8000-00000000000b'), null::timestamptz,
  'reaction, unsupported, edit and revoke alone wait for nothing');
select is(crm_private.conversation_awaiting_reply_since('d3260000-0000-4000-8000-00000000000c'), null::timestamptz,
  'a reply sent from the phone is the studio''s turn');
-- F: the studio acknowledged the client's closing line with a reaction
-- (20261004190000); an edit is not a turn, and a new message waits again.
select pg_temp.conv('d3260000-0000-4000-8000-00000000000f', '447700326006');
select pg_temp.msg('d3260000-0000-4000-8000-00000000000f', 'inbound', 'text', now() - interval '3 hours');
select pg_temp.msg('d3260000-0000-4000-8000-00000000000f', 'outbound', 'edit', now() - interval '150 minutes', 'sent');
select ok(crm_private.conversation_awaiting_reply_since('d3260000-0000-4000-8000-00000000000f') is not null,
  'an edit from the studio is not a reply');
select pg_temp.msg('d3260000-0000-4000-8000-00000000000f', 'outbound', 'reaction', now() - interval '2 hours', 'sent');
select is(crm_private.conversation_awaiting_reply_since('d3260000-0000-4000-8000-00000000000f'), null::timestamptz,
  'a studio reaction after the client''s message is the studio''s turn');
select pg_temp.msg('d3260000-0000-4000-8000-00000000000f', 'inbound', 'text', now() - interval '90 minutes');
select ok(crm_private.conversation_awaiting_reply_since('d3260000-0000-4000-8000-00000000000f') is not null,
  'a new client message after the reaction waits again');
select pg_temp.msg('d3260000-0000-4000-8000-00000000000f', 'outbound', 'text', now() - interval '1 hour');
select ok(crm_private.conversation_awaiting_reply_since('d3260000-0000-4000-8000-00000000000d') is not null,
  'a failed send and an automation are not a reply');
select ok(crm_private.conversation_awaiting_reply_since('d3260000-0000-4000-8000-00000000000e') is not null,
  'an unknown inbound type still waits on the studio');
select is(pg_temp.unmatched_waiting(), (select waiting from baseline) + 3,
  'Today counts exactly the three unknown senders waiting on a real message');

-- ------------------------------------------------------- 2. not_crm

select throws_ok(
  $$select public.set_conversation_not_crm('d3260000-0000-4000-8000-00000000000a', true)$$,
  '42501', null, 'marking a conversation personal needs a signed-in operator');
select set_config('request.jwt.claims',
  '{"sub":"c3260000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$select public.set_conversation_not_crm('d3260000-0000-4000-8000-00000000000a', true)$$,
  '42501', null, 'a read-only profile cannot mark a conversation personal');
select is((public.get_conversation_attention('d3260000-0000-4000-8000-00000000000a') ->> 'needs_reply')::boolean,
  true, 'a read-only profile can see that it waits');
reset role;

select set_config('request.jwt.claims',
  '{"sub":"c3260000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select lives_ok(
  $$select public.set_conversation_not_crm('d3260000-0000-4000-8000-00000000000a', true)$$,
  'the owner marks a conversation personal');
select is((public.get_conversation_attention('d3260000-0000-4000-8000-00000000000a') ->> 'needs_reply')::boolean,
  false, 'a personal conversation does not need a reply');
select ok((select bool_and(not needs_reply and not_crm_at is not null)
           from public.list_communication_conversations(null, 'unmatched', 100)
           where id = 'd3260000-0000-4000-8000-00000000000a'),
  'the Inbox projection says the same');
reset role;
select is(pg_temp.unmatched_waiting(), (select waiting from baseline) + 2, 'Today stops counting it');

select pg_temp.msg('d3260000-0000-4000-8000-00000000000a', 'inbound', 'text', now() - interval '10 minutes');
select is(pg_temp.unmatched_waiting(), (select waiting from baseline) + 2,
  'a new personal message stays hidden until the operator says otherwise');
select is(crm_private.unanswered_waiting_since('conversation', 'a1111111-1111-4111-8111-111111111111',
  'd3260000-0000-4000-8000-00000000000a'), null::timestamptz, 'and sends no Telegram reminder');
select ok(exists (select 1 from public.activity_log l
                  where l.event_type = 'communication.not_crm_marked'
                    and l.metadata ->> 'conversation' = 'd3260000-0000-4000-8000-00000000000a'),
  'the mark is in the audit trail');

set local role authenticated;
select lives_ok(
  $$select public.set_conversation_not_crm('d3260000-0000-4000-8000-00000000000a', false)$$,
  'the owner clears the mark');
reset role;
select is(pg_temp.unmatched_waiting(), (select waiting from baseline) + 3, 'and it waits in Today again');

-- A linked conversation cannot be marked personal, and a mark made before a
-- link never hides the client's messages.
insert into public.clients (id, full_name, email, phone) values
  ('c3261111-0000-4000-8000-000000000000', 'Linked Later 326', 'linked-later-326@example.test', null);
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'e3261111-0000-4000-8000-000000000000', 'c3261111-0000-4000-8000-000000000000',
  'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-3261', 'e3261111-9999-4000-8000-000000000000',
  repeat('1', 64), 'reviewing', 'complete', 'Linked Later 326', 'linked-later-326@example.test', '2026-08-05', now());

set local role authenticated;
select public.set_conversation_not_crm('d3260000-0000-4000-8000-00000000000e', true);
select lives_ok(
  $$select public.link_communication_conversation_client('d3260000-0000-4000-8000-00000000000e', 'c3261111-0000-4000-8000-000000000000')$$,
  'the operator links the personal-marked conversation to a client');
select throws_ok(
  $$select public.set_conversation_not_crm('d3260000-0000-4000-8000-00000000000e', true)$$,
  '23514', null, 'a linked conversation cannot be marked personal');
reset role;
select ok(pg_temp.reply_item('d3260000-0000-4000-8000-00000000000e') is not null,
  'the linked client''s waiting message is in Today despite the old mark');
select pg_temp.msg('d3260000-0000-4000-8000-00000000000e', 'inbound', 'text', now() - interval '5 minutes');
select ok(pg_temp.reply_item('d3260000-0000-4000-8000-00000000000e') is not null,
  'and so is the next one');
select is(pg_temp.unmatched_waiting(), (select waiting from baseline) + 2,
  'it no longer counts as an unknown sender');

-- ------------------------------------------------------- 3. handled outside the CRM

-- The version the operator saw: the actionable inbound the screen showed.
create temporary table seen as
select crm_private.conversation_awaiting_reply_since('d3260000-0000-4000-8000-00000000000d') as at;
grant select on seen to authenticated;
set local role authenticated;
select lives_ok(
  format($$select public.acknowledge_attention_item('a1111111-1111-4111-8111-111111111111', 'conversation_reply',
           'd3260000-0000-4000-8000-00000000000d', %L)$$, (select at from seen)),
  'the owner says the conversation was handled outside the CRM');
select ok((public.get_conversation_attention('d3260000-0000-4000-8000-00000000000d') ->> 'handled_outside_crm_at') is not null,
  'the conversation shows it was handled outside the CRM');
reset role;
select is(pg_temp.unmatched_waiting(), (select waiting from baseline) + 1, 'Today stops counting it');

select pg_temp.msg('d3260000-0000-4000-8000-00000000000d', 'inbound', 'reaction', now() - interval '2 minutes');
select is(pg_temp.unmatched_waiting(), (select waiting from baseline) + 1,
  'a reaction afterwards does not bring it back');
select pg_temp.msg('d3260000-0000-4000-8000-00000000000d', 'inbound', 'text', now() - interval '1 minute');
select is(pg_temp.unmatched_waiting(), (select waiting from baseline) + 2,
  'a new real message after it returns it to Today');

update seen set at = crm_private.conversation_awaiting_reply_since('d3260000-0000-4000-8000-00000000000d');
set local role authenticated;
select public.acknowledge_attention_item('a1111111-1111-4111-8111-111111111111', 'conversation_reply',
  'd3260000-0000-4000-8000-00000000000d', (select at from seen));
select is((public.clear_attention_acknowledgement('a1111111-1111-4111-8111-111111111111', 'conversation_reply',
  'd3260000-0000-4000-8000-00000000000d') ->> 'cleared')::boolean, true, 'the owner can undo it');
reset role;
select is(pg_temp.unmatched_waiting(), (select waiting from baseline) + 2, 'and it waits again');
select set_config('request.jwt.claims',
  '{"sub":"c3260000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$select public.clear_attention_acknowledgement('a1111111-1111-4111-8111-111111111111', 'conversation_reply',
    'd3260000-0000-4000-8000-00000000000d')$$,
  '42501', null, 'a read-only profile cannot undo an acknowledgement');
reset role;
select set_config('request.jwt.claims',
  '{"sub":"c3260000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ------------------------------------------------------- 4. archive

select pg_temp.conv('d3260000-0000-4000-8000-0000000000a1', '447700326011', 'archived');
select pg_temp.msg('d3260000-0000-4000-8000-0000000000a1', 'inbound', 'reaction', now());
select is((select state::text from public.communication_conversations where id = 'd3260000-0000-4000-8000-0000000000a1'),
  'archived', 'a reaction leaves an archived conversation archived');
select pg_temp.msg('d3260000-0000-4000-8000-0000000000a1', 'inbound', 'text', now());
select is((select state::text from public.communication_conversations where id = 'd3260000-0000-4000-8000-0000000000a1'),
  'open', 'a real message reopens an archived conversation');

select pg_temp.conv('d3260000-0000-4000-8000-0000000000a2', '447700326012', 'archived');
update public.communication_conversations set not_crm_at = now()
where id = 'd3260000-0000-4000-8000-0000000000a2';
select pg_temp.msg('d3260000-0000-4000-8000-0000000000a2', 'inbound', 'text', now());
select is((select state::text from public.communication_conversations where id = 'd3260000-0000-4000-8000-0000000000a2'),
  'archived', 'a personal unlinked conversation stays archived');

-- ------------------------------------------------------- 5. client-side exact linking

select pg_temp.conv('d3260000-0000-4000-8000-0000000000b1', '447700326021');
select pg_temp.msg('d3260000-0000-4000-8000-0000000000b1', 'inbound', 'text', now() - interval '1 hour');
insert into public.clients (id, full_name, email, phone) values
  ('c3262222-0000-4000-8000-000000000000', 'Exact Phone 326', 'exact-326@example.test', '+44 7700 326021');
select is((select link_state::text from public.communication_conversations where id = 'd3260000-0000-4000-8000-0000000000b1'),
  'unmatched', 'a client outside the artist''s scope is not linked');
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'e3262222-0000-4000-8000-000000000000', 'c3262222-0000-4000-8000-000000000000',
  'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-3262', 'e3262222-9999-4000-8000-000000000000',
  repeat('2', 64), 'reviewing', 'complete', 'Exact Phone 326', 'exact-326@example.test', '2026-08-05', now());
select is((select client_id from public.communication_conversations where id = 'd3260000-0000-4000-8000-0000000000b1'),
  'c3262222-0000-4000-8000-000000000000'::uuid, 'the unique exact phone match is linked once the client is in scope');
select is((select enquiry_id from public.communication_conversations where id = 'd3260000-0000-4000-8000-0000000000b1'),
  'e3262222-0000-4000-8000-000000000000'::uuid, 'with the client''s enquiry');

-- Ambiguous: two clients in scope share the number.
select pg_temp.conv('d3260000-0000-4000-8000-0000000000b2', '447700326022');
insert into public.clients (id, full_name, email, phone) values
  ('c3263333-0000-4000-8000-000000000000', 'Shared One 326', 'shared-one-326@example.test', null),
  ('c3264444-0000-4000-8000-000000000000', 'Shared Two 326', 'shared-two-326@example.test', '07700 326022');
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at
) values
  ('e3263333-0000-4000-8000-000000000000', 'c3263333-0000-4000-8000-000000000000',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-3263', 'e3263333-9999-4000-8000-000000000000',
   repeat('3', 64), 'reviewing', 'complete', 'Shared One 326', 'shared-one-326@example.test', '2026-08-05', now()),
  ('e3264444-0000-4000-8000-000000000000', 'c3264444-0000-4000-8000-000000000000',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-3264', 'e3264444-9999-4000-8000-000000000000',
   repeat('4', 64), 'reviewing', 'complete', 'Shared Two 326', 'shared-two-326@example.test', '2026-08-05', now());
-- The first client gets the same number only now: two exact matches.
update public.clients set phone = '+447700326022' where id = 'c3263333-0000-4000-8000-000000000000';
select is((select link_state::text from public.communication_conversations where id = 'd3260000-0000-4000-8000-0000000000b2'),
  'unmatched', 'an automatic link is withdrawn the moment its number stops being unique');
select is((select auto_linked_at from public.communication_conversations where id = 'd3260000-0000-4000-8000-0000000000b2'),
  null::timestamptz, 'and carries no automatic provenance any more');
update public.clients set phone = '+447700326022' where id = 'c3264444-0000-4000-8000-000000000000';
select is((select link_state::text from public.communication_conversations where id = 'd3260000-0000-4000-8000-0000000000b2'),
  'unmatched', 'two clients with one number are never guessed between');
-- The number becomes unique again when one client changes phone.
update public.clients set phone = '+447700326099' where id = 'c3263333-0000-4000-8000-000000000000';
select is((select client_id from public.communication_conversations where id = 'd3260000-0000-4000-8000-0000000000b2'),
  'c3264444-0000-4000-8000-000000000000'::uuid, 'and the unique match is linked again');

-- An operator link is the operator's: an ambiguity later never withdraws it.
set local role authenticated;
select public.link_communication_conversation_client('d3260000-0000-4000-8000-0000000000b2', 'c3264444-0000-4000-8000-000000000000');
reset role;
select is((select auto_linked_at from public.communication_conversations where id = 'd3260000-0000-4000-8000-0000000000b2'),
  null::timestamptz, 'an operator confirming the automatic match makes the link the operator''s');
update public.clients set phone = '+447700326022' where id = 'c3263333-0000-4000-8000-000000000000';
select is((select client_id from public.communication_conversations where id = 'd3260000-0000-4000-8000-0000000000b2'),
  'c3264444-0000-4000-8000-000000000000'::uuid, 'an operator link survives a later ambiguity');

-- Cross-artist: a client reached only through another artist.
select pg_temp.conv('d3260000-0000-4000-8000-0000000000b3', '447700326023');
insert into public.clients (id, full_name, email, phone) values
  ('c3265555-0000-4000-8000-000000000000', 'Other Artist 326', 'other-326@example.test', '+447700326023');
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'e3265555-0000-4000-8000-000000000000', 'c3265555-0000-4000-8000-000000000000',
  'a2222222-2222-4222-8222-222222222222', 'ENQ-2099-3265', 'e3265555-9999-4000-8000-000000000000',
  repeat('5', 64), 'reviewing', 'complete', 'Other Artist 326', 'other-326@example.test', '2026-08-05', now());
select is((select link_state::text from public.communication_conversations where id = 'd3260000-0000-4000-8000-0000000000b3'),
  'unmatched', 'another artist''s client is never linked');

-- ------------------------------------------------------- 6. attention facts

-- A linked client answered from the phone, then reacted: the studio spoke last.
insert into public.clients (id, full_name, email) values
  ('c3266666-0000-4000-8000-000000000000', 'Reacting Client 326', 'reacting-326@example.test');
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'e3266666-0000-4000-8000-000000000000', 'c3266666-0000-4000-8000-000000000000',
  'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-3266', 'e3266666-9999-4000-8000-000000000000',
  repeat('6', 64), 'reviewing', 'complete', 'Reacting Client 326', 'reacting-326@example.test', '2026-08-05',
  now() - interval '10 days');
select pg_temp.conv('d3260000-0000-4000-8000-0000000000c1', '447700326031');
update public.communication_conversations
set client_id = 'c3266666-0000-4000-8000-000000000000', link_state = 'linked'
where id = 'd3260000-0000-4000-8000-0000000000c1';
select pg_temp.msg('d3260000-0000-4000-8000-0000000000c1', 'inbound', 'text', now() - interval '9 days');
select pg_temp.msg('d3260000-0000-4000-8000-0000000000c1', 'outbound', 'text', now() - interval '8 days');
select pg_temp.msg('d3260000-0000-4000-8000-0000000000c1', 'inbound', 'reaction', now() - interval '7 days');
select is((select last_speaker from crm_private.attention_comm_facts(
             'a1111111-1111-4111-8111-111111111111', 'c3266666-0000-4000-8000-000000000000')),
  'studio', 'a client reaction after the studio''s reply is not the client''s turn');
select ok(pg_temp.reply_item('d3260000-0000-4000-8000-0000000000c1') is null,
  'and Today shows no reply item for it');

-- ------------------------------------------------------- 7. history is kept

select is((select count(*)::int from public.communication_messages
           where conversation_id = 'd3260000-0000-4000-8000-00000000000a'), 3,
  'marking, clearing and acknowledging deleted no message');
select is((select count(*)::int from public.communication_messages
           where conversation_id = 'd3260000-0000-4000-8000-00000000000d'), 5,
  'every inbound event is still stored, reactions included');

select * from finish(true);
rollback;
