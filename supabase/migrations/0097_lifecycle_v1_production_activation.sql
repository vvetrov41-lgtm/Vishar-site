-- 0097_lifecycle_v1_production_activation.sql
--
-- Lifecycle Automation v1: the first configuration that makes the 0093-0096
-- engine actually do something.
--
-- Everything before this migration built the machinery and deliberately left it
-- inert: production carried zero automation rules, zero message templates and
-- zero automation jobs while the shared-cron heartbeat ran every five minutes
-- with nothing to find. This migration supplies exactly the configuration data
-- that turns the heartbeat into working automation, and nothing else. It adds
-- no table, no function, no trigger, no scheduler, no delivery path and no
-- credential.
--
-- What it configures, per active artist:
--
--   * tattoo session  -> reminder 72 hours before session start
--   * tattoo session  -> reminder/check-in 24 hours before session start
--   * consultation    -> reminder/check-in 24 hours before session start
--
-- and deliberately NOT a 72-hour consultation reminder. A consultation is a
-- short conversation, not a booked working day, so the 72-hour slot that exists
-- to protect a tattoo day has nothing to protect here.
--
-- `consultation` is two appointment types in this schema,
-- `in_person_consultation` and `video_consultation`, and a lifecycle rule is
-- conditioned on exactly one type. Covering "consultation" therefore takes two
-- rules against one shared template, not a widened scope.
-- `touch_up` is deliberately left unconfigured in v1.
--
-- Safety properties this migration relies on rather than re-implements:
--
--   * delivery stays on the existing path - an automation job creates a system
--     approved `email_messages` row, `crm_private.enqueue_outbox` puts an
--     `approved_email` job in `public.integration_outbox`, and the existing
--     Gmail Worker drains it. No new email path, no Gmail credential here;
--   * every send re-reads the live gates under the job lock: appointment type,
--     `confirmed` status, client email, consent/suppression, and the artist's
--     enabled Gmail integration;
--   * a reschedule moves the pending job because the scheduler re-derives
--     `scheduled_at` from the live session, and a cancellation/no-show/
--     completion cancels it. Neither needs a rule change;
--   * the global, workspace and per-artist automation kill switches are
--     unchanged and still stop everything configured here.
--
-- Applying this migration cannot itself send an email. A job only materialises
-- from an `appointment.scheduled` automation event, which is projected from a
-- new `activity_log` row; it is never backfilled from history. Appointments
-- booked before this migration therefore stay outside the automation until
-- something schedules them again, which is deliberate: this migration does not
-- enrol already-booked clients into automated email.

-- ---------------------------------------------------------------------------
-- 1. Service copy
--
-- Purposes `session_reminder_72h`, `session_reminder_24h` and
-- `consultation_reminder` already exist in the catalogue, all classified
-- `service`, so no purpose is invented here.
--
-- The bodies interpolate only catalogued variables that the renderer can always
-- resolve from the session itself: client first name, artist, studio, date and
-- time. `{{deposit_amount}}`, `{{enquiry_reference}}` and `{{booking_link}}`
-- are deliberately absent - the first two make the send fail closed whenever
-- the row is missing that data, and the third has no stored value at all.
--
-- The copy states only facts the CRM holds and asks the client to reply. It
-- asserts no deposit, cancellation, preparation or aftercare policy, because
-- no such policy is authoritative in this repository yet. Adding that wording
-- is a product decision, and it is a template edit through
-- `upsert_message_template` / `set_message_template_active` - not a schema
-- change and not a change to any rule below.
-- ---------------------------------------------------------------------------

with target as (
  select distinct a.workspace_id
  from public.artists a
  join crm_private.artist_state s on s.artist_id = a.id and s.is_active
),
copy (purpose, subject, body) as (
  values
    (
      'session_reminder_72h',
      'Your tattoo appointment with {{artist_display_name}} on {{appointment_date}}',
      'Hi {{client_first_name}},

This is a reminder that your tattoo appointment with {{artist_display_name}} at {{studio_name}} is on {{appointment_date}} at {{appointment_time}}.

If you need to move or cancel this appointment, please reply to this email as soon as you can so the time can be offered to someone else.

See you soon,
{{studio_name}}'
    ),
    (
      'session_reminder_24h',
      'Tomorrow: your tattoo appointment with {{artist_display_name}}',
      'Hi {{client_first_name}},

Your tattoo appointment with {{artist_display_name}} at {{studio_name}} is tomorrow, {{appointment_date}}, at {{appointment_time}}.

If anything has changed, or you have a question before then, just reply to this email.

See you tomorrow,
{{studio_name}}'
    ),
    (
      'consultation_reminder',
      'Tomorrow: your consultation with {{artist_display_name}}',
      'Hi {{client_first_name}},

Your consultation with {{artist_display_name}} is tomorrow, {{appointment_date}}, at {{appointment_time}}.

Please bring any reference images or ideas you would like to talk through.

If anything has changed, or you have a question before then, just reply to this email.

See you tomorrow,
{{studio_name}}'
    )
)
insert into public.message_templates (
  workspace_id, artist_id, purpose, channel, locale, status, subject, body, created_by
)
select t.workspace_id, null, c.purpose, 'email', 'en', 'active', c.subject, c.body, null
from target t
cross join copy c
where not exists (
  select 1
  from public.message_templates m
  where m.workspace_id = t.workspace_id
    and m.artist_id is null
    and m.purpose = c.purpose
    and m.channel = 'email'::public.message_template_channel
    and m.locale = 'en'
    and m.status = 'active'::public.message_template_status
);

-- ---------------------------------------------------------------------------
-- 2. Enabled lifecycle rules
--
-- These are written enabled. The control-plane RPC creates a rule disabled so
-- a human can review it before it runs; this migration IS that reviewed
-- decision, applied through the protected production release path, so a second
-- manual enable step would add ceremony without adding a reviewer.
--
-- Offsets are negative minutes before `session_start`: 4320 = 72h, 1440 = 24h.
-- `trigger_event_type` is `appointment.scheduled`, the only session-scoped
-- creation trigger in `automation_trigger_catalog`, which is what the
-- definition guard requires for a client message.
-- ---------------------------------------------------------------------------

with target as (
  select a.id as artist_id
  from public.artists a
  join crm_private.artist_state s on s.artist_id = a.id and s.is_active
),
spec (name, appointment_type, message_purpose, anchor_offset_minutes) as (
  values
    ('Tattoo session reminder - 72 hours',
     'tattoo_session', 'session_reminder_72h', -4320),
    ('Tattoo session check-in - 24 hours',
     'tattoo_session', 'session_reminder_24h', -1440),
    ('Consultation check-in - 24 hours (in person)',
     'in_person_consultation', 'consultation_reminder', -1440),
    ('Consultation check-in - 24 hours (video)',
     'video_consultation', 'consultation_reminder', -1440)
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
  'session_start'::public.automation_schedule_anchor,
  s.anchor_offset_minutes,
  s.appointment_type::public.appointment_type,
  s.message_purpose,
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
    and r.message_purpose = s.message_purpose
    and r.schedule_anchor = 'session_start'::public.automation_schedule_anchor
    and r.anchor_offset_minutes = s.anchor_offset_minutes
);

-- ---------------------------------------------------------------------------
-- 3. Post-conditions
--
-- Configuration-as-data is only reproducible if the migration refuses to leave
-- a half-configured installation behind. An enabled rule whose template is
-- missing would fail every job closed with `template_unavailable`; a template
-- with no rule would simply never be selected. Assert the pairing instead of
-- discovering it in production.
-- ---------------------------------------------------------------------------

do $$
declare
  v_artists integer;
  v_rules integer;
  v_orphans integer;
begin
  select count(*) into v_artists
  from public.artists a
  join crm_private.artist_state s on s.artist_id = a.id and s.is_active;

  select count(*) into v_rules
  from public.automation_rules r
  join crm_private.artist_state s on s.artist_id = r.artist_id and s.is_active
  where r.action_type = 'send_client_message'::public.automation_action_type
    and r.is_enabled;

  if v_rules <> v_artists * 4 then
    raise exception
      'lifecycle v1 expected 4 enabled client rules per active artist, found % for % artists',
      v_rules, v_artists;
  end if;

  select count(*) into v_orphans
  from public.automation_rules r
  join public.artists a on a.id = r.artist_id
  join crm_private.artist_state s on s.artist_id = r.artist_id and s.is_active
  where r.action_type = 'send_client_message'::public.automation_action_type
    and r.is_enabled
    and not exists (
      select 1
      from public.message_templates m
      where m.workspace_id = a.workspace_id
        and (m.artist_id = r.artist_id or m.artist_id is null)
        and m.purpose = r.message_purpose
        and m.channel = r.message_channel
        and m.locale = r.message_locale
        and m.status = 'active'::public.message_template_status
    );

  if v_orphans > 0 then
    raise exception
      'lifecycle v1 left % enabled client rule(s) with no active template', v_orphans;
  end if;
end
$$;
