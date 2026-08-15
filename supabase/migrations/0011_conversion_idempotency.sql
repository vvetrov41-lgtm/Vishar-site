-- 0011_conversion_idempotency.sql
--
-- Give enquiry conversion an explicit retry contract. The enquiry row remains
-- the serialisation point, the unique projects.enquiry_id constraint remains
-- defence in depth, and an exact retry never creates a second project or
-- activity event.
--
-- Forward-only.

create or replace function public.convert_enquiry_to_project(
  p_enquiry_id uuid,
  p_title      text,
  p_description text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_role                 public.crm_role;
  v_client_id            uuid;
  v_state                public.enquiry_intake_state;
  v_status               public.enquiry_status;
  v_owner_only           boolean;
  v_project_id           uuid;
  v_existing_title       text;
  v_existing_description text;
  v_title                text;
begin
  v_role := crm_private.require_role('owner', 'booking_manager');
  v_title := left(btrim(p_title), 200);

  if v_title is null or v_title = '' then
    raise exception 'project title is required' using errcode = '22023';
  end if;

  select e.client_id, e.intake_state, e.status
    into v_client_id, v_state, v_status
  from public.enquiries e
  where e.id = p_enquiry_id
  for update;

  if v_client_id is null then
    raise exception 'enquiry % does not exist', p_enquiry_id using errcode = '23503';
  end if;

  if v_state <> 'complete' then
    raise exception 'enquiry % has not completed intake', p_enquiry_id using errcode = '22023';
  end if;

  select p.id, p.title, p.description
    into v_project_id, v_existing_title, v_existing_description
  from public.projects p
  where p.enquiry_id = p_enquiry_id;

  if found then
    if v_status <> 'converted' then
      raise exception 'enquiry % has a project but status is %', p_enquiry_id, v_status
        using errcode = '55000';
    end if;

    if v_existing_title is distinct from v_title
       or v_existing_description is distinct from p_description then
      raise exception 'enquiry % was already converted with different project details', p_enquiry_id
        using errcode = '22023';
    end if;

    return jsonb_build_object(
      'project_id', v_project_id,
      'enquiry_id', p_enquiry_id,
      'client_id', v_client_id,
      'replayed', true
    );
  end if;

  if v_status = 'converted' then
    raise exception 'enquiry % is converted but has no project', p_enquiry_id
      using errcode = '55000';
  end if;

  select t.owner_only into v_owner_only
  from public.enquiry_status_transitions t
  where t.from_status = v_status and t.to_status = 'converted';

  if v_owner_only is null then
    raise exception 'transition % -> converted is not allowed', v_status
      using errcode = '42501';
  end if;

  if v_owner_only and v_role <> 'owner' then
    raise exception 'transition % -> converted is owner only', v_status
      using errcode = '42501';
  end if;

  insert into public.projects (client_id, enquiry_id, status, title, description)
  values (v_client_id, p_enquiry_id, 'draft', v_title, p_description)
  returning id into v_project_id;

  update public.enquiries e set status = 'converted' where e.id = p_enquiry_id;

  perform crm_private.log_activity(
    'enquiry.converted',
    case when v_role = 'owner' then 'owner' else 'staff' end,
    auth.uid(), v_client_id, p_enquiry_id, v_project_id, null, null, null, null, null,
    '{}'::jsonb
  );

  return jsonb_build_object(
    'project_id', v_project_id,
    'enquiry_id', p_enquiry_id,
    'client_id', v_client_id,
    'replayed', false
  );
end;
$$;

comment on function public.convert_enquiry_to_project(uuid, text, text) is
  'Converts one complete accepted/deposit-paid enquiry to one project. An exact title/description retry returns that project with replayed=true; changed retry details fail with SQLSTATE 22023.';
