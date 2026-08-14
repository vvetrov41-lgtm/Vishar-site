-- 197_calendar_actor_authorization.sql
--
-- The Calendar Worker may trust a signed Cloudflare Access identity only after
-- the CRM access graph confirms current manage-integrations capability for the
-- exact artist. This RPC is backend-only and returns one boolean.

begin;
select no_plan();

select has_function(
  'public',
  'authorize_calendar_actor',
  array['text', 'uuid'],
  'Calendar actor authorization RPC exists'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.authorize_calendar_actor(text,uuid)',
    'EXECUTE'
  ),
  'anonymous callers cannot query Calendar actor authorization'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.authorize_calendar_actor(text,uuid)',
    'EXECUTE'
  ),
  'browser sessions cannot query the backend Calendar actor authorization RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.authorize_calendar_actor(text,uuid)',
    'EXECUTE'
  ),
  'service_role receives only the narrow Calendar actor authorization RPC'
);

insert into auth.users (id, email) values
  ('97777777-7777-4777-8777-777777777771', 'calendar-owner@example.test'),
  ('97777777-7777-4777-8777-777777777772', 'calendar-kristina@example.test'),
  ('97777777-7777-4777-8777-777777777773', 'calendar-disabled@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('97777777-7777-4777-8777-777777777771', 'calendar-owner@example.test', 'Calendar Owner', 'owner', true),
  ('97777777-7777-4777-8777-777777777772', 'calendar-kristina@example.test', 'Calendar Kristina', 'booking_manager', true),
  ('97777777-7777-4777-8777-777777777773', 'calendar-disabled@example.test', 'Calendar Disabled', 'booking_manager', false);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  (
    '97777777-7777-4777-8777-777777777772',
    'a2222222-2222-4222-8222-222222222222',
    'manager', false, false, true, true, true
  ),
  (
    '97777777-7777-4777-8777-777777777773',
    'a2222222-2222-4222-8222-222222222222',
    'manager', false, false, true, true, true
  );

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  public.authorize_calendar_actor(
    ' CALENDAR-OWNER@EXAMPLE.TEST ',
    'a1111111-1111-4111-8111-111111111111'
  ),
  'an active owner is authorized for Vladimir through its materialized membership'
);
select ok(
  public.authorize_calendar_actor(
    'calendar-owner@example.test',
    'a2222222-2222-4222-8222-222222222222'
  ),
  'an active owner is authorized for Kristina through its materialized membership'
);
select ok(
  public.authorize_calendar_actor(
    'calendar-kristina@example.test',
    'a2222222-2222-4222-8222-222222222222'
  ),
  'an active booking manager with can_manage_integrations is authorized for its artist'
);
select ok(
  not public.authorize_calendar_actor(
    'calendar-kristina@example.test',
    'a1111111-1111-4111-8111-111111111111'
  ),
  'the same booking manager is not authorized for another artist'
);
select ok(
  not public.authorize_calendar_actor(
    'calendar-disabled@example.test',
    'a2222222-2222-4222-8222-222222222222'
  ),
  'an inactive CRM profile is rejected even when its membership flag is true'
);
select ok(
  not public.authorize_calendar_actor(
    'missing@example.test',
    'a2222222-2222-4222-8222-222222222222'
  ),
  'an Access email with no CRM profile is rejected'
);
select ok(
  not public.authorize_calendar_actor(
    '',
    'a2222222-2222-4222-8222-222222222222'
  ),
  'a blank actor email is rejected'
);
reset role;

update public.artist_memberships
set can_manage_integrations = false
where profile_id = '97777777-7777-4777-8777-777777777772'
  and artist_id = 'a2222222-2222-4222-8222-222222222222';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok(
  not public.authorize_calendar_actor(
    'calendar-kristina@example.test',
    'a2222222-2222-4222-8222-222222222222'
  ),
  'revoking can_manage_integrations immediately revokes Calendar self-service'
);
reset role;

update public.artist_memberships
set can_manage_integrations = true,
    is_active = false
where profile_id = '97777777-7777-4777-8777-777777777772'
  and artist_id = 'a2222222-2222-4222-8222-222222222222';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok(
  not public.authorize_calendar_actor(
    'calendar-kristina@example.test',
    'a2222222-2222-4222-8222-222222222222'
  ),
  'deactivating the artist membership immediately revokes Calendar self-service'
);
reset role;

select * from finish();
rollback;
