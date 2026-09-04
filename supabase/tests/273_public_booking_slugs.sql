-- 273_public_booking_slugs.sql
-- Canonical /book/{artist-slug} routing. Slugs are aliases only; immutable
-- booking-source and Artist ids remain the database authority.

begin;
select no_plan();

select has_column('public', 'booking_sources', 'is_public_booking',
  'booking_sources records the source behind the public artist slug');
select col_not_null('public', 'booking_sources', 'is_public_booking',
  'canonical-source marker is never nullable');
select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'booking_sources'
      and indexname = 'booking_sources_one_public_per_artist_idx'
      and indexdef ilike '%unique%'
      and indexdef ilike '%where is_public_booking%'
  ),
  'at most one canonical public source per Artist is enforced'
);

select is(
  (select count(*)::int from public.booking_sources
   where artist_id = 'a1111111-1111-4111-8111-111111111111'::uuid
     and is_public_booking),
  1,
  'Vladimir existing source history gets exactly one canonical source'
);
select is(
  (select count(*)::int from public.booking_sources
   where artist_id = 'a2222222-2222-4222-8222-222222222222'::uuid
     and is_public_booking),
  1,
  'Kristina existing source history gets exactly one canonical source'
);

-- Self-contained Artist/source used to prove server-side resolution.
insert into public.workspaces (
  id, slug, display_name, workspace_type, timezone, default_currency, is_active
) values (
  '97300000-0000-4000-8000-000000000001',
  'public-booking-test', 'Public booking test', 'solo', 'Europe/London', 'GBP', true
);
insert into public.artists (
  id, workspace_id, slug, display_name, timezone, default_currency,
  booking_reference_prefix, is_active
) values (
  '97300000-0000-4000-8000-000000000002',
  '97300000-0000-4000-8000-000000000001',
  'public-booking-test', 'Public Booking Test', 'Europe/London', 'GBP', 'PBT', true
);
insert into public.booking_sources (
  id, artist_id, source_key, allowed_origin, form_version, is_active,
  public_source_id, source_kind, display_label, form_template, is_public_booking
) values (
  '97300000-0000-4000-8000-000000000003',
  '97300000-0000-4000-8000-000000000002',
  'fixture-hosted-source', null, 'booking-v1', true,
  '97300000-0000-4000-8000-000000000004',
  'hosted', 'Fixture booking', 'tattoo-enquiry', true
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  (select artist_id from public.resolve_booking_source(
    'public-slug:public-booking-test', 'https://vishartattoo.com', 'booking-v1'
  )),
  '97300000-0000-4000-8000-000000000002'::uuid,
  'slug resolves the exact immutable Artist id'
);
select is(
  (select booking_source_id from public.resolve_booking_source(
    'public-slug:public-booking-test', 'https://vishartattoo.com', 'booking-v1'
  )),
  '97300000-0000-4000-8000-000000000003'::uuid,
  'slug resolves the designated canonical source'
);
select is(
  (select source_key from public.resolve_booking_source(
    'public-slug:public-booking-test', 'https://vishartattoo.com', 'booking-v1'
  )),
  'fixture-hosted-source'::text,
  'resolver returns the immutable source key, not the slug pseudo-key'
);
select throws_ok(
  $$select * from public.resolve_booking_source(
      'public-slug:public-booking-test', 'https://evil.example', 'booking-v1'
    )$$,
  '42501', null,
  'public slug resolver refuses a different origin'
);
select throws_ok(
  $$select * from public.resolve_booking_source(
      'public-slug:somebody-else', 'https://vishartattoo.com', 'booking-v1'
    )$$,
  '42501', null,
  'unknown slug fails closed with no fallback Artist'
);
select throws_ok(
  $$select * from public.resolve_booking_source(
      'public-slug:Public-Booking-Test', 'https://vishartattoo.com', 'booking-v1'
    )$$,
  '22023', null,
  'noncanonical slug spelling is rejected rather than normalized'
);
reset role;

select throws_ok(
  $$update public.booking_sources
    set is_public_booking = false
    where id = '97300000-0000-4000-8000-000000000003'::uuid$$,
  '23514', null,
  'canonical-source designation is immutable on an existing source'
);
select throws_ok(
  $$insert into public.booking_sources (
      id, artist_id, source_key, allowed_origin, form_version, is_active,
      public_source_id, source_kind, display_label, form_template, is_public_booking
    ) values (
      '97300000-0000-4000-8000-000000000005',
      '97300000-0000-4000-8000-000000000002',
      'second-public-source', null, 'booking-v1', true,
      '97300000-0000-4000-8000-000000000006',
      'hosted', 'Second public', 'tattoo-enquiry', true
    )$$,
  '23505', null,
  'a second canonical source for one Artist is impossible'
);

update public.booking_sources
set is_active = false
where id = '97300000-0000-4000-8000-000000000003'::uuid;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select * from public.resolve_booking_source(
      'public-slug:public-booking-test', 'https://vishartattoo.com', 'booking-v1'
    )$$,
  '42501', null,
  'disabled canonical source makes its slug unavailable rather than falling back'
);
reset role;

-- First source for a future Artist atomically claims its public route.
insert into public.workspaces (
  id, slug, display_name, workspace_type, timezone, default_currency, is_active
) values (
  '97300000-0000-4000-8000-000000000011',
  'future-booking-test', 'Future booking test', 'solo', 'Europe/London', 'GBP', true
);
insert into public.artists (
  id, workspace_id, slug, display_name, timezone, default_currency,
  booking_reference_prefix, is_active
) values (
  '97300000-0000-4000-8000-000000000012',
  '97300000-0000-4000-8000-000000000011',
  'future-booking-test', 'Future Booking Test', 'Europe/London', 'GBP', 'FBT', true
);
insert into auth.users (id, email) values
  ('97300000-0000-4000-8000-000000000013', 'public-booking-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('97300000-0000-4000-8000-000000000013', 'public-booking-owner@example.test', 'Public Booking Owner', 'owner', true);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"97300000-0000-4000-8000-000000000013","role":"authenticated"}', true
);
select lives_ok(
  $$select public.create_booking_source(
      '97300000-0000-4000-8000-000000000012', 'hosted', 'First form', null, 'tattoo-enquiry', false
    )$$,
  'ordinary CRM source creation works for a future Artist'
);
select lives_ok(
  $$select public.create_booking_source(
      '97300000-0000-4000-8000-000000000012', 'hosted', 'Second form', null, 'tattoo-enquiry', false
    )$$,
  'additional noncanonical sources remain possible'
);
reset role;

select is(
  (select count(*)::int from public.booking_sources
   where artist_id = '97300000-0000-4000-8000-000000000012'::uuid
     and is_public_booking),
  1,
  'future Artist automatically gets exactly one canonical source'
);
select is(
  (select display_label from public.booking_sources
   where artist_id = '97300000-0000-4000-8000-000000000012'::uuid
     and is_public_booking),
  'First form'::text,
  'the first source owns the future Artist public route'
);

-- Canonical sources expose the human URL through the existing RPC result shape.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"97300000-0000-4000-8000-000000000013","role":"authenticated"}', true
);
select is(
  (select public_path from public.list_booking_sources('97300000-0000-4000-8000-000000000012')
   where display_label = 'First form'),
  'https://vishartattoo.com/book/future-booking-test'::text,
  'CRM readback exposes the stable canonical booking URL'
);
reset role;

select * from finish();
rollback;
