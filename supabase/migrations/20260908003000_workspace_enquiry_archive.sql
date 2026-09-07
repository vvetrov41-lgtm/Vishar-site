-- 20260908003000_workspace_enquiry_archive.sql
--
-- "Delete enquiry" is an audited soft-delete. The old wrapper allowed only the
-- legacy global owner role, which means a self-service solo workspace owner
-- (whose profile role is booking_manager) could not clean up their own enquiry.
-- Authorise against the enquiry's artist scope instead.

create or replace function public.update_enquiry_details(
  p_enquiry_id uuid,
  p_enquiry jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry public.enquiries%rowtype;
  v_workspace_id uuid;
  v_actor_kind text;
begin
  if p_enquiry_id is null then
    raise exception 'enquiry id is required' using errcode = '22023';
  end if;
  if p_enquiry is null or jsonb_typeof(p_enquiry) <> 'object' then
    raise exception 'enquiry payload must be an object' using errcode = '22023';
  end if;

  if p_enquiry ? '_archive' then
    if p_enquiry <> jsonb_build_object('_archive', true) then
      raise exception 'enquiry archive payload must contain only _archive=true'
        using errcode = '22023';
    end if;

    select e.* into v_enquiry
    from public.enquiries e
    where e.id = p_enquiry_id
    for update;

    if not found then
      raise exception 'enquiry not found' using errcode = 'P0002';
    end if;

    -- Backward-compatible global owner plus the real tenant-scoped permission.
    if not public.is_owner() and not public.can_manage_artist(v_enquiry.artist_id) then
      raise exception 'enquiry is outside your managed artist scope'
        using errcode = '42501';
    end if;

    if v_enquiry.archived_at is not null then
      return jsonb_build_object(
        'enquiry_id', p_enquiry_id,
        'archived', true,
        'changed', false
      );
    end if;

    if exists (
      select 1
      from public.projects p
      where p.enquiry_id = p_enquiry_id
        and p.archived_at is null
    ) then
      raise exception 'enquiry has an active project and cannot be archived'
        using errcode = '55000', hint = 'ENQUIRY_HAS_ACTIVE_PROJECT';
    end if;

    -- Do not make an upcoming consultation disappear from its source enquiry.
    -- Completed/cancelled history is safe to retain behind an archived enquiry.
    if exists (
      select 1
      from public.sessions s
      where s.enquiry_id = p_enquiry_id
        and s.status in ('draft', 'proposed', 'confirmed')
    ) then
      raise exception 'enquiry has an active appointment and cannot be archived'
        using errcode = '55000', hint = 'ENQUIRY_HAS_ACTIVE_APPOINTMENT';
    end if;

    select a.workspace_id into v_workspace_id
    from public.artists a
    where a.id = v_enquiry.artist_id;

    v_actor_kind := case
      when public.is_owner()
        or crm_private.has_workspace_capability(v_workspace_id, 'manage_workspace')
      then 'owner' else 'staff' end;

    update public.enquiries e
    set archived_at = clock_timestamp(),
        last_action_at = clock_timestamp()
    where e.id = p_enquiry_id;

    perform crm_private.log_artist_activity(
      v_enquiry.artist_id,
      'enquiry.archived',
      v_actor_kind,
      auth.uid(),
      v_enquiry.client_id,
      p_enquiry_id,
      null, null, null,
      jsonb_build_object('reason', 'manual_cleanup')
    );

    return jsonb_build_object(
      'enquiry_id', p_enquiry_id,
      'archived', true,
      'changed', true
    );
  end if;

  return crm_private.update_enquiry_details_core(p_enquiry_id, p_enquiry);
end;
$$;

revoke all on function public.update_enquiry_details(uuid,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.update_enquiry_details(uuid,jsonb)
  to authenticated;

comment on function public.update_enquiry_details(uuid,jsonb) is
  'Canonical enquiry edit RPC. {_archive:true} is an audited soft-delete allowed to users who manage the enquiry artist; active projects or appointments block deletion.';
