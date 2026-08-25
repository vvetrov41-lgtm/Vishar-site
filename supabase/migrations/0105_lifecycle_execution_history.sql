-- 0105_lifecycle_execution_history.sql
--
-- Read-only Lifecycle Automation Studio v2 execution history. The browser gets
-- a bounded, artist-scoped projection with normalized delivery states and
-- normalized failure categories. Raw provider errors, recipient addresses,
-- provider identifiers, credentials and message bodies remain private.

create or replace function public.list_client_lifecycle_execution_history(
  p_artist_id uuid,
  p_limit integer default 50
)
returns table (
  job_id uuid,
  rule_id uuid,
  rule_name text,
  rule_version integer,
  session_id uuid,
  client_name text,
  appointment_type public.appointment_type,
  message_purpose text,
  scheduled_at timestamptz,
  lifecycle_status text,
  job_status public.automation_job_status,
  email_status public.email_message_status,
  outbox_status public.outbox_status,
  failure_reason text,
  attempt_count integer,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
  with authorized as (
    select a.id as artist_id
    from public.artists a
    where a.id = p_artist_id
      and a.is_active
      and public.is_active_user()
      and crm_private.has_artist_capability(a.id, 'view_automations')
      and crm_private.has_artist_capability(a.id, 'view_sessions')
      and crm_private.has_artist_capability(a.id, 'view_clients')
      and crm_private.has_artist_capability(a.id, 'view_integrations')
  ),
  rows as (
    select
      j.id as selected_job_id,
      j.rule_id as selected_rule_id,
      coalesce(r.name, 'Lifecycle automation') as selected_rule_name,
      j.rule_version as selected_rule_version,
      j.session_id as selected_session_id,
      c.full_name as selected_client_name,
      s.appointment_type as selected_appointment_type,
      j.message_purpose as selected_message_purpose,
      j.scheduled_at as selected_scheduled_at,
      j.status as selected_job_status,
      j.last_error_category,
      j.attempt_count as selected_attempt_count,
      j.created_at as selected_created_at,
      j.updated_at as selected_updated_at,
      em.status as selected_email_status,
      o.status as selected_outbox_status,
      o.attempt_count as selected_outbox_attempt_count
    from public.automation_jobs j
    join authorized a on a.artist_id = j.artist_id
    join public.sessions s on s.id = j.session_id and s.artist_id = j.artist_id
    join public.clients c on c.id = s.client_id
    left join public.automation_rules r on r.id = j.rule_id and r.artist_id = j.artist_id
    left join lateral (
      select m.id, m.status
      from public.email_messages m
      where m.automation_job_id = j.id
        and m.artist_id = j.artist_id
      order by m.created_at desc, m.id
      limit 1
    ) em on true
    left join lateral (
      select io.status, io.attempt_count
      from public.integration_outbox io
      where io.kind = 'approved_email'::public.outbox_kind
        and io.email_message_id = em.id
      order by io.created_at desc, io.id
      limit 1
    ) o on true
    order by j.scheduled_at desc, j.created_at desc, j.id
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
  )
  select
    x.selected_job_id,
    x.selected_rule_id,
    x.selected_rule_name,
    x.selected_rule_version,
    x.selected_session_id,
    x.selected_client_name,
    x.selected_appointment_type,
    x.selected_message_purpose,
    x.selected_scheduled_at,
    case
      when x.selected_job_status = 'pending'::public.automation_job_status and x.selected_scheduled_at > now() then 'scheduled'
      when x.selected_job_status = 'pending'::public.automation_job_status then 'pending'
      when x.selected_job_status = 'running'::public.automation_job_status and x.selected_attempt_count > 1 then 'retrying'
      when x.selected_job_status = 'running'::public.automation_job_status then 'pending'
      when x.selected_job_status = 'cancelled'::public.automation_job_status and x.last_error_category = 'client_blocked' then 'suppressed'
      when x.selected_job_status = 'cancelled'::public.automation_job_status and x.last_error_category = 'appointment_ineligible' then 'withdrawn'
      when x.selected_job_status = 'cancelled'::public.automation_job_status then 'cancelled'
      when x.selected_job_status = 'failed'::public.automation_job_status then 'failed'
      when x.selected_job_status = 'completed'::public.automation_job_status and x.selected_email_status = 'sent'::public.email_message_status then 'sent'
      when x.selected_job_status = 'completed'::public.automation_job_status and x.selected_email_status = 'cancelled'::public.email_message_status then 'cancelled'
      when x.selected_job_status = 'completed'::public.automation_job_status and x.selected_email_status = 'failed'::public.email_message_status then 'failed'
      when x.selected_job_status = 'completed'::public.automation_job_status and x.selected_outbox_status in ('failed'::public.outbox_status, 'dead'::public.outbox_status) then 'failed'
      when x.selected_job_status = 'completed'::public.automation_job_status and x.selected_outbox_status in ('pending'::public.outbox_status, 'leased'::public.outbox_status) and coalesce(x.selected_outbox_attempt_count, 0) > 0 then 'retrying'
      when x.selected_job_status = 'completed'::public.automation_job_status and x.selected_email_status = 'queued'::public.email_message_status then 'queued'
      when x.selected_job_status = 'completed'::public.automation_job_status and x.selected_email_status is null then 'failed'
      else 'queued'
    end as lifecycle_status,
    x.selected_job_status,
    x.selected_email_status,
    x.selected_outbox_status,
    case
      when x.selected_job_status = 'cancelled'::public.automation_job_status and x.last_error_category = 'client_blocked' then 'client_suppressed'
      when x.selected_job_status = 'cancelled'::public.automation_job_status and x.last_error_category = 'appointment_ineligible' then 'appointment_withdrawn'
      when x.last_error_category in ('integration_unavailable', 'template_unavailable', 'destination_unavailable') then x.last_error_category
      when x.selected_email_status = 'failed'::public.email_message_status then 'email_failed'
      when x.selected_outbox_status in ('failed'::public.outbox_status, 'dead'::public.outbox_status) then 'provider_delivery_failed'
      when x.selected_job_status = 'completed'::public.automation_job_status and x.selected_email_status is null then 'delivery_state_missing'
      when x.selected_job_status = 'failed'::public.automation_job_status then 'automation_failed'
      else null
    end as failure_reason,
    x.selected_attempt_count,
    x.selected_created_at,
    x.selected_updated_at
  from rows x;
$$;

revoke all on function public.list_client_lifecycle_execution_history(uuid, integer) from public;
revoke all on function public.list_client_lifecycle_execution_history(uuid, integer) from anon;
revoke all on function public.list_client_lifecycle_execution_history(uuid, integer) from service_role;
grant execute on function public.list_client_lifecycle_execution_history(uuid, integer) to authenticated;
