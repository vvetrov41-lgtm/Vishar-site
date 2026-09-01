-- 221_communications_inbox.sql
--
-- Migration 0072: the CRM inbox projection and the operator actions that turn
-- an unknown sender into a known one.
--
-- Everything here is synthetic. The rule under test is that an inbound direct
-- message is never automatically an enquiry, that linking is conservative, and
-- that neither action can cross an artist boundary.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Function ACL and hardening
-- ---------------------------------------------------------------------------

select ok(
  not has_function_privilege('anon', 'public.list_communication_conversations(text,text,integer,timestamptz)', 'EXECUTE'),
  'anon cannot list conversations'
);
select ok(
  has_function_privilege('authenticated', 'public.list_communication_conversations(text,text,integer,timestamptz)', 'EXECUTE'),
  'an authenticated CRM session may list conversations'
);
select ok(
  not has_function_privilege('anon', 'public.link_communication_conversation_client(uuid,uuid)', 'EXECUTE'),
  'anon cannot link a client'
);
select ok(
  not has_function_privilege('service_role', 'public.create_enquiry_from_communication(uuid,uuid,jsonb,jsonb,boolean)', 'EXECUTE'),
  'the public Worker credential cannot mint an enquiry from a conversation'
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
       'list_communication_conversations',
       'link_communication_conversation_client',
       'create_client_from_communication',
       'create_enquiry_from_communication',
       'mark_communication_conversation_read',
       'set_communication_conversation_state'
     )),
  'every inbox RPC is SECURITY DEFINER with a fixed search_path'
);

-- Provenance is typed, not free text, so a browser cannot forge it.
select has_column('public', 'enquiries', 'communication_conversation_id',
                  'an enquiry records the conversation it came from');
select has_column('public', 'enquiries', 'communication_channel',
                  'an enquiry records the channel it came from');
select has_column('public', 'enquiries', 'created_from_communication',
                  'an enquiry records that it came from a conversation');

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.artist_integrations
  (artist_id, integration_type, provider, integration_key, configuration, is_enabled)
values
  ('a1111111-1111-4111-8111-111111111111', 'instagram', 'instagram_login',
   'vladimir-inbox', '{"instagram_user_id":"17841400000000011"}'::jsonb, true),
  ('a2222222-2222-4222-8222-222222222222', 'instagram', 'instagram_login',
   'kristina-inbox', '{"instagram_user_id":"17841400000000012"}'::jsonb, true),
  ('a1111111-1111-4111-8111-111111111111', 'whatsapp', 'meta_cloud_api',
   'vladimir-production', '{}'::jsonb, true);

-- Two unknown Instagram senders for Vladimir, one for Kristina, and one
-- WhatsApp conversation so the channel filter has something to exclude.
select public.record_communication_inbound_message(
  'a1111111-1111-4111-8111-111111111111', 'instagram', 'vladimir-inbox',
  '5550000000001', 'ig_mid_INBOX0000000001', '2026-08-18 09:00:00+00',
  'text', 'Hello, I would like a sleeve'
);
select public.record_communication_inbound_message(
  'a1111111-1111-4111-8111-111111111111', 'instagram', 'vladimir-inbox',
  '5550000000002', 'ig_mid_INBOX0000000002', '2026-08-18 09:05:00+00',
  'text', 'hey'
);
select public.record_communication_inbound_message(
  'a2222222-2222-4222-8222-222222222222', 'instagram', 'kristina-inbox',
  '5550000000003', 'ig_mid_INBOX0000000003', '2026-08-18 09:10:00+00',
  'text', 'Kristina enquiry'
);
select public.record_communication_inbound_message(
  'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'vladimir-production',
  '447700930001', 'wamid.INBOXSYNTHETIC01', '2026-08-18 09:15:00+00',
  'text', 'WhatsApp message'
);

insert into public.clients (id, full_name, email, phone) values
  ('a9111111-1111-4111-8111-111111111111', 'Existing Vladimir Client', 'inbox.v@example.test', '+44 7700 931111'),
  ('a9222222-2222-4222-8222-222222222222', 'Existing Kristina Client', 'inbox.k@example.test', '+44 7700 932222');

insert into public.enquiries
  (id, client_id, idempotency_key, intake_fingerprint, intake_state,
   submitted_full_name, submitted_email, privacy_notice_version,
   privacy_acknowledged_at, artist_id)
values
  ('b9111111-1111-4111-8111-111111111111', 'a9111111-1111-4111-8111-111111111111',
   'c9111111-1111-4111-8111-111111111111', repeat('a', 64), 'complete',
   'Existing Vladimir Client', 'inbox.v@example.test', '2026-07-29', now(),
   'a1111111-1111-4111-8111-111111111111'),
  ('b9222222-2222-4222-8222-222222222222', 'a9222222-2222-4222-8222-222222222222',
   'c9222222-2222-4222-8222-222222222222', repeat('b', 64), 'complete',
   'Existing Kristina Client', 'inbox.k@example.test', '2026-07-29', now(),
   'a2222222-2222-4222-8222-222222222222');

insert into auth.users (id, email) values
  ('d9111111-1111-4111-8111-111111111111', 'inbox.owner@example.test'),
  ('d9222222-2222-4222-8222-222222222222', 'inbox.manager@example.test'),
  ('d9333333-3333-4333-8333-333333333333', 'inbox.reader@example.test');
insert into public.profiles (id, email, role, is_active) values
  ('d9111111-1111-4111-8111-111111111111', 'inbox.owner@example.test', 'owner', true),
  ('d9222222-2222-4222-8222-222222222222', 'inbox.manager@example.test', 'booking_manager', true),
  ('d9333333-3333-4333-8333-333333333333', 'inbox.reader@example.test', 'read_only', true);
insert into public.artist_memberships
  (profile_id, artist_id, access_level, can_manage_sessions, can_manage_integrations, is_active)
values
  ('d9222222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111',
   'manager', true, true, true),
  ('d9333333-3333-4333-8333-333333333333', 'a1111111-1111-4111-8111-111111111111',
   'read_only', false, false, true);

create function pg_temp.inbox_claims(p text) returns void language sql as
  $$select set_config('request.jwt.claims', p, true)::void$$;
grant execute on function pg_temp.inbox_claims(text) to authenticated;

-- Resolves a synthetic conversation id by participant. SECURITY DEFINER so a
-- role-switched test session can still address a conversation it is about to
-- be refused access to.
create function pg_temp.conversation_for(p_contact text) returns uuid
  language sql stable security definer as
  $$select id from public.communication_conversations where external_contact_id = p_contact$$;
grant execute on function pg_temp.conversation_for(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Inbox projection is artist scoped and filterable
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.inbox_claims('{"sub":"d9222222-2222-4222-8222-222222222222","role":"authenticated"}');

select is(
  (select count(*)::int from public.list_communication_conversations()),
  3,
  'the All view shows only the conversations this manager artist owns'
);
select is(
  (select count(*)::int from public.list_communication_conversations('instagram')),
  2,
  'the Instagram filter narrows to that channel'
);
select is(
  (select count(*)::int from public.list_communication_conversations('whatsapp')),
  1,
  'the WhatsApp filter narrows to that channel'
);
select is(
  (select count(*)::int from public.list_communication_conversations(null, 'unmatched')),
  3,
  'every inbound conversation starts unmatched'
);
select ok(
  (select bool_and(has_unread) from public.list_communication_conversations()),
  'a conversation with a newer inbound than the operator read mark is unread'
);
select is(
  (select latest_preview from public.list_communication_conversations('instagram', null, 1)),
  'hey',
  'the list carries a short preview rather than the message history'
);
select throws_ok(
  $$select * from public.list_communication_conversations(null, null, 500)$$,
  '22023', null,
  'the inbox refuses an unbounded page size'
);

-- ---------------------------------------------------------------------------
-- Linking is conservative and artist bound
-- ---------------------------------------------------------------------------

select is(
  public.link_communication_conversation_client(
    pg_temp.conversation_for('5550000000001'),
    'a9111111-1111-4111-8111-111111111111'
  ) ->> 'link_state',
  'linked',
  'an operator can link an unmatched conversation to an existing client'
);
select is(
  (select count(*)::int from public.list_communication_conversations(null, 'linked')),
  1,
  'the linked filter reflects the operator decision'
);

-- The client exists and the operator manages it elsewhere, but it does not
-- belong to this conversation's artist scope.
select throws_ok(
  $$select public.link_communication_conversation_client(
      pg_temp.conversation_for('5550000000002'),
      'a9222222-2222-4222-8222-222222222222')$$,
  '42501', null,
  'a Kristina client cannot be attached to a Vladimir conversation'
);

-- A conversation the manager cannot reach at all is invisible and unlinkable.
select throws_ok(
  $$select public.link_communication_conversation_client(
      pg_temp.conversation_for('5550000000003'),
      'a9111111-1111-4111-8111-111111111111')$$,
  '42501', null,
  'a Vladimir manager cannot touch a Kristina conversation'
);

select is(
  public.create_client_from_communication(
    pg_temp.conversation_for('5550000000002'),
    'Instagram Walk-in', null, null, null
  ) ->> 'link_state',
  'linked',
  'an operator can create a client from an unmatched conversation'
);
-- A direct message carries no verified email or phone, so nothing is invented.
select is(
  (select coalesce(email, 'NULL') || ':' || coalesce(phone, 'NULL')
   from public.clients
   where full_name = 'Instagram Walk-in'),
  'NULL:NULL',
  'no contact detail is fabricated from the provider'
);

reset role;

-- ---------------------------------------------------------------------------
-- Promoting a conversation to a real enquiry
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.inbox_claims('{"sub":"d9222222-2222-4222-8222-222222222222","role":"authenticated"}');

select is(
  (public.create_enquiry_from_communication(
    pg_temp.conversation_for('5550000000001'),
    'e9111111-1111-4111-8111-111111111111',
    jsonb_build_object(
      'full_name', 'Existing Vladimir Client',
      'email', 'inbox.v@example.test',
      'phone', '+44 7700 931111',
      'preferred_contact', 'Instagram'
    ),
    jsonb_build_object('project_type', 'Sleeve', 'idea', 'Full sleeve from Instagram'),
    true
  ) ->> 'created_from_communication')::boolean,
  true,
  'an operator can promote a real conversation to a CRM enquiry'
);

select is(
  (select communication_channel::text from public.enquiries
   where communication_conversation_id = pg_temp.conversation_for('5550000000001')),
  'instagram',
  'the enquiry records that it came from Instagram'
);
select ok(
  (select created_from_communication from public.enquiries
   where communication_conversation_id = pg_temp.conversation_for('5550000000001')),
  'the enquiry is marked as communication-sourced'
);
select is(
  (select enquiry_id is not null from public.communication_conversations
   where id = pg_temp.conversation_for('5550000000001')),
  true,
  'the conversation now points back at the enquiry it produced'
);

-- Intake matches clients on email and phone. Resolving a different person than
-- the conversation is linked to is an identity conflict for a human, not
-- something to silently repoint.
select throws_ok(
  $$select public.create_enquiry_from_communication(
      pg_temp.conversation_for('5550000000001'),
      'e9222222-2222-4222-8222-222222222222',
      jsonb_build_object('full_name', 'Someone Else',
                         'email', 'someone.else@example.test'),
      jsonb_build_object('project_type', 'Sleeve'),
      true)$$,
  '23514', null,
  'enquiry details matching a different client are refused rather than repointed'
);

reset role;

-- ---------------------------------------------------------------------------
-- Read-only sessions observe but never mutate
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.inbox_claims('{"sub":"d9333333-3333-4333-8333-333333333333","role":"authenticated"}');

select ok(
  (select count(*) from public.list_communication_conversations()) > 0,
  'a read-only session can still see the inbox'
);
select throws_ok(
  $$select public.link_communication_conversation_client(
      pg_temp.conversation_for('5550000000002'),
      'a9111111-1111-4111-8111-111111111111')$$,
  '42501', null,
  'a read-only session cannot link a client'
);
select throws_ok(
  $$select public.set_communication_conversation_state(
      pg_temp.conversation_for('5550000000002'), 'archived')$$,
  '42501', null,
  'a read-only session cannot archive a conversation'
);
reset role;

-- ---------------------------------------------------------------------------
-- Archiving stops outbound queueing without deleting history
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.inbox_claims('{"sub":"d9222222-2222-4222-8222-222222222222","role":"authenticated"}');

select is(
  public.set_communication_conversation_state(
    pg_temp.conversation_for('5550000000002'), 'archived'
  ) ->> 'state',
  'archived',
  'an operator can archive a spam conversation'
);
select throws_ok(
  $$select public.queue_communication_message(
      pg_temp.conversation_for('5550000000002'), 'reply attempt',
      'f9111111-1111-4111-8111-111111111111')$$,
  '23514', null,
  'an archived conversation refuses new outbound messages'
);
select ok(
  (select count(*) from public.communication_messages
   where conversation_id = pg_temp.conversation_for('5550000000002')) > 0,
  'archiving preserves the message history'
);
reset role;

select * from finish();
rollback;
