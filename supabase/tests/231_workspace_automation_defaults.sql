-- 231_workspace_automation_defaults.sql
--
-- Migration 0083: workspace automation defaults are write-time blueprints, not
-- read-time inheritance. Every executable rule remains artist-scoped, a new
-- artist inherits nothing until an authorized explicit apply, and an artist
-- override survives later workspace edits until it is deliberately cleared.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Shape and closed control-plane boundary
-- ---------------------------------------------------------------------------

select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_class where oid = 'public.workspace_automation_defaults'::regclass),
  'workspace automation defaults have RLS enabled and forced'
);

select is(
  (select count(*)::int
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'workspace_automation_defaults'
     and data_type = 'jsonb'),
  0,
  'workspace defaults add no JSON rule language'
);

select has_column('public', 'automation_rules', 'workspace_default_id',
  'concrete artist rules record their workspace-default provenance');
select has_column('public', 'automation_rules', 'workspace_default_version',
  'concrete artist rules record the inherited default version');
select has_column('public', 'automation_rules', 'workspace_override',
  'concrete artist rules record explicit artist divergence');
select hasnt_column('public', 'workspace_automation_defaults', 'recipient_profile_id',
  'a workspace default cannot choose a notification recipient');

select ok(
  not has_table_privilege('authenticated', 'public.workspace_automation_defaults', 'SELECT')
  and not has_table_privilege('authenticated', 'public.workspace_automation_defaults', 'INSERT')
  and not has_table_privilege('service_role', 'public.workspace_automation_defaults', 'SELECT'),
  'API roles have no direct workspace-default table access'
);

select ok(
  not has_function_privilege('authenticated',
    'public.upsert_workspace_automation_default(uuid,uuid,text,text,text,text,text,text,integer,public.notification_priority,boolean)', 'EXECUTE')
  and not has_function_privilege('service_role',
    'public.upsert_workspace_automation_default(uuid,uuid,text,text,text,text,text,text,integer,public.notification_priority,boolean)', 'EXECUTE'),
  'the Phase P workspace control plane is not exposed to API roles yet'
);

select ok(
  not has_function_privilege('authenticated',
    'public.set_artist_automation_override(uuid,uuid,text,text,text,text,text,text,integer,public.notification_priority,boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.clear_artist_automation_override(uuid,uuid)', 'EXECUTE'),
  'artist override contracts are also closed until a later reviewed surface grants them'
);

select ok(
  (select bool_and(p.prosecdef and 'search_path=pg_catalog, public, crm_private' = any (p.proconfig))
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'crm_private')
     and p.proname in (
       'guard_workspace_automation_rule_source',
       'validate_workspace_automation_definition',
       'materialize_workspace_automation_default',
       'upsert_workspace_automation_default',
       'apply_workspace_automation_defaults_to_artist',
       'set_artist_automation_override',
       'clear_artist_automation_override',
       'list_workspace_automation_defaults'
     )),
  'every Phase P authority-bearing function is SECURITY DEFINER with pinned search_path'
);

-- 0081 stays the execution engine. A workspace default must never become a
-- second scheduler or a read-time inheritance branch inside the tick.
select ok(
  (select pg_get_functiondef(p.oid) not like '%workspace_automation_defaults%'
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'service_run_automation_tick'),
  'the validated 0081 automation tick is unchanged by workspace defaults'
);

-- ---------------------------------------------------------------------------
-- Fixtures: one studio, one rival workspace, and three kinds of operator
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('c9111111-1111-4111-8111-111111111111', 'auto.admin@example.test'),
  ('c9222222-2222-4222-8222-222222222222', 'auto.alice@example.test'),
  ('c9333333-3333-4333-8333-333333333333', 'auto.limited@example.test'),
  ('c9444444-4444-4444-8444-444444444444', 'auto.reader@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('c9111111-1111-4111-8111-111111111111', 'auto.admin@example.test', 'Automation Admin', 'booking_manager', true),
  ('c9222222-2222-4222-8222-222222222222', 'auto.alice@example.test', 'Alice Artist', 'booking_manager', true),
  ('c9333333-3333-4333-8333-333333333333', 'auto.limited@example.test', 'Limited Admin', 'booking_manager', true),
  ('c9444444-4444-4444-8444-444444444444', 'auto.reader@example.test', 'Automation Reader', 'read_only', true);

insert into public.workspaces (id, slug, display_name, workspace_type) values
  ('c7111111-1111-4111-8111-111111111111', 'automation-studio', 'Automation Studio', 'studio'),
  ('c7222222-2222-4222-8222-222222222222', 'automation-rival', 'Automation Rival', 'studio');

insert into public.artists (id, slug, display_name, workspace_id, is_active) values
  ('c8111111-1111-4111-8111-111111111111', 'automation-alice', 'Alice',
   'c7111111-1111-4111-8111-111111111111', true),
  ('c8222222-2222-4222-8222-222222222222', 'automation-bob', 'Bob',
   'c7111111-1111-4111-8111-111111111111', true),
  ('c8444444-4444-4444-8444-444444444444', 'automation-rival-artist', 'Rival',
   'c7222222-2222-4222-8222-222222222222', true);

insert into public.workspace_memberships
  (profile_id, workspace_id, workspace_role,
   can_manage_workspace, can_manage_team, can_manage_integrations, is_active)
values
  ('c9111111-1111-4111-8111-111111111111', 'c7111111-1111-4111-8111-111111111111',
   'admin', true, true, true, true),
  ('c9333333-3333-4333-8333-333333333333', 'c7111111-1111-4111-8111-111111111111',
   'admin', true, true, true, true);

insert into public.artist_memberships
  (profile_id, artist_id, access_level,
   can_manage_integrations, is_active)
values
  -- The workspace admin also holds explicit automation authority on both
  -- artists. Workspace membership alone is deliberately insufficient.
  ('c9111111-1111-4111-8111-111111111111', 'c8111111-1111-4111-8111-111111111111',
   'manager', true, true),
  ('c9111111-1111-4111-8111-111111111111', 'c8222222-2222-4222-8222-222222222222',
   'manager', true, true),
  -- Alice has no workspace membership. She can still override her own concrete
  -- artist rule because artist authority is independent from workspace power.
  ('c9222222-2222-4222-8222-222222222222', 'c8111111-1111-4111-8111-111111111111',
   'artist', true, true),
  -- Limited Admin can run the workspace but has artist authority only on Alice.
  ('c9333333-3333-4333-8333-333333333333', 'c8111111-1111-4111-8111-111111111111',
   'manager', true, true),
  ('c9444444-4444-4444-8444-444444444444', 'c8111111-1111-4111-8111-111111111111',
   'read_only', false, true);

create function pg_temp.auto_as(p uuid) returns void language sql as
  $$select set_config('request.jwt.claims',
      json_build_object('sub', p, 'role', 'authenticated')::text, true)::void$$;

-- ---------------------------------------------------------------------------
-- Workspace default creation expands to explicit artist rules
-- ---------------------------------------------------------------------------

select pg_temp.auto_as('c9111111-1111-4111-8111-111111111111');

create temporary table auto_default as
select public.upsert_workspace_automation_default(
  'c7111111-1111-4111-8111-111111111111',
  null,
  'Review new enquiries',
  'enquiry.created',
  'New enquiry needs review',
  'Open the enquiry and assign the next step.',
  null, null,
  10,
  'normal',
  false
) as id;

select is(
  (select count(*)::int from public.workspace_automation_defaults
   where id = (select id from auto_default)),
  1,
  'one workspace blueprint is stored'
);
select is(
  (select version from public.workspace_automation_defaults
   where id = (select id from auto_default)),
  1,
  'a new workspace default starts at version one'
);
select is(
  (select count(*)::int from public.automation_rules
   where workspace_default_id = (select id from auto_default)),
  2,
  'the default expands at write time to one concrete rule per current active artist'
);
select is(
  (select count(*)::int from public.automation_rules
   where workspace_default_id = (select id from auto_default)
     and workspace_default_version = 1
     and not workspace_override
     and not is_enabled),
  2,
  'materialized rules pin the source version and start with the default disabled state'
);
select is(
  (select count(distinct artist_id)::int from public.automation_rules
   where workspace_default_id = (select id from auto_default)),
  2,
  'materialisation produces explicit artist scopes rather than a workspace-scoped executable rule'
);

-- Conditions are deliberately typed and status-only.
select throws_ok(
  $$select public.upsert_workspace_automation_default(
      'c7111111-1111-4111-8111-111111111111', null,
      'Impossible status condition', 'enquiry.created', 'Title', null,
      null, 'accepted', 0, 'normal', false)$$,
  '22023', null,
  'a status condition cannot be attached to a non-status trigger'
);
select throws_ok(
  $$select public.upsert_workspace_automation_default(
      'c7111111-1111-4111-8111-111111111111', null,
      'Unknown trigger', 'enquiry.made_up', 'Title')$$,
  '22023', null,
  'an uncatalogued trigger is refused rather than becoming a stringly rule'
);

-- ---------------------------------------------------------------------------
-- A future artist inherits nothing until an explicit authorized apply
-- ---------------------------------------------------------------------------

insert into public.artists (id, slug, display_name, workspace_id, is_active) values
  ('c8333333-3333-4333-8333-333333333333', 'automation-charlie', 'Charlie',
   'c7111111-1111-4111-8111-111111111111', true);

select is(
  (select count(*)::int from public.automation_rules
   where artist_id = 'c8333333-3333-4333-8333-333333333333'
     and workspace_default_id = (select id from auto_default)),
  0,
  'adding an artist does not silently inherit a workspace automation default'
);

insert into public.artist_memberships
  (profile_id, artist_id, access_level, can_manage_integrations, is_active)
values
  ('c9111111-1111-4111-8111-111111111111', 'c8333333-3333-4333-8333-333333333333',
   'manager', true, true);

select is(
  public.apply_workspace_automation_defaults_to_artist(
    'c8333333-3333-4333-8333-333333333333'),
  1,
  'authorized onboarding explicitly applies the one existing workspace default'
);
select is(
  (select count(*)::int from public.automation_rules
   where artist_id = 'c8333333-3333-4333-8333-333333333333'
     and workspace_default_id = (select id from auto_default)),
  1,
  'the explicit apply produces Charlie''s concrete artist rule'
);

-- ---------------------------------------------------------------------------
-- Artist override survives workspace updates
-- ---------------------------------------------------------------------------

select pg_temp.auto_as('c9222222-2222-4222-8222-222222222222');
select lives_ok(
  format($$select public.set_artist_automation_override(
      %L::uuid,
      'c8111111-1111-4111-8111-111111111111'::uuid,
      'Alice review flow',
      'enquiry.status_changed',
      'Alice custom action',
      'Alice chose a different internal reminder.',
      null, 'reviewing', 60, 'high', true)$$,
      (select id from auto_default)),
  'an artist with manage_automations can override their concrete rule without workspace power'
);

select ok(
  (select workspace_override from public.automation_rules
   where artist_id = 'c8111111-1111-4111-8111-111111111111'
     and workspace_default_id = (select id from auto_default)),
  'the concrete Alice rule records deliberate divergence'
);
select is(
  (select action_title from public.automation_rules
   where artist_id = 'c8111111-1111-4111-8111-111111111111'
     and workspace_default_id = (select id from auto_default)),
  'Alice custom action',
  'the artist override owns the concrete action content'
);

select pg_temp.auto_as('c9111111-1111-4111-8111-111111111111');
select lives_ok(
  format($$select public.upsert_workspace_automation_default(
      'c7111111-1111-4111-8111-111111111111'::uuid,
      %L::uuid,
      'Review new enquiries',
      'enquiry.created',
      'Studio default changed',
      'This is the new studio-level internal reminder.',
      null, null, 30, 'normal', true)$$,
      (select id from auto_default)),
  'the workspace admin can revise a default when they still hold authority on every affected artist'
);

select is(
  (select version from public.workspace_automation_defaults
   where id = (select id from auto_default)),
  2,
  'changing the workspace default bumps its version'
);
select is(
  (select action_title from public.automation_rules
   where artist_id = 'c8111111-1111-4111-8111-111111111111'
     and workspace_default_id = (select id from auto_default)),
  'Alice custom action',
  'a later workspace edit does not overwrite an artist override'
);
select is(
  (select workspace_default_version from public.automation_rules
   where artist_id = 'c8111111-1111-4111-8111-111111111111'
     and workspace_default_id = (select id from auto_default)),
  1,
  'the override keeps the source version it diverged from'
);
select is(
  (select count(*)::int from public.automation_rules
   where workspace_default_id = (select id from auto_default)
     and artist_id in (
       'c8222222-2222-4222-8222-222222222222'::uuid,
       'c8333333-3333-4333-8333-333333333333'::uuid)
     and action_title = 'Studio default changed'
     and workspace_default_version = 2
     and is_enabled
     and not workspace_override),
  2,
  'non-overridden artist rules advance to the new default version and state'
);

-- Clearing the override is an explicit artist action and copies the current
-- default, not the old version Alice originally diverged from.
select pg_temp.auto_as('c9222222-2222-4222-8222-222222222222');
select lives_ok(
  format($$select public.clear_artist_automation_override(
      %L::uuid, 'c8111111-1111-4111-8111-111111111111'::uuid)$$,
      (select id from auto_default)),
  'the artist can explicitly return to the workspace default'
);
select ok(
  not (select workspace_override from public.automation_rules
       where artist_id = 'c8111111-1111-4111-8111-111111111111'
         and workspace_default_id = (select id from auto_default)),
  'clearing removes the override marker'
);
select is(
  (select action_title from public.automation_rules
   where artist_id = 'c8111111-1111-4111-8111-111111111111'
     and workspace_default_id = (select id from auto_default)),
  'Studio default changed',
  'clearing copies the current workspace content'
);
select is(
  (select workspace_default_version from public.automation_rules
   where artist_id = 'c8111111-1111-4111-8111-111111111111'
     and workspace_default_id = (select id from auto_default)),
  2,
  'clearing advances the artist copy to the current workspace version'
);

-- ---------------------------------------------------------------------------
-- Workspace power alone never becomes artist authority
-- ---------------------------------------------------------------------------

select pg_temp.auto_as('c9333333-3333-4333-8333-333333333333');
select throws_ok(
  format($$select public.upsert_workspace_automation_default(
      'c7111111-1111-4111-8111-111111111111'::uuid,
      %L::uuid,
      'Should fail', 'enquiry.created', 'Should fail')$$,
      (select id from auto_default)),
  '42501', null,
  'a workspace admin cannot update a default when they lack manage_automations on another affected artist'
);
select is(
  (select version from public.workspace_automation_defaults
   where id = (select id from auto_default)),
  2,
  'the refused partial-authority write leaves the default unchanged'
);

-- A privileged direct write cannot smuggle a default across a workspace either;
-- the table trigger is a second boundary below the RPC authorization.
select throws_ok(
  format($$insert into public.automation_rules (
      artist_id, name, trigger_event_type, action_title,
      workspace_default_id, workspace_default_version)
    values (
      'c8444444-4444-4444-8444-444444444444', 'Cross workspace',
      'enquiry.created', 'No', %L::uuid, 2)$$,
      (select id from auto_default)),
  '23514', null,
  'a concrete rule cannot carry a workspace default from another workspace'
);

-- A read-only artist cannot use the override contract even when called from
-- the migration-owner test context: the function re-evaluates auth.uid().
select pg_temp.auto_as('c9444444-4444-4444-8444-444444444444');
select throws_ok(
  format($$select public.set_artist_automation_override(
      %L::uuid, 'c8111111-1111-4111-8111-111111111111'::uuid,
      'Reader override', 'enquiry.created', 'No')$$,
      (select id from auto_default)),
  '42501', null,
  'read-only artist access cannot create an automation override'
);

-- ---------------------------------------------------------------------------
-- No hidden delivery side effects
-- ---------------------------------------------------------------------------

select is((select count(*)::int from public.notifications where notification_type = 'automation.triggered'),
          0,
          'managing defaults and overrides sends no notification by itself');
select is((select count(*)::int from public.integration_outbox
           where created_at >= transaction_timestamp()),
          0,
          'Phase P writes no provider outbox work');
select is((select count(*)::int from public.communication_outbox
           where created_at >= transaction_timestamp()),
          0,
          'Phase P writes no client communication');

select * from finish(true);
rollback;
