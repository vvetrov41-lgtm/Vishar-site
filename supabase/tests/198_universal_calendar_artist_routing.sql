-- 198_universal_calendar_artist_routing.sql
--
-- Onboarding an artist's Google Calendar must be a CRM membership plus a
-- consent, never a Worker deployment. These tests pin the invariants that
-- make that safe: the route selector is derived from the owning artist, one
-- Google account backs at most one artist, and the backend-only resolver
-- refuses unknown, inactive and unauthorized artists identically.

begin;
select no_plan();

-- --------------------------------------------------------------------------
-- Grants
-- --------------------------------------------------------------------------

select has_function(
  'public',
  'resolve_calendar_artist_route',
  array['text', 'text'],
  'the Calendar artist resolver exists'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.resolve_calendar_artist_route(text,text)',
    'EXECUTE'
  ),
  'anonymous callers cannot resolve a Calendar artist route'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.resolve_calendar_artist_route(text,text)',
    'EXECUTE'
  ),
  'browser sessions cannot resolve a Calendar artist route'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.resolve_calendar_artist_route(text,text)',
    'EXECUTE'
  ),
  'only the backend resolves Calendar artist routes'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.reset_calendar_expected_account(uuid)',
    'EXECUTE'
  ),
  'anonymous callers cannot clear a recorded Google account'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.reset_calendar_expected_account(uuid)',
    'EXECUTE'
  ),
  'an authorized CRM operator can clear a recorded Google account'
);

-- --------------------------------------------------------------------------
-- Fixtures: a third artist nobody has ever written into Worker configuration
-- --------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.artists (id, slug, display_name, is_active) values
  ('a5555555-5555-4555-8555-555555555551', 'ucr-third', 'Third Artist', true),
  ('a5555555-5555-4555-8555-555555555552', 'ucr-fourth', 'Fourth Artist', true),
  ('a5555555-5555-4555-8555-555555555553', 'ucr-retired', 'Retired Artist', false);

insert into auth.users (id, email) values
  ('b5555555-5555-4555-8555-555555555551', 'ucr-owner@example.test'),
  ('b5555555-5555-4555-8555-555555555552', 'ucr-third-manager@example.test'),
  ('b5555555-5555-4555-8555-555555555553', 'ucr-reader@example.test'),
  ('b5555555-5555-4555-8555-555555555554', 'ucr-inactive@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('b5555555-5555-4555-8555-555555555551', 'ucr-owner@example.test', 'UCR Owner', 'owner', true),
  ('b5555555-5555-4555-8555-555555555552', 'ucr-third-manager@example.test', 'UCR Third Manager', 'booking_manager', true),
  ('b5555555-5555-4555-8555-555555555553', 'ucr-reader@example.test', 'UCR Reader', 'booking_manager', true),
  ('b5555555-5555-4555-8555-555555555554', 'ucr-inactive@example.test', 'UCR Inactive', 'booking_manager', false);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('b5555555-5555-4555-8555-555555555552', 'a5555555-5555-4555-8555-555555555551',
   'manager', false, false, true, true, true),
  -- Same artist, but no integration-management capability.
  ('b5555555-5555-4555-8555-555555555553', 'a5555555-5555-4555-8555-555555555551',
   'manager', false, false, true, false, true),
  ('b5555555-5555-4555-8555-555555555554', 'a5555555-5555-4555-8555-555555555551',
   'manager', false, false, true, true, true),
  ('b5555555-5555-4555-8555-555555555551', 'a5555555-5555-4555-8555-555555555553',
   'manager', false, false, true, true, true)
-- Owners may already have been granted membership of every artist by the
-- provisioning trigger, so this fixture states the capability it needs rather
-- than assuming it is the first writer.
on conflict (profile_id, artist_id) do update
set access_level = excluded.access_level,
    can_manage_integrations = excluded.can_manage_integrations,
    is_active = excluded.is_active;

-- --------------------------------------------------------------------------
-- The route selector belongs to exactly one artist
-- --------------------------------------------------------------------------

select throws_ok(
  $$insert into public.artist_integrations (
      artist_id, integration_type, provider, integration_key,
      external_account_label, configuration, is_enabled
    ) values (
      'a5555555-5555-4555-8555-555555555551', 'calendar', 'google',
      'google_calendar_ucr-fourth', 'wrong-route@example.test', '{}'::jsonb, false
    )$$,
  '23514', null,
  'a calendar selector naming another artist is rejected'
);
select throws_ok(
  $$insert into public.artist_integrations (
      artist_id, integration_type, provider, integration_key,
      external_account_label, configuration, is_enabled
    ) values (
      'a5555555-5555-4555-8555-555555555551', 'calendar', 'outlook',
      'google_calendar_ucr-third', 'wrong-provider@example.test', '{}'::jsonb, false
    )$$,
  '23514', null,
  'a calendar integration for another provider is rejected'
);

-- --------------------------------------------------------------------------
-- Connecting a brand new artist needs no source change
-- --------------------------------------------------------------------------

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.set_calendar_connection_metadata(
    'a5555555-5555-4555-8555-555555555551',
    'google_calendar_ucr-third',
    'Third.Artist@Example.Test',
    true
  )$$,
  'the backend connects an artist that appears in no Worker configuration'
);
reset role;

select is(
  (
    select external_account_label
    from public.artist_integrations
    where artist_id = 'a5555555-5555-4555-8555-555555555551'
      and integration_type = 'calendar'
  ),
  'third.artist@example.test',
  'the Google account is normalized and recorded'
);
select is(
  (
    select configuration -> 'presentation' ->> 'event_display_name'
    from public.artist_integrations
    where artist_id = 'a5555555-5555-4555-8555-555555555551'
      and integration_type = 'calendar'
  ),
  'Third Artist',
  'event presentation defaults to the artist display name'
);
select is(
  (
    select configuration -> 'presentation' ->> 'event_visibility'
    from public.artist_integrations
    where artist_id = 'a5555555-5555-4555-8555-555555555551'
      and integration_type = 'calendar'
  ),
  'public',
  'event visibility defaults to the same value the Worker variables used'
);

-- --------------------------------------------------------------------------
-- The recorded Google account is pinned
-- --------------------------------------------------------------------------

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.set_calendar_connection_metadata(
    'a5555555-5555-4555-8555-555555555551',
    'google_calendar_ucr-third',
    'someone.else@example.test',
    true
  )$$,
  '23505', null,
  'a consent for a different Google account cannot re-point a connected artist'
);
select throws_ok(
  $$select public.set_calendar_connection_metadata(
    'a5555555-5555-4555-8555-555555555552',
    'google_calendar_ucr-fourth',
    'third.artist@example.test',
    true
  )$$,
  '23505', null,
  'one Google account cannot back two artists'
);
select throws_ok(
  $$select public.set_calendar_connection_metadata(
    'a5555555-5555-4555-8555-555555555553',
    'google_calendar_ucr-retired',
    'retired@example.test',
    true
  )$$,
  null, null,
  'an inactive artist cannot be connected'
);
reset role;

-- --------------------------------------------------------------------------
-- Backend-only resolver: unknown, inactive and unauthorized look identical
-- --------------------------------------------------------------------------

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  public.resolve_calendar_artist_route('ucr-third-manager@example.test', 'ucr-third') ->> 'artist_id',
  'a5555555-5555-4555-8555-555555555551',
  'the slug hint resolves to the authoritative artist id'
);
select is(
  public.resolve_calendar_artist_route('ucr-third-manager@example.test', 'ucr-third') ->> 'integration_key',
  'google_calendar_ucr-third',
  'the resolver returns the derived route selector'
);
select is(
  public.resolve_calendar_artist_route('ucr-third-manager@example.test', 'ucr-third') ->> 'expected_account_email',
  'third.artist@example.test',
  'the resolver returns the pinned Google account'
);
select is(
  public.resolve_calendar_artist_route(
    'UCR-Third-Manager@Example.Test',
    'a5555555-5555-4555-8555-555555555551'
  ) ->> 'artist_slug',
  'ucr-third',
  'a UUID reference and a case-different actor email resolve the same artist'
);
select is(
  public.resolve_calendar_artist_route('ucr-third-manager@example.test', 'ucr-fourth'),
  null,
  'an operator with no membership of that artist is denied'
);
select is(
  public.resolve_calendar_artist_route('ucr-reader@example.test', 'ucr-third'),
  null,
  'a member without manage-integrations is denied'
);
select is(
  public.resolve_calendar_artist_route('ucr-inactive@example.test', 'ucr-third'),
  null,
  'a deactivated profile is denied'
);
select is(
  public.resolve_calendar_artist_route('ucr-owner@example.test', 'ucr-retired'),
  null,
  'an inactive artist is denied even for its owner'
);
select is(
  public.resolve_calendar_artist_route('ucr-third-manager@example.test', 'no-such-artist'),
  null,
  'an unknown artist is the same denial as an unauthorized one'
);
select is(
  public.resolve_calendar_artist_route('ucr-third-manager@example.test', '../admin'),
  null,
  'a malformed reference resolves to nothing'
);
select is(
  public.resolve_calendar_artist_route(null, 'ucr-third'),
  null,
  'a missing actor resolves to nothing'
);
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"b5555555-5555-4555-8555-555555555552","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.resolve_calendar_artist_route('ucr-third-manager@example.test', 'ucr-third')$$,
  '42501', null,
  'a browser session cannot resolve an artist route even for its own artist'
);
reset role;

-- --------------------------------------------------------------------------
-- Clearing the pin is capability-checked and refuses while connected
-- --------------------------------------------------------------------------

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"b5555555-5555-4555-8555-555555555553","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.reset_calendar_expected_account('a5555555-5555-4555-8555-555555555551')$$,
  '42501', null,
  'a member without manage-integrations cannot clear the recorded account'
);
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"b5555555-5555-4555-8555-555555555552","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.reset_calendar_expected_account('a5555555-5555-4555-8555-555555555551')$$,
  '55000', null,
  'the recorded account cannot be cleared under a live connection'
);
reset role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.set_calendar_connection_metadata(
    'a5555555-5555-4555-8555-555555555551',
    'google_calendar_ucr-third',
    'third.artist@example.test',
    false
  )$$,
  'the same RPC disconnects and keeps the recorded account'
);
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"b5555555-5555-4555-8555-555555555552","role":"authenticated"}',
  true
);
select is(
  public.reset_calendar_expected_account('a5555555-5555-4555-8555-555555555551') ->> 'cleared',
  'true',
  'a disconnected calendar can forget its Google account'
);
reset role;

select is(
  (
    select external_account_label
    from public.artist_integrations
    where artist_id = 'a5555555-5555-4555-8555-555555555551'
      and integration_type = 'calendar'
  ),
  null,
  'the pin is gone so a different Google account may be authorised next'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.set_calendar_connection_metadata(
    'a5555555-5555-4555-8555-555555555551',
    'google_calendar_ucr-third',
    'replacement@example.test',
    true
  )$$,
  'the artist rebinds to a different Google account after the reset'
);
reset role;

select is(
  (
    select configuration -> 'presentation' ->> 'event_display_name'
    from public.artist_integrations
    where artist_id = 'a5555555-5555-4555-8555-555555555551'
      and integration_type = 'calendar'
  ),
  'Third Artist',
  'event presentation survives disconnect, reset and reconnect'
);

-- --------------------------------------------------------------------------
-- Existing artists keep their Worker-era presentation
--
-- Migration 0137 seeds Vladimir's Blueberry colour and Kristina's Wisteria
-- label from the values their Worker variables used to supply. A freshly
-- migrated database has no calendar rows to seed, so what these tests pin is
-- the behaviour that makes the seed durable: a later connect or disconnect
-- must carry an existing presentation forward instead of resetting it.
-- --------------------------------------------------------------------------

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.set_calendar_connection_metadata(
    'a1111111-1111-4111-8111-111111111111',
    'google_calendar_vladimir',
    'vladimir-calendar@example.test',
    true
  )$$,
  'Vladimir connects through the generic route'
);
reset role;

update public.artist_integrations
set configuration = jsonb_set(
  configuration,
  '{presentation}',
  '{"event_visibility":"public","event_display_name":"Vladimir","event_color_id":"9","event_label_name":null,"event_label_color":null}'::jsonb
)
where artist_id = 'a1111111-1111-4111-8111-111111111111'
  and integration_type = 'calendar';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.set_calendar_connection_metadata(
    'a1111111-1111-4111-8111-111111111111',
    'google_calendar_vladimir',
    'vladimir-calendar@example.test',
    false
  )$$,
  'a later disconnect does not reset the seeded presentation'
);
reset role;

select is(
  (
    select configuration -> 'presentation' ->> 'event_color_id'
    from public.artist_integrations
    where artist_id = 'a1111111-1111-4111-8111-111111111111'
      and integration_type = 'calendar'
  ),
  '9',
  'Vladimir keeps the Blueberry colour across a disconnect'
);

update public.artist_integrations
set configuration = jsonb_set(
  configuration,
  '{presentation}',
  '{"event_visibility":"public","event_display_name":"Kristina","event_color_id":null,"event_label_name":"Wisteria","event_label_color":"#b39ddb"}'::jsonb
)
where artist_id = 'a1111111-1111-4111-8111-111111111111'
  and integration_type = 'calendar';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.set_calendar_connection_metadata(
    'a1111111-1111-4111-8111-111111111111',
    'google_calendar_vladimir',
    'vladimir-calendar@example.test',
    true
  )$$,
  'reconnecting preserves a Google event label target'
);
reset role;

select is(
  (
    select configuration -> 'presentation' ->> 'event_label_name'
    from public.artist_integrations
    where artist_id = 'a1111111-1111-4111-8111-111111111111'
      and integration_type = 'calendar'
  ),
  'Wisteria',
  'a Google event label survives a reconnect'
);
select is(
  (
    select configuration -> 'presentation' ->> 'event_label_color'
    from public.artist_integrations
    where artist_id = 'a1111111-1111-4111-8111-111111111111'
      and integration_type = 'calendar'
  ),
  '#b39ddb',
  'so does its colour, because both halves are required together'
);

-- A half-configured label would fail the Worker's label lookup on every
-- connection attempt, so the server drops both halves instead.
update public.artist_integrations
set configuration = jsonb_set(
  configuration,
  '{presentation}',
  '{"event_visibility":"public","event_display_name":"Vladimir","event_color_id":"9","event_label_name":"Wisteria","event_label_color":null}'::jsonb
)
where artist_id = 'a1111111-1111-4111-8111-111111111111'
  and integration_type = 'calendar';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.set_calendar_connection_metadata(
    'a1111111-1111-4111-8111-111111111111',
    'google_calendar_vladimir',
    'vladimir-calendar@example.test',
    true
  )$$,
  'a half-configured label does not block the connection'
);
reset role;

select is(
  (
    select configuration -> 'presentation' ->> 'event_label_name'
    from public.artist_integrations
    where artist_id = 'a1111111-1111-4111-8111-111111111111'
      and integration_type = 'calendar'
  ),
  null,
  'a half-configured label is normalized away rather than sent to Google'
);

-- --------------------------------------------------------------------------
-- Connection status is no longer a two-artist allowlist
-- --------------------------------------------------------------------------

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"b5555555-5555-4555-8555-555555555552","role":"authenticated"}',
  true
);
select is(
  (
    select count(*)::integer
    from public.list_calendar_connection_status()
    where artist_slug = 'ucr-third'
  ),
  1,
  'a third artist appears in Calendar Connections for its own manager'
);
select is(
  (
    select count(*)::integer
    from public.list_calendar_connection_status()
    where artist_slug <> 'ucr-third'
  ),
  0,
  'and no artist that manager cannot manage appears with it'
);
reset role;

select * from finish();
rollback;
