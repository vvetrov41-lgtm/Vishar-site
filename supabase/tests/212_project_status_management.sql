-- 212_project_status_management.sql
-- Synthetic-only validation for human project lifecycle management.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('f9111111-1111-4111-8111-111111111111', 'project-status-owner@example.test'),
  ('f9122222-2222-4222-8222-222222222222', 'project-status-manager@example.test'),
  ('f9133333-3333-4333-8333-333333333333', 'project-status-reader@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('f9111111-1111-4111-8111-111111111111', 'project-status-owner@example.test', 'Project Status Owner', 'owner', true),
  ('f9122222-2222-4222-8222-222222222222', 'project-status-manager@example.test', 'Project Status Manager', 'booking_manager', true),
  ('f9133333-3333-4333-8333-333333333333', 'project-status-reader@example.test', 'Project Status Reader', 'read_only', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('f9122222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, false, true),
  ('f9133333-3333-4333-8333-333333333333', 'a1111111-1111-4111-8111-111111111111',
   'read_only', false, false, false, false, true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated, service_role;

insert into public.clients (id, full_name, email) values
  ('f9211111-1111-4111-8111-111111111111', 'Project Status Client', 'project-status-client@example.test');

insert into public.projects (
  id, artist_id, client_id, title, status, currency
) values (
  'f9311111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'f9211111-1111-4111-8111-111111111111',
  'Project Status Fixture', 'draft', 'GBP'
);

set local role authenticated;
select pg_temp.claims('{"sub":"f9111111-1111-4111-8111-111111111111","role":"authenticated"}');

select is(
  public.set_project_status(
    'f9311111-1111-4111-8111-111111111111', 'active'
  ) ->> 'changed',
  'true',
  'owner can activate an artist-scoped draft project'
);
select is(
  public.set_project_status(
    'f9311111-1111-4111-8111-111111111111', 'active'
  ) ->> 'changed',
  'false',
  'repeating the same status is a no-op'
);

select pg_temp.claims('{"sub":"f9122222-2222-4222-8222-222222222222","role":"authenticated"}');
select is(
  public.set_project_status(
    'f9311111-1111-4111-8111-111111111111', 'on_hold'
  ) ->> 'status',
  'on_hold',
  'booking manager with artist manage access can update project lifecycle'
);

select pg_temp.claims('{"sub":"f9133333-3333-4333-8333-333333333333","role":"authenticated"}');
select throws_ok(
  $$select public.set_project_status(
      'f9311111-1111-4111-8111-111111111111', 'completed'
    )$$,
  '42501', null,
  'read-only artist membership cannot change project status'
);

reset role;
select is(
  (select status::text from public.projects where id = 'f9311111-1111-4111-8111-111111111111'),
  'on_hold',
  'denied status mutation leaves the project unchanged'
);
select is(
  (select count(*)::int from public.activity_log
   where project_id = 'f9311111-1111-4111-8111-111111111111'
     and event_type = 'project.status_changed'),
  2,
  'only actual project status changes append audit events'
);
select ok(
  has_function_privilege('authenticated', 'public.set_project_status(uuid,public.project_status)', 'execute')
  and not has_function_privilege('anon', 'public.set_project_status(uuid,public.project_status)', 'execute')
  and not has_function_privilege('service_role', 'public.set_project_status(uuid,public.project_status)', 'execute'),
  'project status workflow is exposed only to authenticated human CRM callers'
);

select * from finish();
rollback;
