-- 20260923040000_ai_job_retry_policy.sql
--
-- Audit M-6 (2026-09-22). Both AI job queues already stop after three
-- attempts, but every failure waited a flat five minutes and a permanent
-- input_invalid refusal was retried twice more, paying for model calls that
-- could not succeed. The policy is now:
--   * input_invalid (and, for the CRM agent, the two image codes) end the job
--     at once: the input will not change between attempts;
--   * transient codes (ai_unavailable, output_invalid, processing_failed) keep
--     the existing three-attempt ceiling with exponential backoff: 5 minutes
--     after the first failure, 30 after the second, so a short provider
--     outage no longer exhausts the budget in ten minutes;
--   * attempts never increase, so spend can only go down;
--   * a final failure stays visible through the H-5 operational alert.
-- Nothing here sends AI output to a client.

CREATE OR REPLACE FUNCTION public.service_fail_enquiry_ai_job(p_job_id uuid, p_lease_token uuid, p_error_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'crm_private'
AS $function$
declare v_job public.enquiry_ai_jobs%rowtype; v_status text; v_code text;
begin
  if not crm_private.is_service_backend() then raise exception 'backend only' using errcode='42501'; end if;
  v_code:=case when p_error_code in ('input_invalid','ai_unavailable','output_invalid','processing_failed') then p_error_code else 'processing_failed' end;
  select * into v_job from public.enquiry_ai_jobs where id=p_job_id for update;
  if not found or v_job.status<>'processing' or v_job.lease_token is distinct from p_lease_token or v_job.lease_until<=clock_timestamp()
    then return jsonb_build_object('status','not_claimed'); end if;
  v_status:=case when v_code='input_invalid' then 'failed' when v_job.attempts<3 then 'pending' else 'failed' end;
  update public.enquiry_ai_jobs set status=v_status,error_code=v_code,
    available_at=clock_timestamp()+case when v_job.attempts<=1 then interval '5 minutes' else interval '30 minutes' end,lease_token=null,lease_until=null,updated_at=clock_timestamp() where id=v_job.id;
  perform crm_private.log_artist_activity(v_job.artist_id,'enquiry.ai_failed','worker',null,v_job.client_id,v_job.enquiry_id,null,null,null,
    jsonb_build_object('job_id',v_job.id,'trigger_type',v_job.trigger_type,'error_code',v_code,'status',v_status));
  return jsonb_build_object('status',v_status,'error_code',v_code);
end;
$function$;

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
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;

  -- An unrecognised code becomes the generic one rather than being stored: the
  -- column is a closed vocabulary and a Worker must not widen it.
  v_code := case
    when p_error_code in ('input_invalid','ai_unavailable','output_invalid',
                          'processing_failed','image_unavailable','image_unsupported')
      then p_error_code
    else 'processing_failed'
  end;

  select j.* into v_job from public.crm_agent_jobs j where j.id = p_job_id for update;
  if not found or v_job.status <> 'processing'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_until <= clock_timestamp() then
    return jsonb_build_object('status', 'not_claimed');
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

