-- 0075_workspaces.sql
--
-- The organization layer: workspaces, workspace memberships, and the link from
-- an artist to the organization they work in.
--
-- The single rule this migration exists to enforce
-- ------------------------------------------------
--   A workspace membership never, on its own, produces an artist capability.
--
-- A studio admin who can administer the organization does not thereby gain
-- read access to an artist's clients, enquiries, finance or provider tokens.
-- To work on an artist, somebody has to hold an `artist_memberships` row for
-- that artist — an explicit, auditable, revocable grant. `grant_source` from
-- migration 0074 records that a workspace role produced it.
--
-- The "assign this manager to all our artists" affordance from the product
-- brief is therefore a *write-time expansion*: it creates one artist
-- membership row per selected artist. It is never an inheritance rule
-- evaluated at read time, because an inheritance rule is exactly the thing
-- that quietly widens when a workspace gains an artist.
--
-- Backfill
-- --------
-- Every existing artist gets its own `solo` workspace, so nobody's access
-- changes: a solo workspace has exactly one artist, and the people who already
-- held an owner/artist membership on that artist become its workspace owners.
-- No profile gains access to an artist it could not already reach.
--
-- Forward-only. No provider call, no deployment, no enqueued work.

-- ---------------------------------------------------------------------------
-- 1. Types
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'workspace_type') then
    create type public.workspace_type as enum ('solo', 'studio');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'workspace_role') then
    create type public.workspace_role as enum ('owner', 'admin', 'booking_manager', 'read_only');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

create table if not exists public.workspaces (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique,
  display_name     text not null,
  workspace_type   public.workspace_type not null,
  timezone         text not null default 'Europe/London',
  default_currency text not null default 'GBP',
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint workspaces_slug_shape check (slug ~ '^[a-z][a-z0-9-]{1,62}$'),
  constraint workspaces_display_name_present check (btrim(display_name) <> ''),
  constraint workspaces_currency_shape check (default_currency ~ '^[A-Z]{3}$')
);

comment on table public.workspaces is
  'An organization that owns one or more artists. type solo is a single artist working alone; type studio is a shared organization. Holds identity only - no operational record and no provider credential.';

create table if not exists public.workspace_memberships (
  id                      uuid primary key default gen_random_uuid(),
  profile_id              uuid not null references public.profiles (id) on delete cascade,
  workspace_id            uuid not null references public.workspaces (id) on delete cascade,
  workspace_role          public.workspace_role not null,
  can_manage_workspace    boolean not null default false,
  can_manage_team         boolean not null default false,
  can_manage_integrations boolean not null default false,
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (profile_id, workspace_id)
);

comment on table public.workspace_memberships is
  'What a profile may do at organization level. Grants no artist-scoped access of any kind; artist work always requires a public.artist_memberships row.';

comment on column public.workspace_memberships.can_manage_team is
  'May invite people into the workspace and expand a workspace grant into explicit artist memberships. Never grants the artist capabilities being handed out - see public.grant_workspace_artist_membership.';

-- ---------------------------------------------------------------------------
-- 3. Private mirrors
--
-- Same reason as crm_private.artist_access in migration 0015: an RLS helper
-- cannot query the table its own policy is being evaluated on.
-- ---------------------------------------------------------------------------

create table if not exists crm_private.workspace_state (
  workspace_id uuid primary key,
  is_active    boolean not null
);

create table if not exists crm_private.workspace_access (
  profile_id              uuid not null,
  workspace_id            uuid not null,
  workspace_role          public.workspace_role not null,
  can_manage_workspace    boolean not null,
  can_manage_team         boolean not null,
  can_manage_integrations boolean not null,
  is_active               boolean not null,
  primary key (profile_id, workspace_id)
);

revoke all on crm_private.workspace_state from public, anon, authenticated, service_role;
revoke all on crm_private.workspace_access from public, anon, authenticated, service_role;

create or replace function crm_private.sync_workspace_state()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if tg_op = 'DELETE' then
    delete from crm_private.workspace_state where workspace_id = old.id;
    return old;
  end if;

  insert into crm_private.workspace_state (workspace_id, is_active)
  values (new.id, new.is_active)
  on conflict (workspace_id) do update set is_active = excluded.is_active;

  return new;
end;
$$;

create or replace function crm_private.sync_workspace_access()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if tg_op = 'DELETE' then
    delete from crm_private.workspace_access
    where profile_id = old.profile_id and workspace_id = old.workspace_id;
    return old;
  end if;

  insert into crm_private.workspace_access (
    profile_id, workspace_id, workspace_role,
    can_manage_workspace, can_manage_team, can_manage_integrations, is_active
  ) values (
    new.profile_id, new.workspace_id, new.workspace_role,
    new.can_manage_workspace, new.can_manage_team, new.can_manage_integrations, new.is_active
  )
  on conflict (profile_id, workspace_id) do update
    set workspace_role = excluded.workspace_role,
        can_manage_workspace = excluded.can_manage_workspace,
        can_manage_team = excluded.can_manage_team,
        can_manage_integrations = excluded.can_manage_integrations,
        is_active = excluded.is_active;

  return new;
end;
$$;

create or replace function crm_private.protect_workspace_membership_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.profile_id is distinct from old.profile_id
     or new.workspace_id is distinct from old.workspace_id then
    raise exception 'workspace membership identity is immutable; deactivate it and create a new membership'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists workspaces_sync_state on public.workspaces;
create trigger workspaces_sync_state
  after insert or update or delete on public.workspaces
  for each row execute function crm_private.sync_workspace_state();

drop trigger if exists workspace_memberships_sync_access on public.workspace_memberships;
create trigger workspace_memberships_sync_access
  after insert or update or delete on public.workspace_memberships
  for each row execute function crm_private.sync_workspace_access();

drop trigger if exists workspace_memberships_protect_identity on public.workspace_memberships;
create trigger workspace_memberships_protect_identity
  before update on public.workspace_memberships
  for each row execute function crm_private.protect_workspace_membership_identity();

-- Existing timestamp helper from migration 0006.
drop trigger if exists workspaces_set_updated_at on public.workspaces;
create trigger workspaces_set_updated_at
  before update on public.workspaces
  for each row execute function public.set_updated_at();

drop trigger if exists workspace_memberships_set_updated_at on public.workspace_memberships;
create trigger workspace_memberships_set_updated_at
  before update on public.workspace_memberships
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Artist -> workspace
--
-- Added nullable and backfilled in the same transaction, then constrained. If
-- the backfill were ever to miss a row the NOT NULL below fails the migration
-- rather than leaving an artist that belongs to no organization.
-- ---------------------------------------------------------------------------

alter table public.artists
  add column if not exists workspace_id uuid references public.workspaces (id);

-- One solo workspace per existing artist. The slug namespace is shared with
-- nothing else, so the artist slug is reused directly.
insert into public.workspaces (slug, display_name, workspace_type, timezone, default_currency, is_active)
select a.slug, a.display_name, 'solo'::public.workspace_type, a.timezone, a.default_currency, a.is_active
from public.artists a
where a.workspace_id is null
  and not exists (select 1 from public.workspaces w where w.slug = a.slug);

update public.artists a
set workspace_id = w.id
from public.workspaces w
where a.workspace_id is null and w.slug = a.slug;

-- Every future artist gets its solo workspace automatically, so that creating
-- an artist stays a single insert for every existing caller (the team-admin
-- Worker, the pgTAP fixtures, and any later onboarding RPC).
--
-- The generated workspace is always internally valid, even when the artist row
-- that triggered it is not. That is deliberate: an artist row with a malformed
-- slug or currency must be rejected by its own constraint with the error code
-- callers already handle, not by a constraint on a table they did not name. The
-- surrounding statement rolls the workspace back with it.
create or replace function crm_private.provision_artist_workspace()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
declare
  v_slug text;
  v_suffix integer := 1;
begin
  if new.workspace_id is not null then
    return new;
  end if;

  v_slug := case
    when new.slug ~ '^[a-z][a-z0-9-]{1,62}$' then new.slug
    else 'workspace-' || replace(gen_random_uuid()::text, '-', '')
  end;

  while exists (select 1 from public.workspaces w where w.slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := left(v_slug, 60) || '-' || v_suffix::text;
  end loop;

  insert into public.workspaces (
    slug, display_name, workspace_type, timezone, default_currency, is_active
  ) values (
    v_slug,
    case when btrim(coalesce(new.display_name, '')) = '' then v_slug else new.display_name end,
    'solo'::public.workspace_type,
    case when new.timezone is null or btrim(new.timezone) = '' then 'Europe/London' else new.timezone end,
    case when new.default_currency ~ '^[A-Z]{3}$' then new.default_currency else 'GBP' end,
    true
  )
  returning id into new.workspace_id;

  return new;
end;
$fn$;

drop trigger if exists artists_provision_workspace on public.artists;
create trigger artists_provision_workspace
  before insert on public.artists
  for each row execute function crm_private.provision_artist_workspace();

alter table public.artists
  alter column workspace_id set not null;

create index if not exists artists_workspace_idx on public.artists (workspace_id);

comment on column public.artists.workspace_id is
  'The organization this artist works in. Membership of that workspace does not by itself grant any access to this artist.';

-- Whoever already ran an artist becomes an owner of its solo workspace. This
-- reflects existing reality; it grants no artist access that did not exist.
--
-- The same rule then keeps applying by trigger. It is safe *only* because a
-- solo workspace contains exactly one artist, so owning it reaches nothing the
-- membership did not already reach. A studio workspace is never populated this
-- way: its owners are named deliberately through
-- public.upsert_workspace_membership.
create or replace function crm_private.sync_solo_workspace_owner()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $fn$
begin
  if not new.is_active or new.access_level not in ('owner', 'artist') then
    return new;
  end if;

  insert into public.workspace_memberships (
    profile_id, workspace_id, workspace_role,
    can_manage_workspace, can_manage_team, can_manage_integrations, is_active
  )
  select new.profile_id, a.workspace_id, 'owner'::public.workspace_role, true, true, true, true
  from public.artists a
  join public.workspaces w on w.id = a.workspace_id
  where a.id = new.artist_id
    and w.workspace_type = 'solo'
  on conflict (profile_id, workspace_id) do nothing;

  return new;
end;
$fn$;

drop trigger if exists artist_memberships_sync_solo_workspace on public.artist_memberships;
create trigger artist_memberships_sync_solo_workspace
  after insert or update on public.artist_memberships
  for each row execute function crm_private.sync_solo_workspace_owner();

insert into public.workspace_memberships (
  profile_id, workspace_id, workspace_role,
  can_manage_workspace, can_manage_team, can_manage_integrations, is_active
)
select distinct m.profile_id, a.workspace_id, 'owner'::public.workspace_role, true, true, true, true
from public.artist_memberships m
join public.artists a on a.id = m.artist_id
join public.workspaces w on w.id = a.workspace_id and w.workspace_type = 'solo'
where m.is_active
  and m.access_level in ('owner', 'artist')
on conflict (profile_id, workspace_id) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Workspace authorization
--
-- Mirrors crm_private.has_artist_capability in shape so that a reader who
-- knows one knows the other. There is no cross-over between the two: neither
-- function consults the other's tables.
-- ---------------------------------------------------------------------------

create or replace function crm_private.has_workspace_capability(
  p_workspace_id uuid,
  p_capability text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1
    from crm_private.profile_access p
    join crm_private.workspace_access w on w.profile_id = p.profile_id
    join crm_private.workspace_state s on s.workspace_id = w.workspace_id
    where p.profile_id = auth.uid()
      and p.is_active
      and w.workspace_id = p_workspace_id
      and w.is_active
      and s.is_active
      and case p_capability
        when 'view' then true
        when 'manage_workspace' then
          w.workspace_role in ('owner', 'admin') and w.can_manage_workspace
        when 'manage_team' then
          w.workspace_role in ('owner', 'admin') and w.can_manage_team
        when 'manage_integrations' then
          w.workspace_role in ('owner', 'admin') and w.can_manage_integrations
        else false
      end
  );
$$;

create or replace function crm_private.require_workspace_access(
  p_workspace_id uuid,
  p_capability text default 'view'
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if p_workspace_id is null then
    raise exception 'a workspace id is required' using errcode = '22023';
  end if;

  if p_capability not in ('view', 'manage_workspace', 'manage_team', 'manage_integrations') then
    raise exception 'unknown workspace capability %', p_capability using errcode = '22023';
  end if;

  if not crm_private.has_workspace_capability(p_workspace_id, p_capability) then
    raise exception 'workspace access is not permitted' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.can_access_workspace(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select crm_private.has_workspace_capability(p_workspace_id, 'view');
$$;

create or replace function public.can_manage_workspace(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select crm_private.has_workspace_capability(p_workspace_id, 'manage_workspace');
$$;

revoke all on function crm_private.has_workspace_capability(uuid, text) from public, anon, authenticated, service_role;
revoke all on function crm_private.require_workspace_access(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.can_access_workspace(uuid) from public, anon, authenticated, service_role;
revoke all on function public.can_manage_workspace(uuid) from public, anon, authenticated, service_role;
grant execute on function public.can_access_workspace(uuid) to authenticated, service_role;
grant execute on function public.can_manage_workspace(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. `manage_workspace` becomes answerable
--
-- Migration 0074 returned false for this capability because there was no
-- workspace authority to consult. There is one now. This is the only branch
-- that changes; every other branch is reproduced unchanged.
-- ---------------------------------------------------------------------------

create or replace function crm_private.has_artist_capability(
  p_artist_id uuid,
  p_capability text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1
    from crm_private.profile_access p
    join crm_private.artist_access a on a.profile_id = p.profile_id
    where p.profile_id = auth.uid()
      and p.is_active
      and a.artist_id = p_artist_id
      and a.is_active
      and case p_capability
        when 'view' then true
        when 'manage' then
          p.role in ('owner', 'booking_manager')
          and a.access_level <> 'read_only'
        when 'view_finance' then
          p.role = 'owner'
          or (p.role = 'booking_manager' and a.can_view_finance)
        when 'manage_finance' then
          p.role = 'owner'
          or (p.role = 'booking_manager' and a.can_manage_finance)
        when 'manage_sessions' then
          p.role = 'owner'
          or (p.role = 'booking_manager' and a.can_manage_sessions)
        when 'manage_integrations' then
          p.role = 'owner'
          or (p.role = 'booking_manager' and a.can_manage_integrations)

        when 'view_clients' then true
        when 'view_enquiries' then true
        when 'view_projects' then true
        when 'view_sessions' then true
        when 'view_communications' then true
        when 'view_integrations' then true
        when 'view_booking_sources' then true
        when 'view_notifications' then true
        when 'view_automations' then true

        when 'manage_clients' then
          p.role in ('owner', 'booking_manager') and a.access_level <> 'read_only'
        when 'manage_enquiries' then
          p.role in ('owner', 'booking_manager') and a.access_level <> 'read_only'
        when 'assign_enquiries' then
          p.role in ('owner', 'booking_manager') and a.access_level <> 'read_only'
        when 'manage_projects' then
          p.role in ('owner', 'booking_manager') and a.access_level <> 'read_only'
        when 'send_communications' then
          p.role in ('owner', 'booking_manager') and a.access_level <> 'read_only'
        when 'manage_communications' then
          p.role in ('owner', 'booking_manager') and a.access_level <> 'read_only'
        when 'manage_notifications' then
          p.role in ('owner', 'booking_manager') and a.access_level <> 'read_only'

        when 'manage_booking_sources' then
          p.role = 'owner'
          or (p.role = 'booking_manager' and a.can_manage_integrations)
        when 'manage_automations' then
          p.role = 'owner'
          or (p.role = 'booking_manager' and a.can_manage_integrations)

        when 'manage_team' then
          p.role = 'owner'
          or a.access_level in ('owner', 'artist')

        -- Administering the organization is a workspace right, evaluated
        -- against the workspace this artist belongs to. Holding it does not
        -- grant any of the artist rights above.
        when 'manage_workspace' then
          crm_private.has_workspace_capability(
            (select ar.workspace_id from public.artists ar where ar.id = p_artist_id),
            'manage_workspace'
          )

        else false
      end
  );
$$;

-- ---------------------------------------------------------------------------
-- 7. Read surfaces
-- ---------------------------------------------------------------------------

create or replace function public.list_workspaces()
returns table (
  id                      uuid,
  slug                    text,
  display_name            text,
  workspace_type          public.workspace_type,
  timezone                text,
  default_currency        text,
  is_active               boolean,
  workspace_role          public.workspace_role,
  can_manage_workspace    boolean,
  can_manage_team         boolean,
  can_manage_integrations boolean,
  artist_count            integer
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select w.id, w.slug, w.display_name, w.workspace_type, w.timezone,
         w.default_currency, w.is_active,
         wa.workspace_role, wa.can_manage_workspace, wa.can_manage_team,
         wa.can_manage_integrations,
         (select count(*)::int from public.artists a where a.workspace_id = w.id)
  from public.workspaces w
  join crm_private.workspace_access wa
    on wa.workspace_id = w.id
   and wa.profile_id = auth.uid()
   and wa.is_active
  where public.is_active_user()
  order by w.display_name;
$$;

comment on function public.list_workspaces() is
  'Workspaces the signed-in profile belongs to, with its own organization-level rights. Says nothing about which artists it may work on.';

revoke all on function public.list_workspaces() from public, anon, authenticated, service_role;
grant execute on function public.list_workspaces() to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Write surfaces
--
-- Two named RPCs. Both refuse to hand out a right the caller does not itself
-- hold, which is what stops a workspace admin from bootstrapping finance
-- access it was never given.
-- ---------------------------------------------------------------------------

create or replace function public.upsert_workspace_membership(
  p_profile_id uuid,
  p_workspace_id uuid,
  p_workspace_role public.workspace_role,
  p_can_manage_workspace boolean default false,
  p_can_manage_team boolean default false,
  p_can_manage_integrations boolean default false,
  p_is_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid;
begin
  if p_profile_id is null or p_workspace_id is null then
    raise exception 'a profile and a workspace are required' using errcode = '22023';
  end if;

  -- A global owner keeps administering the installation. Otherwise the caller
  -- must administer this exact workspace.
  if not public.is_owner() then
    perform crm_private.require_workspace_access(p_workspace_id, 'manage_team');
  end if;

  if not exists (
    select 1 from public.profiles pr where pr.id = p_profile_id and pr.is_active
  ) then
    raise exception 'the target profile is not an active CRM user' using errcode = '22023';
  end if;

  -- No self-elevation: a non-owner cannot mint a right it lacks.
  if not public.is_owner() then
    if p_can_manage_workspace
       and not crm_private.has_workspace_capability(p_workspace_id, 'manage_workspace') then
      raise exception 'cannot grant workspace administration you do not hold'
        using errcode = '42501';
    end if;
    if p_can_manage_integrations
       and not crm_private.has_workspace_capability(p_workspace_id, 'manage_integrations') then
      raise exception 'cannot grant workspace integration management you do not hold'
        using errcode = '42501';
    end if;
    if p_workspace_role = 'owner' then
      raise exception 'only a workspace owner is transferred deliberately, not granted here'
        using errcode = '42501';
    end if;
  end if;

  insert into public.workspace_memberships (
    profile_id, workspace_id, workspace_role,
    can_manage_workspace, can_manage_team, can_manage_integrations, is_active
  ) values (
    p_profile_id, p_workspace_id, p_workspace_role,
    coalesce(p_can_manage_workspace, false),
    coalesce(p_can_manage_team, false),
    coalesce(p_can_manage_integrations, false),
    coalesce(p_is_active, true)
  )
  on conflict (profile_id, workspace_id) do update
    set workspace_role = excluded.workspace_role,
        can_manage_workspace = excluded.can_manage_workspace,
        can_manage_team = excluded.can_manage_team,
        can_manage_integrations = excluded.can_manage_integrations,
        is_active = excluded.is_active
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.grant_workspace_artist_membership(
  p_profile_id uuid,
  p_artist_id uuid,
  p_access_level public.artist_access_level default 'manager',
  p_can_view_finance boolean default false,
  p_can_manage_finance boolean default false,
  p_can_manage_sessions boolean default false,
  p_can_manage_integrations boolean default false,
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
  if p_profile_id is null or p_artist_id is null then
    raise exception 'a profile and an artist are required' using errcode = '22023';
  end if;

  select a.workspace_id into v_workspace_id
  from public.artists a
  where a.id = p_artist_id and a.is_active;
  if v_workspace_id is null then
    raise exception 'the artist is unavailable' using errcode = '22023';
  end if;

  -- Two ways to be allowed here, and they are different rights:
  --   * the artist's own team management (an artist inviting their manager);
  --   * workspace team management (a studio admin staffing its artists).
  if not (
    public.is_owner()
    or crm_private.has_artist_capability(p_artist_id, 'manage_team')
    or crm_private.has_workspace_capability(v_workspace_id, 'manage_team')
  ) then
    raise exception 'artist access is not permitted' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.profiles pr where pr.id = p_profile_id and pr.is_active
  ) then
    raise exception 'the target profile is not an active CRM user' using errcode = '22023';
  end if;

  if p_access_level = 'owner' and not public.is_owner() then
    raise exception 'an owner-level artist membership is granted only by an installation owner'
      using errcode = '42501';
  end if;

  -- Finance and integrations are never carried along by a workspace role. The
  -- caller must hold each right on this exact artist to hand it out.
  if not public.is_owner() then
    if (p_can_view_finance or p_can_manage_finance)
       and not crm_private.has_artist_capability(p_artist_id, 'manage_finance') then
      raise exception 'cannot grant finance access you do not hold' using errcode = '42501';
    end if;
    if p_can_manage_integrations
       and not crm_private.has_artist_capability(p_artist_id, 'manage_integrations') then
      raise exception 'cannot grant integration management you do not hold' using errcode = '42501';
    end if;
  end if;

  insert into public.artist_memberships (
    profile_id, artist_id, access_level,
    can_view_finance, can_manage_finance,
    can_manage_sessions, can_manage_integrations, is_active, grant_source
  ) values (
    p_profile_id, p_artist_id, p_access_level,
    coalesce(p_can_view_finance, false),
    coalesce(p_can_manage_finance, false),
    coalesce(p_can_manage_sessions, false),
    coalesce(p_can_manage_integrations, false),
    coalesce(p_is_active, true),
    'workspace_grant'
  )
  on conflict (profile_id, artist_id) do update
    set access_level = excluded.access_level,
        can_view_finance = excluded.can_view_finance,
        can_manage_finance = excluded.can_manage_finance,
        can_manage_sessions = excluded.can_manage_sessions,
        can_manage_integrations = excluded.can_manage_integrations,
        is_active = excluded.is_active
  returning id into v_id;

  perform crm_private.log_artist_activity(
    p_artist_id, 'membership.updated', 'staff', auth.uid(),
    null, null, null, null, p_profile_id,
    jsonb_build_object('access_level', p_access_level, 'grant_source', 'workspace_grant')
  );

  return v_id;
end;
$$;

revoke all on function public.upsert_workspace_membership(uuid, uuid, public.workspace_role, boolean, boolean, boolean, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.upsert_workspace_membership(uuid, uuid, public.workspace_role, boolean, boolean, boolean, boolean)
  to authenticated;

revoke all on function public.grant_workspace_artist_membership(uuid, uuid, public.artist_access_level, boolean, boolean, boolean, boolean, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.grant_workspace_artist_membership(uuid, uuid, public.artist_access_level, boolean, boolean, boolean, boolean, boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Table privileges and RLS
--
-- Browser roles get SELECT only, exactly as public.artists does. Every write
-- goes through the named RPCs above.
-- ---------------------------------------------------------------------------

alter table public.workspaces enable row level security;
alter table public.workspaces force row level security;
alter table public.workspace_memberships enable row level security;
alter table public.workspace_memberships force row level security;

revoke all on public.workspaces from public, anon, authenticated, service_role;
revoke all on public.workspace_memberships from public, anon, authenticated, service_role;
grant select on public.workspaces to authenticated;
grant select on public.workspace_memberships to authenticated;

drop policy if exists workspaces_select on public.workspaces;
create policy workspaces_select on public.workspaces
  for select
  using (public.can_access_workspace(id) or crm_private.is_service_backend());

drop policy if exists workspace_memberships_select on public.workspace_memberships;
create policy workspace_memberships_select on public.workspace_memberships
  for select
  using (
    (profile_id = auth.uid() and public.is_active_user())
    or public.can_manage_workspace(workspace_id)
    or crm_private.is_service_backend()
  );
