-- 0062_record_archival.sql
--
-- Add narrow owner-only archival workflows for erroneous enquiries and clients.
-- The CRM presents these as delete actions, but records are retained for audit,
-- linked history, Storage reconciliation and recovery. Working lists already
-- exclude archived rows.
--
-- Keep the authenticated RPC inventory stable: the existing canonical record
-- edit RPCs gain one reserved {_archive:true} command. Their original editing
-- implementations are moved behind closed crm_private helpers.
--
-- Forward-only.

-- ---------------------------------------------------------------------------
-- Preserve the exact 0048 edit implementations as closed internal helpers.
-- ---------------------------------------------------------------------------

alter function public.update_client_details(uuid,jsonb)
  set schema crm_private;
alter function crm_private.update_client_details(uuid,jsonb)
  rename to update_client_details_core;
revoke all on function crm_private.update_client_details_core(uuid,jsonb)
  from public, anon, authenticated, service_role;

alter function public.update_enquiry_details(uuid,jsonb)
  set schema crm_private;
alter function crm_private.update_enquiry_details(uuid,jsonb)
  rename to update_enquiry_details_core;
revoke all on function crm_private.update_enquiry_details_core(uuid,jsonb)
  from public, anon, authenticated, service_role;

comment on function crm_private.update_client_details_core(uuid,jsonb) is
  'Closed 0048 canonical client-edit implementation. Called only through public.update_client_details.';
comment on function crm_private.update_enquiry_details_core(uuid,jsonb) is
  'Closed 0048 enquiry-edit implementation. Called only through public.update_enquiry_details.';

-- ---------------------------------------------------------------------------
-- Canonical client edit + owner-only archival command.
-- ---------------------------------------------------------------------------

create or replace function public.update_client_details(
  p_client_id uuid,
  p_client jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client public.clients%rowtype;
  v_archived_enquiries integer := 0;
begin
  if p_client_id is null then
    raise exception 'client id is required' using errcode = '22023';
  end if;
  if p_client is null or jsonb_typeof(p_client) <> 'object' then
    raise exception 'client payload must be an object' using errcode = '22023';
  end if;

  if p_client ? '_archive' then
    if p_client <> jsonb_build_object('_archive', true) then
      raise exception 'client archive payload must contain only _archive=true'
        using errcode = '22023';
    end if;
    if not public.is_owner() then
      raise exception 'owner access required' using errcode = '42501';
    end if;

    select c.* into v_client
    from public.clients c
    where c.id = p_client_id
    for update;

    if not found then
      raise exception 'client not found' using errcode = 'P0002';
    end if;

    if v_client.archived_at is not null then
      return jsonb_build_object(
        'client_id', p_client_id,
        'archived', true,
        'archived_enquiries', 0,
        'changed', false
      );
    end if;

    if exists (
      select 1
      from public.projects p
      where p.client_id = p_client_id
        and p.archived_at is null
    ) then
      raise exception 'client has an active project and cannot be archived'
        using errcode = '55000';
    end if;

    update public.enquiries e
    set archived_at = clock_timestamp(),
        last_action_at = clock_timestamp()
    where e.client_id = p_client_id
      and e.archived_at is null;
    get diagnostics v_archived_enquiries = row_count;

    update public.clients c
    set archived_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where c.id = p_client_id;

    perform crm_private.log_activity(
      'client.archived',
      'owner',
      auth.uid(),
      p_client_id,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      jsonb_build_object(
        'reason', 'manual_cleanup',
        'archived_enquiries', v_archived_enquiries
      )
    );

    return jsonb_build_object(
      'client_id', p_client_id,
      'archived', true,
      'archived_enquiries', v_archived_enquiries,
      'changed', true
    );
  end if;

  return crm_private.update_client_details_core(p_client_id, p_client);
end;
$$;

revoke all on function public.update_client_details(uuid,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.update_client_details(uuid,jsonb)
  to authenticated;

comment on function public.update_client_details(uuid,jsonb) is
  'Canonical client edit RPC. Owner-only {_archive:true} performs audited soft deletion and archives unconverted enquiries; active projects block archival.';

-- ---------------------------------------------------------------------------
-- Canonical enquiry edit + owner-only archival command.
-- ---------------------------------------------------------------------------

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
    if not public.is_owner() then
      raise exception 'owner access required' using errcode = '42501';
    end if;

    select e.* into v_enquiry
    from public.enquiries e
    where e.id = p_enquiry_id
    for update;

    if not found then
      raise exception 'enquiry not found' using errcode = 'P0002';
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
        using errcode = '55000';
    end if;

    update public.enquiries e
    set archived_at = clock_timestamp(),
        last_action_at = clock_timestamp()
    where e.id = p_enquiry_id;

    perform crm_private.log_artist_activity(
      v_enquiry.artist_id,
      'enquiry.archived',
      'owner',
      auth.uid(),
      v_enquiry.client_id,
      p_enquiry_id,
      null,
      null,
      null,
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
  'Mutable enquiry-detail edit RPC. Owner-only {_archive:true} performs audited soft deletion; an active linked project blocks archival.';
