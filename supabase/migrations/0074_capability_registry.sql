-- 0074_capability_registry.sql
--
-- A canonical, enumerable capability registry for artist-scoped authorization.
--
-- Why this exists
-- ---------------
-- Today `crm_private.has_artist_capability` accepts six hard-coded capability
-- strings, and each caller — RLS policies, workflow RPCs, the CRM's
-- `admin/src/lib/permissions.ts`, the GPT action Workers — carries its own
-- private copy of what those strings mean. Adding a seventh capability means
-- editing every copy, and a future MCP surface would have added an eighth.
--
-- This migration turns the capability vocabulary into data that every surface
-- can read, and adds the finer-grained names the platform needs (team,
-- communications, booking sources, notifications, automations, workspace).
--
-- What this migration deliberately does NOT change
-- ------------------------------------------------
-- The six legacy capability strings are load-bearing: they appear inside live
-- RLS policies and inside RPC bodies that are deployed right now. Every one of
-- them keeps its exact current meaning, decided by exactly the same membership
-- facts. `has_artist_capability` gains new branches; no existing branch is
-- edited. `221`-series pgTAP pins the legacy answers for every combination of
-- (global role x access level x capability flag) so a future edit cannot
-- silently widen one.
--
-- No data is destroyed, no grant is widened, no provider is contacted and
-- nothing is deployed. Forward-only.

-- ---------------------------------------------------------------------------
-- 1. The registry
--
-- `implied_by` lets a coarse capability answer for a finer one without a
-- second lookup: a membership that satisfies `manage` satisfies
-- `manage_enquiries`. It is a documentation and enumeration aid; the
-- authoritative decision still happens in `has_artist_capability`, because a
-- table a user could read is not a place to put an authorization rule.
-- ---------------------------------------------------------------------------

create table if not exists public.capability_registry (
  capability    text primary key,
  domain        text not null,
  is_write      boolean not null,
  implied_by    text references public.capability_registry (capability),
  description   text not null,
  created_at    timestamptz not null default now(),
  constraint capability_registry_name_shape
    check (capability ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint capability_registry_domain_shape
    check (domain ~ '^[a-z][a-z0-9_]{2,31}$')
);

comment on table public.capability_registry is
  'Canonical vocabulary of artist-scoped capabilities shared by the CRM, MCP and GPT surfaces. Reading a row grants nothing; crm_private.has_artist_capability remains the only authority.';

-- Legacy names first, so `implied_by` can reference them.
insert into public.capability_registry (capability, domain, is_write, implied_by, description) values
  ('view',                 'legacy',         false, null,     'Legacy: any read access to the artist scope.'),
  ('manage',               'legacy',         true,  null,     'Legacy: general write access to the artist scope.'),
  ('view_finance',         'finance',        false, null,     'Read deposits, payment requests and the payment ledger.'),
  ('manage_finance',       'finance',        true,  null,     'Issue, cancel and reconcile payments.'),
  ('manage_sessions',      'sessions',       true,  null,     'Create, reschedule and cancel appointments.'),
  ('manage_integrations',  'integrations',   true,  null,     'Connect, reconnect, test and disconnect provider integrations.')
on conflict (capability) do nothing;

insert into public.capability_registry (capability, domain, is_write, implied_by, description) values
  ('view_clients',            'clients',        false, 'view',                'Read client records in this artist scope.'),
  ('manage_clients',          'clients',        true,  'manage',              'Create and edit client records.'),
  ('view_enquiries',          'enquiries',      false, 'view',                'Read enquiries.'),
  ('manage_enquiries',        'enquiries',      true,  'manage',              'Edit enquiries and move them through their status flow.'),
  ('assign_enquiries',        'enquiries',      true,  'manage',              'Assign an enquiry to a CRM user.'),
  ('view_projects',           'projects',       false, 'view',                'Read projects.'),
  ('manage_projects',         'projects',       true,  'manage',              'Create and edit projects.'),
  ('view_sessions',           'sessions',       false, 'view',                'Read appointments and availability.'),
  ('view_communications',     'communications', false, 'view',                'Read client conversations.'),
  ('send_communications',     'communications', true,  'manage',              'Send a message to a client.'),
  ('manage_communications',   'communications', true,  'manage',              'Link, promote and archive conversations.'),
  ('view_integrations',       'integrations',   false, 'view',                'See safe integration status. Never a token, chat id or secret.'),
  ('view_booking_sources',    'booking',        false, 'view',                'See booking forms and connected websites.'),
  ('manage_booking_sources',  'booking',        true,  'manage_integrations', 'Create, edit and disable booking forms and websites.'),
  ('view_notifications',      'notifications',  false, 'view',                'See notifications addressed to this artist scope.'),
  ('manage_notifications',    'notifications',  true,  'manage',              'Change notification routing for this artist scope.'),
  ('view_automations',        'automations',    false, 'view',                'Read automation rules.'),
  ('manage_automations',      'automations',    true,  'manage_integrations', 'Create, activate and disable automation rules.'),
  ('manage_team',             'team',           true,  null,                  'Invite and manage the people who work on this artist scope.'),
  ('manage_workspace',        'workspace',      true,  null,                  'Administer the workspace this artist belongs to.')
on conflict (capability) do nothing;

alter table public.capability_registry enable row level security;
alter table public.capability_registry force row level security;

revoke all on public.capability_registry from anon, authenticated, service_role;
grant select on public.capability_registry to authenticated, service_role;

-- The vocabulary is not confidential; only signed-in CRM users can read it.
create policy capability_registry_read on public.capability_registry
  for select to authenticated
  using (public.is_active_user());

-- No write policy is declared on purpose. `authenticated` holds SELECT and
-- nothing else, so INSERT/UPDATE/DELETE are refused by privilege before RLS is
-- consulted. A permissive `using (false)` policy would OR with the read policy
-- and control nothing, which would be worse than absent.

-- ---------------------------------------------------------------------------
-- 2. Membership provenance
--
-- `crm_private.ensure_owner_artist_memberships` and
-- `crm_private.grant_artist_to_active_owners` synthesise an `owner` membership
-- on every artist for every active global owner. That is correct for a
-- single-installation CRM and wrong for a platform: it is what makes a new
-- artist's account see every other artist.
--
-- Phase C narrows those triggers to workspace scope. That cannot be done
-- safely until workspaces exist and are backfilled, so this migration only
-- records *how* each membership came to exist. Synthesised rows become
-- identifiable without changing anyone's access today.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'artist_memberships'
      and column_name = 'grant_source'
  ) then
    alter table public.artist_memberships
      add column grant_source text not null default 'explicit';

    alter table public.artist_memberships
      add constraint artist_memberships_grant_source_known
      check (grant_source in ('explicit', 'owner_sync', 'workspace_grant'));
  end if;
end;
$$;

comment on column public.artist_memberships.grant_source is
  'How this membership came to exist: explicit (a human granted it), owner_sync (synthesised by the legacy global-owner triggers), workspace_grant (granted through a workspace role). Never widens access on its own.';

-- Backfill: an owner-level membership that covers an artist the profile did not
-- explicitly ask for is, by construction, one the owner triggers produced.
update public.artist_memberships m
set grant_source = 'owner_sync'
where m.access_level = 'owner'
  and m.grant_source = 'explicit'
  and exists (
    select 1
    from crm_private.profile_access p
    where p.profile_id = m.profile_id
      and p.is_active
      and p.role = 'owner'
  );

-- Keep the marker accurate as the legacy triggers keep running.
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
      can_manage_sessions, can_manage_integrations, is_active, grant_source
    )
    select p_profile_id, s.artist_id, 'owner', true, true, true, true, true, 'owner_sync'
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
    can_manage_sessions, can_manage_integrations, is_active, grant_source
  )
  select p.profile_id, new.id, 'owner', true, true, true, true, true, 'owner_sync'
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

-- ---------------------------------------------------------------------------
-- 3. The resolver
--
-- Every legacy branch is reproduced character for character. The new branches
-- are additions below the `else` that used to return false.
--
-- The two capabilities that are new *rights* rather than new names for old
-- rights are `manage_team` and `manage_workspace`. Both are deliberately
-- narrow here: only a global owner, or an artist-level membership on that
-- exact artist, may manage that artist's team. Workspace administration
-- returns false until Phase C introduces workspace memberships; a capability
-- that has no authority to consult must not guess.
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
        -- Legacy vocabulary. Unchanged.
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

        -- Reads. Any active membership on the artist already implies these;
        -- they exist so a caller can ask a precise question.
        when 'view_clients' then true
        when 'view_enquiries' then true
        when 'view_projects' then true
        when 'view_sessions' then true
        when 'view_communications' then true
        when 'view_integrations' then true
        when 'view_booking_sources' then true
        when 'view_notifications' then true
        when 'view_automations' then true

        -- Writes that the legacy `manage` right already covered.
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

        -- Writes that follow the integrations right, because they change how
        -- work reaches the outside world.
        when 'manage_booking_sources' then
          p.role = 'owner'
          or (p.role = 'booking_manager' and a.can_manage_integrations)
        when 'manage_automations' then
          p.role = 'owner'
          or (p.role = 'booking_manager' and a.can_manage_integrations)

        -- New rights.
        --
        -- An artist runs their own team. A manager does not acquire the power
        -- to invite further managers by being able to manage integrations.
        when 'manage_team' then
          p.role = 'owner'
          or a.access_level in ('owner', 'artist')

        -- No workspace authority exists yet. Fail closed rather than guess.
        when 'manage_workspace' then false

        else false
      end
  );
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

  -- The registry is now the allow-list. An unknown capability is a programming
  -- error and must not be treated as "denied but plausible".
  if not exists (
    select 1 from public.capability_registry r
    where r.capability = p_capability
  ) then
    raise exception 'unknown artist capability %', p_capability using errcode = '22023';
  end if;

  if not crm_private.has_artist_capability(p_artist_id, p_capability) then
    raise exception 'artist access is not permitted' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The shared read surface
--
-- One function that the CRM, MCP and GPT all call to learn what the caller may
-- do. Without it each surface re-derives capabilities from `profiles.role`
-- plus membership flags, which is exactly how three permission systems start.
--
-- It reports only the caller's own capabilities. It takes no profile argument,
-- so no caller can ask about somebody else.
-- ---------------------------------------------------------------------------

create or replace function public.list_capabilities(p_artist_id uuid default null)
returns table (
  artist_id  uuid,
  capability text,
  domain     text,
  is_write   boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select a.artist_id, r.capability, r.domain, r.is_write
  from crm_private.artist_state a
  cross join public.capability_registry r
  where a.is_active
    and (p_artist_id is null or a.artist_id = p_artist_id)
    and r.domain <> 'legacy'
    and crm_private.has_artist_capability(a.artist_id, r.capability)
  order by a.artist_id, r.domain, r.capability;
$$;

comment on function public.list_capabilities(uuid) is
  'The signed-in profile''s own artist-scoped capabilities. Takes no profile argument by design: a caller can never ask what another user may do.';

revoke all on function public.list_capabilities(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_capabilities(uuid) to authenticated;

-- `has_artist_capability` and `require_artist_access` keep their existing
-- grants: both are crm_private helpers reached through SECURITY DEFINER
-- callers, and neither is directly callable by an API role. `create or replace`
-- preserves the existing ACL, so nothing is re-granted here.
