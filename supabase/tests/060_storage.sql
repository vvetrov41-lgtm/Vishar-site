-- 060_storage.sql
--
-- The private bucket, canonical path ownership, and who may read, write and
-- delete objects.
--
-- Note the boundary: this file tests the DATABASE side of Storage — the bucket
-- row and the policies on storage.objects. Signed-URL minting, expiry and the
-- Storage API's own MIME and size enforcement live in the Storage service and
-- are not exercised here. Direct deletion is protected by the Storage service
-- too, so this suite inspects the DELETE policy and identity predicates without
-- bypassing storage.protect_delete(). See scripts/test-support/README.md.

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
--
-- These rows are installed by the privileged pgTAP/migration owner. They model
-- database state only; direct table writes here are not evidence that a Worker
-- can bypass its controlled RPC surface.
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
  jsonb_build_object(
    'idea', 'A raven',
    'privacy_acknowledged', true,
    'privacy_notice_version', '2026-07-29'
  ),
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
-- Helper assertions impersonate the same database role and JWT combination
-- that PostgREST uses.
set local role authenticated;
select pg_temp.claims('{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}');
select ok(public.crm_storage_object_is_known((select known_path from paths)),
          'a path backed by a manifest is recognised');
select ok(not public.crm_storage_object_is_known((select forged_path from paths)),
          'a well-formed but unbacked path is NOT recognised');
select ok(not public.crm_storage_object_is_known('clients/'),
          'a bare prefix is not recognised, so the bucket cannot be listed wholesale');
select ok(not public.crm_storage_object_is_known(''),
          'an empty key is not recognised');

select pg_temp.claims('{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}');
select ok(not public.crm_storage_object_is_known((select known_path from paths)),
          'read_only cannot use the helper as a file-manifest existence oracle');
reset role;

-- ---------------------------------------------------------------------------
-- Anonymous access
-- ---------------------------------------------------------------------------

set local role anon;
select pg_temp.claims('{"role":"anon"}');

select is((select count(*)::int from storage.buckets), 0,
          'anon cannot see the bucket, so it cannot be discovered');
select is((select count(*)::int from storage.objects), 0,
          'anon may hold SELECT but RLS exposes zero CRM objects');
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

-- Install a syntactically valid but unbacked object as a privileged fixture.
-- Real uploads cannot create it through the INSERT policy; its presence makes
-- the following read-boundary assertions non-vacuous.
insert into storage.objects (bucket_id, name)
select 'crm-files', forged_path from paths;

set local role anon;
select pg_temp.claims('{"role":"anon"}');
select is((select count(*)::int from storage.objects), 0,
          'anon still reads zero rows when CRM objects exist');
reset role;

set local role authenticated;
select pg_temp.claims('{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}');
select is((select count(*)::int from storage.objects), 1,
          'a booking manager sees only the manifest-backed object');
select is((select count(*)::int from storage.objects
           where name = (select forged_path from paths)), 0,
          'a booking manager cannot read a forged object path');
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
-- Ready manifests and deletion policy
-- ---------------------------------------------------------------------------

-- Once the manifest is ready, a booking manager may read it but cannot
-- recreate or replace its object. An owner retains an explicit repair path.
set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
select public.mark_enquiry_file_uploaded(
  (select (r -> 'files' -> 0 ->> 'file_id')::uuid from t_enq),
  null
);
reset role;

set local role authenticated;
select pg_temp.claims('{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}');
select ok(not public.crm_storage_object_writable((select known_path from paths)),
          'a booking manager fails the write predicate for a ready manifest');
select ok(not public.is_owner(), 'a booking manager is not an owner');
select ok(not crm_private.is_service_backend(),
          'a booking manager is not mistaken for the backend');
select throws_ok(
  format($$insert into storage.objects (bucket_id, name) values ('crm-files', %L)$$,
         (select known_path from paths)),
  '42501', null,
  'a booking manager cannot replace an object after its manifest is ready'
);
reset role;

set local role authenticated;
select pg_temp.claims('{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}');
select ok(public.crm_storage_object_writable((select known_path from paths)),
          'the owner keeps the documented repair predicate for a ready manifest');
select is((select count(*)::int from storage.objects), 1,
          'the owner sees the manifest-backed object but not the forged object');
select is((select count(*)::int from storage.objects
           where name = (select forged_path from paths)), 0,
          'the owner cannot read a forged object path');
select ok(public.is_owner(), 'the owner identity predicate is true for the owner');
select ok(not crm_private.is_service_backend(),
          'an authenticated owner is not mistaken for the backend');
reset role;

-- The backend satisfies the compensating-cleanup identity predicate. The
-- Storage API must perform the real deletion; direct SQL DELETE is deliberately
-- absent because Supabase protects managed object rows with protect_delete().
set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
select ok(crm_private.is_service_backend(),
          'the service_role satisfies the backend identity predicate');
select ok(public.crm_storage_object_is_known((select known_path from paths)),
          'the backend recognises the manifest-backed path');
reset role;

select is(
  (select count(*)::int
   from pg_policies
   where schemaname = 'storage'
     and tablename = 'objects'
     and policyname = 'crm_files_delete'
     and cmd = 'DELETE'),
  1,
  'the CRM object DELETE policy exists'
);
select ok(
  (select roles @> array['authenticated', 'service_role']::name[]
   from pg_policies
   where schemaname = 'storage'
     and tablename = 'objects'
     and policyname = 'crm_files_delete'),
  'the DELETE policy is scoped to authenticated staff and service_role'
);
select ok(
  (select qual ~ 'bucket_id.*crm-files'
          and qual ~ 'is_owner'
          and qual ~ 'is_service_backend'
   from pg_policies
   where schemaname = 'storage'
     and tablename = 'objects'
     and policyname = 'crm_files_delete'),
  'the DELETE policy requires the CRM bucket and owner-or-backend identity'
);

select * from finish(true);
rollback;
