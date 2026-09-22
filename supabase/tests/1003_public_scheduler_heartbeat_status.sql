-- 1003_public_scheduler_heartbeat_status.sql
--
-- The external scheduler watchdog reads only the heartbeat age, anonymously,
-- and a missing or old heartbeat is always reported stale.

begin;
select no_plan();

select has_function('public', 'get_scheduler_heartbeat_status', array[]::text[],
  'the anonymous scheduler heartbeat status exists');
select ok(has_function_privilege('anon', 'public.get_scheduler_heartbeat_status()', 'EXECUTE'),
  'the credential-free external watchdog can read heartbeat status');
select is(
  (select array_agg(p.parameter_name::text order by p.ordinal_position)
   from information_schema.parameters p
   join information_schema.routines r on r.specific_name = p.specific_name
   where r.routine_schema = 'public' and r.routine_name = 'get_scheduler_heartbeat_status'
     and p.parameter_mode = 'OUT'),
  array['last_succeeded_at', 'age_seconds', 'stale'],
  'the status exposes only the heartbeat timestamp, its age and staleness'
);

delete from crm_private.automation_scheduler_heartbeat;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select results_eq(
  $$select last_succeeded_at is null, age_seconds is null, stale from public.get_scheduler_heartbeat_status()$$,
  $$values (true, true, true)$$,
  'a missing heartbeat is reported as stale in exactly one row'
);
reset role;

insert into crm_private.automation_scheduler_heartbeat (singleton, last_succeeded_at)
values (true, now() - interval '4 minutes');
set local role anon;
select results_eq(
  $$select stale, age_seconds between 239 and 241 from public.get_scheduler_heartbeat_status()$$,
  $$values (false, true)$$,
  'a heartbeat within one production window is fresh'
);
reset role;

update crm_private.automation_scheduler_heartbeat set last_succeeded_at = now() - interval '16 minutes';
set local role anon;
select results_eq(
  $$select stale from public.get_scheduler_heartbeat_status()$$,
  $$values (true)$$,
  'three missed */5 windows make the heartbeat stale'
);
select throws_ok(
  $$select * from crm_private.automation_scheduler_heartbeat$$,
  '42501', null,
  'anonymous callers still cannot read the heartbeat table directly'
);
reset role;

select * from finish(true);
rollback;
