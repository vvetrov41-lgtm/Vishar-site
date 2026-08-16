-- 0055_gpt_full_crm_completion.sql
--
-- Complete the bounded operational surface introduced by 0054 with the daily
-- CRM operations that otherwise require the human UI: manual enquiry creation,
-- project copy editing, follow-up cancellation, full appointment detail and a
-- metadata-minimised artist activity view.

create or replace function public.gpt_create_manual_enquiry(
  p_idempotency_key uuid,
  p_client jsonb,
  p_enquiry jsonb,
  p_privacy_acknowledged boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;

  return public.create_manual_enquiry(
    p_idempotency_key,
    v_artist_id,
    p_client,
    p_enquiry,
    p_privacy_acknowledged
  );
end;
$$;

create or replace function public.gpt_update_project_details(
  p_project_id uuid,
  p_title text default null,
  p_description text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_project public.projects%rowtype;
  v_title text;
  v_description text;
  v_changed text[] := '{}'::text[];
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;

  select p.* into v_project
  from public.projects p
  where p.id = p_project_id
    and p.archived_at is null
  for update;

  if not found or v_project.artist_id <> v_artist_id then
    raise exception 'project is outside this GPT artist scope' using errcode = '42501';
  end if;

  v_title := case when p_title is null then v_project.title
    else left(btrim(p_title), 200) end;
  v_description := case when p_description is null then v_project.description
    else left(nullif(btrim(p_description), ''), 4000) end;

  if v_title = '' then
    raise exception 'project title is required' using errcode = '22023';
  end if;

  if v_title is distinct from v_project.title then
    v_changed := array_append(v_changed, 'title');
  end if;
  if v_description is distinct from v_project.description then
    v_changed := array_append(v_changed, 'description');
  end if;

  if cardinality(v_changed) > 0 then
    update public.projects p
    set title = v_title,
        description = v_description
    where p.id = p_project_id;

    perform crm_private.log_artist_activity(
      v_artist_id,
      'project.updated',
      case when public.is_owner() then 'owner' else 'staff' end,
      auth.uid(),
      v_project.client_id,
      v_project.enquiry_id,
      p_project_id,
      null,
      null,
      jsonb_build_object('changed_fields', to_jsonb(v_changed))
    );
  end if;

  return jsonb_build_object(
    'project_id', p_project_id,
    'changed_fields', to_jsonb(v_changed)
  );
end;
$$;

create or replace function public.gpt_cancel_follow_up(p_follow_up_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_follow_up public.follow_ups%rowtype;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;

  select f.* into v_follow_up
  from public.follow_ups f
  where f.id = p_follow_up_id
  for update;

  if not found or v_follow_up.artist_id <> v_artist_id then
    raise exception 'follow-up is outside this GPT artist scope' using errcode = '42501';
  end if;

  if v_follow_up.status = 'cancelled' then
    return jsonb_build_object('follow_up_id', p_follow_up_id, 'status', 'cancelled', 'changed', false);
  end if;
  if v_follow_up.status = 'done' then
    raise exception 'a completed follow-up cannot be cancelled' using errcode = '42501';
  end if;

  update public.follow_ups f
  set status = 'cancelled',
      cancelled_at = now(),
      updated_at = now()
  where f.id = p_follow_up_id;

  perform crm_private.log_artist_activity(
    v_artist_id,
    'follow_up.cancelled',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    v_follow_up.client_id,
    v_follow_up.enquiry_id,
    v_follow_up.project_id,
    null,
    null,
    jsonb_build_object('follow_up_id', p_follow_up_id)
  );

  return jsonb_build_object('follow_up_id', p_follow_up_id, 'status', 'cancelled', 'changed', true);
end;
$$;

create or replace function public.gpt_get_appointment_full(p_appointment_id uuid)
returns table (
  appointment_id uuid,
  appointment_type public.appointment_type,
  status public.session_status,
  start_at timestamptz,
  end_at timestamptz,
  calendar_version integer,
  calendar_sync_status public.calendar_sync_status,
  client_id uuid,
  client_name text,
  enquiry_id uuid,
  project_id uuid,
  notes text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;

  return query
  select s.id, s.appointment_type, s.status, s.start_at, s.end_at,
         s.calendar_version, s.calendar_sync_status, s.client_id, c.full_name,
         s.enquiry_id, s.project_id, s.notes, s.created_at, s.updated_at
  from public.sessions s
  join public.clients c on c.id = s.client_id
  where s.id = p_appointment_id and s.artist_id = v_artist_id;
end;
$$;

create or replace function public.gpt_list_activity(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit integer default 30
)
returns table (
  activity_id uuid,
  occurred_at timestamptz,
  event_type text,
  actor_kind text,
  actor_name text,
  client_id uuid,
  enquiry_id uuid,
  project_id uuid,
  session_id uuid
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_artist_id uuid;
  v_limit integer;
begin
  select c.artist_id into v_artist_id
  from crm_private.require_gpt_operational_context('crm') c;

  if p_from is not null and p_to is not null and p_to <= p_from then
    raise exception 'activity range end must be after its start' using errcode = '22023';
  end if;
  if p_from is not null and p_to is not null and p_to - p_from > interval '366 days' then
    raise exception 'activity range may not exceed 366 days' using errcode = '22023';
  end if;
  v_limit := least(greatest(coalesce(p_limit, 30), 1), 50);

  return query
  select a.id, a.occurred_at, a.event_type, a.actor_kind, p.display_name,
         a.client_id, a.enquiry_id, a.project_id, a.session_id
  from public.activity_log a
  left join public.profiles p on p.id = a.actor_profile_id
  where a.artist_id = v_artist_id
    and (p_from is null or a.occurred_at >= p_from)
    and (p_to is null or a.occurred_at < p_to)
  order by a.occurred_at desc, a.id
  limit v_limit;
end;
$$;

revoke all on function public.gpt_create_manual_enquiry(uuid,jsonb,jsonb,boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_update_project_details(uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_cancel_follow_up(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_get_appointment_full(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.gpt_list_activity(timestamptz,timestamptz,integer)
  from public, anon, authenticated, service_role;

grant execute on function public.gpt_create_manual_enquiry(uuid,jsonb,jsonb,boolean)
  to authenticated;
grant execute on function public.gpt_update_project_details(uuid,text,text)
  to authenticated;
grant execute on function public.gpt_cancel_follow_up(uuid)
  to authenticated;
grant execute on function public.gpt_get_appointment_full(uuid)
  to authenticated;
grant execute on function public.gpt_list_activity(timestamptz,timestamptz,integer)
  to authenticated;
