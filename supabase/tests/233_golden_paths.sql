-- 233_golden_paths.sql
--
-- Phase U. Every phase before this one tested its own migration against its own
-- fixtures. That proves each piece works; it does not prove they compose.
--
-- This file onboards one brand-new artist the way a real studio would, and then
-- follows a single real enquiry all the way through: workspace provisioning,
-- membership, capability, a self-service booking source, a hosted form
-- submission, the durable intake, the activity projection, an automation rule,
-- a scheduler tick, a notification landing in the right person's inbox, the
-- consent gate on contacting that client, a workspace automation default, and
-- the unified GPT resolving the same artist through the same membership layer.
--
-- The point is the seams. Each assertion below is about something no single
-- earlier test could see, because it needs two phases to be true at once.
--
-- Nothing here is artist-specific, hard-coded to Vladimir or Kristina, or
-- dependent on a Cloudflare secret. That is the claim Phase U has to support:
-- a new artist arrives and the platform already works for them.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Act 0. The cast
--
-- One installation owner, one artist who owns their own book, one manager who
-- helps them, and one outsider who belongs to a different artist entirely.
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('9a011111-1111-4111-8111-111111111111', 'golden-owner@example.test'),
  ('9a022222-2222-4222-8222-222222222222', 'golden-artist@example.test'),
  ('9a033333-3333-4333-8333-333333333333', 'golden-manager@example.test'),
  ('9a044444-4444-4444-8444-444444444444', 'golden-outsider@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('9a011111-1111-4111-8111-111111111111', 'golden-owner@example.test',
   'Golden Owner', 'owner', true),
  ('9a022222-2222-4222-8222-222222222222', 'golden-artist@example.test',
   'Golden Artist', 'booking_manager', true),
  ('9a033333-3333-4333-8333-333333333333', 'golden-manager@example.test',
   'Golden Manager', 'booking_manager', true),
  ('9a044444-4444-4444-8444-444444444444', 'golden-outsider@example.test',
   'Golden Outsider', 'booking_manager', true);

-- The outsider belongs to an artist that already existed. They are the control:
-- nothing the new artist does may ever reach them.
insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values (
  '9a044444-4444-4444-8444-444444444444',
  'a2222222-2222-4222-8222-222222222222', 'artist',
  false, false, true, true, true
);

create function pg_temp.who(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.who(text) to authenticated, service_role;

create function pg_temp.owner() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"9a011111-1111-4111-8111-111111111111","role":"authenticated"}', true)::void;
$$;
create function pg_temp.artist() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"9a022222-2222-4222-8222-222222222222","role":"authenticated"}', true)::void;
$$;
create function pg_temp.manager() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"9a033333-3333-4333-8333-333333333333","role":"authenticated"}', true)::void;
$$;
create function pg_temp.outsider() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub":"9a044444-4444-4444-8444-444444444444","role":"authenticated"}', true)::void;
$$;
create function pg_temp.backend() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', true)::void;
$$;

-- The hosted form requires between one and three reference images, so the
-- golden path submits a real one rather than an empty list.
create function pg_temp.reference_files() returns jsonb language sql immutable as $$
  select jsonb_build_array(jsonb_build_object(
    'mime_type', 'image/jpeg',
    'safe_extension', 'jpg',
    'byte_size', 2048,
    'original_filename', 'golden-reference.jpg'
  ));
$$;
grant execute on function pg_temp.owner() to authenticated, service_role;
grant execute on function pg_temp.artist() to authenticated, service_role;
grant execute on function pg_temp.manager() to authenticated, service_role;
grant execute on function pg_temp.outsider() to authenticated, service_role;
grant execute on function pg_temp.backend() to authenticated, service_role;
grant execute on function pg_temp.reference_files() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Act 1. A new artist exists, and a workspace exists because of it
--
-- Phase C's claim is that onboarding needs no workspace bookkeeping: creating
-- the artist provisions one. Nobody has to remember to do it.
-- ---------------------------------------------------------------------------

insert into public.artists (
  id, slug, display_name, timezone, default_currency,
  booking_reference_prefix, is_active
) values (
  'a7777777-7777-4777-8777-777777777777', 'golden', 'Golden',
  'Europe/London', 'GBP', 'GLD', true
);

select isnt(
  (select workspace_id from public.artists
   where id = 'a7777777-7777-4777-8777-777777777777'),
  null,
  'creating an artist provisions their workspace with no separate step'
);
select is(
  (select w.workspace_type::text
   from public.workspaces w
   join public.artists a on a.workspace_id = w.id
   where a.id = 'a7777777-7777-4777-8777-777777777777'),
  'solo',
  'a new artist starts in their own solo workspace'
);

-- ---------------------------------------------------------------------------
-- Act 2. Membership, and only membership, opens the door
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.owner();

select isnt(
  public.grant_workspace_artist_membership(
    '9a022222-2222-4222-8222-222222222222',
    'a7777777-7777-4777-8777-777777777777',
    'artist', true, true, true, true, true),
  null,
  'the installation owner staffs the new artist through the named RPC'
);
select isnt(
  public.grant_workspace_artist_membership(
    '9a033333-3333-4333-8333-333333333333',
    'a7777777-7777-4777-8777-777777777777',
    'manager', false, false, true, true, true),
  null,
  'and adds a manager to help them'
);

-- Phase B: the capability registry answers for an artist nobody wrote code for.
select pg_temp.artist();
select ok(
  (select array['view_sessions', 'manage_sessions', 'manage_enquiries',
                'manage_booking_sources', 'manage_automations']
          <@ array_agg(capability)
   from public.list_capabilities('a7777777-7777-4777-8777-777777777777')),
  'the new artist holds their own operational capabilities on day one'
);
select ok(
  (select 'manage_finance' = any (array_agg(capability))
   from public.list_capabilities('a7777777-7777-4777-8777-777777777777')),
  'and the finance right the owner granted them'
);

-- The manager was granted the same artist but no finance flag. Same registry,
-- same artist, different answer: the capability follows the membership row.
select pg_temp.manager();
select ok(
  (select array['view_sessions', 'manage_sessions', 'manage_enquiries']
          <@ array_agg(capability)
   from public.list_capabilities('a7777777-7777-4777-8777-777777777777')),
  'the manager holds the operational capabilities they were given'
);
select ok(
  (select 'manage_finance' <> all (array_agg(capability))
   from public.list_capabilities('a7777777-7777-4777-8777-777777777777')),
  'but not finance, which was never granted to them'
);

select pg_temp.outsider();
select is(
  (select count(*)::int from public.list_accessible_artists()
   where id = 'a7777777-7777-4777-8777-777777777777'),
  0,
  'an unrelated artist''s staff cannot see the new artist at all'
);
select is(
  (select count(*)::int
   from public.list_capabilities('a7777777-7777-4777-8777-777777777777')),
  0,
  'and hold no capability whatsoever on them'
);

-- ---------------------------------------------------------------------------
-- Act 3. The artist opens their own booking source, with no deploy
--
-- Phase H/I-J's claim: a booking source is data, not configuration. Nobody
-- edits a Worker, a wrangler file or an environment variable to add one.
-- ---------------------------------------------------------------------------

select pg_temp.artist();

create temporary table t_source as
select public.create_booking_source(
  'a7777777-7777-4777-8777-777777777777',
  'hosted', 'Golden hosted enquiry form', null, 'tattoo-enquiry', true
) as source_id;
grant select on t_source to public;

select isnt(
  (select source_id from t_source), null,
  'the artist creates their own hosted booking source'
);

create temporary table t_public as
select b.public_source_id
from public.booking_sources b
where b.id = (select source_id from t_source);
grant select on t_public to public;

select pg_temp.outsider();
select throws_ok(
  $$select public.list_booking_sources('a7777777-7777-4777-8777-777777777777')$$,
  '42501', null,
  'the routing map of another artist is refused outright, not returned empty'
);

-- ---------------------------------------------------------------------------
-- Act 4. A stranger fills in the form, and the enquiry lands in the right book
--
-- The submitter names a form, never an artist. The artist is derived.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.backend();
set local role service_role;

create temporary table t_intake as
select public.create_hosted_enquiry_intake(
  (select public_source_id from t_public),
  '9a999999-9999-4999-8999-999999999999',
  jsonb_build_object(
    'full_name', 'Golden Client',
    'email', 'golden-client@example.test',
    'preferred_contact', 'Email'
  ),
  jsonb_build_object(
    'project_type', 'Blackwork',
    'placement', 'Forearm',
    'approximate_size', '15 cm',
    'cover_up', 'No',
    'preferred_timing', 'Flexible',
    'idea', 'Golden path end-to-end enquiry.',
    'source', '/forms/golden',
    'privacy_acknowledged', true,
    'privacy_notice_version', '2026-07-29'
  ),
  pg_temp.reference_files()
) as r;
grant select on t_intake to public;

select is(
  (select r ->> 'artist_id' from t_intake),
  'a7777777-7777-4777-8777-777777777777',
  'the hosted form resolves to the new artist from the form id alone'
);

reset role;
create temporary table t_enquiry as
select (r ->> 'enquiry_id')::uuid as enquiry_id,
       (select e.client_id from public.enquiries e
        where e.id = (r ->> 'enquiry_id')::uuid) as client_id
from t_intake;
grant select on t_enquiry to public;

-- ---------------------------------------------------------------------------
-- Act 5. An automation the artist wrote themselves reacts to it
--
-- Phase N materialises jobs from the activity projection. The enquiry above
-- produced a real activity row, so the rule has something to fire on.
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.artist();

create temporary table t_rule as
select public.create_automation_rule(
  'a7777777-7777-4777-8777-777777777777',
  'Tell me about new enquiries',
  'enquiry.created',
  'A new enquiry arrived',
  'Open the CRM to review it.',
  null, null, 0, 'normal'
) as rule_id;
grant select on t_rule to public;

select isnt(
  (select rule_id from t_rule), null,
  'the new artist writes their own automation with no engineer involved'
);

-- A rule arrives switched off, exactly as a booking source does. An automation
-- that started firing the moment it was typed would be the wrong default.
select is(
  (select is_enabled from public.list_automation_rules(
     'a7777777-7777-4777-8777-777777777777')
   where id = (select rule_id from t_rule)),
  false,
  'a new automation rule is created switched off'
);

select is(
  public.set_automation_rule_enabled((select rule_id from t_rule), true),
  true,
  'the artist turns their own rule on'
);

select pg_temp.outsider();
select is(
  (select count(*)::int from public.list_automation_rules(
     'a7777777-7777-4777-8777-777777777777')),
  0,
  'another artist''s staff cannot read those rules'
);

-- A second enquiry, now that the rule exists, is the one the engine reacts to.
reset role;
select pg_temp.backend();
set local role service_role;

create temporary table t_intake2 as
select public.create_hosted_enquiry_intake(
  (select public_source_id from t_public),
  '9a888888-8888-4888-8888-888888888888',
  jsonb_build_object(
    'full_name', 'Golden Client Two',
    'email', 'golden-client-two@example.test',
    'preferred_contact', 'Email'
  ),
  jsonb_build_object(
    'project_type', 'Fine line',
    'placement', 'Ankle',
    'approximate_size', '8 cm',
    'cover_up', 'No',
    'preferred_timing', 'Flexible',
    'idea', 'Second golden path enquiry, after the rule exists.',
    'source', '/forms/golden',
    'privacy_acknowledged', true,
    'privacy_notice_version', '2026-07-29'
  ),
  pg_temp.reference_files()
) as r;
grant select on t_intake2 to public;

create temporary table t_tick as
select * from public.service_run_automation_tick(100);
grant select on t_tick to public;

select cmp_ok(
  (select materialised from t_tick), '>=', 1,
  'the scheduler materialises a job from the artist''s own rule'
);
select cmp_ok(
  (select notified from t_tick), '>=', 1,
  'and the tick delivers at least one internal notification'
);

-- ---------------------------------------------------------------------------
-- Act 6. The notification reaches the artist, and nobody else
-- ---------------------------------------------------------------------------

reset role;
set local role authenticated;
select pg_temp.artist();

select cmp_ok(
  (select count(*)::int from public.list_notifications(null, 50)
   where artist_id = 'a7777777-7777-4777-8777-777777777777'),
  '>=', 1,
  'the artist finds the automation notification in their own inbox'
);
select is(
  (select title from public.list_notifications(null, 50)
   where artist_id = 'a7777777-7777-4777-8777-777777777777'
   order by scheduled_at desc limit 1),
  'A new enquiry arrived',
  'and it says what the artist wrote, not what a developer hard-coded'
);

select pg_temp.outsider();
select is(
  (select count(*)::int from public.list_notifications(null, 50)
   where artist_id = 'a7777777-7777-4777-8777-777777777777'),
  0,
  'an unrelated artist''s staff receives none of it'
);

-- ---------------------------------------------------------------------------
-- Act 7. The consent gate already protects a client nobody configured
--
-- Phase O shipped before anything could send a message. This is the assertion
-- that the guard is actually in the path for a brand-new client.
-- ---------------------------------------------------------------------------

select pg_temp.artist();

select is(
  public.may_contact_client(
    (select client_id from t_enquiry), 'email', 'session_reminder_24h'),
  true,
  'service traffic to a new client is allowed without a consent record'
);
select is(
  public.may_contact_client(
    (select client_id from t_enquiry), 'email', 'studio_news'),
  false,
  'marketing to the same client is refused, because silence is not consent'
);

select is(
  public.record_client_marketing_consent(
    (select client_id from t_enquiry), 'email', 'granted',
    'booking_form', 'forms/golden'),
  true,
  'the artist records a real consent decision'
);
select is(
  public.may_contact_client(
    (select client_id from t_enquiry), 'email', 'studio_news'),
  true,
  'and only then may marketing reach that client'
);

-- ---------------------------------------------------------------------------
-- Act 8. A studio default reaches the new artist without touching their rules
--
-- Phase P expands a workspace default into an artist-owned copy. The new artist
-- is the case that matters: they were not present when the default was written.
-- ---------------------------------------------------------------------------

-- Phase P shipped its control plane closed: these RPCs are granted to no API
-- role at all, pending the release that gives them a screen. That is the
-- current, deliberate state, so the golden path asserts it rather than
-- pretending a manager could click this today.
select ok(
  (select bool_and(
     not has_function_privilege(r, f, 'EXECUTE'))
   from unnest(array['anon', 'authenticated', 'service_role']) r
   cross join unnest(array[
     'public.upsert_workspace_automation_default(uuid,uuid,text,text,text,text,text,text,integer,public.notification_priority,boolean)',
     'public.apply_workspace_automation_defaults_to_artist(uuid)',
     'public.list_workspace_automation_defaults(uuid)']) f),
  'the workspace automation control plane is reachable by no API role yet'
);

-- Exercising it therefore needs the definer boundary a future surface would
-- provide. The mechanism is what matters here: a default written before this
-- artist existed still reaches them.
reset role;
create function pg_temp.write_default(p_workspace_id uuid) returns uuid
language sql security definer set search_path = pg_catalog, public, crm_private as $$
  select public.upsert_workspace_automation_default(
    p_workspace_id, null,
    'Studio policy: chase new enquiries',
    'enquiry.created',
    'Studio reminder: a new enquiry is waiting',
    'The studio asks that new enquiries are answered the same day.',
    null, null, 0, 'normal', true);
$$;
create function pg_temp.apply_defaults(p_artist_id uuid) returns integer
language sql security definer set search_path = pg_catalog, public, crm_private as $$
  select public.apply_workspace_automation_defaults_to_artist(p_artist_id);
$$;
grant execute on function pg_temp.write_default(uuid) to authenticated;
grant execute on function pg_temp.apply_defaults(uuid) to authenticated;

set local role authenticated;
select pg_temp.owner();

create temporary table t_default as
select pg_temp.write_default(
  (select workspace_id from public.artists
   where id = 'a7777777-7777-4777-8777-777777777777')
) as default_id;
grant select on t_default to public;

select isnt((select default_id from t_default), null,
  'the workspace owner writes one studio-wide default');

select cmp_ok(
  pg_temp.apply_defaults('a7777777-7777-4777-8777-777777777777'),
  '>=', 1,
  'applying it to the new artist produces a real artist-owned rule'
);
select cmp_ok(
  (select count(*)::int from public.list_automation_rules(
     'a7777777-7777-4777-8777-777777777777')),
  '>=', 2,
  'the artist now owns both their own rule and the studio one'
);

-- ---------------------------------------------------------------------------
-- Act 9. The unified GPT resolves the same artist through the same memberships
--
-- Phase S-T's whole claim is that it adds no second authorization path. This is
-- where that gets checked against an artist the GPT layer has never seen.
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.backend();

update crm_private.gpt_action_clients
set oauth_client_id = 'oauth-golden-unified',
    can_read_appointments = true,
    can_manage_appointments = true,
    can_read_enquiries = true,
    is_active = true
where integration_key = 'vishar-unified-gpt';

create function pg_temp.gpt_enquiry_artist() returns uuid
language sql security definer set search_path = pg_catalog, public, crm_private as $$
  select c.artist_id from crm_private.require_gpt_enquiry_context() c;
$$;
grant execute on function pg_temp.gpt_enquiry_artist() to authenticated;

set local role authenticated;
select pg_temp.who(
  '{"sub":"9a022222-2222-4222-8222-222222222222","role":"authenticated","client_id":"oauth-golden-unified"}'
);

select is(
  (select array_agg(a ->> 'display_name')
   from jsonb_array_elements(public.gpt_artist_context(null) -> 'artists') a),
  array['Golden'],
  'the unified GPT offers the new artist to the human who actually holds them'
);
select is(
  public.gpt_artist_context(null) ->> 'active_artist_id',
  'a7777777-7777-4777-8777-777777777777',
  'a human with exactly one artist needs no selection step'
);
select is(
  pg_temp.gpt_enquiry_artist(),
  'a7777777-7777-4777-8777-777777777777'::uuid,
  'and GPT enquiry reads resolve to that artist through the ordinary context'
);

-- The outsider, on the same GPT client, reaches their own artist and only that.
select pg_temp.who(
  '{"sub":"9a044444-4444-4444-8444-444444444444","role":"authenticated","client_id":"oauth-golden-unified"}'
);
select is(
  pg_temp.gpt_enquiry_artist(),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'the same shared GPT resolves a different human to a different artist'
);
select throws_ok(
  $$select public.gpt_artist_context('a7777777-7777-4777-8777-777777777777')$$,
  '42501', null,
  'and refuses to be pointed at the new artist they do not hold'
);

-- ---------------------------------------------------------------------------
-- Act 10. Revocation closes every door at once
--
-- One membership row goes inactive. Nothing else changes: no GPT config, no
-- booking source edit, no notification cleanup. Everything must fail closed
-- because everything asked the same question.
-- ---------------------------------------------------------------------------

reset role;
update public.artist_memberships
set is_active = false
where profile_id = '9a022222-2222-4222-8222-222222222222'
  and artist_id = 'a7777777-7777-4777-8777-777777777777';

set local role authenticated;
select pg_temp.artist();

select is(
  (select count(*)::int from public.list_accessible_artists()
   where id = 'a7777777-7777-4777-8777-777777777777'),
  0,
  'the revoked human no longer sees the artist in the CRM'
);
select throws_ok(
  $$select public.list_booking_sources('a7777777-7777-4777-8777-777777777777')$$,
  '42501', null,
  'nor their booking sources'
);
select is(
  (select count(*)::int from public.list_automation_rules(
     'a7777777-7777-4777-8777-777777777777')),
  0,
  'nor their automation rules'
);
select is(
  (select count(*)::int from public.list_notifications(null, 50)
   where artist_id = 'a7777777-7777-4777-8777-777777777777'),
  0,
  'nor the notifications that were already in their inbox'
);

-- Hidden, not destroyed. Restoring the membership restores the inbox, which is
-- the same posture the unified GPT takes with a stale Artist selector.
reset role;
update public.artist_memberships
set is_active = true
where profile_id = '9a022222-2222-4222-8222-222222222222'
  and artist_id = 'a7777777-7777-4777-8777-777777777777';
set local role authenticated;
select pg_temp.artist();

select cmp_ok(
  (select count(*)::int from public.list_notifications(null, 50)
   where artist_id = 'a7777777-7777-4777-8777-777777777777'),
  '>=', 1,
  'restoring the membership brings the same notifications back'
);

reset role;
update public.artist_memberships
set is_active = false
where profile_id = '9a022222-2222-4222-8222-222222222222'
  and artist_id = 'a7777777-7777-4777-8777-777777777777';
set local role authenticated;
select pg_temp.artist();

select pg_temp.who(
  '{"sub":"9a022222-2222-4222-8222-222222222222","role":"authenticated","client_id":"oauth-golden-unified"}'
);
select throws_ok(
  $$select pg_temp.gpt_enquiry_artist()$$,
  '42501', null,
  'and the unified GPT fails closed for the same reason, with no fallback artist'
);

-- The manager, whose membership was never touched, is unaffected. Revocation
-- has to be exactly as narrow as it is complete.
select pg_temp.manager();
select is(
  (select count(*)::int from public.list_accessible_artists()
   where id = 'a7777777-7777-4777-8777-777777777777'),
  1,
  'the manager who was not revoked still has their access'
);

-- ---------------------------------------------------------------------------
-- Act 11. Nothing along that path handed a browser a provider secret
--
-- Every read the golden path used is checked here for the shapes that would
-- represent a credential or a routing internal escaping into the CRM.
-- ---------------------------------------------------------------------------

select pg_temp.manager();

select ok(
  not exists (
    select 1
    from public.list_booking_sources('a7777777-7777-4777-8777-777777777777') b
    where b::text ~* '(token|secret|api[_-]?key|chat_id|bearer|sb_secret)'
  ),
  'the booking source list carries no credential-shaped field'
);
select ok(
  not exists (
    select 1
    from public.list_notifications(null, 50) n
    where n::text ~* '(token|secret|api[_-]?key|chat_id|bearer|sb_secret)'
  ),
  'the notification inbox carries none either'
);
select ok(
  not exists (
    select 1
    from public.list_integration_status() s
    where s::text ~* '(token|secret|api[_-]?key|chat_id|bearer|sb_secret)'
  ),
  'and neither does the integrations screen'
);

select * from finish(true);
rollback;
