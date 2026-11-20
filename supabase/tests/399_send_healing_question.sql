-- 399_send_healing_question.sql
-- Google review request, phase 2a: the artist's "Ask" button queues the
-- approved WhatsApp template vishar_healing_check_v1 for a current healing
-- suggestion, and the WhatsApp drain resolver re-checks it at send time.
-- No provider call is made. Every row is synthetic and rolled back.
begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table t_hq_artist as
select a.id, a.workspace_id from public.artists a
join crm_private.artist_state st on st.artist_id = a.id and st.is_active
where a.slug = 'vladimir';
grant select on t_hq_artist to public;

insert into auth.users (id, email) values
  ('e9800000-0000-4000-8000-0000000000a1', 'hq-manager@example.test'),
  ('e9800000-0000-4000-8000-0000000000a3', 'hq-read-only@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('e9800000-0000-4000-8000-0000000000a1', 'hq-manager@example.test', 'HQ Manager', 'booking_manager', true),
  ('e9800000-0000-4000-8000-0000000000a3', 'hq-read-only@example.test', 'HQ Read', 'booking_manager', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level, can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('e9800000-0000-4000-8000-0000000000a1', (select id from t_hq_artist),
   'manager', false, false, true, false, true),
  ('e9800000-0000-4000-8000-0000000000a3', (select id from t_hq_artist),
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
select v.id, v.name, v.email, v.phone, (select workspace_id from t_hq_artist) from (values
  ('e98c0000-0000-4000-8000-000000000001'::uuid, 'Alice Healed', 'hq-a@example.test', '+447700900801'),
  ('e98c0000-0000-4000-8000-000000000002', 'Ben Recent', 'hq-b@example.test', '+447700900802'),
  ('e98c0000-0000-4000-8000-000000000003', 'Hal Nochat', 'hq-h@example.test', '+447700900803')
) v(id, name, email, phone);

insert into public.projects (id, client_id, artist_id, status, title, deposit_status, currency)
select ('e98d0000-0000-4000-8000-00000000000' || v.n)::uuid,
       ('e98c0000-0000-4000-8000-00000000000' || v.n)::uuid,
       (select id from t_hq_artist), 'active', 'HQ project ' || v.n, 'not_required', 'GBP'
from (values ('1'), ('2'), ('3')) v(n);

insert into public.sessions
  (id, artist_id, client_id, project_id, appointment_type, status, start_at, end_at,
   duration_hours, currency)
select ('e9850000-0000-4000-8000-00000000000' || v.n)::uuid, (select id from t_hq_artist),
       ('e98c0000-0000-4000-8000-00000000000' || v.n)::uuid,
       ('e98d0000-0000-4000-8000-00000000000' || v.n)::uuid,
       'tattoo_session', 'completed', pg_temp.days_ago(v.d),
       pg_temp.days_ago(v.d) + interval '4 hours', 4, 'GBP'
from (values ('1', 40), ('2', 10), ('3', 35)) v(n, d);

insert into public.visit_outcomes
  (session_id, artist_id, client_id, appointment_type, state, outcome, work_result,
   worked_minutes, confirmed_at)
select ('e9850000-0000-4000-8000-00000000000' || v.n)::uuid, (select id from t_hq_artist),
       ('e98c0000-0000-4000-8000-00000000000' || v.n)::uuid,
       'tattoo_session', 'confirmed', 'attended', 'work_complete', 240,
       pg_temp.days_ago(v.d) + interval '5 hours'
from (values ('1', 40), ('2', 10), ('3', 35)) v(n, d);

insert into public.artist_integrations(
  artist_id, integration_type, provider, integration_key, external_account_label, is_enabled)
select a.id, 'whatsapp', 'meta_cloud_api', 'vladimir-production', 'Synthetic healing route', true
from t_hq_artist a
where not exists (
  select 1 from public.artist_integrations i where i.artist_id = a.id
    and i.integration_type = 'whatsapp' and i.provider = 'meta_cloud_api'
    and i.integration_key = 'vladimir-production');

insert into public.communication_conversations(
  id, artist_id, channel, integration_key, external_contact_id, client_id, link_state, state)
select 'e98e0000-0000-4000-8000-000000000001', id, 'whatsapp', 'vladimir-production',
       '447700900801', 'e98c0000-0000-4000-8000-000000000001', 'linked', 'open'
from t_hq_artist;

-- Synthetic Meta approval, as the maintenance poller would record it.
insert into crm_private.lifecycle_whatsapp_template_candidates (
  artist_id, purpose, template_name, template_language, approval_status,
  provider_template_id, verified_at)
select id, 'healing_check', 'vishar_healing_check_v1', 'en_GB', 'APPROVED', '2100052927362795', now()
from t_hq_artist
on conflict (artist_id, purpose) do update set
  template_name = excluded.template_name, template_language = excluded.template_language,
  approval_status = excluded.approval_status,
  provider_template_id = excluded.provider_template_id, verified_at = excluded.verified_at;

-- ------------------------------------------------------------- refusals
select pg_temp.as_profile('e9800000-0000-4000-8000-0000000000a3');
select throws_ok(
  $$select public.send_healing_question((select id from t_hq_artist),
      'e9850000-0000-4000-8000-000000000001', 'e98a0000-0000-4000-8000-000000000001')$$,
  '42501', null, 'a read-only member cannot send the healing question');

select pg_temp.as_profile('e9800000-0000-4000-8000-0000000000a1');
select throws_ok(
  $$select public.send_healing_question((select id from t_hq_artist),
      'e9850000-0000-4000-8000-000000000001', null)$$,
  '22023', null, 'an operation id is required');
select throws_ok(
  $$select public.send_healing_question((select id from t_hq_artist),
      'e9850000-0000-4000-8000-000000000002', 'e98a0000-0000-4000-8000-000000000002')$$,
  '55000', 'this visit is not a current healing suggestion',
  'a visit 10 days ago is not suggested yet');
select throws_ok(
  $$select public.send_healing_question((select id from t_hq_artist),
      'e9850000-0000-4000-8000-000000000003', 'e98a0000-0000-4000-8000-000000000003')$$,
  '55000', 'client has no open WhatsApp conversation',
  'a client without a WhatsApp conversation is refused');

update crm_private.lifecycle_whatsapp_template_candidates set verified_at = now() - interval '3 days'
where artist_id = (select id from t_hq_artist) and purpose = 'healing_check';
select throws_ok(
  $$select public.send_healing_question((select id from t_hq_artist),
      'e9850000-0000-4000-8000-000000000001', 'e98a0000-0000-4000-8000-000000000004')$$,
  '55000', 'the healing question template is not approved for this artist',
  'a stale template approval is refused');
update crm_private.lifecycle_whatsapp_template_candidates set verified_at = now()
where artist_id = (select id from t_hq_artist) and purpose = 'healing_check';

select is((select count(*)::int from public.review_requests
           where client_id in ('e98c0000-0000-4000-8000-000000000001',
                               'e98c0000-0000-4000-8000-000000000003')),
  0, 'refusals leave no review request');

-- ------------------------------------------------------------------ send
create temporary table t_hq_result as
select public.send_healing_question((select id from t_hq_artist),
  'e9850000-0000-4000-8000-000000000001', 'e98a0000-0000-4000-8000-000000000010') as r;
grant select on t_hq_result to public;

select is((select r ->> 'state' from t_hq_result), 'healing_asked', 'the request becomes healing_asked');
select ok((select r ? 'healing_message_id' and not r ? 'created_by' from t_hq_result),
  'the result carries the message and no profile ids');

select results_eq(
  $$select m.direction::text, m.origin::text, m.status::text, m.message_type, m.body
    from public.communication_messages m
    where m.id = (select (r ->> 'healing_message_id')::uuid from t_hq_result)$$,
  $$values ('outbound', 'crm', 'queued', 'template',
            'Hi Alice, I hope all is well with you. How has your tattoo healed?')$$,
  'one queued outbound template message with the approved wording');

select results_eq(
  $$select p.template_name, p.template_language, p.body_parameters
    from crm_private.healing_check_whatsapp_payloads p
    where p.communication_message_id = (select (r ->> 'healing_message_id')::uuid from t_hq_result)$$,
  $$values ('vishar_healing_check_v1'::text, 'en_GB'::text, '["Alice"]'::jsonb)$$,
  'the drain payload carries only the first name');

select is((select count(*)::int from public.integration_outbox o
           where o.communication_message_id = (select (r ->> 'healing_message_id')::uuid from t_hq_result)
             and o.kind = 'whatsapp_message'),
  1, 'exactly one WhatsApp outbox job');

select is(public.send_healing_question((select id from t_hq_artist),
            'e9850000-0000-4000-8000-000000000001', 'e98a0000-0000-4000-8000-000000000010'),
  (select r from t_hq_result), 'a retry with the same operation returns the recorded result');
select is((select count(*)::int from public.communication_messages
           where conversation_id = 'e98e0000-0000-4000-8000-000000000001' and direction = 'outbound'),
  1, 'the retry queues no second message');

select throws_ok(
  $$select public.send_healing_question((select id from t_hq_artist),
      'e9850000-0000-4000-8000-000000000001', 'e98a0000-0000-4000-8000-000000000011')$$,
  '55000', 'this visit is not a current healing suggestion',
  'a second question for the same visit is refused');
select is((public.act_on_review_suggestion((select id from t_hq_artist),
      'e9850000-0000-4000-8000-000000000001', 'snooze', 'e98a0000-0000-4000-8000-000000000010')) ->> 'state',
  'healing_asked', 'replaying the send operation as a snooze returns the recorded send');
select is((select state from public.review_requests
           where anchor_session_id = 'e9850000-0000-4000-8000-000000000001'),
  'healing_asked', 'and does not snooze the asked visit');
select ok(not exists (
  select 1 from jsonb_array_elements(public.list_review_suggestions((select id from t_hq_artist)) -> 'suggestions') s
  where s ->> 'client_id' = 'e98c0000-0000-4000-8000-000000000001'),
  'the asked client leaves the suggestions');

-- ------------------------------------------------- resolver at send time
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table t_hq_outbox as
select o.id from public.integration_outbox o
where o.communication_message_id = (select (r ->> 'healing_message_id')::uuid from t_hq_result);
grant select on t_hq_outbox to public;
select is((select count(*)::int from public.claim_whatsapp_outbox_by_id(
  (select id from t_hq_outbox), 'hq-worker', 120)), 1, 'the WhatsApp worker can lease the job');

select results_eq(
  $$select is_lifecycle, purpose, template_name, body_parameters, delivery_allowed
    from public.service_resolve_whatsapp_lifecycle_payload((select id from t_hq_outbox), 'hq-worker')$$,
  $$values (true, 'healing_check'::text, 'vishar_healing_check_v1'::text, '["Alice"]'::jsonb, true)$$,
  'the resolver returns the healing template as deliverable');

update crm_private.lifecycle_whatsapp_template_candidates set approval_status = 'PAUSED', provider_template_id = null
where artist_id = (select id from t_hq_artist) and purpose = 'healing_check';
select is((select delivery_allowed from public.service_resolve_whatsapp_lifecycle_payload(
  (select id from t_hq_outbox), 'hq-worker')), false, 'a paused template is not delivered');
update crm_private.lifecycle_whatsapp_template_candidates
set approval_status = 'APPROVED', provider_template_id = '2100052927362795', verified_at = now()
where artist_id = (select id from t_hq_artist) and purpose = 'healing_check';

insert into public.communication_suppressions (client_id, channel, reason, is_active)
values ('e98c0000-0000-4000-8000-000000000001', 'whatsapp', 'unsubscribed', true);
select is((select delivery_allowed from public.service_resolve_whatsapp_lifecycle_payload(
  (select id from t_hq_outbox), 'hq-worker')), false, 'a client who unsubscribed after Ask is not messaged');

-- ------------------------------------------------------------- privileges
select ok(has_function_privilege('authenticated', 'public.send_healing_question(uuid,uuid,uuid)', 'execute'),
  'the CRM can call send_healing_question');
select ok(not has_function_privilege('anon', 'public.send_healing_question(uuid,uuid,uuid)', 'execute'),
  'anon cannot send');
select ok(not has_function_privilege('authenticated', 'crm_private.healing_check_template_ready(uuid,text,text)', 'execute'),
  'the template check is private');
select ok(not has_table_privilege('authenticated', 'crm_private.healing_check_whatsapp_payloads', 'select'),
  'the browser cannot read drain payloads');

select * from finish(true);
rollback;
