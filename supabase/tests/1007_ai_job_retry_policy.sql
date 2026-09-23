-- 1007_ai_job_retry_policy.sql
--
-- Audit M-6: a permanent input refusal ends an AI job at once; transient
-- failures keep the three-attempt ceiling with 5- then 30-minute backoff.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.clients (id, full_name, email) values
  ('e5011111-1111-4111-8111-111111111111', 'AI Retry Client', 'ai-retry@example.test');
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'e5021111-1111-4111-8111-111111111111', 'e5011111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111', 'PENDING', 'e5031111-1111-4111-8111-111111111111',
  repeat('f', 64), 'new', 'complete', 'AI Retry Client', 'ai-retry@example.test', '2026-08-05', now()
);

create function pg_temp.ai_job(p_id uuid, p_attempts int) returns void language sql as $$
  insert into public.enquiry_ai_jobs (
    id, artist_id, workspace_id, enquiry_id, client_id, trigger_type, source_event_id,
    status, attempts, lease_token, lease_until
  )
  select p_id, a.id, a.workspace_id, 'e5021111-1111-4111-8111-111111111111',
         'e5011111-1111-4111-8111-111111111111', 'booking', 'retry-test:' || p_id,
         'processing', p_attempts, p_id, clock_timestamp() + interval '2 minutes'
  from public.artists a where a.id = 'a1111111-1111-4111-8111-111111111111';
$$;

create function pg_temp.agent_job(p_id uuid, p_attempts int) returns void language sql as $$
  insert into public.crm_agent_jobs (
    id, artist_id, workspace_id, client_id, job_type, source_event_id, snapshot_hash,
    status, attempts, lease_token, lease_until
  )
  select p_id, a.id, a.workspace_id, 'e5011111-1111-4111-8111-111111111111',
         'refresh_client_ai_state', 'retry-test:' || p_id, repeat('a', 64),
         'processing', p_attempts, p_id, clock_timestamp() + interval '2 minutes'
  from public.artists a where a.id = 'a1111111-1111-4111-8111-111111111111';
$$;

-- Enquiry AI.
select pg_temp.ai_job('e5101111-1111-4111-8111-111111111111', 1);
select is(public.service_fail_enquiry_ai_job('e5101111-1111-4111-8111-111111111111',
  'e5101111-1111-4111-8111-111111111111', 'input_invalid') ->> 'status', 'failed',
  'enquiry AI: input_invalid ends the job on the first attempt');

select pg_temp.ai_job('e5111111-1111-4111-8111-111111111111', 1);
select is(public.service_fail_enquiry_ai_job('e5111111-1111-4111-8111-111111111111',
  'e5111111-1111-4111-8111-111111111111', 'ai_unavailable') ->> 'status', 'pending',
  'enquiry AI: a provider outage is retried');
select ok((select available_at between now() + interval '4 minutes' and now() + interval '6 minutes'
  from public.enquiry_ai_jobs where id = 'e5111111-1111-4111-8111-111111111111'),
  'enquiry AI: the first retry waits five minutes');

select pg_temp.ai_job('e5121111-1111-4111-8111-111111111111', 2);
select public.service_fail_enquiry_ai_job('e5121111-1111-4111-8111-111111111111',
  'e5121111-1111-4111-8111-111111111111', 'ai_unavailable');
select ok((select available_at between now() + interval '29 minutes' and now() + interval '31 minutes'
  from public.enquiry_ai_jobs where id = 'e5121111-1111-4111-8111-111111111111'),
  'enquiry AI: the second retry backs off to thirty minutes');

select pg_temp.ai_job('e5131111-1111-4111-8111-111111111111', 3);
select is(public.service_fail_enquiry_ai_job('e5131111-1111-4111-8111-111111111111',
  'e5131111-1111-4111-8111-111111111111', 'ai_unavailable') ->> 'status', 'failed',
  'enquiry AI: the three-attempt ceiling is unchanged');

-- CRM agent.
select pg_temp.agent_job('e5201111-1111-4111-8111-111111111111', 1);
select is(public.service_fail_crm_agent_job('e5201111-1111-4111-8111-111111111111',
  'e5201111-1111-4111-8111-111111111111', 'input_invalid') ->> 'status', 'failed',
  'CRM agent: input_invalid ends the job on the first attempt');

select pg_temp.agent_job('e5211111-1111-4111-8111-111111111111', 2);
select is(public.service_fail_crm_agent_job('e5211111-1111-4111-8111-111111111111',
  'e5211111-1111-4111-8111-111111111111', 'output_invalid') ->> 'status', 'pending',
  'CRM agent: an invalid model output is retried within the ceiling');
select ok((select available_at between now() + interval '29 minutes' and now() + interval '31 minutes'
  from public.crm_agent_jobs where id = 'e5211111-1111-4111-8111-111111111111'),
  'CRM agent: the second retry backs off to thirty minutes');

select pg_temp.agent_job('e5221111-1111-4111-8111-111111111111', 3);
select is(public.service_fail_crm_agent_job('e5221111-1111-4111-8111-111111111111',
  'e5221111-1111-4111-8111-111111111111', 'processing_failed') ->> 'status', 'failed',
  'CRM agent: the three-attempt ceiling is unchanged');

select * from finish(true);
rollback;
