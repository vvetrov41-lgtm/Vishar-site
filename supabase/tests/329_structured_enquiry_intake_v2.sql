-- 329_structured_enquiry_intake_v2.sql
--
-- Booking form v2: structured project details, image roles, up to six files
-- and WhatsApp-first enquiries without email. Legacy behaviour is covered by
-- 030_intake.sql and must stay unchanged.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create function pg_temp.v2_files(design integer, existing integer)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(f order by n), '[]'::jsonb)
  from (
    select i as n, jsonb_build_object(
      'mime_type', 'image/jpeg', 'safe_extension', 'jpg', 'byte_size', 2048,
      'original_filename', 'design-' || i || '.jpg', 'intake_role', 'design_reference') as f
    from generate_series(1, design) as i
    union all
    select 100 + i, jsonb_build_object(
      'mime_type', 'image/jpeg', 'safe_extension', 'jpg', 'byte_size', 2048,
      'original_filename', 'existing-' || i || '.jpg', 'intake_role', 'existing_tattoo')
    from generate_series(1, existing) as i
  ) files;
$$;

create function pg_temp.v2_meta()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'project_type', 'Cover-up',
    'placement', 'Arm: Full sleeve, Forearm',
    'approximate_size', 'Not specified',
    'cover_up', 'Yes',
    'idea', 'A full sleeve that covers the old forearm piece.',
    'source', '/booking/',
    'privacy_acknowledged', true,
    'privacy_notice_version', '2026-09-09',
    'project_details', jsonb_build_object(
      'schema', 'enquiry-v2',
      'areas', jsonb_build_array(jsonb_build_object(
        'region', 'Arm',
        'placements', jsonb_build_array('Full sleeve', 'Forearm'),
        'work', jsonb_build_array('Cover-up')
      )),
      'styles', jsonb_build_array('Black & Grey realism')
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- Structured details and image roles are stored
-- ---------------------------------------------------------------------------

create temporary table t_v2 as
select public.create_enquiry_intake(
  'bbbbbbbb-0000-4000-8000-000000000001',
  jsonb_build_object('full_name', 'Vera Sleeve', 'email', 'vera@example.test',
                     'phone', '+44 7700 900111', 'preferred_contact', 'Email'),
  pg_temp.v2_meta(),
  pg_temp.v2_files(2, 4)
) as r;

select is((select jsonb_array_length(r -> 'files') from t_v2), 6,
          'six intake files are accepted');

select is(
  (select project_details #>> '{areas,0,region}' from public.enquiries
   where idempotency_key = 'bbbbbbbb-0000-4000-8000-000000000001'),
  'Arm',
  'structured project details are stored on the enquiry'
);

select is(
  (select array_agg(intake_role order by ordinal)::text from public.enquiry_files f
   join public.enquiries e on e.id = f.enquiry_id
   where e.idempotency_key = 'bbbbbbbb-0000-4000-8000-000000000001'),
  '{design_reference,design_reference,existing_tattoo,existing_tattoo,existing_tattoo,existing_tattoo}',
  'each manifest keeps its image role in submission order'
);

select is(
  (select array_agg(ordinal order by ordinal)::text from public.enquiry_files f
   join public.enquiries e on e.id = f.enquiry_id
   where e.idempotency_key = 'bbbbbbbb-0000-4000-8000-000000000001'),
  '{0,1,2,3,4,5}',
  'ordinals extend to six files'
);

select ok(
  (select bool_and(f.category = 'reference' and f.storage_path ~ '/references/')
   from public.enquiry_files f join public.enquiries e on e.id = f.enquiry_id
   where e.idempotency_key = 'bbbbbbbb-0000-4000-8000-000000000001'),
  'v2 files keep the reference category and canonical storage path'
);

-- Exact replay returns the same enquiry.
select is(
  (select public.create_enquiry_intake(
     'bbbbbbbb-0000-4000-8000-000000000001',
     jsonb_build_object('full_name', 'Vera Sleeve', 'email', 'vera@example.test',
                        'phone', '+44 7700 900111', 'preferred_contact', 'Email'),
     pg_temp.v2_meta(), pg_temp.v2_files(2, 4)) ->> 'replayed'),
  'true',
  'an identical v2 retry replays'
);

-- A changed image role is a different payload under the same key.
select throws_ok(
  $$select public.create_enquiry_intake(
     'bbbbbbbb-0000-4000-8000-000000000001',
     jsonb_build_object('full_name', 'Vera Sleeve', 'email', 'vera@example.test',
                        'phone', '+44 7700 900111', 'preferred_contact', 'Email'),
     pg_temp.v2_meta(), pg_temp.v2_files(3, 3))$$,
  '22023', null,
  'reusing a key with different image roles is refused'
);

-- ---------------------------------------------------------------------------
-- WhatsApp-first enquiries without email
-- ---------------------------------------------------------------------------

create temporary table t_wa as
select public.create_enquiry_intake(
  'bbbbbbbb-0000-4000-8000-000000000002',
  -- The Worker has already converted a UK 07 mobile to E.164.
  jsonb_build_object('full_name', 'Walt App', 'phone', '+447700900222',
                     'preferred_contact', 'WhatsApp'),
  pg_temp.v2_meta(),
  pg_temp.v2_files(1, 1)
) as r;

select is((select r ->> 'client_match_method' from t_wa), 'created',
          'a WhatsApp-only client is created');
select ok(
  (select submitted_email is null and submitted_phone = '+447700900222'
   from public.enquiries where idempotency_key = 'bbbbbbbb-0000-4000-8000-000000000002'),
  'the enquiry stores no email and the submitted phone'
);
select ok(
  (select c.email is null and c.phone_normalized = '+447700900222'
   from public.clients c join public.enquiries e on e.client_id = c.id
   where e.idempotency_key = 'bbbbbbbb-0000-4000-8000-000000000002'),
  'the client is matchable by normalised phone'
);

-- The same phone later with an email reuses the client.
select is(
  (select public.create_enquiry_intake(
     'bbbbbbbb-0000-4000-8000-000000000003',
     jsonb_build_object('full_name', 'Walt App', 'email', 'walt@example.test',
                        'phone', '+447700900222', 'preferred_contact', 'Email'),
     pg_temp.v2_meta(), pg_temp.v2_files(1, 1)) ->> 'client_match_method'),
  'phone',
  'a later enquiry with the same phone matches the WhatsApp-only client'
);

select throws_ok(
  $$select public.create_enquiry_intake(gen_random_uuid(),
      jsonb_build_object('full_name', 'No Channel', 'phone', '07700 900333',
                         'preferred_contact', 'Email'),
      pg_temp.v2_meta(), pg_temp.v2_files(1, 0))$$,
  '22023', null,
  'email stays required when Email is the preferred reply'
);

select throws_ok(
  $$select public.create_enquiry_intake(gen_random_uuid(),
      jsonb_build_object('full_name', 'Bad Number', 'phone', '12345',
                         'preferred_contact', 'WhatsApp'),
      pg_temp.v2_meta(), pg_temp.v2_files(1, 0))$$,
  '22023', null,
  'a WhatsApp-only enquiry needs a matchable phone'
);

select throws_ok(
  $$select public.create_enquiry_intake(gen_random_uuid(),
      jsonb_build_object('full_name', 'Bad Mail', 'email', 'not-an-email',
                         'phone', '+447700900444', 'preferred_contact', 'WhatsApp'),
      pg_temp.v2_meta(), pg_temp.v2_files(1, 0))$$,
  '23514', null,
  'a malformed email is refused by the shape check rather than silently dropped'
);

-- ---------------------------------------------------------------------------
-- Shape guards
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select public.create_enquiry_intake(gen_random_uuid(),
      jsonb_build_object('full_name', 'Array Details', 'email', 'arr@example.test'),
      pg_temp.v2_meta() || jsonb_build_object('project_details', jsonb_build_array(1)),
      pg_temp.v2_files(1, 0))$$,
  '22023', null,
  'project details must be an object'
);

select throws_ok(
  $$select public.create_enquiry_intake(gen_random_uuid(),
      jsonb_build_object('full_name', 'Bad Role', 'email', 'role@example.test'),
      pg_temp.v2_meta(),
      jsonb_build_array(jsonb_build_object('mime_type', 'image/jpeg', 'safe_extension', 'jpg',
        'byte_size', 2048, 'intake_role', 'selfie')))$$,
  '23514', null,
  'an unknown image role is refused'
);

select throws_ok(
  $$select public.create_enquiry_intake(gen_random_uuid(),
      jsonb_build_object('full_name', 'Seven', 'email', 'seven@example.test'),
      pg_temp.v2_meta(), pg_temp.v2_files(4, 3))$$,
  '22023', null,
  'seven files are refused'
);

select ok(
  has_column_privilege('authenticated', 'public.enquiries', 'project_details', 'SELECT')
  and has_column_privilege('authenticated', 'public.enquiry_files', 'intake_role', 'SELECT'),
  'staff can read the new columns through RLS-scoped column grants'
);

select ok(
  not has_column_privilege('anon', 'public.enquiries', 'project_details', 'SELECT'),
  'anonymous callers cannot read project details'
);

select * from finish();
rollback;
