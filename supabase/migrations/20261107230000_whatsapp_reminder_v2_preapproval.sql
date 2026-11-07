-- Stage two new Vladimir-only Utility template candidates without mutating
-- the approved v1 WhatsApp send registry. Meta may take time to approve v2,
-- so live reminder delivery and email fallback must remain unchanged.
create table crm_private.lifecycle_whatsapp_template_candidates (
  artist_id uuid not null references public.artists(id) on delete restrict,
  purpose text not null check (purpose in ('session_reminder_72h','session_reminder_24h')),
  template_name text not null check (
    template_name ~ '^[a-z0-9_]+$' and char_length(template_name) <= 512
  ),
  template_language text not null check (template_language ~ '^[a-z]{2}(_[A-Z]{2})?$'),
  approval_status text not null default 'UNKNOWN' check (
    approval_status in ('UNKNOWN','PENDING','APPROVED','REJECTED','PAUSED')
  ),
  provider_template_id text check (
    provider_template_id is null or provider_template_id ~ '^[0-9]{5,32}$'
  ),
  verified_at timestamptz,
  next_retry_at timestamptz,
  last_failure_code text check (
    last_failure_code is null or last_failure_code ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  updated_at timestamptz not null default now(),
  primary key (artist_id,purpose),
  constraint candidate_approved_evidence check (
    approval_status <> 'APPROVED'
    or (provider_template_id is not null and verified_at is not null)
  )
);
alter table crm_private.lifecycle_whatsapp_template_candidates enable row level security;
revoke all on crm_private.lifecycle_whatsapp_template_candidates
  from public,anon,authenticated,service_role;

do $guard$
begin
  if (select count(*) from crm_private.lifecycle_whatsapp_template_registry t
       where t.artist_id='a1111111-1111-4111-8111-111111111111'::uuid
         and t.template_language='en_GB'
         and ((t.purpose='session_reminder_72h'
           and t.template_name='vishar_lifecycle_reminder_72h_v1')
           or (t.purpose='session_reminder_24h'
           and t.template_name='vishar_lifecycle_reminder_24h_v1'))) <> 2
  then
    raise exception 'Vladimir active WhatsApp reminder identities drifted'
      using errcode='23514';
  end if;
end;
$guard$;
insert into crm_private.lifecycle_whatsapp_template_candidates
  (artist_id,purpose,template_name,template_language)
select t.artist_id,t.purpose,
  case t.purpose
    when 'session_reminder_72h' then 'vishar_lifecycle_reminder_72h_v2'
    when 'session_reminder_24h' then 'vishar_lifecycle_reminder_24h_v2'
  end,t.template_language
from crm_private.lifecycle_whatsapp_template_registry t
where t.artist_id='a1111111-1111-4111-8111-111111111111'::uuid
  and t.purpose in ('session_reminder_72h','session_reminder_24h');

-- The existing bounded claim now includes potential v2 templates while the
-- active v1 identities remain the only ones the lifecycle sender may use.
create or replace function public.service_claim_lifecycle_whatsapp_template_targets(
  p_limit integer default 8
) returns table (
  artist_id uuid,integration_key text,purpose text,
  template_name text,template_language text,approval_status text
) language plpgsql security definer
set search_path=pg_catalog,public,crm_private
as $claim$
begin
  if not crm_private.is_service_backend() then
    raise exception 'Meta template maintenance is backend-only' using errcode='42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'invalid Meta template maintenance limit' using errcode='22023';
  end if;
  return query
  with targets as (
    select t.artist_id,t.purpose,t.template_name,t.template_language,
           t.approval_status,t.verified_at,t.next_retry_at
    from crm_private.lifecycle_whatsapp_template_registry t
    union all
    select c.artist_id,c.purpose,c.template_name,c.template_language,
           c.approval_status,c.verified_at,c.next_retry_at
    from crm_private.lifecycle_whatsapp_template_candidates c
  )
  select t.artist_id,i.integration_key,t.purpose,t.template_name,
         t.template_language,t.approval_status
  from targets t
  join crm_private.artist_state s on s.artist_id=t.artist_id and s.is_active
  join public.artist_integrations i on i.artist_id=t.artist_id
    and i.integration_type='whatsapp'::public.artist_integration_type
    and i.provider='meta_cloud_api' and i.is_enabled
  where (
      t.verified_at is null
      or (t.approval_status='PENDING'
          and t.verified_at<now()-interval '15 minutes')
      or (t.approval_status<>'PENDING'
          and t.verified_at<now()-interval '24 hours')
    )
    and (t.next_retry_at is null or t.next_retry_at<=now())
    and (select count(*) from public.artist_integrations exact
      where exact.artist_id=t.artist_id
        and exact.integration_type='whatsapp'::public.artist_integration_type
        and exact.provider='meta_cloud_api' and exact.is_enabled)=1
  order by coalesce(t.verified_at,'-infinity'::timestamptz),
           t.artist_id,t.purpose,t.template_name
  limit p_limit;
end;
$claim$;

-- Provider identity must match either an active entry or a candidate entry.
-- Candidate verification NEVER changes an approved, in-use v1 registry row.
create or replace function public.service_record_lifecycle_whatsapp_template_status(
 p_artist_id uuid,p_purpose text,p_template_name text,p_template_language text,
 p_status text,p_provider_template_id text default null
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,crm_private
as $status$
declare
 v_status text:=upper(btrim(coalesce(p_status,'')));
 v_id text:=nullif(btrim(coalesce(p_provider_template_id,'')),'');
 v_count integer:=0;
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
 update crm_private.lifecycle_whatsapp_template_registry r
 set approval_status=v_status,
     provider_template_id=case when v_status='APPROVED' then v_id else null end,
     verified_at=now(),updated_at=now()
 where r.artist_id=p_artist_id and r.purpose=p_purpose
   and r.template_name=p_template_name and r.template_language=p_template_language;
 get diagnostics v_count=row_count;
 if v_count=0 then
   update crm_private.lifecycle_whatsapp_template_candidates c
   set approval_status=v_status,
       provider_template_id=case when v_status='APPROVED' then v_id else null end,
       verified_at=now(),updated_at=now()
   where c.artist_id=p_artist_id and c.purpose=p_purpose
     and c.template_name=p_template_name and c.template_language=p_template_language;
   get diagnostics v_count=row_count;
 end if;
 if v_count<>1 then
   raise exception 'WhatsApp template target unavailable' using errcode='22023';
 end if;
 return jsonb_build_object('artist_id',p_artist_id,'purpose',p_purpose,
  'approval_status',v_status,'verified_at',now());
end;
$status$;

create or replace function public.service_record_lifecycle_whatsapp_template_failure(
 p_artist_id uuid,p_purpose text,p_template_name text,p_template_language text,
 p_error_code text
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,crm_private
as $failure$
declare
 v_delay interval;
 v_count integer:=0;
begin
 if not crm_private.is_service_backend() then
   raise exception 'Meta template failure recording is backend-only' using errcode='42501';
 end if;
 if p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{2,63}$' then
   raise exception 'unsafe template failure code' using errcode='22023';
 end if;
 v_delay:=case
   when p_error_code in ('whatsapp_template_api_unavailable_for_account',
       'whatsapp_template_credentials_rejected',
       'whatsapp_template_contract_mismatch') then interval '6 hours'
   when p_error_code='whatsapp_template_rate_limited' then interval '1 hour'
   else interval '30 minutes' end;
 update crm_private.lifecycle_whatsapp_template_registry r
 set next_retry_at=now()+v_delay,last_failure_code=p_error_code,updated_at=now()
 where r.artist_id=p_artist_id and r.purpose=p_purpose
   and r.template_name=p_template_name and r.template_language=p_template_language;
 get diagnostics v_count=row_count;
 if v_count=0 then
   update crm_private.lifecycle_whatsapp_template_candidates c
   set next_retry_at=now()+v_delay,last_failure_code=p_error_code,updated_at=now()
   where c.artist_id=p_artist_id and c.purpose=p_purpose
     and c.template_name=p_template_name and c.template_language=p_template_language;
   get diagnostics v_count=row_count;
 end if;
 if v_count<>1 then
   raise exception 'unknown lifecycle Meta template target' using errcode='22023';
 end if;
 return jsonb_build_object('artist_id',p_artist_id,'purpose',p_purpose,
   'next_retry_at',now()+v_delay,'failure_code',p_error_code);
end;
$failure$;

-- Existing EXECUTE grants and row-level approval/delivery gates are retained;
-- no client message, appointment, template approval or provider call is emitted.
