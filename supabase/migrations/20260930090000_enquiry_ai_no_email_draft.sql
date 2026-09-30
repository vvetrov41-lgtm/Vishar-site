-- 20260930090000_enquiry_ai_no_email_draft.sql
--
-- The owner asked for automatic AI reply drafts to be removed: the drafts were
-- not usable, and the CRM already hid them from every work queue. The intake
-- analysis itself (structured summary, missing information) stays; only the
-- email_messages row it used to create is dropped.
--
-- 1. service_complete_enquiry_ai_job no longer inserts an AI email draft.
--    Its return shape keeps 'draft_id' (always null) so the current worker,
--    which only reads 'status', keeps working unchanged.
-- 2. Every existing automatic intake draft (ai_intake_job_id set) that was
--    never approved is cancelled. Drafts the owner explicitly asked a GPT
--    action to write are also created_by_kind='ai' but carry no intake job;
--    they are left alone. Nothing is deleted, so history and foreign keys stay
--    intact, and a cancelled row can never be approved, queued or sent.

create or replace function public.service_complete_enquiry_ai_job(p_job_id uuid,p_lease_token uuid,p_result jsonb,p_provider text,p_model text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, crm_private as $$
declare v_job public.enquiry_ai_jobs%rowtype; v_enquiry public.enquiries%rowtype; v_client public.clients%rowtype; v_artist public.artists%rowtype;
begin
  if not crm_private.is_service_backend() then raise exception 'backend only' using errcode='42501'; end if;
  if not crm_private.validate_enquiry_ai_result(p_result) or p_provider is null or p_provider not in ('qwen','workers_ai','openai')
    or p_model is null or length(p_model) not between 1 and 160 or p_model !~ '^[@a-zA-Z0-9/_.:-]+$'
    then raise exception 'invalid structured AI result' using errcode='22023'; end if;
  select * into v_job from public.enquiry_ai_jobs where id=p_job_id for update;
  if not found or v_job.status<>'processing' or v_job.lease_token is distinct from p_lease_token or v_job.lease_until<=clock_timestamp()
    then return jsonb_build_object('status','not_claimed'); end if;
  if not coalesce((select enabled from crm_private.enquiry_ai_config where singleton),false) then return jsonb_build_object('status','disabled'); end if;
  select * into v_enquiry from public.enquiries where id=v_job.enquiry_id for update;
  select * into v_client from public.clients where id=v_enquiry.client_id for update;
  select * into v_artist from public.artists where id=v_enquiry.artist_id for share;
  if v_enquiry.artist_id is distinct from v_job.artist_id or v_enquiry.client_id is distinct from v_job.client_id
    or v_client.workspace_id is distinct from v_job.workspace_id or v_artist.workspace_id is distinct from v_job.workspace_id
    or not coalesce(v_artist.is_active,false)
    then
      update public.enquiry_ai_jobs set status='failed',error_code='scope_changed',lease_token=null,lease_until=null,updated_at=clock_timestamp() where id=v_job.id;
      return jsonb_build_object('status','failed','error_code','scope_changed');
  end if;
  if crm_private.enquiry_ai_snapshot(v_job.enquiry_id) is distinct from v_job.snapshot_hash
    or exists(select 1 from public.enquiry_ai_jobs newer where newer.enquiry_id=v_job.enquiry_id and newer.created_at>v_job.created_at)
    or (v_job.trigger_type='gmail' and not exists(select 1 from crm_private.gmail_thread_contexts g where g.id=v_job.gmail_thread_context_id and g.artist_id=v_job.artist_id and g.enquiry_id=v_job.enquiry_id and g.client_id=v_job.client_id and g.last_provider_message_id=v_job.source_event_id))
    then
      update public.enquiry_ai_jobs set status='stale',error_code='stale_input',lease_token=null,lease_until=null,updated_at=clock_timestamp() where id=v_job.id;
      return jsonb_build_object('status','stale');
  end if;
  update public.enquiry_ai_jobs set status='succeeded',result=p_result,draft_id=null,provider=p_provider,model=p_model,
    source_text=null,lease_token=null,lease_until=null,error_code=null,updated_at=clock_timestamp() where id=v_job.id;
  perform crm_private.log_artist_activity(v_job.artist_id,'enquiry.ai_completed','worker',null,v_job.client_id,v_job.enquiry_id,null,null,null,
    jsonb_build_object('job_id',v_job.id,'trigger_type',v_job.trigger_type,'provider',p_provider,'model',p_model,'crm_fields_changed',false,'draft_generated',false));
  return jsonb_build_object('status','succeeded','job_id',v_job.id,'draft_id',null,'crm_fields_changed',false);
end;
$$;

revoke all on function public.service_complete_enquiry_ai_job(uuid,uuid,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.service_complete_enquiry_ai_job(uuid,uuid,jsonb,text,text) to service_role;

update public.email_messages
set status = 'cancelled'
where created_by_kind = 'ai'
  and ai_intake_job_id is not null
  and status = 'draft'
  and approved_at is null;
