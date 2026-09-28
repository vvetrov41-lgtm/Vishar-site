-- 319_artist_facing_notification_recipients.sql
--
-- Migration 20260928140000. Administrative owner access to another artist is
-- not a subscription to that artist's personal notifications, and "mark all
-- read" is one server-side update bounded by the caller's own visible rows.
--
-- Fixtures are synthetic and rolled back.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- ACL
-- ---------------------------------------------------------------------------

select ok(
  has_function_privilege('authenticated', 'public.mark_all_notifications_read()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.mark_all_notifications_read()', 'EXECUTE'),
  'mark all read is callable by a signed-in session only'
);
select ok(
  (select p.prosecdef and 'search_path=pg_catalog, public, crm_private' = any (p.proconfig)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'mark_all_notifications_read'),
  'mark all read is SECURITY DEFINER with a pinned search_path'
);
select ok(
  not has_function_privilege('authenticated', 'crm_private.artist_notification_recipients(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'crm_private.artist_notification_recipients(uuid)', 'EXECUTE'),
  'the recipient rule is internal'
);

-- ---------------------------------------------------------------------------
-- Fixtures: a studio owner who runs their own artist and administers a second
-- artist whose own profile is a manager membership.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('f3190000-0000-4000-8000-000000000001', 'afr.owner@example.test'),
  ('f3190000-0000-4000-8000-000000000002', 'afr.kmanager@example.test'),
  ('f3190000-0000-4000-8000-000000000003', 'afr.artist@example.test'),
  ('f3190000-0000-4000-8000-000000000004', 'afr.helper@example.test');

insert into public.profiles (id, email, role, is_active) values
  ('f3190000-0000-4000-8000-000000000001', 'afr.owner@example.test', 'booking_manager', true),
  ('f3190000-0000-4000-8000-000000000002', 'afr.kmanager@example.test', 'booking_manager', true),
  ('f3190000-0000-4000-8000-000000000003', 'afr.artist@example.test', 'booking_manager', true),
  ('f3190000-0000-4000-8000-000000000004', 'afr.helper@example.test', 'booking_manager', true);

insert into public.artists (id, slug, display_name, is_active) values
  ('f3191000-0000-4000-8000-00000000000a', 'afr-own', 'Own', true),
  ('f3191000-0000-4000-8000-00000000000b', 'afr-managed', 'Managed', true),
  ('f3191000-0000-4000-8000-00000000000c', 'afr-team', 'Team', true);

insert into public.artist_memberships
  (profile_id, artist_id, access_level, can_view_finance, can_manage_finance,
   can_manage_sessions, can_manage_integrations, is_active)
values
  -- Own: the owner is the only member, so they are its artist-facing profile.
  ('f3190000-0000-4000-8000-000000000001', 'f3191000-0000-4000-8000-00000000000a', 'owner', true, true, true, true, true),
  -- Managed: owner has admin access; the artist's own profile is a manager.
  ('f3190000-0000-4000-8000-000000000001', 'f3191000-0000-4000-8000-00000000000b', 'owner', true, true, true, true, true),
  ('f3190000-0000-4000-8000-000000000002', 'f3191000-0000-4000-8000-00000000000b', 'manager', false, false, true, false, true),
  -- Team: an artist and a helper manager; reminders go to the artist only.
  ('f3190000-0000-4000-8000-000000000003', 'f3191000-0000-4000-8000-00000000000c', 'artist', false, false, true, false, true),
  ('f3190000-0000-4000-8000-000000000004', 'f3191000-0000-4000-8000-00000000000c', 'manager', false, false, true, false, true),
  ('f3190000-0000-4000-8000-000000000001', 'f3191000-0000-4000-8000-00000000000c', 'owner', true, true, true, true, true);

-- ---------------------------------------------------------------------------
-- Recipient rule
-- ---------------------------------------------------------------------------

select results_eq(
  $$select profile_id from crm_private.artist_notification_recipients('f3191000-0000-4000-8000-00000000000a')$$,
  $$values ('f3190000-0000-4000-8000-000000000001'::uuid)$$,
  'an owner who is the only member of their artist receives its notifications'
);
select results_eq(
  $$select profile_id from crm_private.artist_notification_recipients('f3191000-0000-4000-8000-00000000000b')$$,
  $$values ('f3190000-0000-4000-8000-000000000002'::uuid)$$,
  'a managed artist''s notifications go to its own manager profile, not the administering owner'
);
select results_eq(
  $$select profile_id from crm_private.artist_notification_recipients('f3191000-0000-4000-8000-00000000000c')$$,
  $$values ('f3190000-0000-4000-8000-000000000003'::uuid)$$,
  'an artist member is preferred over a helper manager and the owner'
);
select results_eq(
  $$select profile_id from crm_private.automation_notification_recipients('f3191000-0000-4000-8000-00000000000b')$$,
  $$values ('f3190000-0000-4000-8000-000000000002'::uuid)$$,
  'automation, failure-alert and appointment producers use the same rule'
);

update public.artist_memberships set is_active = false
where profile_id = 'f3190000-0000-4000-8000-000000000002'
  and artist_id = 'f3191000-0000-4000-8000-00000000000b';
select results_eq(
  $$select profile_id from crm_private.artist_notification_recipients('f3191000-0000-4000-8000-00000000000b')$$,
  $$values ('f3190000-0000-4000-8000-000000000001'::uuid)$$,
  'the owner is the fallback only when the artist has no active artist-facing member'
);
update public.artist_memberships set is_active = true
where profile_id = 'f3190000-0000-4000-8000-000000000002'
  and artist_id = 'f3191000-0000-4000-8000-00000000000b';

update public.artist_memberships set is_active = false
where profile_id = 'f3190000-0000-4000-8000-000000000003'
  and artist_id = 'f3191000-0000-4000-8000-00000000000c';
select results_eq(
  $$select profile_id from crm_private.artist_notification_recipients('f3191000-0000-4000-8000-00000000000c')$$,
  $$values ('f3190000-0000-4000-8000-000000000001'::uuid)$$,
  'a deactivated artist is not silently replaced by a helper manager; the owner is the safe fallback'
);
update public.artist_memberships set is_active = true
where profile_id = 'f3190000-0000-4000-8000-000000000003'
  and artist_id = 'f3191000-0000-4000-8000-00000000000c';

-- Follow-ups: unassigned goes to the artist-facing profile; an explicit
-- assignment to the owner stays with the owner.
insert into public.clients (id, full_name, email) values
  ('f3192000-0000-4000-8000-000000000001', 'Afr Client', 'afr.client@example.test');
insert into public.follow_ups (id, artist_id, subject, due_at, assigned_to, status, client_id) values
  ('f3193000-0000-4000-8000-000000000001', 'f3191000-0000-4000-8000-00000000000b',
   'Unassigned', now() - interval '1 hour', null, 'open', 'f3192000-0000-4000-8000-000000000001'),
  ('f3193000-0000-4000-8000-000000000002', 'f3191000-0000-4000-8000-00000000000b',
   'Assigned to owner', now() - interval '1 hour', 'f3190000-0000-4000-8000-000000000001', 'open',
   'f3192000-0000-4000-8000-000000000001');

select results_eq(
  $$select profile_id from crm_private.follow_up_recipients('f3193000-0000-4000-8000-000000000001')$$,
  $$values ('f3190000-0000-4000-8000-000000000002'::uuid)$$,
  'an unassigned follow-up for a managed artist reaches the artist''s manager profile'
);
select results_eq(
  $$select profile_id from crm_private.follow_up_recipients('f3193000-0000-4000-8000-000000000002')$$,
  $$values ('f3190000-0000-4000-8000-000000000001'::uuid)$$,
  'a follow-up explicitly assigned to the owner still reaches the owner'
);

-- Telegram gate: a paused artist-facing Telegram does not move alerts to the owner.
insert into crm_private.telegram_destinations(
  id, destination_kind, profile_id, chat_id, chat_type, safe_label, is_active, connected_by_profile_id
) values
  ('f3194000-0000-4000-8000-000000000001', 'profile', 'f3190000-0000-4000-8000-000000000001',
   '73190001', 'private', 'Telegram', true, 'f3190000-0000-4000-8000-000000000001');
insert into public.notification_preferences(profile_id, channel, is_enabled) values
  ('f3190000-0000-4000-8000-000000000001', 'telegram', true);

select ok(
  not crm_private.telegram_notification_recipient_eligible(
    'f3190000-0000-4000-8000-000000000001', 'f3191000-0000-4000-8000-00000000000b',
    (select workspace_id from public.artists where id = 'f3191000-0000-4000-8000-00000000000b')),
  'the owner is not a Telegram fallback for an artist whose manager has no Telegram'
);
select ok(
  crm_private.telegram_notification_recipient_eligible(
    'f3190000-0000-4000-8000-000000000001', 'f3191000-0000-4000-8000-00000000000a',
    (select workspace_id from public.artists where id = 'f3191000-0000-4000-8000-00000000000a')),
  'the owner still receives Telegram alerts for their own artist'
);

-- Administrative access is unchanged by any of this.
select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"f3190000-0000-4000-8000-000000000001"}', true);
set local role authenticated;
select ok(public.can_access_artist('f3191000-0000-4000-8000-00000000000b'),
  'the owner keeps administrative access to the managed artist');
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- Mark all read
-- ---------------------------------------------------------------------------

insert into public.notifications
  (id, recipient_profile_id, artist_id, notification_type, title, priority, status, dedupe_key, scheduled_at, read_at, delivered_at)
values
  ('f3195000-0000-4000-8000-000000000001', 'f3190000-0000-4000-8000-000000000001', 'f3191000-0000-4000-8000-00000000000a',
   'test.one', 'One', 'normal', 'delivered', 'afr:1', now() - interval '1 hour', null, null),
  ('f3195000-0000-4000-8000-000000000002', 'f3190000-0000-4000-8000-000000000001', 'f3191000-0000-4000-8000-00000000000a',
   'test.two', 'Two', 'normal', 'pending', 'afr:2', now() - interval '1 hour', null, null),
  ('f3195000-0000-4000-8000-000000000003', 'f3190000-0000-4000-8000-000000000001', null,
   'test.three', 'Three', 'normal', 'delivered', 'afr:3', now() - interval '1 hour', null, null),
  ('f3195000-0000-4000-8000-000000000004', 'f3190000-0000-4000-8000-000000000001', 'f3191000-0000-4000-8000-00000000000a',
   'test.old', 'Already read', 'normal', 'read', 'afr:4', now() - interval '3 days', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('f3195000-0000-4000-8000-000000000005', 'f3190000-0000-4000-8000-000000000002', 'f3191000-0000-4000-8000-00000000000b',
   'test.other', 'Someone else''s', 'normal', 'delivered', 'afr:5', now() - interval '1 hour', null, null),
  -- Addressed to the manager but for an artist they do not hold: out of scope.
  ('f3195000-0000-4000-8000-000000000006', 'f3190000-0000-4000-8000-000000000002', 'f3191000-0000-4000-8000-00000000000a',
   'test.scope', 'Out of scope', 'normal', 'delivered', 'afr:6', now() - interval '1 hour', null, null),
  ('f3195000-0000-4000-8000-000000000007', 'f3190000-0000-4000-8000-000000000001', 'f3191000-0000-4000-8000-00000000000a',
   'test.dismissed', 'Dismissed', 'normal', 'dismissed', 'afr:7', now() - interval '1 hour', null, null);

select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"f3190000-0000-4000-8000-000000000001"}', true);
set local role authenticated;

select is(
  (select count(*)::integer from public.list_notifications(null, 200) where id::text like 'f3195000%'),
  4,
  'the list shows the caller''s own rows and hides dismissed ones'
);
select is(public.mark_all_notifications_read(), 3, 'every unread row of the caller is marked read in one call');
select is(public.mark_all_notifications_read(), 0, 'a second call changes nothing');
select is(
  (select count(*)::integer from public.list_notifications(null, 200)
   where id::text like 'f3195000%' and status <> 'read'),
  0,
  'nothing the caller can see is left unread'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  (select read_at from public.notifications where id = 'f3195000-0000-4000-8000-000000000004'),
  '2026-01-01T00:00:00Z'::timestamptz,
  'an already-read row keeps its original read time'
);
select ok(
  (select bool_and(read_at is not null and delivered_at is not null)
   from public.notifications where id in ('f3195000-0000-4000-8000-000000000001',
     'f3195000-0000-4000-8000-000000000002', 'f3195000-0000-4000-8000-000000000003')),
  'marked rows carry read_at and delivered_at'
);
select is(
  (select status::text from public.notifications where id = 'f3195000-0000-4000-8000-000000000005'),
  'delivered',
  'another profile''s notification is untouched'
);
select is(
  (select status::text from public.notifications where id = 'f3195000-0000-4000-8000-000000000007'),
  'dismissed',
  'a dismissed row stays dismissed'
);

select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"f3190000-0000-4000-8000-000000000002"}', true);
set local role authenticated;
select is(public.mark_all_notifications_read(), 1,
  'the manager marks only rows for artists they still hold');
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select status::text from public.notifications where id = 'f3195000-0000-4000-8000-000000000006'),
  'delivered',
  'a row for an artist outside the caller''s scope is not changed'
);

select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select throws_ok(
  $$select public.mark_all_notifications_read()$$,
  '42501',
  null,
  'an anonymous caller cannot reach the function'
);
reset role;

select * from finish();
rollback;
