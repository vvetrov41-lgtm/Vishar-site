-- 400_review_request_followups.sql
-- Google review request, phase 2b: the client's reply to the healing
-- question, the artist's "ask for a review" send and "close". No provider
-- call is made. Every row is synthetic and rolled back.
begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table t_fu_artist as
select a.id, a.workspace_id from public.artists a
join crm_private.artist_state st on st.artist_id = a.id and st.is_active
where a.slug = 'vladimir';
grant select on t_fu_artist to public;

insert into auth.users (id, email) values
  ('e9900000-0000-4000-8000-0000000000a1', 'fu-manager@example.test'),
  ('e9900000-0000-4000-8000-0000000000a3', 'fu-read-only@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('e9900000-0000-4000-8000-0000000000a1', 'fu-manager@example.test', 'FU Manager', 'booking_manager', true),
  ('e9900000-0000-4000-8000-0000000000a3', 'fu-read-only@example.test', 'FU Read', 'booking_manager', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level, can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('e9900000-0000-4000-8000-0000000000a1', (select id from t_fu_artist),
   'manager', false, false, true, false, true),
  ('e9900000-0000-4000-8000-0000000000a3', (select id from t_fu_artist),
   'read_only', false, false, false, false, true);

create function pg_temp.as_profile(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    jsonb_build_object('sub', p, 'role', 'authenticated')::text, true)::void;
$$;
grant execute on function pg_temp.as_profile(uuid) to public;

create function pg_temp.days_ago(p int) returns timestamptz language sql stable as $$
  select date_trunc('hour', now()) - make_interval(days => p);
$$;
grant execute on function pg_temp.days_ago(int) to public;

-- ---------------------------------------------------------------- fixtures
-- 1 Alice: healed, WhatsApp conversation. 2 Ben: visit 10 days ago.
-- 3 Hal: healed, no WhatsApp conversation.
insert into public.clients (id, full_name, email, phone, workspace_id)
select v.id, v.name, v.email, v.phone, (select workspace_id from t_fu_artist) from (values
  ('e99c0000-0000-4000-8000-000000000001'::uuid, 'Alice Healed', 'fu-a@example.test', '+447700900801'),
  ('e99c0000-0000-4000-8000-000000000002', 'Ben Recent', 'fu-b@example.test', '+447700900802'),
  ('e99c0000-0000-4000-8000-000000000003', 'Hal Nochat', 'fu-h@example.test', '+447700900803')
) v(id, name, email, phone);

insert into public.projects (id, client_id, artist_id, status, title, deposit_status, currency)
select ('e99d0000-0000-4000-8000-00000000000' || v.n)::uuid,
       ('e99c0000-0000-4000-8000-00000000000' || v.n)::uuid,
       (select id from t_fu_artist), 'active', 'FU project ' || v.n, 'not_required', 'GBP'
from (values ('1'), ('2'), ('3')) v(n);

insert into public.sessions
  (id, artist_id, client_id, project_id, appointment_type, status, start_at, end_at,
   duration_hours, currency)
select ('e9950000-0000-4000-8000-00000000000' || v.n)::uuid, (select id from t_fu_artist),
       ('e99c0000-0000-4000-8000-00000000000' || v.n)::uuid,
       ('e99d0000-0000-4000-8000-00000000000' || v.n)::uuid,
       'tattoo_session', 'completed', pg_temp.days_ago(v.d),
       pg_temp.days_ago(v.d) + interval '4 hours', 4, 'GBP'
from (values ('1', 40), ('2', 10), ('3', 35)) v(n, d);

insert into public.visit_outcomes
  (session_id, artist_id, client_id, appointment_type, state, outcome, work_result,
   worked_minutes, confirmed_at)
select ('e9950000-0000-4000-8000-00000000000' || v.n)::uuid, (select id from t_fu_artist),
       ('e99c0000-0000-4000-8000-00000000000' || v.n)::uuid,
       'tattoo_session', 'confirmed', 'attended', 'work_complete', 240,
       pg_temp.days_ago(v.d) + interval '5 hours'
from (values ('1', 40), ('2', 10), ('3', 35)) v(n, d);

insert into public.artist_integrations(
  artist_id, integration_type, provider, integration_key, external_account_label, is_enabled)
select a.id, 'whatsapp', 'meta_cloud_api', 'vladimir-production', 'Synthetic healing route', true
from t_fu_artist a
where not exists (
  select 1 from public.artist_integrations i where i.artist_id = a.id
    and i.integration_type = 'whatsapp' and i.provider = 'meta_cloud_api'
    and i.integration_key = 'vladimir-production');

insert into public.communication_conversations(
  id, artist_id, channel, integration_key, external_contact_id, client_id, link_state, state)
select 'e99e0000-0000-4000-8000-000000000001', id, 'whatsapp', 'vladimir-production',
       '447700900801', 'e99c0000-0000-4000-8000-000000000001', 'linked', 'open'
from t_fu_artist;

-- Synthetic Meta approval, as the maintenance poller would record it.
insert into crm_private.lifecycle_whatsapp_template_candidates (
  artist_id, purpose, template_name, template_language, approval_status,
  provider_template_id, verified_at)
select id, 'healing_check', 'vishar_healing_check_v1', 'en_GB', 'APPROVED', '2100052927362795', now()
from t_fu_artist
on conflict (artist_id, purpose) do update set
  template_name = excluded.template_name, template_language = excluded.template_language,
  approval_status = excluded.approval_status,
  provider_template_id = excluded.provider_template_id, verified_at = excluded.verified_at;


-- Ask Alice and Hal (Hal gets a conversation too).
insert into public.communication_conversations(
  id, artist_id, channel, integration_key, external_contact_id, client_id, link_state, state)
select 'e99e0000-0000-4000-8000-000000000003', id, 'whatsapp', 'vladimir-production',
       '447700900803', 'e99c0000-0000-4000-8000-000000000003', 'linked', 'open'
from t_fu_artist;

select pg_temp.as_profile('e9900000-0000-4000-8000-0000000000a1');
create temporary table t_fu_req as
select (public.send_healing_question((select id from t_fu_artist),
          'e9950000-0000-4000-8000-000000000001', 'e99a0000-0000-4000-8000-000000000001') ->> 'id')::uuid as alice,
       (public.send_healing_question((select id from t_fu_artist),
          'e9950000-0000-4000-8000-000000000003', 'e99a0000-0000-4000-8000-000000000003') ->> 'id')::uuid as hal;
grant select on t_fu_req to public;

create function pg_temp.item(p uuid) returns jsonb language sql as $$
  select x from jsonb_array_elements(public.list_review_followups((select id from t_fu_artist)) -> 'items') x
  where x ->> 'review_request_id' = p::text;
$$;
grant execute on function pg_temp.item(uuid) to public;

select is(pg_temp.item((select alice from t_fu_req)) ->> 'status', 'awaiting_reply',
  'after the question the request waits for a reply');
select ok(pg_temp.item((select alice from t_fu_req)) ->> 'draft_message' is null,
  'no review draft before a reply');

select throws_ok(
  $$select public.ask_for_review((select id from t_fu_artist), (select alice from t_fu_req),
      'e99a0000-0000-4000-8000-000000000010', 'Thanks!')$$,
  '55000', 'the client has not replied to the healing question', 'no review request before a reply');

-- Alice replies two days later (inside the 24-hour window now).
insert into public.communication_messages(
  id, conversation_id, artist_id, channel, direction, origin, status, message_type, body, created_at)
select 'e99f0000-0000-4000-8000-000000000001', 'e99e0000-0000-4000-8000-000000000001', id,
       'whatsapp', 'inbound', 'contact', 'received', 'text', 'Healed beautifully, thank you!', clock_timestamp()
from t_fu_artist;
update public.communication_conversations set last_inbound_at = now()
where id = 'e99e0000-0000-4000-8000-000000000001';

select is(pg_temp.item((select alice from t_fu_req)) ->> 'status', 'replied', 'a reply is shown');
select is(pg_temp.item((select alice from t_fu_req)) ->> 'reply_text', 'Healed beautifully, thank you!',
  'with its text');
select is(pg_temp.item((select alice from t_fu_req)) ->> 'draft_message',
  'So glad to hear it healed well! If you have a minute, a Google review would mean a lot to me: '
  || (select google_review_url from crm_private.artist_review_settings where artist_id = (select id from t_fu_artist)),
  'and the review draft with the artist''s own link');

-- Refusals.
select pg_temp.as_profile('e9900000-0000-4000-8000-0000000000a3');
select throws_ok(
  $$select public.ask_for_review((select id from t_fu_artist), (select alice from t_fu_req),
      'e99a0000-0000-4000-8000-000000000011', 'Thanks!')$$,
  '42501', null, 'a read-only member cannot ask for a review');
select pg_temp.as_profile('e9900000-0000-4000-8000-0000000000a1');
select throws_ok(
  $$select public.ask_for_review((select id from t_fu_artist), (select alice from t_fu_req),
      'e99a0000-0000-4000-8000-000000000012', '   ')$$,
  '22023', null, 'an empty review message is refused');
select throws_ok(
  $$select public.ask_for_review('a2222222-2222-4222-8222-222222222222', (select alice from t_fu_req),
      'e99a0000-0000-4000-8000-000000000013', 'Thanks!')$$,
  '42501', null, 'another artist cannot act on the request');
select throws_ok(
  $$select public.ask_for_review((select id from t_fu_artist), (select alice from t_fu_req),
      'e99a0000-0000-4000-8000-000000000001', 'Thanks!')$$,
  '22023', null, 'the healing operation id cannot be reused');

-- Send.
create temporary table t_fu_sent as
select public.ask_for_review((select id from t_fu_artist), (select alice from t_fu_req),
  'e99a0000-0000-4000-8000-000000000020', '  Lovely! A Google review would mean a lot: https://g.page/r/x/review  ') as r;
grant select on t_fu_sent to public;
select is((select r ->> 'state' from t_fu_sent), 'review_asked', 'the request becomes review_asked');
select is((select r ->> 'reply_message_id' from t_fu_sent), 'e99f0000-0000-4000-8000-000000000001',
  'the reply is recorded');
select results_eq(
  $$select m.direction::text, m.message_type, m.body, m.status::text from public.communication_messages m
    where m.id = (select (r ->> 'review_message_id')::uuid from t_fu_sent)$$,
  $$values ('outbound', 'text', 'Lovely! A Google review would mean a lot: https://g.page/r/x/review', 'queued')$$,
  'one queued free-form message with the artist''s text');
select is(public.ask_for_review((select id from t_fu_artist), (select alice from t_fu_req),
  'e99a0000-0000-4000-8000-000000000020', 'other text'), (select r from t_fu_sent),
  'a retry returns the recorded result');
select is((select count(*)::int from public.communication_messages
           where conversation_id = 'e99e0000-0000-4000-8000-000000000001' and message_type = 'text'
             and direction = 'outbound'), 1, 'and sends nothing more');
select throws_ok(
  $$select public.ask_for_review((select id from t_fu_artist), (select alice from t_fu_req),
      'e99a0000-0000-4000-8000-000000000021', 'Again')$$,
  '55000', 'this review request is already decided', 'one review request per healing question');
select ok(pg_temp.item((select alice from t_fu_req)) is null, 'the asked request leaves the follow-ups');

-- Hal replied five days ago: the WhatsApp window has closed.
insert into public.communication_messages(
  id, conversation_id, artist_id, channel, direction, origin, status, message_type, body, created_at)
select 'e99f0000-0000-4000-8000-000000000003', 'e99e0000-0000-4000-8000-000000000003', id,
       'whatsapp', 'inbound', 'contact', 'received', 'text', 'Bit itchy still', clock_timestamp()
from t_fu_artist;
update public.communication_conversations set last_inbound_at = now() - interval '5 days'
where id = 'e99e0000-0000-4000-8000-000000000003';
select throws_ok(
  $$select public.ask_for_review((select id from t_fu_artist), (select hal from t_fu_req),
      'e99a0000-0000-4000-8000-000000000030', 'Thanks!')$$,
  '23514', null, 'outside the 24-hour window the free-form review message is refused');
select is((select state from public.review_requests where id = (select hal from t_fu_req)), 'healing_asked',
  'and the request is unchanged');

select is(public.close_review_request((select id from t_fu_artist), (select hal from t_fu_req),
  'e99a0000-0000-4000-8000-000000000031') ->> 'state', 'closed', 'the artist can close it instead');
select is((select reply_message_id from public.review_requests where id = (select hal from t_fu_req)),
  'e99f0000-0000-4000-8000-000000000003'::uuid, 'closing records the reply');
select throws_ok(
  $$select public.close_review_request((select id from t_fu_artist), (select hal from t_fu_req),
      'e99a0000-0000-4000-8000-000000000032')$$,
  '55000', 'this review request is already decided', 'a closed request cannot be decided again');

-- Silent expiry: a question with no reply for over 21 days drops off.
update public.review_requests set healing_asked_at = now() - interval '22 days'
where id = (select hal from t_fu_req);
update public.review_requests set state = 'healing_asked', closed_at = null
where id = (select hal from t_fu_req);
delete from public.communication_messages where id = 'e99f0000-0000-4000-8000-000000000003';
select ok(pg_temp.item((select hal from t_fu_req)) is null, 'no reply within 21 days: the card closes silently');

-- ------------------------------------------------------------- privileges
select ok(has_function_privilege('authenticated', 'public.list_review_followups(uuid)', 'execute'), 'CRM can list');
select ok(has_function_privilege('authenticated', 'public.ask_for_review(uuid,uuid,uuid,text)', 'execute'), 'CRM can ask');
select ok(has_function_privilege('authenticated', 'public.close_review_request(uuid,uuid,uuid)', 'execute'), 'CRM can close');
select ok(not has_function_privilege('anon', 'public.ask_for_review(uuid,uuid,uuid,text)', 'execute'), 'anon cannot ask');
select ok(not has_function_privilege('authenticated', 'crm_private.review_followup_begin(uuid,uuid,uuid,text)', 'execute'),
  'the shared guard is private');
select ok(not has_function_privilege('authenticated', 'crm_private.review_request_reply(uuid)', 'execute'),
  'the reply lookup is private');

select * from finish(true);
rollback;
