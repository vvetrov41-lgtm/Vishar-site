-- 229_automation_engine.sql
--
-- Migration 0081: the automation foundation.
--
-- An automation engine is a machine that acts on a person's behalf without
-- being watched, so the properties worth pinning are the ones that decide what
-- it can never do: run outside its artist's scope, react to an event nobody
-- catalogued, execute an action nobody enumerated, notify somebody who cannot
-- reach the work, or do the same thing twice because a scheduler ran twice.
--
-- Everything is synthetic and rolled back.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Shape, ACL and hardening
-- ---------------------------------------------------------------------------

select has_table('public', 'automation_events', 'the domain event projection exists');
select has_table('public', 'automation_rules', 'the rule table exists');
select has_table('public', 'automation_jobs', 'the job table exists');
select has_table('public', 'automation_kill_switches', 'the kill switch table exists');

select ok(
  (select bool_and(relrowsecurity and relforcerowsecurity)
   from pg_class
   where oid in ('public.automation_trigger_catalog'::regclass,
                 'public.automation_events'::regclass,
                 'public.automation_rules'::regclass,
                 'public.automation_jobs'::regclass,
                 'public.automation_kill_switches'::regclass)),
  'row level security is enabled and forced on every automation table'
);

select ok(
  (select bool_and(
     not has_table_privilege('authenticated', t, 'SELECT')
     and not has_table_privilege('authenticated', t, 'INSERT')
     and not has_table_privilege('authenticated', t, 'UPDATE')
     and not has_table_privilege('anon', t, 'SELECT'))
   from unnest(array['public.automation_events', 'public.automation_rules',
                     'public.automation_jobs', 'public.automation_kill_switches']) t),
  'no browser session touches an automation table directly; rules are read through the RPC'
);

select ok(
  not has_function_privilege('authenticated', 'public.service_run_automation_tick(integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.service_run_automation_tick(integer)', 'EXECUTE'),
  'a browser cannot run the scheduler'
);
select ok(
  has_function_privilege('service_role', 'public.service_run_automation_tick(integer)', 'EXECUTE'),
  'the backend credential can run the scheduler'
);
select ok(
  not has_function_privilege('service_role', 'public.create_automation_rule(uuid,text,text,text,text,text,text,integer,public.notification_priority)', 'EXECUTE'),
  'the Worker credential cannot mint automation rules'
);
select ok(
  (select bool_and(p.prosecdef and 'search_path=pg_catalog, public, crm_private' = any (p.proconfig))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'crm_private')
     and p.proname in ('service_run_automation_tick', 'list_automation_rules',
                       'create_automation_rule', 'set_automation_rule_enabled',
                       'automations_enabled_for_artist',
                       'automation_notification_recipients',
                       'project_automation_event')),
  'every automation entry point is SECURITY DEFINER with a pinned search_path'
);

-- There is no rule DSL to sandbox, and the absence is the control. A jsonb
-- column here would be the place a template or expression language would
-- eventually grow.
select is(
  (select count(*)::int
   from information_schema.columns
   where table_schema = 'public'
     and table_name in ('automation_rules', 'automation_jobs', 'automation_events')
     and data_type in ('json', 'jsonb')),
  0,
  'no automation table carries a json config column'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('a9111111-1111-4111-8111-111111111111', 'auto.artist@example.test'),
  ('a9222222-2222-4222-8222-222222222222', 'auto.manager@example.test'),
  ('a9333333-3333-4333-8333-333333333333', 'auto.reader@example.test'),
  ('a9444444-4444-4444-8444-444444444444', 'auto.other@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('a9111111-1111-4111-8111-111111111111', 'auto.artist@example.test', 'Auto Artist', 'booking_manager', true),
  ('a9222222-2222-4222-8222-222222222222', 'auto.manager@example.test', 'Auto Manager', 'booking_manager', true),
  ('a9333333-3333-4333-8333-333333333333', 'auto.reader@example.test', 'Auto Reader', 'read_only', true),
  ('a9444444-4444-4444-8444-444444444444', 'auto.other@example.test', 'Auto Other', 'booking_manager', true);

insert into public.artists (id, slug, display_name, is_active) values
  ('a8111111-1111-4111-8111-111111111111', 'auto-alpha', 'Auto Alpha', true),
  ('a8222222-2222-4222-8222-222222222222', 'auto-beta', 'Auto Beta', true);

insert into public.artist_memberships
  (profile_id, artist_id, access_level, can_view_finance, can_manage_finance,
   can_manage_sessions, can_manage_integrations, is_active)
values
  -- Runs Alpha, so both manages automations and receives their notifications.
  ('a9111111-1111-4111-8111-111111111111', 'a8111111-1111-4111-8111-111111111111',
   'artist', true, true, true, true, true),
  -- A manager on Alpha with no integration right, so no manage_automations.
  ('a9222222-2222-4222-8222-222222222222', 'a8111111-1111-4111-8111-111111111111',
   'manager', false, false, true, false, true),
  -- Read-only on Alpha.
  ('a9333333-3333-4333-8333-333333333333', 'a8111111-1111-4111-8111-111111111111',
   'read_only', false, false, false, false, true),
  -- Runs Beta only.
  ('a9444444-4444-4444-8444-444444444444', 'a8222222-2222-4222-8222-222222222222',
   'artist', true, true, true, true, true);

insert into public.clients (id, full_name, email) values
  ('a7111111-1111-4111-8111-111111111111', 'Auto Client', 'auto-client@example.test');

-- A real status change names the enquiry it happened to, so the projection has
-- an entity to point a notification at.
insert into public.enquiries
  (id, artist_id, client_id, reference_number, idempotency_key,
   intake_fingerprint, status, intake_state, submitted_full_name,
   submitted_email, privacy_notice_version, privacy_acknowledged_at)
values
  ('a6111111-1111-4111-8111-111111111111', 'a8111111-1111-4111-8111-111111111111',
   'a7111111-1111-4111-8111-111111111111', 'ENQ-2026-9001',
   'a5111111-1111-4111-8111-111111111111', repeat('a', 64),
   'new', 'complete', 'Auto Client', 'auto-client@example.test',
   '2026-07-29', now());

create function pg_temp.auto_as(p uuid) returns void language sql as
  $$select set_config('request.jwt.claims',
      json_build_object('sub', p, 'role', 'authenticated')::text, true)::void$$;
grant execute on function pg_temp.auto_as(uuid) to authenticated;

create function pg_temp.auto_backend() returns void language sql as
  $$select set_config('request.jwt.claims', '{"role":"service_role"}', true)::void$$;

-- ---------------------------------------------------------------------------
-- Rule management is capability gated, and artist scoped
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.auto_as('a9333333-3333-4333-8333-333333333333');
select throws_ok(
  $$select public.create_automation_rule(
      'a8111111-1111-4111-8111-111111111111'::uuid,
      'Read only tries', 'enquiry.created', 'Should not exist')$$,
  '42501', null,
  'a read-only membership cannot create an automation'
);
reset role;

set local role authenticated;
select pg_temp.auto_as('a9222222-2222-4222-8222-222222222222');
select throws_ok(
  $$select public.create_automation_rule(
      'a8111111-1111-4111-8111-111111111111'::uuid,
      'Manager tries', 'enquiry.created', 'Should not exist')$$,
  '42501', null,
  'a manager without integration management cannot create an automation'
);
reset role;

set local role authenticated;
select pg_temp.auto_as('a9444444-4444-4444-8444-444444444444');
select throws_ok(
  $$select public.create_automation_rule(
      'a8111111-1111-4111-8111-111111111111'::uuid,
      'Cross artist', 'enquiry.created', 'Should not exist')$$,
  '42501', null,
  'an artist cannot create an automation in another artist scope'
);
reset role;

set local role authenticated;
select pg_temp.auto_as('a9111111-1111-4111-8111-111111111111');
select throws_ok(
  $$select public.create_automation_rule(
      'a8111111-1111-4111-8111-111111111111'::uuid,
      'Unknown trigger', 'enquiry.exploded', 'Should not exist')$$,
  '22023', null,
  'an event nobody catalogued cannot be a trigger'
);
select throws_ok(
  $$select public.create_automation_rule(
      'a8111111-1111-4111-8111-111111111111'::uuid,
      'Injected trigger', 'drop table public.enquiries', 'Should not exist')$$,
  '22023', null,
  'a trigger is a catalogue key, not a statement'
);

create temporary table t_rule as
select public.create_automation_rule(
  'a8111111-1111-4111-8111-111111111111'::uuid,
  'Tell the team about a new enquiry',
  'enquiry.status_changed',
  'An enquiry is waiting for a reply',
  'Open the CRM to see it.',
  null,
  'waiting_for_client',
  0,
  'high'::public.notification_priority
) as id;
grant select on t_rule to public;
reset role;

select is(
  (select count(*)::int from public.automation_rules where is_enabled),
  0,
  'a new rule is created disabled, so nothing runs until somebody turns it on'
);

-- ---------------------------------------------------------------------------
-- Events are projected from activity_log, once, and only from the catalogue
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select crm_private.log_artist_activity(
  'a8111111-1111-4111-8111-111111111111', 'enquiry.status_changed', 'staff', null,
  'a7111111-1111-4111-8111-111111111111', 'a6111111-1111-4111-8111-111111111111',
  null, null, null,
  jsonb_build_object('from_status', 'new', 'to_status', 'waiting_for_client')
);

select is(
  (select count(*)::int from public.automation_events
   where event_type = 'enquiry.status_changed'),
  1,
  'an activity row in the catalogue is projected exactly once'
);
select is(
  (select to_status from public.automation_events
   where event_type = 'enquiry.status_changed'),
  'waiting_for_client',
  'the status the rule can condition on is carried across'
);

-- An event outside the catalogue must not become an automation event, or every
-- automation would eventually react to bookkeeping.
select crm_private.log_artist_activity(
  'a8111111-1111-4111-8111-111111111111', 'outbox.succeeded', 'worker', null,
  null, null, null, null, null, '{}'::jsonb
);
select is(
  (select count(*)::int from public.automation_events),
  1,
  'an activity event outside the catalogue is not projected'
);

-- The rule RPCs write their own audit rows. Those must not feed the engine, or
-- an automation could react to its own administration.
select ok(
  not exists (
    select 1 from public.automation_events
    where event_type like 'automation.%'
  ),
  'automation administration does not become an automation event'
);

-- ---------------------------------------------------------------------------
-- A disabled rule materialises nothing
-- ---------------------------------------------------------------------------

select pg_temp.auto_backend();
select is(
  (select materialised from public.service_run_automation_tick(100)),
  0,
  'a disabled rule produces no job'
);

-- ---------------------------------------------------------------------------
-- Enabling, matching and delay
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.auto_as('a9111111-1111-4111-8111-111111111111');
select ok(
  public.set_automation_rule_enabled((select id from t_rule), true),
  'the artist can enable their own rule'
);
reset role;

set local role authenticated;
select pg_temp.auto_as('a9444444-4444-4444-8444-444444444444');
select throws_ok(
  format('select public.set_automation_rule_enabled(%L::uuid, false)', (select id from t_rule)),
  '42501', null,
  'an artist from another scope cannot disable somebody else''s rule'
);
reset role;

select pg_temp.auto_backend();
create temporary table t_first_tick as
select * from public.service_run_automation_tick(100);
grant select on t_first_tick to public;

select is(
  (select materialised from t_first_tick), 1,
  'an enabled matching rule materialises exactly one job'
);
-- One pass materialises, withdraws and executes, so a rule with no delay is
-- delivered by the same call rather than waiting for the next tick.
select is(
  (select notified from t_first_tick), 1,
  'and the same pass notifies exactly one recipient'
);
select is(
  (select artist_id from public.automation_jobs),
  'a8111111-1111-4111-8111-111111111111'::uuid,
  'the job belongs to the rule''s artist'
);

-- The same pair must never materialise twice, whatever the scheduler does.
select pg_temp.auto_backend();
select is(
  (select materialised from public.service_run_automation_tick(100)),
  0,
  'a second tick materialises nothing for the same event and rule'
);
select is(
  (select count(*)::int from public.automation_jobs),
  1,
  'and leaves exactly one job'
);

-- ---------------------------------------------------------------------------
-- Conditions actually narrow
-- ---------------------------------------------------------------------------

select crm_private.log_artist_activity(
  'a8111111-1111-4111-8111-111111111111', 'enquiry.status_changed', 'staff', null,
  'a7111111-1111-4111-8111-111111111111', 'a6111111-1111-4111-8111-111111111111',
  null, null, null,
  jsonb_build_object('from_status', 'new', 'to_status', 'declined')
);
select pg_temp.auto_backend();
select is(
  (select materialised from public.service_run_automation_tick(100)),
  0,
  'an event whose status does not match the condition materialises nothing'
);

-- ---------------------------------------------------------------------------
-- Cross-artist isolation
-- ---------------------------------------------------------------------------

select crm_private.log_artist_activity(
  'a8222222-2222-4222-8222-222222222222', 'enquiry.status_changed', 'staff', null,
  null, null, null, null, null,
  jsonb_build_object('from_status', 'new', 'to_status', 'waiting_for_client')
);
select pg_temp.auto_backend();
select is(
  (select materialised from public.service_run_automation_tick(100)),
  0,
  'an identical event in another artist scope never matches this artist''s rule'
);
select is(
  (select count(*)::int from public.automation_jobs
   where artist_id = 'a8222222-2222-4222-8222-222222222222'),
  0,
  'and produces no job for that artist'
);

-- ---------------------------------------------------------------------------
-- Execution notifies the people who run the artist, once
-- ---------------------------------------------------------------------------

select is(
  (select recipient_profile_id from public.notifications
   where notification_type = 'automation.triggered'),
  'a9111111-1111-4111-8111-111111111111'::uuid,
  'the recipient is the person who runs the artist, derived server-side'
);
select is(
  (select priority::text from public.notifications
   where notification_type = 'automation.triggered'),
  'high',
  'the rule''s priority is carried into the notification'
);
select ok(
  not exists (
    select 1 from public.notifications
    where notification_type = 'automation.triggered'
      and recipient_profile_id in (
        'a9222222-2222-4222-8222-222222222222',
        'a9333333-3333-4333-8333-333333333333',
        'a9444444-4444-4444-8444-444444444444')
  ),
  'a plain manager, a read-only account and an unrelated artist are not notified'
);
select is(
  (select status::text from public.automation_jobs),
  'completed',
  'the job is completed once it has been executed'
);

-- A repeated tick is the normal case for a scheduler, and must be silent.
select pg_temp.auto_backend();
select is(
  (select notified from public.service_run_automation_tick(100)),
  0,
  'a duplicate scheduler run sends no second notification'
);
select is(
  (select count(*)::int from public.notifications
   where notification_type = 'automation.triggered'),
  1,
  'and the recipient still has exactly one'
);

-- ---------------------------------------------------------------------------
-- Nothing reaches a client, and no provider work is queued
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from public.integration_outbox
   where created_at >= now() - interval '1 minute'),
  0,
  'an automation queues no provider job in this release'
);
select is(
  (select count(*)::int from public.communication_messages),
  0,
  'and sends nothing to a client'
);

-- ---------------------------------------------------------------------------
-- Editing a rule withdraws pending work but never rewrites history
-- ---------------------------------------------------------------------------

select crm_private.log_artist_activity(
  'a8111111-1111-4111-8111-111111111111', 'enquiry.status_changed', 'staff', null,
  'a7111111-1111-4111-8111-111111111111', 'a6111111-1111-4111-8111-111111111111',
  null, null, null,
  jsonb_build_object('from_status', 'reviewing', 'to_status', 'waiting_for_client')
);

-- Give the new job a delay so it is materialised but not yet due.
update public.automation_rules set delay_minutes = 60 where id = (select id from t_rule);
select is(
  (select version from public.automation_rules where id = (select id from t_rule)),
  2,
  'a material edit bumps the rule version'
);

select pg_temp.auto_backend();
select is(
  (select materialised from public.service_run_automation_tick(100)),
  1,
  'the new event materialises under the current rule version'
);
select ok(
  (select scheduled_at > now() + interval '55 minutes'
   from public.automation_jobs where status = 'pending'),
  'the delay is applied to the schedule'
);
select is(
  (select executed from public.service_run_automation_tick(100)),
  0,
  'a job that is not due yet is not executed'
);

-- Now edit again: the pending job was materialised under a meaning that no
-- longer exists.
update public.automation_rules set action_title = 'Different message'
where id = (select id from t_rule);

select pg_temp.auto_backend();
select is(
  (select withdrawn from public.service_run_automation_tick(100)),
  1,
  'pending work from a superseded rule version is withdrawn'
);
select is(
  (select status::text from public.automation_jobs where cancelled_at is not null),
  'cancelled',
  'and is cancelled rather than deleted'
);
select is(
  (select count(*)::int from public.automation_jobs where status = 'completed'),
  1,
  'the already-completed job is untouched by the edit'
);
select is(
  (select action_title from public.automation_jobs where status = 'completed'),
  'An enquiry is waiting for a reply',
  'a completed job still records the action that actually ran'
);

-- ---------------------------------------------------------------------------
-- Kill switches pause rather than discard
-- ---------------------------------------------------------------------------

-- Materialise a job under a delay so it is genuinely pending when the switch
-- goes on, then make it due without touching the rule (which would withdraw it).
update public.automation_rules set delay_minutes = 30 where id = (select id from t_rule);

select crm_private.log_artist_activity(
  'a8111111-1111-4111-8111-111111111111', 'enquiry.status_changed', 'staff', null,
  'a7111111-1111-4111-8111-111111111111', 'a6111111-1111-4111-8111-111111111111',
  null, null, null,
  jsonb_build_object('from_status', 'new', 'to_status', 'waiting_for_client')
);

select pg_temp.auto_backend();
select ok(
  (select materialised from public.service_run_automation_tick(100)) >= 1,
  'a fresh event materialises again under the current version'
);

insert into public.automation_kill_switches (scope_kind, scope_id, is_enabled)
values ('artist', 'a8111111-1111-4111-8111-111111111111', false);

update public.automation_jobs set scheduled_at = now() - interval '1 minute'
where status = 'pending';

select pg_temp.auto_backend();
select is(
  (select executed from public.service_run_automation_tick(100)),
  0,
  'an artist kill switch stops execution of work that is already due'
);
select ok(
  (select count(*) from public.automation_jobs where status = 'pending') >= 1,
  'and leaves the work pending rather than discarding it'
);

update public.automation_kill_switches set is_enabled = true
where scope_kind = 'artist';
insert into public.automation_kill_switches (scope_kind, scope_id, is_enabled)
values ('global', null, false);

select pg_temp.auto_backend();
select is(
  (select executed from public.service_run_automation_tick(100)),
  0,
  'the global kill switch stops execution for everybody'
);

update public.automation_kill_switches set is_enabled = true where scope_kind = 'global';
select pg_temp.auto_backend();
select ok(
  (select executed from public.service_run_automation_tick(100)) >= 1,
  're-enabling releases the paused work rather than having discarded it'
);

-- ---------------------------------------------------------------------------
-- A revoked recipient is not notified
-- ---------------------------------------------------------------------------

-- The kill-switch section left a delay on the rule; clear it so the next event
-- is due immediately and actually reaches execution.
update public.automation_rules set delay_minutes = 0 where id = (select id from t_rule);

update public.artist_memberships set is_active = false
where profile_id = 'a9111111-1111-4111-8111-111111111111'
  and artist_id = 'a8111111-1111-4111-8111-111111111111';

select crm_private.log_artist_activity(
  'a8111111-1111-4111-8111-111111111111', 'enquiry.status_changed', 'staff', null,
  'a7111111-1111-4111-8111-111111111111', 'a6111111-1111-4111-8111-111111111111',
  null, null, null,
  jsonb_build_object('from_status', 'accepted', 'to_status', 'waiting_for_client')
);

select pg_temp.auto_backend();
select is(
  (select notified from public.service_run_automation_tick(100)),
  0,
  'a job whose only recipient lost access notifies nobody'
);
select is(
  (select last_error_category from public.automation_jobs
   where last_error_category = 'no_recipient' limit 1),
  'no_recipient',
  'and records why, rather than looking like a successful delivery'
);

-- ---------------------------------------------------------------------------
-- Scheduler input bounds
-- ---------------------------------------------------------------------------

select pg_temp.auto_backend();
select throws_ok(
  $$select * from public.service_run_automation_tick(0)$$,
  '22023', null, 'the tick refuses a nonsensical batch size'
);
select throws_ok(
  $$select * from public.service_run_automation_tick(100000)$$,
  '22023', null, 'and refuses an unbounded one'
);

set local role authenticated;
select pg_temp.auto_as('a9111111-1111-4111-8111-111111111111');
select throws_ok(
  $$select * from public.service_run_automation_tick(10)$$,
  '42501', null,
  'an authenticated browser session cannot run the scheduler even if it finds the name'
);
reset role;

-- ---------------------------------------------------------------------------
-- Rule constraints
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.automation_rules
      (artist_id, name, trigger_event_type, action_title, delay_minutes)
    values ('a8111111-1111-4111-8111-111111111111', 'Too long',
            'enquiry.created', 'Title', 999999)$$,
  '23514', null,
  'a delay beyond thirty days is refused'
);
select throws_ok(
  $$insert into public.automation_rules
      (artist_id, name, trigger_event_type, action_title)
    values ('a8111111-1111-4111-8111-111111111111', 'Bad trigger',
            'not.catalogued', 'Title')$$,
  '23503', null,
  'a trigger outside the catalogue is refused at the table too'
);
select throws_ok(
  $$update public.automation_rules
      set artist_id = 'a8222222-2222-4222-8222-222222222222'$$,
  '23514', null,
  'a rule cannot be moved into another artist scope'
);

select * from finish(true);
rollback;
