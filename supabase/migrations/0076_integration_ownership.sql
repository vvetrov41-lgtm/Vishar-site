-- 0076_integration_ownership.sql
--
-- Workspace-owned integrations, explicit per-artist assignment, and an
-- explicit personal-vs-studio route selection.
--
-- Why a new table instead of widening artist_integrations
-- -------------------------------------------------------
-- `public.artist_integrations` is reached by deployed code: the Telegram,
-- Calendar, Gmail, WhatsApp and Instagram Workers all resolve through
-- `public.resolve_outbox_route`, which joins it on `artist_id`. Adding an
-- `owner_type` column would have made `artist_id` nullable and forced every one
-- of those joins to be rewritten in the same release. So artist-owned
-- integrations keep exactly the table, columns, constraints, guard trigger,
-- RLS and RPCs they have today, and workspace ownership arrives beside them.
--
-- The three concepts, kept apart on purpose
-- -----------------------------------------
--   workspace_integrations   a provider connection the organization owns
--   integration_assignments  which artists may use it, and for what
--   artist_integration_routes which connection an artist actually uses for a
--                             channel: their own, or an assigned studio one
--
-- There is no implicit precedence between a personal and a studio connection.
-- A route is a row somebody wrote, or there is no route. "Personal first" and
-- "studio first" are both wrong for somebody, and a rule nobody chose is the
-- kind that silently sends one artist's reply from another artist's account.
--
-- A cross-workspace assignment is impossible by construction: a trigger
-- requires the artist and the integration to sit in the same workspace, so a
-- Workspace A account can never be attached to a Workspace B artist even if a
-- caller passes both ids deliberately.
--
-- No credential is stored here, exactly as in artist_integrations: the same
-- forbidden-key and credential-shape guard runs on workspace configuration.
--
-- Forward-only. No provider call, no deployment, no enqueued work, and no
-- change to how any currently deployed Worker resolves a route.

-- ---------------------------------------------------------------------------
-- 1. Status vocabulary
--
-- What an integrations dashboard needs to render "Needs attention" without
-- ever seeing a provider message. The category is a closed set, not free text,
-- so a provider error string cannot reach a browser through this column.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'integration_error_category') then
    create type public.integration_error_category as enum (
      'none',
      'not_connected',
      'credential_expired',
      'credential_rejected',
      'permission_revoked',
      'destination_unavailable',
      'rate_limited',
      'provider_unavailable',
      'configuration_invalid',
      'unknown'
    );
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'integration_route_kind') then
    create type public.integration_route_kind as enum ('artist', 'workspace');
  end if;
end;
$$;

-- Safe status columns on the existing artist-owned table. Additive; every
-- existing row keeps working and every existing caller ignores them.
alter table public.artist_integrations
  add column if not exists connected_at timestamptz,
  add column if not exists last_success_at timestamptz,
  add column if not exists last_error_at timestamptz,
  add column if not exists last_error_category public.integration_error_category
    not null default 'none';

comment on column public.artist_integrations.last_error_category is
  'A closed vocabulary, never a provider message. The dashboard renders this; the provider''s own error text stays in Worker logs.';

-- ---------------------------------------------------------------------------
-- 2. Workspace-owned integrations
-- ---------------------------------------------------------------------------

create table if not exists public.workspace_integrations (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references public.workspaces (id) on delete cascade,
  integration_type       public.artist_integration_type not null,
  provider               text not null,
  integration_key        text not null,
  external_account_label text,
  configuration          jsonb not null default '{}'::jsonb,
  is_enabled             boolean not null default false,
  connected_at           timestamptz,
  last_success_at        timestamptz,
  last_error_at          timestamptz,
  last_error_category    public.integration_error_category not null default 'none',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (workspace_id, integration_type, integration_key),
  constraint workspace_integrations_provider_shape
    check (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  constraint workspace_integrations_key_shape
    check (integration_key ~ '^[a-z][a-z0-9_-]{2,79}$'),
  constraint workspace_integrations_configuration_is_object
    check (jsonb_typeof(configuration) = 'object')
);

comment on table public.workspace_integrations is
  'Provider metadata for a connection the organization owns. Same rule as artist_integrations: tokens, chat ids, OAuth credentials, payment secrets and private keys are prohibited here and live only in encrypted server-side configuration.';

-- The integration key becomes a Worker binding name deterministically (see
-- workers/lib/provider-routing.js), so it has to stay inside the owning
-- workspace's namespace for the same reason an artist key does.
create or replace function crm_private.protect_workspace_integration_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_slug text;
begin
  select w.slug into v_slug from public.workspaces w where w.id = new.workspace_id;
  if v_slug is null then
    raise exception 'the workspace is unavailable' using errcode = '22023';
  end if;

  if new.integration_key not like v_slug || '-%' then
    raise exception 'a workspace integration key must start with the workspace slug'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
     and (new.workspace_id is distinct from old.workspace_id
          or new.integration_type is distinct from old.integration_type
          or new.integration_key is distinct from old.integration_key) then
    raise exception 'workspace integration identity is immutable; disable it and create a new one'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

-- Reuses the existing credential detector from the artist-owned table rather
-- than declaring a second, drifting copy of what counts as a secret.
create or replace function crm_private.guard_workspace_integration_configuration()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_key text;
begin
  v_key := crm_private.find_forbidden_integration_key(new.configuration);
  if v_key is not null then
    raise exception 'workspace integration configuration may not contain credential key %', v_key
      using errcode = '23514',
            detail = 'Store credentials only in encrypted server-side Cloudflare configuration.';
  end if;

  if crm_private.find_suspicious_integration_value(new.configuration) is not null then
    raise exception 'workspace integration configuration contains a credential-shaped value'
      using errcode = '23514',
            detail = 'Store credentials only in encrypted server-side Cloudflare configuration.';
  end if;

  return new;
end;
$$;

drop trigger if exists workspace_integrations_protect_identity on public.workspace_integrations;
create trigger workspace_integrations_protect_identity
  before insert or update on public.workspace_integrations
  for each row execute function crm_private.protect_workspace_integration_identity();

drop trigger if exists workspace_integrations_guard_configuration on public.workspace_integrations;
create trigger workspace_integrations_guard_configuration
  before insert or update on public.workspace_integrations
  for each row execute function crm_private.guard_workspace_integration_configuration();

drop trigger if exists workspace_integrations_set_updated_at on public.workspace_integrations;
create trigger workspace_integrations_set_updated_at
  before update on public.workspace_integrations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Assignments
--
-- "Every artist in the workspace uses every studio integration" is exactly the
-- rule this table exists to avoid. An assignment is a row somebody wrote.
-- ---------------------------------------------------------------------------

create table if not exists public.integration_assignments (
  id                        uuid primary key default gen_random_uuid(),
  workspace_integration_id  uuid not null references public.workspace_integrations (id) on delete cascade,
  artist_id                 uuid not null references public.artists (id) on delete cascade,
  purpose                   text not null default 'default',
  is_active                 boolean not null default true,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (workspace_integration_id, artist_id, purpose),
  constraint integration_assignments_purpose_shape
    check (purpose ~ '^[a-z][a-z0-9_]{2,31}$')
);

comment on table public.integration_assignments is
  'Which artists may use a workspace-owned integration, and for what. Absence of a row is absence of permission; there is no implicit studio-wide grant.';

create or replace function crm_private.guard_integration_assignment_workspace()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_integration_workspace uuid;
  v_artist_workspace uuid;
begin
  select wi.workspace_id into v_integration_workspace
  from public.workspace_integrations wi
  where wi.id = new.workspace_integration_id;

  select a.workspace_id into v_artist_workspace
  from public.artists a
  where a.id = new.artist_id;

  if v_integration_workspace is null or v_artist_workspace is null then
    raise exception 'the integration or the artist is unavailable' using errcode = '22023';
  end if;

  -- The boundary. A caller that names both ids deliberately still cannot
  -- attach one organization's provider account to another organization's
  -- artist.
  if v_integration_workspace <> v_artist_workspace then
    raise exception 'an integration can only be assigned to an artist in its own workspace'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists integration_assignments_guard_workspace on public.integration_assignments;
create trigger integration_assignments_guard_workspace
  before insert or update on public.integration_assignments
  for each row execute function crm_private.guard_integration_assignment_workspace();

drop trigger if exists integration_assignments_set_updated_at on public.integration_assignments;
create trigger integration_assignments_set_updated_at
  before update on public.integration_assignments
  for each row execute function public.set_updated_at();

create index if not exists integration_assignments_artist_idx
  on public.integration_assignments (artist_id, is_active);

-- ---------------------------------------------------------------------------
-- 4. Routes
--
-- Exactly one active route per (artist, integration type). This is the row the
-- delivery path will consult in a later phase; nothing reads it yet, so adding
-- it changes no behaviour.
-- ---------------------------------------------------------------------------

create table if not exists public.artist_integration_routes (
  id                       uuid primary key default gen_random_uuid(),
  artist_id                uuid not null references public.artists (id) on delete cascade,
  integration_type         public.artist_integration_type not null,
  route_kind               public.integration_route_kind not null,
  artist_integration_id    uuid references public.artist_integrations (id) on delete cascade,
  workspace_integration_id uuid references public.workspace_integrations (id) on delete cascade,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (artist_id, integration_type),
  -- A route names exactly one connection, and the kind and the reference must
  -- agree. A row that says "workspace" while pointing at a personal account is
  -- not a misconfiguration to be interpreted at delivery time.
  constraint artist_integration_routes_exactly_one_target check (
    (route_kind = 'artist'
       and artist_integration_id is not null
       and workspace_integration_id is null)
    or
    (route_kind = 'workspace'
       and workspace_integration_id is not null
       and artist_integration_id is null)
  )
);

comment on table public.artist_integration_routes is
  'Which connection an artist uses for one channel: their own, or an assigned workspace one. There is no default and no precedence rule - an absent row means no route has been chosen.';

create or replace function crm_private.guard_artist_integration_route()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_type public.artist_integration_type;
  v_owner uuid;
begin
  if new.route_kind = 'artist' then
    select i.artist_id, i.integration_type into v_owner, v_type
    from public.artist_integrations i
    where i.id = new.artist_integration_id;

    if v_owner is null then
      raise exception 'the integration is unavailable' using errcode = '22023';
    end if;
    if v_owner <> new.artist_id then
      raise exception 'an artist route must point at that artist''s own integration'
        using errcode = '23514';
    end if;
  else
    select wi.integration_type into v_type
    from public.workspace_integrations wi
    where wi.id = new.workspace_integration_id;

    if v_type is null then
      raise exception 'the integration is unavailable' using errcode = '22023';
    end if;

    -- Owning the workspace is not enough. The artist has to have been given
    -- this specific account, which is the whole point of the assignment table.
    if not exists (
      select 1
      from public.integration_assignments ia
      where ia.workspace_integration_id = new.workspace_integration_id
        and ia.artist_id = new.artist_id
        and ia.is_active
    ) then
      raise exception 'the workspace integration is not assigned to this artist'
        using errcode = '23514';
    end if;
  end if;

  if v_type <> new.integration_type then
    raise exception 'the route channel does not match the integration channel'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists artist_integration_routes_guard on public.artist_integration_routes;
create trigger artist_integration_routes_guard
  before insert or update on public.artist_integration_routes
  for each row execute function crm_private.guard_artist_integration_route();

drop trigger if exists artist_integration_routes_set_updated_at on public.artist_integration_routes;
create trigger artist_integration_routes_set_updated_at
  before update on public.artist_integration_routes
  for each row execute function public.set_updated_at();

-- Withdrawing an assignment must take the route with it, or an artist would
-- keep sending through an account the studio has taken back.
create or replace function crm_private.revoke_routes_for_assignment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if tg_op = 'DELETE' or not new.is_active then
    delete from public.artist_integration_routes r
    where r.route_kind = 'workspace'
      and r.workspace_integration_id = coalesce(old.workspace_integration_id, new.workspace_integration_id)
      and r.artist_id = coalesce(old.artist_id, new.artist_id);
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists integration_assignments_revoke_routes on public.integration_assignments;
create trigger integration_assignments_revoke_routes
  after update or delete on public.integration_assignments
  for each row execute function crm_private.revoke_routes_for_assignment();

-- ---------------------------------------------------------------------------
-- 5. Write surfaces
-- ---------------------------------------------------------------------------

create or replace function public.configure_workspace_integration(
  p_workspace_id uuid,
  p_integration_type public.artist_integration_type,
  p_provider text,
  p_integration_key text,
  p_external_account_label text default null,
  p_configuration jsonb default '{}'::jsonb,
  p_is_enabled boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid;
begin
  perform crm_private.require_workspace_access(p_workspace_id, 'manage_integrations');

  insert into public.workspace_integrations (
    workspace_id, integration_type, provider, integration_key,
    external_account_label, configuration, is_enabled
  ) values (
    p_workspace_id, p_integration_type, lower(p_provider), p_integration_key,
    p_external_account_label, coalesce(p_configuration, '{}'::jsonb),
    coalesce(p_is_enabled, false)
  )
  on conflict (workspace_id, integration_type, integration_key) do update
    set provider = excluded.provider,
        external_account_label = excluded.external_account_label,
        configuration = excluded.configuration,
        is_enabled = excluded.is_enabled
  returning id into v_id;

  return jsonb_build_object(
    'workspace_integration_id', v_id,
    'workspace_id', p_workspace_id,
    'integration_type', p_integration_type,
    'provider', lower(p_provider),
    'integration_key', p_integration_key,
    'is_enabled', coalesce(p_is_enabled, false)
  );
end;
$$;

create or replace function public.assign_workspace_integration(
  p_workspace_integration_id uuid,
  p_artist_id uuid,
  p_purpose text default 'default',
  p_is_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_workspace_id uuid;
  v_id uuid;
begin
  select wi.workspace_id into v_workspace_id
  from public.workspace_integrations wi
  where wi.id = p_workspace_integration_id;
  if v_workspace_id is null then
    raise exception 'the integration is unavailable' using errcode = '22023';
  end if;

  -- Two separate rights, and both are required. Owning the account is not
  -- permission to point somebody else's work at it, and being able to manage
  -- an artist's integrations is not permission to spend the studio's account.
  perform crm_private.require_workspace_access(v_workspace_id, 'manage_integrations');
  perform crm_private.require_artist_access(p_artist_id, 'manage_integrations');

  insert into public.integration_assignments (
    workspace_integration_id, artist_id, purpose, is_active
  ) values (
    p_workspace_integration_id, p_artist_id,
    coalesce(p_purpose, 'default'), coalesce(p_is_active, true)
  )
  on conflict (workspace_integration_id, artist_id, purpose) do update
    set is_active = excluded.is_active
  returning id into v_id;

  perform crm_private.log_artist_activity(
    p_artist_id, 'integration.configured', 'staff', auth.uid(),
    null, null, null, null, null,
    jsonb_build_object('assignment', coalesce(p_purpose, 'default'),
                       'is_active', coalesce(p_is_active, true))
  );

  return v_id;
end;
$$;

create or replace function public.select_artist_integration_route(
  p_artist_id uuid,
  p_integration_type public.artist_integration_type,
  p_route_kind public.integration_route_kind,
  p_artist_integration_id uuid default null,
  p_workspace_integration_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_integrations');
  perform crm_private.require_active_artist(p_artist_id);

  insert into public.artist_integration_routes (
    artist_id, integration_type, route_kind,
    artist_integration_id, workspace_integration_id
  ) values (
    p_artist_id, p_integration_type, p_route_kind,
    p_artist_integration_id, p_workspace_integration_id
  )
  on conflict (artist_id, integration_type) do update
    set route_kind = excluded.route_kind,
        artist_integration_id = excluded.artist_integration_id,
        workspace_integration_id = excluded.workspace_integration_id
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The dashboard read contract
--
-- One provider-neutral shape for every integration the caller may see, whether
-- the artist owns it or the workspace does. It returns no configuration blob
-- at all: even though the guard trigger keeps credentials out of that column,
-- the safest column to publish is the one that is not published.
-- ---------------------------------------------------------------------------

create or replace function public.list_integration_status()
returns table (
  integration_id       uuid,
  owner_kind           public.integration_route_kind,
  owner_id             uuid,
  owner_label          text,
  integration_type     public.artist_integration_type,
  provider             text,
  display_label        text,
  is_enabled           boolean,
  connected_at         timestamptz,
  last_success_at      timestamptz,
  last_error_at        timestamptz,
  last_error_category  public.integration_error_category,
  assigned_artist_ids  uuid[],
  is_selected_route    boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select i.id,
         'artist'::public.integration_route_kind,
         a.artist_id,
         ar.display_name,
         i.integration_type,
         i.provider,
         i.external_account_label,
         i.is_enabled,
         i.connected_at,
         i.last_success_at,
         i.last_error_at,
         i.last_error_category,
         array[]::uuid[],
         exists (
           select 1 from public.artist_integration_routes r
           where r.artist_integration_id = i.id
         )
  from crm_private.artist_access a
  join public.artist_integrations i on i.artist_id = a.artist_id
  join public.artists ar on ar.id = a.artist_id
  where a.profile_id = auth.uid()
    and a.is_active
    and crm_private.has_artist_capability(a.artist_id, 'view_integrations')

  union all

  select wi.id,
         'workspace'::public.integration_route_kind,
         wi.workspace_id,
         w.display_name,
         wi.integration_type,
         wi.provider,
         wi.external_account_label,
         wi.is_enabled,
         wi.connected_at,
         wi.last_success_at,
         wi.last_error_at,
         wi.last_error_category,
         coalesce((
           select array_agg(ia.artist_id order by ia.artist_id)
           from public.integration_assignments ia
           where ia.workspace_integration_id = wi.id and ia.is_active
         ), array[]::uuid[]),
         exists (
           select 1 from public.artist_integration_routes r
           where r.workspace_integration_id = wi.id
         )
  from crm_private.workspace_access wa
  join public.workspace_integrations wi on wi.workspace_id = wa.workspace_id
  join public.workspaces w on w.id = wa.workspace_id
  where wa.profile_id = auth.uid()
    and wa.is_active;
$$;

comment on function public.list_integration_status() is
  'Provider-neutral integration status for the signed-in profile. Returns no token, chat id, provider account identifier or configuration blob - only what a dashboard needs to render a state and offer an action.';

-- ---------------------------------------------------------------------------
-- 7. Privileges and RLS
-- ---------------------------------------------------------------------------

alter table public.workspace_integrations enable row level security;
alter table public.workspace_integrations force row level security;
alter table public.integration_assignments enable row level security;
alter table public.integration_assignments force row level security;
alter table public.artist_integration_routes enable row level security;
alter table public.artist_integration_routes force row level security;

revoke all on public.workspace_integrations from public, anon, authenticated, service_role;
revoke all on public.integration_assignments from public, anon, authenticated, service_role;
revoke all on public.artist_integration_routes from public, anon, authenticated, service_role;

-- Browser sessions read through list_integration_status. The tables themselves
-- are granted to the backend only, so a future Worker can resolve a route
-- without a second copy of the schema.
grant select on public.workspace_integrations to service_role;
grant select on public.integration_assignments to service_role;
grant select on public.artist_integration_routes to service_role;

drop policy if exists workspace_integrations_service_select on public.workspace_integrations;
create policy workspace_integrations_service_select on public.workspace_integrations
  for select using (crm_private.is_service_backend());

drop policy if exists integration_assignments_service_select on public.integration_assignments;
create policy integration_assignments_service_select on public.integration_assignments
  for select using (crm_private.is_service_backend());

drop policy if exists artist_integration_routes_service_select on public.artist_integration_routes;
create policy artist_integration_routes_service_select on public.artist_integration_routes
  for select using (crm_private.is_service_backend());

revoke all on function public.configure_workspace_integration(uuid, public.artist_integration_type, text, text, text, jsonb, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.configure_workspace_integration(uuid, public.artist_integration_type, text, text, text, jsonb, boolean)
  to authenticated;

revoke all on function public.assign_workspace_integration(uuid, uuid, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.assign_workspace_integration(uuid, uuid, text, boolean)
  to authenticated;

revoke all on function public.select_artist_integration_route(uuid, public.artist_integration_type, public.integration_route_kind, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.select_artist_integration_route(uuid, public.artist_integration_type, public.integration_route_kind, uuid, uuid)
  to authenticated;

revoke all on function public.list_integration_status()
  from public, anon, authenticated, service_role;
grant execute on function public.list_integration_status() to authenticated;
