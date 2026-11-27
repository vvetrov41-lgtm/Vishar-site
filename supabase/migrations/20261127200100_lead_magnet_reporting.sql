-- Add consented attribution, email-match evidence and artist-scoped aggregates.
begin;
create function crm_private.valid_lead_magnet_attribution(p_value jsonb)
returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare item record;
begin
  if p_value is null or jsonb_typeof(p_value)<>'object' or pg_column_size(p_value)>1600 then return false; end if;
  if p_value='{}'::jsonb then return true; end if;
  if p_value->>'consent_version' is distinct from 'guide-attribution-v1' then return false; end if;
  for item in select key,value from jsonb_each(p_value) loop
    if item.key not in ('consent_version','utm_source','utm_medium','utm_campaign','utm_content','utm_term') or jsonb_typeof(item.value)<>'string' then return false; end if;
    if item.key<>'consent_version' and (length(item.value#>>'{}') not between 1 and 160 or (item.value#>>'{}') !~ '^[A-Za-z0-9_.-]+$') then return false; end if;
  end loop;
  return true;
end; $$;
revoke all on function crm_private.valid_lead_magnet_attribution(jsonb) from public,anon,authenticated;
alter table crm_private.lead_magnet_requests drop constraint lead_magnet_requests_attribution_check;
alter table crm_private.lead_magnet_requests add constraint lead_magnet_requests_attribution_check check(crm_private.valid_lead_magnet_attribution(attribution));
alter table crm_private.lead_magnet_enrolments add column converted_enquiry_id uuid references public.enquiries(id) on delete set null;
create index lead_magnet_request_enrolment_time_idx on crm_private.lead_magnet_requests(enrolment_id,created_at);
create index lead_magnet_contact_artist_time_idx on crm_private.lead_magnet_contacts(artist_id,created_at);
-- This match is evidence of a later enquiry using the same email, not proof
-- of causal ad attribution. Never create a client or modify an enquiry.
create function crm_private.reconcile_lead_magnet_conversions(p_job uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public,crm_private as $$
begin
  with candidates as (
    select e.id,(select q.id from public.enquiries q join public.clients cl on cl.id=q.client_id
      where q.artist_id=e.artist_id and lower(btrim(cl.email))=c.email
        and q.created_at>=(select min(r.created_at) from crm_private.lead_magnet_requests r where r.enrolment_id=e.id)
      order by q.created_at,q.id limit 1) as enquiry_id
    from crm_private.lead_magnet_enrolments e join crm_private.lead_magnet_contacts c on c.id=e.contact_id and c.artist_id=e.artist_id
    where e.converted_at is null
      and (p_job is null or exists(select 1 from crm_private.lead_magnet_delivery_jobs j where j.id=p_job and j.enrolment_id=e.id))
  )
  update crm_private.lead_magnet_enrolments e set converted_at=now(),converted_enquiry_id=x.enquiry_id
    from candidates x where e.id=x.id and x.enquiry_id is not null and e.converted_at is null;
  update crm_private.lead_magnet_delivery_jobs j set status='cancelled',leased_by=null,lease_expires_at=null,lease_token=null
    from crm_private.lead_magnet_enrolments e where j.enrolment_id=e.id and j.artist_id=e.artist_id and e.converted_at is not null
    and j.step>0 and j.status in ('pending','failed','leased');
end; $$;
revoke all on function crm_private.reconcile_lead_magnet_conversions(uuid) from public,anon,authenticated;

create or replace function public.service_capture_lead_magnet(
  p_artist_slug text,p_magnet_slug text,p_request_id uuid,p_first_name text,p_email text,
  p_marketing_opt_in boolean,p_consent_version text,p_attribution jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,crm_private as $$
declare
  m crm_private.lead_magnets%rowtype;
  c crm_private.lead_magnet_contacts%rowtype;
  e crm_private.lead_magnet_enrolments%rowtype;
  previous crm_private.lead_magnet_requests%rowtype;
  n text:=btrim(p_first_name); addr text:=lower(btrim(p_email));
begin
  if not crm_private.is_service_backend() then raise exception 'backend_only' using errcode='42501'; end if;
  if p_request_id is null or p_marketing_opt_in is null or n is null or char_length(n) not between 1 and 80 or n ~ '[[:cntrl:]]'
    or addr is null or char_length(addr)>254 or addr !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or not crm_private.valid_lead_magnet_attribution(p_attribution) then raise exception 'invalid_request' using errcode='22023'; end if;
  select lm.* into m from crm_private.lead_magnets lm join public.artists a on a.id=lm.artist_id
    where a.slug=p_artist_slug and a.is_active and lm.slug=p_magnet_slug and lm.active;
  if not found or m.consent_version is distinct from p_consent_version then raise exception 'magnet_unavailable' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
  select * into previous from crm_private.lead_magnet_requests where id=p_request_id;
  if found then
    select ee.* into e from crm_private.lead_magnet_enrolments ee where ee.id=previous.enrolment_id;
    select cc.* into c from crm_private.lead_magnet_contacts cc where cc.id=e.contact_id;
    if e.magnet_id is distinct from m.id or c.artist_id is distinct from m.artist_id or c.email is distinct from addr
      or previous.marketing_opt_in is distinct from p_marketing_opt_in or previous.consent_version is distinct from p_consent_version or previous.attribution is distinct from p_attribution then
      raise exception 'request_conflict' using errcode='22023';
    end if;
    return jsonb_build_object('ok',true,'delivery_queued',true,'download_url',previous.download_url);
  end if;
  -- Durable cap across IPs for new recipients, not individual request retries.
  perform pg_advisory_xact_lock(hashtextextended('lead-magnet-cap:'||m.artist_id::text,0));
  if not exists(select 1 from crm_private.lead_magnet_contacts where artist_id=m.artist_id and email=addr)
     and (select count(*) from crm_private.lead_magnet_contacts where artist_id=m.artist_id and created_at>now()-interval '24 hours')>=100 then
    raise exception 'lead_magnet_daily_limit' using errcode='54000';
  end if;
  insert into crm_private.lead_magnet_contacts(artist_id,email,first_name) values(m.artist_id,addr,n)
    on conflict(artist_id,email) do update set first_name=excluded.first_name,updated_at=now() returning * into c;
  insert into crm_private.lead_magnet_enrolments(artist_id,contact_id,magnet_id,marketing_enabled,consent_recorded_at)
    values(m.artist_id,c.id,m.id,p_marketing_opt_in and c.marketing_suppressed_at is null,case when p_marketing_opt_in and c.marketing_suppressed_at is null then now() end)
    on conflict(contact_id,magnet_id) do update set marketing_enabled=excluded.marketing_enabled,consent_recorded_at=excluded.consent_recorded_at returning * into e;
  insert into crm_private.lead_magnet_requests(id,artist_id,enrolment_id,asset_version,download_url,marketing_opt_in,consent_version,consent_text,attribution)
    values(p_request_id,m.artist_id,e.id,m.asset_version,m.download_url,p_marketing_opt_in,m.consent_version,m.consent_text,p_attribution);
  insert into crm_private.lead_magnet_delivery_jobs(artist_id,enrolment_id,asset_version,download_url,step,due_at)
    values(m.artist_id,e.id,m.asset_version,m.download_url,0,now()) on conflict(enrolment_id,asset_version,step) do nothing;
  if e.marketing_enabled and m.nurture_enabled and e.converted_at is null then
    insert into crm_private.lead_magnet_delivery_jobs(artist_id,enrolment_id,asset_version,download_url,step,due_at)
      select m.artist_id,e.id,m.asset_version,m.download_url,s.step,now()+make_interval(days=>s.step)
      from (values (3),(7),(14)) s(step)
      on conflict(enrolment_id,asset_version,step) do nothing;
  else
    update crm_private.lead_magnet_delivery_jobs set status='cancelled',leased_by=null,lease_expires_at=null,lease_token=null
      where enrolment_id=e.id and step>0 and status in ('pending','failed','leased');
  end if;
  return jsonb_build_object('ok',true,'delivery_queued',true,'download_url',m.download_url);
end; $$;
create or replace function public.service_claim_lead_magnet_jobs(p_worker text,p_limit integer default 5)
returns table(job_id uuid,lease_token uuid) language plpgsql security definer set search_path=pg_catalog,public,crm_private as $$
begin
  if not crm_private.is_service_backend() then raise exception 'backend_only' using errcode='42501'; end if;
  if p_worker is null or p_worker !~ '^[a-z][a-z0-9_-]{2,127}$' or p_limit is null or p_limit not between 1 and 20 then raise exception 'invalid_claim' using errcode='22023'; end if;
  update crm_private.lead_magnet_delivery_jobs j set status='dead_letter', error_code='lease_expired_uncertain',leased_by=null,lease_expires_at=null,lease_token=null where j.status='leased' and j.lease_expires_at<=now();
  perform crm_private.reconcile_lead_magnet_conversions(null);
  return query
    with eligible as (
      select j.id from crm_private.lead_magnet_delivery_jobs j
      join crm_private.lead_magnet_enrolments e on e.id=j.enrolment_id and e.artist_id=j.artist_id
      join crm_private.lead_magnet_contacts c on c.id=e.contact_id and c.artist_id=e.artist_id
      join crm_private.lead_magnets m on m.id=e.magnet_id and m.artist_id=e.artist_id
      join public.artists a on a.id=m.artist_id
      where j.status in ('pending','failed') and j.due_at<=now() and j.attempts<5
        and a.is_active and m.active and j.asset_version=m.asset_version
        and (j.step=0 or (m.nurture_enabled and e.marketing_enabled and e.converted_at is null and c.marketing_suppressed_at is null and exists(select 1 from crm_private.lead_magnet_delivery_jobs d where d.enrolment_id=e.id and d.asset_version=j.asset_version and d.step=0 and d.status='sent')))
      order by j.due_at,j.id for update of j skip locked limit p_limit
    ), claimed as (
      update crm_private.lead_magnet_delivery_jobs j set status='leased',leased_by=p_worker,lease_expires_at=now()+interval '3 minutes',lease_token=gen_random_uuid(),attempts=j.attempts+1,error_code=null
      from eligible x where j.id=x.id returning j.id,j.lease_token
    ) select x.id,x.lease_token from claimed x;
end; $$;
create or replace function public.service_authorize_lead_magnet_job(p_job uuid,p_worker text,p_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,crm_private as $$
declare payload jsonb;
begin
  if not crm_private.is_service_backend() then raise exception 'backend_only' using errcode='42501'; end if;
  perform crm_private.reconcile_lead_magnet_conversions(p_job);
  select jsonb_build_object('job_id',j.id,'artist_id',j.artist_id,'magnet_slug',m.slug,'email',c.email,'first_name',c.first_name,'step',j.step,'asset_version',j.asset_version,'download_url',j.download_url,'unsubscribe_token',case when j.step>0 then c.unsubscribe_token else null end)
  into payload
  from crm_private.lead_magnet_delivery_jobs j
  join crm_private.lead_magnet_enrolments e on e.id=j.enrolment_id and e.artist_id=j.artist_id
  join crm_private.lead_magnet_contacts c on c.id=e.contact_id and c.artist_id=e.artist_id
  join crm_private.lead_magnets m on m.id=e.magnet_id and m.artist_id=e.artist_id
  join public.artists a on a.id=m.artist_id
  where j.id=p_job and j.status='leased' and j.leased_by=p_worker and j.lease_token=p_token and j.lease_expires_at>now()
    and a.is_active and m.active and j.asset_version=m.asset_version
    and (j.step=0 or (m.nurture_enabled and e.marketing_enabled and e.converted_at is null and c.marketing_suppressed_at is null and exists(select 1 from crm_private.lead_magnet_delivery_jobs d where d.enrolment_id=e.id and d.asset_version=j.asset_version and d.step=0 and d.status='sent')));
  return payload;
end; $$;
-- An aggregate dashboard. No recipient PII, unsubscribe tokens or cross-artist rows.
create function public.get_lead_magnet_summary(p_artist_id uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,crm_private as $$
declare result jsonb;
begin
  if crm_private.jwt_role()<>'authenticated' then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_artist_id is not null and not crm_private.has_artist_capability(p_artist_id,'view') then raise exception 'not_authorized' using errcode='42501'; end if;
  select coalesce(jsonb_agg(x.row_data order by x.artist_id,x.slug),'[]'::jsonb) into result
  from (
    select m.artist_id,m.slug,jsonb_build_object('artist_id',m.artist_id,'artist_name',a.display_name,'slug',m.slug,'version',m.asset_version,'active',m.active,
      'recipients',(select count(*) from crm_private.lead_magnet_enrolments e where e.magnet_id=m.id),
      'requests',(select count(*) from crm_private.lead_magnet_requests r join crm_private.lead_magnet_enrolments e on e.id=r.enrolment_id where e.magnet_id=m.id),
      'opted_in',(select count(*) from crm_private.lead_magnet_enrolments e where e.magnet_id=m.id and e.marketing_enabled),
      'delivered',(select count(distinct j.enrolment_id) from crm_private.lead_magnet_delivery_jobs j join crm_private.lead_magnet_enrolments e on e.id=j.enrolment_id where e.magnet_id=m.id and j.step=0 and j.status='sent'),
      'delivery_attention',(select count(*) from crm_private.lead_magnet_delivery_jobs j join crm_private.lead_magnet_enrolments e on e.id=j.enrolment_id where e.magnet_id=m.id and j.status='dead_letter'),
      'matched_enquiries',(select count(distinct e.converted_enquiry_id) from crm_private.lead_magnet_enrolments e where e.magnet_id=m.id and e.converted_enquiry_id is not null),
      'sources',(select coalesce(jsonb_agg(to_jsonb(v) order by v.requests desc,v.source,v.campaign),'[]'::jsonb) from (
          select coalesce(r.attribution->>'utm_source','unattributed') source,coalesce(r.attribution->>'utm_campaign','') campaign,count(*) requests
          from crm_private.lead_magnet_requests r join crm_private.lead_magnet_enrolments e on e.id=r.enrolment_id
          where e.magnet_id=m.id group by 1,2 order by 3 desc,1,2 limit 30
       ) v)
    ) row_data from crm_private.lead_magnets m join public.artists a on a.id=m.artist_id
    where (p_artist_id is null or m.artist_id=p_artist_id) and crm_private.has_artist_capability(m.artist_id,'view')
  ) x;
  return jsonb_build_object('magnets',result,'generated_at',now());
end; $$;
revoke all on function public.get_lead_magnet_summary(uuid) from public,anon;
grant execute on function public.get_lead_magnet_summary(uuid) to authenticated;
commit;
