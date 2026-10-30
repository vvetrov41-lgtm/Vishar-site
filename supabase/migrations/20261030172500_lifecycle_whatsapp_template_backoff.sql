-- Account-level Meta policy/API rejection must not be retried every
-- five minutes by the shared WhatsApp scheduler. Keep only redacted codes.
alter table crm_private.lifecycle_whatsapp_template_registry
 add column next_retry_at timestamptz,
 add column last_failure_code text check (
   last_failure_code is null or last_failure_code ~ '^[a-z][a-z0-9_]{2,63}$'
 );

create or replace function public.service_record_lifecycle_whatsapp_template_failure(
 p_artist_id uuid,p_purpose text,p_template_name text,p_template_language text,
 p_error_code text
)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $function$
declare
 v_delay interval;
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
       'whatsapp_template_contract_mismatch')
     then interval '6 hours'
   when p_error_code='whatsapp_template_rate_limited'
     then interval '1 hour'
   else interval '30 minutes' end;
 update crm_private.lifecycle_whatsapp_template_registry t
 set next_retry_at=now()+v_delay,last_failure_code=p_error_code,updated_at=now()
 where t.artist_id=p_artist_id and t.purpose=p_purpose
   and t.template_name=p_template_name
   and t.template_language=p_template_language;
 if not found then
   raise exception 'unknown lifecycle Meta template target' using errcode='22023';
 end if;
 return jsonb_build_object('artist_id',p_artist_id,'purpose',p_purpose,
   'next_retry_at',now()+v_delay,'failure_code',p_error_code);
end;
$function$;
revoke all on function public.service_record_lifecycle_whatsapp_template_failure(
 uuid,text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.service_record_lifecycle_whatsapp_template_failure(
 uuid,text,text,text,text) to service_role;

-- A successful Meta readback clears any previous transient/policy block.
create or replace function crm_private.lifecycle_whatsapp_clear_template_retry()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $function$
begin
 if new.verified_at is distinct from old.verified_at then
   new.next_retry_at:=null;
   new.last_failure_code:=null;
 end if;
 return new;
end;
$function$;
revoke all on function crm_private.lifecycle_whatsapp_clear_template_retry()
 from public,anon,authenticated,service_role;
create trigger lifecycle_whatsapp_clear_template_retry
before update of verified_at on crm_private.lifecycle_whatsapp_template_registry
for each row execute function crm_private.lifecycle_whatsapp_clear_template_retry();

-- Tighten the existing target claim without changing its exposed columns.
-- Source-of-truth targets for bounded Meta template readback/provisioning.
-- This is a backend-only metadata read; it does not send client messages.
create or replace function public.service_claim_lifecycle_whatsapp_template_targets(
 p_limit integer default 8
)
returns table (
 artist_id uuid,integration_key text,purpose text,
 template_name text,template_language text,approval_status text
)
language plpgsql security definer
set search_path=pg_catalog,public,crm_private as $function$
begin
 if not crm_private.is_service_backend() then
  raise exception 'Meta template maintenance is backend-only' using errcode='42501';
 end if;
 if p_limit is null or p_limit < 1 or p_limit > 20 then
  raise exception 'invalid Meta template maintenance limit' using errcode='22023';
 end if;
 return query
 select t.artist_id,i.integration_key,t.purpose,t.template_name,
        t.template_language,t.approval_status
 from crm_private.lifecycle_whatsapp_template_registry t
 join crm_private.artist_state s on s.artist_id=t.artist_id and s.is_active
 join public.artist_integrations i
   on i.artist_id=t.artist_id
   and i.integration_type='whatsapp'::public.artist_integration_type
   and i.provider='meta_cloud_api' and i.is_enabled
 where (t.verified_at is null or t.verified_at<now()-interval '24 hours')
   and (t.next_retry_at is null or t.next_retry_at<=now())
   and (select count(*) from public.artist_integrations exact
       where exact.artist_id=t.artist_id
       and exact.integration_type='whatsapp'::public.artist_integration_type
       and exact.provider='meta_cloud_api' and exact.is_enabled)=1
 order by coalesce(t.verified_at,'-infinity'::timestamptz),
          t.artist_id,t.purpose
 limit p_limit;
end;
$function$;
revoke all on function public.service_claim_lifecycle_whatsapp_template_targets(integer)
 from public,anon,authenticated,service_role;
grant execute on function public.service_claim_lifecycle_whatsapp_template_targets(integer)
 to service_role;

