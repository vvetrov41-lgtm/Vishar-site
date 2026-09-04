-- 274_calendar_access_operator_directory.sql
--
-- The Calendar connector's edge allow-set is a projection of this directory, so
-- the directory must never be readable by a browser session and must never be
-- wider than the manage-integrations capability it mirrors.

begin;
select no_plan();

select has_function(
  'public',
  'list_calendar_access_operators',
  'the Calendar Access operator directory exists'
);
select ok(
  not has_function_privilege('anon', 'public.list_calendar_access_operators()', 'EXECUTE'),
  'anonymous callers cannot enumerate operator email addresses'
);
select ok(
  not has_function_privilege('authenticated', 'public.list_calendar_access_operators()', 'EXECUTE'),
  'a browser session cannot enumerate operator email addresses'
);
select ok(
  has_function_privilege('service_role', 'public.list_calendar_access_operators()', 'EXECUTE'),
  'only the backend reads the operator directory'
);

-- --------------------------------------------------------------------------
-- Fixtures: one owner, one manager with the capability, one without it, one
-- deactivated profile, and one manager of an inactive artist.
-- --------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.artists (id, slug, display_name, is_active) values
  ('a6666666-6666-4666-8666-666666666661', 'dir-active', 'Directory Active', true),
  ('a6666666-6666-4666-8666-666666666662', 'dir-retired', 'Directory Retired', false);

insert into auth.users (id, email) values
  ('b6666666-6666-4666-8666-666666666661', 'dir-owner@example.test'),
  ('b6666666-6666-4666-8666-666666666662', 'dir-manager@example.test'),
  ('b6666666-6666-4666-8666-666666666663', 'dir-noncapable@example.test'),
  ('b6666666-6666-4666-8666-666666666664', 'dir-inactive@example.test'),
  ('b6666666-6666-4666-8666-666666666665', 'dir-retired-artist@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('b6666666-6666-4666-8666-666666666661', 'dir-owner@example.test', 'Dir Owner', 'owner', true),
  ('b6666666-6666-4666-8666-666666666662', 'dir-manager@example.test', 'Dir Manager', 'booking_manager', true),
  ('b6666666-6666-4666-8666-666666666663', 'dir-noncapable@example.test', 'Dir NonCapable', 'booking_manager', true),
  ('b6666666-6666-4666-8666-666666666664', 'dir-inactive@example.test', 'Dir Inactive', 'booking_manager', false),
  ('b6666666-6666-4666-8666-666666666665', 'dir-retired-artist@example.test', 'Dir Retired Artist', 'booking_manager', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('b6666666-6666-4666-8666-666666666662', 'a6666666-6666-4666-8666-666666666661',
   'manager', false, false, true, true, true),
  ('b6666666-6666-4666-8666-666666666663', 'a6666666-6666-4666-8666-666666666661',
   'manager', false, false, true, false, true),
  ('b6666666-6666-4666-8666-666666666664', 'a6666666-6666-4666-8666-666666666661',
   'manager', false, false, true, true, true),
  ('b6666666-6666-4666-8666-666666666665', 'a6666666-6666-4666-8666-666666666662',
   'manager', false, false, true, true, true)
on conflict (profile_id, artist_id) do update
set can_manage_integrations = excluded.can_manage_integrations,
    is_active = excluded.is_active;

-- --------------------------------------------------------------------------
-- The projection is exactly the manage-integrations capability
-- --------------------------------------------------------------------------

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  (select count(*)::int from public.list_calendar_access_operators()
    where operator_email = 'dir-manager@example.test'),
  1,
  'a manager holding manage-integrations on an active artist is in the directory'
);
select is(
  (select is_owner from public.list_calendar_access_operators()
    where operator_email = 'dir-manager@example.test'),
  false,
  'a booking manager is not marked as an owner'
);
select is(
  (select count(*)::int from public.list_calendar_access_operators()
    where operator_email = 'dir-noncapable@example.test'),
  0,
  'a member without manage-integrations never reaches the Access boundary'
);
select is(
  (select count(*)::int from public.list_calendar_access_operators()
    where operator_email = 'dir-inactive@example.test'),
  0,
  'a deactivated profile is dropped from the boundary'
);
select is(
  (select count(*)::int from public.list_calendar_access_operators()
    where operator_email = 'dir-retired-artist@example.test'),
  0,
  'managing only an inactive artist does not admit anybody'
);
select is(
  (select is_owner from public.list_calendar_access_operators()
    where operator_email = 'dir-owner@example.test'),
  true,
  'the owner is marked so the sync can refuse an owner-less allow-set'
);
select is(
  (select count(*)::int from (
     select operator_email from public.list_calendar_access_operators()
     group by operator_email having count(*) > 1) d),
  0,
  'each operator appears exactly once however many artists they manage'
);
select is(
  (select count(*)::int from public.list_calendar_access_operators()
    where operator_email <> lower(btrim(operator_email))
       or operator_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'),
  0,
  'every returned address is normalised and shaped like an email selector'
);

reset role;

-- Revoking the capability removes the operator from the boundary on the next
-- sync, with no Cloudflare edit. service_role holds no direct table privilege,
-- so the membership change is made by the migration owner exactly as a CRM
-- write would reach it.
update public.artist_memberships
set can_manage_integrations = false
where profile_id = 'b6666666-6666-4666-8666-666666666662'
  and artist_id = 'a6666666-6666-4666-8666-666666666661';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select count(*)::int from public.list_calendar_access_operators()
    where operator_email = 'dir-manager@example.test'),
  0,
  'revoking manage-integrations narrows the boundary without touching Cloudflare'
);
reset role;

-- --------------------------------------------------------------------------
-- Backend-only
-- --------------------------------------------------------------------------

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"b6666666-6666-4666-8666-666666666661","role":"authenticated"}',
  true
);
select throws_ok(
  $$select * from public.list_calendar_access_operators()$$,
  '42501', null,
  'even an owner session cannot read the operator directory from the browser'
);
reset role;

select * from finish();
rollback;
