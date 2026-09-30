-- Unified GPT v2: Team and Workspace administration (specs/gpt-team-workspace-admin).
--
-- The owner decided on 2026-09-30 to expose the remaining Team, Workspace and
-- own-account operator actions to the profile-bound unified GPT. Each wrapper:
--   1. requires the registered GPT OAuth client and the `administration`
--      ceiling, which only the profile-bound unified client can hold;
--   2. derives the Artist or workspace from the server-owned GPT context and
--      never accepts one from the model;
--   3. calls the same public RPC the CRM screen calls, which keeps its own
--      owner / manage_team / workspace-administrator check on auth.uid().
-- The capability argument of the guards is null on purpose: duplicating the
-- CRM RPC's role checks here would drift from them.
--
-- Team invitations (team.invite, team.artist_invite) run through the Team API
-- Worker and are not part of this migration. Account deletion, workspace
-- ownership transfer, the installation signup policy and the control-plane
-- access gate stay CRM screen actions by the owner's decision.

-- ---------------------------------------------------------------------------
-- Narrowing helper: a profile belongs to a workspace when it holds a
-- workspace membership there or a membership on one of its Artists.
-- ---------------------------------------------------------------------------

create or replace function crm_private.gpt_profile_in_workspace(p_profile_id uuid, p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select exists (
    select 1 from public.workspace_memberships wm
    where wm.profile_id = p_profile_id and wm.workspace_id = p_workspace_id
  ) or exists (
    select 1 from public.artist_memberships am
    join public.artists a on a.id = am.artist_id
    where am.profile_id = p_profile_id and a.workspace_id = p_workspace_id
  );
$$;

revoke all on function crm_private.gpt_profile_in_workspace(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ======================================================================= Team

create or replace function public.gpt_list_team_profiles()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_context_workspace('administration', null);
  return coalesce((
    select jsonb_agg(to_jsonb(p) order by p.display_name, p.email)
    from public.list_profiles() p
    where crm_private.gpt_profile_in_workspace(p.id, v_ctx.workspace_id)
  ), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_set_team_profile_role(p_request_id uuid, p_profile_id uuid, p_role text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_request jsonb; v_replay jsonb;
begin
  select * into v_ctx from crm_private.require_gpt_context_workspace('administration', null);
  if not crm_private.gpt_profile_in_workspace(p_profile_id, v_ctx.workspace_id) then
    raise exception 'profile is outside the active GPT workspace' using errcode = '42501';
  end if;
  v_request := jsonb_build_object('profile_id', p_profile_id, 'role', p_role);
  v_replay := crm_private.gpt_receipt_begin(v_ctx.gpt_client_id, p_request_id, 'set_team_profile_role', v_request);
  if v_replay is not null then return v_replay; end if;
  return crm_private.gpt_receipt_finish(v_ctx.gpt_client_id, p_request_id, 'set_team_profile_role', v_request,
    public.set_profile_role(p_profile_id, p_role::public.crm_role));
end;
$$;

create or replace function public.gpt_set_team_profile_active(p_request_id uuid, p_profile_id uuid, p_is_active boolean)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_request jsonb; v_replay jsonb;
begin
  select * into v_ctx from crm_private.require_gpt_context_workspace('administration', null);
  if not crm_private.gpt_profile_in_workspace(p_profile_id, v_ctx.workspace_id) then
    raise exception 'profile is outside the active GPT workspace' using errcode = '42501';
  end if;
  v_request := jsonb_build_object('profile_id', p_profile_id, 'is_active', p_is_active);
  v_replay := crm_private.gpt_receipt_begin(v_ctx.gpt_client_id, p_request_id, 'set_team_profile_active', v_request);
  if v_replay is not null then return v_replay; end if;
  return crm_private.gpt_receipt_finish(v_ctx.gpt_client_id, p_request_id, 'set_team_profile_active', v_request,
    public.set_profile_active(p_profile_id, p_is_active));
end;
$$;

create or replace function public.gpt_list_team_memberships()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_context_workspace('administration', null);
  return coalesce((
    select jsonb_agg(to_jsonb(m) order by m.artist_id, m.profile_id)
    from public.list_team_memberships() m
    join public.artists a on a.id = m.artist_id
    where a.workspace_id = v_ctx.workspace_id
  ), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_upsert_artist_membership(
  p_request_id uuid,
  p_profile_id uuid,
  p_access_level text,
  p_can_view_finance boolean default null,
  p_can_manage_finance boolean default null,
  p_can_manage_sessions boolean default null,
  p_can_manage_integrations boolean default null,
  p_is_active boolean default null
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_request jsonb; v_replay jsonb; v_current public.artist_memberships%rowtype;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('administration', null);
  v_request := jsonb_build_object('profile_id', p_profile_id, 'access_level', p_access_level,
    'view_finance', p_can_view_finance, 'manage_finance', p_can_manage_finance,
    'manage_sessions', p_can_manage_sessions, 'manage_integrations', p_can_manage_integrations,
    'active', p_is_active);
  v_replay := crm_private.gpt_receipt_begin(v_ctx.gpt_client_id, p_request_id, 'upsert_artist_membership', v_request);
  if v_replay is not null then return v_replay; end if;
  -- An omitted setting keeps the member's current value (new members get the
  -- CRM defaults), so a role change never silently revokes or re-enables.
  select m.* into v_current from public.artist_memberships m
  where m.profile_id = p_profile_id and m.artist_id = v_ctx.artist_id;
  -- Read-only access holds no capability, so nothing is carried over into it.
  if p_access_level = 'read_only' then
    v_current := jsonb_populate_record(null::public.artist_memberships,
      jsonb_build_object('access_level', 'read_only', 'is_active', v_current.is_active));
  end if;
  return crm_private.gpt_receipt_finish(v_ctx.gpt_client_id, p_request_id, 'upsert_artist_membership', v_request,
    public.upsert_artist_membership(p_profile_id, v_ctx.artist_id, p_access_level::public.artist_access_level,
      coalesce(p_can_view_finance, v_current.can_view_finance, false),
      coalesce(p_can_manage_finance, v_current.can_manage_finance, false),
      coalesce(p_can_manage_sessions, v_current.can_manage_sessions, false),
      coalesce(p_can_manage_integrations, v_current.can_manage_integrations, false),
      coalesce(p_is_active, v_current.is_active, true)));
end;
$$;

create or replace function public.gpt_list_directory_profiles()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_gpt_profile_scope('administration');
  return coalesce((select jsonb_agg(to_jsonb(d)) from public.list_directory_profiles() d), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_list_workspace_team()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_context_workspace('administration', null);
  return coalesce((select jsonb_agg(to_jsonb(t)) from public.list_workspace_team(v_ctx.workspace_id) t), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_upsert_workspace_membership(
  p_request_id uuid,
  p_profile_id uuid,
  p_workspace_role text,
  p_can_manage_workspace boolean default null,
  p_can_manage_team boolean default null,
  p_can_manage_integrations boolean default null,
  p_is_active boolean default null
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_request jsonb; v_replay jsonb; v_current public.workspace_memberships%rowtype;
begin
  select * into v_ctx from crm_private.require_gpt_context_workspace('administration', null);
  v_request := jsonb_build_object('profile_id', p_profile_id, 'workspace_role', p_workspace_role,
    'manage_workspace', p_can_manage_workspace, 'manage_team', p_can_manage_team,
    'manage_integrations', p_can_manage_integrations, 'active', p_is_active);
  v_replay := crm_private.gpt_receipt_begin(v_ctx.gpt_client_id, p_request_id, 'upsert_workspace_membership', v_request);
  if v_replay is not null then return v_replay; end if;
  -- An omitted setting keeps the member's current value (new members get the
  -- CRM defaults), so a role change never silently revokes or re-enables.
  select wm.* into v_current from public.workspace_memberships wm
  where wm.profile_id = p_profile_id and wm.workspace_id = v_ctx.workspace_id;
  return crm_private.gpt_receipt_finish(v_ctx.gpt_client_id, p_request_id, 'upsert_workspace_membership', v_request,
    jsonb_build_object('membership_id', public.upsert_workspace_membership(p_profile_id, v_ctx.workspace_id,
      p_workspace_role::public.workspace_role,
      coalesce(p_can_manage_workspace, v_current.can_manage_workspace, false),
      coalesce(p_can_manage_team, v_current.can_manage_team, false),
      coalesce(p_can_manage_integrations, v_current.can_manage_integrations, false),
      coalesce(p_is_active, v_current.is_active, true))));
end;
$$;

create or replace function public.gpt_list_artist_memberships()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('administration', null);
  return coalesce((select jsonb_agg(to_jsonb(m)) from public.list_artist_memberships(v_ctx.artist_id) m), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_preview_artist_membership(
  p_profile_id uuid,
  p_access_level text,
  p_can_view_finance boolean default false,
  p_can_manage_finance boolean default false,
  p_can_manage_sessions boolean default false,
  p_can_manage_integrations boolean default false
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('administration', null);
  return coalesce((
    select jsonb_agg(to_jsonb(c))
    from public.preview_membership_capabilities(v_ctx.artist_id, p_profile_id,
      p_access_level::public.artist_access_level, coalesce(p_can_view_finance, false),
      coalesce(p_can_manage_finance, false), coalesce(p_can_manage_sessions, false),
      coalesce(p_can_manage_integrations, false)) c
  ), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_grant_artist_membership(
  p_request_id uuid,
  p_profile_id uuid,
  p_access_level text default null,
  p_can_view_finance boolean default null,
  p_can_manage_finance boolean default null,
  p_can_manage_sessions boolean default null,
  p_can_manage_integrations boolean default null,
  p_is_active boolean default null
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_request jsonb; v_replay jsonb; v_current public.artist_memberships%rowtype;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('administration', null);
  v_request := jsonb_build_object('profile_id', p_profile_id, 'access_level', p_access_level,
    'view_finance', p_can_view_finance, 'manage_finance', p_can_manage_finance,
    'manage_sessions', p_can_manage_sessions, 'manage_integrations', p_can_manage_integrations,
    'active', p_is_active);
  v_replay := crm_private.gpt_receipt_begin(v_ctx.gpt_client_id, p_request_id, 'grant_artist_membership', v_request);
  if v_replay is not null then return v_replay; end if;
  -- Same rule as gpt_upsert_artist_membership: omitted settings keep the
  -- member's current values; a new member starts as a manager with nothing extra.
  select m.* into v_current from public.artist_memberships m
  where m.profile_id = p_profile_id and m.artist_id = v_ctx.artist_id;
  -- Read-only access holds no capability, so nothing is carried over into it.
  if coalesce(p_access_level, v_current.access_level::text) = 'read_only' then
    v_current := jsonb_populate_record(null::public.artist_memberships,
      jsonb_build_object('access_level', 'read_only', 'is_active', v_current.is_active));
  end if;
  return crm_private.gpt_receipt_finish(v_ctx.gpt_client_id, p_request_id, 'grant_artist_membership', v_request,
    jsonb_build_object('membership_id', public.grant_workspace_artist_membership(p_profile_id, v_ctx.artist_id,
      coalesce(p_access_level::public.artist_access_level, v_current.access_level, 'manager'),
      coalesce(p_can_view_finance, v_current.can_view_finance, false),
      coalesce(p_can_manage_finance, v_current.can_manage_finance, false),
      coalesce(p_can_manage_sessions, v_current.can_manage_sessions, false),
      coalesce(p_can_manage_integrations, v_current.can_manage_integrations, false),
      coalesce(p_is_active, v_current.is_active, true))));
end;
$$;

create or replace function public.gpt_seat_artist_owner(p_request_id uuid, p_profile_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_request jsonb; v_replay jsonb;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('administration', null);
  v_request := jsonb_build_object('profile_id', p_profile_id);
  v_replay := crm_private.gpt_receipt_begin(v_ctx.gpt_client_id, p_request_id, 'seat_artist_owner', v_request);
  if v_replay is not null then return v_replay; end if;
  return crm_private.gpt_receipt_finish(v_ctx.gpt_client_id, p_request_id, 'seat_artist_owner', v_request,
    jsonb_build_object('membership_id', public.seat_artist_owner(p_profile_id, v_ctx.artist_id)));
end;
$$;

-- ================================================================== Workspace

create or replace function public.gpt_list_workspaces()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_gpt_profile_scope('administration');
  return coalesce((select jsonb_agg(to_jsonb(w)) from public.list_workspaces() w), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_create_workspace(
  p_request_id uuid,
  p_display_name text,
  p_workspace_type text default 'studio',
  p_slug text default null,
  p_timezone text default 'Europe/London',
  p_default_currency text default 'GBP'
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_client_id uuid; v_request jsonb; v_replay jsonb;
begin
  v_client_id := crm_private.require_gpt_profile_scope('administration');
  v_request := jsonb_build_object('display_name', p_display_name, 'type', coalesce(p_workspace_type, 'studio'),
    'slug', p_slug, 'timezone', coalesce(p_timezone, 'Europe/London'), 'currency', coalesce(p_default_currency, 'GBP'));
  v_replay := crm_private.gpt_receipt_begin(v_client_id, p_request_id, 'create_workspace', v_request);
  if v_replay is not null then return v_replay; end if;
  return crm_private.gpt_receipt_finish(v_client_id, p_request_id, 'create_workspace', v_request,
    jsonb_build_object('workspace_id', public.create_workspace(p_display_name,
      coalesce(p_workspace_type, 'studio')::public.workspace_type, p_slug,
      coalesce(p_timezone, 'Europe/London'), coalesce(p_default_currency, 'GBP'))));
end;
$$;

create or replace function public.gpt_update_workspace(
  p_request_id uuid,
  p_display_name text default null,
  p_timezone text default null,
  p_default_currency text default null,
  p_is_active boolean default null
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_request jsonb; v_replay jsonb;
begin
  select * into v_ctx from crm_private.require_gpt_context_workspace('administration', null);
  v_request := jsonb_build_object('display_name', p_display_name, 'timezone', p_timezone,
    'currency', p_default_currency, 'active', p_is_active);
  v_replay := crm_private.gpt_receipt_begin(v_ctx.gpt_client_id, p_request_id, 'update_workspace', v_request);
  if v_replay is not null then return v_replay; end if;
  return crm_private.gpt_receipt_finish(v_ctx.gpt_client_id, p_request_id, 'update_workspace', v_request,
    jsonb_build_object('updated', public.update_workspace(v_ctx.workspace_id, p_display_name, p_timezone,
      p_default_currency, p_is_active)));
end;
$$;

create or replace function public.gpt_list_workspace_artists()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_context_workspace('administration', null);
  return coalesce((select jsonb_agg(to_jsonb(a)) from public.list_workspace_artists(v_ctx.workspace_id) a), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_get_artist_control_plane_context()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('administration', null);
  return coalesce((select to_jsonb(c) from public.artist_control_plane_context(v_ctx.artist_id) c limit 1), '{}'::jsonb);
end;
$$;

create or replace function public.gpt_create_artist(
  p_request_id uuid,
  p_display_name text,
  p_slug text default null,
  p_timezone text default null,
  p_default_currency text default null,
  p_booking_reference_prefix text default null
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_request jsonb; v_replay jsonb;
begin
  select * into v_ctx from crm_private.require_gpt_context_workspace('administration', null);
  v_request := jsonb_build_object('display_name', p_display_name, 'slug', p_slug, 'timezone', p_timezone,
    'currency', p_default_currency, 'prefix', p_booking_reference_prefix);
  v_replay := crm_private.gpt_receipt_begin(v_ctx.gpt_client_id, p_request_id, 'create_artist', v_request);
  if v_replay is not null then return v_replay; end if;
  return crm_private.gpt_receipt_finish(v_ctx.gpt_client_id, p_request_id, 'create_artist', v_request,
    jsonb_build_object('artist_id', public.create_artist(v_ctx.workspace_id, p_display_name, p_slug, p_timezone,
      p_default_currency, p_booking_reference_prefix)));
end;
$$;

create or replace function public.gpt_update_artist(
  p_request_id uuid,
  p_display_name text default null,
  p_timezone text default null,
  p_default_currency text default null,
  p_is_active boolean default null
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record; v_request jsonb; v_replay jsonb;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('administration', null);
  v_request := jsonb_build_object('display_name', p_display_name, 'timezone', p_timezone,
    'currency', p_default_currency, 'active', p_is_active);
  v_replay := crm_private.gpt_receipt_begin(v_ctx.gpt_client_id, p_request_id, 'update_artist', v_request);
  if v_replay is not null then return v_replay; end if;
  return crm_private.gpt_receipt_finish(v_ctx.gpt_client_id, p_request_id, 'update_artist', v_request,
    jsonb_build_object('updated', public.update_artist(v_ctx.artist_id, p_display_name, p_timezone,
      p_default_currency, p_is_active)));
end;
$$;

create or replace function public.gpt_get_artist_onboarding_state()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('administration', null);
  return coalesce((
    select jsonb_agg(to_jsonb(s) order by s.sort_order) from public.artist_onboarding_state(v_ctx.artist_id) s
  ), '[]'::jsonb);
end;
$$;

create or replace function public.gpt_get_tenant_invite_policy()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, crm_private
as $$
declare v_ctx record;
begin
  select * into v_ctx from crm_private.require_gpt_domain_context('administration', null);
  return public.tenant_invite_policy(v_ctx.artist_id);
end;
$$;

-- --------------------------------------------------------------------- grants

do $$
declare v_signature text;
begin
  foreach v_signature in array array[
    'public.gpt_list_team_profiles()',
    'public.gpt_set_team_profile_role(uuid,uuid,text)',
    'public.gpt_set_team_profile_active(uuid,uuid,boolean)',
    'public.gpt_list_team_memberships()',
    'public.gpt_upsert_artist_membership(uuid,uuid,text,boolean,boolean,boolean,boolean,boolean)',
    'public.gpt_list_directory_profiles()',
    'public.gpt_list_workspace_team()',
    'public.gpt_upsert_workspace_membership(uuid,uuid,text,boolean,boolean,boolean,boolean)',
    'public.gpt_list_artist_memberships()',
    'public.gpt_preview_artist_membership(uuid,text,boolean,boolean,boolean,boolean)',
    'public.gpt_grant_artist_membership(uuid,uuid,text,boolean,boolean,boolean,boolean,boolean)',
    'public.gpt_seat_artist_owner(uuid,uuid)',
    'public.gpt_list_workspaces()',
    'public.gpt_create_workspace(uuid,text,text,text,text,text)',
    'public.gpt_update_workspace(uuid,text,text,text,boolean)',
    'public.gpt_list_workspace_artists()',
    'public.gpt_get_artist_control_plane_context()',
    'public.gpt_create_artist(uuid,text,text,text,text,text)',
    'public.gpt_update_artist(uuid,text,text,text,boolean)',
    'public.gpt_get_artist_onboarding_state()',
    'public.gpt_get_tenant_invite_policy()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;
