-- 300_client_ai_brief_convergence.sql
--
-- Phase 6a: an unrelated change to the clients table no longer invalidates a
-- brief, and stale briefs converge through a bounded, deduplicated sweep.
-- Everything is rolled back.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update crm_private.crm_agent_config set enabled = true;

insert into public.clients (id, workspace_id, full_name, email) values
  ('d6200000-0000-4000-8000-000000000001',
   (select workspace_id from public.artists where id = 'a1111111-1111-4111-8111-111111111111'),
   'Converging Client', 'converging@example.test'),
  ('d6200000-0000-4000-8000-000000000002',
   (select workspace_id from public.artists where id = 'a1111111-1111-4111-8111-111111111111'),
   'Second Converging Client', 'converging-2@example.test');
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at
) values
  ('d6300000-0000-4000-8000-000000000001', 'd6200000-0000-4000-8000-000000000001',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-9951', 'd6310000-0000-4000-8000-000000000001',
   repeat('c', 64), 'reviewing', 'complete', 'Converging Client', 'converging@example.test', '2026-08-05', now()),
  ('d6300000-0000-4000-8000-000000000002', 'd6200000-0000-4000-8000-000000000002',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-9952', 'd6310000-0000-4000-8000-000000000002',
   repeat('d', 64), 'reviewing', 'complete', 'Second Converging Client', 'converging-2@example.test', '2026-08-05', now());

create temp table wm on commit drop as
select crm_private.client_ai_watermark('a1111111-1111-4111-8111-111111111111', 'd6200000-0000-4000-8000-000000000001') as before;

-- A column the model never sees, and a value in it, do not move the watermark.
alter table public.clients add column pg_tap_unrelated_column text;
update public.clients set pg_tap_unrelated_column = 'x', phone_input = '07700 900123'
where id = 'd6200000-0000-4000-8000-000000000001';
select is(
  crm_private.client_ai_watermark('a1111111-1111-4111-8111-111111111111', 'd6200000-0000-4000-8000-000000000001'),
  (select before from wm),
  'a new clients column or a field the model never sees leaves the brief current');

-- A field the model is shown does move it.
update public.clients set full_name = 'Converging Client Renamed'
where id = 'd6200000-0000-4000-8000-000000000001';
select isnt(
  crm_private.client_ai_watermark('a1111111-1111-4111-8111-111111111111', 'd6200000-0000-4000-8000-000000000001'),
  (select before from wm),
  'a change to what the model reads makes the brief stale');

-- Two stale briefs, no job pending for either.
insert into public.client_ai_state (
  artist_id, workspace_id, client_id, summary, brief, missing_information, source_watermark, provider, model
)
select 'a1111111-1111-4111-8111-111111111111', a.workspace_id, c.id,
  'Synthetic summary for convergence.',
  jsonb_build_object(
    'project_summary', 'Synthetic.', 'stage', 'awaiting_artist_review', 'placement', null, 'style', null,
    'colour', null, 'size', null, 'cover_up_context', null, 'constraints', jsonb_build_array(),
    'decisions_made', jsonb_build_array(), 'open_questions', jsonb_build_array(),
    'promises_to_client', jsonb_build_array(), 'waiting_on', 'artist',
    'last_interaction', 'Synthetic.',
    'discussed', jsonb_build_object(
      'session_estimate', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'price', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'deposit', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'candidate_dates', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'confirmed_dates', jsonb_build_object('value', null, 'status', 'not_discussed'))),
  '[]'::jsonb, repeat('0', 64), 'qwen', '@cf/qwen/qwen3.8-27b'
from public.clients c
join public.artists a on a.id = 'a1111111-1111-4111-8111-111111111111'
where c.id in ('d6200000-0000-4000-8000-000000000001', 'd6200000-0000-4000-8000-000000000002');

-- Other suites may have left pending jobs; start from none for these clients.
delete from public.crm_agent_jobs
where client_id in ('d6200000-0000-4000-8000-000000000001', 'd6200000-0000-4000-8000-000000000002');

set local role service_role;
select is((public.service_converge_client_ai_briefs(1) ->> 'queued')::int, 1,
  'the sweep queues no more than its budget');
reset role;
select is((select count(*)::int from public.crm_agent_jobs
           where source_event_id like 'converge:%'
             and client_id in ('d6200000-0000-4000-8000-000000000001', 'd6200000-0000-4000-8000-000000000002')),
  1, 'one ordinary refresh job exists');

set local role service_role;
select is((public.service_converge_client_ai_briefs(1) ->> 'queued')::int, 0,
  'the hourly budget is spent, so nothing more is queued');
select is((public.service_converge_client_ai_briefs(4) ->> 'queued')::int, 1,
  'a larger budget queues the other client, never the one already pending');
select is((public.service_converge_client_ai_briefs(10) ->> 'queued')::int, 0,
  'a client with a pending refresh is not queued twice');
reset role;

-- A failed refresh for the same facts is not retried until they change.
update public.crm_agent_jobs set status = 'failed', error_code = 'ai_unavailable'
where client_id in ('d6200000-0000-4000-8000-000000000001', 'd6200000-0000-4000-8000-000000000002')
  and source_event_id like 'converge:%';
set local role service_role;
select is((public.service_converge_client_ai_briefs(10) ->> 'queued')::int, 0,
  'the same watermark is never swept twice');
reset role;

-- Disabled agent: nothing happens.
update crm_private.crm_agent_config set enabled = false;
set local role service_role;
select is(public.service_converge_client_ai_briefs(10) ->> 'status', 'disabled',
  'the sweep does nothing while the agent is disabled');
reset role;

-- Access.
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}', true);
select throws_ok($$select public.service_converge_client_ai_briefs(4)$$, '42501', null,
  'only the backend can sweep');
reset role;
select ok(not has_function_privilege('authenticated', 'public.service_converge_client_ai_briefs(integer)', 'execute'),
  'authenticated holds no execute on the sweep');

select * from finish(true);
rollback;
