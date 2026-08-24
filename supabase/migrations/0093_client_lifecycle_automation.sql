-- 0093_client_lifecycle_automation.sql
--
-- Client lifecycle automation on top of the generic 0081 scheduler.
--
-- Safety properties:
--   * client messages are service-only, template-only and email-only here;
--   * a lifecycle job is scoped to one authoritative session and artist;
--   * its schedule is derived from the live session start/end, so reschedules
--     move pending work instead of creating a second delivery;
--   * cancellation/no-show/completion gates are re-read immediately before send;
--   * suppression/consent and the active Gmail integration are re-read before
--     an approved system message is created;
--   * system automation is a separate approval provenance. It never fabricates
--     a human approver and does not weaken the human/AI draft flow;
--   * provider delivery remains the existing approved_email outbox + Gmail
--     Worker contract, including its own live-recipient and integration checks.
--
-- Forward-only. This migration creates no enabled rule, no active template and
-- no provider configuration, so applying it cannot itself send a client email.

-- ---------------------------------------------------------------------------
-- 1. Lifecycle scheduling vocabulary and service-purpose catalogue
-- ---------------------------------------------------------------------------

do $$
begin
  create type public.automation_schedule_anchor as enum (
    'event_occurred',
    'session_start',
    'session_end'
  );
exception when duplicate_object then null;
end
$$;

insert into public.message_template_purposes (purpose, classification, description)
values
  ('session_reminder_7d', 'service', 'Seven-day appointment reminder.'),
  ('post_session_checkin', 'service', 'Post-session healing or follow-up check-in.')
on conflict (purpose) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Rule/default/job definition snapshots
-- ---------------------------------------------------------------------------

alter table public.automation_rules
  add column schedule_anchor public.automation_schedule_anchor not null default 'event_occurred',
  add column anchor_offset_minutes integer not null default 0,
  add column condition_appointment_type public.appointment_type,
  add column message_purpose text references public.message_template_purposes (purpose) on delete restrict,
  add column message_channel public.message_template_channel,
  add column message_locale text;

alter table public.automation_rules
  add constraint automation_rules_anchor_offset_bounds
    check (anchor_offset_minutes between -43200 and 43200),
  add constraint automation_rules_lifecycle_action_shape
    check (
      (
        action_type = 'notify_artist_team'::public.automation_action_type
        and schedule_anchor = 'event_occurred'::public.automation_schedule_anchor
        and anchor_offset_minutes = 0
        and condition_appointment_type is null
        and message_purpose is null
        and message_channel is null
        and message_locale is null
      )
      or
      (
        action_type = 'send_client_message'::public.automation_action_type
        and schedule_anchor in (
          'session_start'::public.automation_schedule_anchor,
          'session_end'::public.automation_schedule_anchor
        )
        and delay_minutes = 0
        and condition_appointment_type is not null
        and message_purpose is not null
        and message_channel = 'email'::public.message_template_channel
        and message_locale in ('en', 'ru')
        and action_body is null
      )
    );

alter table public.workspace_automation_defaults
  add column schedule_anchor public.automation_schedule_anchor not null default 'event_occurred',
  add column anchor_offset_minutes integer not null default 0,
  add column condition_appointment_type public.appointment_type,
  add column message_purpose text references public.message_template_purposes (purpose) on delete restrict,
  add column message_channel public.message_template_channel,
  add column message_locale text;

alter table public.workspace_automation_defaults
  add constraint workspace_automation_defaults_anchor_offset_bounds
    check (anchor_offset_minutes between -43200 and 43200),
  add constraint workspace_automation_defaults_lifecycle_action_shape
    check (
      (
        action_type = 'notify_artist_team'::public.automation_action_type
        and schedule_anchor = 'event_occurred'::public.automation_schedule_anchor
        and anchor_offset_minutes = 0
        and condition_appointment_type is null
        and message_purpose is null
        and message_channel is null
        and message_locale is null
      )
      or
      (
        action_type = 'send_client_message'::public.automation_action_type
        and schedule_anchor in (
          'session_start'::public.automation_schedule_anchor,
          'session_end'::public.automation_schedule_anchor
        )
        and delay_minutes = 0
        and condition_appointment_type is not null
        and message_purpose is not null
        and message_channel = 'email'::public.message_template_channel
        and message_locale in ('en', 'ru')
        and action_body is null
      )
    );

alter table public.automation_jobs
  add column schedule_anchor public.automation_schedule_anchor not null default 'event_occurred',
  add column anchor_offset_minutes integer not null default 0,
  add column condition_appointment_type public.appointment_type,
  add column message_purpose text references public.message_template_purposes (purpose) on delete restrict,
  add column message_channel public.message_template_channel,
  add column message_locale text,
  add column session_id uuid references public.sessions (id) on delete restrict;

alter table public.automation_jobs
  add constraint automation_jobs_anchor_offset_bounds
    check (anchor_offset_minutes between -43200 and 43200),
  add constraint automation_jobs_lifecycle_action_shape
    check (
      (
        action_type = 'notify_artist_team'::public.automation_action_type
        and schedule_anchor = 'event_occurred'::public.automation_schedule_anchor
        and anchor_offset_minutes = 0
        and condition_appointment_type is null
        and message_purpose is null
        and message_channel is null
        and message_locale is null
        and session_id is null
      )
      or
      (
        action_type = 'send_client_message'::public.automation_action_type
        and schedule_anchor in (
          'session_start'::public.automation_schedule_anchor,
          'session_end'::public.automation_schedule_anchor
        )
        and condition_appointment_type is not null
        and message_purpose is not null
        and message_channel = 'email'::public.message_template_channel
        and message_locale in ('en', 'ru')
        and action_body is null
        and session_id is not null
      )
    );

-- A single lifecycle rule may materialise from more than one activity row for
-- the same appointment (for example, a repeated confirmation transition). The
-- session is the domain identity, so only one job may exist per rule/session.
create unique index automation_jobs_lifecycle_rule_session_idx
  on public.automation_jobs (rule_id, session_id)
  where session_id is not null;

alter table public.automation_jobs
  drop constraint automation_jobs_error_category_known;
alter table public.automation_jobs
  add constraint automation_jobs_error_category_known
  check (
    last_error_category is null
    or last_error_category in (
      'none',
      'no_recipient',
      'rule_withdrawn',
      'unsupported_action',
      'client_blocked',
      'template_unavailable',
      'destination_unavailable',
      'integration_unavailable',
      'appointment_ineligible',
      'unknown'
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Definition validation and versioning
-- ---------------------------------------------------------------------------

create or replace function crm_private.guard_client_automation_definition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_entity_kind text;
  v_classification public.message_classification;
begin
  if new.action_type <> 'send_client_message'::public.automation_action_type then
    return new;
  end if;

  select c.entity_kind into v_entity_kind
  from public.automation_trigger_catalog c
  where c.event_type = new.trigger_event_type;

  if v_entity_kind is distinct from 'session' then
    raise exception 'client lifecycle messages require a session-scoped trigger'
      using errcode = '22023';
  end if;

  select p.classification into v_classification
  from public.message_template_purposes p
  where p.purpose = new.message_purpose;

  if v_classification is distinct from 'service'::public.message_classification then
    raise exception 'client lifecycle automation may only use service message purposes'
      using errcode = '22023';
  end if;

  if new.schedule_anchor = 'session_start'::public.automation_schedule_anchor
     and new.anchor_offset_minutes > 0 then
    raise exception 'a session-start lifecycle offset may not be after the session starts'
      using errcode = '22023';
  end if;

  if new.schedule_anchor = 'session_end'::public.automation_schedule_anchor
     and new.anchor_offset_minutes < 0 then
    raise exception 'a session-end lifecycle offset may not be before the session ends'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

drop trigger if exists automation_rules_guard_client_definition
  on public.automation_rules;
create trigger automation_rules_guard_client_definition
  before insert or update on public.automation_rules
  for each row execute function crm_private.guard_client_automation_definition();

drop trigger if exists workspace_automation_defaults_guard_client_definition
  on public.workspace_automation_defaults;
create trigger workspace_automation_defaults_guard_client_definition
  before insert or update on public.workspace_automation_defaults
  for each row execute function crm_private.guard_client_automation_definition();

create or replace function crm_private.bump_automation_rule_version()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.artist_id is distinct from old.artist_id then
    raise exception 'an automation rule cannot change artist; disable it and create a new one'
      using errcode = '23514';
  end if;

  if new.trigger_event_type is distinct from old.trigger_event_type
     or new.condition_from_status is distinct from old.condition_from_status
     or new.condition_to_status is distinct from old.condition_to_status
     or new.delay_minutes is distinct from old.delay_minutes
     or new.action_type is distinct from old.action_type
     or new.action_title is distinct from old.action_title
     or new.action_body is distinct from old.action_body
     or new.action_priority is distinct from old.action_priority
     or new.schedule_anchor is distinct from old.schedule_anchor
     or new.anchor_offset_minutes is distinct from old.anchor_offset_minutes
     or new.condition_appointment_type is distinct from old.condition_appointment_type
     or new.message_purpose is distinct from old.message_purpose
     or new.message_channel is distinct from old.message_channel
     or new.message_locale is distinct from old.message_locale then
    new.version := old.version + 1;
  end if;

  return new;
end;
$$;

create or replace function crm_private.bump_workspace_automation_default_version()
returns trigger
language plpgsql
set search_path = pg_catalog, public, crm_private
as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'a workspace automation default cannot change workspace; create a new default instead'
      using errcode = '23514';
  end if;

  if new.name is distinct from old.name
     or new.trigger_event_type is distinct from old.trigger_event_type
     or new.condition_from_status is distinct from old.condition_from_status
     or new.condition_to_status is distinct from old.condition_to_status
     or new.delay_minutes is distinct from old.delay_minutes
     or new.action_type is distinct from old.action_type
     or new.action_title is distinct from old.action_title
     or new.action_body is distinct from old.action_body
     or new.action_priority is distinct from old.action_priority
     or new.schedule_anchor is distinct from old.schedule_anchor
     or new.anchor_offset_minutes is distinct from old.anchor_offset_minutes
     or new.condition_appointment_type is distinct from old.condition_appointment_type
     or new.message_purpose is distinct from old.message_purpose
     or new.message_channel is distinct from old.message_channel
     or new.message_locale is distinct from old.message_locale
     or new.is_enabled is distinct from old.is_enabled then
    new.version := old.version + 1;
  end if;

  return new;
end;
$$;

-- Workspace blueprints retain their write-time expansion model. No runtime
-- inheritance is introduced into the scheduler.
create or replace function crm_private.materialize_workspace_automation_default(
  p_default_id uuid,
  p_artist_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_default public.workspace_automation_defaults%rowtype;
  v_artist_workspace uuid;
  v_rule_id uuid;
begin
  select d.* into v_default
  from public.workspace_automation_defaults d
  where d.id = p_default_id;

  if not found then
    raise exception 'the workspace automation default is unavailable'
      using errcode = '22023';
  end if;

  select a.workspace_id into v_artist_workspace
  from public.artists a
  where a.id = p_artist_id and a.is_active;

  if v_artist_workspace is null or v_artist_workspace <> v_default.workspace_id then
    raise exception 'the artist does not belong to the automation default workspace'
      using errcode = '23514';
  end if;

  insert into public.automation_rules (
    artist_id, name, trigger_event_type,
    condition_from_status, condition_to_status, delay_minutes,
    action_type, action_title, action_body, action_priority,
    schedule_anchor, anchor_offset_minutes, condition_appointment_type,
    message_purpose, message_channel, message_locale,
    is_enabled, created_by,
    workspace_default_id, workspace_default_version, workspace_override
  ) values (
    p_artist_id, v_default.name, v_default.trigger_event_type,
    v_default.condition_from_status, v_default.condition_to_status,
    v_default.delay_minutes,
    v_default.action_type, v_default.action_title, v_default.action_body,
    v_default.action_priority,
    v_default.schedule_anchor, v_default.anchor_offset_minutes,
    v_default.condition_appointment_type,
    v_default.message_purpose, v_default.message_channel, v_default.message_locale,
    v_default.is_enabled, auth.uid(),
    v_default.id, v_default.version, false
  )
  on conflict (workspace_default_id, artist_id) do update
    set name = excluded.name,
        trigger_event_type = excluded.trigger_event_type,
        condition_from_status = excluded.condition_from_status,
        condition_to_status = excluded.condition_to_status,
        delay_minutes = excluded.delay_minutes,
        action_type = excluded.action_type,
        action_title = excluded.action_title,
        action_body = excluded.action_body,
        action_priority = excluded.action_priority,
        schedule_anchor = excluded.schedule_anchor,
        anchor_offset_minutes = excluded.anchor_offset_minutes,
        condition_appointment_type = excluded.condition_appointment_type,
        message_purpose = excluded.message_purpose,
        message_channel = excluded.message_channel,
        message_locale = excluded.message_locale,
        is_enabled = excluded.is_enabled,
        workspace_default_version = excluded.workspace_default_version
    where not public.automation_rules.workspace_override
  returning id into v_rule_id;

  if v_rule_id is null then
    select r.id into v_rule_id
    from public.automation_rules r
    where r.workspace_default_id = p_default_id
      and r.artist_id = p_artist_id;
  end if;

  return v_rule_id;
end;
$$;

-- Clearing any artist override must restore the whole current blueprint,
-- including lifecycle fields, not just the legacy notification columns.
create or replace function public.clear_artist_automation_override(
  p_workspace_default_id uuid,
  p_artist_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_default public.workspace_automation_defaults%rowtype;
  v_artist_workspace uuid;
  v_rule_id uuid;
begin
  perform crm_private.require_artist_access(p_artist_id, 'manage_automations');

  select d.* into v_default
  from public.workspace_automation_defaults d
  where d.id = p_workspace_default_id;

  select a.workspace_id into v_artist_workspace
  from public.artists a
  where a.id = p_artist_id and a.is_active;

  if v_default.id is null or v_artist_workspace is null
     or v_default.workspace_id <> v_artist_workspace then
    raise exception 'the automation default does not belong to this artist workspace'
      using errcode = '23514';
  end if;

  update public.automation_rules r
  set name = v_default.name,
      trigger_event_type = v_default.trigger_event_type,
      condition_from_status = v_default.condition_from_status,
      condition_to_status = v_default.condition_to_status,
      delay_minutes = v_default.delay_minutes,
      action_type = v_default.action_type,
      action_title = v_default.action_title,
      action_body = v_default.action_body,
      action_priority = v_default.action_priority,
      schedule_anchor = v_default.schedule_anchor,
      anchor_offset_minutes = v_default.anchor_offset_minutes,
      condition_appointment_type = v_default.condition_appointment_type,
      message_purpose = v_default.message_purpose,
      message_channel = v_default.message_channel,
      message_locale = v_default.message_locale,
      is_enabled = v_default.is_enabled,
      workspace_default_version = v_default.version,
      workspace_override = false
  where r.workspace_default_id = p_workspace_default_id
    and r.artist_id = p_artist_id
  returning r.id into v_rule_id;

  if v_rule_id is null then
    raise exception 'the workspace automation default has not been applied to this artist'
      using errcode = '22023';
  end if;

  perform crm_private.log_artist_activity(
    p_artist_id, 'automation.rule_updated',
    case when public.is_owner() then 'owner' else 'staff' end,
    auth.uid(), null, null, null, null, null,
    jsonb_build_object('workspace_default_id', p_workspace_default_id,
                       'workspace_override', false)
  );

  return v_rule_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. System-email provenance and one-email-per-job idempotency
-- ---------------------------------------------------------------------------

alter table public.email_messages
  add column automation_job_id uuid references public.automation_jobs (id) on delete restrict;

create unique index email_messages_automation_job_idx
  on public.email_messages (automation_job_id)
  where automation_job_id is not null;

alter table public.email_messages
  drop constraint if exists email_messages_approval_required;
alter table public.email_messages
  add constraint email_messages_approval_required
  check (
    status not in ('approved', 'queued', 'sent')
    or (
      approved_at is not null
      and (
        (created_by_kind = 'system' and approved_by is null)
        or (created_by_kind in ('human', 'ai') and approved_by is not null)
      )
    )
  );

create or replace function crm_private.guard_email_automation_job()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job_artist uuid;
  v_action public.automation_action_type;
  v_session_id uuid;
  v_session public.sessions%rowtype;
begin
  if new.automation_job_id is null then
    return new;
  end if;

  if new.created_by_kind <> 'system'
     or new.created_by is not null
     or new.approved_by is not null then
    raise exception 'automation email provenance must be system-only'
      using errcode = '23514';
  end if;

  select j.artist_id, j.action_type, j.session_id
    into v_job_artist, v_action, v_session_id
  from public.automation_jobs j
  where j.id = new.automation_job_id;

  if v_job_artist is null
     or v_action <> 'send_client_message'::public.automation_action_type
     or v_session_id is null
     or v_job_artist <> new.artist_id then
    raise exception 'automation email does not match its lifecycle job'
      using errcode = '23514';
  end if;

  select s.* into v_session
  from public.sessions s
  where s.id = v_session_id;

  if not found
     or v_session.artist_id <> new.artist_id
     or v_session.client_id is distinct from new.client_id
     or v_session.enquiry_id is distinct from new.enquiry_id
     or v_session.project_id is distinct from new.project_id then
    raise exception 'automation email links do not match the authoritative session'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists email_messages_guard_automation_job
  on public.email_messages;
create trigger email_messages_guard_automation_job
  before insert or update on public.email_messages
  for each row execute function crm_private.guard_email_automation_job();

-- ---------------------------------------------------------------------------
-- 5. Scheduling and template rendering helpers
-- ---------------------------------------------------------------------------

create or replace function crm_private.resolve_automation_scheduled_at(
  p_schedule_anchor public.automation_schedule_anchor,
  p_delay_minutes integer,
  p_anchor_offset_minutes integer,
  p_event_occurred_at timestamptz,
  p_artist_id uuid,
  p_entity_kind text,
  p_entity_id uuid,
  p_condition_appointment_type public.appointment_type
)
returns timestamptz
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_session public.sessions%rowtype;
begin
  if p_schedule_anchor = 'event_occurred'::public.automation_schedule_anchor then
    return p_event_occurred_at + make_interval(mins => coalesce(p_delay_minutes, 0));
  end if;

  if p_entity_kind <> 'session' or p_entity_id is null then
    return null;
  end if;

  select s.* into v_session
  from public.sessions s
  where s.id = p_entity_id
    and s.artist_id = p_artist_id;

  if not found
     or (p_condition_appointment_type is not null
         and v_session.appointment_type <> p_condition_appointment_type) then
    return null;
  end if;

  if p_schedule_anchor = 'session_start'::public.automation_schedule_anchor then
    return v_session.start_at + make_interval(mins => coalesce(p_anchor_offset_minutes, 0));
  end if;

  return v_session.end_at + make_interval(mins => coalesce(p_anchor_offset_minutes, 0));
end;
$$;

create or replace function crm_private.render_lifecycle_template_text(
  p_text text,
  p_session_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_out text := p_text;
  v_client_name text;
  v_artist_name text;
  v_studio_name text;
  v_timezone text;
  v_start_at timestamptz;
  v_reference text;
  v_deposit_amount numeric;
  v_currency text;
begin
  if v_out is null then
    return null;
  end if;

  select c.full_name,
         a.display_name,
         w.display_name,
         a.timezone,
         s.start_at,
         e.reference_number,
         coalesce(p.deposit_override_amount, p.deposit_amount),
         p.currency
    into v_client_name, v_artist_name, v_studio_name, v_timezone,
         v_start_at, v_reference, v_deposit_amount, v_currency
  from public.sessions s
  join public.clients c on c.id = s.client_id
  join public.artists a on a.id = s.artist_id
  join public.workspaces w on w.id = a.workspace_id
  left join public.enquiries e on e.id = s.enquiry_id
  left join public.projects p on p.id = s.project_id
  where s.id = p_session_id;

  if not found then
    return null;
  end if;

  v_out := replace(v_out, '{{client_first_name}}', split_part(btrim(v_client_name), ' ', 1));
  v_out := replace(v_out, '{{artist_display_name}}', v_artist_name);
  v_out := replace(v_out, '{{studio_name}}', v_studio_name);
  v_out := replace(v_out, '{{appointment_date}}',
                   to_char(v_start_at at time zone v_timezone, 'FMDD FMMonth YYYY'));
  v_out := replace(v_out, '{{appointment_time}}',
                   to_char(v_start_at at time zone v_timezone, 'HH24:MI'));

  if position('{{enquiry_reference}}' in v_out) > 0 then
    if v_reference is null then return null; end if;
    v_out := replace(v_out, '{{enquiry_reference}}', v_reference);
  end if;

  if position('{{deposit_amount}}' in v_out) > 0 then
    if v_deposit_amount is null or v_currency is null then return null; end if;
    v_out := replace(
      v_out,
      '{{deposit_amount}}',
      to_char(v_deposit_amount, 'FM999999990.00') || ' ' || upper(v_currency)
    );
  end if;

  -- No canonical booking URL is stored on the session. Do not invent one from
  -- a website hostname or allow a stale rule body to smuggle it in.
  if position('{{booking_link}}' in v_out) > 0 then
    return null;
  end if;

  -- The template-table trigger already restricts variables to the catalogue.
  -- This final check turns any unresolved catalogue variable into a hard,
  -- non-sending configuration failure.
  if v_out ~ '\{\{[a-z][a-z0-9_]*\}\}' then
    return null;
  end if;

  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. One atomic client-message execution primitive
-- ---------------------------------------------------------------------------

create or replace function crm_private.execute_client_lifecycle_job(p_job_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_job public.automation_jobs%rowtype;
  v_session public.sessions%rowtype;
  v_template record;
  v_block_reason text;
  v_to_email text;
  v_subject text;
  v_body text;
  v_message_id uuid;
  v_outbox_id uuid;
begin
  if not crm_private.is_service_backend() then
    raise exception 'client lifecycle execution is backend-only' using errcode = '42501';
  end if;

  select j.* into v_job
  from public.automation_jobs j
  where j.id = p_job_id
  for update;

  if not found
     or v_job.status <> 'pending'::public.automation_job_status
     or v_job.action_type <> 'send_client_message'::public.automation_action_type then
    return 'skipped';
  end if;

  if not crm_private.automations_enabled_for_artist(v_job.artist_id) then
    return 'paused';
  end if;

  select s.* into v_session
  from public.sessions s
  where s.id = v_job.session_id
    and s.artist_id = v_job.artist_id;

  if not found
     or v_session.appointment_type <> v_job.condition_appointment_type then
    update public.automation_jobs
    set status = 'cancelled', cancelled_at = now(),
        last_error_category = 'appointment_ineligible'
    where id = p_job_id;
    return 'cancelled';
  end if;

  if v_job.schedule_anchor = 'session_start'::public.automation_schedule_anchor then
    if v_session.status in ('cancelled', 'no_show', 'completed') then
      update public.automation_jobs
      set status = 'cancelled', cancelled_at = now(),
          last_error_category = 'appointment_ineligible'
      where id = p_job_id;
      return 'cancelled';
    end if;
    if v_session.status <> 'confirmed' then
      return 'pending';
    end if;
  else
    if v_session.status in ('cancelled', 'no_show') then
      update public.automation_jobs
      set status = 'cancelled', cancelled_at = now(),
          last_error_category = 'appointment_ineligible'
      where id = p_job_id;
      return 'cancelled';
    end if;
    if v_session.status <> 'completed' then
      return 'pending';
    end if;
  end if;

  if v_job.scheduled_at > now() then
    return 'pending';
  end if;

  select lower(btrim(c.email)) into v_to_email
  from public.clients c
  where c.id = v_session.client_id
    and not c.is_archived
    and c.email is not null
    and btrim(c.email) <> '';

  if v_to_email is null then
    update public.automation_jobs
    set status = 'failed', attempt_count = attempt_count + 1,
        last_error_category = 'destination_unavailable'
    where id = p_job_id;
    return 'failed';
  end if;

  select t.id, t.purpose, t.version, t.subject, t.body, p.classification
    into v_template
  from public.message_templates t
  join public.artists a on a.id = v_job.artist_id
  join public.message_template_purposes p on p.purpose = t.purpose
  where t.workspace_id = a.workspace_id
    and (t.artist_id = v_job.artist_id or t.artist_id is null)
    and t.purpose = v_job.message_purpose
    and t.channel = v_job.message_channel
    and t.locale = v_job.message_locale
    and t.status = 'active'
  order by (t.artist_id is not null) desc, t.version desc, t.id
  limit 1;

  if v_template.id is null or v_template.classification <> 'service'::public.message_classification then
    update public.automation_jobs
    set status = 'failed', attempt_count = attempt_count + 1,
        last_error_category = 'template_unavailable'
    where id = p_job_id;
    return 'failed';
  end if;

  v_block_reason := crm_private.client_send_block_reason(
    v_session.client_id,
    v_job.message_channel,
    v_template.classification
  );

  if v_block_reason is not null then
    update public.automation_jobs
    set status = 'cancelled', cancelled_at = now(),
        last_error_category = 'client_blocked'
    where id = p_job_id;
    return 'blocked';
  end if;

  if not exists (
    select 1
    from public.artist_integrations i
    where i.artist_id = v_job.artist_id
      and i.integration_type = 'email'::public.artist_integration_type
      and i.provider = 'google'
      and i.is_enabled
      and i.external_account_label is not null
      and btrim(i.external_account_label) <> ''
  ) then
    update public.automation_jobs
    set status = 'failed', attempt_count = attempt_count + 1,
        last_error_category = 'integration_unavailable'
    where id = p_job_id;
    return 'failed';
  end if;

  v_subject := crm_private.render_lifecycle_template_text(v_template.subject, v_session.id);
  v_body := crm_private.render_lifecycle_template_text(v_template.body, v_session.id);

  if v_subject is null or btrim(v_subject) = ''
     or v_body is null or btrim(v_body) = '' then
    update public.automation_jobs
    set status = 'failed', attempt_count = attempt_count + 1,
        last_error_category = 'template_unavailable'
    where id = p_job_id;
    return 'failed';
  end if;

  begin
    insert into public.email_messages (
      status, artist_id, client_id, enquiry_id, project_id,
      to_email, subject, body,
      template_key, template_version,
      created_by, created_by_kind, approved_by, approved_at,
      automation_job_id
    ) values (
      'approved', v_job.artist_id, v_session.client_id,
      v_session.enquiry_id, v_session.project_id,
      v_to_email, v_subject, v_body,
      v_template.purpose, v_template.version,
      null, 'system', null, now(),
      v_job.id
    )
    on conflict do nothing
    returning id into v_message_id;

    if v_message_id is null then
      select m.id into v_message_id
      from public.email_messages m
      where m.automation_job_id = v_job.id;
    end if;

    if v_message_id is null then
      raise exception 'lifecycle email idempotency could not resolve a message';
    end if;

    v_outbox_id := crm_private.enqueue_outbox(
      'approved_email',
      'email:automation:' || v_job.id::text,
      jsonb_build_object('email_message_id', v_message_id),
      v_session.client_id,
      v_session.enquiry_id,
      v_session.project_id,
      v_session.id,
      v_message_id
    );

    update public.automation_jobs
    set status = 'completed', completed_at = now(),
        attempt_count = attempt_count + 1,
        last_error_category = 'none'
    where id = p_job_id;

    perform crm_private.log_artist_activity(
      v_job.artist_id,
      'email.automation_queued',
      'system',
      null,
      v_session.client_id,
      v_session.enquiry_id,
      v_session.project_id,
      v_session.id,
      null,
      jsonb_build_object(
        'automation_job_id', v_job.id,
        'email_message_id', v_message_id,
        'purpose', v_template.purpose
      )
    );
  exception when others then
    update public.automation_jobs
    set status = 'failed', attempt_count = attempt_count + 1,
        last_error_category = 'unknown'
    where id = p_job_id;
    return 'failed';
  end;

  return 'queued';
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Scheduler: materialise, reconcile, withdraw, then execute
-- ---------------------------------------------------------------------------

create or replace function public.service_run_automation_tick(p_limit integer default 100)
returns table (
  materialised integer,
  withdrawn    integer,
  executed     integer,
  notified     integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, crm_private
as $$
declare
  v_materialised integer := 0;
  v_withdrawn integer := 0;
  v_executed integer := 0;
  v_notified integer := 0;
  v_client_job record;
  v_client_result text;
begin
  if not crm_private.is_service_backend() then
    raise exception 'automation ticks are backend-only' using errcode = '42501';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'automation tick limit must be between 1 and 500' using errcode = '22023';
  end if;

  with pairs as (
    select r.id as rule_id, r.version, e.id as event_id, e.artist_id,
           r.action_type, r.action_title, r.action_body, r.action_priority,
           r.schedule_anchor, r.anchor_offset_minutes,
           r.condition_appointment_type,
           r.message_purpose, r.message_channel, r.message_locale,
           case
             when r.action_type = 'send_client_message'::public.automation_action_type
             then e.entity_id
             else null
           end as session_id,
           crm_private.resolve_automation_scheduled_at(
             r.schedule_anchor,
             r.delay_minutes,
             r.anchor_offset_minutes,
             e.occurred_at,
             e.artist_id,
             e.entity_kind,
             e.entity_id,
             r.condition_appointment_type
           ) as scheduled_at
    from public.automation_events e
    join public.automation_rules r
      on r.artist_id = e.artist_id
     and r.trigger_event_type = e.event_type
     and r.is_enabled
    where (r.condition_from_status is null or r.condition_from_status = e.from_status)
      and (r.condition_to_status is null or r.condition_to_status = e.to_status)
      and not exists (
        select 1 from public.automation_jobs j
        where j.rule_id = r.id and j.event_id = e.id
      )
    order by e.occurred_at, e.id
    limit p_limit
  ),
  inserted as (
    insert into public.automation_jobs (
      rule_id, rule_version, event_id, artist_id,
      action_type, action_title, action_body, action_priority,
      schedule_anchor, anchor_offset_minutes, condition_appointment_type,
      message_purpose, message_channel, message_locale,
      session_id, scheduled_at
    )
    select rule_id, version, event_id, artist_id,
           action_type, action_title, action_body, action_priority,
           schedule_anchor, anchor_offset_minutes, condition_appointment_type,
           message_purpose, message_channel, message_locale,
           session_id, scheduled_at
    from pairs
    where scheduled_at is not null
    on conflict do nothing
    returning 1
  )
  select count(*)::int into v_materialised from inserted;

  -- Withdraw stale rule snapshots first. A later reschedule never revives work
  -- that was explicitly disabled or edited.
  with stale as (
    update public.automation_jobs j
    set status = 'cancelled',
        cancelled_at = now(),
        last_error_category = 'rule_withdrawn'
    from public.automation_rules r
    where j.rule_id = r.id
      and j.status = 'pending'
      and (not r.is_enabled or r.version <> j.rule_version)
    returning 1
  )
  select count(*)::int into v_withdrawn from stale;

  -- Reconcile every still-pending lifecycle job from the authoritative session.
  -- This is the reschedule primitive: the domain row moves, the job follows.
  update public.automation_jobs j
  set scheduled_at = case j.schedule_anchor
        when 'session_start'::public.automation_schedule_anchor
          then s.start_at + make_interval(mins => j.anchor_offset_minutes)
        when 'session_end'::public.automation_schedule_anchor
          then s.end_at + make_interval(mins => j.anchor_offset_minutes)
        else j.scheduled_at
      end
  from public.sessions s
  where j.status = 'pending'
    and j.action_type = 'send_client_message'::public.automation_action_type
    and s.id = j.session_id
    and s.artist_id = j.artist_id
    and j.scheduled_at is distinct from case j.schedule_anchor
        when 'session_start'::public.automation_schedule_anchor
          then s.start_at + make_interval(mins => j.anchor_offset_minutes)
        when 'session_end'::public.automation_schedule_anchor
          then s.end_at + make_interval(mins => j.anchor_offset_minutes)
        else j.scheduled_at
      end;

  -- Definitive appointment states cancel pending lifecycle work. Proposed/draft
  -- are deliberately not terminal: a later confirmation may still make a due
  -- reminder eligible, and the next tick will pick it up.
  update public.automation_jobs j
  set status = 'cancelled', cancelled_at = now(),
      last_error_category = 'appointment_ineligible'
  where j.status = 'pending'
    and j.action_type = 'send_client_message'::public.automation_action_type
    and (
      not exists (
        select 1 from public.sessions s
        where s.id = j.session_id
          and s.artist_id = j.artist_id
          and s.appointment_type = j.condition_appointment_type
      )
      or exists (
        select 1 from public.sessions s
        where s.id = j.session_id
          and s.artist_id = j.artist_id
          and (
            (j.schedule_anchor = 'session_start'::public.automation_schedule_anchor
             and s.status in ('cancelled', 'no_show', 'completed'))
            or
            (j.schedule_anchor = 'session_end'::public.automation_schedule_anchor
             and s.status in ('cancelled', 'no_show'))
          )
      )
    );

  -- Legacy artist-team notification execution is unchanged.
  with due as (
    select j.id, j.artist_id, j.action_title, j.action_body, j.action_priority,
           e.entity_kind, e.entity_id
    from public.automation_jobs j
    join public.automation_events e on e.id = j.event_id
    join crm_private.artist_state s on s.artist_id = j.artist_id and s.is_active
    where j.status = 'pending'
      and j.scheduled_at <= now()
      and j.action_type = 'notify_artist_team'
      and crm_private.automations_enabled_for_artist(j.artist_id)
    order by j.scheduled_at, j.id
    limit p_limit
  ),
  targeted as (
    select d.*, r.profile_id
    from due d
    cross join lateral crm_private.automation_notification_recipients(d.artist_id) r
  ),
  sent as (
    insert into public.notifications (
      recipient_profile_id, artist_id, notification_type, title, body,
      entity_type, entity_id, priority, status, dedupe_key,
      scheduled_at, delivered_at
    )
    select t.profile_id, t.artist_id, 'automation.triggered',
           t.action_title, t.action_body,
           case when t.entity_id is not null then t.entity_kind end,
           t.entity_id, t.action_priority,
           'delivered',
           'automation_job:' || t.id::text || ':' || t.profile_id::text,
           now(), now()
    from targeted t
    on conflict (dedupe_key) do nothing
    returning 1
  ),
  finished as (
    update public.automation_jobs j
    set status = 'completed',
        completed_at = now(),
        attempt_count = j.attempt_count + 1,
        last_error_category = case
          when exists (select 1 from targeted t where t.id = j.id) then 'none'
          else 'no_recipient'
        end
    where j.id in (select id from due)
    returning 1
  )
  select (select count(*)::int from finished), (select count(*)::int from sent)
  into v_executed, v_notified;

  -- Client work is executed one locked job at a time. The helper rechecks every
  -- live gate under that lock and creates email + outbox atomically.
  for v_client_job in
    select j.id
    from public.automation_jobs j
    join public.sessions s
      on s.id = j.session_id
     and s.artist_id = j.artist_id
    join crm_private.artist_state a
      on a.artist_id = j.artist_id
     and a.is_active
    where j.status = 'pending'
      and j.action_type = 'send_client_message'::public.automation_action_type
      and j.scheduled_at <= now()
      and crm_private.automations_enabled_for_artist(j.artist_id)
      and (
        (j.schedule_anchor = 'session_start'::public.automation_schedule_anchor
         and s.status = 'confirmed')
        or
        (j.schedule_anchor = 'session_end'::public.automation_schedule_anchor
         and s.status = 'completed')
      )
    order by j.scheduled_at, j.id
    limit p_limit
  loop
    v_client_result := crm_private.execute_client_lifecycle_job(v_client_job.id);
    if v_client_result in ('queued', 'failed', 'blocked', 'cancelled') then
      v_executed := v_executed + 1;
    end if;
  end loop;

  return query select v_materialised, v_withdrawn, v_executed, v_notified;
end;
$$;

comment on function public.service_run_automation_tick(integer) is
  'Materialises, reconciles, withdraws and executes artist-team and client-lifecycle automation. Client lifecycle schedules are re-derived from the live session and provider delivery remains in the approved-email outbox.';

-- ---------------------------------------------------------------------------
-- 8. Private helper boundary
-- ---------------------------------------------------------------------------

revoke all on function crm_private.guard_client_automation_definition()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.guard_email_automation_job()
  from public, anon, authenticated, service_role;
revoke all on function crm_private.resolve_automation_scheduled_at(
  public.automation_schedule_anchor, integer, integer, timestamptz,
  uuid, text, uuid, public.appointment_type
) from public, anon, authenticated, service_role;
revoke all on function crm_private.render_lifecycle_template_text(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.execute_client_lifecycle_job(uuid)
  from public, anon, authenticated, service_role;

-- Keep the existing backend-only tick grant after CREATE OR REPLACE.
revoke all on function public.service_run_automation_tick(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.service_run_automation_tick(integer) to service_role;
