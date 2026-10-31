-- Poll Meta templates awaiting approval at a bounded 15-minute cadence,
-- instead of leaving recently submitted Utility templates stale for 24 hours.
-- Approved and other non-pending statuses keep the previous 24-hour refresh;
-- explicit API error backoff still takes precedence in every case.
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
 where (
     t.verified_at is null
     or (
       t.approval_status='PENDING'
       and t.verified_at<now()-interval '15 minutes'
     )
     or (
       t.approval_status<>'PENDING'
       and t.verified_at<now()-interval '24 hours'
     )
   )
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

