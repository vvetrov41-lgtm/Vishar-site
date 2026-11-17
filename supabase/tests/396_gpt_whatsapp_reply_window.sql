-- 396_gpt_whatsapp_reply_window.sql
--
-- Migration 20261117100000: public.gpt_send_communication_reply now carries
-- the production body, which routes a WhatsApp conversation through
-- public.queue_whatsapp_message and its 24-hour customer-service window check.
--
-- Two scenarios through the real GPT surface, as the profile-bound unified GPT:
--   1. the client wrote 1 hour ago: the reply is queued once;
--   2. the client last wrote 25 hours ago: the reply is refused with 23514
--      before any message or outbox row exists.
-- Instagram replies are unaffected by the WhatsApp window.
--
-- Nothing is sent: a queued reply is only a communication_messages row plus an
-- integration_outbox row inside this rolled-back transaction. No Worker or
-- provider runs against this database.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Definition
-- ---------------------------------------------------------------------------

select ok(
  pg_get_functiondef('public.gpt_send_communication_reply(uuid,text,uuid)'::regprocedure)
    ~ 'channel = ''whatsapp''::public.communication_channel then\s+return public\.queue_whatsapp_message\(',
  'the GPT reply routes WhatsApp conversations through the window-guarded queue'
);
select ok(
  pg_get_functiondef('public.queue_whatsapp_message(uuid,text,uuid)'::regprocedure)
    ~ 'v_last_inbound_at < now\(\) - interval ''24 hours''',
  'the WhatsApp queue refuses free-form text outside the 24-hour window'
);
select ok(
  has_function_privilege('authenticated', 'public.gpt_send_communication_reply(uuid,text,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.gpt_send_communication_reply(uuid,text,uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.gpt_send_communication_reply(uuid,text,uuid)', 'EXECUTE'),
  'the reply grant is unchanged: authenticated GPT sessions only'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.artist_integrations
  (artist_id, integration_type, provider, integration_key, configuration, is_enabled)
values
  ('a1111111-1111-4111-8111-111111111111', 'whatsapp', 'meta_cloud_api',
   'vladimir-production', '{}'::jsonb, true),
  ('a1111111-1111-4111-8111-111111111111', 'instagram', 'instagram_login',
   'vladimir-window-test', '{"instagram_user_id":"17841400000000396"}'::jsonb, true);

-- Window open: the client's last WhatsApp message arrived 1 hour ago.
select public.record_communication_inbound_message(
  'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'vladimir-production',
  '447700939601', 'wamid.WINDOW396OPEN01', now() - interval '1 hour',
  'text', 'Is Saturday still fine?'
);
-- Window closed: the client's last WhatsApp message arrived 25 hours ago.
select public.record_communication_inbound_message(
  'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'vladimir-production',
  '447700939602', 'wamid.WINDOW396SHUT01', now() - interval '25 hours',
  'text', 'Thanks, see you then'
);
-- Instagram, last message 25 hours ago: no WhatsApp window applies.
select public.record_communication_inbound_message(
  'a1111111-1111-4111-8111-111111111111', 'instagram', 'vladimir-window-test',
  '5560000003961', 'ig_mid_WINDOW396IG01', now() - interval '25 hours',
  'text', 'Instagram side'
);

insert into auth.users (id, email) values
  ('f3961111-1111-4111-8111-111111111111', 'gpt-window-operator@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('f3961111-1111-4111-8111-111111111111', 'gpt-window-operator@example.test',
   'GPT Window Operator', 'booking_manager', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('f3961111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'manager', false, false, true, false, true);

update crm_private.gpt_action_clients
set oauth_client_id = 'oauth-gpt-window-test',
    can_manage_communications = true,
    can_manage_crm = true,
    is_active = true
where integration_key = 'vishar-unified-gpt';

create function pg_temp.window_claims(p text) returns void language sql as
  $$select set_config('request.jwt.claims', p, true)::void$$;
grant execute on function pg_temp.window_claims(text) to authenticated;

create function pg_temp.window_conversation(p_contact text) returns uuid
  language sql stable security definer as
  $$select id from public.communication_conversations where external_contact_id = p_contact$$;
grant execute on function pg_temp.window_conversation(text) to authenticated;

-- Counts are read with definer rights so the role-switched session sees the
-- rows the refused call must not have created.
create function pg_temp.outbound_count(p_contact text) returns integer
  language sql stable security definer as
  $$select count(*)::integer
    from public.communication_messages m
    join public.communication_conversations c on c.id = m.conversation_id
    where c.external_contact_id = p_contact and m.direction = 'outbound'$$;
grant execute on function pg_temp.outbound_count(text) to authenticated;

create function pg_temp.outbox_count(p_contact text) returns integer
  language sql stable security definer as
  $$select count(*)::integer
    from public.integration_outbox o
    join public.communication_messages m on m.id = o.communication_message_id
    join public.communication_conversations c on c.id = m.conversation_id
    where c.external_contact_id = p_contact$$;
grant execute on function pg_temp.outbox_count(text) to authenticated;

select ok(
  (select last_inbound_at between now() - interval '61 minutes' and now() - interval '59 minutes'
   from public.communication_conversations where external_contact_id = '447700939601'),
  'fixture: the open conversation last heard from the client 1 hour ago'
);
select ok(
  (select last_inbound_at < now() - interval '24 hours'
   from public.communication_conversations where external_contact_id = '447700939602'),
  'fixture: the closed conversation last heard from the client 25 hours ago'
);

set local role authenticated;
select pg_temp.window_claims(
  '{"sub":"f3961111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-gpt-window-test"}'
);
select is(
  public.gpt_artist_context('a1111111-1111-4111-8111-111111111111') ->> 'active_artist_id',
  'a1111111-1111-4111-8111-111111111111',
  'the GPT works in Vladimir''s artist context'
);

-- ---------------------------------------------------------------------------
-- Scenario 1: reply inside the 24-hour window
-- ---------------------------------------------------------------------------

select is(
  public.gpt_send_communication_reply(
    pg_temp.window_conversation('447700939601'),
    'Yes, Saturday at 11 is still fine.',
    'f3962222-2222-4222-8222-222222222201'
  ) ->> 'status',
  'queued',
  'inside the window the reply is queued'
);
select is(pg_temp.outbound_count('447700939601'), 1, 'inside the window exactly one outbound message exists');
select is(pg_temp.outbox_count('447700939601'), 1, 'inside the window exactly one outbox row exists for the drain');
select is(
  (public.gpt_send_communication_reply(
     pg_temp.window_conversation('447700939601'),
     'Yes, Saturday at 11 is still fine.',
     'f3962222-2222-4222-8222-222222222201') ->> 'replayed')::boolean,
  true,
  'a repeated request id replays instead of queueing a second reply'
);
select is(pg_temp.outbound_count('447700939601'), 1, 'the replay created no second message');

-- ---------------------------------------------------------------------------
-- Scenario 2: reply after the 24-hour window closed
-- ---------------------------------------------------------------------------

select throws_ok(
  format(
    $$select public.gpt_send_communication_reply(%L::uuid, 'See you on Saturday!', 'f3962222-2222-4222-8222-222222222202')$$,
    pg_temp.window_conversation('447700939602')
  ),
  '23514',
  'WhatsApp free-form window is closed for this client',
  'after the window closed the reply is refused'
);
select is(pg_temp.outbound_count('447700939602'), 0, 'the refused reply created no message');
select is(pg_temp.outbox_count('447700939602'), 0, 'the refused reply created no outbox row');

-- The same refusal holds through the WhatsApp-specific GPT operation.
select throws_ok(
  format(
    $$select public.gpt_send_whatsapp_message(%L::uuid, 'See you on Saturday!', 'f3962222-2222-4222-8222-222222222203')$$,
    pg_temp.window_conversation('447700939602')
  ),
  '23514',
  'WhatsApp free-form window is closed for this client',
  'the WhatsApp-specific GPT operation refuses the same closed window'
);
select is(pg_temp.outbound_count('447700939602'), 0, 'still no message after the second refused path');

-- ---------------------------------------------------------------------------
-- Control: the WhatsApp window does not apply to Instagram
-- ---------------------------------------------------------------------------

select is(
  public.gpt_send_communication_reply(
    pg_temp.window_conversation('5560000003961'),
    'Thanks for the message.',
    'f3962222-2222-4222-8222-222222222204'
  ) ->> 'status',
  'queued',
  'an Instagram reply is not blocked by the WhatsApp window'
);

reset role;
select * from finish();
rollback;
