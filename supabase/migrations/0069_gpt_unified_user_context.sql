-- 0069_gpt_unified_user_context.sql
--
-- Introduce one user-centric GPT OAuth application while preserving the two
-- existing artist-bound OAuth clients during a controlled transition.
--
-- Authority is always:
--   authenticated profile -> active membership -> server-selected artist
--   -> artist GPT policy -> operation capability.
--
-- The model may request an artist slug, but the database never treats that
-- request as authority and never accepts an artist UUID on the GPT surface.

-- ---------------------------------------------------------------------------
-- OAuth application and per-user active artist context
-- ---------------------------------------------------------------------------

create table crm_private.gpt_oauth_applications (
  id              uuid primary key,
  application_key text not null unique,
  display_name    text not null,
  oauth_client_id text unique,
  is_active       boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint gpt_oauth_applications_key_shape
    check (application_key ~ '^[a-z][a-z0-9_-]{2,79}$'),
  constraint gpt_oauth_applications_display_name
    check (btrim(display_name) <> '' and char_length(display_name) <= 120),
  constraint gpt_oauth_applications_client_shape
    check (
      oauth_client_id is null
      or (
        btrim(oauth_client_id) = oauth_client_id
        and char_length(oauth_client_id) between 8 and 200
        and oauth_client_id ~ '^[A-Za-z0-9._:-]+$'
      )
    ),
  constraint gpt_oauth_applications_active_requires_client
    check (not is_active or oauth_client_id is not null)
);

create trigger gpt_oauth_applications_set_updated_at
  before update on crm_private.gpt_oauth_applications
  for each row execute function public.set_updated_at();

create table crm_private.gpt_user_artist_contexts (
  oauth_application_id uuid not null
    references crm_private.gpt_oauth_applications(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  artist_id uuid not null references public.artists(id) on delete restrict,
  selected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (oauth_application_id, profile_id)
);

create trigger gpt_user_artist_contexts_set_updated_at
  before update on crm_private.gpt_user_artist_contexts
  for each row execute function public.set_updated_at();

revoke all on crm_private.gpt_oauth_applications,
  crm_private.gpt_user_artist_contexts
  from public, anon, authenticated, service_role;

comment on table crm_private.gpt_oauth_applications is
  'Allow-list of GPT OAuth applications. A unified application identifies the app, never an artist.';
comment on table crm_private.gpt_user_artist_contexts is
  'Server-controlled active artist selection for one authenticated profile and unified GPT OAuth application.';

insert into crm_private.gpt_oauth_applications (
  id, application_key, display_name, is_active
) values (
  'c9999999-9999-4999-8999-999999999999',
  'vishar-unified-gpt',
  'Vishar CRM GPT',
  false
);

-- gpt_action_clients becomes the per-artist policy record. Existing OAuth
-- bindings remain valid for legacy clients, but a new artist policy no longer
-- needs its own OAuth client merely to become available to the unified app.
alter table crm_private.gpt_action_clients
  drop constraint gpt_action_clients_active_requires_client;

alter table crm_private.gpt_action_clients
  add constraint gpt_action_clients_artist_key unique (artist_id);

comment on table crm_private.gpt_action_clients is
  'Per-artist GPT capability policy. oauth_client_id is retained only for legacy fixed-artist OAuth compatibility.';
comment on column crm_private.gpt_action_clients.oauth_client_id is
  'Optional non-secret legacy OAuth client identifier. Unified GPT artist scope is not derived from this column.';

-- A client id must identify either one unified application or one legacy
-- policy, never both. This remains true even when the old owner configuration
-- RPC is used during the transition.
create or replace function crm_private.prevent_gpt_oauth_client_collision()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.oauth_client_id is null then
    return new;
  end if;

  if tg_table_name = 'gpt_oauth_applications' then
    if exists (
      select 1 from crm_private.gpt_action_clients c
      where c.oauth_client_id = new.oauth_client_id
    ) then
      raise exception 'OAuth client is already assigned to a legacy GPT policy'
        using errcode = '23505';
    end if;
  elsif exists (
    select 1 from crm_private.gpt_oauth_applications a
    where a.oauth_client_id = new.oauth_client_id
  ) then
    raise exception 'OAuth client is already assigned to a unified GPT application'
      using errcode = '23505';
  end if;

  return new;
end;
$$;

create trigger gpt_oauth_applications_no_client_collision
  before insert or update of oauth_client_id
  on crm_private.gpt_oauth_applications
  for each row execute function crm_private.prevent_gpt_oauth_client_collision();

create trigger gpt_action_clients_no_application_collision
  before insert or update of oauth_client_id
  on crm_private.gpt_action_clients
  for each row execute function crm_private.prevent_gpt_oauth_client_collision();

revoke all on function crm_private.prevent_gpt_oauth_client_collision()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Canonical identity, accessible-policy and operational-context resolvers
-- ---------------------------------------------------------------------------

create or replace function crm_private.resolve_gpt_oauth_identity(
  p_oauth_client_id text
)
returns table (
  identity_mode text,
  oauth_application_id uuid,
  legacy_gpt_client_id uuid,
  oauth_client_id text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client_id text := nullif(btrim(coalesce(p_oauth_client_id, '')), '');
  v_application crm_private.gpt_oauth_applications%rowtype;
  v_legacy crm_private.gpt_action_clients%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authenticated GPT OAuth user is required'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from crm_private.profile_access p
    where p.profile_id = auth.uid() and p.is_active
  ) then
    raise exception 'an active CRM profile is required'
      using errcode = '42501';
  end if;

  if v_client_id is null then
    raise exception 'a Supabase OAuth client token is required'
      using errcode = '42501';
  end if;

  select a.* into v_application
  from crm_private.gpt_oauth_applications a
  where a.oauth_client_id = v_client_id and a.is_active;

  select c.* into v_legacy
  from crm_private.gpt_action_clients c
  where c.oauth_client_id = v_client_id and c.is_active;

  if v_application.id is not null and v_legacy.id is not null then
    raise exception 'ambiguous GPT OAuth client configuration'
      using errcode = '42501';
  elsif v_application.id is not null then
    return query select 'unified_user'::text, v_application.id, null::uuid, v_client_id;
  elsif v_legacy.id is not null then
    return query select 'legacy_fixed'::text, null::uuid, v_legacy.id, v_client_id;
  else
    raise exception 'this GPT OAuth client is not enabled'
      using errcode = '42501';
  end if;
end;
$$;

create or replace function crm_private.gpt_accessible_artist_policies(
  p_oauth_client_id text
)
returns table (
  gpt_client_id uuid,
  artist_id uuid,
  artist_key text,
  artist_display_name text,
  integration_key text,
  identity_mode text,
  oauth_application_id uuid
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_identity record;
begin
  select * into v_identity
  from crm_private.resolve_gpt_oauth_identity(p_oauth_client_id);

  if v_identity.identity_mode = 'legacy_fixed' then
    return query
    select c.id, c.artist_id, a.slug, a.display_name, c.integration_key,
           v_identity.identity_mode, null::uuid
    from crm_private.gpt_action_clients c
    join public.artists a on a.id = c.artist_id and a.is_active
    where c.id = v_identity.legacy_gpt_client_id
      and c.is_active
      and crm_private.has_artist_capability(c.artist_id, 'view');
  else
    return query
    select c.id, c.artist_id, a.slug, a.display_name, c.integration_key,
           v_identity.identity_mode, v_identity.oauth_application_id
    from crm_private.gpt_action_clients c
    join public.artists a on a.id = c.artist_id and a.is_active
    where c.is_active
      and crm_private.has_artist_capability(c.artist_id, 'view')
    order by a.display_name, a.id;
  end if;
end;
$$;

create or replace function crm_private.require_gpt_identity_context(
  p_capability text
)
returns table (
  gpt_client_id uuid,
  artist_id uuid,
  integration_key text,
  identity_mode text,
  oauth_application_id uuid
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_oauth_client_id text := nullif(btrim(auth.jwt() ->> 'client_id'), '');
  v_capability text := lower(btrim(coalesce(p_capability, '')));
  v_identity record;
  v_policy crm_private.gpt_action_clients%rowtype;
  v_accessible_count integer;
  v_selected_artist uuid;
begin
  if v_capability not in (
    'appointment_read', 'appointment_write', 'enquiry_read',
    'crm', 'finance', 'communications'
  ) then
    raise exception 'unknown GPT operational capability'
      using errcode = '22023';
  end if;

  select * into v_identity
  from crm_private.resolve_gpt_oauth_identity(v_oauth_client_id);

  if v_identity.identity_mode = 'legacy_fixed' then
    select c.* into v_policy
    from crm_private.gpt_accessible_artist_policies(v_oauth_client_id) p
    join crm_private.gpt_action_clients c on c.id = p.gpt_client_id;
  else
    select x.artist_id into v_selected_artist
    from crm_private.gpt_user_artist_contexts x
    where x.oauth_application_id = v_identity.oauth_application_id
      and x.profile_id = auth.uid();

    if v_selected_artist is not null then
      select c.* into v_policy
      from crm_private.gpt_accessible_artist_policies(v_oauth_client_id) p
      join crm_private.gpt_action_clients c on c.id = p.gpt_client_id
      where p.artist_id = v_selected_artist;
    end if;

    if v_policy.id is null then
      select count(*)::integer into v_accessible_count
      from crm_private.gpt_accessible_artist_policies(v_oauth_client_id);

      if v_accessible_count = 1 then
        select c.* into v_policy
        from crm_private.gpt_accessible_artist_policies(v_oauth_client_id) p
        join crm_private.gpt_action_clients c on c.id = p.gpt_client_id;
      elsif v_accessible_count = 0 then
        raise exception 'no GPT artist scope is available for this user'
          using errcode = '42501';
      else
        raise exception 'active artist context is required'
          using errcode = '42501';
      end if;
    end if;
  end if;

  if v_policy.id is null then
    raise exception 'the selected GPT artist context is no longer available'
      using errcode = '42501';
  end if;

  perform crm_private.require_active_artist(v_policy.artist_id);

  if v_capability = 'appointment_read' then
    if not v_policy.can_read_appointments then
      raise exception 'this GPT artist policy cannot read appointments' using errcode = '42501';
    end if;
    perform crm_private.require_artist_access(v_policy.artist_id, 'view');
  elsif v_capability = 'appointment_write' then
    if not v_policy.can_manage_appointments then
      raise exception 'this GPT artist policy cannot manage appointments' using errcode = '42501';
    end if;
    perform crm_private.require_artist_access(v_policy.artist_id, 'manage_sessions');
  elsif v_capability = 'enquiry_read' then
    if not v_policy.can_read_enquiries then
      raise exception 'this GPT artist policy cannot read enquiries' using errcode = '42501';
    end if;
    perform crm_private.require_artist_access(v_policy.artist_id, 'view');
  elsif v_capability = 'crm' then
    if not v_policy.can_manage_crm then
      raise exception 'this GPT artist policy cannot manage CRM records' using errcode = '42501';
    end if;
    perform crm_private.require_artist_access(v_policy.artist_id, 'manage');
  elsif v_capability = 'finance' then
    if not v_policy.can_manage_finance then
      raise exception 'this GPT artist policy cannot manage finance' using errcode = '42501';
    end if;
    perform crm_private.require_artist_access(v_policy.artist_id, 'manage_finance');
  elsif v_capability = 'communications' then
    if not v_policy.can_manage_communications then
      raise exception 'this GPT artist policy cannot manage communications' using errcode = '42501';
    end if;
    perform crm_private.require_artist_access(v_policy.artist_id, 'manage');
  end if;

  return query
  select v_policy.id, v_policy.artist_id, v_policy.integration_key,
         v_identity.identity_mode, v_identity.oauth_application_id;
end;
$$;

revoke all on function crm_private.resolve_gpt_oauth_identity(text),
  crm_private.gpt_accessible_artist_policies(text),
  crm_private.require_gpt_identity_context(text)
  from public, anon, authenticated, service_role;

-- Every existing GPT domain now delegates to the same canonical resolver.
create or replace function crm_private.require_gpt_action_context(p_write boolean)
returns table (gpt_client_id uuid, artist_id uuid, integration_key text)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select c.gpt_client_id, c.artist_id, c.integration_key
  from crm_private.require_gpt_identity_context(
    case when p_write then 'appointment_write' else 'appointment_read' end
  ) c;
$$;

create or replace function crm_private.require_gpt_enquiry_context()
returns table (gpt_client_id uuid, artist_id uuid, integration_key text)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select c.gpt_client_id, c.artist_id, c.integration_key
  from crm_private.require_gpt_identity_context('enquiry_read') c;
$$;

create or replace function crm_private.require_gpt_operational_context(p_capability text)
returns table (gpt_client_id uuid, artist_id uuid, integration_key text)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select c.gpt_client_id, c.artist_id, c.integration_key
  from crm_private.require_gpt_identity_context(p_capability) c;
$$;

revoke all on function crm_private.require_gpt_action_context(boolean),
  crm_private.require_gpt_enquiry_context(),
  crm_private.require_gpt_operational_context(text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Minimal GPT artist-context surface (no UUIDs, capabilities or providers)
-- ---------------------------------------------------------------------------

create or replace function public.gpt_list_accessible_artists()
returns table (artist_key text, display_name text, is_active boolean)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client_id text := nullif(btrim(auth.jwt() ->> 'client_id'), '');
  v_identity record;
  v_selected_artist uuid;
  v_count integer;
begin
  select * into v_identity
  from crm_private.resolve_gpt_oauth_identity(v_client_id);

  if v_identity.identity_mode = 'unified_user' then
    select x.artist_id into v_selected_artist
    from crm_private.gpt_user_artist_contexts x
    where x.oauth_application_id = v_identity.oauth_application_id
      and x.profile_id = auth.uid();
  end if;

  select count(*)::integer into v_count
  from crm_private.gpt_accessible_artist_policies(v_client_id);

  return query
  select p.artist_key, p.artist_display_name,
         case
           when p.identity_mode = 'legacy_fixed' then true
           when v_count = 1 then true
           else p.artist_id = v_selected_artist
         end
  from crm_private.gpt_accessible_artist_policies(v_client_id) p
  order by p.artist_display_name, p.artist_key;
end;
$$;

create or replace function public.gpt_get_artist_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client_id text := nullif(btrim(auth.jwt() ->> 'client_id'), '');
  v_identity record;
  v_active record;
  v_count integer;
begin
  select * into v_identity
  from crm_private.resolve_gpt_oauth_identity(v_client_id);

  select count(*)::integer into v_count
  from crm_private.gpt_accessible_artist_policies(v_client_id);

  if v_identity.identity_mode = 'legacy_fixed' or v_count = 1 then
    select p.artist_key, p.artist_display_name into v_active
    from crm_private.gpt_accessible_artist_policies(v_client_id) p
    limit 1;
  else
    select p.artist_key, p.artist_display_name into v_active
    from crm_private.gpt_user_artist_contexts x
    join crm_private.gpt_accessible_artist_policies(v_client_id) p
      on p.artist_id = x.artist_id
    where x.oauth_application_id = v_identity.oauth_application_id
      and x.profile_id = auth.uid();
  end if;

  return jsonb_build_object(
    'active_artist', case when v_active.artist_key is null then null else
      jsonb_build_object('key', v_active.artist_key, 'display_name', v_active.artist_display_name) end,
    'accessible_artist_count', v_count,
    'selection_required', v_count > 1 and v_active.artist_key is null
  );
end;
$$;

create or replace function public.gpt_set_active_artist(p_artist_key text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client_id text := nullif(btrim(auth.jwt() ->> 'client_id'), '');
  v_key text := lower(btrim(coalesce(p_artist_key, '')));
  v_identity record;
  v_policy record;
  v_previous_artist uuid;
begin
  if v_key !~ '^[a-z][a-z0-9-]{1,62}$' then
    raise exception 'a valid artist key is required' using errcode = '22023';
  end if;

  select * into v_identity
  from crm_private.resolve_gpt_oauth_identity(v_client_id);

  select * into v_policy
  from crm_private.gpt_accessible_artist_policies(v_client_id) p
  where p.artist_key = v_key;

  if v_policy.artist_id is null then
    raise exception 'artist context is not available to this user'
      using errcode = '42501';
  end if;

  if v_identity.identity_mode = 'legacy_fixed' then
    return jsonb_build_object(
      'active_artist', jsonb_build_object('key', v_policy.artist_key, 'display_name', v_policy.artist_display_name),
      'changed', false
    );
  end if;

  select x.artist_id into v_previous_artist
  from crm_private.gpt_user_artist_contexts x
  where x.oauth_application_id = v_identity.oauth_application_id
    and x.profile_id = auth.uid();

  insert into crm_private.gpt_user_artist_contexts (
    oauth_application_id, profile_id, artist_id, selected_at
  ) values (
    v_identity.oauth_application_id, auth.uid(), v_policy.artist_id, now()
  )
  on conflict (oauth_application_id, profile_id) do update
    set artist_id = excluded.artist_id,
        selected_at = excluded.selected_at,
        updated_at = now();

  insert into public.activity_log (
    event_type, actor_profile_id, actor_kind, artist_id, metadata
  ) values (
    'gpt.artist_context_changed', auth.uid(), 'ai', v_policy.artist_id,
    jsonb_build_object('artist_key', v_policy.artist_key)
  );

  return jsonb_build_object(
    'active_artist', jsonb_build_object('key', v_policy.artist_key, 'display_name', v_policy.artist_display_name),
    'changed', v_previous_artist is distinct from v_policy.artist_id
  );
end;
$$;

revoke all on function public.gpt_list_accessible_artists(),
  public.gpt_get_artist_context(),
  public.gpt_set_active_artist(text)
  from public, anon, authenticated, service_role;
grant execute on function public.gpt_list_accessible_artists(),
  public.gpt_get_artist_context(),
  public.gpt_set_active_artist(text)
  to authenticated;

comment on function public.gpt_list_accessible_artists() is
  'Lists only artist key, display name and active selection for the authenticated GPT user. No membership, capability or provider metadata is returned.';
comment on function public.gpt_set_active_artist(text) is
  'Changes unified GPT context only after current membership and artist-policy validation. The requested key is never authority.';

-- ---------------------------------------------------------------------------
-- Owner configuration for the one app and future artist policies
-- ---------------------------------------------------------------------------

create or replace function public.configure_gpt_oauth_application(
  p_application_key text,
  p_oauth_client_id text,
  p_is_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_application crm_private.gpt_oauth_applications%rowtype;
  v_client_id text := nullif(btrim(coalesce(p_oauth_client_id, '')), '');
begin
  if not public.is_owner() then
    raise exception 'only the owner may configure GPT OAuth applications' using errcode = '42501';
  end if;

  select a.* into v_application
  from crm_private.gpt_oauth_applications a
  where a.application_key = btrim(coalesce(p_application_key, ''))
  for update;
  if not found then
    raise exception 'unknown GPT OAuth application' using errcode = '22023';
  end if;
  if coalesce(p_is_active, false) and v_client_id is null then
    raise exception 'an OAuth client id is required before activation' using errcode = '22023';
  end if;

  update crm_private.gpt_oauth_applications a
  set oauth_client_id = v_client_id,
      is_active = coalesce(p_is_active, false)
  where a.id = v_application.id;

  insert into public.activity_log (
    event_type, actor_profile_id, actor_kind, metadata
  ) values (
    'gpt.application_configured', auth.uid(), 'owner',
    jsonb_build_object(
      'application_key', v_application.application_key,
      'active', coalesce(p_is_active, false),
      'has_oauth_client', v_client_id is not null
    )
  );

  return jsonb_build_object(
    'application_key', v_application.application_key,
    'active', coalesce(p_is_active, false),
    'has_oauth_client', v_client_id is not null
  );
end;
$$;

create or replace function public.configure_gpt_artist_policy(
  p_artist_id uuid,
  p_is_active boolean,
  p_can_read_appointments boolean,
  p_can_manage_appointments boolean,
  p_can_read_enquiries boolean,
  p_can_manage_crm boolean,
  p_can_manage_finance boolean,
  p_can_manage_communications boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist public.artists%rowtype;
  v_policy crm_private.gpt_action_clients%rowtype;
  v_integration_key text;
begin
  if not public.is_owner() then
    raise exception 'only the owner may configure GPT artist policies' using errcode = '42501';
  end if;
  select a.* into v_artist from public.artists a where a.id = p_artist_id and a.is_active;
  if not found then
    raise exception 'active artist is required' using errcode = '22023';
  end if;
  perform crm_private.require_artist_access(p_artist_id, 'manage');
  if coalesce(p_can_manage_appointments, false) then
    if not coalesce(p_can_read_appointments, false) then
      raise exception 'appointment management requires appointment read access' using errcode = '22023';
    end if;
    perform crm_private.require_artist_access(p_artist_id, 'manage_sessions');
  end if;
  if coalesce(p_can_manage_finance, false) then
    perform crm_private.require_artist_access(p_artist_id, 'manage_finance');
  end if;

  select c.* into v_policy
  from crm_private.gpt_action_clients c
  where c.artist_id = p_artist_id
  for update;

  v_integration_key := coalesce(
    v_policy.integration_key,
    'gpt-artist-' || replace(p_artist_id::text, '-', '')
  );

  insert into crm_private.gpt_action_clients (
    id, artist_id, integration_key, display_name, oauth_client_id,
    can_read_appointments, can_manage_appointments, can_read_enquiries,
    can_manage_crm, can_manage_finance, can_manage_communications, is_active
  ) values (
    coalesce(v_policy.id, gen_random_uuid()), p_artist_id, v_integration_key,
    v_artist.display_name || ' GPT policy', v_policy.oauth_client_id,
    coalesce(p_can_read_appointments, false), coalesce(p_can_manage_appointments, false),
    coalesce(p_can_read_enquiries, false), coalesce(p_can_manage_crm, false),
    coalesce(p_can_manage_finance, false), coalesce(p_can_manage_communications, false),
    coalesce(p_is_active, false)
  )
  on conflict (artist_id) do update set
    display_name = excluded.display_name,
    can_read_appointments = excluded.can_read_appointments,
    can_manage_appointments = excluded.can_manage_appointments,
    can_read_enquiries = excluded.can_read_enquiries,
    can_manage_crm = excluded.can_manage_crm,
    can_manage_finance = excluded.can_manage_finance,
    can_manage_communications = excluded.can_manage_communications,
    is_active = excluded.is_active;

  insert into public.artist_integrations (
    artist_id, integration_type, provider, integration_key,
    external_account_label, configuration, is_enabled
  ) values (
    p_artist_id, 'gpt', 'openai_gpt_actions', v_integration_key,
    v_artist.display_name || ' in Vishar CRM GPT',
    '{"authentication":"supabase_oauth_2_1","identity":"user_membership_context"}'::jsonb,
    coalesce(p_is_active, false)
  )
  on conflict (artist_id, integration_type, integration_key) do update set
    external_account_label = excluded.external_account_label,
    configuration = excluded.configuration,
    is_enabled = excluded.is_enabled,
    updated_at = now();

  insert into public.activity_log (
    event_type, actor_profile_id, actor_kind, artist_id, metadata
  ) values (
    'gpt.artist_policy_configured', auth.uid(), 'owner', p_artist_id,
    jsonb_build_object(
      'integration', v_integration_key,
      'active', coalesce(p_is_active, false),
      'read_appointments', coalesce(p_can_read_appointments, false),
      'manage_appointments', coalesce(p_can_manage_appointments, false),
      'read_enquiries', coalesce(p_can_read_enquiries, false),
      'manage_crm', coalesce(p_can_manage_crm, false),
      'manage_finance', coalesce(p_can_manage_finance, false),
      'manage_communications', coalesce(p_can_manage_communications, false)
    )
  );

  return jsonb_build_object(
    'integration_key', v_integration_key,
    'active', coalesce(p_is_active, false)
  );
end;
$$;

revoke all on function public.configure_gpt_oauth_application(text,text,boolean),
  public.configure_gpt_artist_policy(uuid,boolean,boolean,boolean,boolean,boolean,boolean,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.configure_gpt_oauth_application(text,text,boolean),
  public.configure_gpt_artist_policy(uuid,boolean,boolean,boolean,boolean,boolean,boolean,boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Consent supports both legacy fixed-artist and unified user-centric clients.
-- ---------------------------------------------------------------------------

drop function public.get_gpt_action_consent_summary(text);

create function public.get_gpt_action_consent_summary(p_oauth_client_id text)
returns table (
  integration_key text,
  client_display_name text,
  artist_id uuid,
  artist_display_name text,
  can_read_appointments boolean,
  can_manage_appointments boolean,
  identity_mode text,
  accessible_artists jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_identity record;
  v_legacy crm_private.gpt_action_clients%rowtype;
  v_application crm_private.gpt_oauth_applications%rowtype;
  v_count integer;
begin
  select * into v_identity
  from crm_private.resolve_gpt_oauth_identity(p_oauth_client_id);

  if v_identity.identity_mode = 'legacy_fixed' then
    select c.* into v_legacy
    from crm_private.gpt_accessible_artist_policies(p_oauth_client_id) p
    join crm_private.gpt_action_clients c on c.id = p.gpt_client_id;
    if v_legacy.id is null then
      raise exception 'this user cannot access the GPT artist scope' using errcode = '42501';
    end if;

    return query
    select v_legacy.integration_key, v_legacy.display_name, a.id, a.display_name,
           v_legacy.can_read_appointments, v_legacy.can_manage_appointments,
           'legacy_fixed'::text,
           jsonb_build_array(jsonb_build_object('key', a.slug, 'display_name', a.display_name))
    from public.artists a where a.id = v_legacy.artist_id;
  else
    select a.* into v_application
    from crm_private.gpt_oauth_applications a
    where a.id = v_identity.oauth_application_id;

    select count(*)::integer into v_count
    from crm_private.gpt_accessible_artist_policies(p_oauth_client_id);
    if v_count = 0 then
      raise exception 'this user has no artist access for the unified GPT' using errcode = '42501';
    end if;

    return query
    select v_application.application_key, v_application.display_name,
           null::uuid,
           case when v_count = 1 then min(p.artist_display_name) else 'Multiple artists' end,
           bool_or(c.can_read_appointments), bool_or(c.can_manage_appointments),
           'unified_user'::text,
           jsonb_agg(
             jsonb_build_object('key', p.artist_key, 'display_name', p.artist_display_name)
             order by p.artist_display_name, p.artist_key
           )
    from crm_private.gpt_accessible_artist_policies(p_oauth_client_id) p
    join crm_private.gpt_action_clients c on c.id = p.gpt_client_id;
  end if;
end;
$$;

revoke all on function public.get_gpt_action_consent_summary(text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_gpt_action_consent_summary(text)
  to authenticated;

comment on function public.get_gpt_action_consent_summary(text) is
  'Consent guard for legacy fixed-artist and unified membership-scoped GPT OAuth applications. Returns no OAuth secret, provider id or credential.';
