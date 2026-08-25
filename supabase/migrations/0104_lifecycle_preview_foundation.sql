-- 0104_lifecycle_preview_foundation.sql
--
-- First Lifecycle Automation Studio v2 slice: bounded, artist-scoped preview
-- reads. This migration creates no rule, template, job, email, outbox row or
-- appointment action capability. It grants no browser SELECT on private
-- automation tables and keeps provider credentials behind existing Workers.

create or replace function public.list_client_lifecycle_preview_sessions(
  p_artist_id uuid,
  p_limit integer default 50
)
returns table (
  session_id uuid,
  client_name text,
  appointment_type public.appointment_type,
  session_status public.session_status,
  start_at timestamptz,
  end_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  select
    s.id,
    c.full_name,
    s.appointment_type,
    s.status,
    s.start_at,
    s.end_at
  from public.sessions s
  join public.clients c on c.id = s.client_id
  where s.artist_id = p_artist_id
    and public.is_active_user()
    and crm_private.has_artist_capability(p_artist_id, 'view_automations')
  order by abs(extract(epoch from (s.start_at - now()))), s.start_at desc, s.id
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

create or replace function public.preview_client_lifecycle_rule(
  p_artist_id uuid,
  p_rule_id uuid,
  p_session_id uuid
)
returns table (
  rule_id uuid,
  rule_name text,
  rule_version integer,
  rule_enabled boolean,
  session_id uuid,
  client_name text,
  appointment_type public.appointment_type,
  session_status public.session_status,
  scheduled_at timestamptz,
  template_id uuid,
  template_version integer,
  template_scope text,
  rendered_subject text,
  rendered_body text,
  suppression_reason text,
  integration_available boolean,
  existing_job_id uuid,
  existing_job_status public.automation_job_status,
  eligible boolean,
  blocker text
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with authorized as (
    select a.id as artist_id, a.workspace_id
    from public.artists a
    where a.id = p_artist_id
      and a.is_active
      and public.is_active_user()
      and crm_private.has_artist_capability(a.id, 'view_automations')
  ),
  selected_rule as (
    select r.*
    from public.automation_rules r
    join authorized a on a.artist_id = r.artist_id
    where r.id = p_rule_id
      and r.action_type = 'send_client_message'::public.automation_action_type
      and r.message_channel = 'email'::public.message_template_channel
  ),
  selected_session as (
    select s.*, c.full_name as client_name, c.email as client_email, c.archived_at as client_archived_at
    from public.sessions s
    join public.clients c on c.id = s.client_id
    join authorized a on a.artist_id = s.artist_id
    where s.id = p_session_id
  ),
  base as (
    select
      r.*,
      s.id as selected_session_id,
      s.client_name,
      s.client_email,
      s.client_archived_at,
      s.client_id as selected_client_id,
      s.appointment_type as selected_appointment_type,
      s.status as selected_session_status,
      s.start_at as selected_start_at,
      s.end_at as selected_end_at,
      a.workspace_id,
      case r.schedule_anchor
        when 'session_start'::public.automation_schedule_anchor
          then s.start_at + make_interval(mins => r.anchor_offset_minutes)
        when 'session_end'::public.automation_schedule_anchor
          then s.end_at + make_interval(mins => r.anchor_offset_minutes)
      end as computed_scheduled_at,
      crm_private.automations_enabled_for_artist(r.artist_id) as automations_enabled
    from selected_rule r
    cross join selected_session s
    join authorized a on a.artist_id = r.artist_id
  ),
  resolved as (
    select
      b.*,
      t.id as selected_template_id,
      t.version as selected_template_version,
      case when t.artist_id is null then 'workspace' else 'artist' end as selected_template_scope,
      t.subject as template_subject,
      t.body as template_body,
      p.classification as template_classification,
      j.id as selected_job_id,
      j.status as selected_job_status,
      exists (
        select 1
        from public.artist_integrations i
        where i.artist_id = b.artist_id
          and i.integration_type = 'email'::public.artist_integration_type
          and i.provider = 'google'
          and i.is_enabled
          and i.external_account_label is not null
          and btrim(i.external_account_label) <> ''
      ) as has_email_integration
    from base b
    left join lateral (
      select mt.*
      from public.message_templates mt
      where mt.workspace_id = b.workspace_id
        and (mt.artist_id = b.artist_id or mt.artist_id is null)
        and mt.purpose = b.message_purpose
        and mt.channel = b.message_channel
        and mt.locale = b.message_locale
        and mt.status = 'active'::public.message_template_status
      order by (mt.artist_id is not null) desc, mt.version desc, mt.id
      limit 1
    ) t on true
    left join public.message_template_purposes p on p.purpose = t.purpose
    left join lateral (
      select aj.id, aj.status
      from public.automation_jobs aj
      where aj.rule_id = b.id
        and aj.session_id = b.selected_session_id
      order by aj.created_at desc, aj.id
      limit 1
    ) j on true
  ),
  rendered as (
    select
      x.*,
      case
        when x.selected_template_id is null then null
        when position('{{confirm_link}}' in coalesce(x.template_subject, '')) > 0
          or position('{{reschedule_link}}' in coalesce(x.template_subject, '')) > 0
          or position('{{cancel_link}}' in coalesce(x.template_subject, '')) > 0
          then null
        else crm_private.render_lifecycle_template_text(x.template_subject, x.selected_session_id)
      end as preview_subject,
      case
        when x.selected_template_id is null then null
        when x.message_purpose in ('session_reminder_24h', 'consultation_reminder')
          and (
            position('{{confirm_link}}' in coalesce(x.template_body, '')) > 0
            or position('{{reschedule_link}}' in coalesce(x.template_body, '')) > 0
            or position('{{cancel_link}}' in coalesce(x.template_body, '')) > 0
          )
          and position('{{confirm_link}}' in coalesce(x.template_body, '')) > 0
          and position('{{reschedule_link}}' in coalesce(x.template_body, '')) > 0
          and position('{{cancel_link}}' in coalesce(x.template_body, '')) > 0
          then replace(
            replace(
              replace(
                crm_private.render_lifecycle_action_template_text(
                  x.template_body,
                  x.selected_session_id,
                  repeat('a', 64),
                  repeat('b', 64),
                  repeat('c', 64)
                ),
                repeat('a', 64),
                '[preview confirm link]'
              ),
              repeat('b', 64),
              '[preview reschedule link]'
            ),
            repeat('c', 64),
            '[preview cancel link]'
          )
        when position('{{confirm_link}}' in coalesce(x.template_body, '')) > 0
          or position('{{reschedule_link}}' in coalesce(x.template_body, '')) > 0
          or position('{{cancel_link}}' in coalesce(x.template_body, '')) > 0
          then null
        else crm_private.render_lifecycle_template_text(x.template_body, x.selected_session_id)
      end as preview_body,
      case
        when x.selected_template_id is null then null
        when x.template_classification <> 'service'::public.message_classification then null
        else crm_private.client_send_block_reason(
          x.selected_client_id,
          x.message_channel,
          x.template_classification
        )
      end as send_block_reason
    from resolved x
  ),
  decided as (
    select
      x.*,
      case
        when not x.automations_enabled then 'automation_paused'
        when not x.is_enabled then 'rule_disabled'
        when x.condition_appointment_type is distinct from x.selected_appointment_type then 'appointment_type_mismatch'
        when x.schedule_anchor = 'session_start'::public.automation_schedule_anchor
          and x.selected_session_status in ('cancelled', 'no_show', 'completed') then 'appointment_ineligible'
        when x.schedule_anchor = 'session_start'::public.automation_schedule_anchor
          and x.selected_session_status <> 'confirmed' then 'appointment_not_ready'
        when x.schedule_anchor = 'session_end'::public.automation_schedule_anchor
          and x.selected_session_status in ('cancelled', 'no_show') then 'appointment_ineligible'
        when x.schedule_anchor = 'session_end'::public.automation_schedule_anchor
          and x.selected_session_status <> 'completed' then 'appointment_not_ready'
        when x.computed_scheduled_at > now() then 'not_due'
        when x.client_archived_at is not null
          or x.client_email is null
          or btrim(x.client_email) = '' then 'destination_unavailable'
        when x.selected_template_id is null
          or x.template_classification <> 'service'::public.message_classification
          or x.preview_subject is null
          or btrim(x.preview_subject) = ''
          or x.preview_body is null
          or btrim(x.preview_body) = '' then 'template_unavailable'
        when x.send_block_reason is not null then 'client_blocked'
        when not x.has_email_integration then 'integration_unavailable'
        when x.selected_job_status = 'completed'::public.automation_job_status then 'already_delivered'
        when x.selected_job_status = 'cancelled'::public.automation_job_status then 'job_cancelled'
        when x.selected_job_status = 'failed'::public.automation_job_status then 'job_failed'
        else null
      end as decision_blocker
    from rendered x
  )
  select
    x.id,
    x.name,
    x.version,
    x.is_enabled,
    x.selected_session_id,
    x.client_name,
    x.selected_appointment_type,
    x.selected_session_status,
    x.computed_scheduled_at,
    x.selected_template_id,
    x.selected_template_version,
    x.selected_template_scope,
    x.preview_subject,
    x.preview_body,
    x.send_block_reason,
    x.has_email_integration,
    x.selected_job_id,
    x.selected_job_status,
    x.decision_blocker is null,
    x.decision_blocker
  from decided x;
$$;

revoke all on function public.list_client_lifecycle_preview_sessions(uuid, integer) from public;
revoke all on function public.list_client_lifecycle_preview_sessions(uuid, integer) from anon;
revoke all on function public.list_client_lifecycle_preview_sessions(uuid, integer) from service_role;
grant execute on function public.list_client_lifecycle_preview_sessions(uuid, integer) to authenticated;

revoke all on function public.preview_client_lifecycle_rule(uuid, uuid, uuid) from public;
revoke all on function public.preview_client_lifecycle_rule(uuid, uuid, uuid) from anon;
revoke all on function public.preview_client_lifecycle_rule(uuid, uuid, uuid) from service_role;
grant execute on function public.preview_client_lifecycle_rule(uuid, uuid, uuid) to authenticated;
