-- 20261115120000_crm_agent_quota_deferral.sql
--
-- Resilience review (2026-11-15), scenario "AI unavailable / quota spent".
--
-- The daily Cloudflare Neuron allocation is one account-wide budget. Once it
-- is spent every model call is refused until 00:00 UTC, and the router does
-- not even try a fallback on the same allocation. A CRM agent job that met
-- this refusal was treated like any transient failure: three attempts with a
-- 5- then 30-minute backoff, all inside the same exhausted day, then terminal
-- `failed/ai_unavailable`. On 13 November 2026 thirty jobs ended this way in
-- production and the client briefs were refreshed only if a later event
-- happened to queue a new job.
--
-- A quota refusal says nothing about the job, so it no longer spends the
-- job's attempt budget:
--   * the Worker reports the new bounded code `ai_quota_exhausted`;
--   * the job goes back to `pending`, the attempt is handed back, and it
--     becomes available shortly after the next 00:00 UTC, when the
--     allocation resets (with jitter so a backlog does not arrive at once);
--   * the deferral is bounded: a job older than 48 hours fails for good and
--     reaches the existing operational failure alert;
--   * every other code keeps the M-6 policy exactly.
--
-- Deploy order is free. The current Worker never sends the new code. A new
-- Worker against the previous function has the code folded into
-- `processing_failed`, which is the previous behaviour.
--
-- Derived AI state only. Nothing here sends anything to a client, and model
-- spend can only go down: two guaranteed-to-fail calls per job are removed.

alter table public.crm_agent_jobs
  drop constraint crm_agent_jobs_error_code_check;

alter table public.crm_agent_jobs
  add constraint crm_agent_jobs_error_code_check
  check (error_code = any (array[
    'input_invalid'::text, 'ai_unavailable'::text, 'output_invalid'::text,
    'processing_failed'::text, 'stale_input'::text, 'lease_expired'::text,
    'scope_changed'::text, 'image_unavailable'::text, 'image_unsupported'::text,
    'ai_quota_exhausted'::text
  ]));

CREATE OR REPLACE FUNCTION public.service_fail_crm_agent_job(p_job_id uuid, p_lease_token uuid, p_error_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare
  v_job public.crm_agent_jobs%rowtype;
  v_status text;
  v_code text;
  v_available_at timestamptz;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;

  -- An unrecognised code becomes the generic one rather than being stored: the
  -- column is a closed vocabulary and a Worker must not widen it.
  v_code := case
    when p_error_code in ('input_invalid','ai_unavailable','output_invalid',
                          'processing_failed','image_unavailable','image_unsupported',
                          'ai_quota_exhausted')
      then p_error_code
    else 'processing_failed'
  end;

  select j.* into v_job from public.crm_agent_jobs j where j.id = p_job_id for update;
  if not found or v_job.status <> 'processing'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_until <= clock_timestamp() then
    return jsonb_build_object('status', 'not_claimed');
  end if;

  if v_code = 'ai_quota_exhausted' then
    -- The spent daily allocation is not this job's failure. Hand the attempt
    -- back and wait for the reset instead of burning the budget inside the
    -- same exhausted day. Bounded by the job's age so it cannot wait forever.
    if v_job.created_at > clock_timestamp() - interval '48 hours' then
      v_available_at := date_trunc('day', clock_timestamp() at time zone 'UTC') at time zone 'UTC'
        + interval '1 day' + interval '5 minutes' + random() * interval '10 minutes';
      update public.crm_agent_jobs
      set status = 'pending', error_code = v_code,
          attempts = greatest(v_job.attempts - 1, 0),
          available_at = v_available_at,
          lease_token = null, lease_until = null, updated_at = clock_timestamp()
      where id = v_job.id;
      return jsonb_build_object('status', 'pending', 'error_code', v_code, 'deferred', true);
    end if;

    update public.crm_agent_jobs
    set status = 'failed', error_code = v_code,
        lease_token = null, lease_until = null, updated_at = clock_timestamp()
    where id = v_job.id;
    return jsonb_build_object('status', 'failed', 'error_code', v_code);
  end if;

  -- Two of these codes describe the object, not the call, so retrying is
  -- pointless and the job ends now.
  v_status := case
    when v_code in ('image_unavailable','image_unsupported','input_invalid') then 'failed'
    when v_job.attempts < 3 then 'pending'
    else 'failed'
  end;

  update public.crm_agent_jobs
  set status = v_status, error_code = v_code,
      available_at = clock_timestamp() + case
        when v_job.attempts <= 1 then interval '5 minutes'
        else interval '30 minutes'
      end,
      lease_token = null, lease_until = null, updated_at = clock_timestamp()
  where id = v_job.id;

  return jsonb_build_object('status', v_status, 'error_code', v_code);
end;
$function$;
