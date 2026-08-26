begin;
select plan(25);

insert into auth.users (id, email) values
  ('fa100000-0000-4000-8000-000000000001', 'template-manager@example.test'),
  ('fa100000-0000-4000-8000-000000000002', 'template-outsider@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('fa100000-0000-4000-8000-000000000001', 'template-manager@example.test', 'Template Manager', 'booking_manager', true),
  ('fa100000-0000-4000-8000-000000000002', 'template-outsider@example.test', 'Template Outsider', 'booking_manager', true);

insert into public.workspaces (id, slug, display_name, workspace_type, is_active) values
  ('fa200000-0000-4000-8000-000000000001', 'template-home', 'Template Home', 'studio', true),
  ('fa200000-0000-4000-8000-000000000002', 'template-foreign', 'Template Foreign', 'studio', true);

insert into public.artists (id, workspace_id, slug, display_name, is_active) values
  ('fa300000-0000-4000-8000-000000000001', 'fa200000-0000-4000-8000-000000000001', 'template-home-artist', 'Template Home Artist', true),
  ('fa300000-0000-4000-8000-000000000002', 'fa200000-0000-4000-8000-000000000002', 'template-foreign-artist', 'Template Foreign Artist', true);

insert into public.workspace_memberships (
  profile_id, workspace_id, workspace_role,
  can_manage_workspace, can_manage_team, can_manage_integrations, is_active
) values (
  'fa100000-0000-4000-8000-000000000001',
  'fa200000-0000-4000-8000-000000000001',
  'admin', true, false, false, true
);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active, grant_source
) values
  ('fa100000-0000-4000-8000-000000000001', 'fa300000-0000-4000-8000-000000000001',
   'manager', false, false, false, true, true, 'explicit'),
  ('fa100000-0000-4000-8000-000000000002', 'fa300000-0000-4000-8000-000000000002',
   'manager', false, false, false, true, true, 'explicit');

create function pg_temp.as_template_profile(p_profile uuid) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    json_build_object('sub', p_profile, 'role', 'authenticated')::text,
    true
  )::void;
$$;
grant execute on function pg_temp.as_template_profile(uuid) to authenticated;

create temporary table template_side_effect_counts_before as
select
  (select count(*) from public.automation_jobs) as jobs,
  (select count(*) from public.email_messages) as emails,
  (select count(*) from public.integration_outbox) as outbox;

select ok(
  has_function_privilege('authenticated', 'public.upsert_message_template(uuid,text,public.message_template_channel,text,text,text,uuid)', 'EXECUTE'),
  'authenticated can create a reviewed template draft'
);
select ok(
  not has_function_privilege('anon', 'public.upsert_message_template(uuid,text,public.message_template_channel,text,text,text,uuid)', 'EXECUTE'),
  'anon cannot create a template draft'
);
select ok(
  not has_function_privilege('service_role', 'public.upsert_message_template(uuid,text,public.message_template_channel,text,text,text,uuid)', 'EXECUTE'),
  'service role cannot author template policy'
);
select is(
  (select prosecdef from pg_proc where oid='public.upsert_message_template(uuid,text,public.message_template_channel,text,text,text,uuid)'::regprocedure),
  true,
  'template authoring RPC is SECURITY DEFINER'
);
select ok(
  (select 'search_path=pg_catalog, public, crm_private' = any(proconfig)
   from pg_proc where oid='public.upsert_message_template(uuid,text,public.message_template_channel,text,text,text,uuid)'::regprocedure),
  'template authoring RPC pins its search_path'
);
select has_index('public', 'message_templates', 'message_templates_workspace_version_idx',
  'workspace template versions have a unique database invariant');
select has_index('public', 'message_templates', 'message_templates_artist_version_idx',
  'artist template versions have a unique database invariant');
select col_not_null('public', 'message_templates', 'version', 'template version remains required');

reset role;
select pg_temp.as_template_profile('fa100000-0000-4000-8000-000000000001'::uuid);
set local role authenticated;

create temporary table template_ids (slot text primary key, id uuid not null);
grant select, insert on template_ids to authenticated;

insert into template_ids values
  ('artist-v1', public.upsert_message_template(
    'fa200000-0000-4000-8000-000000000001', 'session_reminder_24h', 'email',
    'Artist first version', 'en', 'First subject', 'fa300000-0000-4000-8000-000000000001')),
  ('artist-v2', public.upsert_message_template(
    'fa200000-0000-4000-8000-000000000001', 'session_reminder_24h', 'email',
    'Artist second version', 'en', 'Second subject', 'fa300000-0000-4000-8000-000000000001')),
  ('artist-ru-v1', public.upsert_message_template(
    'fa200000-0000-4000-8000-000000000001', 'session_reminder_24h', 'email',
    'Первая русская версия', 'ru', 'Русская тема', 'fa300000-0000-4000-8000-000000000001')),
  ('workspace-v1', public.upsert_message_template(
    'fa200000-0000-4000-8000-000000000001', 'session_reminder_24h', 'email',
    'Workspace first version', 'en', 'Workspace first', null)),
  ('workspace-v2', public.upsert_message_template(
    'fa200000-0000-4000-8000-000000000001', 'session_reminder_24h', 'email',
    'Workspace second version', 'en', 'Workspace second', null));

select throws_ok(
  $$select public.upsert_message_template(
    'fa200000-0000-4000-8000-000000000002', 'session_reminder_24h', 'email',
    'Foreign template', 'en', 'Foreign subject', 'fa300000-0000-4000-8000-000000000002')$$,
  '42501', null,
  'an operator cannot version a foreign artist template'
);

reset role;

select is(
  (select array_agg(t.version order by t.version)
   from public.message_templates t join template_ids i on i.id=t.id
   where i.slot in ('artist-v1','artist-v2')),
  array[1,2],
  'artist saves advance monotonically inside one exact slot'
);
select is(
  (select array_agg(t.version order by t.version)
   from public.message_templates t join template_ids i on i.id=t.id
   where i.slot in ('workspace-v1','workspace-v2')),
  array[1,2],
  'workspace saves advance independently inside its exact slot'
);
select is(
  (select t.version from public.message_templates t join template_ids i on i.id=t.id where i.slot='artist-ru-v1'),
  1,
  'a different locale starts its own version sequence'
);
select is(
  (select count(*)::integer from public.message_templates t join template_ids i on i.id=t.id where t.status='draft'),
  5,
  'every new version remains a draft'
);
select is(
  (select t.body from public.message_templates t join template_ids i on i.id=t.id where i.slot='artist-v1'),
  'Artist first version',
  'saving v2 does not rewrite the v1 body'
);
select is(
  (select t.body from public.message_templates t join template_ids i on i.id=t.id where i.slot='artist-v2'),
  'Artist second version',
  'the replacement body belongs only to v2'
);
select isnt(
  (select id from template_ids where slot='artist-v1'),
  (select id from template_ids where slot='artist-v2'),
  'each version has a stable immutable id'
);
select throws_ok(
  $$insert into public.message_templates (
      workspace_id, artist_id, purpose, channel, locale, version, status, body
    ) values (
      'fa200000-0000-4000-8000-000000000001', 'fa300000-0000-4000-8000-000000000001',
      'session_reminder_24h', 'email', 'en', 2, 'draft', 'Duplicate version')$$,
  '23505', null,
  'the database rejects a duplicate artist-slot version'
);

select pg_temp.as_template_profile('fa100000-0000-4000-8000-000000000001'::uuid);
set local role authenticated;
select ok(
  public.set_message_template_active((select id from template_ids where slot='artist-v1'), true),
  'v1 can be explicitly activated'
);
select ok(
  public.set_message_template_active((select id from template_ids where slot='artist-v2'), true),
  'v2 can atomically replace v1'
);
reset role;

select is(
  (select status::text from public.message_templates where id=(select id from template_ids where slot='artist-v1')),
  'retired',
  'the replaced version remains as retired history'
);
select is(
  (select status::text from public.message_templates where id=(select id from template_ids where slot='artist-v2')),
  'active',
  'the chosen replacement is the only active version'
);
select is(
  (select count(*)::integer from public.message_templates
   where artist_id='fa300000-0000-4000-8000-000000000001'
     and purpose='session_reminder_24h' and channel='email' and locale='en'),
  2,
  'activation does not delete prior versions'
);
select is((select count(*) from public.automation_jobs), (select jobs from template_side_effect_counts_before),
  'template versioning creates no automation job');
select is((select count(*) from public.email_messages), (select emails from template_side_effect_counts_before),
  'template versioning creates no email');
select is((select count(*) from public.integration_outbox), (select outbox from template_side_effect_counts_before),
  'template versioning creates no provider outbox row');

select * from finish();
rollback;
