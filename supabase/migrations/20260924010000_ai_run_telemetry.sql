-- 20260924010000_ai_run_telemetry.sql
--
-- Phase 0 of the CRM AI architecture
-- (docs/audits/2026-09-24-crm-ai-opus55-architecture-audit.md, section J.1).
--
-- THE GAP THIS CLOSES
--
-- The router already knows, per attempt, which provider it tried, how long it
-- took and which bounded code it failed with. The CRM jobs threw that away:
-- `crm_agent_jobs` keeps one final error code for a failed job and nothing at
-- all for a job that fell back and succeeded. Nobody could answer "why did
-- Qwen fall back on this job" from production data.
--
-- WHAT IS STORED, AND WHAT NEVER IS
--
-- One row per model run: task, job reference, bounded codes, durations,
-- character and token counts. Never a prompt, a message, a model answer, an
-- image, a credential, a raw provider error or any reasoning text. Every
-- text column is a closed vocabulary or a strict pattern that cannot carry a
-- sentence, and the attempt array is validated key by key.
--
-- The Worker never supplies the source event or the watermark. It names a job
-- it holds a claim for; the database copies those two values from the job row,
-- so telemetry cannot be used to plant an identifier.
--
-- FAILURE POLICY
--
-- Telemetry is fail-open with respect to the AI job. The Worker swallows any
-- error from this RPC, and the RPC itself answers `rejected` instead of raising
-- for a malformed record, so a telemetry defect can never fail a job.
--
-- RETENTION
--
-- 90 days, enforced on write: each insert removes a bounded batch of expired
-- rows. No separate cron is needed and the table cannot grow without bound
-- while the AI layer is running.

create table crm_private.ai_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default clock_timestamp(),
  task text not null check (task ~ '^[a-z][a-z0-9_]{2,63}$'),
  job_kind text not null
    check (job_kind in ('enquiry_intake', 'client_state', 'reference_image')),
  job_id uuid,
  source_event_id text
    check (source_event_id is null or source_event_id ~ '^[A-Za-z0-9_:.-]{1,255}$'),
  source_watermark text
    check (source_watermark is null or source_watermark ~ '^[a-f0-9]{64}$'),
  prompt_version text not null check (prompt_version ~ '^[a-z0-9][a-z0-9_.-]{0,47}$'),
  schema_version text not null check (schema_version ~ '^[a-z0-9][a-z0-9_.-]{0,47}$'),
  route_source text not null check (route_source in ('default', 'env', 'unknown')),
  attempts jsonb not null,
  attempt_count smallint not null check (attempt_count between 0 and 4),
  fallback_used boolean not null,
  final_provider text
    check (final_provider is null or final_provider in ('qwen', 'workers_ai', 'openai', 'deepseek')),
  quality_tier text not null check (quality_tier in ('primary', 'fallback', 'none')),
  outcome text not null check (outcome in ('succeeded', 'failed', 'stale', 'not_applied')),
  error_code text check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  validation_failure text
    check (validation_failure is null or validation_failure ~ '^[a-z][a-z0-9_.]{2,79}$'),
  duration_ms integer not null check (duration_ms between 0 and 900000),
  input_chars integer check (input_chars is null or input_chars between 0 and 1000000),
  image_count smallint not null default 0 check (image_count between 0 and 4)
);

create index ai_runs_created_at_idx on crm_private.ai_runs (created_at);
create index ai_runs_task_created_idx on crm_private.ai_runs (task, created_at desc);

-- Private schema, no RLS policy and no API grant. The only ways in and out are
-- the two service-backend functions below.
revoke all on crm_private.ai_runs from public, anon, authenticated, service_role;

comment on table crm_private.ai_runs is
  'Per-run AI telemetry: bounded codes, durations and counts only. No prompt, message, model output, image, credential or reasoning text. 90-day retention on write.';

-- ---------------------------------------------------------------------------
-- Attempt validator
-- ---------------------------------------------------------------------------

create function crm_private.ai_run_attempt_valid(p_attempt jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_key text;
  v_value jsonb;
begin
  if jsonb_typeof(p_attempt) is distinct from 'object' then
    return false;
  end if;

  for v_key, v_value in select * from jsonb_each(p_attempt) loop
    case v_key
      when 'provider' then
        if jsonb_typeof(v_value) <> 'string'
           or (v_value #>> '{}') not in ('qwen', 'workers_ai', 'openai', 'deepseek') then
          return false;
        end if;
      when 'model' then
        if jsonb_typeof(v_value) <> 'string' or (v_value #>> '{}') !~ '^[A-Za-z0-9_.:-]{1,60}$' then
          return false;
        end if;
      when 'outcome' then
        if jsonb_typeof(v_value) <> 'string' or (v_value #>> '{}') not in ('succeeded', 'failed') then
          return false;
        end if;
      when 'error_code' then
        if jsonb_typeof(v_value) <> 'null'
           and (jsonb_typeof(v_value) <> 'string' or (v_value #>> '{}') !~ '^[a-z][a-z0-9_]{2,63}$') then
          return false;
        end if;
      when 'finish_reason' then
        if jsonb_typeof(v_value) <> 'null'
           and (jsonb_typeof(v_value) <> 'string' or (v_value #>> '{}') !~ '^[a-z][a-z0-9_]{0,31}$') then
          return false;
        end if;
      when 'validation_failure' then
        if jsonb_typeof(v_value) <> 'null'
           and (jsonb_typeof(v_value) <> 'string' or (v_value #>> '{}') !~ '^[a-z][a-z0-9_.]{2,79}$') then
          return false;
        end if;
      when 'duration_ms', 'output_chars', 'prompt_tokens', 'completion_tokens', 'reasoning_tokens' then
        if jsonb_typeof(v_value) <> 'null'
           and (jsonb_typeof(v_value) <> 'number'
                or (v_value #>> '{}') !~ '^[0-9]{1,7}$') then
          return false;
        end if;
      else
        -- An unknown key could carry text. Reject it rather than store it.
        return false;
    end case;
  end loop;

  return p_attempt ? 'provider' and p_attempt ? 'outcome' and p_attempt ? 'duration_ms'
    and jsonb_typeof(p_attempt -> 'duration_ms') = 'number';
end;
$$;

create function crm_private.ai_run_attempts_valid(p_attempts jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog, crm_private
as $$
  select jsonb_typeof(p_attempts) = 'array'
    and jsonb_array_length(p_attempts) <= 4
    and coalesce((
      select bool_and(crm_private.ai_run_attempt_valid(a))
      from jsonb_array_elements(p_attempts) a
    ), true);
$$;

alter table crm_private.ai_runs
  add constraint ai_runs_attempts_valid check (crm_private.ai_run_attempts_valid(attempts)),
  add constraint ai_runs_attempt_count_matches check (attempt_count = jsonb_array_length(attempts));

revoke all on function crm_private.ai_run_attempt_valid(jsonb) from public, anon, authenticated, service_role;
revoke all on function crm_private.ai_run_attempts_valid(jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Write path
-- ---------------------------------------------------------------------------

create function public.service_record_ai_run(p_run jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_kind text;
  v_job uuid;
  v_event text;
  v_watermark text;
  v_attempts jsonb;
  v_id uuid;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;

  if jsonb_typeof(p_run) is distinct from 'object' then
    return jsonb_build_object('status', 'rejected');
  end if;

  -- Keys outside the contract are ignored rather than stored. The column set
  -- is fixed, so an unexpected key has nowhere to go.
  v_kind := p_run ->> 'job_kind';
  v_attempts := coalesce(p_run -> 'attempts', '[]'::jsonb);

  begin
    v_job := nullif(p_run ->> 'job_id', '')::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('status', 'rejected');
  end;

  -- Source event and watermark come from the job row, never from the caller.
  if v_job is not null then
    if v_kind = 'enquiry_intake' then
      select j.source_event_id, j.snapshot_hash into v_event, v_watermark
      from public.enquiry_ai_jobs j where j.id = v_job;
    elsif v_kind in ('client_state', 'reference_image') then
      select j.source_event_id, j.snapshot_hash into v_event, v_watermark
      from public.crm_agent_jobs j where j.id = v_job;
    end if;
    if v_watermark is not null and v_watermark !~ '^[a-f0-9]{64}$' then
      v_watermark := null;
    end if;
    if v_event is not null and v_event !~ '^[A-Za-z0-9_:.-]{1,255}$' then
      v_event := null;
    end if;
  end if;

  begin
    insert into crm_private.ai_runs (
      task, job_kind, job_id, source_event_id, source_watermark,
      prompt_version, schema_version, route_source,
      attempts, attempt_count, fallback_used, final_provider, quality_tier,
      outcome, error_code, validation_failure, duration_ms, input_chars, image_count
    ) values (
      p_run ->> 'task', v_kind, v_job, v_event, v_watermark,
      p_run ->> 'prompt_version', p_run ->> 'schema_version',
      coalesce(p_run ->> 'route_source', 'unknown'),
      v_attempts,
      case when jsonb_typeof(v_attempts) = 'array' then jsonb_array_length(v_attempts) else -1 end,
      coalesce((p_run ->> 'fallback_used')::boolean, false),
      p_run ->> 'final_provider',
      coalesce(p_run ->> 'quality_tier', 'none'),
      p_run ->> 'outcome',
      p_run ->> 'error_code',
      p_run ->> 'validation_failure',
      (p_run ->> 'duration_ms')::integer,
      (p_run ->> 'input_chars')::integer,
      coalesce((p_run ->> 'image_count')::smallint, 0)
    )
    returning id into v_id;
  exception
    when check_violation or not_null_violation or invalid_text_representation
      or numeric_value_out_of_range or invalid_parameter_value then
      return jsonb_build_object('status', 'rejected');
  end;

  -- Bounded retention on write.
  delete from crm_private.ai_runs r
  where r.id in (
    select old.id from crm_private.ai_runs old
    where old.created_at < clock_timestamp() - interval '90 days'
    order by old.created_at
    limit 200
  );

  return jsonb_build_object('status', 'recorded', 'id', v_id);
end;
$$;

revoke all on function public.service_record_ai_run(jsonb) from public, anon, authenticated;
grant execute on function public.service_record_ai_run(jsonb) to service_role;

comment on function public.service_record_ai_run(jsonb) is
  'Service-only, fail-open AI run telemetry. Copies source event and watermark from the job row; rejects any value outside the bounded vocabulary.';

-- ---------------------------------------------------------------------------
-- Aggregate readback
-- ---------------------------------------------------------------------------

create function public.service_ai_run_summary(p_hours integer default 168)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_since timestamptz;
  v_result jsonb;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;

  v_since := clock_timestamp() - make_interval(hours => least(greatest(coalesce(p_hours, 168), 1), 2160));

  with runs as (
    select * from crm_private.ai_runs where created_at >= v_since
  ),
  per_task as (
    select r.task,
      count(*) as runs,
      count(*) filter (where r.outcome = 'succeeded') as succeeded,
      count(*) filter (where r.outcome = 'failed') as failed,
      count(*) filter (where r.outcome = 'stale') as stale,
      count(*) filter (where r.fallback_used) as fallback_used,
      count(*) filter (where exists (
        select 1 from jsonb_array_elements(r.attempts) a where a ->> 'error_code' = 'output_invalid'
      )) as runs_with_schema_invalid_attempt,
      percentile_cont(0.5) within group (order by r.duration_ms) as p50_ms,
      percentile_cont(0.95) within group (order by r.duration_ms) as p95_ms
    from runs r
    group by r.task
  ),
  shares as (
    select x.task, jsonb_object_agg(x.provider, x.n) as final_provider_share
    from (
      select r.task, coalesce(r.final_provider, 'none') as provider, count(*) as n
      from runs r group by 1, 2
    ) x
    group by x.task
  ),
  attempt_errors as (
    select r.task, a ->> 'provider' as provider, coalesce(a ->> 'error_code', 'succeeded') as code, count(*) as n
    from runs r cross join lateral jsonb_array_elements(r.attempts) a
    group by 1, 2, 3
  )
  select jsonb_build_object(
    'since', v_since,
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'task', t.task,
        'runs', t.runs,
        'succeeded', t.succeeded,
        'failed', t.failed,
        'stale', t.stale,
        'fallback_used', t.fallback_used,
        'runs_with_schema_invalid_attempt', t.runs_with_schema_invalid_attempt,
        'p50_ms', round(t.p50_ms),
        'p95_ms', round(t.p95_ms),
        'final_provider_share', coalesce((select sh.final_provider_share from shares sh where sh.task = t.task), '{}'::jsonb),
        'attempts_by_provider_and_code', coalesce((
          select jsonb_agg(jsonb_build_object('provider', e.provider, 'code', e.code, 'count', e.n)
                           order by e.provider, e.code)
          from attempt_errors e where e.task = t.task
        ), '[]'::jsonb)
      ) order by t.task)
      from per_task t
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.service_ai_run_summary(integer) from public, anon, authenticated;
grant execute on function public.service_ai_run_summary(integer) to service_role;

comment on function public.service_ai_run_summary(integer) is
  'Service-only aggregate AI readback: success, failure, fallback, schema-invalid, p50/p95 latency and provider share per task. Counts only.';
