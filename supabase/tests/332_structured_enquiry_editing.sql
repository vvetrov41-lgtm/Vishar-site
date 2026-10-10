-- 332_structured_enquiry_editing.sql
--
-- update_enquiry_project_details (20261009210000): structured edits of booking
-- form v2 enquiries, server-side recomputation of the legacy columns,
-- optimistic conflict detection, unchanged client text, legacy enquiries and
-- the derived-column guard in the legacy edit path (CRM and GPT).

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('97111111-1111-4111-8111-111111111111', 'struct-owner@example.test'),
  ('97222222-2222-4222-8222-222222222222', 'struct-manager@example.test'),
  ('97333333-3333-4333-8333-333333333333', 'struct-readonly@example.test');

insert into public.profiles (id, email, role, is_active) values
  ('97111111-1111-4111-8111-111111111111', 'struct-owner@example.test', 'owner', true),
  ('97222222-2222-4222-8222-222222222222', 'struct-manager@example.test', 'booking_manager', true),
  ('97333333-3333-4333-8333-333333333333', 'struct-readonly@example.test', 'read_only', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('97222222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, false, true),
  ('97333333-3333-4333-8333-333333333333', 'a1111111-1111-4111-8111-111111111111',
   'read_only', false, false, false, false, true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to anon, authenticated, service_role;

-- A v2 enquiry exactly as the Worker writes it: full sleeve with a forearm
-- cover-up plus a new calf tattoo.
create temporary table t_v2 as
select public.create_enquiry_intake(
  'dddddddd-0000-4000-8000-000000000001',
  jsonb_build_object('full_name', 'Structured Client', 'email', 'structured@example.test'),
  jsonb_build_object(
    'idea', 'Original client words about the sleeve.',
    'preferred_timing', 'Spring',
    'source', '/booking/',
    'privacy_acknowledged', true,
    'privacy_notice_version', '2026-09-09'
  ) || (crm_private.normalise_enquiry_project_input('{
    "areas":[{"region":"arm","placements":["full_sleeve","forearm"],"work":["cover_up"]},
             {"region":"leg","placements":["calf"],"work":["new"]}],
    "styles":["colour"],"existingDetails":"Old tribal band"}'::jsonb) - 'project_details')
    || jsonb_build_object('project_details', crm_private.normalise_enquiry_project_input('{
    "areas":[{"region":"arm","placements":["full_sleeve","forearm"],"work":["cover_up"]},
             {"region":"leg","placements":["calf"],"work":["new"]}],
    "styles":["colour"],"existingDetails":"Old tribal band"}'::jsonb) -> 'project_details'),
  jsonb_build_array(jsonb_build_object('mime_type', 'image/jpeg', 'safe_extension', 'jpg',
    'byte_size', 2048, 'intake_role', 'existing_tattoo'))
) as r;
select public.mark_enquiry_file_uploaded(f.id) from public.enquiry_files f
where f.enquiry_id = (select (r ->> 'enquiry_id')::uuid from t_v2);
select public.finalize_enquiry_intake((select (r ->> 'enquiry_id')::uuid from t_v2));
grant select on t_v2 to authenticated;

create function pg_temp.v2_id() returns uuid language sql stable as $$
  select (r ->> 'enquiry_id')::uuid from t_v2;
$$;
grant execute on function pg_temp.v2_id() to authenticated;

create function pg_temp.loaded() returns jsonb language sql stable security definer as $$
  select jsonb_build_object('project_details', e.project_details, 'preferred_timing', e.preferred_timing)
  from public.enquiries e where e.id = pg_temp.v2_id();
$$;
grant execute on function pg_temp.loaded() to authenticated;

select is((select cover_up from public.enquiries where id = pg_temp.v2_id()), 'Yes',
  'fixture: Worker-derived cover_up');

-- ---------------------------------------------------------------------------
-- Manager edits areas, styles and timing
-- ---------------------------------------------------------------------------

create temporary table t_snapshot as select pg_temp.loaded() as loaded;
grant select on t_snapshot to authenticated;

set local role authenticated;
select pg_temp.claims('{"sub":"97222222-2222-4222-8222-222222222222","role":"authenticated"}');

select lives_ok(
  format($$select public.update_enquiry_project_details(%L, %L::jsonb, %L::jsonb)$$,
    pg_temp.v2_id(),
    '{"areas":[{"region":"arm","placements":["full_sleeve","forearm"],"work":["cover_up","extension"]},
               {"region":"leg","placements":["thigh","calf"],"work":["new"]}],
      "styles":["colour","black_grey"],
      "sizeNotes":"Thigh piece about 20 cm",
      "existingDetails":"Old tribal band",
      "preferred_timing":"Summer"}',
    (select loaded from t_snapshot)),
  'booking manager can edit a structured enquiry in their artist scope'
);
reset role;

select is(
  (select jsonb_build_object('project_type', project_type, 'placement', placement,
     'approximate_size', approximate_size, 'cover_up', cover_up, 'preferred_timing', preferred_timing)
   from public.enquiries where id = pg_temp.v2_id()),
  jsonb_build_object('project_type', 'Cover-up',
    'placement', 'Arm: Full sleeve, Forearm; Leg: Thigh, Calf',
    'approximate_size', 'Thigh piece about 20 cm', 'cover_up', 'Yes', 'preferred_timing', 'Summer'),
  'legacy columns are recomputed on the server from the new structure'
);
select is(
  (select project_details -> 'areas' from public.enquiries where id = pg_temp.v2_id()),
  '[{"region":"Arm","placements":["Full sleeve","Forearm"],"work":["Cover-up","Extension"]},
    {"region":"Leg","placements":["Thigh","Calf"],"work":["New tattoo"]}]'::jsonb,
  'multiple areas and combined Cover-up + Extension are stored'
);
select is(
  (select project_details -> 'styles' from public.enquiries where id = pg_temp.v2_id()),
  '["Colour realism","Black & Grey realism"]'::jsonb,
  'styles are updated'
);
select is(
  (select idea from public.enquiries where id = pg_temp.v2_id()),
  'Original client words about the sleeve.',
  'the client''s own description is never changed by a structured edit'
);
select ok(
  exists (select 1 from public.activity_log a
          where a.enquiry_id = pg_temp.v2_id() and a.event_type = 'enquiry.updated'
            and (a.metadata ->> 'structured')::boolean
            and a.metadata -> 'changed_fields' ? 'project_details'),
  'the structured edit is audited with changed field names'
);

-- Remove the cover-up: every derived view follows.
create temporary table t_snapshot2 as select pg_temp.loaded() as loaded;
grant select on t_snapshot2 to authenticated;
set local role authenticated;
select pg_temp.claims('{"sub":"97222222-2222-4222-8222-222222222222","role":"authenticated"}');
select lives_ok(
  format($$select public.update_enquiry_project_details(%L, %L::jsonb, %L::jsonb)$$,
    pg_temp.v2_id(),
    '{"areas":[{"region":"leg","placements":["calf"],"work":["new"]}],"styles":["colour"],
      "existingDetails":"dropped because nothing is existing"}',
    (select loaded from t_snapshot2)),
  'an edit can remove areas and work types'
);
reset role;
select is(
  (select jsonb_build_array(project_type, placement, approximate_size, cover_up,
     project_details ? 'existingDetails', project_details #> '{imageRequirements,existingTattooPhoto}')
   from public.enquiries where id = pg_temp.v2_id()),
  '["Colour realism","Leg: Calf","Not specified","No",false,false]'::jsonb,
  'type, placement, size, cover-up and image requirements no longer claim a cover-up'
);

-- ---------------------------------------------------------------------------
-- Concurrent edits
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"97111111-1111-4111-8111-111111111111","role":"authenticated"}');
select throws_ok(
  format($$select public.update_enquiry_project_details(%L, %L::jsonb, %L::jsonb)$$,
    pg_temp.v2_id(),
    '{"areas":[{"region":"back","placements":["full_back"],"work":["new"]}],"styles":["colour"]}',
    (select loaded from t_snapshot)),
  '55000', 'the enquiry was changed by someone else; reload it and try again',
  'an edit based on stale project details is refused'
);
select throws_ok(
  format($$select public.update_enquiry_project_details(%L, %L::jsonb, %L::jsonb)$$,
    pg_temp.v2_id(),
    '{"areas":[{"region":"back","placements":["full_back"],"work":["new"]}],"styles":["colour"]}',
    jsonb_set(pg_temp.loaded(), '{preferred_timing}', '"Winter"')),
  '55000', null,
  'an edit based on stale timing is refused'
);
select throws_ok(
  format($$select public.update_enquiry_project_details(%L, %L::jsonb, '{}'::jsonb)$$,
    pg_temp.v2_id(),
    '{"areas":[{"region":"back","placements":["full_back"],"work":["new"]}],"styles":["colour"]}'),
  '22023', null,
  'the loaded state is mandatory'
);
select is(
  (select placement from public.enquiries where id = pg_temp.v2_id()),
  'Leg: Calf',
  'refused edits leave the enquiry unchanged'
);

-- Invalid structure is refused with the Worker's rules.
select throws_ok(
  format($$select public.update_enquiry_project_details(%L, %L::jsonb, %L::jsonb)$$,
    pg_temp.v2_id(),
    '{"areas":[{"region":"arm","placements":["forearm"],"work":["new","cover_up"]}],"styles":["colour"]}',
    pg_temp.loaded()),
  '22023', null,
  'New tattoo cannot be combined with existing work in one area'
);
select throws_ok(
  format($$select public.update_enquiry_project_details(%L, %L::jsonb, %L::jsonb)$$,
    pg_temp.v2_id(),
    '{"areas":[{"region":"arm","placements":["forearm"],"work":["new"]}],"styles":["colour"],"idea":"rewrite"}',
    pg_temp.loaded()),
  '22023', null,
  'the structured edit cannot touch the client description'
);
reset role;

-- ---------------------------------------------------------------------------
-- Legacy edit path on a structured enquiry (CRM form and GPT)
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"97222222-2222-4222-8222-222222222222","role":"authenticated"}');
select throws_ok(
  format($$select public.update_enquiry_details(%L, '{"placement":"Back"}'::jsonb)$$, pg_temp.v2_id()),
  '22023', null,
  'derived columns of a structured enquiry cannot be overwritten by hand'
);
select lives_ok(
  format($$select public.update_enquiry_details(%L, %L::jsonb)$$, pg_temp.v2_id(),
    jsonb_build_object('placement', 'Leg: Calf', 'project_type', 'Colour realism',
                       'preferred_timing', 'Autumn', 'idea', 'Operator-corrected idea')),
  'unchanged derived values, timing and idea are still accepted'
);
select is(
  (select preferred_timing from public.enquiries where id = pg_temp.v2_id()),
  'Autumn',
  'timing is edited through the legacy path'
);
reset role;

-- ---------------------------------------------------------------------------
-- Legacy enquiries keep the old editor
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"97111111-1111-4111-8111-111111111111","role":"authenticated"}');
create temporary table t_legacy as
select public.create_manual_enquiry(
  '97000000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  jsonb_build_object('full_name', 'Legacy Edit', 'email', 'legacy-edit@example.test'),
  jsonb_build_object('project_type', 'Cover-up', 'placement', 'Forearm', 'idea', 'Legacy idea'),
  true
) as r;
select throws_ok(
  format($$select public.update_enquiry_project_details(%L, %L::jsonb, %L::jsonb)$$,
    (select r ->> 'enquiry_id' from t_legacy),
    '{"areas":[{"region":"arm","placements":["forearm"],"work":["new"]}],"styles":["colour"]}',
    '{"project_details":null}'),
  '22023', null,
  'a legacy enquiry is not converted by the structured editor'
);
select lives_ok(
  format($$select public.update_enquiry_details(%L, '{"placement":"Upper arm","cover_up":"No"}'::jsonb)$$,
    (select r ->> 'enquiry_id' from t_legacy)),
  'legacy enquiries keep free-text editing of every field'
);
select is(
  (select placement from public.enquiries where id = (select (r ->> 'enquiry_id')::uuid from t_legacy)),
  'Upper arm',
  'legacy placement is updated'
);
reset role;

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

set local role authenticated;
select pg_temp.claims('{"sub":"97333333-3333-4333-8333-333333333333","role":"authenticated"}');
select throws_ok(
  format($$select public.update_enquiry_project_details(%L, %L::jsonb, %L::jsonb)$$,
    pg_temp.v2_id(),
    '{"areas":[{"region":"arm","placements":["forearm"],"work":["new"]}],"styles":["colour"]}',
    '{"project_details":null}'),
  '42501', null,
  'read_only cannot edit structured details'
);
reset role;

select ok(has_function_privilege('authenticated', 'public.update_enquiry_project_details(uuid,jsonb,jsonb)', 'EXECUTE'),
  'authenticated may call the structured edit and is then checked inside it');
select ok(not has_function_privilege('anon', 'public.update_enquiry_project_details(uuid,jsonb,jsonb)', 'EXECUTE'),
  'anon cannot call the structured edit');
select ok(not has_function_privilege('service_role', 'public.update_enquiry_project_details(uuid,jsonb,jsonb)', 'EXECUTE'),
  'service_role is not granted the staff structured edit');
select ok(not has_function_privilege('authenticated', 'crm_private.normalise_enquiry_project_input(jsonb)', 'EXECUTE'),
  'the normaliser is private');

select * from finish(true);
rollback;
