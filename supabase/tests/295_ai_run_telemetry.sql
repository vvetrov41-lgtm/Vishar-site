-- 295_ai_run_telemetry.sql
--
-- Phase 0 AI telemetry: bounded, service-only, fail-open, content-free.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.clients (id, full_name, email) values
  ('e6011111-1111-4111-8111-111111111111', 'Telemetry Client', 'telemetry@example.test');

insert into public.crm_agent_jobs (
  id, artist_id, workspace_id, client_id, job_type, source_event_id, snapshot_hash,
  status, attempts
)
select 'e6021111-1111-4111-8111-111111111111', a.id, a.workspace_id,
       'e6011111-1111-4111-8111-111111111111', 'refresh_client_ai_state',
       'telemetry-test:event', repeat('b', 64), 'succeeded', 1
from public.artists a where a.id = 'a1111111-1111-4111-8111-111111111111';

create function pg_temp.run(p_overrides jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'task', 'crm_client_state',
    'job_kind', 'client_state',
    'job_id', 'e6021111-1111-4111-8111-111111111111',
    'prompt_version', 'client-state.2026-09-10',
    'schema_version', 'client-state.v1',
    'route_source', 'env',
    'attempts', jsonb_build_array(
      jsonb_build_object('provider', 'qwen', 'model', 'cf-qwen-qwen3.8-27b', 'outcome', 'failed',
        'error_code', 'provider_timeout', 'finish_reason', null, 'duration_ms', 30001,
        'output_chars', null, 'prompt_tokens', null, 'completion_tokens', null,
        'reasoning_tokens', null, 'validation_failure', null),
      jsonb_build_object('provider', 'workers_ai', 'model', 'cf-meta-llama-3.1-8b-instruct-fast',
        'outcome', 'succeeded', 'error_code', null, 'finish_reason', 'stop', 'duration_ms', 2400,
        'output_chars', 1800, 'prompt_tokens', 2100, 'completion_tokens', 500,
        'reasoning_tokens', null, 'validation_failure', null)
    ),
    'fallback_used', true,
    'final_provider', 'workers_ai',
    'quality_tier', 'fallback',
    'outcome', 'succeeded',
    'error_code', null,
    'validation_failure', null,
    'duration_ms', 32401,
    'input_chars', 5400,
    'image_count', 0
  ) || p_overrides;
$$;

-- Storage is private.
select ok(to_regclass('crm_private.ai_runs') is not null, 'ai_runs lives in the private schema');
select ok(
  not has_table_privilege('anon', 'crm_private.ai_runs', 'SELECT')
  and not has_table_privilege('authenticated', 'crm_private.ai_runs', 'SELECT')
  and not has_table_privilege('service_role', 'crm_private.ai_runs', 'SELECT')
  and not has_table_privilege('service_role', 'crm_private.ai_runs', 'INSERT'),
  'no API role reads or writes ai_runs directly'
);

-- Happy path; source event and watermark come from the job row.
select is(public.service_record_ai_run(pg_temp.run(
  '{"source_event_id":"planted:by-caller","source_watermark":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}'::jsonb
)) ->> 'status', 'recorded', 'a bounded run is recorded');

select results_eq(
  $$ select source_event_id, source_watermark, attempt_count::int, final_provider, quality_tier
     from crm_private.ai_runs where job_id = 'e6021111-1111-4111-8111-111111111111' $$,
  $$ values ('telemetry-test:event'::text, repeat('b', 64), 2, 'workers_ai'::text, 'fallback'::text) $$,
  'source event and watermark are copied from the job, never from the caller'
);

-- Content cannot be persisted.
select is(public.service_record_ai_run(pg_temp.run(jsonb_build_object('attempts', jsonb_build_array(
  jsonb_build_object('provider', 'qwen', 'outcome', 'failed', 'duration_ms', 10,
    'text', 'Hi, I would like a dragon on my arm')
)))) ->> 'status', 'rejected', 'an attempt carrying a text key is rejected');

select is(public.service_record_ai_run(pg_temp.run(jsonb_build_object('attempts', jsonb_build_array(
  jsonb_build_object('provider', 'qwen', 'outcome', 'failed', 'duration_ms', 10,
    'error_code', 'Provider said: the client wrote hello')
)))) ->> 'status', 'rejected', 'free text in an attempt error code is rejected');

select is(public.service_record_ai_run(pg_temp.run(jsonb_build_object('attempts', jsonb_build_array(
  jsonb_build_object('provider', 'qwen', 'model', 'model with spaces', 'outcome', 'failed', 'duration_ms', 10)
)))) ->> 'status', 'rejected', 'a free-text model token is rejected');

select is(public.service_record_ai_run(pg_temp.run('{"error_code":"ignore previous instructions"}'::jsonb)) ->> 'status',
  'rejected', 'free text in the run error code is rejected');

select is(public.service_record_ai_run(pg_temp.run('{"validation_failure":"brief.stage was booked"}'::jsonb)) ->> 'status',
  'rejected', 'free text in the validation failure is rejected');

select is(public.service_record_ai_run(pg_temp.run('{"prompt_version":"You maintain an internal CRM brief"}'::jsonb)) ->> 'status',
  'rejected', 'a prompt cannot be smuggled in as a version');

select is(public.service_record_ai_run(pg_temp.run('{"task":"crm client state"}'::jsonb)) ->> 'status',
  'rejected', 'an invalid task name is rejected');

select is(public.service_record_ai_run(pg_temp.run(jsonb_build_object('attempts',
  '[{"provider":"qwen","outcome":"failed","duration_ms":1},{"provider":"qwen","outcome":"failed","duration_ms":1},
    {"provider":"qwen","outcome":"failed","duration_ms":1},{"provider":"qwen","outcome":"failed","duration_ms":1},
    {"provider":"qwen","outcome":"failed","duration_ms":1}]'::jsonb))) ->> 'status',
  'rejected', 'more than four attempts is rejected');

select is(public.service_record_ai_run(pg_temp.run('{"duration_ms":"slow"}'::jsonb)) ->> 'status',
  'rejected', 'a non-numeric duration is rejected, not raised');

select is(public.service_record_ai_run('"just a string"'::jsonb) ->> 'status', 'rejected',
  'a non-object record is rejected');

select is((select count(*)::int from crm_private.ai_runs), 1, 'rejected records leave no row');

-- A run with no attempts (input refused before any provider) is allowed.
select is(public.service_record_ai_run(pg_temp.run(
  '{"attempts":[],"fallback_used":false,"final_provider":null,"quality_tier":"none","outcome":"failed","error_code":"input_invalid"}'::jsonb
)) ->> 'status', 'recorded', 'a run refused before any provider is recorded with zero attempts');

-- Retention on write.
insert into crm_private.ai_runs (
  created_at, task, job_kind, prompt_version, schema_version, route_source, attempts, attempt_count,
  fallback_used, quality_tier, outcome, duration_ms
) values (
  clock_timestamp() - interval '91 days', 'crm_client_state', 'client_state', 'v', 'v', 'default',
  '[]'::jsonb, 0, false, 'none', 'failed', 1
);
select public.service_record_ai_run(pg_temp.run());
select is(
  (select count(*)::int from crm_private.ai_runs where created_at < clock_timestamp() - interval '90 days'),
  0, 'rows older than 90 days are removed on write'
);

-- Aggregate readback.
select is(
  (select (t ->> 'runs')::int from jsonb_array_elements(public.service_ai_run_summary(24) -> 'tasks') t
   where t ->> 'task' = 'crm_client_state'),
  3, 'summary counts runs per task'
);
select is(
  (select (t ->> 'fallback_used')::int from jsonb_array_elements(public.service_ai_run_summary(24) -> 'tasks') t
   where t ->> 'task' = 'crm_client_state'),
  2, 'summary counts fallback runs'
);
select ok(
  (select t -> 'final_provider_share' ? 'workers_ai' from jsonb_array_elements(public.service_ai_run_summary(24) -> 'tasks') t
   where t ->> 'task' = 'crm_client_state'),
  'summary reports final provider share'
);
select ok(
  (select exists (
     select 1 from jsonb_array_elements(t -> 'attempts_by_provider_and_code') e
     where e ->> 'provider' = 'qwen' and e ->> 'code' = 'provider_timeout')
   from jsonb_array_elements(public.service_ai_run_summary(24) -> 'tasks') t
   where t ->> 'task' = 'crm_client_state'),
  'summary breaks attempts down by provider and error code'
);

-- Only the service backend may call either function.
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.service_record_ai_run('{}'::jsonb) $$, '42501', null,
  'a non-service caller cannot record telemetry');
select throws_ok($$ select public.service_ai_run_summary(24) $$, '42501', null,
  'a non-service caller cannot read the summary');

select * from finish(true);
rollback;
