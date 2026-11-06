-- Durable, artist-scoped WhatsApp voice-note transcription.
-- Raw audio is never persisted. Private media ids are retained only for bounded retries.
create table crm_private.whatsapp_audio_transcription_jobs (
  id uuid primary key default gen_random_uuid(),
  communication_message_id uuid not null unique
    references public.communication_messages(id) on delete cascade,
  artist_id uuid not null,
  integration_key text not null,
  media_id text not null check (media_id ~ '^[0-9]{5,32}$'),
  state text not null default 'pending'
    check (state in ('pending', 'processing', 'done', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  next_attempt_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  error_code text check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint whatsapp_audio_lease_shape check (
    (state = 'processing' and lease_owner is not null and lease_expires_at is not null)
    or (state <> 'processing' and lease_owner is null and lease_expires_at is null)
  )
);
create index whatsapp_audio_pending_idx
  on crm_private.whatsapp_audio_transcription_jobs (next_attempt_at, created_at)
  where state in ('pending', 'processing');
alter table crm_private.whatsapp_audio_transcription_jobs enable row level security;
revoke all on crm_private.whatsapp_audio_transcription_jobs from public, anon, authenticated, service_role;

-- The public RPC namespace is reachable by PostgREST, but execution is
-- restricted to the service backend AND verified inside each function.
create or replace function public.service_queue_whatsapp_audio_transcription(
  p_artist_id uuid,
  p_integration_key text,
  p_provider_message_id text,
  p_media_id text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare v_message_id uuid;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode='42501';
  end if;
  if coalesce(p_media_id,'') !~ '^[0-9]{5,32}$'
     or coalesce(p_provider_message_id,'') !~ '^[A-Za-z0-9_=./-]{8,255}$'
     or coalesce(p_integration_key,'') !~ '^[a-z][a-z0-9_-]{2,79}$' then
    raise exception 'invalid audio route' using errcode='22023';
  end if;

  select m.id into v_message_id
  from public.communication_messages m
  join public.communication_conversations c on c.id = m.conversation_id
  where m.artist_id = p_artist_id
    and c.artist_id = p_artist_id
    and c.integration_key = p_integration_key
    and c.channel::text = 'whatsapp'
    and m.channel::text = 'whatsapp'
    and m.direction::text = 'inbound'
    and m.message_type = 'audio'
    and m.provider_message_id = p_provider_message_id
  order by m.created_at desc
  limit 1;

  if v_message_id is null then
    raise exception 'audio message not recorded for artist' using errcode='22023';
  end if;

  insert into crm_private.whatsapp_audio_transcription_jobs
    (communication_message_id,artist_id,integration_key,media_id)
  values (v_message_id,p_artist_id,p_integration_key,p_media_id)
  on conflict (communication_message_id) do nothing;

  if not exists (
    select 1 from crm_private.whatsapp_audio_transcription_jobs
    where communication_message_id=v_message_id
      and artist_id=p_artist_id and integration_key=p_integration_key
      and media_id=p_media_id
  ) then
    raise exception 'conflicting media id for message' using errcode='23514';
  end if;
  return jsonb_build_object('queued',true);
end;
$function$;

create or replace function public.service_claim_whatsapp_audio_transcriptions(
  p_worker_id text,
  p_limit integer default 3,
  p_lease_seconds integer default 180
)
returns table (job_id uuid, artist_id uuid, integration_key text, media_id text)
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $function$
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode='42501';
  end if;
  if coalesce(p_worker_id,'') !~ '^[a-z][a-z0-9_-]{2,127}$'
    or p_limit not between 1 and 3 or p_lease_seconds not between 60 and 600 then
    raise exception 'invalid lease' using errcode='22023';
  end if;
  update crm_private.whatsapp_audio_transcription_jobs j
  set state='failed', error_code='attempts_exhausted',
      lease_owner=null,lease_expires_at=null,finished_at=now(),updated_at=now()
  where state='processing' and attempts>=5 and lease_expires_at<now();

  return query
  with candidate as (
    select j.id from crm_private.whatsapp_audio_transcription_jobs j
    where (j.state='pending' and j.next_attempt_at<=now())
       or (j.state='processing' and j.lease_expires_at<now() and j.attempts<5)
    order by j.created_at, j.id
    limit p_limit for update skip locked
  )
  update crm_private.whatsapp_audio_transcription_jobs j
  set state='processing',attempts=j.attempts+1,
      lease_owner=p_worker_id,
      lease_expires_at=now() + make_interval(secs=>p_lease_seconds),
      updated_at=now()
  from candidate c where j.id=c.id
  returning j.id,j.artist_id,j.integration_key,j.media_id;
end;
$function$;

create or replace function public.service_complete_whatsapp_audio_transcription(
  p_job_id uuid,
  p_worker_id text,
  p_transcript text default null,
  p_error_code text default null
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare v_job crm_private.whatsapp_audio_transcription_jobs%rowtype;
        v_text text := btrim(coalesce(p_transcript,''));
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode='42501';
  end if;
  select * into v_job from crm_private.whatsapp_audio_transcription_jobs
  where id=p_job_id for update;
  if not found or v_job.state <> 'processing' or v_job.lease_owner <> p_worker_id
    or v_job.lease_expires_at <= now() then
    raise exception 'lease no longer owned' using errcode='23514';
  end if;
  if p_transcript is not null then
    if length(v_text) < 1 or length(v_text) > 4096 or p_error_code is not null then
      raise exception 'invalid transcript' using errcode='22023';
    end if;
    update public.communication_messages m set body=v_text,updated_at=now()
    where m.id=v_job.communication_message_id and m.artist_id=v_job.artist_id
      and m.direction::text='inbound' and m.channel::text='whatsapp'
      and m.message_type='audio' and (m.body is null or m.body=v_text);
    if not found then
      raise exception 'audio message changed or missing' using errcode='23514';
    end if;
    update crm_private.whatsapp_audio_transcription_jobs
    set state='done',lease_owner=null,lease_expires_at=null,finished_at=now(),
        updated_at=now(),error_code=null,media_id='00000'
    where id=p_job_id;
    return jsonb_build_object('completed',true);
  end if;
  if coalesce(p_error_code,'') !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'invalid error code' using errcode='22023';
  end if;
  update crm_private.whatsapp_audio_transcription_jobs
  set state=case when attempts>=5 then 'failed' else 'pending' end,
      next_attempt_at=now()+make_interval(mins=>least(30, attempts*3)),
      lease_owner=null,lease_expires_at=null,updated_at=now(),
      finished_at=case when attempts>=5 then now() else null end,
      error_code=p_error_code,
      media_id=case when attempts>=5 then '00000' else media_id end
  where id=p_job_id;
  return jsonb_build_object('completed',false);
end;
$function$;

revoke all on function public.service_queue_whatsapp_audio_transcription(uuid,text,text,text)
  from public,anon,authenticated;
revoke all on function public.service_claim_whatsapp_audio_transcriptions(text,integer,integer)
  from public,anon,authenticated;
revoke all on function public.service_complete_whatsapp_audio_transcription(uuid,text,text,text)
  from public,anon,authenticated;
grant execute on function public.service_queue_whatsapp_audio_transcription(uuid,text,text,text) to service_role;
grant execute on function public.service_claim_whatsapp_audio_transcriptions(text,integer,integer) to service_role;
grant execute on function public.service_complete_whatsapp_audio_transcription(uuid,text,text,text) to service_role;
