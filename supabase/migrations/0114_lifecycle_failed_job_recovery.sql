-- 0114_lifecycle_failed_job_recovery.sql
--
-- Safe operator recovery for lifecycle execution failures. Only a failed
-- client-message job that has produced no email row may be requeued. Delivery
-- failures are deliberately outside this boundary: once an email exists, an
-- operator retry here could duplicate a customer message.

-- The history result gains one server-authoritative boolean. PostgreSQL cannot
-- change a RETURNS TABLE shape with CREATE OR REPLACE, so replace the function
-- transactionally in this forward-only migration.
drop function public.list_client_lifecycle_execution_history(uuid, integer);

create function public.list_client_lifecycle_execution_history(
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
  retryable boolean,
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
      em.id as selected_email_id,
      em.status as selected_email_status,
      o.status as selected_outbox_status,
      o.attempt_count as selected_outbox_attempt_count,
      (
        j.status = 'failed'::public.automation_job_status
        and em.id is null
        and r.id is not null
        and r.is_enabled
        and r.version = j.rule_version
        and j.action_type = 'send_client_message'::public.automation_action_type
        and j.schedule_anchor in (
          'session_start'::public.automation_schedule_anchor,
          'session_end'::public.automation_schedule_anchor
        )
        and j.message_channel = 'email'::public.message_template_channel
        and j.condition_appointment_type is not null
        and j.message_purpose is not null
        and j.session_id is not null
      ) as selected_retryable
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
    x.selected_retryable,
    x.selected_attempt_count,
    x.selected_created_at,
    x.selected_updated_at
  from rows x;
$$;

revoke all on function public.list_client_lifecycle_execution_history(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_client_lifecycle_execution_history(uuid, integer)
  to authenticated;

create function public.retry_client_lifecycle_job(p_job_id uuid)
returns table (
  job_id uuid,
  job_status public.automation_job_status,
  attempt_count integer,
  scheduled_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.automation_jobs%rowtype;
  v_rule public.automation_rules%rowtype;
  v_previous_error text;
begin
  select j.* into v_job
  from public.automation_jobs j
  where j.id = p_job_id
  for update;

  if not found then
    raise exception 'the lifecycle execution is unavailable'
      using errcode = '22023';
  end if;

  perform crm_private.require_artist_access(v_job.artist_id, 'manage_automations');
  perform crm_private.require_active_artist(v_job.artist_id);

  select r.* into v_rule
  from public.automation_rules r
  where r.id = v_job.rule_id
    and r.artist_id = v_job.artist_id;

  if v_job.status <> 'failed'::public.automation_job_status
     or v_job.action_type <> 'send_client_message'::public.automation_action_type
     or v_job.schedule_anchor not in (
       'session_start'::public.automation_schedule_anchor,
       'session_end'::public.automation_schedule_anchor
     )
     or v_job.message_channel <> 'email'::public.message_template_channel
     or v_job.condition_appointment_type is null
     or v_job.message_purpose is null
     or v_job.session_id is null
     or not found
     or not v_rule.is_enabled
     or v_rule.version <> v_job.rule_version then
    raise exception 'the lifecycle execution is not retryable'
      using errcode = '22023';
  end if;

  -- An email row is the irreversible boundary for this recovery primitive.
  -- It may already be queued, leased, sent or failed at the provider layer;
  -- none of those states may be replayed through automation execution.
  if exists (
    select 1
    from public.email_messages m
    where m.automation_job_id = v_job.id
  ) then
    raise exception 'the lifecycle execution is not retryable'
      using errcode = '22023';
  end if;

  v_previous_error := v_job.last_error_category;

  update public.automation_jobs j
  set status = 'pending'::public.automation_job_status,
      last_error_category = null,
      completed_at = null,
      cancelled_at = null,
      updated_at = now()
  where j.id = v_job.id;

  -- Preserve attempt_count: it is execution history, not a retry budget reset.
  perform crm_private.log_artist_activity(
    v_job.artist_id,
    'automation.job_requeued',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(), null, null, null, null, null,
    jsonb_build_object(
      'job_id', v_job.id,
      'previous_failure_category', v_previous_error,
      'attempt_count', v_job.attempt_count
    )
  );

  return query
  select v_job.id,
         'pending'::public.automation_job_status,
         v_job.attempt_count,
         v_job.scheduled_at;
end;
$$;

revoke all on function public.retry_client_lifecycle_job(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.retry_client_lifecycle_job(uuid)
  to authenticated;
