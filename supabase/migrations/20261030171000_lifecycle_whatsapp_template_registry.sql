-- Artist-scoped lifecycle Utility templates. A connected WhatsApp account is
-- not proof that Meta has approved a template outside the customer window.
-- No sender is activated by this migration.
create table crm_private.lifecycle_whatsapp_template_registry (
  artist_id uuid not null references public.artists(id) on delete restrict,
  purpose text not null check (purpose in (
    'session_reminder_72h','session_reminder_24h',
    'post_session_aftercare','post_session_checkin'
  )),
  template_name text not null check (template_name ~ '^[a-z0-9_]{1,512}$'),
  template_language text not null check (template_language ~ '^[a-z]{2}(_[A-Z]{2})?$'),
  approval_status text not null default 'UNKNOWN'
    check (approval_status in ('UNKNOWN','PENDING','APPROVED','REJECTED','PAUSED')),
  provider_template_id text check (
    provider_template_id is null or provider_template_id ~ '^[0-9]{5,32}$'
  ),
  verified_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (artist_id,purpose),
  constraint lifecycle_whatsapp_approved_evidence check (
    approval_status <> 'APPROVED'
    or (provider_template_id is not null and verified_at is not null)
  )
);
alter table crm_private.lifecycle_whatsapp_template_registry enable row level security;
revoke all on crm_private.lifecycle_whatsapp_template_registry
  from public,anon,authenticated,service_role;

-- Names are proposals only. UNKNOWN is deliberately NOT sendable.
insert into crm_private.lifecycle_whatsapp_template_registry(
 artist_id,purpose,template_name,template_language
)
select a.id,t.purpose,t.template_name,'en_GB'
from public.artists a
cross join (values
 ('session_reminder_72h','vishar_lifecycle_reminder_72h_v1'),
 ('session_reminder_24h','vishar_lifecycle_reminder_24h_v1'),
 ('post_session_aftercare','vishar_lifecycle_aftercare_v1'),
 ('post_session_checkin','vishar_lifecycle_checkin_v1')
) t(purpose,template_name)
where a.slug in ('vladimir','kristina')
on conflict (artist_id,purpose) do nothing;

-- Meta-template maintenance Worker alone may record the provider readback.
-- Raw credentials are never accepted, stored or returned here.
create or replace function public.service_record_lifecycle_whatsapp_template_status(
  p_artist_id uuid,
  p_purpose text,
  p_template_name text,
  p_template_language text,
  p_status text,
  p_provider_template_id text default null
)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $function$
declare
 v_status text:=upper(btrim(coalesce(p_status,'')));
 v_identity crm_private.lifecycle_whatsapp_template_registry%rowtype;
 v_id text:=nullif(btrim(coalesce(p_provider_template_id,'')),'');
begin
 if not crm_private.is_service_backend() then
   raise exception 'WhatsApp template status is backend-only' using errcode='42501';
 end if;
 if v_status not in ('PENDING','APPROVED','REJECTED','PAUSED','UNKNOWN')
    or (v_status='APPROVED' and (v_id is null or v_id !~ '^[0-9]{5,32}$'))
    or (v_id is not null and v_id !~ '^[0-9]{5,32}$')
 then
   raise exception 'invalid WhatsApp template provider evidence' using errcode='22023';
 end if;
 select * into v_identity from crm_private.lifecycle_whatsapp_template_registry
 where artist_id=p_artist_id and purpose=p_purpose
   and template_name=p_template_name and template_language=p_template_language
 for update;
 if not found then
   raise exception 'WhatsApp template target unavailable' using errcode='22023';
 end if;
 update crm_private.lifecycle_whatsapp_template_registry
 set approval_status=v_status,
     provider_template_id=case when v_status='APPROVED' then v_id else null end,
     verified_at=now(),updated_at=now()
 where artist_id=v_identity.artist_id and purpose=v_identity.purpose;
 return jsonb_build_object(
   'artist_id',p_artist_id,'purpose',p_purpose,
   'approval_status',v_status,'verified_at',now()
 );
end;
$function$;
revoke all on function public.service_record_lifecycle_whatsapp_template_status(
 uuid,text,text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.service_record_lifecycle_whatsapp_template_status(
 uuid,text,text,text,text,text) to service_role;
