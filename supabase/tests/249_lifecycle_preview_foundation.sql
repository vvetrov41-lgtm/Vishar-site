-- 249_lifecycle_preview_foundation.sql
--
-- 0104 adds read-only Lifecycle Studio preview surfaces. Everything here is
-- synthetic and rolled back. No provider call is made.

begin;
select no_plan();

select has_function(
  'public', 'list_client_lifecycle_preview_sessions', array['uuid', 'integer'],
  'Lifecycle Studio has a bounded real-session picker RPC'
);
select has_function(
  'public', 'preview_client_lifecycle_rule', array['uuid', 'uuid', 'uuid'],
  'Lifecycle Studio has a bounded rule/session preview RPC'
);
select ok(
  has_function_privilege(
    'authenticated', 'public.list_client_lifecycle_preview_sessions(uuid,integer)', 'EXECUTE')
  and has_function_privilege(
    'authenticated', 'public.preview_client_lifecycle_rule(uuid,uuid,uuid)', 'EXECUTE'),
  'authenticated CRM users may call the bounded preview surfaces'
);
select ok(
  not has_function_privilege(
    'anon', 'public.list_client_lifecycle_preview_sessions(uuid,integer)', 'EXECUTE')
  and not has_function_privilege(
    'service_role', 'public.list_client_lifecycle_preview_sessions(uuid,integer)', 'EXECUTE')
  and not has_function_privilege(
    'anon', 'public.preview_client_lifecycle_rule(uuid,uuid,uuid)', 'EXECUTE')
  and not has_function_privilege(
    'service_role', 'public.preview_client_lifecycle_rule(uuid,uuid,uuid)', 'EXECUTE'),
  'preview does not create a second anonymous or backend policy path'
);
select ok(
  (select bool_and(p.prosecdef and 'search_path=pg_catalog, public, crm_private' = any(p.proconfig))
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'list_client_lifecycle_preview_sessions',
       'preview_client_lifecycle_rule')),
  'both preview RPCs are SECURITY DEFINER with pinned search_path'
);
select ok(
  not has_table_privilege('authenticated', 'public.automation_rules', 'SELECT')
  and not has_table_privilege('authenticated', 'public.automation_jobs', 'SELECT')
  and not has_table_privilege('authenticated', 'public.message_templates', 'SELECT'),
  'preview does not widen direct browser access to lifecycle policy tables'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('fb011111-1111-4111-8111-111111111111', 'preview-reader@example.test'),
  ('fb022222-2222-4222-8222-222222222222', 'preview-outsider@example.test'),
  ('fb033333-3333-4333-8333-333333333333', 'preview-no-finance@example.test');

-- The primary reader is a booking manager rather than an installation owner.
-- That avoids the owner bootstrap trigger silently creating the same synthetic
-- artist membership that this test needs to configure explicitly.
insert into public.profiles (id, email, display_name, role, is_active) values
  ('fb011111-1111-4111-8111-111111111111', 'preview-reader@example.test', 'Preview Reader', 'booking_manager', true),
  ('fb022222-2222-4222-8222-222222222222', 'preview-outsider@example.test', 'Preview Outsider', 'read_only', true),
  ('fb033333-3333-4333-8333-333333333333', 'preview-no-finance@example.test', 'Preview No Finance', 'read_only', true);

insert into public.workspaces (id, slug, display_name, workspace_type, is_active) values
  ('fb101111-1111-4111-8111-111111111111', 'preview-workspace-a', 'Preview Workspace A', 'studio', true),
  ('fb102222-2222-4222-8222-222222222222', 'preview-workspace-b', 'Preview Workspace B', 'studio', true);

insert into public.artists (id, slug, display_name, workspace_id, is_active) values
  ('fb201111-1111-4111-8111-111111111111', 'preview-artist-a', 'Preview Artist A',
   'fb101111-1111-4111-8111-111111111111', true),
  ('fb202222-2222-4222-8222-222222222222', 'preview-artist-b', 'Preview Artist B',
   'fb102222-2222-4222-8222-222222222222', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active, grant_source
) values
  ('fb011111-1111-4111-8111-111111111111', 'fb201111-1111-4111-8111-111111111111',
   'manager', true, false, false, false, true, 'explicit'),
  ('fb022222-2222-4222-8222-222222222222', 'fb202222-2222-4222-8222-222222222222',
   'read_only', false, false, false, false, true, 'explicit'),
  ('fb033333-3333-4333-8333-333333333333', 'fb201111-1111-4111-8111-111111111111',
   'read_only', false, false, false, false, true, 'explicit');

insert into public.clients (id, full_name, email) values
  ('fb301111-1111-4111-8111-111111111111', 'Preview Client', 'preview-client@example.test'),
  ('fb302222-2222-4222-8222-222222222222', 'Other Client', 'other-client@example.test');

insert into public.sessions (
  id, status, start_at, end_at, artist_id, appointment_type, client_id, notes
) values
  ('fb401111-1111-4111-8111-111111111111', 'completed', now() - interval '52 hours', now() - interval '48 hours',
   'fb201111-1111-4111-8111-111111111111', 'tattoo_session', 'fb301111-1111-4111-8111-111111111111',
   'completed preview fixture'),
  ('fb402222-2222-4222-8222-222222222222', 'confirmed', now() + interval '2 hours', now() + interval '6 hours',
   'fb201111-1111-4111-8111-111111111111', 'tattoo_session', 'fb301111-1111-4111-8111-111111111111',
   'action-link preview fixture'),
  ('fb403333-3333-4333-8333-333333333333', 'confirmed', now() + interval '1 day', now() + interval '1 day 4 hours',
   'fb202222-2222-4222-8222-222222222222', 'tattoo_session', 'fb302222-2222-4222-8222-222222222222',
   'cross-artist fixture');

insert into public.message_templates (
  id, workspace_id, artist_id, purpose, channel, locale, version, status, subject, body
) values
  ('fb501111-1111-4111-8111-111111111111',
   'fb101111-1111-4111-8111-111111111111', null,
   'post_session_checkin', 'email', 'en', 1, 'active',
   'Check-in for {{client_first_name}}',
   'Hi {{client_first_name}}, {{artist_display_name}} is checking in.'),
  ('fb502222-2222-4222-8222-222222222222',
   'fb101111-1111-4111-8111-111111111111', null,
   'session_reminder_24h', 'email', 'en', 1, 'active',
   'Appointment for {{client_first_name}}',
   E'Confirm: {{confirm_link}}\nReschedule: {{reschedule_link}}\nCancel: {{cancel_link}}');

insert into public.automation_rules (
  id, artist_id, name, trigger_event_type,
  condition_from_status, condition_to_status, delay_minutes,
  action_type, action_title, action_body, action_priority,
  is_enabled, version, schedule_anchor, anchor_offset_minutes,
  condition_appointment_type, message_purpose, message_channel, message_locale
) values
  ('fb601111-1111-4111-8111-111111111111',
   'fb201111-1111-4111-8111-111111111111', 'Preview post-session rule', 'appointment.scheduled',
   null, null, 0, 'send_client_message', 'Lifecycle preview', null, 'normal',
   true, 1, 'session_end', 1440, 'tattoo_session', 'post_session_checkin', 'email', 'en'),
  ('fb602222-2222-4222-8222-222222222222',
   'fb201111-1111-4111-8111-111111111111', 'Preview action-link rule', 'appointment.scheduled',
   null, null, 0, 'send_client_message', 'Lifecycle preview', null, 'normal',
   true, 1, 'session_start', -1440, 'tattoo_session', 'session_reminder_24h', 'email', 'en');

insert into public.artist_integrations (
  id, artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
) values (
  'fb701111-1111-4111-8111-111111111111',
  'fb201111-1111-4111-8111-111111111111',
  'email', 'google', 'preview-google-email',
  'preview-artist@example.test', '{}'::jsonb, true
);

create temporary table preview_counts_before as
select
  (select count(*) from public.automation_rules) as rules,
  (select count(*) from public.message_templates) as templates,
  (select count(*) from public.automation_jobs) as jobs,
  (select count(*) from public.email_messages) as emails,
  (select count(*) from public.integration_outbox) as outbox,
  (select count(*) from crm_private.appointment_client_action_tokens) as action_tokens;
grant select on preview_counts_before to public;

create function pg_temp.as_profile(p_profile uuid) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    json_build_object('sub', p_profile, 'role', 'authenticated')::text,
    true
  )::void;
$$;
grant execute on function pg_temp.as_profile(uuid) to authenticated;

reset role;
select pg_temp.as_profile('fb011111-1111-4111-8111-111111111111');
set local role authenticated;

select set_eq(
  $$select session_id from public.list_client_lifecycle_preview_sessions(
      'fb201111-1111-4111-8111-111111111111'::uuid, 50)$$,
  $$values
      ('fb401111-1111-4111-8111-111111111111'::uuid),
      ('fb402222-2222-4222-8222-222222222222'::uuid)$$,
  'the preview picker returns only real sessions from the requested artist scope'
);

select ok(
  (select eligible
   from public.preview_client_lifecycle_rule(
     'fb201111-1111-4111-8111-111111111111'::uuid,
     'fb601111-1111-4111-8111-111111111111'::uuid,
     'fb401111-1111-4111-8111-111111111111'::uuid)),
  'a completed due post-session session is currently eligible in preview'
);
select is(
  (select blocker
   from public.preview_client_lifecycle_rule(
     'fb201111-1111-4111-8111-111111111111'::uuid,
     'fb601111-1111-4111-8111-111111111111'::uuid,
     'fb401111-1111-4111-8111-111111111111'::uuid)),
  null,
  'eligible preview has no blocker'
);
select is(
  (select rendered_subject
   from public.preview_client_lifecycle_rule(
     'fb201111-1111-4111-8111-111111111111'::uuid,
     'fb601111-1111-4111-8111-111111111111'::uuid,
     'fb401111-1111-4111-8111-111111111111'::uuid)),
  'Check-in for Preview',
  'preview uses the production renderer for ordinary variables'
);
select is(
  (select rendered_body
   from public.preview_client_lifecycle_rule(
     'fb201111-1111-4111-8111-111111111111'::uuid,
     'fb601111-1111-4111-8111-111111111111'::uuid,
     'fb401111-1111-4111-8111-111111111111'::uuid)),
  'Hi Preview, Preview Artist A is checking in.',
  'preview renders the same artist/client values as the production path'
);
select is(
  (select template_scope
   from public.preview_client_lifecycle_rule(
     'fb201111-1111-4111-8111-111111111111'::uuid,
     'fb601111-1111-4111-8111-111111111111'::uuid,
     'fb401111-1111-4111-8111-111111111111'::uuid)),
  'workspace',
  'preview reports which active template scope actually wins'
);
select ok(
  (select integration_available
   from public.preview_client_lifecycle_rule(
     'fb201111-1111-4111-8111-111111111111'::uuid,
     'fb601111-1111-4111-8111-111111111111'::uuid,
     'fb401111-1111-4111-8111-111111111111'::uuid)),
  'preview reuses the production Gmail-integration availability gate'
);
select ok(
  (select rendered_body like '%[preview confirm link]%'
      and rendered_body like '%[preview reschedule link]%'
      and rendered_body like '%[preview cancel link]%'
      and rendered_body not like '%' || repeat('a', 64) || '%'
   from public.preview_client_lifecycle_rule(
     'fb201111-1111-4111-8111-111111111111'::uuid,
     'fb602222-2222-4222-8222-222222222222'::uuid,
     'fb402222-2222-4222-8222-222222222222'::uuid)),
  'action-link preview returns inert labels rather than a capability-shaped token'
);

reset role;
select pg_temp.as_profile('fb033333-3333-4333-8333-333333333333');
set local role authenticated;
select is(
  (select count(*)::int
   from public.list_client_lifecycle_preview_sessions(
     'fb201111-1111-4111-8111-111111111111'::uuid, 50)),
  2,
  'an active member without finance access may enumerate bounded session labels'
);
select is(
  (select count(*)::int
   from public.preview_client_lifecycle_rule(
     'fb201111-1111-4111-8111-111111111111'::uuid,
     'fb601111-1111-4111-8111-111111111111'::uuid,
     'fb401111-1111-4111-8111-111111111111'::uuid)),
  0,
  'full message preview requires finance read access because the shared renderer can expose deposit values'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.communication_suppressions (client_id, channel, reason, is_active)
values ('fb301111-1111-4111-8111-111111111111', 'email', 'bounced', true);
reset role;
select pg_temp.as_profile('fb011111-1111-4111-8111-111111111111');
set local role authenticated;
select is(
  (select suppression_reason
   from public.preview_client_lifecycle_rule(
     'fb201111-1111-4111-8111-111111111111'::uuid,
     'fb601111-1111-4111-8111-111111111111'::uuid,
     'fb401111-1111-4111-8111-111111111111'::uuid)),
  'suppressed',
  'preview exposes the normalized production suppression result'
);
select is(
  (select blocker
   from public.preview_client_lifecycle_rule(
     'fb201111-1111-4111-8111-111111111111'::uuid,
     'fb601111-1111-4111-8111-111111111111'::uuid,
     'fb401111-1111-4111-8111-111111111111'::uuid)),
  'client_blocked',
  'suppression prevents current eligibility without sending anything'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.communication_suppressions
set is_active = false, released_at = now()
where client_id = 'fb301111-1111-4111-8111-111111111111'::uuid;
update public.automation_rules
set is_enabled = false
where id = 'fb601111-1111-4111-8111-111111111111'::uuid;
reset role;
select pg_temp.as_profile('fb011111-1111-4111-8111-111111111111');
set local role authenticated;
select is(
  (select blocker
   from public.preview_client_lifecycle_rule(
     'fb201111-1111-4111-8111-111111111111'::uuid,
     'fb601111-1111-4111-8111-111111111111'::uuid,
     'fb401111-1111-4111-8111-111111111111'::uuid)),
  'rule_disabled',
  'disabled rules remain previewable but are explicitly ineligible'
);

reset role;
select pg_temp.as_profile('fb022222-2222-4222-8222-222222222222');
set local role authenticated;
select is(
  (select count(*)::int
   from public.list_client_lifecycle_preview_sessions(
     'fb201111-1111-4111-8111-111111111111'::uuid, 50)),
  0,
  'another artist scope cannot enumerate preview sessions'
);
select is(
  (select count(*)::int
   from public.preview_client_lifecycle_rule(
     'fb201111-1111-4111-8111-111111111111'::uuid,
     'fb601111-1111-4111-8111-111111111111'::uuid,
     'fb401111-1111-4111-8111-111111111111'::uuid)),
  0,
  'another artist scope cannot preview the rule/session pair'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.profiles
set is_active = false
where id = 'fb011111-1111-4111-8111-111111111111'::uuid;
reset role;
select pg_temp.as_profile('fb011111-1111-4111-8111-111111111111');
set local role authenticated;
select is(
  (select count(*)::int
   from public.list_client_lifecycle_preview_sessions(
     'fb201111-1111-4111-8111-111111111111'::uuid, 50)),
  0,
  'inactive identities cannot enumerate preview sessions'
);
select is(
  (select count(*)::int
   from public.preview_client_lifecycle_rule(
     'fb201111-1111-4111-8111-111111111111'::uuid,
     'fb602222-2222-4222-8222-222222222222'::uuid,
     'fb402222-2222-4222-8222-222222222222'::uuid)),
  0,
  'inactive identities cannot preview lifecycle behavior'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is((select count(*) from public.automation_rules), (select rules from preview_counts_before),
  'preview creates no automation rules or lifecycle product stages');
select is((select count(*) from public.message_templates), (select templates from preview_counts_before),
  'preview creates no message templates');
select is((select count(*) from public.automation_jobs), (select jobs from preview_counts_before),
  'preview creates no automation jobs');
select is((select count(*) from public.email_messages), (select emails from preview_counts_before),
  'preview creates no email messages');
select is((select count(*) from public.integration_outbox), (select outbox from preview_counts_before),
  'preview enqueues no provider outbox work');
select is((select count(*) from crm_private.appointment_client_action_tokens), (select action_tokens from preview_counts_before),
  'preview mints no appointment action capability');

select * from finish(true);
rollback;
