-- RELEASE CANDIDATE ONLY. Not applied or SQL-runtime-tested. Review on an isolated
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
    values(m.artist_id,c.id,m.id,p_marketing_opt_in,case when p_marketing_opt_in then now() end)
    on conflict(contact_id,magnet_id) do update set marketing_enabled=excluded.marketing_enabled,consent_recorded_at=excluded.consent_recorded_at returning * into e;
  insert into crm_private.lead_magnet_requests(id,artist_id,enrolment_id,asset_version,download_url,marketing_opt_in,consent_version,consent_text,attribution)
    values(p_request_id,m.artist_id,e.id,m.asset_version,m.download_url,p_marketing_opt_in,m.consent_version,m.consent_text,'{}'::jsonb);
  insert into crm_private.lead_magnet_delivery_jobs(artist_id,enrolment_id,asset_version,download_url,step,due_at)
    values(m.artist_id,e.id,m.asset_version,m.download_url,0,now()) on conflict(enrolment_id,asset_version,step) do nothing;
  if p_marketing_opt_in and m.nurture_enabled and e.converted_at is null then
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
  update crm_private.lead_magnet_enrolments set marketing_enabled=false where contact_id=cid;
  update crm_private.lead_magnet_delivery_jobs j set status='cancelled'
    where j.step>0 and j.status in ('pending','failed') and j.enrolment_id in (select id from crm_private.lead_magnet_enrolments where contact_id=cid);
  return true;
end; $$;
revoke all on function public.service_unsubscribe_lead_magnet(uuid) from public,anon,authenticated;
grant execute on function public.service_unsubscribe_lead_magnet(uuid) to service_role;
commit;
-- Remaining integration gates: claim/lease/consent recheck and provider-result
-- RPCs, Gmail adapter, artist-scoped reporting, conversion linking, data retention,
-- public opt-out handler, release configuration and integration tests. Do not
-- activate a magnet or the intake Worker until these gates are accepted.
