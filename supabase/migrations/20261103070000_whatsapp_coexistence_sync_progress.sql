-- Exactly-once Meta Coexistence sync handshake. No contact or message PII.
-- An ambiguous Graph response remains claimed and must NOT be retried blindly.
create table crm_private.whatsapp_coexistence_sync_progress (
  artist_id uuid not null references public.artists(id) on delete restrict,
  sync_type text not null check (sync_type in ('smb_app_state_sync','history')),
  waba_id text not null check (waba_id ~ '^[0-9]{5,32}$'),
  phone_number_id text not null check (phone_number_id ~ '^[0-9]{5,32}$'),
  state text not null check (state in ('claimed','accepted')),
  claimed_at timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (artist_id, sync_type),
  constraint coexistence_sync_acceptance_consistent check (
    (state='claimed' and accepted_at is null) or
    (state='accepted' and accepted_at is not null)
  )
);
alter table crm_private.whatsapp_coexistence_sync_progress enable row level security;
revoke all on crm_private.whatsapp_coexistence_sync_progress from public,anon,authenticated,service_role;

create function public.claim_whatsapp_coexistence_sync(
  p_artist_id uuid, p_waba_id text, p_phone_number_id text, p_sync_type text
)
returns text language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $function$
declare v_state text;
declare v_claimed timestamptz;
declare v_waba text;
declare v_phone text;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_integrations');
  perform crm_private.require_active_artist(p_artist_id);
  if p_artist_id <> 'a2222222-2222-4222-8222-222222222222'::uuid
     or p_waba_id is distinct from '462106700328578'
     or p_phone_number_id is distinct from '518907894641289'
     or p_sync_type not in ('smb_app_state_sync','history') or p_sync_type is null then
    raise exception 'invalid Coexistence sync target' using errcode='22023';
  end if;
  if not exists (
    select 1 from public.artist_integrations i where i.artist_id=p_artist_id
      and i.integration_type='whatsapp'::public.artist_integration_type
      and i.provider='meta_cloud_api' and i.integration_key='kristina-production'
      and i.is_enabled and i.configuration='{}'::jsonb
  ) then
    raise exception 'Coexistence route not ready' using errcode='55000';
  end if;

  insert into crm_private.whatsapp_coexistence_sync_progress
    (artist_id,sync_type,waba_id,phone_number_id,state)
  values (p_artist_id,p_sync_type,p_waba_id,p_phone_number_id,'claimed')
  on conflict do nothing;
  if found then return 'execute'; end if;

  select state,claimed_at,waba_id,phone_number_id
    into v_state,v_claimed,v_waba,v_phone
    from crm_private.whatsapp_coexistence_sync_progress
    where artist_id=p_artist_id and sync_type=p_sync_type
    for update;
  if v_waba is distinct from p_waba_id or v_phone is distinct from p_phone_number_id
     or v_claimed < now()-interval '24 hours' then
    raise exception 'Coexistence sync receipt stale or target changed' using errcode='55000';
  end if;
  if v_state='accepted' then return 'already_accepted'; end if;
  -- A previous request may have succeeded at Meta without returning a reply.
  -- Never reissue an uncertain one-time request.
  raise exception 'Coexistence sync request already in progress or uncertain' using errcode='55000';
end;
$function$;
revoke all on function public.claim_whatsapp_coexistence_sync(uuid,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.claim_whatsapp_coexistence_sync(uuid,text,text,text) to authenticated;

create function public.record_whatsapp_coexistence_sync_accepted(
  p_artist_id uuid, p_sync_type text
)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $function$
declare v_count int;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_integrations');
  perform crm_private.require_active_artist(p_artist_id);
  if p_artist_id <> 'a2222222-2222-4222-8222-222222222222'::uuid
     or p_sync_type not in ('smb_app_state_sync','history') or p_sync_type is null then
    raise exception 'invalid Coexistence sync receipt' using errcode='22023';
  end if;
  update crm_private.whatsapp_coexistence_sync_progress p
    set state='accepted',accepted_at=now()
    where p.artist_id=p_artist_id and p.sync_type=p_sync_type
      and p.state='claimed' and p.claimed_at>=now()-interval '24 hours';
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception 'Coexistence sync receipt not claimable' using errcode='55000';
  end if;
  return jsonb_build_object('accepted',true);
end;
$function$;
revoke all on function public.record_whatsapp_coexistence_sync_accepted(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.record_whatsapp_coexistence_sync_accepted(uuid,text) to authenticated;
