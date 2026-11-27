-- Isolated lead-magnet foundation; no active magnets seeded.
-- private-CRM release branch, then staging. Existing enquiries, clients, and
-- email_messages are deliberately untouched. crm_private.is_service_backend()
-- is the existing backend-only authorization helper in production Vishar CRM.
begin;
create table crm_private.lead_magnets (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.artists(id) on delete restrict,
  slug text not null check (slug ~ '^[a-z][a-z0-9-]{1,62}$'),
  asset_version text not null check (asset_version ~ '^[a-z0-9-]{1,32}$'),
  download_url text not null check (download_url ~ '^https://[^[:space:]]+$'),
  active boolean not null default false,
  nurture_enabled boolean not null default false,
  consent_version text not null,
  consent_text text not null,
  unique(artist_id,slug), unique(id,artist_id)
);
create table crm_private.lead_magnet_contacts (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.artists(id) on delete restrict,
  email text not null check (email=lower(btrim(email)) and char_length(email)<=254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  first_name text not null check (char_length(first_name) between 1 and 80),
  unsubscribe_token uuid not null unique default gen_random_uuid(),
  marketing_suppressed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(artist_id,email),unique(id,artist_id)
);
create table crm_private.lead_magnet_enrolments (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null,
  contact_id uuid not null,
  magnet_id uuid not null,
  marketing_enabled boolean not null default false,
  consent_recorded_at timestamptz,
  converted_at timestamptz,
  foreign key(contact_id,artist_id) references crm_private.lead_magnet_contacts(id,artist_id) on delete restrict,
  foreign key(magnet_id,artist_id) references crm_private.lead_magnets(id,artist_id) on delete restrict,
  unique(contact_id,magnet_id),unique(id,artist_id)
);
create table crm_private.lead_magnet_requests (
  id uuid primary key,
  artist_id uuid not null,
  enrolment_id uuid not null,
  asset_version text not null,
  download_url text not null,
  marketing_opt_in boolean not null,
  consent_version text not null,
  consent_text text not null,
  attribution jsonb not null default '{}'::jsonb check (attribution='{}'::jsonb),
  created_at timestamptz not null default now(),
  foreign key(enrolment_id,artist_id) references crm_private.lead_magnet_enrolments(id,artist_id) on delete restrict
);
create table crm_private.lead_magnet_delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null,
  enrolment_id uuid not null,
  asset_version text not null,
  download_url text not null,
  step smallint not null check(step in (0,3,7,14)),
  status text not null default 'pending' check(status in ('pending','leased','sent','failed','cancelled','dead_letter')),
  due_at timestamptz not null,
  attempts integer not null default 0 check(attempts>=0),
  leased_by text,
  lease_expires_at timestamptz,
  lease_token uuid,
  sent_at timestamptz,
  provider_message_id text,
  error_code text,
  check((status='leased')=(leased_by is not null and lease_expires_at is not null and lease_token is not null)),
  check((status='sent')=(sent_at is not null)),
  foreign key(enrolment_id,artist_id) references crm_private.lead_magnet_enrolments(id,artist_id) on delete restrict,
  unique(enrolment_id,asset_version,step)
);
create index lead_magnet_delivery_due_idx on crm_private.lead_magnet_delivery_jobs(status,due_at);
alter table crm_private.lead_magnets enable row level security;
alter table crm_private.lead_magnet_contacts enable row level security;
alter table crm_private.lead_magnet_enrolments enable row level security;
alter table crm_private.lead_magnet_requests enable row level security;
alter table crm_private.lead_magnet_delivery_jobs enable row level security;
revoke all on crm_private.lead_magnets,crm_private.lead_magnet_contacts,crm_private.lead_magnet_enrolments,crm_private.lead_magnet_requests,crm_private.lead_magnet_delivery_jobs from public,anon,authenticated;

create function public.service_capture_lead_magnet(
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
    or p_attribution is distinct from '{}'::jsonb then raise exception 'invalid_request' using errcode='22023'; end if;
  select lm.* into m from crm_private.lead_magnets lm join public.artists a on a.id=lm.artist_id
    where a.slug=p_artist_slug and a.is_active and lm.slug=p_magnet_slug and lm.active;
  if not found or m.consent_version is distinct from p_consent_version then raise exception 'magnet_unavailable' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
  select * into previous from crm_private.lead_magnet_requests where id=p_request_id;
  if found then
    select ee.* into e from crm_private.lead_magnet_enrolments ee where ee.id=previous.enrolment_id;
    select cc.* into c from crm_private.lead_magnet_contacts cc where cc.id=e.contact_id;
    if e.magnet_id is distinct from m.id or c.artist_id is distinct from m.artist_id or c.email is distinct from addr
      or previous.marketing_opt_in is distinct from p_marketing_opt_in or previous.consent_version is distinct from p_consent_version then
      raise exception 'request_conflict' using errcode='22023';
    end if;
    return jsonb_build_object('ok',true,'delivery_queued',true,'download_url',previous.download_url);
  end if;
  insert into crm_private.lead_magnet_contacts(artist_id,email,first_name) values(m.artist_id,addr,n)
    on conflict(artist_id,email) do update set first_name=excluded.first_name,updated_at=now() returning * into c;
  insert into crm_private.lead_magnet_enrolments(artist_id,contact_id,magnet_id,marketing_enabled,consent_recorded_at)
    values(m.artist_id,c.id,m.id,p_marketing_opt_in and c.marketing_suppressed_at is null,case when p_marketing_opt_in and c.marketing_suppressed_at is null then now() end)
    on conflict(contact_id,magnet_id) do update set marketing_enabled=excluded.marketing_enabled,consent_recorded_at=excluded.consent_recorded_at returning * into e;
  insert into crm_private.lead_magnet_requests(id,artist_id,enrolment_id,asset_version,download_url,marketing_opt_in,consent_version,consent_text,attribution)
    values(p_request_id,m.artist_id,e.id,m.asset_version,m.download_url,p_marketing_opt_in,m.consent_version,m.consent_text,'{}'::jsonb);
  insert into crm_private.lead_magnet_delivery_jobs(artist_id,enrolment_id,asset_version,download_url,step,due_at)
    values(m.artist_id,e.id,m.asset_version,m.download_url,0,now()) on conflict(enrolment_id,asset_version,step) do nothing;
  if e.marketing_enabled and m.nurture_enabled and e.converted_at is null then
    insert into crm_private.lead_magnet_delivery_jobs(artist_id,enrolment_id,asset_version,download_url,step,due_at)
      select m.artist_id,e.id,m.asset_version,m.download_url,s.step,now()+make_interval(days=>s.step)
      from (values (3),(7),(14)) s(step)
      on conflict(enrolment_id,asset_version,step) do nothing;
  else
    update crm_private.lead_magnet_delivery_jobs set status='cancelled'
      where enrolment_id=e.id and step>0 and status in ('pending','failed');
  end if;
  return jsonb_build_object('ok',true,'delivery_queued',true,'download_url',m.download_url);
end; $$;
revoke all on function public.service_capture_lead_magnet(text,text,uuid,text,text,boolean,text,jsonb) from public,anon,authenticated;
grant execute on function public.service_capture_lead_magnet(text,text,uuid,text,text,boolean,text,jsonb) to service_role;

-- Call only from an HTTPS POST confirming the opaque unsubscribe token;
-- a GET link must show confirmation and must never mutate data on its own.
create function public.service_unsubscribe_lead_magnet(p_token uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,public,crm_private as $$
declare cid uuid;
begin
  if not crm_private.is_service_backend() then raise exception 'backend_only' using errcode='42501'; end if;
  select id into cid from crm_private.lead_magnet_contacts where unsubscribe_token=p_token for update;
  if cid is null then return false; end if;
  update crm_private.lead_magnet_contacts set marketing_suppressed_at=coalesce(marketing_suppressed_at,now()) where id=cid;
  update crm_private.lead_magnet_enrolments set marketing_enabled=false where contact_id=cid;
  update crm_private.lead_magnet_delivery_jobs j set status='cancelled',leased_by=null,lease_expires_at=null,lease_token=null
    where j.step>0 and j.status in ('pending','failed','leased') and j.enrolment_id in (select id from crm_private.lead_magnet_enrolments where contact_id=cid);
  return true;
end; $$;
revoke all on function public.service_unsubscribe_lead_magnet(uuid) from public,anon,authenticated;
grant execute on function public.service_unsubscribe_lead_magnet(uuid) to service_role;

-- Claim only due, authorised jobs. Expired leases are quarantined instead of
-- blindly re-sending: a provider may have accepted the original request.
create function public.service_claim_lead_magnet_jobs(p_worker text,p_limit integer default 5)
returns table(job_id uuid,lease_token uuid) language plpgsql security definer set search_path=pg_catalog,public,crm_private as $$
begin
  if not crm_private.is_service_backend() then raise exception 'backend_only' using errcode='42501'; end if;
  if p_worker is null or p_worker !~ '^[a-z][a-z0-9_-]{2,127}$' or p_limit is null or p_limit not between 1 and 20 then raise exception 'invalid_claim' using errcode='22023'; end if;
  update crm_private.lead_magnet_delivery_jobs j set status='dead_letter', error_code='lease_expired_uncertain',leased_by=null,lease_expires_at=null,lease_token=null where j.status='leased' and j.lease_expires_at<=now();
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

-- Called immediately before provider delivery. Return data only for a live lease.
-- This is not a public endpoint. Provider routing must independently verify artist identity.
create function public.service_authorize_lead_magnet_job(p_job uuid,p_worker text,p_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,crm_private as $$
declare payload jsonb;
begin
  if not crm_private.is_service_backend() then raise exception 'backend_only' using errcode='42501'; end if;
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

create function public.service_finish_lead_magnet_job(p_job uuid,p_worker text,p_token uuid,p_outcome text,p_provider_id text default null)
returns boolean language plpgsql security definer set search_path=pg_catalog,public,crm_private as $$
begin
  if not crm_private.is_service_backend() then raise exception 'backend_only' using errcode='42501'; end if;
  if p_outcome is null or p_outcome not in ('sent','retry_before_send','uncertain','cancelled') or
    (p_outcome='sent' and (p_provider_id is null or p_provider_id !~ '^[A-Za-z0-9_-]{1,200}$')) or
    (p_outcome<>'sent' and p_provider_id is not null) then raise exception 'invalid_outcome' using errcode='22023'; end if;
  update crm_private.lead_magnet_delivery_jobs j set
    status=case when p_outcome='sent' then 'sent' when p_outcome='cancelled' then 'cancelled' when p_outcome='retry_before_send' and j.attempts<5 then 'failed' else 'dead_letter' end,
    due_at=case when p_outcome='retry_before_send' then now()+make_interval(mins=>5*j.attempts) else j.due_at end,
    sent_at=case when p_outcome='sent' then now() else null end,provider_message_id=p_provider_id,
    error_code=case when p_outcome='uncertain' then 'provider_outcome_uncertain' when p_outcome='retry_before_send' then 'pre_send_failure' else null end,
    leased_by=null,lease_expires_at=null,lease_token=null
  where j.id=p_job and j.status='leased' and j.leased_by=p_worker and j.lease_token=p_token and j.lease_expires_at>now();
  return found;
end; $$;
revoke all on function public.service_claim_lead_magnet_jobs(text,integer), public.service_authorize_lead_magnet_job(uuid,text,uuid), public.service_finish_lead_magnet_job(uuid,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.service_claim_lead_magnet_jobs(text,integer), public.service_authorize_lead_magnet_job(uuid,text,uuid), public.service_finish_lead_magnet_job(uuid,text,uuid,text,text) to service_role;

commit;
-- Remaining integration gates: claim/lease/consent recheck and provider-result
-- RPCs, Gmail adapter, artist-scoped reporting, conversion linking, data retention,
-- public opt-out handler, release configuration and integration tests. Do not
-- activate a magnet or the intake Worker until these gates are accepted.
