-- 334_enquiry_file_body_areas.sql
--
-- Optional image category and body-area links (20261009230000).

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('98111111-1111-4111-8111-111111111111', 'areas-manager@example.test'),
  ('98222222-2222-4222-8222-222222222222', 'areas-readonly@example.test');
insert into public.profiles (id, email, role, is_active) values
  ('98111111-1111-4111-8111-111111111111', 'areas-manager@example.test', 'booking_manager', true),
  ('98222222-2222-4222-8222-222222222222', 'areas-readonly@example.test', 'read_only', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level, can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('98111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'manager', false, false, true, false, true),
  ('98222222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111', 'read_only', false, false, false, false, true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to anon, authenticated, service_role;

-- A legacy intake with three unclassified images.
create temporary table t_e as
select public.create_enquiry_intake(
  'ffffffff-0000-4000-8000-000000000001',
  jsonb_build_object('full_name', 'Areas Client', 'email', 'areas@example.test'),
  jsonb_build_object('project_type', 'Cover-up', 'placement', 'Forearm', 'idea', 'Areas',
    'source', '/booking/', 'privacy_acknowledged', true, 'privacy_notice_version', '2026-09-09'),
  jsonb_build_array(
    jsonb_build_object('mime_type', 'image/jpeg', 'safe_extension', 'jpg', 'byte_size', 2048),
    jsonb_build_object('mime_type', 'image/jpeg', 'safe_extension', 'jpg', 'byte_size', 2048),
    jsonb_build_object('mime_type', 'image/jpeg', 'safe_extension', 'jpg', 'byte_size', 2048))
) as r;
select public.mark_enquiry_file_uploaded(f.id) from public.enquiry_files f
where f.enquiry_id = (select (r ->> 'enquiry_id')::uuid from t_e);
select public.finalize_enquiry_intake((select (r ->> 'enquiry_id')::uuid from t_e));

create function pg_temp.file(n integer) returns uuid language sql stable security definer as $$
  select f.id from public.enquiry_files f
  where f.enquiry_id = (select (r ->> 'enquiry_id')::uuid from t_e) and f.ordinal = n;
$$;
grant execute on function pg_temp.file(integer) to authenticated;

select ok(
  (select bool_and(body_areas = '{}' and intake_role is null) from public.enquiry_files
   where enquiry_id = (select (r ->> 'enquiry_id')::uuid from t_e)),
  'existing images are unlinked and unclassified by default');
select throws_ok(
  $$update public.enquiry_files set body_areas = '{tail}' where ordinal = 0$$,
  '23514', null, 'unknown body areas are rejected by the table itself');

set local role authenticated;
select pg_temp.claims('{"sub":"98111111-1111-4111-8111-111111111111","role":"authenticated"}');

select lives_ok(format($$select public.set_enquiry_file_classification(%L, 'design_reference', '{arm}')$$, pg_temp.file(0)),
  'Image 1: design reference / Arm');
select lives_ok(format($$select public.set_enquiry_file_classification(%L, 'existing_tattoo', '{arm}')$$, pg_temp.file(1)),
  'Image 2: existing tattoo / Arm');
select lives_ok(format($$select public.set_enquiry_file_classification(%L, 'design_reference', '{leg,arm}')$$, pg_temp.file(2)),
  'Image 3: design reference for two areas');
reset role;

select is(
  (select jsonb_agg(jsonb_build_array(intake_role, body_areas) order by ordinal) from public.enquiry_files
   where enquiry_id = (select (r ->> 'enquiry_id')::uuid from t_e)),
  '[["design_reference",["arm"]],["existing_tattoo",["arm"]],["design_reference",["leg","arm"]]]'::jsonb,
  'category and areas are stored per image');
select ok(
  (select count(*) = 3 from public.activity_log a
   where a.enquiry_id = (select (r ->> 'enquiry_id')::uuid from t_e) and a.event_type = 'enquiry.reference_classified'),
  'each classification is audited');

set local role authenticated;
select pg_temp.claims('{"sub":"98111111-1111-4111-8111-111111111111","role":"authenticated"}');
select lives_ok(format($$select public.set_enquiry_file_classification(%L, null, '{}')$$, pg_temp.file(2)),
  'classification can be cleared again');
select throws_ok(format($$select public.set_enquiry_file_classification(%L, 'tattoo', '{}')$$, pg_temp.file(0)),
  '22023', null, 'unknown category is rejected');
select throws_ok(format($$select public.set_enquiry_file_classification(%L, null, '{arm,arm}')$$, pg_temp.file(0)),
  '22023', null, 'repeated area is rejected');
reset role;

select ok(
  (select intake_role is null and body_areas = '{}' from public.enquiry_files where id = pg_temp.file(2)),
  'a cleared image is unclassified again');
select is(
  (select storage_path from public.enquiry_files where id = pg_temp.file(0)),
  public.enquiry_file_storage_path(
    (select (r ->> 'client_id')::uuid from t_e), (select (r ->> 'enquiry_id')::uuid from t_e),
    pg_temp.file(0), 'jpg'),
  'the Storage path is unchanged');
select is(crm_private.enquiry_v2_region_labels('{leg,arm}'), '["Leg","Arm"]'::jsonb, 'keys map to labels in order');

set local role authenticated;
select pg_temp.claims('{"sub":"98222222-2222-4222-8222-222222222222","role":"authenticated"}');
select throws_ok(format($$select public.set_enquiry_file_classification(%L, null, '{}')$$, pg_temp.file(0)),
  '42501', null, 'read_only cannot classify images');
reset role;

select ok(has_function_privilege('authenticated', 'public.set_enquiry_file_classification(uuid,text,text[])', 'EXECUTE'), 'authenticated may call');
select ok(not has_function_privilege('anon', 'public.set_enquiry_file_classification(uuid,text,text[])', 'EXECUTE'), 'anon may not call');
select ok(not has_function_privilege('service_role', 'public.set_enquiry_file_classification(uuid,text,text[])', 'EXECUTE'), 'service_role is not granted');
select ok(has_column_privilege('authenticated', 'public.enquiry_files', 'body_areas', 'SELECT'), 'CRM users can read body_areas');
select ok(
  (select 'body_areas' = any(p.proargnames) and 'intake_role' = any(p.proargnames)
   from pg_proc p where p.oid = 'public.gpt_list_enquiry_files(uuid)'::regprocedure),
  'GPT file list returns role and areas');

select * from finish(true);
rollback;
