-- 0112_lifecycle_scheduler_heartbeat.sql
--
-- Persist one privacy-safe proof that the shared production scheduler completed
-- its lifecycle tick recently. The heartbeat contains no Artist, client,
-- appointment, message, provider or credential data. It is written only by the
-- trusted backend after service_run_automation_tick succeeds.
--
-- The existing Artist health RPC gains two appended fields:
--   * scheduler_last_succeeded_at
--   * scheduler_stale
-- A heartbeat is stale after 15 minutes, which is three missed windows of the
-- production */5 scheduler. Existing callers can ignore the appended columns.

create table crm_private.automation_scheduler_heartbeat (
  singleton boolean primary key default true check (singleton),
  last_succeeded_at timestamptz not null
);

comment on table crm_private.automation_scheduler_heartbeat is
  'Singleton privacy-safe proof of the most recent successfully completed lifecycle scheduler tick.';
comment on column crm_private.automation_scheduler_heartbeat.last_succeeded_at is
  'Server timestamp recorded only after the trusted Worker receives and validates a successful lifecycle tick result.';

revoke all on table crm_private.automation_scheduler_heartbeat
  from public, anon, authenticated, service_role;

create function public.service_record_automation_scheduler_heartbeat()
returns timestamptz
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_succeeded_at timestamptz := clock_timestamp();
begin
  if not crm_private.is_service_backend() then
    raise exception 'automation scheduler heartbeat is backend-only'
      using errcode = '42501';
  end if;

  insert into crm_private.automation_scheduler_heartbeat (
    singleton,
    last_succeeded_at
  ) values (
    true,
    v_succeeded_at
  )
  on conflict (singleton) do update
    set last_succeeded_at = excluded.last_succeeded_at;

  return v_succeeded_at;
end;
$$;

revoke all on function public.service_record_automation_scheduler_heartbeat()
  from public, anon, authenticated, service_role;
grant execute on function public.service_record_automation_scheduler_heartbeat()
  to service_role;

comment on function public.service_record_automation_scheduler_heartbeat() is
  'Backend-only singleton heartbeat written after a successful lifecycle automation tick; contains no customer or provider data.';

-- PostgreSQL cannot append OUT columns with CREATE OR REPLACE. Recreate the
-- existing read-only health projection atomically while preserving its exact
-- input signature and execute ACL.
drop function public.get_lifecycle_automation_health(uuid);

create function public.get_lifecycle_automation_health(
  p_artist_id uuid
)
returns table (
  artist_id uuid,
  health_status text,
  automation_enabled boolean,
  active_rule_count integer,
  disabled_rule_count integer,
  attention_item_count integer,
  missing_template_rule_count integer,
  invalid_rule_count integer,
  integration_available boolean,
  recent_failed_job_count integer,
  blocker_codes text[],
  pending_job_count integer,
  overdue_pending_job_count integer,
  next_scheduled_at timestamptz,
  oldest_overdue_pending_at timestamptz,
  last_completed_at timestamptz,
  last_failed_at timestamptz,
  scheduler_last_succeeded_at timestamptz,
  scheduler_stale boolean
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
      and crm_private.has_artist_capability(a.id, 'view_integrations')
  ),
  lifecycle_rules as (
    select
      r.*,
      a.workspace_id,
      tc.entity_kind as trigger_entity_kind,
      mp.classification as purpose_classification
    from public.automation_rules r
    join authorized a on a.artist_id = r.artist_id
    left join public.automation_trigger_catalog tc
      on tc.event_type = r.trigger_event_type
    left join public.message_template_purposes mp
      on mp.purpose = r.message_purpose
    where r.action_type = 'send_client_message'::public.automation_action_type
  ),
  evaluated_rules as (
    select
      r.*,
      (
        r.trigger_entity_kind = 'session'
        and r.purpose_classification = 'service'::public.message_classification
        and r.condition_appointment_type is not null
        and r.message_channel = 'email'::public.message_template_channel
        and r.message_locale in ('en', 'ru')
        and (
          (
            r.schedule_anchor = 'session_start'::public.automation_schedule_anchor
            and r.anchor_offset_minutes between -43200 and 0
          )
          or (
            r.schedule_anchor = 'session_end'::public.automation_schedule_anchor
            and r.anchor_offset_minutes between 0 and 43200
          )
        )
      ) as valid_definition,
      (
        t.id is not null
        and t.classification = 'service'::public.message_classification
        and t.subject is not null
        and btrim(t.subject) <> ''
        and btrim(t.body) <> ''
        and position('{{confirm_link}}' in t.subject) = 0
        and position('{{reschedule_link}}' in t.subject) = 0
        and position('{{cancel_link}}' in t.subject) = 0
        and (
          (
            t.purpose in ('session_reminder_24h', 'consultation_reminder')
            and (
              (
                position('{{confirm_link}}' in t.body) = 0
                and position('{{reschedule_link}}' in t.body) = 0
                and position('{{cancel_link}}' in t.body) = 0
              )
              or (
                position('{{confirm_link}}' in t.body) > 0
                and position('{{reschedule_link}}' in t.body) > 0
                and position('{{cancel_link}}' in t.body) > 0
              )
            )
          )
          or (
            t.purpose not in ('session_reminder_24h', 'consultation_reminder')
            and position('{{confirm_link}}' in t.body) = 0
            and position('{{reschedule_link}}' in t.body) = 0
            and position('{{cancel_link}}' in t.body) = 0
          )
        )
      ) as has_usable_template
    from lifecycle_rules r
    left join lateral (
      select
        mt.id, mt.artist_id, mt.purpose, mt.version,
        mt.subject, mt.body, p.classification
      from public.message_templates mt
      join public.message_template_purposes p on p.purpose = mt.purpose
      where mt.workspace_id = r.workspace_id
        and (mt.artist_id = r.artist_id or mt.artist_id is null)
        and mt.purpose = r.message_purpose
        and mt.channel = r.message_channel
        and mt.locale = r.message_locale
        and mt.status = 'active'::public.message_template_status
      order by (mt.artist_id is not null) desc, mt.version desc, mt.id
      limit 1
    ) t on true
  ),
  rule_summary as (
    select
      count(*) filter (where is_enabled)::integer as active_rule_count,
      count(*) filter (where not is_enabled)::integer as disabled_rule_count,
      count(*) filter (
        where is_enabled and valid_definition is not true
      )::integer as invalid_rule_count,
      count(*) filter (
        where is_enabled
          and valid_definition is true
          and has_usable_template is not true
      )::integer as missing_template_rule_count
    from evaluated_rules
  ),
  runtime as (
    select
      a.artist_id,
      crm_private.automations_enabled_for_artist(a.artist_id) as automation_enabled,
      exists (
        select 1
        from public.artist_integrations i
        where i.artist_id = a.artist_id
          and i.integration_type = 'email'::public.artist_integration_type
          and i.provider = 'google'
          and i.is_enabled
          and i.external_account_label is not null
          and btrim(i.external_account_label) <> ''
      ) as integration_available,
      (
        select count(*)::integer
        from public.automation_jobs j
        join lifecycle_rules r on r.id = j.rule_id
        where j.status = 'failed'::public.automation_job_status
          and j.updated_at >= now() - interval '7 days'
      ) as recent_failed_job_count,
      (
        select count(*)::integer
        from public.automation_jobs j
        join lifecycle_rules r on r.id = j.rule_id
        where j.status = 'pending'::public.automation_job_status
      ) as pending_job_count,
      (
        select count(*)::integer
        from public.automation_jobs j
        join lifecycle_rules r on r.id = j.rule_id
        where j.status = 'pending'::public.automation_job_status
          and j.scheduled_at < now() - interval '15 minutes'
      ) as overdue_pending_job_count,
      (
        select min(j.scheduled_at)
        from public.automation_jobs j
        join lifecycle_rules r on r.id = j.rule_id
        where j.status = 'pending'::public.automation_job_status
          and j.scheduled_at >= now()
      ) as next_scheduled_at,
      (
        select min(j.scheduled_at)
        from public.automation_jobs j
        join lifecycle_rules r on r.id = j.rule_id
        where j.status = 'pending'::public.automation_job_status
          and j.scheduled_at < now() - interval '15 minutes'
      ) as oldest_overdue_pending_at,
      (
        select max(j.completed_at)
        from public.automation_jobs j
        join lifecycle_rules r on r.id = j.rule_id
        where j.status = 'completed'::public.automation_job_status
          and j.completed_at is not null
      ) as last_completed_at,
      (
        select max(j.updated_at)
        from public.automation_jobs j
        join lifecycle_rules r on r.id = j.rule_id
        where j.status = 'failed'::public.automation_job_status
      ) as last_failed_at,
      (
        select h.last_succeeded_at
        from crm_private.automation_scheduler_heartbeat h
        where h.singleton
      ) as scheduler_last_succeeded_at
    from authorized a
  ),
  measured as (
    select
      x.artist_id,
      x.automation_enabled,
      r.active_rule_count,
      r.disabled_rule_count,
      r.missing_template_rule_count,
      r.invalid_rule_count,
      x.integration_available,
      x.recent_failed_job_count,
      x.pending_job_count,
      x.overdue_pending_job_count,
      x.next_scheduled_at,
      x.oldest_overdue_pending_at,
      x.last_completed_at,
      x.last_failed_at,
      x.scheduler_last_succeeded_at,
      coalesce(
        x.scheduler_last_succeeded_at < now() - interval '15 minutes',
        true
      ) as scheduler_stale,
      array_remove(array[
        case when r.active_rule_count > 0 and not x.automation_enabled
          then 'automation_paused' end,
        case when r.active_rule_count > 0 and not x.integration_available
          then 'integration_unavailable' end,
        case when r.missing_template_rule_count > 0
          then 'missing_active_template' end,
        case when r.invalid_rule_count > 0
          then 'invalid_rule' end,
        case when x.recent_failed_job_count >= 3
          then 'repeated_delivery_failures' end
      ]::text[], null) as blocker_codes
    from runtime x
    cross join rule_summary r
  )
  select
    m.artist_id,
    case
      when m.active_rule_count = 0 then 'inactive'
      when cardinality(m.blocker_codes) > 0 then 'attention'
      else 'healthy'
    end,
    m.automation_enabled,
    m.active_rule_count,
    m.disabled_rule_count,
    cardinality(m.blocker_codes),
    m.missing_template_rule_count,
    m.invalid_rule_count,
    m.integration_available,
    m.recent_failed_job_count,
    m.blocker_codes,
    m.pending_job_count,
    m.overdue_pending_job_count,
    m.next_scheduled_at,
    m.oldest_overdue_pending_at,
    m.last_completed_at,
    m.last_failed_at,
    m.scheduler_last_succeeded_at,
    m.scheduler_stale
  from measured m;
$$;

revoke all on function public.get_lifecycle_automation_health(uuid) from public;
revoke all on function public.get_lifecycle_automation_health(uuid) from anon;
revoke all on function public.get_lifecycle_automation_health(uuid) from service_role;
grant execute on function public.get_lifecycle_automation_health(uuid) to authenticated;

comment on function public.get_lifecycle_automation_health(uuid) is
  'Returns bounded Artist lifecycle health, runtime queue timing and global scheduler heartbeat diagnostics without client data, message copy, destinations or raw provider errors.';
