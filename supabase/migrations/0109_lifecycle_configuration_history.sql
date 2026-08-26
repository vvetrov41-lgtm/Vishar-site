-- 0109_lifecycle_configuration_history.sql
--
-- Read-only Lifecycle Automation Studio configuration history. The browser
-- receives an Artist-scoped, cursor-paginated projection of typed operational
-- fields. Raw activity metadata, template copy, client data and provider state
-- remain outside the API contract.

create or replace function public.list_lifecycle_configuration_history(
  p_artist_id uuid,
  p_limit integer default 50,
  p_before_occurred_at timestamptz default null,
  p_before_id uuid default null
)
returns table (
  activity_id uuid,
  occurred_at timestamptz,
  event_type text,
  actor_profile_id uuid,
  actor_display_name text,
  actor_kind text,
  entity_kind text,
  rule_id uuid,
  template_id uuid,
  purpose text,
  channel text,
  locale text,
  version integer,
  is_enabled_before boolean,
  is_enabled_after boolean,
  schedule_anchor_before text,
  schedule_anchor_after text,
  anchor_offset_minutes_before integer,
  anchor_offset_minutes_after integer,
  status_before text,
  status_after text,
  pending_jobs_rescheduled integer,
  previous_active_versions_retired integer
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
  ),
  selected as (
    select a.*, p.display_name as selected_actor_display_name
    from public.activity_log a
    join authorized z on z.artist_id = a.artist_id
    left join public.profiles p on p.id = a.actor_profile_id
    where a.event_type in (
      'automation.rule_created',
      'automation.rule_updated',
      'automation.rule_timing_updated',
      'automation.template_created',
      'automation.template_updated'
    )
      and (
        (
          p_before_occurred_at is null
          and p_before_id is null
        )
        or (
          p_before_occurred_at is not null
          and p_before_id is not null
          and (a.occurred_at, a.id) < (p_before_occurred_at, p_before_id)
        )
      )
    order by a.occurred_at desc, a.id desc
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
  ),
  normalized as (
    select
      a.*,
      coalesce(a.metadata ->> 'purpose', a.metadata #>> '{after,message_purpose}') as selected_purpose,
      coalesce(a.metadata ->> 'channel', a.metadata #>> '{after,message_channel}') as selected_channel,
      coalesce(a.metadata ->> 'locale', a.metadata #>> '{after,message_locale}') as selected_locale,
      coalesce(a.metadata ->> 'version', a.metadata #>> '{after,version}') as selected_version,
      a.metadata #>> '{before,is_enabled}' as selected_is_enabled_before,
      coalesce(a.metadata #>> '{after,is_enabled}', a.metadata ->> 'is_enabled') as selected_is_enabled_after,
      a.metadata #>> '{before,schedule_anchor}' as selected_schedule_anchor_before,
      coalesce(a.metadata #>> '{after,schedule_anchor}', a.metadata ->> 'schedule_anchor') as selected_schedule_anchor_after,
      a.metadata #>> '{before,anchor_offset_minutes}' as selected_offset_before,
      coalesce(a.metadata #>> '{after,anchor_offset_minutes}', a.metadata ->> 'anchor_offset_minutes') as selected_offset_after,
      a.metadata #>> '{before,status}' as selected_status_before,
      coalesce(a.metadata #>> '{after,status}', a.metadata ->> 'status') as selected_status_after,
      a.metadata ->> 'pending_jobs_rescheduled' as selected_pending_jobs_rescheduled,
      a.metadata ->> 'previous_active_versions_retired' as selected_previous_versions_retired
    from selected a
  )
  select
    a.id,
    a.occurred_at,
    a.event_type,
    a.actor_profile_id,
    a.selected_actor_display_name,
    a.actor_kind,
    case
      when a.event_type like 'automation.template_%' then 'template'
      else 'rule'
    end,
    case
      when a.metadata ->> 'rule_id' ~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then (a.metadata ->> 'rule_id')::uuid
      else null
    end,
    case
      when a.metadata ->> 'template_id' ~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then (a.metadata ->> 'template_id')::uuid
      else null
    end,
    case
      when exists (
        select 1 from public.message_template_purposes p
        where p.purpose = a.selected_purpose
      ) then a.selected_purpose
      else null
    end,
    case
      when a.selected_channel in ('email', 'whatsapp', 'instagram')
        then a.selected_channel
      else null
    end,
    case
      when a.selected_locale ~ '^[a-z]{2}(-[A-Z]{2})?$'
        then a.selected_locale
      else null
    end,
    case
      when a.selected_version ~ '^[0-9]{1,9}$' then a.selected_version::integer
      else null
    end,
    case
      when a.selected_is_enabled_before in ('true', 'false')
        then a.selected_is_enabled_before::boolean
      else null
    end,
    case
      when a.selected_is_enabled_after in ('true', 'false')
        then a.selected_is_enabled_after::boolean
      else null
    end,
    case
      when a.selected_schedule_anchor_before in ('session_start', 'session_end')
        then a.selected_schedule_anchor_before
      else null
    end,
    case
      when a.selected_schedule_anchor_after in ('session_start', 'session_end')
        then a.selected_schedule_anchor_after
      else null
    end,
    case
      when a.selected_offset_before ~ '^-?[0-9]{1,8}$' then a.selected_offset_before::integer
      else null
    end,
    case
      when a.selected_offset_after ~ '^-?[0-9]{1,8}$' then a.selected_offset_after::integer
      else null
    end,
    case
      when a.selected_status_before in ('draft', 'active', 'retired')
        then a.selected_status_before
      else null
    end,
    case
      when a.selected_status_after in ('draft', 'active', 'retired')
        then a.selected_status_after
      else null
    end,
    case
      when a.selected_pending_jobs_rescheduled ~ '^[0-9]{1,9}$'
        then a.selected_pending_jobs_rescheduled::integer
      else null
    end,
    case
      when a.selected_previous_versions_retired ~ '^[0-9]{1,9}$'
        then a.selected_previous_versions_retired::integer
      else null
    end
  from normalized a
  order by a.occurred_at desc, a.id desc;
$$;

revoke all on function public.list_lifecycle_configuration_history(
  uuid, integer, timestamptz, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.list_lifecycle_configuration_history(
  uuid, integer, timestamptz, uuid
) to authenticated;

comment on function public.list_lifecycle_configuration_history(
  uuid, integer, timestamptz, uuid
) is
  'Returns bounded typed Artist automation configuration history without raw activity metadata, message copy, client data or provider state.';
