-- 225_internal_notifications.sql
--
-- Migration 0077: internal notifications and the follow-up sweep.
--
-- Before this migration a follow-up that came due produced nothing at all, so
-- the assertions worth making are about who gets told, that they get told once,
-- and that the things which should cancel a reminder actually cancel it.
--
-- The privacy property is the one to keep an eye on: a notification is
-- addressed to a person, and the artist scope it arose in is a label, not an
-- audience. An artist cannot read their manager's reminder just because it
-- happened inside their scope.
--
-- Everything is synthetic and rolled back. Times are relative to now(), so the
-- file is timezone-independent by construction.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- ACL and hardening
-- ---------------------------------------------------------------------------

select ok(
  not has_function_privilege('authenticated', 'public.service_sweep_due_follow_ups(integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.service_sweep_due_follow_ups(integer)', 'EXECUTE'),
  'the sweep is backend-only and cannot be triggered from a browser'
);
select ok(
  has_function_privilege('service_role', 'public.service_sweep_due_follow_ups(integer)', 'EXECUTE'),
  'the backend credential can run the sweep'
);
select ok(
  not has_table_privilege('anon', 'public.notifications', 'SELECT')
  and not has_table_privilege('authenticated', 'public.notifications', 'INSERT')
  and not has_table_privilege('authenticated', 'public.notifications', 'UPDATE'),
  'no browser session may write a notification, and anon may read none'
);
select ok(
  (select bool_and(relrowsecurity and relforcerowsecurity)
   from pg_class where oid in ('public.notifications'::regclass,
                               'public.notification_preferences'::regclass)),
  'row level security is enabled and forced on the notification tables'
);
select ok(
  not has_table_privilege('authenticated', 'crm_private.profile_notification_targets', 'SELECT')
  and not has_table_privilege('service_role', 'crm_private.profile_notification_targets', 'SELECT'),
  'a person''s delivery address is reachable from no API role at all'
);
select ok(
  (select bool_and(p.prosecdef and 'search_path=pg_catalog, public, crm_private' = any (p.proconfig))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('service_sweep_due_follow_ups', 'list_notifications',
                       'mark_notification_read', 'snooze_follow_up',
                       'set_notification_preference')),
  'every notification entry point is SECURITY DEFINER with a pinned search_path'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('f1000000-0000-4000-8000-000000000001', 'nt.artist@example.test'),
  ('f1000000-0000-4000-8000-000000000002', 'nt.sarah@example.test'),
  ('f1000000-0000-4000-8000-000000000003', 'nt.other@example.test');

insert into public.profiles (id, email, role, is_active) values
  ('f1000000-0000-4000-8000-000000000001', 'nt.artist@example.test', 'booking_manager', true),
  ('f1000000-0000-4000-8000-000000000002', 'nt.sarah@example.test', 'booking_manager', true),
  ('f1000000-0000-4000-8000-000000000003', 'nt.other@example.test', 'booking_manager', true);

insert into public.artists (id, slug, display_name, is_active) values
  ('f2000000-0000-4000-8000-00000000000a', 'nt-alpha', 'Alpha', true),
  ('f2000000-0000-4000-8000-00000000000b', 'nt-beta', 'Beta', true);

insert into public.artist_memberships
  (profile_id, artist_id, access_level, can_manage_sessions, is_active)
values
  ('f1000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-00000000000a',
   'artist', true, true),
  ('f1000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-00000000000a',
   'manager', true, true),
  ('f1000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-00000000000b',
   'artist', true, true);

-- A follow-up must point at something (num_nonnulls(client, enquiry, project)
-- >= 1), so the fixtures carry a client. The client itself is artist-neutral;
-- the follow-up's own artist_id is what scopes it.
insert into public.clients (id, full_name, email) values
  ('f3000000-0000-4000-8000-000000000001', 'Charlie Client', 'charlie@example.test');

-- Four follow-ups: one due and assigned, one due and unassigned, one not due
-- yet, one already completed.
insert into public.follow_ups
  (id, artist_id, subject, details, due_at, assigned_to, status, client_id)
values
  ('f4000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-00000000000a',
   'Reply to Charlie', 'He asked about the sleeve.', now() - interval '2 days',
   'f1000000-0000-4000-8000-000000000002', 'open', 'f3000000-0000-4000-8000-000000000001'),
  ('f4000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-00000000000a',
   'Check references', null, now() - interval '30 minutes', null, 'open',
   'f3000000-0000-4000-8000-000000000001'),
  ('f4000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-00000000000a',
   'Not due yet', null, now() + interval '3 days',
   'f1000000-0000-4000-8000-000000000002', 'open',
   'f3000000-0000-4000-8000-000000000001'),
  ('f4000000-0000-4000-8000-000000000004', 'f2000000-0000-4000-8000-00000000000a',
   'Already done', null, now() - interval '1 day',
   'f1000000-0000-4000-8000-000000000002', 'open',
   'f3000000-0000-4000-8000-000000000001');

update public.follow_ups
set status = 'done', completed_at = now() - interval '2 hours'
where id = 'f4000000-0000-4000-8000-000000000004';

create function pg_temp.nt_as(p uuid) returns void language sql as
  $$select set_config('request.jwt.claims',
      json_build_object('sub', p, 'role', 'authenticated')::text, true)::void$$;
grant execute on function pg_temp.nt_as(uuid) to authenticated;

create function pg_temp.nt_backend() returns void language sql as
  $$select set_config('request.jwt.claims', '{"role":"service_role"}', true)::void$$;

-- ---------------------------------------------------------------------------
-- The sweep
-- ---------------------------------------------------------------------------

select pg_temp.nt_backend();
select is(
  (select count(*)::int from public.service_sweep_due_follow_ups(100)),
  2,
  'the sweep notifies the assigned overdue follow-up and the unassigned one'
);

select is(
  (select recipient_profile_id from public.notifications
   where entity_id = 'f4000000-0000-4000-8000-000000000001'),
  'f1000000-0000-4000-8000-000000000002'::uuid,
  'an assigned follow-up notifies its assignee, not the artist'
);
select is(
  (select recipient_profile_id from public.notifications
   where entity_id = 'f4000000-0000-4000-8000-000000000002'),
  'f1000000-0000-4000-8000-000000000001'::uuid,
  'an unassigned follow-up falls back to whoever actually runs the artist'
);
select ok(
  not exists (
    select 1 from public.notifications
    where recipient_profile_id = 'f1000000-0000-4000-8000-000000000003'
  ),
  'an artist in an unrelated scope is notified about nothing'
);
select ok(
  not exists (
    select 1 from public.notifications
    where entity_id in ('f4000000-0000-4000-8000-000000000003',
                        'f4000000-0000-4000-8000-000000000004')
  ),
  'a follow-up that is not due, and one already completed, produce nothing'
);
select is(
  (select priority::text from public.notifications
   where entity_id = 'f4000000-0000-4000-8000-000000000001'),
  'high',
  'a follow-up more than a day overdue is raised to high priority'
);
select is(
  (select priority::text from public.notifications
   where entity_id = 'f4000000-0000-4000-8000-000000000002'),
  'normal',
  'one that came due half an hour ago is not'
);
select ok(
  (select last_notified_at is not null from public.follow_ups
   where id = 'f4000000-0000-4000-8000-000000000001'),
  'the follow-up records that it was announced'
);

-- ---------------------------------------------------------------------------
-- Idempotency (brief section 39)
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from public.service_sweep_due_follow_ups(100)),
  0,
  'a second sweep over the same due follow-ups notifies nobody again'
);
select is(
  (select count(*)::int from public.notifications),
  2,
  'and produces no second notification row'
);

-- ---------------------------------------------------------------------------
-- Completing and cancelling stop the reminder
-- ---------------------------------------------------------------------------

update public.follow_ups
set status = 'cancelled', cancelled_at = now()
where id = 'f4000000-0000-4000-8000-000000000002';

update public.follow_ups set due_at = now() - interval '10 minutes'
where id = 'f4000000-0000-4000-8000-000000000002';

select pg_temp.nt_backend();
select is(
  (select count(*)::int from public.service_sweep_due_follow_ups(100)),
  0,
  'a cancelled follow-up is not notified even after its due date moves'
);


-- ---------------------------------------------------------------------------
-- Snooze changes the schedule rather than creating a second task
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from public.follow_ups
   where artist_id = 'f2000000-0000-4000-8000-00000000000a'),
  4,
  'four follow-ups before any snooze'
);

set local role authenticated;
select pg_temp.nt_as('f1000000-0000-4000-8000-000000000001');
select lives_ok(
  $$select public.snooze_follow_up('f4000000-0000-4000-8000-000000000001'::uuid,
                                   now() + interval '1 hour')$$,
  'an open follow-up can be snoozed by somebody who runs the artist'
);
select throws_ok(
  $$select public.snooze_follow_up('f4000000-0000-4000-8000-000000000001'::uuid,
                                   now() - interval '1 hour')$$,
  '22023', null,
  'a snooze into the past is refused'
);
select throws_ok(
  $$select public.snooze_follow_up('f4000000-0000-4000-8000-000000000001'::uuid,
                                   now() + interval '400 days')$$,
  '22023', null,
  'a snooze beyond a year is refused'
);
reset role;

set local role authenticated;
select pg_temp.nt_as('f1000000-0000-4000-8000-000000000003');
select throws_ok(
  $$select public.snooze_follow_up('f4000000-0000-4000-8000-000000000001'::uuid,
                                   now() + interval '1 hour')$$,
  '42501', null,
  'somebody outside the artist scope cannot snooze its follow-ups'
);
reset role;

select is(
  (select count(*)::int from public.follow_ups
   where artist_id = 'f2000000-0000-4000-8000-00000000000a'),
  4,
  'snoozing created no duplicate task'
);
select is(
  (select schedule_version from public.follow_ups
   where id = 'f4000000-0000-4000-8000-000000000001'),
  2,
  'snoozing bumped the schedule version'
);

-- The snoozed follow-up is not due yet, so nothing fires. Once it is, the new
-- schedule version makes a fresh notification legitimate rather than a
-- duplicate.
select pg_temp.nt_backend();
select is(
  (select count(*)::int from public.service_sweep_due_follow_ups(100)),
  0,
  'a snoozed follow-up is silent until its new due date'
);

update public.follow_ups set due_at = now() - interval '1 minute'
where id = 'f4000000-0000-4000-8000-000000000001';

select pg_temp.nt_backend();
select is(
  (select count(*)::int from public.service_sweep_due_follow_ups(100)),
  1,
  'when the snooze expires the follow-up is announced again'
);
select is(
  (select count(*)::int from public.notifications
   where entity_id = 'f4000000-0000-4000-8000-000000000001'),
  2,
  'the earlier notification survives as the record of the first attempt'
);

-- ---------------------------------------------------------------------------
-- A notification is addressed to a person, not to a scope
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.nt_as('f1000000-0000-4000-8000-000000000001');
select ok(
  not exists (
    select 1 from public.list_notifications()
    where entity_id = 'f4000000-0000-4000-8000-000000000001'
  ),
  'the artist cannot read a reminder addressed to their manager, even in their own scope'
);
select ok(
  exists (
    select 1 from public.list_notifications()
    where entity_id = 'f4000000-0000-4000-8000-000000000002'
  ),
  'the artist reads the reminders addressed to them'
);
reset role;

set local role authenticated;
select pg_temp.nt_as('f1000000-0000-4000-8000-000000000002');
select is(
  (select count(*)::int from public.list_notifications()),
  2,
  'the manager reads exactly their own reminders and nobody else''s'
);
select ok(
  public.mark_notification_read(
    (select id from public.notifications
     where recipient_profile_id = 'f1000000-0000-4000-8000-000000000002'
     order by scheduled_at limit 1)),
  'the recipient can mark their own notification read'
);
reset role;

set local role authenticated;
select pg_temp.nt_as('f1000000-0000-4000-8000-000000000003');
select ok(
  not public.mark_notification_read(
    (select id from public.notifications
     where recipient_profile_id = 'f1000000-0000-4000-8000-000000000002'
     limit 1)),
  'somebody else''s notification cannot be marked read'
);
select is(
  (select count(*)::int from public.list_notifications()),
  0,
  'an unrelated profile sees no notifications at all'
);
reset role;

-- ---------------------------------------------------------------------------
-- Personal delivery preferences
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.nt_as('f1000000-0000-4000-8000-000000000002');
select throws_ok(
  $$select public.set_notification_preference('in_app'::public.notification_channel, false)$$,
  '22023', null,
  'in-app notifications cannot be switched off'
);
select throws_ok(
  $$select public.set_notification_preference('telegram'::public.notification_channel, true)$$,
  '22023', null,
  'a channel cannot be enabled before a destination exists, or it would deliver silence'
);
reset role;

insert into crm_private.profile_notification_targets
  (profile_id, channel, target_address, safe_label)
values
  ('f1000000-0000-4000-8000-000000000002', 'telegram', '10000001', 'Sarah (private chat)');

set local role authenticated;
select pg_temp.nt_as('f1000000-0000-4000-8000-000000000002');
select ok(
  public.set_notification_preference('telegram'::public.notification_channel, true),
  'with a connected destination the channel can be enabled'
);
select is(
  (select count(*)::int from public.notification_preferences),
  1,
  'a person reads only their own preferences'
);
reset role;

-- The whole point of keeping this separate from artist_integrations: Sarah's
-- private destination is hers, and is not any artist's shared group.
select ok(
  not exists (
    select 1
    from crm_private.profile_notification_targets t
    join public.artist_integrations i on i.integration_key = t.target_address
  ),
  'a personal destination is not an artist integration key'
);


-- ---------------------------------------------------------------------------
-- Losing access reroutes the reminder rather than silencing it
--
-- Placed last because it deliberately changes who every open follow-up is for.
-- ---------------------------------------------------------------------------

update public.artist_memberships set is_active = false
where profile_id = 'f1000000-0000-4000-8000-000000000002'
  and artist_id = 'f2000000-0000-4000-8000-00000000000a';

update public.follow_ups set due_at = now() - interval '5 minutes'
where id = 'f4000000-0000-4000-8000-000000000003';

select pg_temp.nt_backend();
select ok(
  (select count(*)::int from public.service_sweep_due_follow_ups(100)) >= 1,
  'work assigned to a revoked membership is still announced'
);
select is(
  (select count(*)::int from public.notifications
   where entity_id = 'f4000000-0000-4000-8000-000000000003'
     and recipient_profile_id = 'f1000000-0000-4000-8000-000000000002'),
  0,
  'the person who lost access is not told about work they can no longer open'
);
select is(
  (select count(*)::int from public.notifications
   where entity_id = 'f4000000-0000-4000-8000-000000000003'
     and recipient_profile_id = 'f1000000-0000-4000-8000-000000000001'),
  1,
  'it falls back to whoever still runs the artist'
);

select * from finish(true);
rollback;
