-- Rollback-only regression: observe evaluation count, not elapsed wall time.
begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- This file runs only in the disposable pgTAP database, never production.
delete from public.client_ai_state;
update crm_private.crm_agent_config set deterministic_state = false where singleton;
insert into public.clients (id, full_name, archived_at) values
  ('f3410000-0000-4000-8000-000000000001', 'Shadow Fixture One', null),
  ('f3410000-0000-4000-8000-000000000002', 'Shadow Fixture Two', null),
  ('f3410000-0000-4000-8000-000000000003', 'Shadow Archived Fixture', now());
insert into public.client_ai_state
  (artist_id, workspace_id, client_id, summary, brief, source_watermark, provider, model)
select a.id, a.workspace_id, c.id, 'Synthetic summary',
  jsonb_build_object(
    'project_summary', 'Synthetic project', 'stage', 'new_enquiry',
    'placement', null, 'style', null, 'colour', null, 'size', null,
    'cover_up_context', null, 'constraints', '[]'::jsonb,
    'decisions_made', '[]'::jsonb, 'open_questions', '[]'::jsonb,
    'promises_to_client', '[]'::jsonb, 'waiting_on', 'artist', 'last_interaction', null,
    'discussed', jsonb_build_object(
      'session_estimate', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'price', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'deposit', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'candidate_dates', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'confirmed_dates', jsonb_build_object('value', null, 'status', 'not_discussed'))),
  repeat('a', 64), 'qwen', '@cf/qwen/qwen3.8-27b'
from public.artists a cross join public.clients c
where a.id = 'a1111111-1111-4111-8111-111111111111'
  and c.id in ('f3410000-0000-4000-8000-000000000001',
               'f3410000-0000-4000-8000-000000000002',
               'f3410000-0000-4000-8000-000000000003');

create temporary sequence shadow_evaluations;
-- Keep the production STABLE declaration: changing it to VOLATILE would
-- itself prevent CTE folding and make the old query falsely pass this test.
create or replace function crm_private.client_attention(
  p_artist_id uuid, p_client_id uuid, p_now timestamptz default null)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform nextval('pg_temp.shadow_evaluations');
  return jsonb_build_object(
    'workflow_stage', 'gathering_information', 'waiting_on_candidate', 'client',
    'allowed_actions', jsonb_build_array('artist_review'),
    'sla_state', 'ok', 'conflicts', jsonb_build_array('fixture_conflict'),
    'has_valid_next_step', false, 'reply_state', 'unknown');
end;
$$;

create temporary table shadow_result as
select crm_private.attention_shadow_report() as report;
select is((select last_value::int from pg_temp.shadow_evaluations), 2,
  'the expensive attention function is evaluated once per active client');
select is((select report from shadow_result),
  '{"clients":2,"stage_disagreements":2,"waiting_on_disagreements":2,
    "open_ai_actions_disallowed":0,
    "stage_pairs":{"new_enquiry->gathering_information":2},
    "waiting_pairs":{"artist->client":2},"sla_states":{"ok":2},
    "conflicts":{"fixture_conflict":2},"without_valid_next_step":2,
    "reply_states":{"unknown":2}}'::jsonb,
  'all aggregate fields keep their values and archived clients are excluded');

select ok(not has_function_privilege('anon', 'crm_private.attention_shadow_report()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'crm_private.attention_shadow_report()', 'EXECUTE')
  and not has_function_privilege('service_role', 'crm_private.attention_shadow_report()', 'EXECUTE'),
  'the internal report remains inaccessible to API roles');
select ok(has_function_privilege('service_role', 'public.service_record_attention_shadow()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.service_record_attention_shadow()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.service_record_attention_shadow()', 'EXECUTE'),
  'only the service role may execute the recording RPC');

delete from crm_private.attention_shadow_runs;
select is(public.service_record_attention_shadow()->>'status', 'recorded', 'recording still works');
select is(public.service_record_attention_shadow()->>'status', 'throttled', 'the hourly throttle is preserved');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.service_record_attention_shadow() $$, '42501', null,
  'the backend check still denies a non-service request');
select * from finish(true);
rollback;
