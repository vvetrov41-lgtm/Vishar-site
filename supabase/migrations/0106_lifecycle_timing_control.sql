-- 0106_lifecycle_timing_control.sql
--
-- Narrow timing mutation for Lifecycle Automation Studio v2. The browser sends
-- a human timing choice; Postgres converts it to the canonical anchor/offset,
-- versions the rule, reschedules only pending jobs, and records a bounded audit
-- event. Completed/running history and every non-timing rule field stay intact.

create or replace function public.update_client_lifecycle_rule_timing(
  p_rule_id uuid,
  p_timing_direction text,
  p_amount integer,
  p_unit text
)
returns table (
  rule_id uuid,
  schedule_anchor public.automation_schedule_anchor,
  anchor_offset_minutes integer,
  rule_version integer,
  pending_jobs_rescheduled integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_rule public.automation_rules%rowtype;
  v_updated public.automation_rules%rowtype;
  v_minutes_bigint bigint;
  v_minutes integer;
  v_anchor public.automation_schedule_anchor;
  v_offset integer;
  v_rescheduled integer := 0;
begin
  select r.* into v_rule
  from public.automation_rules r
  where r.id = p_rule_id
  for update;

  if not found then
    raise exception 'the client lifecycle rule is unavailable'
      using errcode = '22023';
  end if;

  perform crm_private.require_artist_access(v_rule.artist_id, 'manage_automations');
  perform crm_private.require_active_artist(v_rule.artist_id);

  if v_rule.action_type <> 'send_client_message'::public.automation_action_type
     or v_rule.schedule_anchor not in (
       'session_start'::public.automation_schedule_anchor,
       'session_end'::public.automation_schedule_anchor
     )
     or v_rule.message_channel <> 'email'::public.message_template_channel
     or v_rule.condition_appointment_type is null
     or v_rule.message_purpose is null then
    raise exception 'the client lifecycle rule is unavailable'
      using errcode = '22023';
  end if;

  if p_amount is null or p_amount < 1 then
    raise exception 'timing amount must be a positive whole number'
      using errcode = '22023';
  end if;

  case lower(coalesce(p_unit, ''))
    when 'minutes' then v_minutes_bigint := p_amount::bigint;
    when 'hours' then v_minutes_bigint := p_amount::bigint * 60;
    when 'days' then v_minutes_bigint := p_amount::bigint * 1440;
    else
      raise exception 'timing unit must be minutes, hours or days'
        using errcode = '22023';
  end case;

  if v_minutes_bigint > 43200 then
    raise exception 'lifecycle timing must be within 30 days of the appointment'
      using errcode = '22023';
  end if;

  if mod(v_minutes_bigint, 5) <> 0 then
    raise exception 'lifecycle timing must align to five minutes'
      using errcode = '22023';
  end if;

  v_minutes := v_minutes_bigint::integer;

  case lower(coalesce(p_timing_direction, ''))
    when 'before_session_start' then
      v_anchor := 'session_start'::public.automation_schedule_anchor;
      v_offset := -v_minutes;
    when 'after_session_end' then
      v_anchor := 'session_end'::public.automation_schedule_anchor;
      v_offset := v_minutes;
    else
      raise exception 'timing direction must be before session start or after session end'
        using errcode = '22023';
  end case;

  if v_rule.schedule_anchor = v_anchor
     and v_rule.anchor_offset_minutes = v_offset then
    return query
    select v_rule.id, v_rule.schedule_anchor, v_rule.anchor_offset_minutes,
           v_rule.version, 0;
    return;
  end if;

  update public.automation_rules r
  set schedule_anchor = v_anchor,
      anchor_offset_minutes = v_offset,
      workspace_override = case
        when r.workspace_default_id is not null then true
        else r.workspace_override
      end
  where r.id = v_rule.id
  returning r.* into v_updated;

  -- Pending jobs have produced no side effect, so they may move atomically to
  -- the new rule version. Running/completed/cancelled/failed snapshots remain
  -- untouched and therefore retain the definition they actually used.
  update public.automation_jobs j
  set rule_version = v_updated.version,
      schedule_anchor = v_updated.schedule_anchor,
      anchor_offset_minutes = v_updated.anchor_offset_minutes,
      scheduled_at = case v_updated.schedule_anchor
        when 'session_start'::public.automation_schedule_anchor
          then s.start_at + make_interval(mins => v_updated.anchor_offset_minutes)
        when 'session_end'::public.automation_schedule_anchor
          then s.end_at + make_interval(mins => v_updated.anchor_offset_minutes)
      end,
      updated_at = now()
  from public.sessions s
  where j.rule_id = v_updated.id
    and j.status = 'pending'::public.automation_job_status
    and s.id = j.session_id
    and s.artist_id = j.artist_id;

  get diagnostics v_rescheduled = row_count;

  perform crm_private.log_artist_activity(
    v_updated.artist_id,
    'automation.rule_timing_updated',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(), null, null, null, null, null,
    jsonb_build_object(
      'rule_id', v_updated.id,
      'before', jsonb_build_object(
        'schedule_anchor', v_rule.schedule_anchor,
        'anchor_offset_minutes', v_rule.anchor_offset_minutes,
        'version', v_rule.version
      ),
      'after', jsonb_build_object(
        'schedule_anchor', v_updated.schedule_anchor,
        'anchor_offset_minutes', v_updated.anchor_offset_minutes,
        'version', v_updated.version
      ),
      'pending_jobs_rescheduled', v_rescheduled
    )
  );

  return query
  select v_updated.id, v_updated.schedule_anchor,
         v_updated.anchor_offset_minutes, v_updated.version, v_rescheduled;
end;
$$;

revoke all on function public.update_client_lifecycle_rule_timing(
  uuid, text, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.update_client_lifecycle_rule_timing(
  uuid, text, integer, text
) to authenticated;
