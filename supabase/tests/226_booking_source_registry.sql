-- 226_booking_source_registry.sql
--
-- Migration 0078: public booking-source ids and runtime Origin authority.
-- Everything is synthetic or rolled back.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Shape and ACL
-- ---------------------------------------------------------------------------

select ok(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'booking_sources'
      and column_name = 'public_source_id'
      and data_type = 'uuid'
      and is_nullable = 'NO'
  ),
  'booking_sources has a non-null UUID public source id'
);

select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.booking_sources'::regclass
      and conname = 'booking_sources_public_source_id_key'
      and contype = 'u'
  ),
  'the public source id is unique'
);

select ok(
  has_function_privilege('service_role', 'public.resolve_booking_source_public(uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.resolve_booking_source_public(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.resolve_booking_source_public(uuid,text)', 'EXECUTE'),
  'only the backend credential can execute the runtime source resolver'
);

select ok(
  (select p.prosecdef
          and 'search_path=pg_catalog, public, crm_private' = any (p.proconfig)
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'resolve_booking_source_public'),
  'the public source resolver is SECURITY DEFINER with a pinned search_path'
);

select is(
  (select public_source_id::text from public.booking_sources where source_key = 'vladimir-website'),
  '39680fe5-6da0-48c0-bb6b-b543928747e2',
  'the existing Vladimir website receives its stable rollout id'
);

select is(
  (select public_source_id::text from public.booking_sources where source_key = 'kristina-website'),
  '870e6c8d-a5f7-4c44-97b0-895b659d350f',
  'the existing Kristina website receives its stable rollout id'
);

select isnt(
  (select public_source_id from public.booking_sources where source_key = 'vladimir-website'),
  (select public_source_id from public.booking_sources where source_key = 'kristina-website'),
  'existing websites have distinct public source ids'
);

-- ---------------------------------------------------------------------------
-- Runtime resolution: public id + observed Origin, never artist_id
-- ---------------------------------------------------------------------------

-- Make both existing sources active for the isolated resolver assertions.
update public.booking_sources
set is_active = true
where source_key in ('vladimir-website', 'kristina-website');

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  (select r.artist_id::text
   from public.resolve_booking_source_public(
     '39680fe5-6da0-48c0-bb6b-b543928747e2',
     'https://vishartattoo.com'
   ) r),
  'a1111111-1111-4111-8111-111111111111',
  'Vladimir public id plus Vladimir Origin resolves only Vladimir'
);

select is(
  (select r.source_key
   from public.resolve_booking_source_public(
     '870e6c8d-a5f7-4c44-97b0-895b659d350f',
     'https://www.kristinavishar.com/'
   ) r),
  'kristina-website',
  'the resolver canonicalises the observed HTTPS Origin before matching'
);

select throws_ok(
  $$select * from public.resolve_booking_source_public(
      '39680fe5-6da0-48c0-bb6b-b543928747e2'::uuid,
      'https://www.kristinavishar.com')$$,
  '42501', null,
  'a valid public id cannot be replayed from another registered Origin'
);

select throws_ok(
  $$select * from public.resolve_booking_source_public(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
      'https://vishartattoo.com')$$,
  '42501', null,
  'an unknown public id grants no routing authority'
);

select throws_ok(
  $$select * from public.resolve_booking_source_public(
      '39680fe5-6da0-48c0-bb6b-b543928747e2'::uuid,
      'http://vishartattoo.com')$$,
  '22023', null,
  'plain HTTP is never accepted as a booking Origin'
);

-- ---------------------------------------------------------------------------
-- Table boundary: one active Origin cannot point at two artists
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.booking_sources
      (artist_id, source_key, allowed_origin, form_version, is_active)
    values (
      'a1111111-1111-4111-8111-111111111111',
      'vladimir-cross-origin-test',
      'https://www.kristinavishar.com',
      'booking-v1',
      true
    )$$,
  '23514', null,
  'one active website Origin cannot route to a different artist'
);

select lives_ok(
  $$insert into public.booking_sources
      (artist_id, source_key, allowed_origin, form_version, is_active)
    values (
      'a2222222-2222-4222-8222-222222222222',
      'kristina-second-form-test',
      'https://www.kristinavishar.com',
      'booking-v1',
      true
    )$$,
  'the same artist may have multiple active sources on their own Origin'
);

select throws_ok(
  $$update public.booking_sources
    set public_source_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    where source_key = 'vladimir-website'$$,
  '23514', null,
  'a public source id is immutable once issued'
);

-- Deactivation removes routing authority immediately.
update public.booking_sources
set is_active = false
where source_key = 'vladimir-website';

select throws_ok(
  $$select * from public.resolve_booking_source_public(
      '39680fe5-6da0-48c0-bb6b-b543928747e2'::uuid,
      'https://vishartattoo.com')$$,
  '42501', null,
  'a deactivated source cannot resolve even with the right id and Origin'
);

select * from finish();
rollback;