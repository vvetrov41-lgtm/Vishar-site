-- 0059_project_status_management.sql
--
-- Add one narrow human CRM workflow for changing a project lifecycle status.
-- Project rows remain non-writable through the browser table endpoint; the
-- authenticated caller is resolved through the existing artist membership
-- boundary and every actual change is appended to the activity log.
--
-- Forward-only.

create or replace function public.set_project_status(
  p_project_id uuid,
  p_status public.project_status
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_project public.projects%rowtype;
begin
  if p_project_id is null or p_status is null then
    raise exception 'project and status are required' using errcode = '22023';
  end if;

  select p.* into v_project
  from public.projects p
  where p.id = p_project_id
    and p.archived_at is null
  for update;

  if not found then
    raise exception 'project % does not exist', p_project_id using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_project.artist_id, 'manage');

  if v_project.status = p_status then
    return jsonb_build_object(
      'project_id', p_project_id,
      'status', p_status,
      'changed', false
    );
  end if;

  update public.projects p
  set status = p_status
  where p.id = p_project_id;

  perform crm_private.log_artist_activity(
    v_project.artist_id,
    'project.status_changed',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_project.client_id,
    v_project.enquiry_id,
    p_project_id,
    null,
    null,
    jsonb_build_object(
      'from_status', v_project.status,
      'to_status', p_status
    )
  );

  return jsonb_build_object(
    'project_id', p_project_id,
    'status', p_status,
    'changed', true
  );
end;
$$;

revoke all on function public.set_project_status(uuid,public.project_status)
  from public, anon, authenticated, service_role;
grant execute on function public.set_project_status(uuid,public.project_status)
  to authenticated;

comment on function public.set_project_status(uuid,public.project_status) is
  'Artist-scoped human CRM project lifecycle update. Direct project table writes remain closed and each actual transition is audited.';
