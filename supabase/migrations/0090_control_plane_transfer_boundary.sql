-- 0090_control_plane_transfer_boundary.sql
--
-- Final hardening from the second independent review of the control plane.
--
-- Migration 0089 made workspace owners immutable through ordinary team
-- management and introduced a deliberate ownership-transfer RPC. Its normal
-- path was correct, but it also admitted the legacy installation-wide owner as
-- a bypass. When that caller did not itself own the workspace, the function
-- promoted the recipient, demoted nobody, and logged the installation owner as
-- `from_profile_id`. That was not a transfer and made the audit record false.
--
-- The rule is narrower and easier to reason about: this RPC transfers only the
-- caller's own active workspace ownership. Installation-wide authority remains
-- useful for administering the platform, but it is not a substitute for a
-- workspace ownership edge. Exceptional recovery, if it is ever required,
-- belongs in a separately named operator procedure with its own audit meaning.
--
-- Forward-only. No provider call, no deployment, no enqueued work.

create or replace function public.transfer_workspace_ownership(
  p_workspace_id  uuid,
  p_to_profile_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_caller uuid := auth.uid();
  v_caller_is_owner boolean := false;
begin
  if p_workspace_id is null or p_to_profile_id is null then
    raise exception 'a workspace and a recipient are required' using errcode = '22023';
  end if;

  if not exists (
    select 1 from crm_private.workspace_state ws
    where ws.workspace_id = p_workspace_id and ws.is_active
  ) then
    raise exception 'the workspace is unavailable' using errcode = '22023';
  end if;

  -- Lock the caller's membership while deciding whether they may transfer it.
  -- Besides making the authorization fact explicit, this serializes two
  -- concurrent transfer attempts by the same owner: once the first demotes the
  -- caller, the second wakes up and sees that ownership is already gone.
  select wm.workspace_role = 'owner' and wm.is_active
    into v_caller_is_owner
  from public.workspace_memberships wm
  where wm.workspace_id = p_workspace_id
    and wm.profile_id = v_caller
  for update;

  if not coalesce(v_caller_is_owner, false) then
    raise exception 'only a workspace owner transfers ownership' using errcode = '42501';
  end if;

  if p_to_profile_id = v_caller then
    raise exception 'that profile already owns this workspace' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.profiles pr
    where pr.id = p_to_profile_id and pr.is_active
  ) then
    raise exception 'the target profile is not an active CRM user' using errcode = '22023';
  end if;

  -- The recipient must already be in the organization. Ownership is handed to
  -- a colleague, not used as a way to add one.
  if not exists (
    select 1 from public.workspace_memberships wm
    where wm.workspace_id = p_workspace_id
      and wm.profile_id = p_to_profile_id
      and wm.is_active
  ) then
    raise exception 'add this person to the organization before handing them ownership'
      using errcode = '22023';
  end if;

  -- Promote first. Between these statements the workspace has two active
  -- owners, which is safe; the reverse order would momentarily have none and
  -- the last-owner invariant would reject it.
  update public.workspace_memberships
  set workspace_role = 'owner',
      can_manage_workspace = true,
      can_manage_team = true,
      can_manage_integrations = true,
      is_active = true
  where workspace_id = p_workspace_id and profile_id = p_to_profile_id;

  update public.workspace_memberships
  set workspace_role = 'admin'
  where workspace_id = p_workspace_id and profile_id = v_caller;

  perform crm_private.log_lifecycle_event(
    'workspace.ownership_transferred', null,
    jsonb_build_object(
      'workspace_id', p_workspace_id,
      'to_profile_id', p_to_profile_id,
      -- This is now guaranteed to be truthful: the caller was the active
      -- workspace owner whose row was demoted immediately above.
      'from_profile_id', v_caller
    )
  );

  return true;
end;
$$;

comment on function public.transfer_workspace_ownership(uuid, uuid) is
  'Hand the caller''s active workspace ownership to an existing active member. The caller must themselves be a sitting workspace owner; the legacy installation owner is not a bypass. Promotes before demoting so the last-owner invariant is never momentarily violated, leaves the outgoing owner as an admin, and logs a truthful from_profile_id.';

revoke all on function public.transfer_workspace_ownership(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.transfer_workspace_ownership(uuid, uuid) to authenticated;
