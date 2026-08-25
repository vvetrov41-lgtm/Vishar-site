-- 247_lifecycle_control_plane_reads.sql
--
-- 0102 exposes lifecycle template metadata without granting browser SELECT on
-- message_templates. Everything here is synthetic and rolled back.

begin;
select no_plan();

select has_function('public', 'list_client_lifecycle_templates', array['uuid'],
  'lifecycle templates have a narrow artist-scoped read RPC');
select has_function('public', 'list_client_lifecycle_template_purposes', array['uuid'],
  'service purposes have a narrow artist-scoped read RPC');
select has_function('public', 'list_client_lifecycle_template_variables', array['uuid'],
  'template variables have a narrow artist-scoped read RPC');

select ok(
  has_function_privilege('authenticated', 'public.list_client_lifecycle_templates(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.list_client_lifecycle_template_purposes(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.list_client_lifecycle_template_variables(uuid)', 'EXECUTE'),
  'authenticated CRM users may call the bounded lifecycle read surfaces'
);
select ok(
  not has_function_privilege('anon', 'public.list_client_lifecycle_templates(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.list_client_lifecycle_template_purposes(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.list_client_lifecycle_template_variables(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.list_client_lifecycle_templates(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.list_client_lifecycle_template_purposes(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.list_client_lifecycle_template_variables(uuid)', 'EXECUTE'),
  'anon and backend roles do not gain a second lifecycle policy read path'
);
select ok(
  not has_table_privilege('authenticated', 'public.message_templates', 'SELECT'),
  'browser table access stays closed; only the bounded RPC may expose template metadata'
);
select ok(
  (select bool_and(p.prosecdef and 'search_path=pg_catalog, public, crm_private' = any(p.proconfig))
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'list_client_lifecycle_templates',
       'list_client_lifecycle_template_purposes',
       'list_client_lifecycle_template_variables')),
  'every lifecycle read RPC is SECURITY DEFINER with a pinned search_path'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('fa011111-1111-4111-8111-111111111111', 'lifecycle-reader@example.test'),
  ('fa022222-2222-4222-8222-222222222222', 'lifecycle-outsider@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('fa011111-1111-4111-8111-111111111111', 'lifecycle-reader@example.test',
   'Lifecycle Reader', 'read_only', true),
  ('fa022222-2222-4222-8222-222222222222', 'lifecycle-outsider@example.test',
   'Lifecycle Outsider', 'read_only', true);

insert into public.workspaces (id, slug, display_name, workspace_type, is_active) values
  ('fa101111-1111-4111-8111-111111111111', 'lifecycle-read-a', 'Lifecycle Read A', 'studio', true),
  ('fa102222-2222-4222-8222-222222222222', 'lifecycle-read-b', 'Lifecycle Read B', 'studio', true);

insert into public.artists (id, slug, display_name, workspace_id, is_active) values
  ('fa201111-1111-4111-8111-111111111111', 'lifecycle-read-alpha', 'Lifecycle Alpha',
   'fa101111-1111-4111-8111-111111111111', true),
  ('fa202222-2222-4222-8222-222222222222', 'lifecycle-read-sibling', 'Lifecycle Sibling',
   'fa101111-1111-4111-8111-111111111111', true),
  ('fa203333-3333-4333-8333-333333333333', 'lifecycle-read-other', 'Lifecycle Other',
   'fa102222-2222-4222-8222-222222222222', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active, grant_source
) values
  ('fa011111-1111-4111-8111-111111111111',
   'fa201111-1111-4111-8111-111111111111',
   'read_only', false, false, false, false, true, 'explicit'),
  ('fa022222-2222-4222-8222-222222222222',
   'fa203333-3333-4333-8333-333333333333',
   'read_only', false, false, false, false, true, 'explicit');

-- Four templates prove the exact visibility boundary:
-- workspace A + artist A are visible to A; sibling and other workspace are not.
insert into public.message_templates (
  id, workspace_id, artist_id, purpose, channel, locale, version, status, subject, body
) values
  ('fa301111-1111-4111-8111-111111111111',
   'fa101111-1111-4111-8111-111111111111', null,
   'session_reminder_24h', 'email', 'en', 1, 'active',
   'Workspace reminder', 'Hi {{client_first_name}}, workspace reminder.'),
  ('fa302222-2222-4222-8222-222222222222',
   'fa101111-1111-4111-8111-111111111111',
   'fa201111-1111-4111-8111-111111111111',
   'post_session_checkin', 'email', 'en', 1, 'draft',
   'Artist check-in', 'Hi {{client_first_name}}, artist follow-up.'),
  ('fa303333-3333-4333-8333-333333333333',
   'fa101111-1111-4111-8111-111111111111',
   'fa202222-2222-4222-8222-222222222222',
   'post_session_checkin', 'email', 'en', 1, 'draft',
   'Sibling check-in', 'Sibling-only body.'),
  ('fa304444-4444-4444-8444-444444444444',
   'fa102222-2222-4222-8222-222222222222', null,
   'session_reminder_24h', 'email', 'en', 1, 'active',
   'Other workspace', 'Other workspace body.');

create function pg_temp.as_profile(p_profile uuid) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    json_build_object('sub', p_profile, 'role', 'authenticated')::text,
    true
  )::void;
$$;
grant execute on function pg_temp.as_profile(uuid) to authenticated;

reset role;
select pg_temp.as_profile('fa011111-1111-4111-8111-111111111111');
set local role authenticated;

select set_eq(
  $$select id from public.list_client_lifecycle_templates(
      'fa201111-1111-4111-8111-111111111111'::uuid)$$,
  $$values
      ('fa301111-1111-4111-8111-111111111111'::uuid),
      ('fa302222-2222-4222-8222-222222222222'::uuid)$$,
  'a read-only artist member sees the workspace template and their own override only'
);
select is(
  (select template_scope from public.list_client_lifecycle_templates(
     'fa201111-1111-4111-8111-111111111111'::uuid)
   where id = 'fa301111-1111-4111-8111-111111111111'::uuid),
  'workspace',
  'workspace templates are labelled without exposing internal authorship'
);
select is(
  (select template_scope from public.list_client_lifecycle_templates(
     'fa201111-1111-4111-8111-111111111111'::uuid)
   where id = 'fa302222-2222-4222-8222-222222222222'::uuid),
  'artist',
  'artist overrides are labelled explicitly'
);
select is(
  (select count(*)::int
   from public.list_client_lifecycle_templates(
     'fa201111-1111-4111-8111-111111111111'::uuid)
   where classification <> 'service'::public.message_classification
      or channel <> 'email'::public.message_template_channel),
  0,
  'the template read surface exposes lifecycle-compatible service email templates only'
);
select ok(
  exists (
    select 1
    from public.list_client_lifecycle_template_purposes(
      'fa201111-1111-4111-8111-111111111111'::uuid)
    where purpose = 'post_session_checkin'
      and classification = 'service'::public.message_classification
  ),
  'the service-purpose catalogue includes post-session check-in without creating one'
);
select is(
  (select count(*)::int
   from public.list_client_lifecycle_template_purposes(
     'fa201111-1111-4111-8111-111111111111'::uuid)
   where classification <> 'service'::public.message_classification),
  0,
  'marketing purposes never enter the lifecycle authoring catalogue'
);
select ok(
  exists (
    select 1
    from public.list_client_lifecycle_template_variables(
      'fa201111-1111-4111-8111-111111111111'::uuid)
    where variable = 'client_first_name'
  ),
  'the variable catalogue is available without exposing any client value'
);

reset role;
select pg_temp.as_profile('fa022222-2222-4222-8222-222222222222');
set local role authenticated;
select is(
  (select count(*)::int
   from public.list_client_lifecycle_templates(
     'fa201111-1111-4111-8111-111111111111'::uuid)),
  0,
  'a profile from another artist scope cannot read lifecycle templates'
);
select is(
  (select count(*)::int
   from public.list_client_lifecycle_template_purposes(
     'fa201111-1111-4111-8111-111111111111'::uuid)),
  0,
  'a profile from another artist scope cannot enumerate lifecycle purposes through this surface'
);
select is(
  (select count(*)::int
   from public.list_client_lifecycle_template_variables(
     'fa201111-1111-4111-8111-111111111111'::uuid)),
  0,
  'a profile from another artist scope cannot enumerate lifecycle variables through this surface'
);

select * from finish(true);
rollback;
