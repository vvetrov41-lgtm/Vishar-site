-- 100_booking_sources_integrations.sql
--
-- Migration 0017: trusted source/origin mapping, artist-scoped integration
-- metadata, no-secrets guards, RLS and API ACLs.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Schema and initial logical sources
-- ---------------------------------------------------------------------------

select has_type('public', 'artist_integration_type',
                'artist_integration_type exists');
select enum_has_labels(
  'public', 'artist_integration_type',
  array['telegram', 'calendar', 'email', 'payments', 'gpt', 'whatsapp', 'instagram'],
  'artist integration types are explicit and provider-neutral'
);

select has_table('public', 'booking_sources', 'booking_sources exists');
select has_table('public', 'artist_integrations', 'artist_integrations exists');

select has_column('public', 'booking_sources', c,
                  'booking_sources.' || c || ' exists')
from unnest(array[
  'id', 'artist_id', 'source_key', 'allowed_origin', 'form_version',
  'is_active', 'created_at', 'updated_at'
]) as c;

select has_column('public', 'artist_integrations', c,
                  'artist_integrations.' || c || ' exists')
from unnest(array[
  'id', 'artist_id', 'integration_type', 'provider', 'integration_key',
  'external_account_label', 'configuration', 'is_enabled',
  'created_at', 'updated_at'
]) as c;

select col_is_unique('public', 'booking_sources', 'source_key',
                     'one source key maps to one source');
select col_is_unique(
  'public', 'artist_integrations',
  array['artist_id', 'integration_type', 'integration_key'],
  'one artist has at most one integration per type and key'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is((select count(*)::int from public.booking_sources), 2,
          'Vladimir and Kristina logical website sources are seeded');
select is(
  (select artist_id from public.booking_sources
   where source_key = 'vladimir-website'),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'the Vladimir website source belongs to Vladimir'
);
select is(
  (select allowed_origin from public.booking_sources
   where source_key = 'vladimir-website'),
  'https://vishartattoo.com',
  'the known Vladimir website origin is exact and canonical'
);
select is(
  (select artist_id from public.booking_sources
   where source_key = 'kristina-website'),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'the Kristina website source belongs to Kristina'
);
select is(
  (select allowed_origin from public.booking_sources
   where source_key = 'kristina-website'),
  null::text,
  'Kristina origin is not guessed before her real website is approved'
);
select ok(not exists (select 1 from public.booking_sources where is_active),
          'initial logical sources stay inactive until matching Worker configuration is reviewed');

-- ---------------------------------------------------------------------------
-- RLS and table ACLs
-- ---------------------------------------------------------------------------

select ok(
  (select c.relrowsecurity and c.relforcerowsecurity
   from pg_class c where c.oid = 'public.booking_sources'::regclass),
  'booking_sources has enabled and forced RLS'
);
select ok(
  (select c.relrowsecurity and c.relforcerowsecurity
   from pg_class c where c.oid = 'public.artist_integrations'::regclass),
  'artist_integrations has enabled and forced RLS'
);

select ok(has_table_privilege('authenticated', 'public.booking_sources', 'SELECT'),
          'authenticated may select only RLS-permitted source metadata');
select ok(not has_table_privilege('authenticated', 'public.booking_sources', 'INSERT'),
          'authenticated cannot directly create a booking source');
select ok(not has_table_privilege('authenticated', 'public.booking_sources', 'UPDATE'),
          'authenticated cannot directly change routing');
select ok(has_table_privilege('authenticated', 'public.artist_integrations', 'SELECT'),
          'authenticated may select only RLS-permitted integration metadata');
select ok(not has_table_privilege('authenticated', 'public.artist_integrations', 'INSERT'),
          'authenticated cannot directly create an integration');
select ok(not has_table_privilege('authenticated', 'public.artist_integrations', 'UPDATE'),
          'authenticated cannot directly change integration metadata');
select ok(not has_table_privilege('service_role', 'public.booking_sources', 'SELECT'),
          'service_role has no arbitrary booking-source table read');
select ok(not has_table_privilege('service_role', 'public.artist_integrations', 'SELECT'),
          'service_role has no arbitrary integration table read');

select ok(has_function_privilege(
            'service_role',
            'public.resolve_booking_source(text,text,text)',
            'EXECUTE'),
          'service_role may call only the narrow source resolver');
select ok(not has_function_privilege(
            'authenticated',
            'public.resolve_booking_source(text,text,text)',
            'EXECUTE'),
          'authenticated cannot resolve a trusted booking source');
select ok(not has_function_privilege(
            'anon',
            'public.resolve_booking_source(text,text,text)',
            'EXECUTE'),
          'anon cannot resolve a trusted booking source');

-- ---------------------------------------------------------------------------
-- Profiles and artist memberships
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('71111111-1111-4111-8111-111111111111', 'source-owner@example.test'),
  ('72222222-2222-4222-8222-222222222222', 'kristina-integrations@example.test'),
  ('73333333-3333-4333-8333-333333333333', 'kristina-reader@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('71111111-1111-4111-8111-111111111111', 'source-owner@example.test', 'Source Owner', 'owner', true),
  ('72222222-2222-4222-8222-222222222222', 'kristina-integrations@example.test', 'Kristina Integrations', 'booking_manager', true),
  ('73333333-3333-4333-8333-333333333333', 'kristina-reader@example.test', 'Kristina Reader', 'read_only', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  (
    '72222222-2222-4222-8222-222222222222',
    'a2222222-2222-4222-8222-222222222222',
    'artist', false, false, true, true, true
  ),
  (
    '73333333-3333-4333-8333-333333333333',
    'a2222222-2222-4222-8222-222222222222',
    'read_only', false, false, false, false, true
  );

-- ---------------------------------------------------------------------------
-- Exact source resolution
-- ---------------------------------------------------------------------------

insert into public.booking_sources (
  artist_id, source_key, allowed_origin, form_version, is_active
) values (
  'a2222222-2222-4222-8222-222222222222',
  'kristina-staging-test',
  'HTTPS://KRISTINA-STAGING.EXAMPLE.TEST/',
  'test-v1',
  true
);

select is(
  (select allowed_origin from public.booking_sources
   where source_key = 'kristina-staging-test'),
  'https://kristina-staging.example.test',
  'source origins are canonicalised before storage'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  (select artist_id
   from public.resolve_booking_source(
     'kristina-staging-test',
     'https://kristina-staging.example.test',
     'test-v1'
   )),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'exact trusted source, Origin and form version resolve Kristina'
);

select throws_ok(
  $$select * from public.resolve_booking_source(
      'kristina-staging-test',
      'https://evil.example.test',
      'test-v1'
    )$$,
  '42501', null,
  'a wrong Origin cannot resolve the source'
);
select throws_ok(
  $$select * from public.resolve_booking_source(
      'kristina-staging-test',
      'https://kristina-staging.example.test',
      'wrong-v1'
    )$$,
  '42501', null,
  'a wrong form version cannot resolve the source'
);
select throws_ok(
  $$select * from public.resolve_booking_source(
      'vladimir-website',
      'https://vishartattoo.com',
      'booking-v1'
    )$$,
  '42501', null,
  'an inactive source cannot be resolved'
);
select throws_ok(
  $$select * from public.resolve_booking_source(
      'invented-source',
      'https://kristina-staging.example.test',
      'test-v1'
    )$$,
  '42501', null,
  'an invented browser source key cannot be resolved'
);
select throws_ok(
  $$select * from public.resolve_booking_source(
      'kristina-staging-test',
      'http://kristina-staging.example.test',
      'test-v1'
    )$$,
  '22023', null,
  'a non-HTTPS origin is rejected before lookup'
);

select throws_ok($$select count(*) from public.booking_sources$$, '42501', null,
  'service_role still cannot enumerate booking sources directly');
reset role;

-- ---------------------------------------------------------------------------
-- Safe integration metadata and recursive credential rejection
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.artist_integrations (
  artist_id, integration_type, provider, integration_key,
  external_account_label, configuration, is_enabled
) values
  (
    'a1111111-1111-4111-8111-111111111111',
    'telegram', 'telegram', 'telegram_primary',
    'Vladimir staging routing',
    '{"routing_mode":"server_binding","locale":"en-GB"}'::jsonb,
    false
  ),
  (
    -- Migration 0137 derives every calendar selector from the owning artist
    -- slug, so a calendar row can no longer carry an arbitrary key.
    'a2222222-2222-4222-8222-222222222222',
    'calendar', 'google', 'google_calendar_kristina',
    'Kristina staging calendar metadata',
    '{"calendar_name":"Kristina staging","timezone":"Europe/London"}'::jsonb,
    true
  );

select lives_ok(
  $$insert into public.artist_integrations (
      artist_id, integration_type, provider, integration_key,
      configuration, is_enabled
    ) values (
      'a2222222-2222-4222-8222-222222222222',
      'email', 'gmail', 'email_primary',
      '{"sender_label":"Kristina","reply_mode":"draft_only"}'::jsonb,
      false
    )$$,
  'safe provider metadata can be stored without credentials'
);

select throws_ok(
  $$insert into public.artist_integrations (
      artist_id, integration_type, provider, integration_key, configuration
    ) values (
      'a2222222-2222-4222-8222-222222222222',
      'telegram', 'telegram', 'telegram_bad_token',
      '{"nested":{"bot_token":"not-allowed"}}'::jsonb
    )$$,
  '23514', null,
  'a nested Telegram token key is rejected'
);
select throws_ok(
  $$insert into public.artist_integrations (
      artist_id, integration_type, provider, integration_key, configuration
    ) values (
      'a2222222-2222-4222-8222-222222222222',
      'telegram', 'telegram', 'telegram_bad_chat',
      '{"destination":{"chat_id":"123"}}'::jsonb
    )$$,
  '23514', null,
  'a nested Telegram chat id key is rejected'
);
select throws_ok(
  $$insert into public.artist_integrations (
      artist_id, integration_type, provider, integration_key, configuration
    ) values (
      'a2222222-2222-4222-8222-222222222222',
      'calendar', 'google', 'google_calendar_kristina',
      '{"oauth":{"refresh_token":"not-allowed"}}'::jsonb
    )$$,
  '23514', null,
  'a nested OAuth refresh token key is rejected'
);
select throws_ok(
  $$insert into public.artist_integrations (
      artist_id, integration_type, provider, integration_key, configuration
    ) values (
      'a2222222-2222-4222-8222-222222222222',
      'payments', 'stripe', 'payments_bad_value',
      '{"mode":"sk_live_examplecredential"}'::jsonb
    )$$,
  '23514', null,
  'a credential-shaped value is rejected even under an innocent key'
);

select throws_ok(
  $$insert into public.artist_integrations (
      artist_id, integration_type, provider, integration_key, configuration
    ) values (
      'a2222222-2222-4222-8222-222222222222',
      'calendar', 'google', 'google_calendar_kristina', '{}'::jsonb
    )$$,
  '23505', null,
  'duplicate artist/type/integration keys are rejected'
);

select throws_ok(
  $$update public.artist_integrations
    set artist_id = 'a1111111-1111-4111-8111-111111111111'
    where artist_id = 'a2222222-2222-4222-8222-222222222222'
      and integration_key = 'google_calendar_kristina'$$,
  '23514', null,
  'integration identity cannot be reassigned to another artist'
);
select throws_ok(
  $$update public.booking_sources
    set artist_id = 'a1111111-1111-4111-8111-111111111111'
    where source_key = 'kristina-staging-test'$$,
  '23514', null,
  'booking source identity cannot be reassigned to another artist'
);

insert into public.artists (
  slug, display_name, timezone, default_currency, is_active
) values (
  'inactive-source-test', 'Inactive Source Test',
  'Europe/London', 'GBP', false
);

select throws_ok(
  $$insert into public.booking_sources (
      artist_id, source_key, allowed_origin, form_version, is_active
    ) select
      id, 'inactive-artist-test', 'https://inactive.example.test', 'test-v1', true
    from public.artists where slug = 'inactive-source-test'$$,
  '23503', null,
  'an active booking source cannot target an inactive artist'
);

-- ---------------------------------------------------------------------------
-- Artist-scoped metadata visibility
-- ---------------------------------------------------------------------------

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text)
  to anon, authenticated, service_role;

set local role authenticated;
select pg_temp.claims('{"sub":"71111111-1111-4111-8111-111111111111","role":"authenticated"}');
select is((select count(*)::int from public.booking_sources), 3,
          'owner sees both logical sources and the synthetic active source');
select is((select count(*)::int from public.artist_integrations), 3,
          'owner sees integration metadata for both artists');
select throws_ok(
  $$insert into public.booking_sources (
      artist_id, source_key, allowed_origin, form_version, is_active
    ) values (
      'a1111111-1111-4111-8111-111111111111',
      'browser-forged-source', 'https://forged.example.test', 'v1', true
    )$$,
  '42501', null,
  'even owner cannot create routing through direct browser table access'
);
reset role;

set local role authenticated;
select pg_temp.claims('{"sub":"72222222-2222-4222-8222-222222222222","role":"authenticated"}');
select is((select count(*)::int from public.booking_sources), 2,
          'Kristina integration manager sees only Kristina sources');
select is((select count(*)::int from public.artist_integrations), 2,
          'Kristina integration manager sees only Kristina integration metadata');
select ok(not exists (
            select 1 from public.booking_sources
            where artist_id = 'a1111111-1111-4111-8111-111111111111'),
          'Kristina cannot read Vladimir routing metadata');
select ok(not exists (
            select 1 from public.artist_integrations
            where artist_id = 'a1111111-1111-4111-8111-111111111111'),
          'Kristina cannot read Vladimir integration metadata');
select throws_ok(
  $$update public.artist_integrations set is_enabled = false$$,
  '42501', null,
  'Kristina cannot bypass audited integration RPCs with direct updates'
);
reset role;

set local role authenticated;
select pg_temp.claims('{"sub":"73333333-3333-4333-8333-333333333333","role":"authenticated"}');
select is((select count(*)::int from public.booking_sources), 0,
          'read-only artist membership cannot inspect routing configuration');
select is((select count(*)::int from public.artist_integrations), 0,
          'read-only artist membership cannot inspect integration metadata');
reset role;

set local role anon;
select pg_temp.claims('{"role":"anon"}');
select throws_ok($$select count(*) from public.booking_sources$$, '42501', null,
  'anon cannot enumerate booking sources');
select throws_ok($$select count(*) from public.artist_integrations$$, '42501', null,
  'anon cannot enumerate integration metadata');
reset role;

select * from finish(true);
rollback;
