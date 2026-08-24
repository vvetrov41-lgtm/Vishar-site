-- 240_client_lifecycle_management.sql
--
-- Client lifecycle control-plane contract. Everything here is synthetic and
-- rolled back. The test proves that client-facing automation is explicit,
-- typed, capability-gated, service-template-only and reusable across artists.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Shape and ACL
-- ---------------------------------------------------------------------------

select is(
  (select array_agg(e.enumlabel::text order by e.enumsortorder)
   from pg_type t
   join pg_enum e on e.enumtypid = t.oid
   join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = 'public'
     and t.typname = 'automation_action_type'),
  array['notify_artist_team','send_client_message'],
  'the automation engine has exactly the reviewed staff and client actions'
);

select has_function('public', 'create_client_lifecycle_rule',
  array['uuid','text','appointment_type','text','automation_schedule_anchor','integer','text'],
  'artists have a typed lifecycle-rule authoring RPC');
select has_function('public', 'list_client_lifecycle_rules', array['uuid'],
  'artists have a lifecycle-rule read surface');
select has_function('public', 'upsert_workspace_client_lifecycle_default',
  array['uuid','uuid','text','appointment_type','text','automation_schedule_anchor','integer','text','boolean'],
  'studios have a typed lifecycle-default authoring RPC');
select has_function('public', 'list_workspace_client_lifecycle_defaults', array['uuid'],
  'studios have a lifecycle-default read surface');
select has_function('public', 'set_message_template_active', array['uuid','boolean'],
  'template activation is an explicit reviewed transition');

select ok(
  (select bool_and(
    has_function_privilege('authenticated', f, 'EXECUTE')
    and not has_function_privilege('anon', f, 'EXECUTE')
    and not has_function_privilege('service_role', f, 'EXECUTE'))
   from unnest(array[
    'public.create_client_lifecycle_rule(uuid,text,public.appointment_type,text,public.automation_schedule_anchor,integer,text)',
    'public.list_client_lifecycle_rules(uuid)',
    'public.upsert_workspace_client_lifecycle_default(uuid,uuid,text,public.appointment_type,text,public.automation_schedule_anchor,integer,text,boolean)',
    'public.list_workspace_client_lifecycle_defaults(uuid)',
    'public.set_message_template_active(uuid,boolean)'
   ]) f),
  'lifecycle policy is a human CRM surface, never anon or backend authority'
);

select ok(
  (select bool_and(p.prosecdef and 'search_path=pg_catalog, public, crm_private' = any (p.proconfig))
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'create_client_lifecycle_rule',
       'list_client_lifecycle_rules',
       'upsert_workspace_client_lifecycle_default',
       'list_workspace_client_lifecycle_defaults',
       'set_message_template_active')),
  'every lifecycle management entry point is SECURITY DEFINER with a pinned search_path'
);

-- ---------------------------------------------------------------------------
-- Fixtures: one studio, two artists, one operator who genuinely manages both
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('c9011111-1111-4111-8111-111111111111', 'life.operator@example.test'),
  ('c9022222-2222-4222-8222-222222222222', 'life.outsider@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('c9011111-1111-4111-8111-111111111111', 'life.operator@example.test',
   'Lifecycle Operator', 'booking_manager', true),
  ('c9022222-2222-4222-8222-222222222222', 'life.outsider@example.test',
   'Lifecycle Outsider', 'booking_manager', true);

insert into public.workspaces (id, slug, display_name, workspace_type, is_active) values
  ('c7011111-1111-4111-8111-111111111111', 'life-studio', 'Lifecycle Studio', 'studio', true);

insert into public.artists (id, slug, display_name, workspace_id, is_active) values
  ('c8011111-1111-4111-8111-111111111111', 'life-alpha', 'Lifecycle Alpha',
   'c7011111-1111-4111-8111-111111111111', true),
  ('c8022222-2222-4222-8222-222222222222', 'life-beta', 'Lifecycle Beta',
   'c7011111-1111-4111-8111-111111111111', true);

insert into public.workspace_memberships (
  profile_id, workspace_id, workspace_role,
  can_manage_workspace, can_manage_team, can_manage_integrations, is_active
) values (
  'c9011111-1111-4111-8111-111111111111',
  'c7011111-1111-4111-8111-111111111111',
  'admin', true, true, true, true
);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('c9011111-1111-4111-8111-111111111111',
   'c8011111-1111-4111-8111-111111111111',
   'artist', false, false, true, true, true),
  ('c9011111-1111-4111-8111-111111111111',
   'c8022222-2222-4222-8222-222222222222',
   'artist', false, false, true, true, true),
  ('c9022222-2222-4222-8222-222222222222',
   'c8022222-2222-4222-8222-222222222222',
   'artist', false, false, true, true, true);

create function pg_temp.life_as(p uuid) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    json_build_object('sub', p, 'role', 'authenticated')::text,
    true
  )::void;
$$;
grant execute on function pg_temp.life_as(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Artist rule authoring is typed and starts fail-closed
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.life_as('c9011111-1111-4111-8111-111111111111');
set local role authenticated;

select throws_ok(
  $$select public.create_client_lifecycle_rule(
      'c8011111-1111-4111-8111-111111111111'::uuid,
      'Promotion disguised as reminder',
      'tattoo_session'::public.appointment_type,
      'availability_announcement',
      'session_start'::public.automation_schedule_anchor,
      -1440,
      'en')$$,
  '22023', null,
  'a lifecycle rule cannot use a marketing purpose'
);

select throws_ok(
  $$select public.create_client_lifecycle_rule(
      'c8011111-1111-4111-8111-111111111111'::uuid,
      'Late reminder',
      'tattoo_session'::public.appointment_type,
      'session_reminder_24h',
      'session_start'::public.automation_schedule_anchor,
      60,
      'en')$$,
  '22023', null,
  'a pre-session lifecycle rule cannot schedule after the appointment starts'
);

create temporary table t_artist_rule as
select public.create_client_lifecycle_rule(
  'c8011111-1111-4111-8111-111111111111'::uuid,
  '24 hour tattoo reminder',
  'tattoo_session'::public.appointment_type,
  'session_reminder_24h',
  'session_start'::public.automation_schedule_anchor,
  -1440,
  'en'
) as id;
grant select on t_artist_rule to public;
reset role;

-- Raw table assertions intentionally run as the test owner. The authenticated
-- product role has no table grants and reaches the same state only through RPCs.
select is(
  (select action_type::text from public.automation_rules
   where id = (select id from t_artist_rule)),
  'send_client_message',
  'the typed RPC produces the client-message action'
);
select is(
  (select trigger_event_type from public.automation_rules
   where id = (select id from t_artist_rule)),
  'appointment.scheduled',
  'the caller never chooses an arbitrary lifecycle trigger'
);
select ok(
  not (select is_enabled from public.automation_rules
       where id = (select id from t_artist_rule)),
  'an artist lifecycle rule starts disabled'
);

select pg_temp.life_as('c9011111-1111-4111-8111-111111111111');
set local role authenticated;
select is(
  (select count(*)::int
   from public.list_client_lifecycle_rules('c8011111-1111-4111-8111-111111111111')),
  1,
  'the author can read the lifecycle rule through the bounded surface'
);
reset role;

select pg_temp.life_as('c9022222-2222-4222-8222-222222222222');
set local role authenticated;
select is(
  (select count(*)::int
   from public.list_client_lifecycle_rules('c8011111-1111-4111-8111-111111111111')),
  0,
  'an artist from another scope cannot read the rule'
);
reset role;

-- ---------------------------------------------------------------------------
-- Template activation is explicit and atomically replaces the active version
-- ---------------------------------------------------------------------------

select pg_temp.life_as('c9011111-1111-4111-8111-111111111111');
set local role authenticated;

create temporary table t_template_one as
select public.upsert_message_template(
  'c7011111-1111-4111-8111-111111111111'::uuid,
  'session_reminder_24h',
  'email'::public.message_template_channel,
  'Hi {{client_first_name}}, see you on {{appointment_date}} at {{appointment_time}}.',
  'en',
  'Appointment reminder',
  'c8011111-1111-4111-8111-111111111111'::uuid
) as id;
grant select on t_template_one to public;

select ok(
  public.set_message_template_active((select id from t_template_one), true),
  'the artist explicitly activates the first reviewed template'
);

create temporary table t_template_two as
select public.upsert_message_template(
  'c7011111-1111-4111-8111-111111111111'::uuid,
  'session_reminder_24h',
  'email'::public.message_template_channel,
  'Hi {{client_first_name}}, your session with {{artist_display_name}} is {{appointment_date}} at {{appointment_time}}.',
  'en',
  'Your tattoo session',
  'c8011111-1111-4111-8111-111111111111'::uuid
) as id;
grant select on t_template_two to public;

select ok(
  public.set_message_template_active((select id from t_template_two), true),
  'activating a reviewed replacement succeeds'
);
reset role;

select is(
  (select status::text from public.message_templates
   where id = (select id from t_template_one)),
  'retired',
  'the previous active version is retired atomically'
);
select is(
  (select status::text from public.message_templates
   where id = (select id from t_template_two)),
  'active',
  'and exactly the replacement is active'
);
select is(
  (select count(*)::int from public.message_templates
   where artist_id = 'c8011111-1111-4111-8111-111111111111'
     and purpose = 'session_reminder_24h'
     and channel = 'email'
     and locale = 'en'
     and status = 'active'),
  1,
  'one slot can never have two active templates'
);

-- ---------------------------------------------------------------------------
-- One workspace definition expands into explicit rules for every active artist
-- ---------------------------------------------------------------------------

select pg_temp.life_as('c9011111-1111-4111-8111-111111111111');
set local role authenticated;

create temporary table t_default as
select public.upsert_workspace_client_lifecycle_default(
  'c7011111-1111-4111-8111-111111111111'::uuid,
  null,
  'Studio 7 day tattoo reminder',
  'tattoo_session'::public.appointment_type,
  'session_reminder_7d',
  'session_start'::public.automation_schedule_anchor,
  -10080,
  'en',
  false
) as id;
grant select on t_default to public;

select is(
  (select materialized_artists
   from public.list_workspace_client_lifecycle_defaults(
     'c7011111-1111-4111-8111-111111111111')),
  2,
  'the workspace lifecycle blueprint materializes onto both active artists'
);
reset role;

select is(
  (select count(*)::int from public.automation_rules
   where workspace_default_id = (select id from t_default)),
  2,
  'materialization is two concrete artist-scoped rules, not runtime inheritance'
);
select ok(
  (select bool_and(
      action_type = 'send_client_message'::public.automation_action_type
      and condition_appointment_type = 'tattoo_session'::public.appointment_type
      and message_purpose = 'session_reminder_7d'
      and message_channel = 'email'::public.message_template_channel
      and schedule_anchor = 'session_start'::public.automation_schedule_anchor
      and anchor_offset_minutes = -10080
      and not is_enabled)
   from public.automation_rules
   where workspace_default_id = (select id from t_default)),
  'every materialized rule carries the same reviewed lifecycle policy and remains disabled'
);

-- ---------------------------------------------------------------------------
-- No artist-specific special case is present in the new management path
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public','crm_private')
     and p.proname in (
       'create_client_lifecycle_rule',
       'list_client_lifecycle_rules',
       'upsert_workspace_client_lifecycle_default',
       'list_workspace_client_lifecycle_defaults',
       'set_message_template_active')
     and p.prosrc ~* '(vladimir|kristina)'),
  0,
  'the lifecycle control plane names no pre-existing artist'
);

-- ---------------------------------------------------------------------------
-- System provenance is not a general exemption from approval
--
-- Migration 0093 lets an approved email exist with no approver, because a
-- lifecycle message has no human author to name. That relaxation is only sound
-- while it is tied to the job that produced it: otherwise any future insert
-- path could reach the no-approver branch by writing 'system'. The constraint
-- itself has to say so, not only the trigger.
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.email_messages (
      status, artist_id, client_id, to_email, subject, body,
      created_by, created_by_kind, approved_by, approved_at, automation_job_id
    ) values (
      'approved', 'c8011111-1111-4111-8111-111111111111'::uuid, null,
      'nobody@example.test', 'Unapproved', 'Body',
      null, 'system', null, now(), null)$$,
  '23514', null,
  'an approved system email with no lifecycle job is refused by the check constraint'
);

-- ---------------------------------------------------------------------------
-- An event a rule can never match must not starve the ones it can
--
-- A rule conditioned on one appointment type still sees every session event
-- its artist emits. Those pairs never produce a job, so if they are selected
-- into the batch they are selected again on every tick, forever, in
-- occurred_at order - and once there are more of them than the tick limit,
-- real reminders behind them are never scheduled. The regression is written
-- with a limit of one so a single unmatchable event is enough to prove it.
-- ---------------------------------------------------------------------------

insert into public.clients (id, full_name, email) values
  ('c6011111-1111-4111-8111-111111111111', 'Starvation Client', 'starve@example.test');

insert into public.projects
  (id, artist_id, client_id, status, title, currency)
values
  ('c5011111-1111-4111-8111-111111111111', 'c8011111-1111-4111-8111-111111111111',
   'c6011111-1111-4111-8111-111111111111', 'active', 'Starvation project', 'GBP');

-- The consultation is older, so it sorts first and would take the whole batch.
insert into public.sessions
  (id, artist_id, client_id, appointment_type, status, start_at, end_at)
values
  ('c4011111-1111-4111-8111-111111111111', 'c8011111-1111-4111-8111-111111111111',
   'c6011111-1111-4111-8111-111111111111', 'in_person_consultation', 'confirmed',
   date_trunc('hour', now()) + interval '20 days',
   date_trunc('hour', now()) + interval '20 days' + interval '30 minutes');

insert into public.sessions
  (id, artist_id, project_id, client_id, appointment_type, status, start_at, end_at)
values
  ('c4022222-2222-4222-8222-222222222222', 'c8011111-1111-4111-8111-111111111111',
   'c5011111-1111-4111-8111-111111111111',
   'c6011111-1111-4111-8111-111111111111', 'tattoo_session', 'confirmed',
   date_trunc('hour', now()) + interval '30 days',
   date_trunc('hour', now()) + interval '30 days' + interval '3 hours');

select pg_temp.life_as('c9011111-1111-4111-8111-111111111111');
set local role authenticated;
select ok(
  public.set_automation_rule_enabled((select id from t_artist_rule), true),
  'the tattoo-session reminder is switched on'
);
reset role;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select crm_private.log_artist_activity(
  'c8011111-1111-4111-8111-111111111111', 'appointment.scheduled', 'staff', null,
  'c6011111-1111-4111-8111-111111111111', null, null,
  'c4011111-1111-4111-8111-111111111111', null, '{}'::jsonb);
select crm_private.log_artist_activity(
  'c8011111-1111-4111-8111-111111111111', 'appointment.scheduled', 'staff', null,
  'c6011111-1111-4111-8111-111111111111', null,
  'c5011111-1111-4111-8111-111111111111',
  'c4022222-2222-4222-8222-222222222222', null, '{}'::jsonb);

-- One slot in the batch, and one unmatchable event ahead of the real one.
select is(
  (select materialised from public.service_run_automation_tick(1)),
  1,
  'the single available slot is spent on work that can actually be scheduled'
);
select is(
  (select count(*)::int from public.automation_jobs j
   where j.rule_id = (select id from t_artist_rule)
     and j.session_id = 'c4022222-2222-4222-8222-222222222222'),
  1,
  'the tattoo session behind the consultation is scheduled rather than starved'
);
select is(
  (select count(*)::int from public.automation_jobs j
   where j.rule_id = (select id from t_artist_rule)
     and j.session_id = 'c4011111-1111-4111-8111-111111111111'),
  0,
  'and the consultation the rule does not apply to produces no job at all'
);

select * from finish(true);
rollback;