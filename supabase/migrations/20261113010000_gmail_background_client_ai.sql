-- Bounded background Gmail -> client AI memory. No enquiry-AI queue, draft or send path.
-- The activation timestamp is created at schema apply time: old mailbox history
-- remains metadata-only even if it appears in the first Gmail page after release.

create table if not exists crm_private.gmail_background_ai_capture_config (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  activated_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
revoke all on crm_private.gmail_background_ai_capture_config
  from public, anon, authenticated, service_role;

insert into crm_private.gmail_background_ai_capture_config
  (singleton, enabled, activated_at)
values (true, true, clock_timestamp())
on conflict (singleton) do nothing;

comment on table crm_private.gmail_background_ai_capture_config is
  'Backend-only independent kill switch and no-backfill cutoff for new Gmail client memory. Disable enabled to stop background capture without touching Gmail, CRM agent or legacy enquiry AI.';

-- First stage: check message metadata without fetching any Gmail body.
-- The Worker supplies at most 20 provider ids already seen on a mailbox page.
-- Only new, direct, post-activation mail for a known client can be selected.
create or replace function public.service_select_background_gmail_ai_candidates(
  p_artist_id uuid,
  p_mailbox_email text,
  p_candidates jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_cutoff timestamptz;
  v_enabled boolean;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;

  select enabled, activated_at into v_enabled, v_cutoff
  from crm_private.gmail_background_ai_capture_config where singleton;
  if not coalesce(v_enabled, false)
     or not coalesce((select enabled from crm_private.crm_agent_config where singleton),false)
  then return '[]'::jsonb; end if;

  if p_artist_id is null or p_mailbox_email is null
     or jsonb_typeof(p_candidates) is distinct from 'array'
     or jsonb_array_length(p_candidates) > 20
     or pg_column_size(p_candidates) > 16000 then
    raise exception 'invalid background Gmail candidate batch' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.artist_integrations i
    join crm_private.artist_state a on a.artist_id=i.artist_id and a.is_active
    where i.artist_id=p_artist_id
      and i.integration_type = 'email'::public.artist_integration_type
      and i.provider='google' and i.is_enabled
      and lower(btrim(i.external_account_label)) = lower(btrim(p_mailbox_email))
  ) then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(newest) order by newest.occurred_at desc)
    from (
      select distinct
        x.provider_message_id,
        x.provider_thread_id,
        x.client_id,
        x.client_email,
        x.occurred_at
      from jsonb_to_recordset(p_candidates) as x(
        provider_message_id text, provider_thread_id text,
        client_id uuid, client_email text, occurred_at timestamptz
      )
      join public.clients c on c.id=x.client_id and c.archived_at is null
      where x.provider_message_id ~ '^[A-Za-z0-9_-]{4,255}$'
        and x.provider_thread_id ~ '^[A-Za-z0-9_-]{4,255}$'
        and x.client_email is not null
        and lower(btrim(c.email)) = lower(btrim(x.client_email))
        and x.occurred_at >= v_cutoff
        and x.occurred_at <= clock_timestamp() + interval '2 minutes'
        and crm_private.client_ai_scope(p_artist_id,c.id) is not null
        and not exists (
          select 1 from crm_private.gmail_client_ai_excerpts e
          where e.artist_id=p_artist_id and e.client_id=x.client_id
            and e.provider_message_id=x.provider_message_id
        )
      order by x.occurred_at desc, x.provider_message_id
      limit 2
    ) newest
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.service_select_background_gmail_ai_candidates(uuid,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.service_select_background_gmail_ai_candidates(uuid,text,jsonb)
  to service_role;

-- Second stage: the Worker has already fetched the selected Gmail message,
-- verified full-message id/thread, From/To, no group/CC/BCC and short body.
-- Check the independent database gate and relationships again at write time.
create or replace function public.service_record_background_gmail_ai_message(
  p_artist_id uuid,
  p_client_id uuid,
  p_client_email text,
  p_mailbox_email text,
  p_provider_thread_id text,
  p_provider_message_id text,
  p_subject text,
  p_body text,
  p_occurred_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $function$
declare
  v_cutoff timestamptz;
  v_enabled boolean;
  v_workspace uuid;
  v_body text;
  v_id uuid;
begin
  if not crm_private.is_service_backend() then
    raise exception 'backend only' using errcode = '42501';
  end if;

  select enabled, activated_at into v_enabled, v_cutoff
  from crm_private.gmail_background_ai_capture_config where singleton;
  if not coalesce(v_enabled,false)
     or not coalesce((select enabled from crm_private.crm_agent_config where singleton),false)
  then return jsonb_build_object('status','disabled'); end if;

  if p_artist_id is null or p_client_id is null
     or p_client_email is null or p_mailbox_email is null
     or p_provider_thread_id !~ '^[A-Za-z0-9_-]{4,255}$'
     or p_provider_message_id !~ '^[A-Za-z0-9_-]{4,255}$'
     or (p_subject is not null and length(p_subject)>998)
     or p_body is null or length(p_body)>4000
     or p_occurred_at is null
  then raise exception 'invalid background Gmail message' using errcode='22023'; end if;

  -- Post-migration/provider chronology is the backfill boundary, not read time.
  if p_occurred_at < v_cutoff or p_occurred_at > clock_timestamp()+interval '2 minutes' then
    return jsonb_build_object('status','outside_capture_window');
  end if;

  if not exists (
    select 1 from public.artist_integrations i
    join crm_private.artist_state a on a.artist_id=i.artist_id and a.is_active
    where i.artist_id=p_artist_id
      and i.integration_type='email'::public.artist_integration_type
      and i.provider='google' and i.is_enabled
      and lower(btrim(i.external_account_label))=lower(btrim(p_mailbox_email))
  ) or not exists (
    select 1 from public.clients c
    where c.id=p_client_id and c.archived_at is null
      and lower(btrim(c.email))=lower(btrim(p_client_email))
  ) then return jsonb_build_object('status','scope_unavailable'); end if;

  v_workspace := crm_private.client_ai_scope(p_artist_id,p_client_id);
  if v_workspace is null then return jsonb_build_object('status','scope_unavailable'); end if;

  v_body := left(btrim(replace(p_body,chr(0),'')),3500);
  if v_body = '' then return jsonb_build_object('status','empty'); end if;

  insert into crm_private.gmail_client_ai_excerpts (
    artist_id,workspace_id,client_id,enquiry_id,
    provider_thread_id,provider_message_id,direction,subject,body_excerpt,occurred_at
  ) values (
    p_artist_id,v_workspace,p_client_id,null,
    p_provider_thread_id,p_provider_message_id,'inbound',
    nullif(left(btrim(coalesce(p_subject,'')),500),''),v_body,p_occurred_at
  )
  on conflict (artist_id,client_id,provider_message_id) do nothing
  returning id into v_id;

  if v_id is null then return jsonb_build_object('status','existing'); end if;

  delete from crm_private.gmail_client_ai_excerpts e
  where e.artist_id=p_artist_id and e.client_id=p_client_id
    and e.id not in (
      select k.id from crm_private.gmail_client_ai_excerpts k
      where k.artist_id=p_artist_id and k.client_id=p_client_id
      order by k.occurred_at desc,k.id desc
      limit 5
    );

  perform crm_private.schedule_client_ai_refresh(
    p_artist_id,p_client_id,'gmail:'||p_provider_message_id
  );
  return jsonb_build_object('status','recorded');
end;
$function$;

revoke all on function public.service_record_background_gmail_ai_message(
  uuid,uuid,text,text,text,text,text,text,timestamptz
) from public, anon, authenticated;
grant execute on function public.service_record_background_gmail_ai_message(
  uuid,uuid,text,text,text,text,text,text,timestamptz
) to service_role;

comment on function public.service_record_background_gmail_ai_message(
  uuid,uuid,text,text,text,text,text,text,timestamptz
) is 'Service-only bounded, idempotent Gmail inbound excerpt. Client AI refresh only; does not enqueue legacy enquiry AI, draft messages or send.';
