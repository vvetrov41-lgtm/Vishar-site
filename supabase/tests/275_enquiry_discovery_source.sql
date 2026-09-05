-- 275_enquiry_discovery_source.sql
-- Migration 0140: self-reported discovery attribution is bounded metadata,
-- persists through the trusted booking intake, and never becomes routing input.

begin;
select no_plan();

select has_column('public', 'enquiries', 'discovery_source',
  'enquiries stores self-reported discovery attribution');
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
  'vladimir-website',
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
    'discovery_source', 'chatgpt',
    'source', '/book/vladimir',
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
  'chatgpt'::text,
  'trusted booking intake persists the selected stable discovery category'
);

select lives_ok(
  $$insert into public.enquiries (
      artist_id, client_id, reference_number, status, project_type, placement,
      approximate_size, cover_up, idea, source, discovery_source
    )
    select artist_id, client_id, 'DISC-NULL', 'new', 'Test', 'Arm', '10 cm',
           'No', 'Legacy compatible row', 'legacy-test', null
    from public.enquiries
    where id = (select (r ->> 'enquiry_id')::uuid from t_discovery_intake)$$,
  'legacy and non-public intake may leave discovery source unrecorded'
);

select throws_ok(
  $$insert into public.enquiries (
      artist_id, client_id, reference_number, status, project_type, placement,
      approximate_size, cover_up, idea, source, discovery_source
    )
    select artist_id, client_id, 'DISC-BAD', 'new', 'Test', 'Arm', '10 cm',
           'No', 'Invalid attribution row', 'constraint-test', 'invented-channel'
    from public.enquiries
    where id = (select (r ->> 'enquiry_id')::uuid from t_discovery_intake)$$,
  '23514', null,
  'unsupported discovery categories cannot be stored'
);

select * from finish();
rollback;
