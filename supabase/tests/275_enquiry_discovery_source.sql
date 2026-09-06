-- 275_enquiry_discovery_source.sql
-- Migrations 0140-0141: self-reported discovery attribution is bounded metadata,
-- legacy values are canonicalised, optional detail persists separately, and
-- neither field becomes routing input.

begin;
select no_plan();

select has_column('public', 'enquiries', 'discovery_source',
  'enquiries stores self-reported discovery attribution');
select has_column('public', 'enquiries', 'discovery_source_detail',
  'enquiries stores optional discovery attribution detail separately');
select col_is_null('public', 'enquiries', 'discovery_source',
  'legacy enquiries may keep discovery source unrecorded');
select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.enquiries'::regclass
      and conname = 'enquiries_discovery_source_known'
  ),
  'database constrains non-null discovery values'
);

-- Self-contained public booking source. Do not depend on production seed rows or
-- another pgTAP file's fixture state: this test must pass after --no-seed reset.
insert into public.workspaces (
  id, slug, display_name, workspace_type, timezone, default_currency, is_active
) values (
  '97500000-0000-4000-8000-000000000010',
  'discovery-source-test', 'Discovery Source Test', 'solo',
  'Europe/London', 'GBP', true
);
insert into public.artists (
  id, workspace_id, slug, display_name, timezone, default_currency,
  booking_reference_prefix, is_active
) values (
  '97500000-0000-4000-8000-000000000011',
  '97500000-0000-4000-8000-000000000010',
  'discovery-source-test', 'Discovery Source Test',
  'Europe/London', 'GBP', 'DST', true
);
insert into public.booking_sources (
  id, artist_id, source_key, allowed_origin, form_version, is_active,
  public_source_id, source_kind, display_label, form_template, is_public_booking
) values (
  '97500000-0000-4000-8000-000000000012',
  '97500000-0000-4000-8000-000000000011',
  'discovery-source-hosted', null, 'booking-v1', true,
  '97500000-0000-4000-8000-000000000013',
  'hosted', 'Discovery source form', 'tattoo-enquiry', true
);

create function pg_temp.files() returns jsonb language sql immutable as $$
  select jsonb_build_array(jsonb_build_object(
    'mime_type', 'image/jpeg',
    'safe_extension', 'jpg',
    'byte_size', 2048,
    'original_filename', 'discovery-reference.jpg'
  ));
$$;
grant execute on function pg_temp.files() to service_role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table t_discovery_intake as
select public.create_trusted_enquiry_intake(
  'public-slug:discovery-source-test',
  'https://vishartattoo.com',
  'booking-v1',
  '97500000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'full_name', 'Discovery Test Client',
    'email', 'discovery-test@example.test',
    'preferred_contact', 'Email'
  ),
  jsonb_build_object(
    'project_type', 'Colour realism',
    'placement', 'Outer forearm',
    'approximate_size', '20 cm',
    'cover_up', 'No',
    'preferred_timing', 'Flexible',
    'idea', 'Discovery attribution test.',
    -- Deliberately use the 0140 value to prove rolling-deploy compatibility.
    'discovery_source', 'chatgpt',
    'discovery_source_detail', 'ChatGPT',
    'source', '/book/discovery-source-test',
    'privacy_acknowledged', true,
    'privacy_notice_version', '2026-07-29'
  ),
  pg_temp.files()
) as r;

reset role;

select is(
  (select discovery_source
   from public.enquiries
   where id = (select (r ->> 'enquiry_id')::uuid from t_discovery_intake)),
  'ai'::text,
  'trusted booking intake canonicalises the legacy discovery category'
);

select is(
  (select discovery_source_detail
   from public.enquiries
   where id = (select (r ->> 'enquiry_id')::uuid from t_discovery_intake)),
  'ChatGPT'::text,
  'trusted booking intake persists discovery detail separately'
);

select lives_ok(
  $$update public.enquiries
    set discovery_source = null,
        discovery_source_detail = null
    where id = (select (r ->> 'enquiry_id')::uuid from t_discovery_intake)$$,
  'legacy and non-public intake may leave discovery source unrecorded'
);

select throws_ok(
  $$update public.enquiries
    set discovery_source = 'invented-channel'
    where id = (select (r ->> 'enquiry_id')::uuid from t_discovery_intake)$$,
  '23514', null,
  'unsupported discovery categories cannot be stored'
);

select throws_ok(
  $$update public.enquiries
    set discovery_source = 'google',
        discovery_source_detail = 'not allowed for this category'
    where id = (select (r ->> 'enquiry_id')::uuid from t_discovery_intake)$$,
  '23514', null,
  'discovery detail cannot be attached to categories that do not use it'
);

select * from finish();
rollback;