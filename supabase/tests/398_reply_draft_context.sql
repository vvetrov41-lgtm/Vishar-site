-- 398_reply_draft_context.sql
--
-- Migration 20261119100000: public.get_reply_draft_context returns the
-- artist's own past (client message, reply) pairs as voice examples for a
-- reply draft. It must never return a personal (not-CRM) conversation,
-- another artist's replies, automation or canned messages, and it masks
-- contact details. Nothing is sent or stored.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Definition and grants
-- ---------------------------------------------------------------------------

select ok(
  has_function_privilege('authenticated', 'public.get_reply_draft_context(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_reply_draft_context(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.get_reply_draft_context(uuid)', 'EXECUTE'),
  'the draft context is for signed-in operators only'
);
select ok(
  not has_function_privilege('authenticated', 'crm_private.mask_reply_draft_text(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'crm_private.mask_reply_draft_text(text)', 'EXECUTE'),
  'the masking helper is private'
);
select is(
  crm_private.mask_reply_draft_text('Call +44 7700 900398, mail me@example.test, sort code 30-14-71, see https://example.test/x'),
  'Call [number], mail [email], sort code [number], see [link]',
  'phones, emails, sort codes and links are masked'
);
select is(
  crm_private.mask_reply_draft_text('I can do 14 - 15 November or 28-29, Sort code: 30 14 71, call (020) 7946 0958'),
  'I can do 14 - 15 November or 28-29, Sort code: [number], call [number]',
  'date ranges survive; spaced sort codes after the label and bracketed phones are masked'
);
select is(
  crm_private.mask_reply_draft_text('£140 per hour or £980 for a full day (7 hours), 14 and 15 November'),
  '£140 per hour or £980 for a full day (7 hours), 14 and 15 November',
  'rates, hours and dates stay readable'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('f3981111-1111-4111-8111-111111111111', 'draft-operator@example.test'),
  ('f3981111-1111-4111-8111-111111111112', 'draft-other@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('f3981111-1111-4111-8111-111111111111', 'draft-operator@example.test', 'Draft Operator', 'booking_manager', true),
  ('f3981111-1111-4111-8111-111111111112', 'draft-other@example.test', 'Draft Other', 'booking_manager', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level, can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('f3981111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
   'artist', false, false, true, false, true),
  ('f3981111-1111-4111-8111-111111111112', 'a2222222-2222-4222-8222-222222222222',
   'artist', false, false, true, false, true);

insert into public.clients (id, workspace_id, full_name, email)
select 'f3982222-2222-4222-8222-222222222201', a.workspace_id, 'Kamal Draftson', 'kamal-draft@example.test'
from public.artists a where a.id = 'a1111111-1111-4111-8111-111111111111';

-- c01 target (Vladimir, WhatsApp, client wrote 1 hour ago)
-- c02 example source (Vladimir)
-- c03..c05 a canned reply sent three times (Vladimir)
-- c06 personal chat marked not-CRM (Vladimir)
-- c07 Kristina's conversation
-- c08 personal chat marked not-CRM as a draft target
insert into public.communication_conversations (
  id, artist_id, channel, integration_key, external_contact_id, client_id, link_state, state,
  last_message_at, last_inbound_at, not_crm_at
) values
  ('f3983333-0000-4000-8000-000000000001', 'a1111111-1111-4111-8111-111111111111', 'whatsapp',
   'whatsapp_main', '447700939801', 'f3982222-2222-4222-8222-222222222201', 'linked', 'open',
   now() - interval '1 hour', now() - interval '1 hour', null),
  ('f3983333-0000-4000-8000-000000000002', 'a1111111-1111-4111-8111-111111111111', 'whatsapp',
   'whatsapp_main', '447700939802', null, 'unmatched', 'open', now(), now(), null),
  ('f3983333-0000-4000-8000-000000000003', 'a1111111-1111-4111-8111-111111111111', 'instagram',
   'ig_main', '5560000039803', null, 'unmatched', 'open', now(), now(), null),
  ('f3983333-0000-4000-8000-000000000004', 'a1111111-1111-4111-8111-111111111111', 'instagram',
   'ig_main', '5560000039804', null, 'unmatched', 'open', now(), now(), null),
  ('f3983333-0000-4000-8000-000000000005', 'a1111111-1111-4111-8111-111111111111', 'instagram',
   'ig_main', '5560000039805', null, 'unmatched', 'open', now(), now(), null),
  ('f3983333-0000-4000-8000-000000000006', 'a1111111-1111-4111-8111-111111111111', 'whatsapp',
   'whatsapp_main', '447700939806', null, 'unmatched', 'open', now(), now(), now()),
  ('f3983333-0000-4000-8000-000000000007', 'a2222222-2222-4222-8222-222222222222', 'instagram',
   'ig_kristina', '5560000039807', null, 'unmatched', 'open', now(), now(), null),
  ('f3983333-0000-4000-8000-000000000008', 'a1111111-1111-4111-8111-111111111111', 'whatsapp',
   'whatsapp_main', '447700939808', null, 'unmatched', 'open', now(), now(), now());

create function pg_temp.msg(p_conv text, p_artist text, p_channel text, p_direction text,
  p_origin text, p_status text, p_body text, p_minutes integer)
returns void language sql as $$
  insert into public.communication_messages (
    conversation_id, artist_id, channel, direction, origin, status, body, created_at
  ) values (
    ('f3983333-0000-4000-8000-0000000000' || p_conv)::uuid, p_artist::uuid,
    p_channel::public.communication_channel, p_direction::public.communication_direction,
    p_origin::public.communication_origin, p_status::public.communication_status,
    p_body, now() - make_interval(mins => p_minutes)
  );
$$;

select pg_temp.msg('01', 'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'inbound', 'contact', 'received',
  'Hi, how much would a forearm piece be? My number is +44 7700 900398', 60);

select pg_temp.msg('02', 'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'inbound', 'contact', 'received',
  'Hello, could you tell me your prices for a half sleeve?', 300);
select pg_temp.msg('02', 'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'outbound', 'provider_app', 'read',
  'Hey mate! I charge £140 per hour or £980 for a full day 🙌🏻', 290);
select pg_temp.msg('02', 'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'inbound', 'contact', 'received',
  'Great, thank you so much for the quick answer', 280);
select pg_temp.msg('02', 'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'outbound', 'automation', 'read',
  'Automated booking card text', 270);

-- A late webhook: this client message was written just before the reply
-- (provider time) but ingested after it. Pairing must follow provider time.
insert into public.communication_messages (
  conversation_id, artist_id, channel, direction, origin, status, body, created_at, provider_timestamp
) values
  ('f3983333-0000-4000-8000-000000000002', 'a1111111-1111-4111-8111-111111111111', 'whatsapp',
   'inbound', 'contact', 'received', 'Ingested late, written just before the reply', now() - interval '250 minutes',
   now() - interval '295 minutes');
select pg_temp.msg(c, 'a1111111-1111-4111-8111-111111111111', 'instagram', 'inbound', 'contact', 'received',
  'Hi there, I love your realism work', 200)
  from unnest(array['03', '04', '05']) c;
select pg_temp.msg(c, 'a1111111-1111-4111-8111-111111111111', 'instagram', 'outbound', 'provider_app', 'read',
  'Hi! Thanks for your message. Please fill in the enquiry form.', 199)
  from unnest(array['03', '04', '05']) c;

select pg_temp.msg('06', 'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'inbound', 'contact', 'received',
  'Are we still on for dinner tonight?', 100);
select pg_temp.msg('06', 'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'outbound', 'provider_app', 'read',
  'Personal reply that must never be an example', 99);

select pg_temp.msg('07', 'a2222222-2222-4222-8222-222222222222', 'instagram', 'inbound', 'contact', 'received',
  'Hi Kristina, what are your rates for fine line?', 100);
select pg_temp.msg('07', 'a2222222-2222-4222-8222-222222222222', 'instagram', 'outbound', 'provider_app', 'read',
  'Kristina reply that is not Vladimir''s voice', 99);

-- ---------------------------------------------------------------------------
-- As Vladimir's operator
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"f3981111-1111-4111-8111-111111111111","role":"authenticated"}', true);

create temporary table ctx on commit drop as
  select public.get_reply_draft_context('f3983333-0000-4000-8000-000000000001') as v;

select is((select v ->> 'channel' from ctx), 'whatsapp', 'the target channel is returned');
select is((select v ->> 'client_first_name' from ctx), 'Kamal', 'only the client''s first name is returned');
select is((select (v ->> 'whatsapp_window_open')::boolean from ctx), true, 'the WhatsApp window is open');
select ok((select v ? 'rates' and not (v -> 'rates') ? 'standard_session_deposit' from ctx),
  'rates are returned without the deposit');
select is((select jsonb_array_length(v -> 'messages') from ctx), 1, 'the target conversation has one text');
select is((select v -> 'messages' -> 0 ->> 'text' from ctx),
  'Hi, how much would a forearm piece be? My number is [number]',
  'the target conversation text is masked');

select is((select jsonb_array_length(v -> 'examples') from ctx), 1, 'exactly one voice example survives the filters');
select is((select v -> 'examples' -> 0 ->> 'reply' from ctx),
  'Hey mate! I charge £140 per hour or £980 for a full day 🙌🏻',
  'the example is the artist''s own reply from a client conversation');
select is((select v -> 'examples' -> 0 ->> 'client' from ctx),
  'Ingested late, written just before the reply',
  'the example pairs the reply with the client message just before it in provider time');
select ok((select (v -> 'examples')::text !~ '(Personal reply|Kristina reply|Automated booking|Please fill in the enquiry form)' from ctx),
  'no personal, other-artist, automated or canned reply is an example');

select throws_ok(
  $$select public.get_reply_draft_context('f3983333-0000-4000-8000-000000000008')$$,
  '42501', null, 'a personal (not-CRM) conversation is never a draft target'
);

-- ---------------------------------------------------------------------------
-- As an operator of another artist
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims',
  '{"sub":"f3981111-1111-4111-8111-111111111112","role":"authenticated"}', true);
select throws_ok(
  $$select public.get_reply_draft_context('f3983333-0000-4000-8000-000000000001')$$,
  '42501', null, 'an operator without access to the artist cannot read the context'
);

select * from finish();
rollback;
