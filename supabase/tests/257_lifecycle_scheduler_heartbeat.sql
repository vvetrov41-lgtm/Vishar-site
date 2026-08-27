begin;
select no_plan();

select ok(
  to_regclass('crm_private.automation_scheduler_heartbeat') is not null,
  'scheduler heartbeat state exists in the private schema'
);

select ok(
  not has_table_privilege('anon', 'crm_private.automation_scheduler_heartbeat', 'SELECT')
  and not has_table_privilege('authenticated', 'crm_private.automation_scheduler_heartbeat', 'SELECT')
  and not has_table_privilege('service_role', 'crm_private.automation_scheduler_heartbeat', 'SELECT'),
  'scheduler heartbeat state has no direct API-role table access'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.service_record_automation_scheduler_heartbeat()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.service_record_automation_scheduler_heartbeat()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.service_record_automation_scheduler_heartbeat()',
    'EXECUTE'
  ),
  'only the trusted backend can record scheduler heartbeat state'
);

select ok(
  pg_get_function_result(
    'public.get_lifecycle_automation_health(uuid)'::regprocedure
  ) ilike '%scheduler_last_succeeded_at%'
  and pg_get_function_result(
    'public.get_lifecycle_automation_health(uuid)'::regprocedure
  ) ilike '%scheduler_stale%',
  'lifecycle health exposes bounded scheduler freshness diagnostics'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select lives_ok(
  $$select public.service_record_automation_scheduler_heartbeat()$$,
  'the trusted backend can record a scheduler heartbeat'
);
select lives_ok(
  $$select public.service_record_automation_scheduler_heartbeat()$$,
  'a repeated heartbeat updates the singleton instead of creating history rows'
);
reset role;

select is(
  (select count(*)::integer from crm_private.automation_scheduler_heartbeat),
  1,
  'scheduler heartbeat remains a singleton'
);
select ok(
  (select last_succeeded_at > now() - interval '1 minute'
   from crm_private.automation_scheduler_heartbeat
   where singleton),
  'the heartbeat records a current server timestamp'
);

insert into auth.users (id, email) values
  ('fd100000-0000-4000-8000-000000000001', 'scheduler-heartbeat@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('fd100000-0000-4000-8000-000000000001', 'scheduler-heartbeat@example.test',
   'Scheduler Heartbeat', 'booking_manager', true);

insert into public.workspaces (id, slug, display_name, workspace_type, is_active) values
  ('fd200000-0000-4000-8000-000000000001', 'scheduler-heartbeat-home',
   'Scheduler Heartbeat Home', 'studio', true);

insert into public.artists (id, workspace_id, slug, display_name, is_active) values
  ('fd300000-0000-4000-8000-000000000001', 'fd200000-0000-4000-8000-000000000001',
   'scheduler-heartbeat-artist', 'Scheduler Heartbeat Artist', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active, grant_source
) values (
  'fd100000-0000-4000-8000-000000000001',
  'fd300000-0000-4000-8000-000000000001',
  'manager', false, false, false, false, true, 'explicit'
);

create function pg_temp.as_scheduler_heartbeat_profile(p_profile uuid)
returns void
language sql
as $$
  select set_config(
    'request.jwt.claims',
    json_build_object('sub', p_profile, 'role', 'authenticated')::text,
    true
  )::void;
$$;
grant execute on function pg_temp.as_scheduler_heartbeat_profile(uuid) to authenticated;

update crm_private.automation_scheduler_heartbeat
set last_succeeded_at = now() - interval '30 minutes'
where singleton;

select pg_temp.as_scheduler_heartbeat_profile('fd100000-0000-4000-8000-000000000001');
set local role authenticated;
select ok(
  (select scheduler_stale
   from public.get_lifecycle_automation_health('fd300000-0000-4000-8000-000000000001')),
  'a heartbeat older than three five-minute scheduler windows is stale'
);
select ok(
  (select scheduler_last_succeeded_at < now() - interval '15 minutes'
   from public.get_lifecycle_automation_health('fd300000-0000-4000-8000-000000000001')),
  'authorized health reads expose only the timestamp needed to explain stale scheduler state'
);
reset role;

update crm_private.automation_scheduler_heartbeat
set last_succeeded_at = now()
where singleton;

select pg_temp.as_scheduler_heartbeat_profile('fd100000-0000-4000-8000-000000000001');
set local role authenticated;
select ok(
  not (select scheduler_stale
       from public.get_lifecycle_automation_health('fd300000-0000-4000-8000-000000000001')),
  'a current heartbeat reports the scheduler as fresh'
);
reset role;

select * from finish();
rollback;
