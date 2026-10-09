-- 330_enquiry_reference_six_slots.sql
--
-- Operator CRM may hold up to six reference images per enquiry
-- (20261009200000). A seventh is rejected. Legacy enquiries with three intake
-- images and v2 enquiries with six keep working, and the existing role,
-- artist scope and ACL rules are unchanged (see 199_crm_record_editing_references).

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('96111111-1111-4111-8111-111111111111', 'six-owner@example.test'),
  ('96222222-2222-4222-8222-222222222222', 'six-manager@example.test'),
  ('96333333-3333-4333-8333-333333333333', 'six-readonly@example.test');

insert into public.profiles (id, email, role, is_active) values
  ('96111111-1111-4111-8111-111111111111', 'six-owner@example.test', 'owner', true),
  ('96222222-2222-4222-8222-222222222222', 'six-manager@example.test', 'booking_manager', true),
  ('96333333-3333-4333-8333-333333333333', 'six-readonly@example.test', 'read_only', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('96222222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, false, true),
  ('96333333-3333-4333-8333-333333333333', 'a1111111-1111-4111-8111-111111111111',
   'read_only', false, false, false, false, true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to anon, authenticated, service_role;

create function pg_temp.intake_meta(p_details jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'project_type', 'Black & Grey Realism',
    'placement', 'Forearm',
    'idea', 'Six slot test',
    'source', '/booking/',
    'privacy_acknowledged', true,
    'privacy_notice_version', '2026-09-09'
  ) || case when p_details is null then '{}'::jsonb
            else jsonb_build_object('project_details', p_details) end;
$$;

create function pg_temp.intake_files(n integer, p_role text) returns jsonb language sql immutable as $$
  select jsonb_agg(jsonb_build_object(
    'mime_type', 'image/jpeg', 'safe_extension', 'jpg', 'byte_size', 2048,
    'original_filename', 'intake-' || i || '.jpg'
  ) || case when p_role is null then '{}'::jsonb
            else jsonb_build_object('intake_role', p_role) end order by i)
  from generate_series(1, n) as i;
$$;

-- Prepares one operator reference and returns its ordinal.
create function pg_temp.prepare(p_enquiry uuid) returns smallint language sql as $$
  select (public.prepare_enquiry_reference_upload(p_enquiry, 'ref.jpg', 'image/jpeg', 1024) ->> 'ordinal')::smallint;
$$;
grant execute on function pg_temp.prepare(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures: a legacy enquiry with three intake images and a v2 enquiry with six
-- ---------------------------------------------------------------------------

create temporary table t_legacy as
select public.create_enquiry_intake(
  'cccccccc-0000-4000-8000-000000000001',
  jsonb_build_object('full_name', 'Legacy Three', 'email', 'legacy-three@example.test'),
  pg_temp.intake_meta(null),
  pg_temp.intake_files(3, null)
) as r;

create temporary table t_v2 as
select public.create_enquiry_intake(
  'cccccccc-0000-4000-8000-000000000002',
  jsonb_build_object('full_name', 'Form Six', 'email', 'form-six@example.test'),
  pg_temp.intake_meta(jsonb_build_object('schema', 'enquiry-v2', 'areas', '[]'::jsonb)),
  pg_temp.intake_files(6, 'design_reference')
) as r;

select public.mark_enquiry_file_uploaded(f.id)
from public.enquiry_files f
where f.enquiry_id in ((select (r ->> 'enquiry_id')::uuid from t_legacy),
                       (select (r ->> 'enquiry_id')::uuid from t_v2));
select public.finalize_enquiry_intake((select (r ->> 'enquiry_id')::uuid from t_legacy));
select public.finalize_enquiry_intake((select (r ->> 'enquiry_id')::uuid from t_v2));

grant select on t_legacy, t_v2 to authenticated;

-- A manual enquiry starts with no images.
set local role authenticated;
select pg_temp.claims('{"sub":"96111111-1111-4111-8111-111111111111","role":"authenticated"}');
create temporary table t_manual as
select public.create_manual_enquiry(
  '96000000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  jsonb_build_object('full_name', 'Manual Six', 'email', 'manual-six@example.test'),
  jsonb_build_object('project_type', 'Cover-up', 'placement', 'Arm', 'idea', 'Six slot manual'),
  true
) as r;
reset role;
grant select on t_manual to authenticated;

-- ---------------------------------------------------------------------------
-- 3, 4, 5, 6 accepted; 7 rejected (manual enquiry, booking manager)
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"96222222-2222-4222-8222-222222222222","role":"authenticated"}');

select is(pg_temp.prepare((select (r ->> 'enquiry_id')::uuid from t_manual)), 0::smallint,
  'reference 1 of a new enquiry takes ordinal 0');
select is(pg_temp.prepare((select (r ->> 'enquiry_id')::uuid from t_manual)), 1::smallint,
  'reference 2 of a new enquiry takes ordinal 1');
select is(pg_temp.prepare((select (r ->> 'enquiry_id')::uuid from t_manual)), 2::smallint,
  'reference 3 of a new enquiry takes ordinal 2');
select is(pg_temp.prepare((select (r ->> 'enquiry_id')::uuid from t_manual)), 3::smallint,
  'a fourth reference is accepted');
select is(pg_temp.prepare((select (r ->> 'enquiry_id')::uuid from t_manual)), 4::smallint,
  'a fifth reference is accepted');
select is(pg_temp.prepare((select (r ->> 'enquiry_id')::uuid from t_manual)), 5::smallint,
  'a sixth reference is accepted');
select throws_ok(
  format($$select pg_temp.prepare(%L)$$, (select r ->> 'enquiry_id' from t_manual)),
  '23514', 'an enquiry can have at most six reference images',
  'a seventh reference is rejected'
);
select is(
  (select count(*)::int from public.enquiry_files
   where enquiry_id = (select (r ->> 'enquiry_id')::uuid from t_manual)),
  6,
  'the rejected seventh attempt leaves no manifest behind'
);

-- A cancelled pending slot (no Storage object) is reused, not skipped.
select lives_ok(
  format($$select public.cancel_enquiry_reference_upload(%L)$$,
    (select id from public.enquiry_files
     where enquiry_id = (select (r ->> 'enquiry_id')::uuid from t_manual) and ordinal = 4)),
  'a pending upload without a Storage object can be cancelled'
);
select is(pg_temp.prepare((select (r ->> 'enquiry_id')::uuid from t_manual)), 4::smallint,
  'the freed slot is reused by the next upload');

-- The sixth image finalises like the first: the Storage policy accepts the
-- canonical path for ordinal 5 and the manifest becomes ready.
select lives_ok(
  format($$insert into storage.objects (bucket_id, name) values ('crm-files', %L)$$,
    (select storage_path from public.enquiry_files
     where enquiry_id = (select (r ->> 'enquiry_id')::uuid from t_manual) and ordinal = 5)),
  'the Storage policy accepts the canonical path of the sixth reference'
);
select lives_ok(
  format($$select public.finalize_enquiry_reference_upload(%L)$$,
    (select id from public.enquiry_files
     where enquiry_id = (select (r ->> 'enquiry_id')::uuid from t_manual) and ordinal = 5)),
  'the sixth reference finalises'
);
select is(
  (select upload_state::text from public.enquiry_files
   where enquiry_id = (select (r ->> 'enquiry_id')::uuid from t_manual) and ordinal = 5),
  'ready',
  'the sixth reference is ready'
);

-- ---------------------------------------------------------------------------
-- Legacy enquiry with three intake images gains slots 3-5
-- ---------------------------------------------------------------------------

select is(pg_temp.prepare((select (r ->> 'enquiry_id')::uuid from t_legacy)), 3::smallint,
  'a legacy three-image enquiry accepts operator reference ordinal 3');
select is(pg_temp.prepare((select (r ->> 'enquiry_id')::uuid from t_legacy)), 4::smallint,
  'a legacy three-image enquiry accepts operator reference ordinal 4');
select is(pg_temp.prepare((select (r ->> 'enquiry_id')::uuid from t_legacy)), 5::smallint,
  'a legacy three-image enquiry accepts operator reference ordinal 5');
select throws_ok(
  format($$select pg_temp.prepare(%L)$$, (select r ->> 'enquiry_id' from t_legacy)),
  '23514', null,
  'a legacy enquiry stops at six images'
);
select is(
  (select count(*)::int from public.enquiry_files
   where enquiry_id = (select (r ->> 'enquiry_id')::uuid from t_legacy)
     and intake_role is null and ordinal between 0 and 2),
  3,
  'the legacy intake manifests are untouched'
);

-- ---------------------------------------------------------------------------
-- v2 enquiry already holding six intake images
-- ---------------------------------------------------------------------------

select throws_ok(
  format($$select pg_temp.prepare(%L)$$, (select r ->> 'enquiry_id' from t_v2)),
  '23514', null,
  'a v2 enquiry with six intake images accepts no further reference'
);
select is(
  (select count(*)::int from public.enquiry_files
   where enquiry_id = (select (r ->> 'enquiry_id')::uuid from t_v2)
     and intake_role = 'design_reference'),
  6,
  'v2 intake roles are kept'
);

-- Input limits are unchanged.
select throws_ok(
  format($$select public.prepare_enquiry_reference_upload(%L, 'big.jpg', 'image/jpeg', %s)$$,
    (select r ->> 'enquiry_id' from t_manual), 4 * 1024 * 1024 + 1),
  '22023', null,
  'the 4 MB per-file limit is unchanged'
);
select throws_ok(
  format($$select public.prepare_enquiry_reference_upload(%L, 'x.gif', 'image/gif', 100)$$,
    (select r ->> 'enquiry_id' from t_manual)),
  '22023', null,
  'the MIME allowlist is unchanged'
);
reset role;

-- ---------------------------------------------------------------------------
-- Permissions are unchanged
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"96333333-3333-4333-8333-333333333333","role":"authenticated"}');
select throws_ok(
  format($$select pg_temp.prepare(%L)$$, (select r ->> 'enquiry_id' from t_legacy)),
  '42501', null,
  'read_only still cannot prepare a reference upload'
);
reset role;

select ok(has_function_privilege('authenticated', 'public.prepare_enquiry_reference_upload(uuid,text,text,bigint)', 'EXECUTE'),
  'authenticated may prepare a reference upload');
select ok(not has_function_privilege('anon', 'public.prepare_enquiry_reference_upload(uuid,text,text,bigint)', 'EXECUTE'),
  'anon cannot prepare a reference upload');
select ok(not has_function_privilege('service_role', 'public.prepare_enquiry_reference_upload(uuid,text,text,bigint)', 'EXECUTE'),
  'service_role is not granted the staff reference workflow');

select * from finish(true);
rollback;
