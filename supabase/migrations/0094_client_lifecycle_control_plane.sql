-- 0094_client_lifecycle_control_plane.sql
--
-- Human-facing control plane for the client lifecycle engine added in 0093.
--
-- This migration deliberately does not alter the legacy create/list automation
-- RPC contracts. Existing artist-team rules keep their stable API while client
-- lifecycle policy gets explicit, typed entry points.
--
-- Applying this migration creates no rule, template or provider binding. Every
-- newly-created lifecycle rule/default starts disabled unless an authorized
-- caller explicitly asks otherwise.

-- ---------------------------------------------------------------------------
-- 1. Artist lifecycle rules
-- ---------------------------------------------------------------------------

create or replace function public.create_client_lifecycle_rule(
  p_artist_id uuid,
  p_name text,
  p_appointment_type public.appointment_type,
  p_message_purpose text,
  p_schedule_anchor public.automation_schedule_anchor,
  p_anchor_offset_minutes integer,
  p_locale text default 'en'
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_automations');
  perform crm_private.require_active_artist(p_artist_id);

  insert into public.automation_rules (
    artist_id,
    name,
    trigger_event_type,
    condition_from_status,
    condition_to_status,
    delay_minutes,
    action_type,
    action_title,
    action_body,
    action_priority,
    schedule_anchor,
    anchor_offset_minutes,
    condition_appointment_type,
    message_purpose,
    message_channel,
    message_locale,
    is_enabled,
    created_by
  ) values (
    p_artist_id,
    btrim(p_name),
    'appointment.scheduled',
    null,
    null,
    0,
    'send_client_message',
    'Client lifecycle email',
    null,
    'normal',
    p_schedule_anchor,
    p_anchor_offset_minutes,
    p_appointment_type,
    p_message_purpose,
    'email',
    coalesce(p_locale, 'en'),
    false,
    auth.uid()
  )
  returning id into v_id;

  perform crm_private.log_artist_activity(
    p_artist_id,
    'automation.rule_created',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    null, null, null, null, null,
    jsonb_build_object(
      'action_type', 'send_client_message',
      'appointment_type', p_appointment_type,
      'message_purpose', p_message_purpose,
      'schedule_anchor', p_schedule_anchor,
      'anchor_offset_minutes', p_anchor_offset_minutes
    )
  );

  return v_id;
end;
$$;

create or replace function public.list_client_lifecycle_rules(
  p_artist_id uuid default null
)
returns table (
  id                         uuid,
  artist_id                  uuid,
  name                       text,
  appointment_type           public.appointment_type,
  message_purpose            text,
  message_channel            public.message_template_channel,
  message_locale             text,
  schedule_anchor            public.automation_schedule_anchor,
  anchor_offset_minutes      integer,
  is_enabled                 boolean,
  version                    integer,
  workspace_default_id       uuid,
  workspace_default_version  integer,
  workspace_override         boolean,
  created_at                 timestamptz,
  updated_at                 timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select
    r.id,
    r.artist_id,
    r.name,
    r.condition_appointment_type,
    r.message_purpose,
    r.message_channel,
    r.message_locale,
    r.schedule_anchor,
    r.anchor_offset_minutes,
    r.is_enabled,
    r.version,
    r.workspace_default_id,
    r.workspace_default_version,
    r.workspace_override,
    r.created_at,
    r.updated_at
  from public.automation_rules r
  where public.is_active_user()
    and r.action_type = 'send_client_message'::public.automation_action_type
    and (p_artist_id is null or r.artist_id = p_artist_id)
    and crm_private.has_artist_capability(r.artist_id, 'view_automations')
  order by r.created_at, r.id;
$$;

-- ---------------------------------------------------------------------------
-- 2. Workspace lifecycle blueprints
--
-- Like the generic 0083 defaults, these expand at write time into explicit
-- artist rules. They do not create runtime inheritance or ambient workspace
-- authority in the scheduler.
-- ---------------------------------------------------------------------------

create or replace function public.upsert_workspace_client_lifecycle_default(
  p_workspace_id uuid,
  p_default_id uuid,
  p_name text,
  p_appointment_type public.appointment_type,
  p_message_purpose text,
  p_schedule_anchor public.automation_schedule_anchor,
  p_anchor_offset_minutes integer,
  p_locale text default 'en',
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
    select 1
    from crm_private.workspace_state w
    where w.workspace_id = p_workspace_id
      and w.is_active
  ) then
    raise exception 'the workspace is unavailable' using errcode = '22023';
  end if;

  -- A workspace policy is never silently applied to only the subset of artists
  -- the caller happens to manage. Either every active artist is authorized or
  -- the entire write fails closed.
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
      workspace_id,
      name,
      trigger_event_type,
      condition_from_status,
      condition_to_status,
      delay_minutes,
      action_type,
      action_title,
      action_body,
      action_priority,
      schedule_anchor,
      anchor_offset_minutes,
      condition_appointment_type,
      message_purpose,
      message_channel,
      message_locale,
      is_enabled,
      created_by
    ) values (
      p_workspace_id,
      btrim(p_name),
      'appointment.scheduled',
      null,
      null,
      0,
      'send_client_message',
      'Client lifecycle email',
      null,
      'normal',
      p_schedule_anchor,
      p_anchor_offset_minutes,
      p_appointment_type,
      p_message_purpose,
      'email',
      coalesce(p_locale, 'en'),
      coalesce(p_is_enabled, false),
      auth.uid()
    )
    returning id into v_id;
  else
    update public.workspace_automation_defaults d
    set name = btrim(p_name),
        trigger_event_type = 'appointment.scheduled',
        condition_from_status = null,
        condition_to_status = null,
        delay_minutes = 0,
        action_type = 'send_client_message',
        action_title = 'Client lifecycle email',
        action_body = null,
        action_priority = 'normal',
        schedule_anchor = p_schedule_anchor,
        anchor_offset_minutes = p_anchor_offset_minutes,
        condition_appointment_type = p_appointment_type,
        message_purpose = p_message_purpose,
        message_channel = 'email',
        message_locale = coalesce(p_locale, 'en'),
        is_enabled = coalesce(p_is_enabled, false)
    where d.id = p_default_id
      and d.workspace_id = p_workspace_id
      and d.action_type = 'send_client_message'::public.automation_action_type
    returning d.id into v_id;

    if v_id is null then
      raise exception 'the workspace client lifecycle default is unavailable'
        using errcode = '22023';
    end if;
  end if;

  for v_artist in
    select a.id
    from public.artists a
    where a.workspace_id = p_workspace_id
      and a.is_active
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
    jsonb_build_object(
      'workspace_id', p_workspace_id,
      'default_id', v_id,
      'action_type', 'send_client_message',
      'appointment_type', p_appointment_type,
      'message_purpose', p_message_purpose,
      'schedule_anchor', p_schedule_anchor,
      'anchor_offset_minutes', p_anchor_offset_minutes
    )
  );

  return v_id;
end;
$$;

create or replace function public.list_workspace_client_lifecycle_defaults(
  p_workspace_id uuid
)
returns table (
  id                         uuid,
  workspace_id               uuid,
  name                       text,
  appointment_type           public.appointment_type,
  message_purpose            text,
  message_channel            public.message_template_channel,
  message_locale             text,
  schedule_anchor            public.automation_schedule_anchor,
  anchor_offset_minutes      integer,
  is_enabled                 boolean,
  version                    integer,
  materialized_artists       integer,
  overridden_artists         integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
begin
  perform crm_private.require_workspace_access(p_workspace_id, 'manage_integrations');

  return query
  select
    d.id,
    d.workspace_id,
    d.name,
    d.condition_appointment_type,
    d.message_purpose,
    d.message_channel,
    d.message_locale,
    d.schedule_anchor,
    d.anchor_offset_minutes,
    d.is_enabled,
    d.version,
    count(r.id)::int,
    count(r.id) filter (where r.workspace_override)::int
  from public.workspace_automation_defaults d
  left join public.automation_rules r
    on r.workspace_default_id = d.id
  where d.workspace_id = p_workspace_id
    and d.action_type = 'send_client_message'::public.automation_action_type
  group by d.id
  order by d.created_at, d.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Template activation
--
-- upsert_message_template intentionally creates drafts. This is the reviewed
-- transition that makes one draft sendable. Activating a new version retires
-- the previous active version in the exact same artist/workspace slot first,
-- so the unique active-template indexes remain the final database invariant.
-- ---------------------------------------------------------------------------

create or replace function public.set_message_template_active(
  p_template_id uuid,
  p_is_active boolean
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_template public.message_templates%rowtype;
begin
  select t.* into v_template
  from public.message_templates t
  where t.id = p_template_id
  for update;

  if not found then
    raise exception 'the message template is unavailable' using errcode = '22023';
  end if;

  if v_template.artist_id is not null then
    perform crm_private.require_artist_access(v_template.artist_id, 'manage_automations');
  else
    perform crm_private.require_workspace_access(v_template.workspace_id, 'manage_workspace');
  end if;

  if coalesce(p_is_active, false) then
    update public.message_templates t
    set status = 'retired'
    where t.id <> v_template.id
      and t.status = 'active'
      and t.workspace_id = v_template.workspace_id
      and t.artist_id is not distinct from v_template.artist_id
      and t.purpose = v_template.purpose
      and t.channel = v_template.channel
      and t.locale = v_template.locale;

    update public.message_templates t
    set status = 'active'
    where t.id = v_template.id;

    return true;
  end if;

  update public.message_templates t
  set status = case when t.status = 'active' then 'retired' else t.status end
  where t.id = v_template.id;

  return false;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. API boundary
-- ---------------------------------------------------------------------------

revoke all on function public.create_client_lifecycle_rule(
  uuid, text, public.appointment_type, text,
  public.automation_schedule_anchor, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_client_lifecycle_rule(
  uuid, text, public.appointment_type, text,
  public.automation_schedule_anchor, integer, text
) to authenticated;

revoke all on function public.list_client_lifecycle_rules(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_client_lifecycle_rules(uuid)
  to authenticated;

revoke all on function public.upsert_workspace_client_lifecycle_default(
  uuid, uuid, text, public.appointment_type, text,
  public.automation_schedule_anchor, integer, text, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.upsert_workspace_client_lifecycle_default(
  uuid, uuid, text, public.appointment_type, text,
  public.automation_schedule_anchor, integer, text, boolean
) to authenticated;

revoke all on function public.list_workspace_client_lifecycle_defaults(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_workspace_client_lifecycle_defaults(uuid)
  to authenticated;

revoke all on function public.set_message_template_active(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_message_template_active(uuid, boolean)
  to authenticated;
