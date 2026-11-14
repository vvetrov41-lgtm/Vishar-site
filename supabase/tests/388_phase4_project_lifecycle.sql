-- Phase 4: synthetic, rollback-only project lifecycle regression.
-- Exercises permission, idempotency, archive preservation and conflict guards.
begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('f8411111-1111-4111-8111-111111111111', 'phase4-owner@example.test'),
  ('f8422222-2222-4222-8222-222222222222', 'phase4-manager@example.test'),
  ('f8433333-3333-4333-8333-333333333333', 'phase4-reader@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('f8411111-1111-4111-8111-111111111111', 'phase4-owner@example.test', 'Project Owner', 'owner', true),
  ('f8422222-2222-4222-8222-222222222222', 'phase4-manager@example.test', 'Project Manager', 'booking_manager', true),
  ('f8433333-3333-4333-8333-333333333333', 'phase4-reader@example.test', 'Project Reader', 'read_only', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('f8422222-2222-4222-8222-222222222222',
   'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, false, true),
  ('f8433333-3333-4333-8333-333333333333',
   'a1111111-1111-4111-8111-111111111111',
   'read_only', false, false, false, false, true);

insert into public.clients (id, full_name, email) values
  ('f8444444-4444-4444-8444-444444444444', 'Phase4 Existing Client', 'phase4-existing@example.test'),
  ('f8455555-5555-4555-8555-555555555555', 'Phase4 Another Client', 'phase4-another@example.test');

create function pg_temp.as_profile(p uuid) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    json_build_object('sub',p,'role','authenticated')::text,true
  )::void
$$;
grant execute on function pg_temp.as_profile(uuid) to authenticated, service_role;

set local role authenticated;
select pg_temp.as_profile('f8422222-2222-4222-8222-222222222222');

select is(
  public.create_client_project(
    'f8466666-6666-4666-8666-666666666666',
    'f8444444-4444-4444-8444-444444444444',
    'a1111111-1111-4111-8111-111111111111',
    ' Colour sleeve ', 'A new piece, no prior enquiry'
  ) ->> 'created',
  'true',
  'manager may create a draft for an existing client in their artist scope'
);

select is(
  public.create_client_project(
    'f8466666-6666-4666-8666-666666666666',
    'f8444444-4444-4444-8444-444444444444',
    'a1111111-1111-4111-8111-111111111111',
    'Colour sleeve', 'A new piece, no prior enquiry'
  ) ->> 'created',
  'false',
  'the same request id is safely replayed after a lost response'
);

select is(
  (select count(*)::integer from public.projects
   where id='f8466666-6666-4666-8666-666666666666'
     and client_id='f8444444-4444-4444-8444-444444444444'
     and artist_id='a1111111-1111-4111-8111-111111111111'
     and enquiry_id is null and status='draft'),
  1,
  'replay does not create a duplicate or an enquiry'
);

select throws_ok(
  $$select public.create_client_project(
    'f8466666-6666-4666-8666-666666666666',
    'f8455555-5555-4555-8555-555555555555',
    'a1111111-1111-4111-8111-111111111111',
    'Colour sleeve', 'A new piece, no prior enquiry')$$,
  '23514', null,
  'the request UUID cannot attach that project to another client'
);

select throws_ok(
  $$select public.create_client_project(
    'f8466666-6666-4666-8666-666666666667',
    'f8444444-4444-4444-8444-444444444444',
    'a2222222-2222-4222-8222-222222222222',
    'Unauthorised project', null)$$,
  '42501', null,
  'manager cannot create a project for an artist outside their membership'
);

select is(
  public.update_project_description(
    'f8466666-6666-4666-8666-666666666666',
    'Revised realism sleeve',
    'A new piece, no prior enquiry'
  ) ->> 'changed',
  'true',
  'manager can save a project description with the original version'
);

select is(
  public.update_project_description(
    'f8466666-6666-4666-8666-666666666666',
    'Revised realism sleeve',
    'A new piece, no prior enquiry'
  ) ->> 'changed',
  'false',
  'a repeated successful description save does not write again'
);

select throws_ok(
  $$select public.update_project_description(
    'f8466666-6666-4666-8666-666666666666',
    'Stale overwrite', 'A new piece, no prior enquiry')$$,
  '40001', null,
  'stale detail changes cannot overwrite a newer description'
);

select pg_temp.as_profile('f8433333-3333-4333-8333-333333333333');
select throws_ok(
  $$select public.update_project_description(
    'f8466666-6666-4666-8666-666666666666',
    'Unauthorised edit', 'Revised realism sleeve')$$,
  '42501', null,
  'a read-only member cannot edit the project'
);
select throws_ok(
  $$select public.create_client_project(
    'f8466666-6666-4666-8666-666666666668',
    'f8444444-4444-4444-8444-444444444444',
    'a1111111-1111-4111-8111-111111111111',
    'Unauthorised creation', null)$$,
  '42501', null,
  'a read-only member cannot create a project'
);

select pg_temp.as_profile('f8422222-2222-4222-8222-222222222222');
select throws_ok(
  $$select public.set_project_archive_state(
    'f8466666-6666-4666-8666-666666666666',true)$$,
  '42501', null,
  'manager cannot archive or restore owner-only projects'
);

select pg_temp.as_profile('f8411111-1111-4111-8111-111111111111');
select throws_ok(
  $$select public.set_project_archive_state(
    'f8466666-6666-4666-8666-666666666666',true)$$,
  '55000', null,
  'even the owner cannot archive an unfinished draft'
);

select is(
  public.set_project_status('f8466666-6666-4666-8666-666666666666','completed') ->> 'changed',
  'true',
  'the standard existing transition finishes the project first'
);

select is(
  public.set_project_archive_state('f8466666-6666-4666-8666-666666666666',true) ->> 'changed',
  'true',
  'owner archives a completed project'
);
select is(
  public.set_project_archive_state('f8466666-6666-4666-8666-666666666666',true) ->> 'changed',
  'false',
  'a second archive tap does not add a second audit event'
);
select ok(
  (select archived_at is not null
   from public.projects where id='f8466666-6666-4666-8666-666666666666'),
  'soft archive leaves the project row and links in place'
);

select throws_ok(
  $$select public.update_project_description(
    'f8466666-6666-4666-8666-666666666666',
    'Editing archived content', 'Revised realism sleeve')$$,
  '23503', null,
  'archived project is read-only'
);

select is(
  public.set_project_archive_state('f8466666-6666-4666-8666-666666666666',false) ->> 'changed',
  'true',
  'owner can restore a project'
);
select is(
  public.set_project_archive_state('f8466666-6666-4666-8666-666666666666',false) ->> 'changed',
  'false',
  'repeat restore is a no-op'
);
select ok(
  (select archived_at is null and status='completed' and enquiry_id is null
   from public.projects where id='f8466666-6666-4666-8666-666666666666'),
  'restoration keeps status and original client link'
);
select is(
  (select count(*)::integer from public.activity_log
   where project_id='f8466666-6666-4666-8666-666666666666'
     and event_type='project.archived'),
  1,
  'archive action writes exactly one audit row'
);
select is(
  (select count(*)::integer from public.activity_log
   where project_id='f8466666-6666-4666-8666-666666666666'
     and event_type='project.restored'),
  1,
  'restore action writes exactly one audit row'
);

reset role;
select ok(
  has_function_privilege('authenticated','public.create_client_project(uuid,uuid,uuid,text,text)','EXECUTE')
  and has_function_privilege('authenticated','public.update_project_description(uuid,text,text)','EXECUTE')
  and has_function_privilege('authenticated','public.set_project_archive_state(uuid,boolean)','EXECUTE')
  and not has_function_privilege('anon','public.create_client_project(uuid,uuid,uuid,text,text)','EXECUTE')
  and not has_function_privilege('service_role','public.set_project_archive_state(uuid,boolean)','EXECUTE'),
  'new RPCs are human authenticated only'
);
select ok(
  not has_table_privilege('authenticated','public.projects','INSERT')
  and not has_table_privilege('authenticated','public.projects','UPDATE')
  and not has_table_privilege('authenticated','public.projects','DELETE'),
  'browser cannot bypass RPCs with direct project mutation'
);

select * from finish();
rollback;
