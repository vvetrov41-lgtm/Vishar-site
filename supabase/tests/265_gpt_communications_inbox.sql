-- 265_gpt_communications_inbox.sql
--
-- Migration 0125: the unified Communications inbox reaches the profile-bound
-- Vishar Unified GPT as nine named operations.
--
-- The rules under test are that the GPT surface adds a ceiling rather than a
-- bypass: the owner-controlled communications capability still gates it, the
-- server-owned active Artist context still pins every conversation, and a
-- conversation belonging to another Artist is refused without confirming that
-- it exists.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Function ACL and hardening
-- ---------------------------------------------------------------------------

select ok(
  not has_function_privilege('authenticated', 'crm_private.gpt_communication_conversation(uuid)', 'EXECUTE'),
  'the private conversation pin is not browser executable'
);

select ok(
  (select bool_and(
     p.prosecdef
     and 'search_path=pg_catalog, public, crm_private' = any (p.proconfig)
   )
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'gpt_list_communication_conversations',
       'gpt_get_communication_conversation',
       'gpt_list_communication_messages',
       'gpt_send_communication_reply',
       'gpt_mark_communication_conversation_read',
       'gpt_set_communication_conversation_state',
       'gpt_link_communication_conversation_client',
       'gpt_create_client_from_communication',
       'gpt_create_enquiry_from_communication'
     )),
  'every GPT inbox RPC is SECURITY DEFINER with a fixed search_path'
);

select ok(
  not has_function_privilege('anon', 'public.gpt_list_communication_conversations(text,text,text,integer,timestamptz)', 'EXECUTE'),
  'anon cannot list conversations through the GPT surface'
);
select ok(
  not has_function_privilege('service_role', 'public.gpt_send_communication_reply(uuid,text,uuid)', 'EXECUTE'),
  'the public Worker credential cannot send a reply through the GPT surface'
);
select ok(
  not has_function_privilege('service_role', 'public.gpt_create_enquiry_from_communication(uuid,uuid,jsonb,jsonb,boolean)', 'EXECUTE'),
  'the public Worker credential cannot mint an enquiry through the GPT surface'
);
select ok(
  has_function_privilege('authenticated', 'public.gpt_list_communication_messages(uuid,integer)', 'EXECUTE'),
  'an authenticated GPT OAuth session may read bounded conversation history'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.artist_integrations
  (artist_id, integration_type, provider, integration_key, configuration, is_enabled)
values
  ('a1111111-1111-4111-8111-111111111111', 'instagram', 'instagram_login',
   'vladimir-gpt-inbox', '{"instagram_user_id":"17841400000000021"}'::jsonb, true),
  ('a1111111-1111-4111-8111-111111111111', 'whatsapp', 'meta_cloud_api',
   'vladimir-gpt-inbox-wa', '{}'::jsonb, true),
  ('a2222222-2222-4222-8222-222222222222', 'instagram', 'instagram_login',
   'kristina-gpt-inbox', '{"instagram_user_id":"17841400000000022"}'::jsonb, true);

select public.record_communication_inbound_message(
  'a1111111-1111-4111-8111-111111111111', 'instagram', 'vladimir-gpt-inbox',
  '5560000000001', 'ig_mid_GPTINBOX000001', '2026-08-20 09:00:00+00',
  'text', 'Hi, can I book a half sleeve?'
);
select public.record_communication_inbound_message(
  'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'vladimir-gpt-inbox-wa',
  '447700940001', 'wamid.GPTINBOXSYNTH01', '2026-08-20 09:05:00+00',
  'text', 'WhatsApp side of the same inbox'
);
select public.record_communication_inbound_message(
  'a2222222-2222-4222-8222-222222222222', 'instagram', 'kristina-gpt-inbox',
  '5560000000002', 'ig_mid_GPTINBOX000002', '2026-08-20 09:10:00+00',
  'text', 'Kristina side, out of scope'
);
select public.record_communication_inbound_message(
  'a1111111-1111-4111-8111-111111111111', 'instagram', 'vladimir-gpt-inbox',
  '5560000000003', 'ig_mid_GPTINBOX000003', '2026-08-20 06:55:00+00',
  'text', 'Escaped-content sender'
);

update public.communication_conversations
set external_display_label = 'sleeve.enquiry'
where external_contact_id = '5560000000001';

-- Twenty maximum-length inbound messages, so the byte budget is the binding
-- constraint on a page rather than the row count.
insert into public.communication_messages
  (conversation_id, artist_id, channel, direction, origin, status, message_type, body, created_at)
select
  c.id, c.artist_id, c.channel,
  'inbound'::public.communication_direction,
  'contact'::public.communication_origin,
  'received'::public.communication_status,
  'text',
  repeat('x', 4096),
  '2026-08-20 08:00:00+00'::timestamptz + (n * interval '1 minute')
from public.communication_conversations c
cross join generate_series(1, 20) as n
where c.external_contact_id = '447700940001';

-- Six maximum-length control-character messages on the Instagram side. Stored
-- bytes and JSON bytes agree for 'x' and diverge six-fold here, which is the
-- shape a raw-byte budget cannot see.
insert into public.communication_messages
  (conversation_id, artist_id, channel, direction, origin, status, message_type, body, created_at)
select
  c.id, c.artist_id, c.channel,
  'inbound'::public.communication_direction,
  'contact'::public.communication_origin,
  'received'::public.communication_status,
  'text',
  repeat(chr(1), 4096),
  '2026-08-20 07:00:00+00'::timestamptz + (n * interval '1 minute')
from public.communication_conversations c
cross join generate_series(1, 6) as n
where c.external_contact_id = '5560000000003';

insert into public.clients (id, full_name, email, phone) values
  ('f6911111-1111-4111-8111-111111111111', 'GPT Inbox Existing Client',
   'gpt.inbox.existing@example.test', '+44 7700 941111');

insert into public.enquiries
  (id, client_id, idempotency_key, intake_fingerprint, intake_state,
   submitted_full_name, submitted_email, privacy_notice_version,
   privacy_acknowledged_at, artist_id)
values
  ('f6811111-1111-4111-8111-111111111111', 'f6911111-1111-4111-8111-111111111111',
   'f6711111-1111-4111-8111-111111111111', repeat('c', 64), 'complete',
   'GPT Inbox Existing Client', 'gpt.inbox.existing@example.test', '2026-07-29', now(),
   'a1111111-1111-4111-8111-111111111111');

insert into auth.users (id, email) values
  ('f6011111-1111-4111-8111-111111111111', 'gpt-inbox-operator@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('f6011111-1111-4111-8111-111111111111', 'gpt-inbox-operator@example.test',
   'GPT Inbox Operator', 'booking_manager', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('f6011111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'manager', false, false, true, false, true),
  ('f6011111-1111-4111-8111-111111111111',
   'a2222222-2222-4222-8222-222222222222', 'manager', false, false, true, false, true);

-- The unified client ships with every capability off. Enabling communications
-- here is the owner decision the ceiling is meant to represent.
update crm_private.gpt_action_clients
set oauth_client_id = 'oauth-gpt-inbox-test',
    can_manage_communications = true,
    can_manage_crm = true,
    is_active = true
where integration_key = 'vishar-unified-gpt';

create function pg_temp.inbox_claims(p text) returns void language sql as
  $$select set_config('request.jwt.claims', p, true)::void$$;
grant execute on function pg_temp.inbox_claims(text) to authenticated;

-- Resolves a synthetic conversation by participant. SECURITY DEFINER so the
-- role-switched session can still address a conversation it is about to be
-- refused.
create function pg_temp.conversation_for(p_contact text) returns uuid
  language sql stable security definer as
  $$select id from public.communication_conversations where external_contact_id = p_contact$$;
grant execute on function pg_temp.conversation_for(text) to authenticated;

create function pg_temp.conversation_state(p_id uuid) returns text
  language sql stable security definer as
  $$select state::text from public.communication_conversations where id = p_id$$;
grant execute on function pg_temp.conversation_state(uuid) to authenticated;

create function pg_temp.conversation_client(p_id uuid) returns uuid
  language sql stable security definer as
  $$select client_id from public.communication_conversations where id = p_id$$;
grant execute on function pg_temp.conversation_client(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. The inbox reaches the GPT only inside the active Artist context
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.inbox_claims(
  '{"sub":"f6011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-gpt-inbox-test"}'
);

-- Two Artists are reachable, so the profile-bound GPT has to choose one. That
-- choice is the only place an Artist id is accepted.
select is(
  public.gpt_artist_context('a1111111-1111-4111-8111-111111111111') ->> 'active_artist_id',
  'a1111111-1111-4111-8111-111111111111',
  'the operator selects Vladimir as the active Artist context'
);

select is(
  (select count(*)::int from public.gpt_list_communication_conversations(null, null, null, 50, null)),
  3,
  'only the active Artist conversations are listed'
);
select is(
  (select count(*)::int from public.gpt_list_communication_conversations('instagram', null, null, 50, null)),
  2,
  'the channel filter narrows the active Artist inbox'
);
select is(
  (select count(*)::int from public.gpt_list_communication_conversations(null, 'unmatched', null, 50, null)),
  3,
  'every new sender is still unmatched'
);
select throws_ok(
  $$select * from public.gpt_list_communication_conversations('telegram', null, null, 50, null)$$,
  '22023',
  null,
  'an unsupported channel is refused rather than silently ignored'
);

-- The list is a projection, not a provider dump: the operator sees the label
-- the provider supplied, and nothing is invented where there is none.
select is(
  (select contact_label from public.gpt_get_communication_conversation(
     pg_temp.conversation_for('5560000000001'))),
  'sleeve.enquiry',
  'a conversation carries the display label the provider supplied'
);
select is(
  (select contact_label from public.gpt_get_communication_conversation(
     pg_temp.conversation_for('447700940001'))),
  null,
  'a conversation with no provider label reports none rather than a raw contact id'
);

select is(
  (select conversation_id from public.gpt_get_communication_conversation(
     pg_temp.conversation_for('5560000000001'))),
  pg_temp.conversation_for('5560000000001'),
  'a single conversation resolves inside the active Artist context'
);
select is(
  (select has_unread from public.gpt_get_communication_conversation(
     pg_temp.conversation_for('5560000000001'))),
  true,
  'an unread inbound conversation reports as unread'
);

select is(
  (select count(*)::int from public.gpt_list_communication_messages(
     pg_temp.conversation_for('5560000000001'), 30)),
  1,
  'bounded message history is readable for an in-scope conversation'
);
select is(
  (select attachment_count from public.gpt_list_communication_messages(
     pg_temp.conversation_for('5560000000001'), 30)),
  0,
  'attachments are reduced to a count rather than a provider payload'
);

-- A row count alone does not bound the response. Thirty maximum-length bodies
-- would exceed the action gateway's 128 KiB ceiling, so the page stops on a
-- byte budget instead and still returns whole bodies.
select is(
  (select count(*)::int from public.gpt_list_communication_messages(
     pg_temp.conversation_for('447700940001'), 30)),
  13,
  'a conversation of long messages returns a byte-budgeted page, not the full 30'
);
select ok(
  (select sum(octet_length(body)) from public.gpt_list_communication_messages(
     pg_temp.conversation_for('447700940001'), 30)) <= 50000 + 4096,
  'the returned bodies stay inside the byte budget the gateway can carry'
);
select ok(
  (select bool_and(char_length(body) = 4096)
   from public.gpt_list_communication_messages(
     pg_temp.conversation_for('447700940001'), 30)
   where char_length(body) > 100),
  'bodies inside the budget are returned whole rather than truncated'
);

-- The gateway ceiling applies after JSON serialisation, and escaping is not a
-- small constant: a C0 control character is one stored byte and six serialised
-- ones. A budget measured in stored bytes would admit twelve of these bodies
-- and emit roughly 295 KB against a 128 KiB cap, so the page must shrink on
-- the escaped size rather than the stored size.
select is(
  (select count(*)::int from public.gpt_list_communication_messages(
     pg_temp.conversation_for('5560000000003'), 30)),
  3,
  'a page of heavily escaped bodies is bounded by serialised bytes, not stored bytes'
);
select ok(
  (select sum(octet_length(to_jsonb(body)::text))
   from public.gpt_list_communication_messages(
     pg_temp.conversation_for('5560000000003'), 30)) <= 50000 + 24578,
  'the serialised bodies stay inside the budget plus one over-budget newest message'
);
select ok(
  (select sum(octet_length(to_jsonb(body)::text))
   from public.gpt_list_communication_messages(
     pg_temp.conversation_for('5560000000003'), 30)) < 131072,
  'the escaped worst case stays under the action gateway response ceiling'
);
select ok(
  (select count(*)::int from public.gpt_list_communication_messages(
     pg_temp.conversation_for('5560000000003'), 30))
  < (select floor(50000.0 / octet_length(repeat(chr(1), 4096)))::int),
  'the escaped page is strictly smaller than a stored-byte budget would have allowed'
);

-- ---------------------------------------------------------------------------
-- 2. Another Artist's conversation is refused without disclosing it
-- ---------------------------------------------------------------------------

select throws_ok(
  format(
    $$select * from public.gpt_list_communication_messages(%L::uuid, 10)$$,
    pg_temp.conversation_for('5560000000002')
  ),
  '42501',
  null,
  'a conversation outside the active Artist context cannot be read'
);
select throws_ok(
  format(
    $$select public.gpt_mark_communication_conversation_read(%L::uuid)$$,
    pg_temp.conversation_for('5560000000002')
  ),
  '42501',
  null,
  'a conversation outside the active Artist context cannot be marked read'
);
select throws_ok(
  $$select public.gpt_get_communication_conversation('f6111111-1111-4111-8111-111111111111')$$,
  '42501',
  null,
  'a conversation that does not exist is answered the same way as one out of scope'
);

-- ---------------------------------------------------------------------------
-- 3. Operator mutations run through the existing CRM contracts
-- ---------------------------------------------------------------------------

select lives_ok(
  format(
    $$select public.gpt_mark_communication_conversation_read(%L::uuid)$$,
    pg_temp.conversation_for('5560000000001')
  ),
  'the GPT can mark an in-scope conversation read'
);
select is(
  (select has_unread from public.gpt_get_communication_conversation(
     pg_temp.conversation_for('5560000000001'))),
  false,
  'marking read clears the unread projection'
);

select lives_ok(
  format(
    $$select public.gpt_send_communication_reply(%L::uuid, 'Thanks for getting in touch.', 'f6511111-1111-4111-8111-111111111111')$$,
    pg_temp.conversation_for('5560000000001')
  ),
  'the GPT can queue one outbound reply'
);
select is(
  (select (public.gpt_send_communication_reply(
     pg_temp.conversation_for('5560000000001'),
     'Thanks for getting in touch.',
     'f6511111-1111-4111-8111-111111111111') ->> 'replayed')::boolean),
  true,
  'an identical request id replays the original message instead of sending twice'
);
select is(
  (select count(*)::int from public.gpt_list_communication_messages(
     pg_temp.conversation_for('5560000000001'), 30)),
  2,
  'exactly one outbound message was created for the repeated request id'
);

select lives_ok(
  format(
    $$select public.gpt_link_communication_conversation_client(%L::uuid, 'f6911111-1111-4111-8111-111111111111')$$,
    pg_temp.conversation_for('447700940001')
  ),
  'the GPT can link an existing CRM client to an in-scope conversation'
);
select is(
  pg_temp.conversation_client(pg_temp.conversation_for('447700940001')),
  'f6911111-1111-4111-8111-111111111111'::uuid,
  'the link is recorded on the conversation'
);

select lives_ok(
  format(
    $$select public.gpt_set_communication_conversation_state(%L::uuid, 'archived')$$,
    pg_temp.conversation_for('447700940001')
  ),
  'the GPT can archive an in-scope conversation'
);
select is(
  pg_temp.conversation_state(pg_temp.conversation_for('447700940001')),
  'archived',
  'the archived state is persisted'
);
select throws_ok(
  format(
    $$select public.gpt_set_communication_conversation_state(%L::uuid, 'deleted')$$,
    pg_temp.conversation_for('447700940001')
  ),
  '22023',
  null,
  'only the supported conversation states are accepted'
);

select is(
  public.gpt_create_enquiry_from_communication(
    pg_temp.conversation_for('5560000000001'),
    'f6611111-1111-4111-8111-111111111111',
    jsonb_build_object(
      'full_name', 'GPT Inbox New Client',
      'email', 'gpt.inbox.new@example.test',
      'phone', '+44 7700 942222'
    ),
    jsonb_build_object(
      'project_type', 'Black and grey',
      'placement', 'Upper arm',
      'idea', 'Synthetic GPT inbox conversion'
    ),
    true
  ) ->> 'created_from_communication',
  'true',
  'the GPT can promote an in-scope conversation to an enquiry'
);
select is(
  (select conversation_id from public.gpt_get_communication_conversation(
     pg_temp.conversation_for('5560000000001'))),
  pg_temp.conversation_for('5560000000001'),
  'the promoted conversation stays inside the active Artist context'
);
select isnt(
  pg_temp.conversation_client(pg_temp.conversation_for('5560000000001')),
  null,
  'promoting the conversation linked it to the client intake resolved'
);

-- ---------------------------------------------------------------------------
-- 4. Creating CRM records still needs the CRM ceiling
--
-- Creating a client or an enquiry is a CRM action that happens to start in the
-- inbox. Turning messaging on must not hand a GPT client the intake its owner
-- deliberately left off.
-- ---------------------------------------------------------------------------

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update crm_private.gpt_action_clients
set can_manage_crm = false
where integration_key = 'vishar-unified-gpt';

set local role authenticated;
select pg_temp.inbox_claims(
  '{"sub":"f6011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-gpt-inbox-test"}'
);

select throws_ok(
  format(
    $$select public.gpt_create_client_from_communication(%L::uuid, 'Should Not Exist', null, null, null)$$,
    pg_temp.conversation_for('447700940001')
  ),
  '42501',
  null,
  'creating a client from a conversation is refused when CRM management is off'
);
select throws_ok(
  format(
    $$select public.gpt_create_enquiry_from_communication(
        %L::uuid,
        'f6311111-1111-4111-8111-111111111111',
        jsonb_build_object('full_name', 'Should Not Exist', 'email', 'nope@example.test'),
        jsonb_build_object('idea', 'Should not be created'),
        true
      )$$,
    pg_temp.conversation_for('447700940001')
  ),
  '42501',
  null,
  'promoting a conversation to an enquiry is refused when CRM management is off'
);

-- The messaging half of the surface is unaffected: the two ceilings are
-- independent owner decisions, not one switch.
select lives_ok(
  $$select * from public.gpt_list_communication_conversations(null, null, null, 10, null)$$,
  'reading the inbox still works with only the communications capability'
);
select lives_ok(
  format(
    $$select public.gpt_mark_communication_conversation_read(%L::uuid)$$,
    pg_temp.conversation_for('5560000000001')
  ),
  'inbox-only operator actions still work with only the communications capability'
);

-- ---------------------------------------------------------------------------
-- 5. The owner-controlled capability is still a ceiling
-- ---------------------------------------------------------------------------

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update crm_private.gpt_action_clients
set can_manage_communications = false
where integration_key = 'vishar-unified-gpt';

set local role authenticated;
select pg_temp.inbox_claims(
  '{"sub":"f6011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-gpt-inbox-test"}'
);

select throws_ok(
  $$select * from public.gpt_list_communication_conversations(null, null, null, 10, null)$$,
  '42501',
  null,
  'the inbox closes when the owner turns the communications capability off'
);
select throws_ok(
  format(
    $$select public.gpt_send_communication_reply(%L::uuid, 'Should not send', 'f6411111-1111-4111-8111-111111111111')$$,
    pg_temp.conversation_for('5560000000001')
  ),
  '42501',
  null,
  'replies close with the capability, not just reads'
);

select * from finish();
rollback;
