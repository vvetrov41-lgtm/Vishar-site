-- Phase 4: create standalone projects and manage their archive lifecycle.
-- No existing customer, finance, session, or enquiry rows are rewritten.
-- Production changes occur only through the normal migration release gate.

create function public.create_client_project(
  p_project_id uuid,
  p_client_id uuid,
  p_artist_id uuid,
  p_title text,
  p_description text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client public.clients%rowtype;
  v_existing public.projects%rowtype;
  v_workspace_id uuid;
  v_title text := btrim(coalesce(p_title, ''));
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
begin
  if p_project_id is null or p_client_id is null or p_artist_id is null
     or length(v_title) < 2 or length(v_title) > 160
     or length(coalesce(v_description, '')) > 4000 then
    raise exception 'valid project id, client, artist and title (2-160 chars) are required'
      using errcode = '22023';
  end if;

  perform crm_private.require_artist_access(p_artist_id, 'manage');

  select a.workspace_id into v_workspace_id
  from public.artists a
  where a.id = p_artist_id and a.is_active;
  if v_workspace_id is null then
    raise exception 'artist is unavailable' using errcode = '23503';
  end if;

  -- Serialise retries through the existing client row. This also prevents
  -- two writes racing a client archival or creating a cross-workspace link.
  select c.* into v_client
  from public.clients c
  where c.id = p_client_id
  for update;
  if not found then
    raise exception 'client is unavailable' using errcode = '23503';
  end if;
  if v_client.archived_at is not null then
    raise exception 'archived clients cannot receive a new project' using errcode = '55000';
  end if;
  if v_client.workspace_id is distinct from v_workspace_id then
    raise exception 'client belongs to a different workspace' using errcode = '23514';
  end if;

  select p.* into v_existing
  from public.projects p
  where p.id = p_project_id
  for update;
  if found then
    if v_existing.client_id is distinct from p_client_id
       or v_existing.artist_id is distinct from p_artist_id
       or v_existing.enquiry_id is not null
       or v_existing.title is distinct from v_title
       or v_existing.description is distinct from v_description
       or v_existing.archived_at is not null then
      raise exception 'project request id was already used for different work'
        using errcode = '23514';
    end if;
    return jsonb_build_object(
      'project_id', p_project_id, 'created', false
    );
  end if;

  -- No enquiry is invented; the existing link guard checks workspace again.
  insert into public.projects (
    id, artist_id, client_id, enquiry_id, title, description, status
  ) values (
    p_project_id, p_artist_id, p_client_id, null, v_title, v_description, 'draft'
  );

  perform crm_private.log_artist_activity(
    p_artist_id,
    'project.created',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    p_client_id,
    null,
    p_project_id,
    null,
    null,
    jsonb_build_object('source', 'client_card')
  );

  return jsonb_build_object('project_id', p_project_id, 'created', true);
end;
$$;

revoke all on function public.create_client_project(uuid,uuid,uuid,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_client_project(uuid,uuid,uuid,text,text)
  to authenticated;

comment on function public.create_client_project(uuid,uuid,uuid,text,text) is
  'Artist-scoped creation of a standalone project for a known, active workspace client. Caller-supplied project UUID is the idempotency key; replay cannot change its client or content.';


create function public.update_project_description(
  p_project_id uuid,
  p_description text,
  p_expected_description text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_project public.projects%rowtype;
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
begin
  if p_project_id is null or length(coalesce(v_description, '')) > 4000 then
    raise exception 'valid project and description up to 4000 characters required'
      using errcode = '22023';
  end if;

  select p.* into v_project
  from public.projects p
  where p.id = p_project_id and p.archived_at is null
  for update;
  if not found then
    raise exception 'active project not found' using errcode = '23503';
  end if;
  perform crm_private.require_artist_access(v_project.artist_id, 'manage');

  -- A replay after a lost response is a no-op. A concurrent different edit
  -- refuses to overwrite what another operator just saved.
  if v_project.description is not distinct from v_description then
    return jsonb_build_object('project_id', p_project_id, 'changed', false);
  end if;
  if v_project.description is distinct from p_expected_description then
    raise exception 'project changed since it was opened'
      using errcode = '40001', hint = 'PROJECT_EDIT_CONFLICT';
  end if;

  update public.projects
  set description = v_description
  where id = p_project_id;

  perform crm_private.log_artist_activity(
    v_project.artist_id,
    'project.description_changed',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_project.client_id, v_project.enquiry_id, p_project_id,
    null, null,
    jsonb_build_object('description_changed', true)
  );
  return jsonb_build_object('project_id', p_project_id, 'changed', true);
end;
$$;

revoke all on function public.update_project_description(uuid,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.update_project_description(uuid,text,text)
  to authenticated;

comment on function public.update_project_description(uuid,text,text) is
  'Optimistic, artist-scoped project description edit. Archived projects are immutable; mismatched expected content refuses with PROJECT_EDIT_CONFLICT.';


create function public.set_project_archive_state(
  p_project_id uuid,
  p_archived boolean
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_project public.projects%rowtype;
begin
  if p_project_id is null or p_archived is null then
    raise exception 'project and archive state are required' using errcode = '22023';
  end if;

  select p.* into v_project
  from public.projects p where p.id = p_project_id
  for update;
  if not found then
    raise exception 'project not found' using errcode = '23503';
  end if;

  perform crm_private.require_artist_access(v_project.artist_id, 'manage');
  if not public.is_owner() then
    raise exception 'only the CRM owner may archive or restore projects'
      using errcode = '42501';
  end if;

  if (v_project.archived_at is not null) = p_archived then
    return jsonb_build_object(
      'project_id', p_project_id, 'archived', p_archived, 'changed', false
    );
  end if;

  if p_archived then
    if v_project.status not in ('completed', 'cancelled') then
      raise exception 'complete or cancel the project before archiving'
        using errcode = '55000', hint = 'PROJECT_NOT_FINISHED';
    end if;
    if exists (
      select 1 from public.sessions s
      where s.project_id = p_project_id
        and s.cancelled_at is null
        and s.status in ('draft', 'proposed', 'confirmed')
    ) then
      raise exception 'unfinished appointments block project archiving'
        using errcode = '55000', hint = 'PROJECT_HAS_OPEN_APPOINTMENTS';
    end if;
  else
    if not exists (
      select 1 from public.clients c
      where c.id = v_project.client_id and c.archived_at is null
    ) then
      raise exception 'restore the client before the project'
        using errcode = '55000';
    end if;
  end if;

  -- Only the soft archive flag changes. Visits, messages, deposits, finance
  -- and source enquiries are deliberately untouched.
  update public.projects p
  set archived_at = case when p_archived then clock_timestamp() else null end
  where p.id = p_project_id;

  perform crm_private.log_artist_activity(
    v_project.artist_id,
    case when p_archived then 'project.archived' else 'project.restored' end,
    'owner',
    auth.uid(),
    v_project.client_id, v_project.enquiry_id, p_project_id,
    null, null,
    jsonb_build_object('status', v_project.status)
  );

  return jsonb_build_object(
    'project_id', p_project_id, 'archived', p_archived, 'changed', true
  );
end;
$$;

revoke all on function public.set_project_archive_state(uuid,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_project_archive_state(uuid,boolean)
  to authenticated;

comment on function public.set_project_archive_state(uuid,boolean) is
  'Owner-only audited soft archive/restore. Only completed or cancelled projects without open appointments may be archived; no related records are modified.';
