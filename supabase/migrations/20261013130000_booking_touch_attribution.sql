-- An opt-in, enquiry-scoped record of first and last known consenting visits.
-- Existing conversion attribution stays on public.enquiries. No browser history
-- is inferred for historical enquiries, and retries never overwrite the first write.
create table if not exists crm_private.enquiry_touch_attribution (
 enquiry_id uuid primary key references public.enquiries(id) on delete cascade,
 artist_id uuid not null references public.artists(id) on delete restrict,
 first_touch jsonb not null,
 last_touch jsonb not null,
 conversion_touch jsonb not null,
 consent_recorded_at timestamptz not null default statement_timestamp(),
 created_at timestamptz not null default statement_timestamp(),
 constraint first_touch_object check (jsonb_typeof(first_touch) = 'object' and pg_column_size(first_touch) <= 2200),
 constraint last_touch_object check (jsonb_typeof(last_touch) = 'object' and pg_column_size(last_touch) <= 2200)
);
alter table crm_private.enquiry_touch_attribution enable row level security;
revoke all on crm_private.enquiry_touch_attribution from public, anon, authenticated, service_role;
create index if not exists enquiry_touch_attribution_artist_idx
 on crm_private.enquiry_touch_attribution (artist_id, created_at desc);

create or replace function public.service_record_enquiry_touch_attribution(
 p_enquiry_id uuid,
 p_idempotency_key uuid,
 p_consent_granted boolean,
 p_first_touch jsonb,
 p_last_touch jsonb
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
 v_enquiry public.enquiries%rowtype;
 v_inserted boolean;
 v_rows integer;
begin
 if not crm_private.is_service_backend() then
   raise exception 'Touch attribution recording is backend-only' using errcode='42501';
 end if;
 if p_consent_granted is distinct from true then
   raise exception 'Analytics consent is required' using errcode='22023';
 end if;
 select e.* into v_enquiry from public.enquiries e where e.id=p_enquiry_id;
 if not found or v_enquiry.idempotency_key is distinct from p_idempotency_key
     or v_enquiry.privacy_acknowledged_at is null then
   raise exception 'Enquiry attribution identity mismatch' using errcode='22023';
 end if;
 if jsonb_typeof(p_first_touch) is distinct from 'object'
   or jsonb_typeof(p_last_touch) is distinct from 'object'
   or pg_column_size(p_first_touch) > 2200 or pg_column_size(p_last_touch) > 2200
   or p_first_touch ->> 'kind' not in ('utm','referral','direct')
   or p_last_touch ->> 'kind' not in ('utm','referral','direct')
   or (p_first_touch ->> 'observedAt') is null
   or (p_last_touch ->> 'observedAt') is null
   or (p_first_touch ->> 'observedAt') !~ '^\\d{4}-\\d{2}-\\d{2}T'
   or (p_last_touch ->> 'observedAt') !~ '^\\d{4}-\\d{2}-\\d{2}T' then
    raise exception 'Invalid bounded touch attribution' using errcode='22023';
 end if;
 insert into crm_private.enquiry_touch_attribution
  (enquiry_id,artist_id,first_touch,last_touch,conversion_touch)
 values (
  v_enquiry.id,v_enquiry.artist_id,p_first_touch,p_last_touch,
  jsonb_build_object(
    'source',v_enquiry.source,
    'utmSource',v_enquiry.utm_source,
    'utmMedium',v_enquiry.utm_medium,
    'utmCampaign',v_enquiry.utm_campaign,
    'utmContent',v_enquiry.utm_content,
    'utmTerm',v_enquiry.utm_term,
    'submittedAt',v_enquiry.created_at
  )
 )
 on conflict (enquiry_id) do nothing;
 get diagnostics v_rows = row_count;
 v_inserted := v_rows > 0;
 return jsonb_build_object('recorded',true,'inserted',v_inserted);
end;
$$;
revoke all on function public.service_record_enquiry_touch_attribution(uuid,uuid,boolean,jsonb,jsonb)
 from public, anon, authenticated, service_role;
grant execute on function public.service_record_enquiry_touch_attribution(uuid,uuid,boolean,jsonb,jsonb)
 to service_role;
comment on table crm_private.enquiry_touch_attribution is
 'Consent-gated first and last known acquisition sources and stored enquiry conversion source; private and idempotent.';
