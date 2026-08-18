-- 0062_record_archival.sql
--
-- Add narrow owner-only archival workflows for erroneous enquiries and clients.
-- The CRM presents these as delete actions, but records are retained for audit,
-- linked history, Storage reconciliation and recovery. Working lists already
-- exclude archived rows.
--
-- Forward-only.

create or replace function public.archive_enquiry(p_enquiry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_enquiry public.enquiries%rowtype;
begin
  if not public.is_owner() then
    raise exception 'owner access required' using errcode = '42501';
  end if;

  if p_enquiry_id is null then
    raise exception 'enquiry is required' using errcode = '22023';
  end if;

  select e.* into v_enquiry
  from public.enquiries e
  where e.id = p_enquiry_id
  for update;

  if not found then
    raise exception 'enquiry % does not exist', p_enquiry_id using errcode = '23503';
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
    raise exception 'enquiry has an active project and cannot be archived' using errcode = '55000';
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
end;
$$;

revoke all on function public.archive_enquiry(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.archive_enquiry(uuid)
  to authenticated;

comment on function public.archive_enquiry(uuid) is
  'Owner-only soft deletion for erroneous enquiries. Active project sources cannot be archived; the row is retained and the action is audited.';

create or replace function public.archive_client(p_client_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_client public.clients%rowtype;
  v_archived_enquiries integer := 0;
begin
  if not public.is_owner() then
    raise exception 'owner access required' using errcode = '42501';
  end if;

  if p_client_id is null then
    raise exception 'client is required' using errcode = '22023';
  end if;

  select c.* into v_client
  from public.clients c
  where c.id = p_client_id
  for update;

  if not found then
    raise exception 'client % does not exist', p_client_id using errcode = '23503';
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
    raise exception 'client has an active project and cannot be archived' using errcode = '55000';
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
end;
$$;

revoke all on function public.archive_client(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.archive_client(uuid)
  to authenticated;

comment on function public.archive_client(uuid) is
  'Owner-only soft deletion for erroneous clients. Unconverted enquiries are archived with the client; active projects block archival. Records remain retained for history and recovery.';
