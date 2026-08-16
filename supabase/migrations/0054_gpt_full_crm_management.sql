-- 0054_gpt_full_crm_management.sql
--
-- Expand the private artist-bound GPT from the appointment/enquiry subset to
-- the daily operational CRM surface. All capabilities are owner-controlled and
-- default off. The OAuth client_id remains the sole authoritative artist route.
-- No generic table, SQL, security-admin, credential or Storage-object read path
-- is introduced.

alter table crm_private.gpt_action_clients
  add column if not exists can_manage_crm boolean not null default false,
  add column if not exists can_manage_finance boolean not null default false,
  add column if not exists can_manage_communications boolean not null default false;

comment on column crm_private.gpt_action_clients.can_manage_crm is
  'Owner-controlled permission for artist-scoped operational CRM management, including single-record client contact detail.';
comment on column crm_private.gpt_action_clients.can_manage_finance is
  'Owner-controlled permission for artist-scoped project/payment operations.';
comment on column crm_private.gpt_action_clients.can_manage_communications is
  'Owner-controlled permission for artist-scoped email and WhatsApp operations.';

create or replace function crm_private.require_gpt_operational_context(p_capability text)
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
  v_capability text := lower(btrim(coalesce(p_capability, '')));
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

  if v_capability = 'crm' then
    if not v_client.can_manage_crm then
      raise exception 'this GPT client cannot manage CRM records'
        using errcode = '42501';
    end if;
    perform crm_private.require_artist_access(v_client.artist_id, 'manage');
  elsif v_capability = 'finance' then
    if not v_client.can_manage_finance then
      raise exception 'this GPT client cannot manage finance'
        using errcode = '42501';
    end if;
    perform crm_private.require_artist_access(v_client.artist_id, 'manage_finance');
  elsif v_capability = 'communications' then
    if not v_client.can_manage_communications then
      raise exception 'this GPT client cannot manage communications'
        using errcode = '42501';
    end if;
    perform crm_private.require_artist_access(v_client.artist_id, 'manage');
  else
    raise exception 'unknown GPT operational capability'
      using errcode = '22023';
  end if;

  return query
  select v_client.id, v_client.artist_id, v_client.integration_key;
end;
$$;

revoke all on function crm_private.require_gpt_operational_context(text)
  from public, anon, authenticated, service_role;

create or replace function crm_private.gpt_client_in_artist_scope(
  p_client_id uuid,
  p_artist_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1 from public.enquiries e
    where e.client_id = p_client_id and e.artist_id = p_artist_id
    union all
    select 1 from public.projects p
    where p.client_id = p_client_id and p.artist_id = p_artist_id
    union all
    select 1 from public.sessions s
    where s.client_id = p_client_id and s.artist_id = p_artist_id
  );
$$;

create or replace function crm_private.gpt_client_has_other_artist_scope(
  p_client_id uuid,
  p_artist_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1 from public.enquiries e
    where e.client_id = p_client_id and e.artist_id <> p_artist_id
    union all
    select 1 from public.projects p
    where p.client_id = p_client_id and p.artist_id <> p_artist_id
    union all
    select 1 from public.sessions s
    where s.client_id = p_client_id and s.artist_id <> p_artist_id
  );
$$;

revoke all on function crm_private.gpt_client_in_artist_scope(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.gpt_client_has_other_artist_scope(uuid,uuid)
  from public, anon, authenticated, service_role;

create or replace function public.configure_gpt_full_management(
  p_integration_key text,
  p_manage_crm boolean,
  p_manage_finance boolean,
  p_manage_communications boolean
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
    raise exception 'only the owner may configure GPT full management'
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

  if coalesce(p_manage_crm, false)
     or coalesce(p_manage_finance, false)
     or coalesce(p_manage_communications, false) then
    if not v_client.is_active or v_client.oauth_client_id is null then
      raise exception 'the GPT OAuth client must be active before full management is enabled'
        using errcode = '22023';
    end if;
    perform crm_private.require_active_artist(v_client.artist_id);
    perform crm_private.require_artist_access(v_client.artist_id, 'manage');
  end if;

  if coalesce(p_manage_finance, false) then
    perform crm_private.require_artist_access(v_client.artist_id, 'manage_finance');
  end if;

  update crm_private.gpt_action_clients c
  set can_manage_crm = coalesce(p_manage_crm, false),
      can_manage_finance = coalesce(p_manage_finance, false),
      can_manage_communications = coalesce(p_manage_communications, false)
  where c.id = v_client.id;

  insert into public.activity_log (
    event_type, actor_profile_id, actor_kind, artist_id, metadata
  ) values (
    'gpt.client_configured', auth.uid(), 'owner', v_client.artist_id,
    jsonb_build_object(
      'integration', v_client.integration_key,
      'manage_crm', coalesce(p_manage_crm, false),
      'manage_finance', coalesce(p_manage_finance, false),
      'manage_communications', coalesce(p_manage_communications, false)
    )
  );

  return jsonb_build_object(
    'integration_key', v_client.integration_key,
    'artist_id', v_client.artist_id,
    'can_manage_crm', coalesce(p_manage_crm, false),
    'can_manage_finance', coalesce(p_manage_finance, false),
    'can_manage_communications', coalesce(p_manage_communications, false)
  );
end;
$$;

-- Clients -------------------------------------------------------------------

create or replace function public.gpt_get_client(p_client_id uuid)
returns table (
  client_id uuid,
  full_name text,
  email text,
  phone text,
  instagram text,
  preferred_contact text,
  travelling_from text,
  notes_summary text,
  created_at timestamptz,
  updated_at timestamptz
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
  from crm_private.require_gpt_operational_context('crm') c;

  if not crm_private.gpt_client_in_artist_scope(p_client_id, v_artist_id) then
    return;
  end if;

  return query
  select c.id, c.full_name, c.email, c.phone, c.instagram,
         c.preferred_contact, c.travelling_from, c.notes_summary,
         c.created_at, c.updated_at
  from public.clients c
  where c.id = p_client_id and c.archived_at is null;
end;
$$;

create or replace function public.gpt_update_client(
  p_client_id uuid,
  p_client jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;

  if not crm_private.gpt_client_in_artist_scope(p_client_id, v_artist_id) then
    raise exception 'client is outside this GPT artist scope' using errcode = '42501';
  end if;
  if crm_private.gpt_client_has_other_artist_scope(p_client_id, v_artist_id) then
    raise exception 'shared client must be edited in the CRM, not an artist-scoped GPT'
      using errcode = '42501';
  end if;

  return public.update_client_details(p_client_id, p_client);
end;
$$;

-- Enquiries -----------------------------------------------------------------

create or replace function public.gpt_get_enquiry_full(p_enquiry_id uuid)
returns table (
  enquiry_id uuid,
  reference_number text,
  status public.enquiry_status,
  client_identifier_conflict boolean,
  assigned_to uuid,
  assigned_to_name text,
  client_id uuid,
  client_name text,
  client_email text,
  client_phone text,
  client_instagram text,
  preferred_contact text,
  travelling_from text,
  project_type text,
  placement text,
  approximate_size text,
  cover_up text,
  preferred_timing text,
  idea text,
  source text,
  landing_page text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  created_at timestamptz,
  updated_at timestamptz,
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
  from crm_private.require_gpt_operational_context('crm') c;

  return query
  select e.id, e.reference_number, e.status, e.client_identifier_conflict,
         e.assigned_to, p.display_name,
         e.client_id, cl.full_name, cl.email, cl.phone, cl.instagram,
         cl.preferred_contact, cl.travelling_from,
         e.project_type, e.placement, e.approximate_size, e.cover_up,
         e.preferred_timing, e.idea,
         e.source, e.landing_page, e.referrer,
         e.utm_source, e.utm_medium, e.utm_campaign, e.utm_content, e.utm_term,
         e.created_at, e.updated_at, e.last_action_at
  from public.enquiries e
  join public.clients cl on cl.id = e.client_id
  left join public.profiles p on p.id = e.assigned_to
  where e.id = p_enquiry_id
    and e.artist_id = v_artist_id
    and e.intake_state = 'complete'
    and e.archived_at is null;
end;
$$;

create or replace function public.gpt_update_enquiry(
  p_enquiry_id uuid,
  p_enquiry jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_record_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;
  select e.artist_id into v_record_artist from public.enquiries e where e.id = p_enquiry_id;
  if v_record_artist is distinct from v_artist_id then
    raise exception 'enquiry is outside this GPT artist scope' using errcode = '42501';
  end if;
  return public.update_enquiry_details(p_enquiry_id, p_enquiry);
end;
$$;

create or replace function public.gpt_set_enquiry_status(
  p_enquiry_id uuid,
  p_status public.enquiry_status
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_record_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;
  select e.artist_id into v_record_artist from public.enquiries e where e.id = p_enquiry_id;
  if v_record_artist is distinct from v_artist_id then
    raise exception 'enquiry is outside this GPT artist scope' using errcode = '42501';
  end if;
  return public.transition_enquiry_status(p_enquiry_id, p_status);
end;
$$;

create or replace function public.gpt_list_artist_staff()
returns table (
  profile_id uuid,
  display_name text,
  access_level text
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
  from crm_private.require_gpt_operational_context('crm') c;

  return query
  select m.profile_id, p.display_name, m.access_level::text
  from public.artist_memberships m
  join public.profiles p on p.id = m.profile_id
  where m.artist_id = v_artist_id
    and m.is_active
    and p.is_active
  order by p.display_name, m.profile_id;
end;
$$;

create or replace function public.gpt_assign_enquiry(
  p_enquiry_id uuid,
  p_profile_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_record_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;
  select e.artist_id into v_record_artist from public.enquiries e where e.id = p_enquiry_id;
  if v_record_artist is distinct from v_artist_id then
    raise exception 'enquiry is outside this GPT artist scope' using errcode = '42501';
  end if;
  return public.assign_enquiry(p_enquiry_id, p_profile_id);
end;
$$;

create or replace function public.gpt_convert_enquiry_to_project(
  p_enquiry_id uuid,
  p_title text,
  p_description text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_record_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;
  select e.artist_id into v_record_artist from public.enquiries e where e.id = p_enquiry_id;
  if v_record_artist is distinct from v_artist_id then
    raise exception 'enquiry is outside this GPT artist scope' using errcode = '42501';
  end if;
  return public.convert_enquiry_to_project(p_enquiry_id, p_title, p_description);
end;
$$;

-- Projects ------------------------------------------------------------------

create or replace function public.gpt_list_projects(
  p_status public.project_status default null,
  p_limit integer default 20
)
returns table (
  project_id uuid,
  client_id uuid,
  client_name text,
  enquiry_id uuid,
  status public.project_status,
  title text,
  description text,
  estimated_sessions integer,
  estimated_hours numeric,
  created_at timestamptz,
  updated_at timestamptz
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
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 25);

  return query
  select p.id, p.client_id, c.full_name, p.enquiry_id, p.status,
         p.title, p.description, p.estimated_sessions, p.estimated_hours,
         p.created_at, p.updated_at
  from public.projects p
  join public.clients c on c.id = p.client_id
  where p.artist_id = v_artist_id
    and p.archived_at is null
    and (p_status is null or p.status = p_status)
  order by p.updated_at desc, p.id
  limit v_limit;
end;
$$;

create or replace function public.gpt_get_project(p_project_id uuid)
returns table (
  project_id uuid,
  client_id uuid,
  client_name text,
  enquiry_id uuid,
  status public.project_status,
  title text,
  description text,
  estimated_sessions integer,
  estimated_hours numeric,
  created_at timestamptz,
  updated_at timestamptz
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
  from crm_private.require_gpt_operational_context('crm') c;
  return query
  select p.id, p.client_id, c.full_name, p.enquiry_id, p.status,
         p.title, p.description, p.estimated_sessions, p.estimated_hours,
         p.created_at, p.updated_at
  from public.projects p
  join public.clients c on c.id = p.client_id
  where p.id = p_project_id and p.artist_id = v_artist_id and p.archived_at is null;
end;
$$;

create or replace function public.gpt_set_project_status(
  p_project_id uuid,
  p_status public.project_status
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_project public.projects%rowtype;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;

  select p.* into v_project
  from public.projects p
  where p.id = p_project_id
  for update;
  if not found or v_project.artist_id <> v_artist_id then
    raise exception 'project is outside this GPT artist scope' using errcode = '42501';
  end if;

  if v_project.status = p_status then
    return jsonb_build_object('project_id', p_project_id, 'status', p_status, 'changed', false);
  end if;

  update public.projects p set status = p_status where p.id = p_project_id;
  perform crm_private.log_artist_activity(
    v_artist_id,
    'project.status_changed',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_project.client_id,
    v_project.enquiry_id,
    p_project_id,
    null,
    null,
    jsonb_build_object('from_status', v_project.status, 'to_status', p_status)
  );

  return jsonb_build_object('project_id', p_project_id, 'status', p_status, 'changed', true);
end;
$$;

create or replace function public.gpt_get_project_finance(p_project_id uuid)
returns table (
  project_id uuid,
  hourly_rate numeric,
  estimate_total numeric,
  estimated_sessions integer,
  estimated_hours numeric,
  deposit_amount numeric,
  deposit_status public.deposit_status,
  currency text
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
  from crm_private.require_gpt_operational_context('finance') c;
  return query
  select p.id, p.hourly_rate, p.estimate_total, p.estimated_sessions,
         p.estimated_hours, p.deposit_amount, p.deposit_status, p.currency
  from public.projects p
  where p.id = p_project_id and p.artist_id = v_artist_id and p.archived_at is null;
end;
$$;

create or replace function public.gpt_update_project_estimate(
  p_project_id uuid,
  p_hourly_rate numeric default null,
  p_estimate_total numeric default null,
  p_estimated_sessions integer default null,
  p_estimated_hours numeric default null,
  p_currency text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_record_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('finance') c;
  select p.artist_id into v_record_artist from public.projects p where p.id = p_project_id;
  if v_record_artist is distinct from v_artist_id then
    raise exception 'project is outside this GPT artist scope' using errcode = '42501';
  end if;
  return public.update_project_estimate(
    p_project_id, p_hourly_rate, p_estimate_total,
    p_estimated_sessions, p_estimated_hours, p_currency
  );
end;
$$;

create or replace function public.gpt_update_project_deposit(
  p_project_id uuid,
  p_deposit_amount numeric,
  p_deposit_status public.deposit_status,
  p_currency text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_record_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('finance') c;
  select p.artist_id into v_record_artist from public.projects p where p.id = p_project_id;
  if v_record_artist is distinct from v_artist_id then
    raise exception 'project is outside this GPT artist scope' using errcode = '42501';
  end if;
  return public.update_project_deposit(
    p_project_id, p_deposit_amount, p_deposit_status, p_currency
  );
end;
$$;

-- Notes and follow-ups ------------------------------------------------------

create or replace function public.gpt_list_internal_notes(
  p_client_id uuid default null,
  p_enquiry_id uuid default null,
  p_project_id uuid default null,
  p_session_id uuid default null,
  p_limit integer default 20
)
returns table (
  note_id uuid,
  author_name text,
  client_id uuid,
  enquiry_id uuid,
  project_id uuid,
  session_id uuid,
  body text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_link_artist uuid;
  v_limit integer;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;

  if p_client_id is null and p_enquiry_id is null and p_project_id is null and p_session_id is null then
    raise exception 'at least one linked CRM record is required' using errcode = '22023';
  end if;

  v_link_artist := crm_private.workflow_artist_from_links(
    p_client_id, p_enquiry_id, p_project_id, p_session_id
  );
  if v_link_artist <> v_artist_id then
    raise exception 'linked records are outside this GPT artist scope' using errcode = '42501';
  end if;
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 50);

  return query
  select n.id, p.display_name, n.client_id, n.enquiry_id, n.project_id,
         n.session_id, n.body, n.created_at, n.updated_at
  from public.internal_notes n
  left join public.profiles p on p.id = n.author_profile_id
  where (p_client_id is null or n.client_id = p_client_id)
    and (p_enquiry_id is null or n.enquiry_id = p_enquiry_id)
    and (p_project_id is null or n.project_id = p_project_id)
    and (p_session_id is null or n.session_id = p_session_id)
  order by n.created_at desc, n.id
  limit v_limit;
end;
$$;

create or replace function public.gpt_create_internal_note(
  p_body text,
  p_client_id uuid default null,
  p_enquiry_id uuid default null,
  p_project_id uuid default null,
  p_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_link_artist uuid;
  v_note_id uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;
  v_link_artist := crm_private.workflow_artist_from_links(
    p_client_id, p_enquiry_id, p_project_id, p_session_id
  );
  if v_link_artist <> v_artist_id then
    raise exception 'linked records are outside this GPT artist scope' using errcode = '42501';
  end if;
  v_note_id := public.create_internal_note(
    p_body, p_client_id, p_enquiry_id, p_project_id, p_session_id
  );
  return jsonb_build_object('note_id', v_note_id);
end;
$$;

create or replace function public.gpt_list_follow_ups(
  p_status public.follow_up_status default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit integer default 20
)
returns table (
  follow_up_id uuid,
  status public.follow_up_status,
  due_at timestamptz,
  subject text,
  details text,
  client_id uuid,
  enquiry_id uuid,
  project_id uuid,
  assigned_to uuid,
  assigned_to_name text,
  created_at timestamptz,
  completed_at timestamptz
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
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;
  if p_from is not null and p_to is not null and p_to <= p_from then
    raise exception 'follow-up range end must be after its start' using errcode = '22023';
  end if;
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 50);

  return query
  select f.id, f.status, f.due_at, f.subject, f.details,
         f.client_id, f.enquiry_id, f.project_id, f.assigned_to,
         p.display_name, f.created_at, f.completed_at
  from public.follow_ups f
  left join public.profiles p on p.id = f.assigned_to
  where f.artist_id = v_artist_id
    and (p_status is null or f.status = p_status)
    and (p_from is null or f.due_at >= p_from)
    and (p_to is null or f.due_at < p_to)
  order by f.due_at nulls last, f.created_at desc
  limit v_limit;
end;
$$;

create or replace function public.gpt_create_follow_up(
  p_subject text,
  p_due_at timestamptz,
  p_client_id uuid default null,
  p_enquiry_id uuid default null,
  p_project_id uuid default null,
  p_assigned_to uuid default null,
  p_details text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_link_artist uuid;
  v_id uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;
  v_link_artist := crm_private.workflow_artist_from_links(
    p_client_id, p_enquiry_id, p_project_id, null
  );
  if v_link_artist <> v_artist_id then
    raise exception 'linked records are outside this GPT artist scope' using errcode = '42501';
  end if;
  v_id := public.create_follow_up(
    p_subject, p_due_at, p_client_id, p_enquiry_id,
    p_project_id, p_assigned_to, p_details
  );
  return jsonb_build_object('follow_up_id', v_id);
end;
$$;

create or replace function public.gpt_complete_follow_up(p_follow_up_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_record_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;
  select f.artist_id into v_record_artist from public.follow_ups f where f.id = p_follow_up_id;
  if v_record_artist is distinct from v_artist_id then
    raise exception 'follow-up is outside this GPT artist scope' using errcode = '42501';
  end if;
  return public.complete_follow_up(p_follow_up_id);
end;
$$;

-- Appointment status and availability --------------------------------------

create or replace function public.gpt_set_appointment_status(
  p_appointment_id uuid,
  p_status public.session_status
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_record_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_action_context(true) c;
  select s.artist_id into v_record_artist from public.sessions s where s.id = p_appointment_id;
  if v_record_artist is distinct from v_artist_id then
    raise exception 'appointment is outside this GPT artist scope' using errcode = '42501';
  end if;
  return public.set_appointment_status(p_appointment_id, p_status);
end;
$$;

create or replace function public.gpt_list_availability_blocks(
  p_from timestamptz,
  p_to timestamptz,
  p_include_cancelled boolean default false
)
returns table (
  block_id uuid,
  block_kind public.availability_block_kind,
  start_at timestamptz,
  end_at timestamptz,
  is_all_day boolean,
  note text,
  cancelled_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
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
  from crm_private.require_gpt_action_context(false) c;
  return query
  select b.block_id, b.block_kind, b.start_at, b.end_at, b.is_all_day,
         b.note, b.cancelled_at, b.created_at, b.updated_at
  from public.list_artist_availability_blocks(
    v_artist_id, p_from, p_to, coalesce(p_include_cancelled, false)
  ) b;
end;
$$;

create or replace function public.gpt_create_availability_block(
  p_block_kind public.availability_block_kind,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_is_all_day boolean default false,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_action_context(true) c;
  return public.create_artist_availability_block(
    v_artist_id, p_block_kind, p_start_at, p_end_at, p_is_all_day, p_note
  );
end;
$$;

create or replace function public.gpt_update_availability_block(
  p_block_id uuid,
  p_block_kind public.availability_block_kind,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_is_all_day boolean default false,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_record_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_action_context(true) c;
  select b.artist_id into v_record_artist from public.artist_availability_blocks b where b.id = p_block_id;
  if v_record_artist is distinct from v_artist_id then
    raise exception 'availability block is outside this GPT artist scope' using errcode = '42501';
  end if;
  return public.update_artist_availability_block(
    p_block_id, p_block_kind, p_start_at, p_end_at, p_is_all_day, p_note
  );
end;
$$;

create or replace function public.gpt_cancel_availability_block(p_block_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_record_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_action_context(true) c;
  select b.artist_id into v_record_artist from public.artist_availability_blocks b where b.id = p_block_id;
  if v_record_artist is distinct from v_artist_id then
    raise exception 'availability block is outside this GPT artist scope' using errcode = '42501';
  end if;
  return public.cancel_artist_availability_block(p_block_id);
end;
$$;

-- Finance -------------------------------------------------------------------

create or replace function public.gpt_list_payment_requests(
  p_status public.payment_request_status default null,
  p_limit integer default 20
)
returns table (
  payment_request_id uuid,
  client_id uuid,
  client_name text,
  project_id uuid,
  session_id uuid,
  purpose public.payment_request_purpose,
  amount numeric,
  currency text,
  status public.payment_request_status,
  expires_at timestamptz,
  created_at timestamptz,
  paid_amount numeric
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
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('finance') c;
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 50);

  return query
  select r.id, r.client_id, c.full_name, r.project_id, r.session_id,
         r.purpose, r.amount, r.currency, r.status, r.expires_at, r.created_at,
         coalesce((select sum(t.amount) from public.payment_transactions t
                   where t.payment_request_id = r.id and t.status = 'succeeded'), 0)
  from public.payment_requests r
  join public.clients c on c.id = r.client_id
  where r.artist_id = v_artist_id
    and (p_status is null or r.status = p_status)
  order by r.created_at desc, r.id
  limit v_limit;
end;
$$;

create or replace function public.gpt_request_session_deposit(
  p_session_id uuid,
  p_idempotency_key uuid,
  p_delivery_channel text default 'email'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_record_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('finance') c;
  select s.artist_id into v_record_artist from public.sessions s where s.id = p_session_id;
  if v_record_artist is distinct from v_artist_id then
    raise exception 'appointment is outside this GPT artist scope' using errcode = '42501';
  end if;
  return public.request_session_deposit(p_session_id, p_idempotency_key, p_delivery_channel);
end;
$$;

create or replace function public.gpt_cancel_payment_request(p_payment_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_record_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('finance') c;
  select r.artist_id into v_record_artist from public.payment_requests r where r.id = p_payment_request_id;
  if v_record_artist is distinct from v_artist_id then
    raise exception 'payment request is outside this GPT artist scope' using errcode = '42501';
  end if;
  return public.cancel_payment_request(p_payment_request_id);
end;
$$;

create or replace function public.gpt_record_manual_payment(
  p_payment_request_id uuid,
  p_idempotency_key uuid,
  p_amount numeric,
  p_occurred_at timestamptz default now(),
  p_safe_note_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_record_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('finance') c;
  select r.artist_id into v_record_artist from public.payment_requests r where r.id = p_payment_request_id;
  if v_record_artist is distinct from v_artist_id then
    raise exception 'payment request is outside this GPT artist scope' using errcode = '42501';
  end if;
  return public.record_manual_payment(
    p_payment_request_id, p_idempotency_key, p_amount, p_occurred_at, p_safe_note_code
  );
end;
$$;

-- Communications -----------------------------------------------------------

create or replace function public.gpt_get_whatsapp_conversation_for_enquiry(p_enquiry_id uuid)
returns table (
  conversation_id uuid,
  client_id uuid,
  contact_label text,
  last_message_at timestamptz,
  last_inbound_at timestamptz
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
  from crm_private.require_gpt_operational_context('communications') c;
  return query
  select wc.id, wc.client_id, wc.contact_label, wc.last_message_at, wc.last_inbound_at
  from public.enquiries e
  join public.whatsapp_conversations wc
    on wc.artist_id = e.artist_id and wc.client_id = e.client_id
  where e.id = p_enquiry_id and e.artist_id = v_artist_id
  order by wc.updated_at desc
  limit 1;
end;
$$;

create or replace function public.gpt_ensure_whatsapp_conversation(p_enquiry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_record_artist uuid;
  v_result jsonb;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('communications') c;
  select e.artist_id into v_record_artist from public.enquiries e where e.id = p_enquiry_id;
  if v_record_artist is distinct from v_artist_id then
    raise exception 'enquiry is outside this GPT artist scope' using errcode = '42501';
  end if;
  v_result := public.ensure_whatsapp_conversation_for_enquiry(p_enquiry_id);
  return jsonb_build_object(
    'conversation_id', v_result ->> 'conversation_id',
    'client_id', v_result ->> 'client_id',
    'created', coalesce((v_result ->> 'created')::boolean, false)
  );
end;
$$;

create or replace function public.gpt_list_whatsapp_messages(
  p_conversation_id uuid,
  p_limit integer default 20
)
returns table (
  message_id uuid,
  direction public.whatsapp_message_direction,
  status public.whatsapp_message_status,
  message_type text,
  body text,
  provider_timestamp timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_conversation_artist uuid;
  v_limit integer;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('communications') c;
  select wc.artist_id into v_conversation_artist
  from public.whatsapp_conversations wc where wc.id = p_conversation_id;
  if v_conversation_artist is distinct from v_artist_id then
    raise exception 'WhatsApp conversation is outside this GPT artist scope' using errcode = '42501';
  end if;
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 50);

  return query
  select m.id, m.direction, m.status, m.message_type, m.body,
         m.provider_timestamp, m.delivered_at, m.read_at, m.failed_at, m.created_at
  from public.whatsapp_messages m
  where m.conversation_id = p_conversation_id and m.artist_id = v_artist_id
  order by m.created_at desc, m.id
  limit v_limit;
end;
$$;

create or replace function public.gpt_send_whatsapp_message(
  p_conversation_id uuid,
  p_body text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_conversation_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('communications') c;
  select wc.artist_id into v_conversation_artist
  from public.whatsapp_conversations wc where wc.id = p_conversation_id;
  if v_conversation_artist is distinct from v_artist_id then
    raise exception 'WhatsApp conversation is outside this GPT artist scope' using errcode = '42501';
  end if;
  return public.queue_whatsapp_message(p_conversation_id, p_body, p_request_id);
end;
$$;

create or replace function public.gpt_list_email_messages(
  p_enquiry_id uuid,
  p_limit integer default 20
)
returns table (
  email_message_id uuid,
  status public.email_message_status,
  to_email text,
  subject text,
  body text,
  created_at timestamptz,
  approved_at timestamptz,
  queued_at timestamptz,
  sent_at timestamptz,
  failed_at timestamptz,
  error_code text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_record_artist uuid;
  v_limit integer;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('communications') c;
  select e.artist_id into v_record_artist from public.enquiries e where e.id = p_enquiry_id;
  if v_record_artist is distinct from v_artist_id then
    raise exception 'enquiry is outside this GPT artist scope' using errcode = '42501';
  end if;
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 50);

  return query
  select m.id, m.status, m.to_email, m.subject, m.body, m.created_at,
         m.approved_at, m.queued_at, m.sent_at, m.failed_at, m.error_code
  from public.email_messages m
  where m.artist_id = v_artist_id and m.enquiry_id = p_enquiry_id
  order by m.created_at desc, m.id
  limit v_limit;
end;
$$;

create or replace function public.gpt_create_email_draft(
  p_enquiry_id uuid,
  p_subject text,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_enquiry public.enquiries%rowtype;
  v_email text;
  v_id uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('communications') c;
  select e.* into v_enquiry from public.enquiries e where e.id = p_enquiry_id;
  if not found or v_enquiry.artist_id <> v_artist_id then
    raise exception 'enquiry is outside this GPT artist scope' using errcode = '42501';
  end if;
  select c.email into v_email from public.clients c where c.id = v_enquiry.client_id;
  if nullif(btrim(v_email), '') is null then
    raise exception 'client has no email address' using errcode = '22023';
  end if;

  v_id := public.create_email_draft(
    v_email, p_subject, p_body,
    v_enquiry.client_id, p_enquiry_id, null, 'ai'
  );
  return jsonb_build_object('email_message_id', v_id, 'status', 'draft');
end;
$$;

create or replace function public.gpt_approve_email_draft(p_email_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_record_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('communications') c;
  select m.artist_id into v_record_artist from public.email_messages m where m.id = p_email_message_id;
  if v_record_artist is distinct from v_artist_id then
    raise exception 'email draft is outside this GPT artist scope' using errcode = '42501';
  end if;
  return public.approve_email_draft(p_email_message_id);
end;
$$;

-- Private file metadata only ------------------------------------------------

create or replace function public.gpt_list_enquiry_files(p_enquiry_id uuid)
returns table (
  file_id uuid,
  ordinal smallint,
  category public.enquiry_file_category,
  original_filename text,
  mime_type text,
  byte_size bigint,
  upload_state public.enquiry_upload_state,
  uploaded_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_record_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;
  select e.artist_id into v_record_artist from public.enquiries e where e.id = p_enquiry_id;
  if v_record_artist is distinct from v_artist_id then
    raise exception 'enquiry is outside this GPT artist scope' using errcode = '42501';
  end if;
  return query
  select f.id, f.ordinal, f.category, f.original_filename, f.mime_type,
         f.byte_size, f.upload_state, f.uploaded_at
  from public.enquiry_files f
  where f.enquiry_id = p_enquiry_id
  order by f.ordinal, f.id;
end;
$$;

create or replace function public.gpt_list_project_files(p_project_id uuid)
returns table (
  file_id uuid,
  session_id uuid,
  category public.enquiry_file_category,
  original_filename text,
  mime_type text,
  byte_size bigint,
  upload_state public.enquiry_upload_state,
  uploaded_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_record_artist uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;
  select p.artist_id into v_record_artist from public.projects p where p.id = p_project_id;
  if v_record_artist is distinct from v_artist_id then
    raise exception 'project is outside this GPT artist scope' using errcode = '42501';
  end if;
  return query
  select f.id, f.session_id, f.category, f.original_filename, f.mime_type,
         f.byte_size, f.upload_state, f.uploaded_at
  from public.project_files f
  where f.project_id = p_project_id
  order by f.created_at, f.id;
end;
$$;

-- Grants --------------------------------------------------------------------

revoke all on function public.configure_gpt_full_management(text,boolean,boolean,boolean)
  from public, anon, authenticated, service_role;

grant execute on function public.configure_gpt_full_management(text,boolean,boolean,boolean)
  to authenticated;

revoke all on function public.gpt_get_client(uuid) from public, anon, authenticated, service_role;
revoke all on function public.gpt_update_client(uuid,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.gpt_get_enquiry_full(uuid) from public, anon, authenticated, service_role;
revoke all on function public.gpt_update_enquiry(uuid,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.gpt_set_enquiry_status(uuid,public.enquiry_status) from public, anon, authenticated, service_role;
revoke all on function public.gpt_list_artist_staff() from public, anon, authenticated, service_role;
revoke all on function public.gpt_assign_enquiry(uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function public.gpt_convert_enquiry_to_project(uuid,text,text) from public, anon, authenticated, service_role;
revoke all on function public.gpt_list_projects(public.project_status,integer) from public, anon, authenticated, service_role;
revoke all on function public.gpt_get_project(uuid) from public, anon, authenticated, service_role;
revoke all on function public.gpt_set_project_status(uuid,public.project_status) from public, anon, authenticated, service_role;
revoke all on function public.gpt_get_project_finance(uuid) from public, anon, authenticated, service_role;
revoke all on function public.gpt_update_project_estimate(uuid,numeric,numeric,integer,numeric,text) from public, anon, authenticated, service_role;
revoke all on function public.gpt_update_project_deposit(uuid,numeric,public.deposit_status,text) from public, anon, authenticated, service_role;
revoke all on function public.gpt_list_internal_notes(uuid,uuid,uuid,uuid,integer) from public, anon, authenticated, service_role;
revoke all on function public.gpt_create_internal_note(text,uuid,uuid,uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function public.gpt_list_follow_ups(public.follow_up_status,timestamptz,timestamptz,integer) from public, anon, authenticated, service_role;
revoke all on function public.gpt_create_follow_up(text,timestamptz,uuid,uuid,uuid,uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.gpt_complete_follow_up(uuid) from public, anon, authenticated, service_role;
revoke all on function public.gpt_set_appointment_status(uuid,public.session_status) from public, anon, authenticated, service_role;
revoke all on function public.gpt_list_availability_blocks(timestamptz,timestamptz,boolean) from public, anon, authenticated, service_role;
revoke all on function public.gpt_create_availability_block(public.availability_block_kind,timestamptz,timestamptz,boolean,text) from public, anon, authenticated, service_role;
revoke all on function public.gpt_update_availability_block(uuid,public.availability_block_kind,timestamptz,timestamptz,boolean,text) from public, anon, authenticated, service_role;
revoke all on function public.gpt_cancel_availability_block(uuid) from public, anon, authenticated, service_role;
revoke all on function public.gpt_list_payment_requests(public.payment_request_status,integer) from public, anon, authenticated, service_role;
revoke all on function public.gpt_request_session_deposit(uuid,uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.gpt_cancel_payment_request(uuid) from public, anon, authenticated, service_role;
revoke all on function public.gpt_record_manual_payment(uuid,uuid,numeric,timestamptz,text) from public, anon, authenticated, service_role;
revoke all on function public.gpt_get_whatsapp_conversation_for_enquiry(uuid) from public, anon, authenticated, service_role;
revoke all on function public.gpt_ensure_whatsapp_conversation(uuid) from public, anon, authenticated, service_role;
revoke all on function public.gpt_list_whatsapp_messages(uuid,integer) from public, anon, authenticated, service_role;
revoke all on function public.gpt_send_whatsapp_message(uuid,text,uuid) from public, anon, authenticated, service_role;
revoke all on function public.gpt_list_email_messages(uuid,integer) from public, anon, authenticated, service_role;
revoke all on function public.gpt_create_email_draft(uuid,text,text) from public, anon, authenticated, service_role;
revoke all on function public.gpt_approve_email_draft(uuid) from public, anon, authenticated, service_role;
revoke all on function public.gpt_list_enquiry_files(uuid) from public, anon, authenticated, service_role;
revoke all on function public.gpt_list_project_files(uuid) from public, anon, authenticated, service_role;

grant execute on function public.gpt_get_client(uuid) to authenticated;
grant execute on function public.gpt_update_client(uuid,jsonb) to authenticated;
grant execute on function public.gpt_get_enquiry_full(uuid) to authenticated;
grant execute on function public.gpt_update_enquiry(uuid,jsonb) to authenticated;
grant execute on function public.gpt_set_enquiry_status(uuid,public.enquiry_status) to authenticated;
grant execute on function public.gpt_list_artist_staff() to authenticated;
grant execute on function public.gpt_assign_enquiry(uuid,uuid) to authenticated;
grant execute on function public.gpt_convert_enquiry_to_project(uuid,text,text) to authenticated;
grant execute on function public.gpt_list_projects(public.project_status,integer) to authenticated;
grant execute on function public.gpt_get_project(uuid) to authenticated;
grant execute on function public.gpt_set_project_status(uuid,public.project_status) to authenticated;
grant execute on function public.gpt_get_project_finance(uuid) to authenticated;
grant execute on function public.gpt_update_project_estimate(uuid,numeric,numeric,integer,numeric,text) to authenticated;
grant execute on function public.gpt_update_project_deposit(uuid,numeric,public.deposit_status,text) to authenticated;
grant execute on function public.gpt_list_internal_notes(uuid,uuid,uuid,uuid,integer) to authenticated;
grant execute on function public.gpt_create_internal_note(text,uuid,uuid,uuid,uuid) to authenticated;
grant execute on function public.gpt_list_follow_ups(public.follow_up_status,timestamptz,timestamptz,integer) to authenticated;
grant execute on function public.gpt_create_follow_up(text,timestamptz,uuid,uuid,uuid,uuid,text) to authenticated;
grant execute on function public.gpt_complete_follow_up(uuid) to authenticated;
grant execute on function public.gpt_set_appointment_status(uuid,public.session_status) to authenticated;
grant execute on function public.gpt_list_availability_blocks(timestamptz,timestamptz,boolean) to authenticated;
grant execute on function public.gpt_create_availability_block(public.availability_block_kind,timestamptz,timestamptz,boolean,text) to authenticated;
grant execute on function public.gpt_update_availability_block(uuid,public.availability_block_kind,timestamptz,timestamptz,boolean,text) to authenticated;
grant execute on function public.gpt_cancel_availability_block(uuid) to authenticated;
grant execute on function public.gpt_list_payment_requests(public.payment_request_status,integer) to authenticated;
grant execute on function public.gpt_request_session_deposit(uuid,uuid,text) to authenticated;
grant execute on function public.gpt_cancel_payment_request(uuid) to authenticated;
grant execute on function public.gpt_record_manual_payment(uuid,uuid,numeric,timestamptz,text) to authenticated;
grant execute on function public.gpt_get_whatsapp_conversation_for_enquiry(uuid) to authenticated;
grant execute on function public.gpt_ensure_whatsapp_conversation(uuid) to authenticated;
grant execute on function public.gpt_list_whatsapp_messages(uuid,integer) to authenticated;
grant execute on function public.gpt_send_whatsapp_message(uuid,text,uuid) to authenticated;
grant execute on function public.gpt_list_email_messages(uuid,integer) to authenticated;
grant execute on function public.gpt_create_email_draft(uuid,text,text) to authenticated;
grant execute on function public.gpt_approve_email_draft(uuid) to authenticated;
grant execute on function public.gpt_list_enquiry_files(uuid) to authenticated;
grant execute on function public.gpt_list_project_files(uuid) to authenticated;
