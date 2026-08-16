-- 0053_gpt_enquiry_reads.sql
--
-- Add a separate, default-off enquiry read capability to private artist-bound
-- GPT clients. Artist scope remains derived exclusively from the OAuth client_id
-- claim. The read surface deliberately excludes contact details, finance,
-- internal notes, files and provider metadata.

alter table crm_private.gpt_action_clients
  add column if not exists can_read_enquiries boolean not null default false;

comment on column crm_private.gpt_action_clients.can_read_enquiries is
  'Owner-controlled permission for the private GPT to read the fixed artist enquiry summary/detail surface.';

create or replace function crm_private.require_gpt_enquiry_context()
returns table (
  gpt_client_id uuid,
  artist_id uuid,
  integration_key text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_oauth_client_id text;
  v_client crm_private.gpt_action_clients%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authenticated GPT OAuth user is required'
      using errcode = '42501';
  end if;

  v_oauth_client_id := nullif(btrim(auth.jwt() ->> 'client_id'), '');
  if v_oauth_client_id is null then
    raise exception 'a Supabase OAuth client token is required'
      using errcode = '42501';
  end if;

  select c.* into v_client
  from crm_private.gpt_action_clients c
  where c.oauth_client_id = v_oauth_client_id
    and c.is_active;

  if not found then
    raise exception 'this GPT OAuth client is not enabled'
      using errcode = '42501';
  end if;

  perform crm_private.require_active_artist(v_client.artist_id);
  if not v_client.can_read_enquiries then
    raise exception 'this GPT client cannot read enquiries'
      using errcode = '42501';
  end if;
  perform crm_private.require_artist_access(v_client.artist_id, 'view');

  return query
  select v_client.id, v_client.artist_id, v_client.integration_key;
end;
$$;

revoke all on function crm_private.require_gpt_enquiry_context()
  from public, anon, authenticated, service_role;

create or replace function public.configure_gpt_enquiry_read_access(
  p_integration_key text,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client crm_private.gpt_action_clients%rowtype;
begin
  if not public.is_owner() then
    raise exception 'only the owner may configure GPT enquiry access'
      using errcode = '42501';
  end if;

  select c.* into v_client
  from crm_private.gpt_action_clients c
  where c.integration_key = p_integration_key
  for update;

  if not found then
    raise exception 'unknown GPT action integration %', p_integration_key
      using errcode = '22023';
  end if;

  if p_enabled then
    if not v_client.is_active or v_client.oauth_client_id is null then
      raise exception 'the GPT OAuth client must be active before enquiry reads are enabled'
        using errcode = '22023';
    end if;
    perform crm_private.require_active_artist(v_client.artist_id);
    perform crm_private.require_artist_access(v_client.artist_id, 'view');
  end if;

  update crm_private.gpt_action_clients c
  set can_read_enquiries = p_enabled
  where c.id = v_client.id;

  insert into public.activity_log (
    event_type, actor_profile_id, actor_kind, artist_id, metadata
  ) values (
    'gpt.client_configured',
    auth.uid(),
    'owner',
    v_client.artist_id,
    jsonb_build_object(
      'integration', v_client.integration_key,
      'enquiry_read_access', p_enabled
    )
  );

  return jsonb_build_object(
    'integration_key', v_client.integration_key,
    'artist_id', v_client.artist_id,
    'can_read_enquiries', p_enabled
  );
end;
$$;

revoke all on function public.configure_gpt_enquiry_read_access(text,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.configure_gpt_enquiry_read_access(text,boolean)
  to authenticated;

create or replace function public.gpt_list_enquiries(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_status public.enquiry_status default null,
  p_limit integer default 20
)
returns table (
  enquiry_id uuid,
  reference_number text,
  status public.enquiry_status,
  client_id uuid,
  client_name text,
  project_type text,
  placement text,
  preferred_timing text,
  created_at timestamptz,
  last_action_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_limit integer;
begin
  if p_from is not null and p_to is not null and p_to <= p_from then
    raise exception 'enquiry range end must be after its start'
      using errcode = '22023';
  end if;
  if p_from is not null and p_to is not null and p_to - p_from > interval '366 days' then
    raise exception 'enquiry range may not exceed 366 days'
      using errcode = '22023';
  end if;

  select c.artist_id into v_artist_id
  from crm_private.require_gpt_enquiry_context() c;
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 25);

  return query
  select
    e.id,
    e.reference_number,
    e.status,
    e.client_id,
    cl.full_name,
    e.project_type,
    e.placement,
    e.preferred_timing,
    e.created_at,
    e.last_action_at
  from public.enquiries e
  join public.clients cl on cl.id = e.client_id
  where e.artist_id = v_artist_id
    and e.intake_state = 'complete'
    and (p_from is null or e.created_at >= p_from)
    and (p_to is null or e.created_at < p_to)
    and (p_status is null or e.status = p_status)
  order by e.created_at desc, e.id
  limit v_limit;
end;
$$;

create or replace function public.gpt_get_enquiry(p_enquiry_id uuid)
returns table (
  enquiry_id uuid,
  reference_number text,
  status public.enquiry_status,
  client_id uuid,
  client_name text,
  project_type text,
  placement text,
  approximate_size text,
  cover_up text,
  preferred_timing text,
  idea text,
  created_at timestamptz,
  last_action_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_enquiry_context() c;

  return query
  select
    e.id,
    e.reference_number,
    e.status,
    e.client_id,
    cl.full_name,
    e.project_type,
    e.placement,
    e.approximate_size,
    e.cover_up,
    e.preferred_timing,
    e.idea,
    e.created_at,
    e.last_action_at
  from public.enquiries e
  join public.clients cl on cl.id = e.client_id
  where e.id = p_enquiry_id
    and e.artist_id = v_artist_id
    and e.intake_state = 'complete';
end;
$$;

revoke all on function public.gpt_list_enquiries(timestamptz,timestamptz,public.enquiry_status,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_get_enquiry(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.gpt_list_enquiries(timestamptz,timestamptz,public.enquiry_status,integer)
  to authenticated;
grant execute on function public.gpt_get_enquiry(uuid)
  to authenticated;

comment on function public.gpt_list_enquiries(timestamptz,timestamptz,public.enquiry_status,integer) is
  'Lists complete enquiries only inside the OAuth client fixed artist scope through a contact-detail-free read surface.';
comment on function public.gpt_get_enquiry(uuid) is
  'Reads one complete enquiry only inside the OAuth client fixed artist scope through a contact-detail-free detail surface.';
