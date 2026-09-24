-- 297_narrow_client_state_contract.sql
--
-- Phase 3: deterministic workflow facts reach the model context; behind
-- deterministic_state the stored stage/waiting side and allowed actions come
-- from the deterministic layer; the classifier reply state becomes a mark.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.clients (id, full_name, email) values
  ('e8011111-1111-4111-8111-111111111111', 'Contract Client', 'contract@example.test');
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'e8021111-1111-4111-8111-111111111111', 'e8011111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-9801', 'e8031111-1111-4111-8111-111111111111',
  repeat('f', 64), 'converted', 'complete', 'Contract Client', 'contract@example.test', '2026-08-05', now()
);
insert into public.projects (id, client_id, artist_id, enquiry_id, title, description, deposit_status, status) values
  ('e8041111-1111-4111-8111-111111111111', 'e8011111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'e8021111-1111-4111-8111-111111111111', 'Contract', 'rollback only', 'paid', 'active');
insert into public.sessions (id, artist_id, client_id, enquiry_id, project_id, appointment_type, status, start_at, end_at, duration_hours)
values ('e8051111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
  'e8011111-1111-4111-8111-111111111111', 'e8021111-1111-4111-8111-111111111111',
  'e8041111-1111-4111-8111-111111111111', 'tattoo_session', 'confirmed',
  date_trunc('hour', now()) + interval '7 days', date_trunc('hour', now()) + interval '7 days 3 hours', 3);

select ok(
  (crm_private.client_ai_context('a1111111-1111-4111-8111-111111111111', 'e8011111-1111-4111-8111-111111111111')
    -> 'attention' -> 'allowed_actions') is not null,
  'the claimed model context carries the deterministic allowed actions');
select is(
  crm_private.client_ai_context('a1111111-1111-4111-8111-111111111111', 'e8011111-1111-4111-8111-111111111111')
    -> 'attention' ->> 'workflow_stage',
  'booked', 'the context states the deterministic stage');

create function pg_temp.brief(p_stage text) returns jsonb language sql as $$
  select jsonb_build_object(
    'project_summary', 'Synthetic project', 'stage', p_stage, 'placement', null, 'style', null,
    'colour', null, 'size', null, 'cover_up_context', null, 'constraints', '[]'::jsonb,
    'decisions_made', '[]'::jsonb, 'open_questions', '[]'::jsonb, 'promises_to_client', '[]'::jsonb,
    'waiting_on', 'artist', 'last_interaction', null,
    'discussed', jsonb_build_object(
      'session_estimate', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'price', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'deposit', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'candidate_dates', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'confirmed_dates', jsonb_build_object('value', null, 'status', 'not_discussed')));
$$;

create function pg_temp.write_state(p_stage text) returns text language sql as $$
  insert into public.client_ai_state (artist_id, workspace_id, client_id, summary, brief, source_watermark, provider, model)
  select a.id, a.workspace_id, 'e8011111-1111-4111-8111-111111111111', 'Synthetic summary', pg_temp.brief(p_stage),
         repeat('a', 64), 'qwen', '@cf/qwen/qwen3.8-27b'
  from public.artists a where a.id = 'a1111111-1111-4111-8111-111111111111'
  on conflict (artist_id, client_id) do update set brief = excluded.brief
  returning brief ->> 'stage';
$$;

-- Flag off: the model's stage is stored as sent (current production behaviour).
update crm_private.crm_agent_config set deterministic_state = false where singleton;
select is(pg_temp.write_state('gathering_information'), 'gathering_information',
  'with deterministic_state off the stored stage is unchanged');

-- Flag on: the deterministic stage wins, whatever the Worker sent.
update crm_private.crm_agent_config set deterministic_state = true where singleton;
select is(pg_temp.write_state('gathering_information'), 'booked',
  'with deterministic_state on the stored stage comes from authoritative facts');
select is(
  (select brief ->> 'waiting_on' from public.client_ai_state where client_id = 'e8011111-1111-4111-8111-111111111111'),
  'nobody', 'the stored waiting side comes from the deterministic layer');

-- A recommendation the facts forbid never opens.
insert into public.client_ai_next_actions (
  artist_id, workspace_id, client_id, client_ai_state_id, action_type, reason, priority,
  draft_reply, missing_information, source_watermark, provider, model
)
select st.artist_id, st.workspace_id, st.client_id, st.id, 'request_deposit', 'Synthetic.', 'normal',
       null, '[]'::jsonb, repeat('b', 64), 'qwen', '@cf/qwen/qwen3.8-27b'
from public.client_ai_state st where st.client_id = 'e8011111-1111-4111-8111-111111111111';
select results_eq(
  $$ select status, superseded_reason from public.client_ai_next_actions
     where client_id = 'e8011111-1111-4111-8111-111111111111' and action_type = 'request_deposit' $$,
  $$ values ('superseded'::text, 'rule_disallowed'::text) $$,
  'an action outside allowed_actions is superseded with a reason');

insert into public.client_ai_next_actions (
  artist_id, workspace_id, client_id, client_ai_state_id, action_type, reason, priority,
  draft_reply, missing_information, source_watermark, provider, model
)
select st.artist_id, st.workspace_id, st.client_id, st.id, 'no_action', 'Synthetic.', 'low',
       null, '[]'::jsonb, repeat('c', 64), 'qwen', '@cf/qwen/qwen3.8-27b'
from public.client_ai_state st where st.client_id = 'e8011111-1111-4111-8111-111111111111';
select is(
  (select status from public.client_ai_next_actions
   where client_id = 'e8011111-1111-4111-8111-111111111111' and action_type = 'no_action'),
  'open', 'an allowed action stays open');

select is((public.service_contract_rule_summary(24) ->> 'rule_disallowed')::int, 1,
  'rule interventions are counted');

-- Classifier reply state becomes an explicit mark on the message the job saw.
insert into public.communication_conversations (
  id, artist_id, channel, client_id, link_state, integration_key, external_contact_id
) values ('e8061111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'e8011111-1111-4111-8111-111111111111', 'linked', 'vladimir-production', '447700900888');
insert into public.communication_messages (
  id, conversation_id, artist_id, channel, direction, origin, status, body, provider_timestamp
) values ('e8071111-1111-4111-8111-111111111111', 'e8061111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'inbound', 'contact', 'received',
  'Thanks, see you then!', now() - interval '2 hours');
insert into public.crm_agent_jobs (
  id, artist_id, workspace_id, client_id, job_type, source_event_id, snapshot_hash, status, attempts
)
select 'e8081111-1111-4111-8111-111111111111', a.id, a.workspace_id, 'e8011111-1111-4111-8111-111111111111',
       'refresh_client_ai_state', 'contract-test:event', repeat('d', 64), 'succeeded', 1
from public.artists a where a.id = 'a1111111-1111-4111-8111-111111111111';

select is(public.service_record_client_reply_state('e8081111-1111-4111-8111-111111111111', 'no_reply_needed') ->> 'status',
  'recorded', 'a classifier reply state is recorded for a succeeded job');
select results_eq(
  $$ select reply_state, reply_state_source, response_debt_candidate
     from crm_private.attention_comm_facts('a1111111-1111-4111-8111-111111111111', 'e8011111-1111-4111-8111-111111111111') $$,
  $$ values ('no_reply_needed'::text, 'classifier'::text, true) $$,
  '"thanks, see you then" keeps the last-speaker fact but owes no reply');
select is(public.service_record_client_reply_state('e8081111-1111-4111-8111-111111111111', 'free text') ->> 'status',
  'ignored', 'only the closed reply-state vocabulary is accepted');

select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.service_record_client_reply_state('e8081111-1111-4111-8111-111111111111', 'no_reply_needed') $$,
  '42501', null, 'only the service backend records reply states');

select * from finish(true);
rollback;
