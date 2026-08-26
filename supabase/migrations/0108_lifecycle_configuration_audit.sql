-- 0108_lifecycle_configuration_audit.sql
--
-- Complete the append-only audit contract for Artist lifecycle configuration.
-- Rule creation and enablement now carry stable entity identifiers plus bounded
-- before/after state. Artist-scoped template drafts and activation transitions
-- are recorded without copying subject/body content into activity metadata.

-- ---------------------------------------------------------------------------
-- 1. Lifecycle rule creation
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
  v_version integer;
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
  returning id, version into v_id, v_version;

  perform crm_private.log_artist_activity(
    p_artist_id,
    'automation.rule_created',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    null, null, null, null, null,
    jsonb_build_object(
      'rule_id', v_id,
      'after', jsonb_build_object(
        'action_type', 'send_client_message',
        'appointment_type', p_appointment_type,
        'message_purpose', p_message_purpose,
        'message_channel', 'email',
        'message_locale', coalesce(p_locale, 'en'),
        'schedule_anchor', p_schedule_anchor,
        'anchor_offset_minutes', p_anchor_offset_minutes,
        'is_enabled', false,
        'version', v_version
      )
    )
  );

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Rule enablement
-- ---------------------------------------------------------------------------

create or replace function public.set_automation_rule_enabled(
  p_rule_id uuid,
  p_is_enabled boolean
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_rule public.automation_rules%rowtype;
  v_updated public.automation_rules%rowtype;
  v_is_enabled boolean := coalesce(p_is_enabled, false);
begin
  select r.* into v_rule
  from public.automation_rules r
  where r.id = p_rule_id
  for update;

  if not found then
    raise exception 'the automation rule is unavailable' using errcode = '22023';
  end if;

  perform crm_private.require_artist_access(v_rule.artist_id, 'manage_automations');

  if v_rule.is_enabled = v_is_enabled then
    return v_is_enabled;
  end if;

  update public.automation_rules r
  set is_enabled = v_is_enabled
  where r.id = v_rule.id
  returning r.* into v_updated;

  perform crm_private.log_artist_activity(
    v_rule.artist_id,
    'automation.rule_updated',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(),
    null, null, null, null, null,
    jsonb_build_object(
      'rule_id', v_rule.id,
      'before', jsonb_build_object(
        'is_enabled', v_rule.is_enabled,
        'version', v_rule.version
      ),
      'after', jsonb_build_object(
        'is_enabled', v_updated.is_enabled,
        'version', v_updated.version
      )
    )
  );

  return v_updated.is_enabled;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Artist template version creation
-- ---------------------------------------------------------------------------

create or replace function public.upsert_message_template(
  p_workspace_id uuid,
  p_purpose text,
  p_channel public.message_template_channel,
  p_body text,
  p_locale text default 'en',
  p_subject text default null,
  p_artist_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_id uuid;
  v_locale text := coalesce(p_locale, 'en');
  v_version integer;
  v_slot_key text;
begin
  if p_artist_id is not null then
    perform crm_private.require_artist_access(p_artist_id, 'manage_automations');
  else
    perform crm_private.require_workspace_access(p_workspace_id, 'manage_workspace');
  end if;

  if not exists (
    select 1 from public.message_template_purposes p where p.purpose = p_purpose
  ) then
    raise exception 'unknown message purpose %', p_purpose using errcode = '22023';
  end if;

  v_slot_key := concat_ws(
    '|',
    p_workspace_id::text,
    coalesce(p_artist_id::text, 'workspace'),
    p_purpose,
    p_channel::text,
    v_locale
  );
  perform pg_advisory_xact_lock(hashtextextended(v_slot_key, 0));

  select coalesce(max(t.version), 0) + 1
  into v_version
  from public.message_templates t
  where t.workspace_id = p_workspace_id
    and t.artist_id is not distinct from p_artist_id
    and t.purpose = p_purpose
    and t.channel = p_channel
    and t.locale = v_locale;

  insert into public.message_templates (
    workspace_id, artist_id, purpose, channel, locale, version,
    subject, body, status, created_by
  ) values (
    p_workspace_id, p_artist_id, p_purpose, p_channel, v_locale, v_version,
    p_subject, p_body, 'draft', auth.uid()
  )
  returning id into v_id;

  -- Workspace templates are governed by the workspace control plane. This
  -- Artist audit trail records only templates an Artist can select or edit.
  if p_artist_id is not null then
    perform crm_private.log_artist_activity(
      p_artist_id,
      'automation.template_created',
      case when public.is_owner() then 'owner' else 'staff' end,
      auth.uid(),
      null, null, null, null, null,
      jsonb_build_object(
        'template_id', v_id,
        'purpose', p_purpose,
        'channel', p_channel,
        'locale', v_locale,
        'version', v_version,
        'status', 'draft'
      )
    );
  end if;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Artist template activation
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
  v_retired_count integer := 0;
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
    if v_template.status = 'active' then
      return true;
    end if;

    update public.message_templates t
    set status = 'retired'
    where t.id <> v_template.id
      and t.status = 'active'
      and t.workspace_id = v_template.workspace_id
      and t.artist_id is not distinct from v_template.artist_id
      and t.purpose = v_template.purpose
      and t.channel = v_template.channel
      and t.locale = v_template.locale;

    get diagnostics v_retired_count = row_count;

    update public.message_templates t
    set status = 'active'
    where t.id = v_template.id;

    if v_template.artist_id is not null then
      perform crm_private.log_artist_activity(
        v_template.artist_id,
        'automation.template_updated',
        case when public.is_owner() then 'owner' else 'staff' end,
        auth.uid(),
        null, null, null, null, null,
        jsonb_build_object(
          'template_id', v_template.id,
          'purpose', v_template.purpose,
          'channel', v_template.channel,
          'locale', v_template.locale,
          'version', v_template.version,
          'before', jsonb_build_object('status', v_template.status),
          'after', jsonb_build_object('status', 'active'),
          'previous_active_versions_retired', v_retired_count
        )
      );
    end if;

    return true;
  end if;

  if v_template.status <> 'active' then
    return false;
  end if;

  update public.message_templates t
  set status = 'retired'
  where t.id = v_template.id;

  if v_template.artist_id is not null then
    perform crm_private.log_artist_activity(
      v_template.artist_id,
      'automation.template_updated',
      case when public.is_owner() then 'owner' else 'staff' end,
      auth.uid(),
      null, null, null, null, null,
      jsonb_build_object(
        'template_id', v_template.id,
        'purpose', v_template.purpose,
        'channel', v_template.channel,
        'locale', v_template.locale,
        'version', v_template.version,
        'before', jsonb_build_object('status', v_template.status),
        'after', jsonb_build_object('status', 'retired'),
        'previous_active_versions_retired', 0
      )
    );
  end if;

  return false;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Preserve the existing human-only API boundary
-- ---------------------------------------------------------------------------

revoke all on function public.create_client_lifecycle_rule(
  uuid, text, public.appointment_type, text,
  public.automation_schedule_anchor, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_client_lifecycle_rule(
  uuid, text, public.appointment_type, text,
  public.automation_schedule_anchor, integer, text
) to authenticated;

revoke all on function public.set_automation_rule_enabled(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_automation_rule_enabled(uuid, boolean)
  to authenticated;

revoke all on function public.upsert_message_template(
  uuid, text, public.message_template_channel, text, text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.upsert_message_template(
  uuid, text, public.message_template_channel, text, text, text, uuid
) to authenticated;

revoke all on function public.set_message_template_active(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.set_message_template_active(uuid, boolean)
  to authenticated;

comment on function public.set_automation_rule_enabled(uuid, boolean) is
  'Changes only rule enablement and appends bounded before/after audit state; identical requests are no-ops.';
comment on function public.upsert_message_template(
  uuid, text, public.message_template_channel, text, text, text, uuid
) is
  'Creates an immutable draft at the next serialized slot version and audits Artist-scoped creation without message content.';
comment on function public.set_message_template_active(uuid, boolean) is
  'Selects or retires an immutable template version and audits Artist-scoped status transitions without message content.';
