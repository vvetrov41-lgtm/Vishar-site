-- 0083_workspace_automation_defaults.sql
--
-- Phase P: workspace automation defaults and explicit artist overrides.
--
-- The important property is the same one that governs workspace team access in
-- migration 0075: workspace scope expands at write time into explicit
-- artist-scoped rows. The validated 0081 scheduler therefore does not learn an
-- inheritance rule and does not change at all. Every executable automation is
-- still a public.automation_rules row with one authoritative artist_id.
--
-- A workspace default is a blueprint, not ambient authority. Creating or
-- updating one requires workspace integration-management authority AND
-- manage_automations on every active artist it is about to affect. A later
-- artist does not silently inherit existing defaults; onboarding has to call
-- apply_workspace_automation_defaults_to_artist explicitly, which again checks
-- both authorities.
--
-- Artist overrides are equally explicit. The concrete rule remembers which
-- workspace default produced it, which default version it last inherited, and
-- whether the artist deliberately diverged. Updating a workspace default only
-- refreshes non-overridden copies. Clearing an override copies the current
-- workspace default back into the existing artist rule.
--
-- These control-plane RPC contracts are deliberately closed to API roles in
-- this migration. The data model and authorization are established first; a
-- later CRM/MCP surface may grant a reviewed subset without turning this schema
-- release into a new browser authority boundary.
--
-- Forward-only. No cron, Worker, provider, client communication, or production
-- configuration changes.

-- ---------------------------------------------------------------------------
-- 1. Workspace blueprints
-- ---------------------------------------------------------------------------

create table if not exists public.workspace_automation_defaults (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references public.workspaces (id) on delete cascade,
  name                  text not null,
  trigger_event_type    text not null references public.automation_trigger_catalog (event_type),
  condition_from_status text,
  condition_to_status   text,
  delay_minutes         integer not null default 0,
  action_type           public.automation_action_type not null default 'notify_artist_team',
  action_title          text not null,
  action_body           text,
  action_priority       public.notification_priority not null default 'normal',
  is_enabled            boolean not null default false,
  version               integer not null default 1,
  created_by            uuid references public.profiles (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint workspace_automation_defaults_name_present check (btrim(name) <> ''),
  constraint workspace_automation_defaults_name_length check (length(name) <= 120),
  constraint workspace_automation_defaults_title_present check (btrim(action_title) <> ''),
  constraint workspace_automation_defaults_title_length check (length(action_title) <= 200),
  constraint workspace_automation_defaults_body_length
    check (action_body is null or length(action_body) <= 2000),
  constraint workspace_automation_defaults_delay_bounds
    check (delay_minutes between 0 and 43200),
  constraint workspace_automation_defaults_condition_shape
    check (
      (condition_from_status is null or condition_from_status ~ '^[a-z][a-z0-9_]{0,63}$')
      and (condition_to_status is null or condition_to_status ~ '^[a-z][a-z0-9_]{0,63}$')
    )
);

comment on table public.workspace_automation_defaults is
  'Workspace automation blueprints. They never execute directly: an authorized write expands them into ordinary artist-scoped automation_rules rows.';

create index if not exists workspace_automation_defaults_workspace_idx
  on public.workspace_automation_defaults (workspace_id, created_at, id);

create or replace function crm_private.bump_workspace_automation_default_version()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'a workspace automation default cannot change workspace; create a new default instead'
      using errcode = '23514';
  end if;

  if new.name is distinct from old.name
     or new.trigger_event_type is distinct from old.trigger_event_type
     or new.condition_from_status is distinct from old.condition_from_status
     or new.condition_to_status is distinct from old.condition_to_status
     or new.delay_minutes is distinct from old.delay_minutes
     or new.action_type is distinct from old.action_type
     or new.action_title is distinct from old.action_title
     or new.action_body is distinct from old.action_body
     or new.action_priority is distinct from old.action_priority
     or new.is_enabled is distinct from old.is_enabled then
    new.version := old.version + 1;
  end if;

  return new;
end;
$$;

drop trigger if exists workspace_automation_defaults_bump_version
  on public.workspace_automation_defaults;
create trigger workspace_automation_defaults_bump_version
  before update on public.workspace_automation_defaults
  for each row execute function crm_private.bump_workspace_automation_default_version();

drop trigger if exists workspace_automation_defaults_set_updated_at
  on public.workspace_automation_defaults;
create trigger workspace_automation_defaults_set_updated_at
  before update on public.workspace_automation_defaults
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Provenance on the concrete artist rule
-- ---------------------------------------------------------------------------

alter table public.automation_rules
  add column if not exists workspace_default_id uuid
    references public.workspace_automation_defaults (id) on delete restrict,
  add column if not exists workspace_default_version integer,
  add column if not exists workspace_override boolean not null default false;

alter table public.automation_rules
  add constraint automation_rules_workspace_source_shape
  check (
    (workspace_default_id is null
      and workspace_default_version is null
      and not workspace_override)
    or
    (workspace_default_id is not null
      and workspace_default_version is not null
      and workspace_default_version > 0)
  );

-- PostgreSQL UNIQUE treats NULLs as distinct, so manual rules remain unlimited
-- while one workspace default can have at most one concrete rule per artist.
create unique index if not exists automation_rules_workspace_default_artist_idx
  on public.automation_rules (workspace_default_id, artist_id);

create or replace function crm_private.guard_workspace_automation_rule_source()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_default_workspace uuid;
  v_artist_workspace uuid;
begin
  if new.workspace_default_id is null then
    if new.workspace_default_version is not null or new.workspace_override then
      raise exception 'manual automation rules cannot carry workspace-default provenance'
        using errcode = '23514';
    end if;
    return new;
  end if;

  select d.workspace_id into v_default_workspace
  from public.workspace_automation_defaults d
  where d.id = new.workspace_default_id;

  select a.workspace_id into v_artist_workspace
  from public.artists a
  where a.id = new.artist_id;

  if v_default_workspace is null or v_artist_workspace is null
     or v_default_workspace <> v_artist_workspace then
    raise exception 'workspace automation defaults may only materialize inside their own workspace'
      using errcode = '23514';
  end if;

  if new.workspace_default_version is null or new.workspace_default_version < 1 then
    raise exception 'workspace-default provenance requires a positive source version'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists automation_rules_guard_workspace_source
  on public.automation_rules;
create trigger automation_rules_guard_workspace_source
  before insert or update on public.automation_rules
  for each row execute function crm_private.guard_workspace_automation_rule_source();

-- ---------------------------------------------------------------------------
-- 3. Validation and write-time materialisation helpers
-- ---------------------------------------------------------------------------

create or replace function crm_private.validate_workspace_automation_definition(
  p_trigger_event_type text,
  p_condition_from_status text,
  p_condition_to_status text
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_has_status boolean;
begin
  select c.has_status into v_has_status
  from public.automation_trigger_catalog c
  where c.event_type = p_trigger_event_type;

  if v_has_status is null then
    raise exception 'unknown automation trigger %', p_trigger_event_type
      using errcode = '22023';
  end if;

  if not v_has_status
     and (p_condition_from_status is not null or p_condition_to_status is not null) then
    raise exception 'status conditions require a status-bearing automation trigger'
      using errcode = '22023';
  end if;
end;
$$;

create or replace function crm_private.materialize_workspace_automation_default(
  p_default_id uuid,
  p_artist_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_default public.workspace_automation_defaults%rowtype;
  v_artist_workspace uuid;
  v_rule_id uuid;
begin
  select d.* into v_default
  from public.workspace_automation_defaults d
  where d.id = p_default_id;

  if not found then
    raise exception 'the workspace automation default is unavailable'
      using errcode = '22023';
  end if;

  select a.workspace_id into v_artist_workspace
  from public.artists a
  where a.id = p_artist_id and a.is_active;

  if v_artist_workspace is null or v_artist_workspace <> v_default.workspace_id then
    raise exception 'the artist does not belong to the automation default workspace'
      using errcode = '23514';
  end if;

  insert into public.automation_rules (
    artist_id, name, trigger_event_type,
    condition_from_status, condition_to_status, delay_minutes,
    action_type, action_title, action_body, action_priority,
    is_enabled, created_by,
    workspace_default_id, workspace_default_version, workspace_override
  ) values (
    p_artist_id, v_default.name, v_default.trigger_event_type,
    v_default.condition_from_status, v_default.condition_to_status,
    v_default.delay_minutes,
    v_default.action_type, v_default.action_title, v_default.action_body,
    v_default.action_priority,
    v_default.is_enabled, auth.uid(),
    v_default.id, v_default.version, false
  )
  on conflict (workspace_default_id, artist_id) do update
    set name = excluded.name,
        trigger_event_type = excluded.trigger_event_type,
        condition_from_status = excluded.condition_from_status,
        condition_to_status = excluded.condition_to_status,
        delay_minutes = excluded.delay_minutes,
        action_type = excluded.action_type,
        action_title = excluded.action_title,
        action_body = excluded.action_body,
        action_priority = excluded.action_priority,
        is_enabled = excluded.is_enabled,
        workspace_default_version = excluded.workspace_default_version
    where not public.automation_rules.workspace_override
  returning id into v_rule_id;

  -- DO UPDATE ... WHERE returns no row when an artist override deliberately
  -- blocks inheritance. Return the already-existing rule id in that case.
  if v_rule_id is null then
    select r.id into v_rule_id
    from public.automation_rules r
    where r.workspace_default_id = p_default_id
      and r.artist_id = p_artist_id;
  end if;

  return v_rule_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Closed control-plane contracts
-- ---------------------------------------------------------------------------

create or replace function public.upsert_workspace_automation_default(
  p_workspace_id uuid,
  p_default_id uuid,
  p_name text,
  p_trigger_event_type text,
  p_action_title text,
  p_action_body text default null,
  p_condition_from_status text default null,
  p_condition_to_status text default null,
  p_delay_minutes integer default 0,
  p_action_priority public.notification_priority default 'normal',
  p_is_enabled boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid;
  v_artist record;
begin
  if p_workspace_id is null then
    raise exception 'a workspace is required' using errcode = '22023';
  end if;

  perform crm_private.require_workspace_access(p_workspace_id, 'manage_integrations');

  if not exists (
    select 1 from crm_private.workspace_state w
    where w.workspace_id = p_workspace_id and w.is_active
  ) then
    raise exception 'the workspace is unavailable' using errcode = '22023';
  end if;

  perform crm_private.validate_workspace_automation_definition(
    p_trigger_event_type, p_condition_from_status, p_condition_to_status
  );

  -- Workspace administration is not artist authority. Fail the whole write if
  -- even one active artist would be changed without explicit manage_automations
  -- authority; never silently apply a "workspace default" to a subset.
  if exists (
    select 1
    from public.artists a
    where a.workspace_id = p_workspace_id
      and a.is_active
      and not crm_private.has_artist_capability(a.id, 'manage_automations')
  ) then
    raise exception 'manage_automations is required for every active artist affected by this workspace default'
      using errcode = '42501';
  end if;

  if p_default_id is null then
    insert into public.workspace_automation_defaults (
      workspace_id, name, trigger_event_type,
      condition_from_status, condition_to_status, delay_minutes,
      action_type, action_title, action_body, action_priority,
      is_enabled, created_by
    ) values (
      p_workspace_id, btrim(p_name), p_trigger_event_type,
      p_condition_from_status, p_condition_to_status, coalesce(p_delay_minutes, 0),
      'notify_artist_team', btrim(p_action_title), p_action_body,
      coalesce(p_action_priority, 'normal'), coalesce(p_is_enabled, false), auth.uid()
    )
    returning id into v_id;
  else
    update public.workspace_automation_defaults d
    set name = btrim(p_name),
        trigger_event_type = p_trigger_event_type,
        condition_from_status = p_condition_from_status,
        condition_to_status = p_condition_to_status,
        delay_minutes = coalesce(p_delay_minutes, 0),
        action_type = 'notify_artist_team',
        action_title = btrim(p_action_title),
        action_body = p_action_body,
        action_priority = coalesce(p_action_priority, 'normal'),
        is_enabled = coalesce(p_is_enabled, false)
    where d.id = p_default_id
      and d.workspace_id = p_workspace_id
    returning d.id into v_id;

    if v_id is null then
      raise exception 'the workspace automation default is unavailable'
        using errcode = '22023';
    end if;
  end if;

  for v_artist in
    select a.id
    from public.artists a
    where a.workspace_id = p_workspace_id and a.is_active
    order by a.id
  loop
    perform crm_private.materialize_workspace_automation_default(v_id, v_artist.id);
  end loop;

  perform crm_private.log_activity(
    case when p_default_id is null
         then 'automation.workspace_default_created'
         else 'automation.workspace_default_updated' end,
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    null, null, null, null, null, null, null, null,
    jsonb_build_object('workspace_id', p_workspace_id, 'default_id', v_id)
  );

  return v_id;
end;
$$;

create or replace function public.apply_workspace_automation_defaults_to_artist(
  p_artist_id uuid
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_workspace_id uuid;
  v_default record;
  v_count integer := 0;
begin
  select a.workspace_id into v_workspace_id
  from public.artists a
  where a.id = p_artist_id and a.is_active;

  if v_workspace_id is null then
    raise exception 'the artist is unavailable' using errcode = '22023';
  end if;

  perform crm_private.require_workspace_access(v_workspace_id, 'manage_integrations');
  perform crm_private.require_artist_access(p_artist_id, 'manage_automations');

  for v_default in
    select d.id
    from public.workspace_automation_defaults d
    where d.workspace_id = v_workspace_id
    order by d.created_at, d.id
  loop
    perform crm_private.materialize_workspace_automation_default(v_default.id, p_artist_id);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

create or replace function public.set_artist_automation_override(
  p_workspace_default_id uuid,
  p_artist_id uuid,
  p_name text,
  p_trigger_event_type text,
  p_action_title text,
  p_action_body text default null,
  p_condition_from_status text default null,
  p_condition_to_status text default null,
  p_delay_minutes integer default 0,
  p_action_priority public.notification_priority default 'normal',
  p_is_enabled boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_default_workspace uuid;
  v_artist_workspace uuid;
  v_rule_id uuid;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_automations');

  select d.workspace_id into v_default_workspace
  from public.workspace_automation_defaults d
  where d.id = p_workspace_default_id;

  select a.workspace_id into v_artist_workspace
  from public.artists a
  where a.id = p_artist_id and a.is_active;

  if v_default_workspace is null or v_artist_workspace is null
     or v_default_workspace <> v_artist_workspace then
    raise exception 'the automation default does not belong to this artist workspace'
      using errcode = '23514';
  end if;

  perform crm_private.validate_workspace_automation_definition(
    p_trigger_event_type, p_condition_from_status, p_condition_to_status
  );

  update public.automation_rules r
  set name = btrim(p_name),
      trigger_event_type = p_trigger_event_type,
      condition_from_status = p_condition_from_status,
      condition_to_status = p_condition_to_status,
      delay_minutes = coalesce(p_delay_minutes, 0),
      action_type = 'notify_artist_team',
      action_title = btrim(p_action_title),
      action_body = p_action_body,
      action_priority = coalesce(p_action_priority, 'normal'),
      is_enabled = coalesce(p_is_enabled, false),
      workspace_override = true
  where r.workspace_default_id = p_workspace_default_id
    and r.artist_id = p_artist_id
  returning r.id into v_rule_id;

  if v_rule_id is null then
    raise exception 'apply the workspace default to this artist before overriding it'
      using errcode = '22023';
  end if;

  perform crm_private.log_artist_activity(
    p_artist_id, 'automation.rule_updated',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(), null, null, null, null, null,
    jsonb_build_object('workspace_default_id', p_workspace_default_id,
                       'workspace_override', true)
  );

  return v_rule_id;
end;
$$;

create or replace function public.clear_artist_automation_override(
  p_workspace_default_id uuid,
  p_artist_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_default public.workspace_automation_defaults%rowtype;
  v_artist_workspace uuid;
  v_rule_id uuid;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_automations');

  select d.* into v_default
  from public.workspace_automation_defaults d
  where d.id = p_workspace_default_id;

  select a.workspace_id into v_artist_workspace
  from public.artists a
  where a.id = p_artist_id and a.is_active;

  if v_default.id is null or v_artist_workspace is null
     or v_default.workspace_id <> v_artist_workspace then
    raise exception 'the automation default does not belong to this artist workspace'
      using errcode = '23514';
  end if;

  update public.automation_rules r
  set name = v_default.name,
      trigger_event_type = v_default.trigger_event_type,
      condition_from_status = v_default.condition_from_status,
      condition_to_status = v_default.condition_to_status,
      delay_minutes = v_default.delay_minutes,
      action_type = v_default.action_type,
      action_title = v_default.action_title,
      action_body = v_default.action_body,
      action_priority = v_default.action_priority,
      is_enabled = v_default.is_enabled,
      workspace_default_version = v_default.version,
      workspace_override = false
  where r.workspace_default_id = p_workspace_default_id
    and r.artist_id = p_artist_id
  returning r.id into v_rule_id;

  if v_rule_id is null then
    raise exception 'the workspace automation default has not been applied to this artist'
      using errcode = '22023';
  end if;

  perform crm_private.log_artist_activity(
    p_artist_id, 'automation.rule_updated',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(), null, null, null, null, null,
    jsonb_build_object('workspace_default_id', p_workspace_default_id,
                       'workspace_override', false)
  );

  return v_rule_id;
end;
$$;

create or replace function public.list_workspace_automation_defaults(
  p_workspace_id uuid
)
returns table (
  id                    uuid,
  workspace_id          uuid,
  name                  text,
  trigger_event_type    text,
  condition_from_status text,
  condition_to_status   text,
  delay_minutes         integer,
  action_type           public.automation_action_type,
  action_title          text,
  action_body           text,
  action_priority       public.notification_priority,
  is_enabled            boolean,
  version               integer,
  materialized_artists  integer,
  overridden_artists    integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_workspace_access(p_workspace_id, 'manage_integrations');

  return query
  select d.id, d.workspace_id, d.name, d.trigger_event_type,
         d.condition_from_status, d.condition_to_status, d.delay_minutes,
         d.action_type, d.action_title, d.action_body, d.action_priority,
         d.is_enabled, d.version,
         count(r.id)::int,
         count(r.id) filter (where r.workspace_override)::int
  from public.workspace_automation_defaults d
  left join public.automation_rules r on r.workspace_default_id = d.id
  where d.workspace_id = p_workspace_id
  group by d.id
  order by d.created_at, d.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS, privileges, and deliberately closed API boundary
-- ---------------------------------------------------------------------------

alter table public.workspace_automation_defaults enable row level security;
alter table public.workspace_automation_defaults force row level security;

revoke all on public.workspace_automation_defaults
  from public, anon, authenticated, service_role;

-- service_role receives no table privilege. This policy exists only so a later
-- backend contract can be granted narrowly without redesigning the table.
drop policy if exists workspace_automation_defaults_service_select
  on public.workspace_automation_defaults;
create policy workspace_automation_defaults_service_select
  on public.workspace_automation_defaults
  for select using (crm_private.is_service_backend());

revoke all on function crm_private.bump_workspace_automation_default_version()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.guard_workspace_automation_rule_source()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.validate_workspace_automation_definition(text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.materialize_workspace_automation_default(uuid,uuid)
  from public, anon, authenticated, service_role;

-- These are stable named control-plane contracts but intentionally have no API
-- role grant in Phase P. A later UI/MCP release must explicitly add them to the
-- strict 050 allow-list at the same time it makes them callable.
revoke all on function public.upsert_workspace_automation_default(
  uuid,uuid,text,text,text,text,text,text,integer,public.notification_priority,boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.apply_workspace_automation_defaults_to_artist(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.set_artist_automation_override(
  uuid,uuid,text,text,text,text,text,text,integer,public.notification_priority,boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.clear_artist_automation_override(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_workspace_automation_defaults(uuid)
  from public, anon, authenticated, service_role;
