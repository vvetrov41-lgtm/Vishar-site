begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Shape and privileges
-- ---------------------------------------------------------------------------

select ok(
  (select bool_and(
    has_function_privilege('authenticated', f, 'EXECUTE')
    and not has_function_privilege('anon', f, 'EXECUTE')
    and not has_function_privilege('service_role', f, 'EXECUTE'))
   from unnest(array[
     'public.create_client_lifecycle_rule(uuid,text,public.appointment_type,text,public.automation_schedule_anchor,integer,text)',
     'public.set_automation_rule_enabled(uuid,boolean)',
     'public.upsert_message_template(uuid,text,public.message_template_channel,text,text,text,uuid)',
     'public.set_message_template_active(uuid,boolean)'
   ]) f),
  'configuration mutations remain authenticated-human-only RPCs'
);

select ok(
  (select bool_and(
    p.prosecdef
    and 'search_path=pg_catalog, public, crm_private' = any(p.proconfig))
   from unnest(array[
     'public.create_client_lifecycle_rule(uuid,text,public.appointment_type,text,public.automation_schedule_anchor,integer,text)'::regprocedure,
     'public.set_automation_rule_enabled(uuid,boolean)'::regprocedure,
     'public.upsert_message_template(uuid,text,public.message_template_channel,text,text,text,uuid)'::regprocedure,
     'public.set_message_template_active(uuid,boolean)'::regprocedure
   ]) f(oid)
   join pg_proc p on p.oid = f.oid),
  'configuration mutations are SECURITY DEFINER with pinned search paths'
);

-- ---------------------------------------------------------------------------
-- Fixtures: two isolated Artists and one genuine manager for each
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('fb100000-0000-4000-8000-000000000001', 'audit-manager@example.test'),
  ('fb100000-0000-4000-8000-000000000002', 'audit-outsider@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('fb100000-0000-4000-8000-000000000001', 'audit-manager@example.test',
   'Audit Manager', 'booking_manager', true),
  ('fb100000-0000-4000-8000-000000000002', 'audit-outsider@example.test',
   'Audit Outsider', 'booking_manager', true);

insert into public.workspaces (id, slug, display_name, workspace_type, is_active) values
  ('fb200000-0000-4000-8000-000000000001', 'audit-home', 'Audit Home', 'studio', true),
  ('fb200000-0000-4000-8000-000000000002', 'audit-foreign', 'Audit Foreign', 'studio', true);

insert into public.artists (id, workspace_id, slug, display_name, is_active) values
  ('fb300000-0000-4000-8000-000000000001', 'fb200000-0000-4000-8000-000000000001',
   'audit-home-artist', 'Audit Home Artist', true),
  ('fb300000-0000-4000-8000-000000000002', 'fb200000-0000-4000-8000-000000000002',
   'audit-foreign-artist', 'Audit Foreign Artist', true);

insert into public.workspace_memberships (
  profile_id, workspace_id, workspace_role,
  can_manage_workspace, can_manage_team, can_manage_integrations, is_active
) values
  ('fb100000-0000-4000-8000-000000000001', 'fb200000-0000-4000-8000-000000000001',
   'admin', true, false, false, true),
  ('fb100000-0000-4000-8000-000000000002', 'fb200000-0000-4000-8000-000000000002',
   'admin', true, false, false, true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active, grant_source
) values
  ('fb100000-0000-4000-8000-000000000001', 'fb300000-0000-4000-8000-000000000001',
   'manager', false, false, false, true, true, 'explicit'),
  ('fb100000-0000-4000-8000-000000000002', 'fb300000-0000-4000-8000-000000000002',
   'manager', false, false, false, true, true, 'explicit');

create function pg_temp.as_audit_profile(p_profile uuid) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    json_build_object('sub', p_profile, 'role', 'authenticated')::text,
    true
  )::void;
$$;
grant execute on function pg_temp.as_audit_profile(uuid) to authenticated;

create temporary table audit_ids (slot text primary key, id uuid not null);
grant select, insert on audit_ids to authenticated;

create temporary table audit_side_effect_counts_before as
select
  (select count(*) from public.automation_jobs) as jobs,
  (select count(*) from public.email_messages) as emails,
  (select count(*) from public.integration_outbox) as outbox;

-- ---------------------------------------------------------------------------
-- Rule create and enable audit
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.as_audit_profile('fb100000-0000-4000-8000-000000000001');
set local role authenticated;

insert into audit_ids values (
  'home-rule',
  public.create_client_lifecycle_rule(
    'fb300000-0000-4000-8000-000000000001',
    'Audited reminder',
    'tattoo_session',
    'session_reminder_24h',
    'session_start',
    -1440,
    'en'
  )
);

select ok(
  public.set_automation_rule_enabled(
    (select id from audit_ids where slot = 'home-rule'), true
  ),
  'an authorized manager can enable the rule'
);
select ok(
  public.set_automation_rule_enabled(
    (select id from audit_ids where slot = 'home-rule'), true
  ),
  'repeating the same enable request returns the actual state'
);

reset role;

select is(
  (select metadata from public.activity_log
   where event_type = 'automation.rule_created'
     and metadata ->> 'rule_id' = (select id::text from audit_ids where slot = 'home-rule')),
  jsonb_build_object(
    'rule_id', (select id from audit_ids where slot = 'home-rule'),
    'after', jsonb_build_object(
      'action_type', 'send_client_message',
      'appointment_type', 'tattoo_session',
      'message_purpose', 'session_reminder_24h',
      'message_channel', 'email',
      'message_locale', 'en',
      'schedule_anchor', 'session_start',
      'anchor_offset_minutes', -1440,
      'is_enabled', false,
      'version', 1
    )
  ),
  'rule creation records the stable rule id and complete bounded initial state'
);

select is(
  (select metadata from public.activity_log
   where event_type = 'automation.rule_updated'
     and metadata ->> 'rule_id' = (select id::text from audit_ids where slot = 'home-rule')),
  jsonb_build_object(
    'rule_id', (select id from audit_ids where slot = 'home-rule'),
    'before', jsonb_build_object('is_enabled', false, 'version', 1),
    'after', jsonb_build_object('is_enabled', true, 'version', 1)
  ),
  'enablement records truthful before and after state without inventing a semantic version'
);

select is(
  (select count(*)::integer from public.activity_log
   where event_type = 'automation.rule_updated'
     and metadata ->> 'rule_id' = (select id::text from audit_ids where slot = 'home-rule')),
  1,
  'an identical enable request is an audited no-op rather than a duplicate event'
);

select is(
  (select actor_profile_id from public.activity_log
   where event_type = 'automation.rule_updated'
     and metadata ->> 'rule_id' = (select id::text from audit_ids where slot = 'home-rule')),
  'fb100000-0000-4000-8000-000000000001'::uuid,
  'the enable audit identifies the authenticated actor'
);

-- A foreign manager creates a legitimate foreign rule. The home manager may
-- neither change it nor manufacture an audit event for it.
select pg_temp.as_audit_profile('fb100000-0000-4000-8000-000000000002');
set local role authenticated;
insert into audit_ids values (
  'foreign-rule',
  public.create_client_lifecycle_rule(
    'fb300000-0000-4000-8000-000000000002',
    'Foreign reminder',
    'tattoo_session',
    'session_reminder_24h',
    'session_start',
    -1440,
    'en'
  )
);
reset role;
select pg_temp.as_audit_profile('fb100000-0000-4000-8000-000000000001');
set local role authenticated;
select throws_ok(
  format(
    'select public.set_automation_rule_enabled(%L::uuid, true)',
    (select id from audit_ids where slot = 'foreign-rule')
  ),
  '42501', null,
  'a manager cannot enable another Artist rule'
);
reset role;

select is(
  (select count(*)::integer from public.activity_log
   where event_type = 'automation.rule_updated'
     and metadata ->> 'rule_id' = (select id::text from audit_ids where slot = 'foreign-rule')),
  0,
  'a denied cross-Artist rule mutation writes no audit event'
);

-- ---------------------------------------------------------------------------
-- Template creation and status-transition audit
-- ---------------------------------------------------------------------------

select pg_temp.as_audit_profile('fb100000-0000-4000-8000-000000000001');
set local role authenticated;

insert into audit_ids values
  ('home-template-v1', public.upsert_message_template(
    'fb200000-0000-4000-8000-000000000001', 'session_reminder_24h', 'email',
    'Private body one', 'en', 'Private subject one', 'fb300000-0000-4000-8000-000000000001')),
  ('home-template-v2', public.upsert_message_template(
    'fb200000-0000-4000-8000-000000000001', 'session_reminder_24h', 'email',
    'Private body two', 'en', 'Private subject two', 'fb300000-0000-4000-8000-000000000001')),
  ('workspace-template', public.upsert_message_template(
    'fb200000-0000-4000-8000-000000000001', 'session_reminder_24h', 'email',
    'Workspace private body', 'en', 'Workspace private subject', null));

select ok(
  public.set_message_template_active(
    (select id from audit_ids where slot = 'home-template-v1'), true
  ),
  'v1 can be activated'
);
select ok(
  public.set_message_template_active(
    (select id from audit_ids where slot = 'home-template-v2'), true
  ),
  'v2 can replace v1'
);
select ok(
  public.set_message_template_active(
    (select id from audit_ids where slot = 'home-template-v2'), true
  ),
  'repeating activation returns the actual active state'
);
select ok(
  not public.set_message_template_active(
    (select id from audit_ids where slot = 'home-template-v2'), false
  ),
  'the active version can be explicitly retired'
);
select ok(
  not public.set_message_template_active(
    (select id from audit_ids where slot = 'home-template-v2'), false
  ),
  'repeating retirement returns the actual inactive state'
);
reset role;

select is(
  (select metadata from public.activity_log
   where event_type = 'automation.template_created'
     and metadata ->> 'template_id' = (select id::text from audit_ids where slot = 'home-template-v2')),
  jsonb_build_object(
    'template_id', (select id from audit_ids where slot = 'home-template-v2'),
    'purpose', 'session_reminder_24h',
    'channel', 'email',
    'locale', 'en',
    'version', 2,
    'status', 'draft'
  ),
  'template creation records only stable slot state and the immutable version'
);

select is(
  (select count(*)::integer from public.activity_log
   where event_type = 'automation.template_created'
     and metadata ->> 'template_id' = (select id::text from audit_ids where slot = 'workspace-template')),
  0,
  'workspace policy does not masquerade as an Artist activity event'
);

select is(
  (select metadata from public.activity_log
   where event_type = 'automation.template_updated'
     and metadata ->> 'template_id' = (select id::text from audit_ids where slot = 'home-template-v2')
     and metadata #>> '{after,status}' = 'active'),
  jsonb_build_object(
    'template_id', (select id from audit_ids where slot = 'home-template-v2'),
    'purpose', 'session_reminder_24h',
    'channel', 'email',
    'locale', 'en',
    'version', 2,
    'before', jsonb_build_object('status', 'draft'),
    'after', jsonb_build_object('status', 'active'),
    'previous_active_versions_retired', 1
  ),
  'activating v2 records the replaced active-version count and bounded transition'
);

select is(
  (select metadata from public.activity_log
   where event_type = 'automation.template_updated'
     and metadata ->> 'template_id' = (select id::text from audit_ids where slot = 'home-template-v2')
     and metadata #>> '{after,status}' = 'retired'),
  jsonb_build_object(
    'template_id', (select id from audit_ids where slot = 'home-template-v2'),
    'purpose', 'session_reminder_24h',
    'channel', 'email',
    'locale', 'en',
    'version', 2,
    'before', jsonb_build_object('status', 'active'),
    'after', jsonb_build_object('status', 'retired'),
    'previous_active_versions_retired', 0
  ),
  'retiring v2 records its exact immutable version and bounded transition'
);

select is(
  (select count(*)::integer from public.activity_log
   where event_type = 'automation.template_updated'
     and metadata ->> 'template_id' = (select id::text from audit_ids where slot = 'home-template-v2')),
  2,
  'identical activation and retirement requests create no duplicate audit events'
);

select is(
  (select status::text from public.message_templates
   where id = (select id from audit_ids where slot = 'home-template-v1')),
  'retired',
  'the replaced template version remains retained as history'
);

select ok(
  not exists (
    select 1
    from public.activity_log a
    where a.artist_id = 'fb300000-0000-4000-8000-000000000001'
      and a.event_type like 'automation.%'
      and (
        a.metadata ?| array['subject', 'body', 'name', 'message', 'content']
        or a.metadata::text like '%Private subject%'
        or a.metadata::text like '%Private body%'
      )
  ),
  'automation audit metadata contains no template copy or forbidden text field'
);

-- A foreign Artist template is legitimate, but the home manager cannot select
-- it and a denied call cannot add a status-transition audit event.
select pg_temp.as_audit_profile('fb100000-0000-4000-8000-000000000002');
set local role authenticated;
insert into audit_ids values (
  'foreign-template',
  public.upsert_message_template(
    'fb200000-0000-4000-8000-000000000002', 'session_reminder_24h', 'email',
    'Foreign private body', 'en', 'Foreign private subject', 'fb300000-0000-4000-8000-000000000002'
  )
);
reset role;
select pg_temp.as_audit_profile('fb100000-0000-4000-8000-000000000001');
set local role authenticated;
select throws_ok(
  format(
    'select public.set_message_template_active(%L::uuid, true)',
    (select id from audit_ids where slot = 'foreign-template')
  ),
  '42501', null,
  'a manager cannot activate another Artist template'
);
reset role;

select is(
  (select count(*)::integer from public.activity_log
   where event_type = 'automation.template_updated'
     and metadata ->> 'template_id' = (select id::text from audit_ids where slot = 'foreign-template')),
  0,
  'a denied cross-Artist template mutation writes no audit event'
);

select is(
  (select count(*) from public.automation_jobs),
  (select jobs from audit_side_effect_counts_before),
  'configuration audit creates no automation job'
);
select is(
  (select count(*) from public.email_messages),
  (select emails from audit_side_effect_counts_before),
  'configuration audit creates no email'
);
select is(
  (select count(*) from public.integration_outbox),
  (select outbox from audit_side_effect_counts_before),
  'configuration audit creates no provider outbox row'
);

select * from finish(true);
rollback;
