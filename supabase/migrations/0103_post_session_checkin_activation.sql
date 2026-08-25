-- 0103_post_session_checkin_activation.sql
--
-- Activate the approved first post-session lifecycle stage on the existing
-- 0093-0100 engine and approved_email Gmail path.
--
-- Product configuration:
--   * 24 hours after authoritative session_end;
--   * tattoo_session and touch_up only;
--   * English only;
--   * service purpose post_session_checkin.
--
-- No consultation appointment type is enrolled. This migration adds no
-- scheduler, Worker, queue, provider route, credential or browser table grant.
-- Like 0097, it only supplies reviewed configuration data. Historical
-- appointments are not backfilled because lifecycle jobs materialise only from
-- a new appointment.scheduled automation event.

-- ---------------------------------------------------------------------------
-- 1. Approved English service copy, one workspace default per active workspace
-- ---------------------------------------------------------------------------

with target as (
  select distinct a.workspace_id
  from public.artists a
  join crm_private.artist_state s on s.artist_id = a.id and s.is_active
)
insert into public.message_templates (
  workspace_id, artist_id, purpose, channel, locale, status,
  subject, body, created_by
)
select
  t.workspace_id,
  null,
  'post_session_checkin',
  'email'::public.message_template_channel,
  'en',
  'active'::public.message_template_status,
  'How is your tattoo feeling today?',
  E'Hi {{client_first_name}},\n\nJust checking in after your tattoo session with {{artist_display_name}} yesterday.\n\nHow are you feeling, and how is the tattoo doing so far?\n\nPlease keep following the aftercare instructions you were given. If you have any questions or anything you are unsure about during the healing process, just reply to this email and let us know.\n\nThere is no need to reply if everything is going well.\n\nTake care,\n{{artist_display_name}}',
  null
from target t
where not exists (
  select 1
  from public.message_templates m
  where m.workspace_id = t.workspace_id
    and m.artist_id is null
    and m.purpose = 'post_session_checkin'
    and m.channel = 'email'::public.message_template_channel
    and m.locale = 'en'
    and m.status = 'active'::public.message_template_status
);

-- ---------------------------------------------------------------------------
-- 2. Two reviewed enabled rules per active artist
-- ---------------------------------------------------------------------------

with target as (
  select a.id as artist_id
  from public.artists a
  join crm_private.artist_state s on s.artist_id = a.id and s.is_active
),
spec (name, appointment_type) as (
  values
    ('Post-session check-in - tattoo session', 'tattoo_session'),
    ('Post-session check-in - touch-up', 'touch_up')
)
insert into public.automation_rules (
  artist_id, name, trigger_event_type,
  condition_from_status, condition_to_status, delay_minutes,
  action_type, action_title, action_body, action_priority,
  schedule_anchor, anchor_offset_minutes, condition_appointment_type,
  message_purpose, message_channel, message_locale,
  is_enabled, created_by
)
select
  t.artist_id,
  s.name,
  'appointment.scheduled',
  null, null, 0,
  'send_client_message'::public.automation_action_type,
  'Client lifecycle email',
  null,
  'normal'::public.notification_priority,
  'session_end'::public.automation_schedule_anchor,
  1440,
  s.appointment_type::public.appointment_type,
  'post_session_checkin',
  'email'::public.message_template_channel,
  'en',
  true,
  null
from target t
cross join spec s
where not exists (
  select 1
  from public.automation_rules r
  where r.artist_id = t.artist_id
    and r.action_type = 'send_client_message'::public.automation_action_type
    and r.condition_appointment_type = s.appointment_type::public.appointment_type
    and r.message_purpose = 'post_session_checkin'
    and r.schedule_anchor = 'session_end'::public.automation_schedule_anchor
    and r.anchor_offset_minutes = 1440
    and r.message_channel = 'email'::public.message_template_channel
    and r.message_locale = 'en'
);

-- ---------------------------------------------------------------------------
-- 3. Apply-time invariants
-- ---------------------------------------------------------------------------

do $$
declare
  v_active_artists integer;
  v_active_workspaces integer;
  v_enabled_rules integer;
  v_invalid_rules integer;
  v_active_templates integer;
  v_exact_copy integer;
  v_orphans integer;
begin
  select count(*), count(distinct a.workspace_id)
    into v_active_artists, v_active_workspaces
  from public.artists a
  join crm_private.artist_state s on s.artist_id = a.id and s.is_active;

  select count(*) into v_enabled_rules
  from public.automation_rules r
  where r.message_purpose = 'post_session_checkin'
    and r.is_enabled;

  if v_enabled_rules <> v_active_artists * 2 then
    raise exception
      'post-session activation expected 2 enabled rules per active artist, found % for % artists',
      v_enabled_rules, v_active_artists
      using errcode = '23514';
  end if;

  select count(*) into v_invalid_rules
  from public.automation_rules r
  where r.message_purpose = 'post_session_checkin'
    and r.is_enabled
    and (
      r.action_type <> 'send_client_message'::public.automation_action_type
      or r.trigger_event_type <> 'appointment.scheduled'
      or r.condition_from_status is not null
      or r.condition_to_status is not null
      or r.delay_minutes <> 0
      or r.schedule_anchor <> 'session_end'::public.automation_schedule_anchor
      or r.anchor_offset_minutes <> 1440
      or r.condition_appointment_type not in (
        'tattoo_session'::public.appointment_type,
        'touch_up'::public.appointment_type
      )
      or r.message_channel <> 'email'::public.message_template_channel
      or r.message_locale <> 'en'
      or r.action_body is not null
      or not exists (
        select 1
        from crm_private.artist_state s
        where s.artist_id = r.artist_id and s.is_active
      )
    );

  if v_invalid_rules > 0 then
    raise exception
      'post-session activation found % enabled rule(s) outside the approved scope',
      v_invalid_rules
      using errcode = '23514';
  end if;

  select count(*) into v_active_templates
  from public.message_templates t
  where t.purpose = 'post_session_checkin'
    and t.status = 'active'::public.message_template_status;

  if v_active_templates <> v_active_workspaces then
    raise exception
      'post-session activation expected one active template per active workspace, found % for % workspaces',
      v_active_templates, v_active_workspaces
      using errcode = '23514';
  end if;

  select count(*) into v_exact_copy
  from public.message_templates t
  where t.artist_id is null
    and t.purpose = 'post_session_checkin'
    and t.channel = 'email'::public.message_template_channel
    and t.locale = 'en'
    and t.status = 'active'::public.message_template_status
    and t.subject = 'How is your tattoo feeling today?'
    and t.body = E'Hi {{client_first_name}},\n\nJust checking in after your tattoo session with {{artist_display_name}} yesterday.\n\nHow are you feeling, and how is the tattoo doing so far?\n\nPlease keep following the aftercare instructions you were given. If you have any questions or anything you are unsure about during the healing process, just reply to this email and let us know.\n\nThere is no need to reply if everything is going well.\n\nTake care,\n{{artist_display_name}}';

  if v_exact_copy <> v_active_workspaces then
    raise exception
      'post-session activation copy is not exact for every active workspace'
      using errcode = '23514';
  end if;

  select count(*) into v_orphans
  from public.automation_rules r
  join public.artists a on a.id = r.artist_id
  where r.message_purpose = 'post_session_checkin'
    and r.is_enabled
    and not exists (
      select 1
      from public.message_templates t
      where t.workspace_id = a.workspace_id
        and (t.artist_id = r.artist_id or t.artist_id is null)
        and t.purpose = r.message_purpose
        and t.channel = r.message_channel
        and t.locale = r.message_locale
        and t.status = 'active'::public.message_template_status
    );

  if v_orphans > 0 then
    raise exception
      'post-session activation left % enabled rule(s) without an active template',
      v_orphans
      using errcode = '23514';
  end if;
end
$$;
