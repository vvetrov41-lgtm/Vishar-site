-- 391_crm_agent_quota_deferral.sql
--
-- Resilience: a spent daily AI allocation defers a CRM agent job to the next
-- reset without spending its attempt budget, bounded by the job's age. Every
-- other failure code keeps the M-6 retry policy.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.clients (id, full_name, email) values
  ('e6011111-1111-4111-8111-111111111111', 'AI Quota Client', 'ai-quota@example.test');

create function pg_temp.agent_job(p_id uuid, p_attempts int, p_age interval default '0') returns void language sql as $$
  insert into public.crm_agent_jobs (
    id, artist_id, workspace_id, client_id, job_type, source_event_id, snapshot_hash,
    status, attempts, lease_token, lease_until, created_at
  )
  select p_id, a.id, a.workspace_id, 'e6011111-1111-4111-8111-111111111111',
         'refresh_client_ai_state', 'quota-test:' || p_id, repeat('a', 64),
         'processing', p_attempts, p_id, clock_timestamp() + interval '2 minutes',
         clock_timestamp() - p_age
  from public.artists a where a.id = 'a1111111-1111-4111-8111-111111111111';
$$;

create function pg_temp.next_utc_midnight() returns timestamptz language sql as $$
  select date_trunc('day', clock_timestamp() at time zone 'UTC') at time zone 'UTC' + interval '1 day';
$$;

-- First attempt meets the spent allocation.
select pg_temp.agent_job('e6101111-1111-4111-8111-111111111111', 1);
select is(public.service_fail_crm_agent_job('e6101111-1111-4111-8111-111111111111',
  'e6101111-1111-4111-8111-111111111111', 'ai_quota_exhausted'),
  jsonb_build_object('status', 'pending', 'error_code', 'ai_quota_exhausted', 'deferred', true),
  'quota: the job is deferred, not failed');
select is((select attempts from public.crm_agent_jobs where id = 'e6101111-1111-4111-8111-111111111111'), 0,
  'quota: the attempt is handed back');
select ok((select available_at between pg_temp.next_utc_midnight() + interval '5 minutes'
                                   and pg_temp.next_utc_midnight() + interval '15 minutes'
  from public.crm_agent_jobs where id = 'e6101111-1111-4111-8111-111111111111'),
  'quota: the job waits for the allocation reset after the next 00:00 UTC');
select is((select (status, error_code, lease_token is null, lease_until is null)::text
  from public.crm_agent_jobs where id = 'e6101111-1111-4111-8111-111111111111'),
  '(pending,ai_quota_exhausted,t,t)',
  'quota: the lease is released and the reason stays visible');

-- The last attempt of the budget no longer ends the job for good.
select pg_temp.agent_job('e6111111-1111-4111-8111-111111111111', 3);
select is(public.service_fail_crm_agent_job('e6111111-1111-4111-8111-111111111111',
  'e6111111-1111-4111-8111-111111111111', 'ai_quota_exhausted') ->> 'status', 'pending',
  'quota: the third attempt is deferred instead of ending the job');
select is((select attempts from public.crm_agent_jobs where id = 'e6111111-1111-4111-8111-111111111111'), 2,
  'quota: a deferred job stays claimable under the three-attempt ceiling');

-- A deferred job is not claimable before the reset.
select is((select count(*)::int from public.crm_agent_jobs j
  where j.id in ('e6101111-1111-4111-8111-111111111111', 'e6111111-1111-4111-8111-111111111111')
    and j.status = 'pending' and j.available_at <= clock_timestamp()), 0,
  'quota: a deferred job is not available again inside the exhausted day');

-- Bounded: an old job fails for good and reaches the operational alert.
select pg_temp.agent_job('e6121111-1111-4111-8111-111111111111', 1, interval '49 hours');
select is(public.service_fail_crm_agent_job('e6121111-1111-4111-8111-111111111111',
  'e6121111-1111-4111-8111-111111111111', 'ai_quota_exhausted'),
  jsonb_build_object('status', 'failed', 'error_code', 'ai_quota_exhausted'),
  'quota: a job older than 48 hours is not deferred again');
select is((select status from public.crm_agent_jobs where id = 'e6121111-1111-4111-8111-111111111111'),
  'failed', 'quota: the bounded deferral ends in a terminal, alertable state');

-- Other codes are untouched.
select pg_temp.agent_job('e6131111-1111-4111-8111-111111111111', 3);
select is(public.service_fail_crm_agent_job('e6131111-1111-4111-8111-111111111111',
  'e6131111-1111-4111-8111-111111111111', 'ai_unavailable') ->> 'status', 'failed',
  'an ordinary provider failure keeps the three-attempt ceiling');
select pg_temp.agent_job('e6141111-1111-4111-8111-111111111111', 1);
select is(public.service_fail_crm_agent_job('e6141111-1111-4111-8111-111111111111',
  'e6141111-1111-4111-8111-111111111111', 'ai_unavailable') ->> 'status', 'pending',
  'an ordinary provider failure is retried');
select is((select attempts from public.crm_agent_jobs where id = 'e6141111-1111-4111-8111-111111111111'), 1,
  'an ordinary provider failure still spends its attempt');
select ok((select available_at between now() + interval '4 minutes' and now() + interval '6 minutes'
  from public.crm_agent_jobs where id = 'e6141111-1111-4111-8111-111111111111'),
  'an ordinary provider failure keeps the five-minute backoff');

-- The lease is still the capability.
select pg_temp.agent_job('e6151111-1111-4111-8111-111111111111', 1);
select is(public.service_fail_crm_agent_job('e6151111-1111-4111-8111-111111111111',
  'e6999999-1111-4111-8111-111111111111', 'ai_quota_exhausted') ->> 'status', 'not_claimed',
  'quota: a wrong lease token cannot defer a job');

-- Backend only.
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$select public.service_fail_crm_agent_job('e6151111-1111-4111-8111-111111111111',
  'e6151111-1111-4111-8111-111111111111', 'ai_quota_exhausted')$$, '42501', 'backend only',
  'quota: the function stays backend-only');

select * from finish(true);
rollback;
