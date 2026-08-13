-- 0015_artists_memberships.sql
--
-- Establish the artist identity and membership layer without changing the
-- existing business-row policies yet. Migration 0019 will use these helpers to
-- replace the current all-active-staff row visibility with artist scope.
--
-- Existing migrations remain unchanged. This migration is forward-only.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.artist_access_level as enum ('owner', 'artist', 'manager', 'read_only');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Artists
-- ---------------------------------------------------------------------------

create table if not exists public.artists (
  id                       uuid primary key default gen_random_uuid(),
  slug                     text not null,
  display_name             text not null,
  legal_name               text,
  timezone                 text not null default 'Europe/London',
  default_currency         text not null default 'GBP',
  booking_reference_prefix text,
  is_active                boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint artists_slug_key unique (slug),
  constraint artists_booking_reference_prefix_key unique (booking_reference_prefix),
  constraint artists_slug_shape check (slug ~ '^[a-z][a-z0-9-]{1,62}$'),
  constraint artists_display_name_not_blank check (btrim(display_name) <> ''),
  constraint artists_display_name_length check (char_length(display_name) <= 120),
  constraint artists_legal_name_length check (legal_name is null or char_length(legal_name) <= 200),
  constraint artists_timezone_not_blank check (btrim(timezone) <> ''),
  constraint artists_timezone_length check (char_length(timezone) <= 100),
  constraint artists_currency_iso check (default_currency ~ '^[A-Z]{3}$'),
  constraint artists_booking_reference_prefix_shape check (
    booking_reference_prefix is null
    or booking_reference_prefix ~ '^[A-Z][A-Z0-9]{1,7}$'
  )
);

comment on table public.artists is
  'Tattoo artists whose CRM records, integrations and finance remain independently scoped.';
comment on column public.artists.booking_reference_prefix is
  'Optional stable prefix reserved for future artist-specific human references. It is not selected by the browser.';

create index if not exists artists_active_idx
  on public.artists (display_name) where is_active;

-- ---------------------------------------------------------------------------
-- Artist memberships
--
-- The global profiles.role remains the coarse capability boundary. A
-- membership can only narrow that role; helper functions below always check
-- both the current global role and this row.
-- ---------------------------------------------------------------------------

create table if not exists public.artist_memberships (
  id                      uuid primary key default gen_random_uuid(),
  profile_id              uuid not null references public.profiles(id) on delete cascade,
  artist_id               uuid not null references public.artists(id) on delete restrict,
  access_level            public.artist_access_level not null,
  can_view_finance        boolean not null default false,
  can_manage_finance      boolean not null default false,
  can_manage_sessions     boolean not null default false,
  can_manage_integrations boolean not null default false,
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint artist_memberships_profile_artist_key unique (profile_id, artist_id),
  constraint artist_memberships_manage_finance_requires_view check (
    not can_manage_finance or can_view_finance
  ),
  constraint artist_memberships_owner_capabilities check (
    access_level <> 'owner'
    or (
      can_view_finance
      and can_manage_finance
      and can_manage_sessions
      and can_manage_integrations
    )
  ),
  constraint artist_memberships_read_only_capabilities check (
    access_level <> 'read_only'
    or (
      not can_view_finance
      and not can_manage_finance
      and not can_manage_sessions
      and not can_manage_integrations
    )
  )
);

comment on table public.artist_memberships is
  'Maps one active CRM profile to the artist scopes it may access. Membership never widens profiles.role.';

create index if not exists artist_memberships_artist_idx
  on public.artist_memberships (artist_id, profile_id) where is_active;
create index if not exists artist_memberships_profile_idx
  on public.artist_memberships (profile_id, artist_id) where is_active;

-- ---------------------------------------------------------------------------
-- Private access mirrors
--
-- RLS helpers cannot query artist_memberships directly while evaluating a
-- policy on that table without creating policy recursion. These minimal mirrors
-- follow the existing crm_private.profile_access pattern from migration 0006.
-- ---------------------------------------------------------------------------

create table if not exists crm_private.artist_state (
  artist_id uuid primary key,
  is_active boolean not null
);

create table if not exists crm_private.artist_access (
  profile_id              uuid not null,
  artist_id               uuid not null,
  access_level            public.artist_access_level not null,
  can_view_finance        boolean not null,
  can_manage_finance      boolean not null,
  can_manage_sessions     boolean not null,
  can_manage_integrations boolean not null,
  is_active               boolean not null,
  primary key (profile_id, artist_id)
);

revoke all on crm_private.artist_state from public, anon, authenticated, service_role;
revoke all on crm_private.artist_access from public, anon, authenticated, service_role;

create or replace function crm_private.sync_artist_state()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if tg_op = 'DELETE' then
    delete from crm_private.artist_state where artist_id = old.id;
    return old;
  end if;

  insert into crm_private.artist_state (artist_id, is_active)
  values (new.id, new.is_active)
  on conflict (artist_id) do update
    set is_active = excluded.is_active;

  return new;
end;
$$;

create or replace function crm_private.protect_artist_membership_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.profile_id is distinct from old.profile_id
     or new.artist_id is distinct from old.artist_id then
    raise exception 'artist membership identity is immutable; deactivate it and create a new membership'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function crm_private.sync_artist_access()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if tg_op = 'DELETE' then
    delete from crm_private.artist_access
    where profile_id = old.profile_id and artist_id = old.artist_id;
    return old;
  end if;

  insert into crm_private.artist_access (
    profile_id, artist_id, access_level,
    can_view_finance, can_manage_finance,
    can_manage_sessions, can_manage_integrations, is_active
  ) values (
    new.profile_id, new.artist_id, new.access_level,
    new.can_view_finance, new.can_manage_finance,
    new.can_manage_sessions, new.can_manage_integrations, new.is_active
  )
  on conflict (profile_id, artist_id) do update
    set access_level = excluded.access_level,
        can_view_finance = excluded.can_view_finance,
        can_manage_finance = excluded.can_manage_finance,
        can_manage_sessions = excluded.can_manage_sessions,
        can_manage_integrations = excluded.can_manage_integrations,
        is_active = excluded.is_active;

  return new;
end;
$$;

revoke all on function crm_private.sync_artist_state()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.protect_artist_membership_identity()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.sync_artist_access()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Owner membership invariants
--
-- An active owner receives every artist scope. This is materialised rather than
-- assumed so the access graph remains inspectable and future policies can use
-- one membership model. Demotion/deactivation closes those owner memberships.
-- ---------------------------------------------------------------------------

create or replace function crm_private.ensure_owner_artist_memberships(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if exists (
    select 1
    from crm_private.profile_access p
    where p.profile_id = p_profile_id
      and p.is_active
      and p.role = 'owner'
  ) then
    insert into public.artist_memberships (
      profile_id, artist_id, access_level,
      can_view_finance, can_manage_finance,
      can_manage_sessions, can_manage_integrations, is_active
    )
    select p_profile_id, s.artist_id, 'owner', true, true, true, true, true
    from crm_private.artist_state s
    on conflict (profile_id, artist_id) do update
      set access_level = 'owner',
          can_view_finance = true,
          can_manage_finance = true,
          can_manage_sessions = true,
          can_manage_integrations = true,
          is_active = true;
  else
    update public.artist_memberships m
    set is_active = false
    where m.profile_id = p_profile_id
      and m.access_level = 'owner'
      and m.is_active;
  end if;
end;
$$;

create or replace function crm_private.sync_owner_artist_memberships()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.ensure_owner_artist_memberships(new.id);
  return new;
end;
$$;

create or replace function crm_private.grant_artist_to_active_owners()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  insert into public.artist_memberships (
    profile_id, artist_id, access_level,
    can_view_finance, can_manage_finance,
    can_manage_sessions, can_manage_integrations, is_active
  )
  select p.profile_id, new.id, 'owner', true, true, true, true, true
  from crm_private.profile_access p
  where p.is_active and p.role = 'owner'
  on conflict (profile_id, artist_id) do update
    set access_level = 'owner',
        can_view_finance = true,
        can_manage_finance = true,
        can_manage_sessions = true,
        can_manage_integrations = true,
        is_active = true;

  return new;
end;
$$;

revoke all on function crm_private.ensure_owner_artist_memberships(uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.sync_owner_artist_memberships()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.grant_artist_to_active_owners()
  from public, anon, authenticated, service_role;

-- Trigger names deliberately sort after profiles_sync_access, so the existing
-- profile mirror is updated before owner memberships are recalculated.
drop trigger if exists profiles_sync_owner_artist_memberships on public.profiles;
create trigger profiles_sync_owner_artist_memberships
  after insert or update of role, is_active on public.profiles
  for each row execute function crm_private.sync_owner_artist_memberships();

drop trigger if exists artists_sync_state on public.artists;
create trigger artists_sync_state
  after insert or update or delete on public.artists
  for each row execute function crm_private.sync_artist_state();

drop trigger if exists artists_grant_active_owners on public.artists;
create trigger artists_grant_active_owners
  after insert on public.artists
  for each row execute function crm_private.grant_artist_to_active_owners();

drop trigger if exists artist_memberships_protect_identity on public.artist_memberships;
create trigger artist_memberships_protect_identity
  before update on public.artist_memberships
  for each row execute function crm_private.protect_artist_membership_identity();

drop trigger if exists artist_memberships_sync_access on public.artist_memberships;
create trigger artist_memberships_sync_access
  after insert or update or delete on public.artist_memberships
  for each row execute function crm_private.sync_artist_access();

-- Existing timestamp helper from migration 0006.
drop trigger if exists artists_set_updated_at on public.artists;
create trigger artists_set_updated_at
  before update on public.artists
  for each row execute function public.set_updated_at();

drop trigger if exists artist_memberships_set_updated_at on public.artist_memberships;
create trigger artist_memberships_set_updated_at
  before update on public.artist_memberships
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Initial artist identities
--
-- Stable UUIDs make forward-only backfills and tests deterministic. No user,
-- email address, payment account or provider destination is stored here.
-- ---------------------------------------------------------------------------

insert into public.artists (
  id, slug, display_name, timezone, default_currency,
  booking_reference_prefix, is_active
) values
  ('a1111111-1111-4111-8111-111111111111', 'vladimir', 'Vladimir', 'Europe/London', 'GBP', 'VLA', true),
  ('a2222222-2222-4222-8222-222222222222', 'kristina', 'Kristina', 'Europe/London', 'GBP', 'KRI', true)
on conflict (slug) do nothing;

-- Defensive mirror backfill in case rows pre-dated trigger creation in a
-- partially applied development database.
insert into crm_private.artist_state (artist_id, is_active)
select a.id, a.is_active from public.artists a
on conflict (artist_id) do update set is_active = excluded.is_active;

-- Existing active owners receive both artist memberships. A project may have
-- no owner yet in a clean database; the profile trigger handles that later.
insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
)
select p.profile_id, a.artist_id, 'owner', true, true, true, true, true
from crm_private.profile_access p
cross join crm_private.artist_state a
where p.is_active and p.role = 'owner'
on conflict (profile_id, artist_id) do update
  set access_level = 'owner',
      can_view_finance = true,
      can_manage_finance = true,
      can_manage_sessions = true,
      can_manage_integrations = true,
      is_active = true;

insert into crm_private.artist_access (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
)
select m.profile_id, m.artist_id, m.access_level,
       m.can_view_finance, m.can_manage_finance,
       m.can_manage_sessions, m.can_manage_integrations, m.is_active
from public.artist_memberships m
on conflict (profile_id, artist_id) do update
  set access_level = excluded.access_level,
      can_view_finance = excluded.can_view_finance,
      can_manage_finance = excluded.can_manage_finance,
      can_manage_sessions = excluded.can_manage_sessions,
      can_manage_integrations = excluded.can_manage_integrations,
      is_active = excluded.is_active;

-- ---------------------------------------------------------------------------
-- Artist capability helpers
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
        else false
      end
  );
$$;

create or replace function public.can_access_artist(p_artist_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select crm_private.has_artist_capability(p_artist_id, 'view');
$$;

create or replace function public.can_manage_artist(p_artist_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select crm_private.has_artist_capability(p_artist_id, 'manage');
$$;

create or replace function public.can_view_artist_finance(p_artist_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select crm_private.has_artist_capability(p_artist_id, 'view_finance');
$$;

create or replace function public.can_manage_artist_finance(p_artist_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select crm_private.has_artist_capability(p_artist_id, 'manage_finance');
$$;

create or replace function public.can_manage_artist_sessions(p_artist_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select crm_private.has_artist_capability(p_artist_id, 'manage_sessions');
$$;

create or replace function public.can_manage_artist_integrations(p_artist_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select crm_private.has_artist_capability(p_artist_id, 'manage_integrations');
$$;

create or replace function crm_private.require_artist_access(
  p_artist_id uuid,
  p_capability text default 'view'
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  if p_artist_id is null then
    raise exception 'an artist id is required' using errcode = '22023';
  end if;

  if p_capability not in (
    'view', 'manage', 'view_finance', 'manage_finance',
    'manage_sessions', 'manage_integrations'
  ) then
    raise exception 'unknown artist capability %', p_capability using errcode = '22023';
  end if;

  if not crm_private.has_artist_capability(p_artist_id, p_capability) then
    raise exception 'artist access is not permitted' using errcode = '42501';
  end if;
end;
$$;

revoke all on function crm_private.has_artist_capability(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.require_artist_access(uuid, text)
  from public, anon, authenticated, service_role;

revoke all on function public.can_access_artist(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.can_manage_artist(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.can_view_artist_finance(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.can_manage_artist_finance(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.can_manage_artist_sessions(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.can_manage_artist_integrations(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.can_access_artist(uuid) to authenticated, service_role;
grant execute on function public.can_manage_artist(uuid) to authenticated, service_role;
grant execute on function public.can_view_artist_finance(uuid) to authenticated, service_role;
grant execute on function public.can_manage_artist_finance(uuid) to authenticated, service_role;
grant execute on function public.can_manage_artist_sessions(uuid) to authenticated, service_role;
grant execute on function public.can_manage_artist_integrations(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS and Data API privileges
--
-- Browser roles receive SELECT only. No direct membership or artist mutation
-- is exposed; future changes go through named, audited RPCs.
-- ---------------------------------------------------------------------------

alter table public.artists enable row level security;
alter table public.artists force row level security;
alter table public.artist_memberships enable row level security;
alter table public.artist_memberships force row level security;

revoke all on public.artists from public, anon, authenticated, service_role;
revoke all on public.artist_memberships from public, anon, authenticated, service_role;
grant select on public.artists to authenticated;
grant select on public.artist_memberships to authenticated;

drop policy if exists artists_select on public.artists;
create policy artists_select on public.artists
  for select
  using (public.can_access_artist(id) or crm_private.is_service_backend());

drop policy if exists artists_insert on public.artists;
create policy artists_insert on public.artists
  for insert
  with check (public.is_owner() or crm_private.is_service_backend());

drop policy if exists artists_update on public.artists;
create policy artists_update on public.artists
  for update
  using (public.is_owner() or crm_private.is_service_backend())
  with check (public.is_owner() or crm_private.is_service_backend());

drop policy if exists artist_memberships_select on public.artist_memberships;
create policy artist_memberships_select on public.artist_memberships
  for select
  using (
    public.is_owner()
    or (profile_id = auth.uid() and public.is_active_user())
    or crm_private.is_service_backend()
  );

drop policy if exists artist_memberships_insert on public.artist_memberships;
create policy artist_memberships_insert on public.artist_memberships
  for insert
  with check (public.is_owner() or crm_private.is_service_backend());

drop policy if exists artist_memberships_update on public.artist_memberships;
create policy artist_memberships_update on public.artist_memberships
  for update
  using (public.is_owner() or crm_private.is_service_backend())
  with check (public.is_owner() or crm_private.is_service_backend());

create or replace function public.list_accessible_artists()
returns table (
  id uuid,
  slug text,
  display_name text,
  timezone text,
  default_currency text,
  is_active boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select a.id, a.slug, a.display_name, a.timezone, a.default_currency, a.is_active
  from public.artists a
  where public.can_access_artist(a.id)
  order by a.display_name;
$$;

revoke all on function public.list_accessible_artists()
  from public, anon, authenticated, service_role;
grant execute on function public.list_accessible_artists() to authenticated;

comment on function public.list_accessible_artists() is
  'Returns only artist identities available to the current active profile. It never returns integration or finance configuration.';

-- Default ACLs were closed in migration 0012. Keep the intended surface
-- explicit and leave every private helper inaccessible to browser roles.
