-- Bounded text-only AI intake. Models propose values; these RPCs never apply
-- them to client/enquiry fields, send messages, book appointments or payments.
-- No historical backfill. Deployment explicitly enables the private switch.
create table crm_private.enquiry_ai_config (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  images_enabled boolean not null default false check (images_enabled = false)
);
insert into crm_private.enquiry_ai_config default values;
revoke all on crm_private.enquiry_ai_config from public, anon, authenticated;
grant select, update on crm_private.enquiry_ai_config to service_role;

create table public.enquiry_ai_jobs (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.artists(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  enquiry_id uuid not null references public.enquiries(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  trigger_type text not null check (trigger_type in ('booking', 'gmail')),
  source_event_id text not null check (length(source_event_id) between 1 and 255),
  -- Private email text lives with the scoped job, never generic activity logs.
  source_text text check (length(source_text) <= 12000),
  gmail_thread_context_id uuid references crm_private.gmail_thread_contexts(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','processing','succeeded','failed','stale')),
  attempts integer not null default 0 check (attempts between 0 and 3),
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  snapshot_hash text,
  result jsonb,
  draft_id uuid references public.email_messages(id) on delete set null,
  provider text check (provider in ('qwen','workers_ai','openai')),
  model text check (length(model) <= 160),
  error_code text check (error_code in ('input_invalid','ai_unavailable','output_invalid','processing_failed','stale_input','lease_expired','scope_changed')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (artist_id, trigger_type, source_event_id),
  foreign key (enquiry_id, artist_id) references public.enquiries(id, artist_id) on delete cascade
);
create index enquiry_ai_jobs_drain_idx on public.enquiry_ai_jobs (available_at, created_at)
  where status in ('pending','processing');
create index enquiry_ai_jobs_enquiry_idx on public.enquiry_ai_jobs(enquiry_id,created_at desc);
alter table public.enquiry_ai_jobs enable row level security;
-- Reads are through the projection RPC: prompts/source_text/leases stay private.
revoke all on public.enquiry_ai_jobs from public, anon, authenticated;
grant select, insert, update, delete on public.enquiry_ai_jobs to service_role;
alter table public.email_messages add column ai_intake_job_id uuid
  references public.enquiry_ai_jobs(id) on delete set null;
create unique index email_messages_ai_intake_job_key on public.email_messages(ai_intake_job_id)
  where ai_intake_job_id is not null;

create function crm_private.validate_enquiry_ai_result(p_result jsonb)
returns boolean language plpgsql immutable set search_path = pg_catalog, public, crm_private as $$
declare
  v_names constant text[] := array['client_name','email','phone','project_description','concept','placement','style','approximate_size','colour','cover_up','budget','preferred_dates','reference_images_present','discovery_source','discovery_source_detail','notes'];
  v_key text; v_field jsonb; v_status text; v_missing text[]; v_expected text[] := '{}';
begin
  if p_result is null or jsonb_typeof(p_result) <> 'object'
    or not (p_result ?& array['fields','summary','missing_information','draft_reply'])
    or (p_result - array['fields','summary','missing_information','draft_reply']) <> '{}'::jsonb
    or jsonb_typeof(p_result->'fields') <> 'object'
    or not ((p_result->'fields') ?& v_names)
    or ((p_result->'fields') - v_names) <> '{}'::jsonb
    or jsonb_typeof(p_result->'summary') <> 'string'
    or length(btrim(p_result->>'summary')) not between 1 and 1200
    or jsonb_typeof(p_result->'draft_reply') <> 'string'
    or length(btrim(p_result->>'draft_reply')) not between 1 and 3000
    or p_result->>'draft_reply' ~* '(https?://|www\.|[£$€][[:space:]]*[0-9]|[0-9][[:space:]]*(gbp|usd|eur|pounds?|dollars?|euros?)\y|\y(confirmed|booked|guaranteed|available on|reserve|reserved|price is|costs?[[:space:]]+[0-9]|(will|would|should|takes?)[[:space:]]+[0-9]+[[:space:]]+sessions?|pay(ment)?[[:space:]]+(now|here|to)|send[[:space:]]+(a[[:space:]]+)?deposit|deposit[[:space:]]+(is|of|required)|ignore[[:space:]]+(previous|all)|system prompt)\y)'
    or jsonb_typeof(p_result->'missing_information') <> 'array'
    then return false; end if;
  foreach v_key in array v_names loop
    v_field := p_result->'fields'->v_key;
    if jsonb_typeof(v_field) <> 'object' or not (v_field ?& array['value','status'])
      or (v_field - array['value','status']) <> '{}'::jsonb
      or jsonb_typeof(v_field->'status') <> 'string' then return false; end if;
    v_status := v_field->>'status';
    if v_status not in ('explicit','inferred','missing') then return false; end if;
    if v_status = 'missing' then
      if v_field->'value' <> 'null'::jsonb then return false; end if;
      v_expected := array_append(v_expected, v_key);
    else
      if v_key in ('cover_up','reference_images_present') then
        if jsonb_typeof(v_field->'value') <> 'boolean' then return false; end if;
      else
        if jsonb_typeof(v_field->'value') <> 'string'
          or length(btrim(v_field->>'value')) not between 1 and
            case when v_key in ('project_description','notes') then 2000 else 500 end
          then return false; end if;
        if v_key = 'colour' and v_field->>'value' not in ('colour','black_and_grey','mixed') then return false; end if;
        if v_key = 'discovery_source' and v_field->>'value' not in ('instagram','chatgpt','other_ai','friend_referral','google','other') then return false; end if;
      end if;
    end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(p_result->'missing_information') x where jsonb_typeof(x) <> 'string') then return false; end if;
  select coalesce(array_agg(x order by x),'{}') into v_missing from jsonb_array_elements_text(p_result->'missing_information') x;
  select coalesce(array_agg(x order by x),'{}') into v_expected from unnest(v_expected) x;
  return v_missing = v_expected;
end;
$$;
revoke all on function crm_private.validate_enquiry_ai_result(jsonb) from public,anon,authenticated;

-- All invocations recompute scope from the real rows; even a tampered job cannot
-- choose another workspace. Private helper has no direct API grants.
create function crm_private.enquiry_ai_snapshot(p_enquiry_id uuid)
returns text language sql stable security definer set search_path = pg_catalog, public, crm_private as $$
  select encode(extensions.digest(convert_to(jsonb_build_object('enquiry',to_jsonb(e),'client',to_jsonb(c),'artist',to_jsonb(a))::text,'UTF8'),'sha256'),'hex')
  from public.enquiries e join public.clients c on c.id=e.client_id
  join public.artists a on a.id=e.artist_id
  where e.id=p_enquiry_id and c.workspace_id=a.workspace_id
    and e.archived_at is null and c.archived_at is null and a.is_active
    and e.intake_state='complete';
$$;
revoke all on function crm_private.enquiry_ai_snapshot(uuid) from public,anon,authenticated;

create function crm_private.enqueue_booking_enquiry_ai()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, crm_private as $$
begin
  if new.intake_state <> 'complete' or (tg_op = 'UPDATE' and old.intake_state = 'complete')
    or not coalesce((select enabled from crm_private.enquiry_ai_config where singleton),false)
    then return new; end if;
  -- AI queue failures cannot roll back an otherwise valid booking. This block
  -- deliberately emits no SQLERRM, prompt, source text or client identifiers.
  begin
    insert into public.enquiry_ai_jobs(artist_id,workspace_id,enquiry_id,client_id,trigger_type,source_event_id)
    select a.id,a.workspace_id,new.id,new.client_id,'booking',new.id::text
    from public.artists a join public.clients c on c.id=new.client_id and c.workspace_id=a.workspace_id
    where a.id=new.artist_id and a.is_active and new.archived_at is null
    on conflict (artist_id,trigger_type,source_event_id) do nothing;
  exception when others then null;
  end;
  return new;
end;
$$;
revoke all on function crm_private.enqueue_booking_enquiry_ai() from public,anon,authenticated;
create trigger enquiries_enqueue_ai after insert or update of intake_state on public.enquiries
  for each row execute function crm_private.enqueue_booking_enquiry_ai();

create function public.service_observe_gmail_enquiry_ai(
  p_artist_id uuid,p_enquiry_id uuid,p_client_id uuid,p_provider_thread_id text,p_subject text,
  p_last_provider_message_id text,p_last_rfc822_message_id text,p_source_text text default null
)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, crm_private as $$
declare
  v_workspace uuid; v_thread crm_private.gmail_thread_contexts%rowtype; v_context_id uuid; v_id uuid;
  v_seen_before boolean := false; v_message_changed boolean := false;
begin
  if not crm_private.is_service_backend() then raise exception 'backend only' using errcode='42501'; end if;
  if p_provider_thread_id is null or p_provider_thread_id !~ '^[A-Za-z0-9_-]{4,255}$'
    or p_last_provider_message_id is null or p_last_provider_message_id !~ '^[A-Za-z0-9_-]{4,255}$'
    or p_subject is null or length(btrim(p_subject)) not between 1 and 998
    or (p_last_rfc822_message_id is not null and length(btrim(p_last_rfc822_message_id)) not between 3 and 998)
    or (p_source_text is not null and length(btrim(p_source_text)) not between 1 and 12000)
    then raise exception 'invalid Gmail observation' using errcode='22023'; end if;
  select a.workspace_id into v_workspace from public.enquiries e
    join public.artists a on a.id=e.artist_id and a.is_active
    join public.clients c on c.id=e.client_id and c.workspace_id=a.workspace_id
    where e.id=p_enquiry_id and e.artist_id=p_artist_id and e.client_id=p_client_id
      and e.archived_at is null and c.archived_at is null and e.intake_state='complete';
  if not found then raise exception 'AI intake scope unavailable' using errcode='42501'; end if;
  -- One observer owns the provider thread at a time. A first observation only
  -- establishes a baseline, so opening old mail cannot backfill AI drafts.
  perform pg_advisory_xact_lock(hashtextextended('gmail-ai:'||p_artist_id::text||':'||p_provider_thread_id,0));
  select * into v_thread from crm_private.gmail_thread_contexts g
    where g.artist_id=p_artist_id and g.enquiry_id=p_enquiry_id and g.provider_thread_id=p_provider_thread_id
    for update;
  v_seen_before := found;
  v_message_changed := v_seen_before and v_thread.last_provider_message_id is distinct from p_last_provider_message_id;
  insert into crm_private.gmail_thread_contexts(artist_id,client_id,enquiry_id,provider_thread_id,subject,last_provider_message_id,last_rfc822_message_id)
    values(p_artist_id,p_client_id,p_enquiry_id,p_provider_thread_id,btrim(p_subject),p_last_provider_message_id,nullif(btrim(coalesce(p_last_rfc822_message_id,'')),''))
    on conflict(artist_id,enquiry_id,provider_thread_id) do update set
      client_id=excluded.client_id,subject=excluded.subject,last_provider_message_id=excluded.last_provider_message_id,
      last_rfc822_message_id=excluded.last_rfc822_message_id,updated_at=clock_timestamp()
    returning id into v_context_id;
  if not coalesce((select enabled from crm_private.enquiry_ai_config where singleton),false)
    or not v_message_changed or p_source_text is null
    then return jsonb_build_object('status','observed','thread_context_id',v_context_id); end if;
  if (select count(*) from public.enquiries e where e.artist_id=p_artist_id and e.client_id=p_client_id and e.archived_at is null) > 1
    or exists (select 1 from crm_private.gmail_thread_contexts g where g.artist_id=p_artist_id and g.provider_thread_id=p_provider_thread_id and g.enquiry_id<>p_enquiry_id)
    then return jsonb_build_object('status','ambiguous','thread_context_id',v_context_id); end if;
  insert into public.enquiry_ai_jobs(artist_id,workspace_id,enquiry_id,client_id,trigger_type,source_event_id,source_text,gmail_thread_context_id)
    values(p_artist_id,v_workspace,p_enquiry_id,p_client_id,'gmail',p_last_provider_message_id,p_source_text,v_context_id)
    on conflict(artist_id,trigger_type,source_event_id) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from public.enquiry_ai_jobs where artist_id=p_artist_id and trigger_type='gmail' and source_event_id=p_last_provider_message_id and enquiry_id=p_enquiry_id;
    return jsonb_build_object('status','existing','job_id',v_id,'thread_context_id',v_context_id);
  end if;
  return jsonb_build_object('status','queued','job_id',v_id,'thread_context_id',v_context_id);
end;
$$;

create function public.service_claim_enquiry_ai_jobs(p_limit integer default 1,p_enquiry_id uuid default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, crm_private as $$
declare v_job public.enquiry_ai_jobs%rowtype; v_input jsonb; v_out jsonb := '[]'; v_hash text; v_token uuid;
begin
  if not crm_private.is_service_backend() then raise exception 'backend only' using errcode='42501'; end if;
  if not coalesce((select enabled from crm_private.enquiry_ai_config where singleton),false) then return v_out; end if;
  update public.enquiry_ai_jobs set status='failed',error_code='lease_expired',lease_token=null,lease_until=null,updated_at=clock_timestamp()
    where status='processing' and lease_until<clock_timestamp() and attempts>=3;
  for v_job in select j.* from public.enquiry_ai_jobs j
    where (p_enquiry_id is null or j.enquiry_id=p_enquiry_id) and j.attempts<3
      and ((j.status='pending' and j.available_at<=clock_timestamp()) or (j.status='processing' and j.lease_until<clock_timestamp()))
      and not exists(select 1 from public.enquiry_ai_jobs busy where busy.enquiry_id=j.enquiry_id and busy.id<>j.id and busy.status='processing' and busy.lease_until>=clock_timestamp())
    order by j.created_at desc for update skip locked
  loop
    if jsonb_array_length(v_out)>=greatest(1,least(coalesce(p_limit,1),5)) then exit; end if;
    if not pg_try_advisory_xact_lock(hashtextextended('enquiry-ai:'||v_job.enquiry_id::text,0)) then continue; end if;
    if exists(select 1 from public.enquiry_ai_jobs busy where busy.enquiry_id=v_job.enquiry_id and busy.id<>v_job.id and busy.status='processing' and busy.lease_until>=clock_timestamp()) then continue; end if;
    v_hash:=crm_private.enquiry_ai_snapshot(v_job.enquiry_id);
    select jsonb_build_object(
      'client',jsonb_build_object('full_name',c.full_name,'email',c.email,'phone',c.phone,'preferred_contact',c.preferred_contact),
      'enquiry',jsonb_build_object('submitted_full_name',e.submitted_full_name,'submitted_email',e.submitted_email,'submitted_phone',e.submitted_phone,
        'project_type',e.project_type,'placement',e.placement,'approximate_size',e.approximate_size,'cover_up',e.cover_up,'preferred_timing',e.preferred_timing,'idea',e.idea,
        'discovery_source',e.discovery_source,'discovery_source_detail',e.discovery_source_detail),
      'artist',jsonb_build_object('display_name',a.display_name,'timezone',a.timezone,'currency',a.default_currency),
      'reference_images_present',exists(select 1 from public.enquiry_files f where f.enquiry_id=e.id and f.upload_state='ready'),
      'trigger_type',v_job.trigger_type,'source_text',v_job.source_text
    ) into v_input from public.enquiries e join public.artists a on a.id=e.artist_id
      join public.clients c on c.id=e.client_id and c.workspace_id=a.workspace_id
      where e.id=v_job.enquiry_id and e.artist_id=v_job.artist_id and e.client_id=v_job.client_id and a.workspace_id=v_job.workspace_id;
    if v_hash is null or v_input is null then
      update public.enquiry_ai_jobs set status='failed',error_code='scope_changed',lease_token=null,lease_until=null,updated_at=clock_timestamp() where id=v_job.id;
      continue;
    end if;
    v_token:=gen_random_uuid();
    update public.enquiry_ai_jobs set status='processing',attempts=attempts+1,lease_token=v_token,lease_until=clock_timestamp()+interval '5 minutes',snapshot_hash=v_hash,error_code=null,updated_at=clock_timestamp() where id=v_job.id;
    v_out:=v_out||jsonb_build_object('job_id',v_job.id,'lease_token',v_token,'enquiry_id',v_job.enquiry_id,'artist_id',v_job.artist_id,'workspace_id',v_job.workspace_id,'input',v_input);
  end loop;
  return v_out;
end;
$$;

create function public.service_complete_enquiry_ai_job(p_job_id uuid,p_lease_token uuid,p_result jsonb,p_provider text,p_model text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, crm_private as $$
declare v_job public.enquiry_ai_jobs%rowtype; v_enquiry public.enquiries%rowtype; v_client public.clients%rowtype; v_artist public.artists%rowtype; v_draft uuid; v_email text;
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
  v_email:=coalesce(nullif(btrim(v_client.email),''),v_enquiry.submitted_email);
  insert into public.email_messages(artist_id,client_id,enquiry_id,status,to_email,subject,body,created_by_kind,ai_intake_job_id,gmail_thread_context_id)
    values(v_job.artist_id,v_job.client_id,v_job.enquiry_id,'draft',v_email,
      'Re: Your tattoo enquiry '||v_enquiry.reference_number,p_result->>'draft_reply','ai',v_job.id,v_job.gmail_thread_context_id)
    returning id into v_draft;
  update public.enquiry_ai_jobs set status='succeeded',result=p_result,draft_id=v_draft,provider=p_provider,model=p_model,
    source_text=null,lease_token=null,lease_until=null,error_code=null,updated_at=clock_timestamp() where id=v_job.id;
  perform crm_private.log_artist_activity(v_job.artist_id,'enquiry.ai_completed','worker',null,v_job.client_id,v_job.enquiry_id,null,null,null,
    jsonb_build_object('job_id',v_job.id,'trigger_type',v_job.trigger_type,'provider',p_provider,'model',p_model,'crm_fields_changed',false,'draft_generated',true));
  return jsonb_build_object('status','succeeded','job_id',v_job.id,'draft_id',v_draft,'crm_fields_changed',false);
end;
$$;

create function public.service_fail_enquiry_ai_job(p_job_id uuid,p_lease_token uuid,p_error_code text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, crm_private as $$
declare v_job public.enquiry_ai_jobs%rowtype; v_status text; v_code text;
begin
  if not crm_private.is_service_backend() then raise exception 'backend only' using errcode='42501'; end if;
  v_code:=case when p_error_code in ('input_invalid','ai_unavailable','output_invalid','processing_failed') then p_error_code else 'processing_failed' end;
  select * into v_job from public.enquiry_ai_jobs where id=p_job_id for update;
  if not found or v_job.status<>'processing' or v_job.lease_token is distinct from p_lease_token or v_job.lease_until<=clock_timestamp()
    then return jsonb_build_object('status','not_claimed'); end if;
  v_status:=case when v_job.attempts<3 then 'pending' else 'failed' end;
  update public.enquiry_ai_jobs set status=v_status,error_code=v_code,available_at=clock_timestamp()+interval '5 minutes',lease_token=null,lease_until=null,updated_at=clock_timestamp() where id=v_job.id;
  perform crm_private.log_artist_activity(v_job.artist_id,'enquiry.ai_failed','worker',null,v_job.client_id,v_job.enquiry_id,null,null,null,
    jsonb_build_object('job_id',v_job.id,'trigger_type',v_job.trigger_type,'error_code',v_code,'status',v_status));
  return jsonb_build_object('status',v_status,'error_code',v_code);
end;
$$;

create function public.get_enquiry_ai_result(p_enquiry_id uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public, crm_private as $$
declare v_artist uuid; v_job public.enquiry_ai_jobs%rowtype; v_draft jsonb; v_enabled boolean;
begin
  select e.artist_id into v_artist from public.enquiries e join public.artists a on a.id=e.artist_id
    join public.clients c on c.id=e.client_id and c.workspace_id=a.workspace_id
    where e.id=p_enquiry_id and e.archived_at is null;
  if not found then raise exception 'enquiry unavailable' using errcode='42501'; end if;
  perform crm_private.require_artist_access(v_artist,'view');
  select enabled into v_enabled from crm_private.enquiry_ai_config where singleton;
  select * into v_job from public.enquiry_ai_jobs where enquiry_id=p_enquiry_id and artist_id=v_artist order by created_at desc limit 1;
  if not found then return jsonb_build_object('enabled',v_enabled,'status','not_requested'); end if;
  select jsonb_build_object('id',m.id,'body',m.body,'subject',m.subject,'status',m.status,'updated_at',m.updated_at) into v_draft
    from public.email_messages m where m.id=v_job.draft_id and m.artist_id=v_artist and m.enquiry_id=p_enquiry_id and m.client_id=v_job.client_id;
  return jsonb_build_object('enabled',v_enabled,'status',v_job.status,'job_id',v_job.id,'trigger_type',v_job.trigger_type,'attempts',v_job.attempts,
    'error_code',v_job.error_code,'result',v_job.result,'draft',v_draft,'updated_at',v_job.updated_at);
end;
$$;

create function public.retry_enquiry_ai(p_enquiry_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, crm_private as $$
declare v_enquiry public.enquiries%rowtype; v_job public.enquiry_ai_jobs%rowtype; v_workspace uuid;
begin
  select * into v_enquiry from public.enquiries where id=p_enquiry_id and archived_at is null for update;
  if not found then raise exception 'enquiry unavailable' using errcode='42501'; end if;
  perform crm_private.require_artist_access(v_enquiry.artist_id,'manage');
  perform crm_private.require_active_artist(v_enquiry.artist_id);
  if not coalesce((select enabled from crm_private.enquiry_ai_config where singleton),false) then return public.get_enquiry_ai_result(p_enquiry_id); end if;
  select a.workspace_id into v_workspace from public.artists a join public.clients c on c.workspace_id=a.workspace_id where a.id=v_enquiry.artist_id and c.id=v_enquiry.client_id and c.archived_at is null;
  if not found or v_enquiry.intake_state<>'complete' then raise exception 'enquiry unavailable' using errcode='42501'; end if;
  select * into v_job from public.enquiry_ai_jobs where enquiry_id=p_enquiry_id order by created_at desc limit 1 for update;
  if not found then
    insert into public.enquiry_ai_jobs(artist_id,workspace_id,enquiry_id,client_id,trigger_type,source_event_id)
      values(v_enquiry.artist_id,v_workspace,p_enquiry_id,v_enquiry.client_id,'booking',p_enquiry_id::text)
      on conflict(artist_id,trigger_type,source_event_id) do nothing;
  elsif v_job.status in ('failed','stale','pending') or (v_job.status='processing' and v_job.lease_until<clock_timestamp()) then
    update public.enquiry_ai_jobs set status='pending',attempts=0,available_at=clock_timestamp(),lease_token=null,lease_until=null,error_code=null,updated_at=clock_timestamp() where id=v_job.id;
  end if;
  return public.get_enquiry_ai_result(p_enquiry_id);
end;
$$;

create function public.edit_email_draft(p_message_id uuid,p_body text,p_expected_updated_at timestamptz)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, crm_private as $$
declare v_msg public.email_messages%rowtype;
begin
  select * into v_msg from public.email_messages where id=p_message_id for update;
  if not found then raise exception 'draft unavailable' using errcode='42501'; end if;
  perform crm_private.require_artist_access(v_msg.artist_id,'manage');
  perform crm_private.require_active_artist(v_msg.artist_id);
  if v_msg.status<>'draft' or p_expected_updated_at is null or v_msg.updated_at<>p_expected_updated_at
    then raise exception 'draft changed; reload before editing' using errcode='40001'; end if;
  if p_body is null or length(btrim(p_body)) not between 1 and 40000 then raise exception 'invalid draft body' using errcode='22023'; end if;
  if not exists(
    select 1 from public.artists a
    join public.clients c on c.workspace_id=a.workspace_id and c.id=v_msg.client_id and c.archived_at is null
    left join public.enquiries e on e.id=v_msg.enquiry_id and e.artist_id=a.id and e.client_id=c.id and e.archived_at is null
    where a.id=v_msg.artist_id and a.is_active and (v_msg.enquiry_id is null or e.id is not null)
  )
    then raise exception 'draft scope unavailable' using errcode='42501'; end if;
  update public.email_messages set body=p_body where id=p_message_id returning * into v_msg;
  return jsonb_build_object('id',v_msg.id,'body',v_msg.body,'subject',v_msg.subject,'status',v_msg.status,'updated_at',v_msg.updated_at);
end;
$$;

revoke all on function public.service_observe_gmail_enquiry_ai(uuid,uuid,uuid,text,text,text,text,text),
  public.service_claim_enquiry_ai_jobs(integer,uuid),public.service_complete_enquiry_ai_job(uuid,uuid,jsonb,text,text),
  public.service_fail_enquiry_ai_job(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.service_observe_gmail_enquiry_ai(uuid,uuid,uuid,text,text,text,text,text),
  public.service_claim_enquiry_ai_jobs(integer,uuid),public.service_complete_enquiry_ai_job(uuid,uuid,jsonb,text,text),
  public.service_fail_enquiry_ai_job(uuid,uuid,text) to service_role;
revoke all on function public.get_enquiry_ai_result(uuid),public.retry_enquiry_ai(uuid),public.edit_email_draft(uuid,text,timestamptz) from public,anon,service_role;
grant execute on function public.get_enquiry_ai_result(uuid),public.retry_enquiry_ai(uuid),public.edit_email_draft(uuid,text,timestamptz) to authenticated;
