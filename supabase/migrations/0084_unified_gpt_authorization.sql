-- 0084_unified_gpt_authorization.sql
--
-- Phases S-T: one Vishar GPT can serve any authenticated CRM profile and may
-- operate only inside that profile's current Artist memberships. The existing
-- per-Artist GPT clients remain valid and keep their fixed Artist semantics.
--
-- The critical rule is deliberately centralized: OAuth client_id identifies a
-- GPT application, auth.uid() identifies the human CRM profile, and Artist
-- membership authorizes the operational scope. A model-provided Artist id is a
-- selector only. It never grants access.
--
-- Nothing here creates an OAuth client, enables the new GPT, changes a Worker
-- route, contacts a provider, or touches production configuration.

-- ---------------------------------------------------------------------------
-- 1. Generalize GPT client binding without changing existing rows.
-- ---------------------------------------------------------------------------

alter table crm_private.gpt_action_clients
  add column if not exists binding_mode text not null default 'artist';

alter table crm_private.gpt_action_clients
  alter column artist_id drop not null;

alter table crm_private.gpt_action_clients
  drop constraint if exists gpt_action_clients_binding_mode_known;
alter table crm_private.gpt_action_clients
  add constraint gpt_action_clients_binding_mode_known
  check (binding_mode in ('artist', 'profile'));

alter table crm_private.gpt_action_clients
  drop constraint if exists gpt_action_clients_binding_shape;
alter table crm_private.gpt_action_clients
  add constraint gpt_action_clients_binding_shape
  check (
    (binding_mode = 'artist' and artist_id is not null)
    or (binding_mode = 'profile' and artist_id is null)
  );

comment on column crm_private.gpt_action_clients.binding_mode is
  'artist keeps the legacy OAuth-client-to-one-Artist binding; profile resolves Artist scope from the authenticated CRM profile membership and its selected context.';
comment on table crm_private.gpt_action_clients is
  'Private allow-list for GPT OAuth clients. Legacy clients are Artist-bound; profile-bound clients derive Artist scope from the signed-in CRM profile and current memberships.';

-- A dormant canonical unified client. It has no OAuth client id and is inactive,
-- so this migration cannot make it usable. The permission flags are ceilings:
-- even when enabled later, current Artist membership/capabilities remain the
-- lower and authoritative boundary on every request.
insert into crm_private.gpt_action_clients (
  id, artist_id, binding_mode, integration_key, display_name, oauth_client_id,
  can_read_appointments, can_manage_appointments, can_read_enquiries,
  can_manage_crm, can_manage_finance, can_manage_communications, is_active
) values (
  'c3333333-3333-4333-8333-333333333333',
  null,
  'profile',
  'vishar-unified-gpt',
  'Vishar CRM unified GPT',
  null,
  true, true, true, true, true, true, false
)
on conflict (integration_key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Per-human active Artist context for profile-bound GPT clients.
-- ---------------------------------------------------------------------------

create table if not exists crm_private.gpt_profile_artist_contexts (
  gpt_client_id uuid not null references crm_private.gpt_action_clients(id) on delete cascade,
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  artist_id     uuid not null references public.artists(id) on delete cascade,
  selected_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (gpt_client_id, profile_id)
);

comment on table crm_private.gpt_profile_artist_contexts is
  'The current Artist selector for one human using one profile-bound GPT client. A row grants nothing and is revalidated against Artist membership on every GPT action.';

revoke all on crm_private.gpt_profile_artist_contexts
  from public, anon, authenticated, service_role;

drop trigger if exists gpt_profile_artist_contexts_set_updated_at
  on crm_private.gpt_profile_artist_contexts;
create trigger gpt_profile_artist_contexts_set_updated_at
  before update on crm_private.gpt_profile_artist_contexts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Central OAuth application lookup and context resolver.
-- ---------------------------------------------------------------------------

create or replace function crm_private.require_gpt_registered_client()
returns table (
  gpt_client_id uuid,
  fixed_artist_id uuid,
  integration_key text,
  binding_mode text
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
  if auth.uid() is null or not public.is_active_user() then
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

  return query
  select v_client.id, v_client.artist_id, v_client.integration_key, v_client.binding_mode;
end;
$$;

revoke all on function crm_private.require_gpt_registered_client()
  from public, anon, authenticated, service_role;

create or replace function crm_private.require_gpt_client_context()
returns table (
  gpt_client_id uuid,
  artist_id uuid,
  integration_key text,
  binding_mode text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_registration record;
  v_artist_id uuid;
  v_accessible_count integer;
  v_implicit_artist_id uuid;
  v_has_persisted_context boolean := false;
begin
  select * into v_registration
  from crm_private.require_gpt_registered_client();

  if v_registration.binding_mode = 'artist' then
    v_artist_id := v_registration.fixed_artist_id;
    perform crm_private.require_active_artist(v_artist_id);
    perform crm_private.require_artist_access(v_artist_id, 'view');
  else
    select c.artist_id, true
      into v_artist_id, v_has_persisted_context
    from crm_private.gpt_profile_artist_contexts c
    where c.gpt_client_id = v_registration.gpt_client_id
      and c.profile_id = auth.uid();

    if v_has_persisted_context then
      -- A revoked/deactivated membership invalidates the persisted selector.
      -- Fail closed instead of silently switching to another Artist.
      if not exists (
        select 1
        from public.list_accessible_artists() a
        where a.id = v_artist_id and a.is_active
      ) then
        raise exception 'the selected GPT Artist context is no longer available; select an Artist again'
          using errcode = '42501';
      end if;
    else
      select count(*)::int, min(a.id)
        into v_accessible_count, v_implicit_artist_id
      from public.list_accessible_artists() a
      where a.is_active;

      if v_accessible_count = 0 then
        raise exception 'this CRM profile has no accessible Artist for the unified GPT'
          using errcode = '42501';
      elsif v_accessible_count > 1 then
        raise exception 'select an Artist context before using the unified GPT'
          using errcode = '22023';
      end if;

      -- A profile with exactly one Artist needs no setup click. This is not a
      -- persisted grant; every request re-derives the same membership.
      v_artist_id := v_implicit_artist_id;
    end if;

    perform crm_private.require_active_artist(v_artist_id);
    perform crm_private.require_artist_access(v_artist_id, 'view');
  end if;

  return query
  select v_registration.gpt_client_id,
         v_artist_id,
         v_registration.integration_key,
         v_registration.binding_mode;
end;
$$;

revoke all on function crm_private.require_gpt_client_context()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. One narrow public context contract.
--
-- NULL reads the current context and available Artists. A non-NULL Artist id
-- selects it. It is callable only with an authenticated OAuth user, and the
-- private registration lookup requires the token's client_id to name an active
-- GPT client. The Artist id is checked against the same CRM membership layer as
-- every other action.
-- ---------------------------------------------------------------------------

create or replace function public.gpt_artist_context(p_artist_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_registration record;
  v_active_artist_id uuid;
  v_selected_artist_id uuid;
  v_accessible_count integer;
  v_artists jsonb := '[]'::jsonb;
begin
  select * into v_registration
  from crm_private.require_gpt_registered_client();

  if p_artist_id is not null then
    if v_registration.binding_mode = 'artist' then
      if p_artist_id is distinct from v_registration.fixed_artist_id then
        raise exception 'this legacy GPT is fixed to another Artist'
          using errcode = '42501';
      end if;
      perform crm_private.require_active_artist(p_artist_id);
      perform crm_private.require_artist_access(p_artist_id, 'view');
    else
      perform crm_private.require_active_artist(p_artist_id);
      perform crm_private.require_artist_access(p_artist_id, 'view');

      insert into crm_private.gpt_profile_artist_contexts (
        gpt_client_id, profile_id, artist_id, selected_at
      ) values (
        v_registration.gpt_client_id, auth.uid(), p_artist_id, now()
      )
      on conflict (gpt_client_id, profile_id) do update
        set artist_id = excluded.artist_id,
            selected_at = now();
    end if;
  end if;

  if v_registration.binding_mode = 'artist' then
    perform crm_private.require_active_artist(v_registration.fixed_artist_id);
    perform crm_private.require_artist_access(v_registration.fixed_artist_id, 'view');
    v_active_artist_id := v_registration.fixed_artist_id;

    select jsonb_build_array(jsonb_build_object(
      'id', a.id,
      'slug', a.slug,
      'display_name', a.display_name,
      'timezone', a.timezone,
      'default_currency', a.default_currency
    )) into v_artists
    from public.artists a
    where a.id = v_registration.fixed_artist_id;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', a.id,
             'slug', a.slug,
             'display_name', a.display_name,
             'timezone', a.timezone,
             'default_currency', a.default_currency
           ) order by a.display_name, a.id), '[]'::jsonb),
           count(*)::int
      into v_artists, v_accessible_count
    from public.list_accessible_artists() a
    where a.is_active;

    select c.artist_id into v_selected_artist_id
    from crm_private.gpt_profile_artist_contexts c
    where c.gpt_client_id = v_registration.gpt_client_id
      and c.profile_id = auth.uid();

    if v_selected_artist_id is not null and exists (
      select 1 from public.list_accessible_artists() a
      where a.id = v_selected_artist_id and a.is_active
    ) then
      v_active_artist_id := v_selected_artist_id;
    elsif v_selected_artist_id is null and v_accessible_count = 1 then
      select (item ->> 'id')::uuid into v_active_artist_id
      from jsonb_array_elements(v_artists) item
      limit 1;
    else
      v_active_artist_id := null;
    end if;
  end if;

  return jsonb_build_object(
    'integration_key', v_registration.integration_key,
    'binding_mode', v_registration.binding_mode,
    'active_artist_id', v_active_artist_id,
    'requires_selection', v_active_artist_id is null,
    'artists', v_artists
  );
end;
$$;

revoke all on function public.gpt_artist_context(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.gpt_artist_context(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Existing GPT operation helpers now resolve through the central context.
--    Their signatures and result columns stay bit-compatible.
-- ---------------------------------------------------------------------------

create or replace function crm_private.require_gpt_action_context(p_write boolean)
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
  v_context record;
  v_client crm_private.gpt_action_clients%rowtype;
begin
  select * into v_context from crm_private.require_gpt_client_context();
  select c.* into v_client from crm_private.gpt_action_clients c
  where c.id = v_context.gpt_client_id;

  if p_write then
    if not v_client.can_manage_appointments then
      raise exception 'this GPT client is read-only' using errcode = '42501';
    end if;
    perform crm_private.require_artist_access(v_context.artist_id, 'manage_sessions');
  else
    if not v_client.can_read_appointments then
      raise exception 'this GPT client cannot read appointments' using errcode = '42501';
    end if;
    perform crm_private.require_artist_access(v_context.artist_id, 'view_sessions');
  end if;

  return query select v_client.id, v_context.artist_id, v_client.integration_key;
end;
$$;

revoke all on function crm_private.require_gpt_action_context(boolean)
  from public, anon, authenticated, service_role;

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
  v_context record;
  v_client crm_private.gpt_action_clients%rowtype;
begin
  select * into v_context from crm_private.require_gpt_client_context();
  select c.* into v_client from crm_private.gpt_action_clients c
  where c.id = v_context.gpt_client_id;

  if not v_client.can_read_enquiries then
    raise exception 'this GPT client cannot read enquiries' using errcode = '42501';
  end if;
  perform crm_private.require_artist_access(v_context.artist_id, 'view_enquiries');

  return query select v_client.id, v_context.artist_id, v_client.integration_key;
end;
$$;

revoke all on function crm_private.require_gpt_enquiry_context()
  from public, anon, authenticated, service_role;

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
  v_capability text := lower(btrim(coalesce(p_capability, '')));
  v_context record;
  v_client crm_private.gpt_action_clients%rowtype;
begin
  select * into v_context from crm_private.require_gpt_client_context();
  select c.* into v_client from crm_private.gpt_action_clients c
  where c.id = v_context.gpt_client_id;

  if v_capability = 'crm' then
    if not v_client.can_manage_crm then
      raise exception 'this GPT client cannot manage CRM records' using errcode = '42501';
    end if;
    perform crm_private.require_artist_access(v_context.artist_id, 'manage');
  elsif v_capability = 'finance' then
    if not v_client.can_manage_finance then
      raise exception 'this GPT client cannot manage finance' using errcode = '42501';
    end if;
    perform crm_private.require_artist_access(v_context.artist_id, 'manage_finance');
  elsif v_capability = 'communications' then
    if not v_client.can_manage_communications then
      raise exception 'this GPT client cannot manage communications' using errcode = '42501';
    end if;
    perform crm_private.require_artist_access(v_context.artist_id, 'manage');
  else
    raise exception 'unknown GPT operational capability' using errcode = '22023';
  end if;

  return query select v_client.id, v_context.artist_id, v_client.integration_key;
end;
$$;

revoke all on function crm_private.require_gpt_operational_context(text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Existing owner configuration RPCs support both modes without changing
--    signatures. Legacy mode preserves its Artist integration row behavior.
-- ---------------------------------------------------------------------------

create or replace function public.configure_gpt_action_client(
  p_integration_key text,
  p_oauth_client_id text,
  p_is_active boolean,
  p_can_manage_appointments boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client crm_private.gpt_action_clients%rowtype;
  v_oauth_client_id text;
begin
  if not public.is_owner() then
    raise exception 'only the owner may configure GPT action clients'
      using errcode = '42501';
  end if;

  v_oauth_client_id := nullif(btrim(p_oauth_client_id), '');
  if p_is_active and v_oauth_client_id is null then
    raise exception 'an OAuth client id is required before activation'
      using errcode = '22023';
  end if;

  select c.* into v_client
  from crm_private.gpt_action_clients c
  where c.integration_key = p_integration_key
  for update;

  if not found then
    raise exception 'unknown GPT action integration %', p_integration_key
      using errcode = '22023';
  end if;

  if p_is_active and v_client.binding_mode = 'artist' then
    perform crm_private.require_active_artist(v_client.artist_id);
  end if;

  update crm_private.gpt_action_clients c
  set oauth_client_id = v_oauth_client_id,
      can_manage_appointments = coalesce(p_can_manage_appointments, false),
      can_read_appointments = true,
      is_active = coalesce(p_is_active, false)
  where c.id = v_client.id;

  if v_client.binding_mode = 'artist' then
    update public.artist_integrations i
    set is_enabled = coalesce(p_is_active, false),
        external_account_label = v_client.display_name
    where i.artist_id = v_client.artist_id
      and i.integration_type = 'gpt'
      and i.integration_key = v_client.integration_key;
  end if;

  insert into public.activity_log (
    event_type, actor_profile_id, actor_kind, artist_id, metadata
  ) values (
    'gpt.client_configured', auth.uid(), 'owner', v_client.artist_id,
    jsonb_build_object(
      'integration', v_client.integration_key,
      'binding_mode', v_client.binding_mode,
      'active', coalesce(p_is_active, false),
      'manage_appointments', coalesce(p_can_manage_appointments, false)
    )
  );

  return jsonb_build_object(
    'integration_key', v_client.integration_key,
    'binding_mode', v_client.binding_mode,
    'artist_id', v_client.artist_id,
    'is_active', coalesce(p_is_active, false),
    'can_read_appointments', true,
    'can_manage_appointments', coalesce(p_can_manage_appointments, false)
  );
end;
$$;

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
    if v_client.binding_mode = 'artist' then
      perform crm_private.require_active_artist(v_client.artist_id);
      perform crm_private.require_artist_access(v_client.artist_id, 'view');
    end if;
  end if;

  update crm_private.gpt_action_clients c
  set can_read_enquiries = coalesce(p_enabled, false)
  where c.id = v_client.id;

  insert into public.activity_log (
    event_type, actor_profile_id, actor_kind, artist_id, metadata
  ) values (
    'gpt.client_configured', auth.uid(), 'owner', v_client.artist_id,
    jsonb_build_object(
      'integration', v_client.integration_key,
      'binding_mode', v_client.binding_mode,
      'enquiry_read_access', coalesce(p_enabled, false)
    )
  );

  return jsonb_build_object(
    'integration_key', v_client.integration_key,
    'binding_mode', v_client.binding_mode,
    'artist_id', v_client.artist_id,
    'can_read_enquiries', coalesce(p_enabled, false)
  );
end;
$$;

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
  v_any_enabled boolean;
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

  v_any_enabled := coalesce(p_manage_crm, false)
                or coalesce(p_manage_finance, false)
                or coalesce(p_manage_communications, false);

  if v_any_enabled then
    if not v_client.is_active or v_client.oauth_client_id is null then
      raise exception 'the GPT OAuth client must be active before full management is enabled'
        using errcode = '22023';
    end if;

    if v_client.binding_mode = 'artist' then
      perform crm_private.require_active_artist(v_client.artist_id);
      perform crm_private.require_artist_access(v_client.artist_id, 'manage');
      if coalesce(p_manage_finance, false) then
        perform crm_private.require_artist_access(v_client.artist_id, 'manage_finance');
      end if;
    end if;
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
      'binding_mode', v_client.binding_mode,
      'manage_crm', coalesce(p_manage_crm, false),
      'manage_finance', coalesce(p_manage_finance, false),
      'manage_communications', coalesce(p_manage_communications, false)
    )
  );

  return jsonb_build_object(
    'integration_key', v_client.integration_key,
    'binding_mode', v_client.binding_mode,
    'artist_id', v_client.artist_id,
    'can_manage_crm', coalesce(p_manage_crm, false),
    'can_manage_finance', coalesce(p_manage_finance, false),
    'can_manage_communications', coalesce(p_manage_communications, false)
  );
end;
$$;

-- Restore the same public grants these three existing functions already had.
revoke all on function public.configure_gpt_action_client(text,text,boolean,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.configure_gpt_action_client(text,text,boolean,boolean)
  to authenticated;
revoke all on function public.configure_gpt_enquiry_read_access(text,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.configure_gpt_enquiry_read_access(text,boolean)
  to authenticated;
revoke all on function public.configure_gpt_full_management(text,boolean,boolean,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.configure_gpt_full_management(text,boolean,boolean,boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 7. OAuth consent summary keeps its existing shape for legacy callers.
--
-- A profile-bound GPT reports the membership boundary rather than pretending it
-- is fixed to the first Artist. artist_id remains populated solely to preserve
-- the long-standing return shape; the unified consent UI ignores that field.
-- ---------------------------------------------------------------------------

create or replace function public.get_gpt_action_consent_summary(p_oauth_client_id text)
returns table (
  integration_key text,
  client_display_name text,
  artist_id uuid,
  artist_display_name text,
  can_read_appointments boolean,
  can_manage_appointments boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client crm_private.gpt_action_clients%rowtype;
  v_artist record;
  v_can_read boolean := false;
  v_can_manage boolean := false;
begin
  if auth.uid() is null or not public.is_active_user() then
    raise exception 'an active CRM session is required to authorize GPT access'
      using errcode = '42501';
  end if;

  select c.* into v_client
  from crm_private.gpt_action_clients c
  where c.oauth_client_id = nullif(btrim(p_oauth_client_id), '')
    and c.is_active;

  if not found then
    raise exception 'this GPT OAuth client is not enabled'
      using errcode = '42501';
  end if;

  if v_client.binding_mode = 'artist' then
    perform crm_private.require_active_artist(v_client.artist_id);
    if v_client.can_manage_appointments then
      perform crm_private.require_artist_access(v_client.artist_id, 'manage_sessions');
    elsif v_client.can_read_appointments then
      perform crm_private.require_artist_access(v_client.artist_id, 'view');
    else
      raise exception 'this GPT client has no appointment access'
        using errcode = '42501';
    end if;

    select a.id, a.display_name into v_artist
    from public.artists a where a.id = v_client.artist_id;

    return query select v_client.integration_key, v_client.display_name,
      v_artist.id, v_artist.display_name,
      v_client.can_read_appointments, v_client.can_manage_appointments;
    return;
  end if;

  select a.id, a.display_name into v_artist
  from public.list_accessible_artists() a
  where a.is_active
  order by a.display_name, a.id
  limit 1;

  if v_artist.id is null then
    raise exception 'this CRM profile has no Artist access for the unified GPT'
      using errcode = '42501';
  end if;

  if v_client.can_read_appointments then
    select exists (
      select 1 from public.list_accessible_artists() a
      where a.is_active and crm_private.has_artist_capability(a.id, 'view_sessions')
    ) into v_can_read;
  end if;
  if v_client.can_manage_appointments then
    select exists (
      select 1 from public.list_accessible_artists() a
      where a.is_active and crm_private.has_artist_capability(a.id, 'manage_sessions')
    ) into v_can_manage;
  end if;

  if not v_can_read and not v_can_manage then
    raise exception 'this CRM profile has no appointment access for the unified GPT'
      using errcode = '42501';
  end if;

  return query select v_client.integration_key, v_client.display_name,
    v_artist.id, 'Artists available to your CRM profile'::text,
    v_can_read, v_can_manage;
end;
$$;

revoke all on function public.get_gpt_action_consent_summary(text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_gpt_action_consent_summary(text)
  to authenticated;
