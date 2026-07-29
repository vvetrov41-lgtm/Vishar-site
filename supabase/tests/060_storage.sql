-- 060_storage.sql
--
-- The private bucket, canonical path ownership, and who may read, write and
-- delete objects.
--
-- Note the boundary: this file tests the DATABASE side of Storage — the bucket
-- row and the policies on storage.objects. Signed-URL minting, expiry and the
-- Storage API's own MIME and size enforcement live in the Storage service and
-- are not exercised here. See supabase/tests/_shim/README.md.

begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- The bucket is private
-- ---------------------------------------------------------------------------

select is((select count(*)::int from storage.buckets where id = 'crm-files'), 1,
          'the crm-files bucket exists');
select is((select public from storage.buckets where id = 'crm-files'), false,
          'the crm-files bucket is NOT public');
select is((select count(*)::int from storage.buckets), 1,
          'crm-files is the only bucket, so client files have one home');
select is((select file_size_limit from storage.buckets where id = 'crm-files'), (4 * 1024 * 1024)::bigint,
          'the bucket enforces the same 4 MB per-file limit as the Worker');
select is((select allowed_mime_types from storage.buckets where id = 'crm-files'),
          array['image/jpeg', 'image/png', 'image/webp'],
          'the bucket allow-lists only the three accepted image types');

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'owner@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'manager@example.test'),
  ('33333333-3333-4333-8333-333333333333', 'readonly@example.test');

insert into public.profiles (id, email, role, is_active) values
  ('11111111-1111-4111-8111-111111111111', 'owner@example.test', 'owner', true),
  ('22222222-2222-4222-8222-222222222222', 'manager@example.test', 'booking_manager', true),
  ('33333333-3333-4333-8333-333333333333', 'readonly@example.test', 'read_only', true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;

create temporary table t_enq as
select public.create_enquiry_intake(
  'aaaaaaaa-0000-4000-8000-000000000001',
  jsonb_build_object('full_name', 'Storage Client', 'email', 'storage@example.test'),
  jsonb_build_object('idea', 'A raven'),
  jsonb_build_array(jsonb_build_object('mime_type', 'image/jpeg', 'safe_extension', 'jpg', 'byte_size', 2048))
) as r;

grant select on t_enq to anon, authenticated, service_role;

create temporary table paths as
select f.storage_path as known_path,
       'clients/' || gen_random_uuid() || '/enquiries/' || gen_random_uuid()
                  || '/references/' || gen_random_uuid() || '.jpg' as forged_path
from public.enquiry_files f limit 1;

grant select on paths to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Canonical paths
-- ---------------------------------------------------------------------------

select matches(
  (select known_path from paths),
  '^clients/[0-9a-f-]{36}/enquiries/[0-9a-f-]{36}/references/[0-9a-f-]{36}\.jpg$',
  'the enquiry reference path matches the documented canonical layout'
);

select is(
  public.project_file_storage_path(
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
    'design', '00000000-0000-4000-8000-000000000003', 'png'),
  'clients/00000000-0000-4000-8000-000000000001/projects/00000000-0000-4000-8000-000000000002'
  || '/designs/00000000-0000-4000-8000-000000000003.png',
  'the project design path matches the documented canonical layout'
);
select is(
  public.project_file_storage_path(
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
    'session', '00000000-0000-4000-8000-000000000003', 'jpg'),
  'clients/00000000-0000-4000-8000-000000000001/projects/00000000-0000-4000-8000-000000000002'
  || '/sessions/00000000-0000-4000-8000-000000000003.jpg',
  'the project session path matches the documented canonical layout'
);
select is(
  public.project_file_storage_path(
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
    'healed', '00000000-0000-4000-8000-000000000003', 'webp'),
  'clients/00000000-0000-4000-8000-000000000001/projects/00000000-0000-4000-8000-000000000002'
  || '/healed/00000000-0000-4000-8000-000000000003.webp',
  'the healed-photo path matches the documented canonical layout'
);

-- A path is only "known" when a manifest backs it. Shape alone is not enough.
select pg_temp.claims('{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}');
select ok(public.crm_storage_object_is_known((select known_path from paths)),
          'a path backed by a manifest is recognised');
select ok(not public.crm_storage_object_is_known((select forged_path from paths)),
          'a well-formed but unbacked path is NOT recognised');
select ok(not public.crm_storage_object_is_known('clients/'),
          'a bare prefix is not recognised, so the bucket cannot be listed wholesale');
select ok(not public.crm_storage_object_is_known(''),
          'an empty key is not recognised');

-- ---------------------------------------------------------------------------
-- Anonymous access
-- ---------------------------------------------------------------------------

set local role anon;
select pg_temp.claims('{"role":"anon"}');

select is((select count(*)::int from storage.buckets), 0,
          'anon cannot see the bucket, so it cannot be discovered');
select throws_ok($$select count(*) from storage.objects$$, '42501', null,
  'anon holds no privilege on storage.objects');
reset role;

-- ---------------------------------------------------------------------------
-- Uploads
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}');

select lives_ok(
  format($$insert into storage.objects (bucket_id, name) values ('crm-files', %L)$$,
         (select known_path from paths)),
  'a booking manager can upload to a path that has a pending manifest'
);

select throws_ok(
  format($$insert into storage.objects (bucket_id, name) values ('crm-files', %L)$$,
         (select forged_path from paths)),
  '42501', null,
  'a forged but well-formed path is refused because no manifest backs it'
);

select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('crm-files', 'clients/../../etc/passwd')$$,
  '42501', null,
  'a traversal-style path is refused'
);

select is((select count(*)::int from storage.objects), 1,
          'a booking manager can read back the object they uploaded');
reset role;

-- read_only has no file access by default.
set local role authenticated;
select pg_temp.claims('{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}');
select is((select count(*)::int from storage.objects), 0,
          'read_only sees no objects at all');
select throws_ok(
  format($$insert into storage.objects (bucket_id, name) values ('crm-files', %L)$$,
         (select forged_path from paths)),
  '42501', null,
  'read_only cannot upload'
);
reset role;

-- ---------------------------------------------------------------------------
-- Deletion
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}');
delete from storage.objects where bucket_id = 'crm-files';
select is((select count(*)::int from storage.objects), 1,
          'a booking manager cannot delete client files');
reset role;

set local role authenticated;
select pg_temp.claims('{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}');
delete from storage.objects where bucket_id = 'crm-files';
select is((select count(*)::int from storage.objects), 0,
          'the owner can delete a client file');
reset role;

-- The backend can clean up after a partial upload, which is what makes the
-- compensating deletion in the Worker possible.
set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
select lives_ok(
  format($$insert into storage.objects (bucket_id, name) values ('crm-files', %L)$$,
         (select known_path from paths)),
  'the Worker can upload to a path with a pending manifest'
);
delete from storage.objects where bucket_id = 'crm-files';
select is((select count(*)::int from storage.objects), 0,
          'the Worker can delete what it uploaded, enabling compensating cleanup');
reset role;

select * from finish(true);
rollback;
