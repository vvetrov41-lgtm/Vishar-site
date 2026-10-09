-- 333_enquiry_project_summary.sql
--
-- enquiries.project_summary (20261009220000) and the additive GPT/MCP read
-- contract: project_details, project_summary, image roles.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create function pg_temp.summary(p_input text) returns text language sql as $$
  select crm_private.enquiry_project_summary(
    crm_private.normalise_enquiry_project_input(p_input::jsonb) -> 'project_details');
$$;

select is(pg_temp.summary('{"areas":[{"region":"arm","placements":["full_sleeve","forearm"],"work":["cover_up"]},{"region":"leg","placements":["calf"],"work":["new"]}],"styles":["colour"]}'),
  'Full sleeve + Forearm cover-up + Leg tattoo',
  'a sleeve with a forearm cover-up plus a leg tattoo is not reduced to Cover-up');
select is(pg_temp.summary('{"areas":[{"region":"back","placements":["full_back"],"work":["rework"]}],"styles":["colour"]}'),
  'Full back rework', 'a large placement alone carries its existing-work label');
select is(pg_temp.summary('{"areas":[{"region":"arm","placements":["forearm","wrist"],"work":["cover_up","extension"]}],"styles":["colour"]}'),
  'Forearm cover-up/extension + Wrist cover-up/extension', 'combined existing work is kept');
select is(pg_temp.summary('{"areas":[{"region":"other","placements":[],"otherPlacement":"Inner lip","work":["new"]}],"styles":["colour"]}'),
  'Inner lip tattoo', 'an Other area is named by the client''s words');
select is(pg_temp.summary('{"areas":[{"region":"arm","placements":["other"],"otherPlacement":"Back of arm","work":["extension"]},{"region":"hand","placements":["fingers"],"work":["new"]}],"styles":["colour"]}'),
  'Back of arm extension + Hand tattoo', 'Other placement text and a second area');
select is(pg_temp.summary('{"areas":[{"region":"leg","placements":["half_leg_sleeve"],"work":["new"]}],"styles":["colour"]}'),
  'Half leg sleeve', 'a new large piece is named by its placement');
select ok(crm_private.enquiry_project_summary(null) is null, 'legacy enquiries have no summary');
select ok(crm_private.enquiry_project_summary('{"areas":[]}'::jsonb) is null, 'no areas, no summary');
select is(crm_private.enquiry_project_summary('{"areas":[{"region":"Tail","placements":["X"],"work":["Cover-up"]}]}'::jsonb),
  'X cover-up', 'an unknown stored label degrades to plain text instead of failing');

-- Generated column follows writes.
create temporary table t_v2 as
select public.create_enquiry_intake(
  'eeeeeeee-0000-4000-8000-000000000001',
  jsonb_build_object('full_name', 'Summary Client', 'email', 'summary@example.test'),
  jsonb_build_object('idea', 'Sleeve and leg', 'source', '/booking/',
    'privacy_acknowledged', true, 'privacy_notice_version', '2026-09-09',
    'project_type', 'Cover-up',
    'project_details', crm_private.normalise_enquiry_project_input('{"areas":[{"region":"arm","placements":["full_sleeve","forearm"],"work":["cover_up"]},{"region":"leg","placements":["calf"],"work":["new"]}],"styles":["colour"]}'::jsonb) -> 'project_details'),
  jsonb_build_array(
    jsonb_build_object('mime_type', 'image/jpeg', 'safe_extension', 'jpg', 'byte_size', 2048, 'intake_role', 'existing_tattoo'),
    jsonb_build_object('mime_type', 'image/jpeg', 'safe_extension', 'jpg', 'byte_size', 2048, 'intake_role', 'design_reference'))
) as r;

select is(
  (select project_summary from public.enquiries where id = (select (r ->> 'enquiry_id')::uuid from t_v2)),
  'Full sleeve + Forearm cover-up + Leg tattoo',
  'intake stores the summary with the structured answers');

update public.enquiries
set project_details = crm_private.normalise_enquiry_project_input('{"areas":[{"region":"leg","placements":["calf"],"work":["new"]}],"styles":["colour"]}'::jsonb) -> 'project_details'
where id = (select (r ->> 'enquiry_id')::uuid from t_v2);
select is(
  (select project_summary from public.enquiries where id = (select (r ->> 'enquiry_id')::uuid from t_v2)),
  'Leg tattoo', 'the summary is recomputed when project_details changes');
select ok(
  not exists (select 1 from public.enquiries where project_details is null and project_summary is not null),
  'legacy rows stay without a summary');

-- Read contract.
select ok(has_column_privilege('authenticated', 'public.enquiries', 'project_summary', 'SELECT'),
  'CRM users can read the summary column');
select ok(not has_column_privilege('anon', 'public.enquiries', 'project_summary', 'SELECT'),
  'anon cannot read the summary column');

select is(
  (select array_agg(a.attname::text order by a.attnum)
   from pg_proc p, unnest(p.proargnames) with ordinality a(attname, attnum)
   where p.oid = 'public.gpt_get_enquiry_full(uuid)'::regprocedure and a.attnum > 32),
  array['project_summary', 'project_details'],
  'gpt_get_enquiry_full appends project_summary and project_details');
select ok(
  (select 'reference_analyses' = any(p.proargnames) and 'idea' = any(p.proargnames) and 'cover_up' = any(p.proargnames)
   from pg_proc p where p.oid = 'public.gpt_get_enquiry_full(uuid)'::regprocedure),
  'gpt_get_enquiry_full keeps every existing field');
select ok(
  (select 'project_details' = any(p.proargnames) and 'project_summary' = any(p.proargnames) and 'idea' = any(p.proargnames)
   from pg_proc p where p.oid = 'public.gpt_get_enquiry(uuid)'::regprocedure),
  'gpt_get_enquiry returns structure, summary and the client text');
select ok(
  (select 'project_summary' = any(p.proargnames) and 'project_type' = any(p.proargnames)
   from pg_proc p where p.oid = 'public.gpt_list_enquiries(timestamp with time zone,timestamp with time zone,public.enquiry_status,integer)'::regprocedure),
  'gpt_list_enquiries returns the summary next to the legacy type');
select ok(
  (select 'intake_role' = any(p.proargnames) from pg_proc p where p.oid = 'public.gpt_list_enquiry_files(uuid)'::regprocedure),
  'gpt_list_enquiry_files returns image roles');

-- ACL unchanged on the recreated reads.
select ok(has_function_privilege('authenticated', 'public.gpt_get_enquiry_full(uuid)', 'EXECUTE'), 'gpt_get_enquiry_full: authenticated');
select ok(not has_function_privilege('anon', 'public.gpt_get_enquiry_full(uuid)', 'EXECUTE'), 'gpt_get_enquiry_full: not anon');
select ok(not has_function_privilege('anon', 'public.gpt_get_enquiry(uuid)', 'EXECUTE'), 'gpt_get_enquiry: not anon');
select ok(not has_function_privilege('anon', 'public.gpt_list_enquiry_files(uuid)', 'EXECUTE'), 'gpt_list_enquiry_files: not anon');
select ok(not has_function_privilege('anon', 'public.gpt_list_enquiries(timestamp with time zone,timestamp with time zone,public.enquiry_status,integer)', 'EXECUTE'), 'gpt_list_enquiries: not anon');

-- Image roles reach the stored analyses.
select public.mark_enquiry_file_uploaded(f.id) from public.enquiry_files f
where f.enquiry_id = (select (r ->> 'enquiry_id')::uuid from t_v2);
insert into public.enquiry_file_ai_analysis (
  artist_id, workspace_id, client_id, enquiry_id, enquiry_file_id, source_checksum, analysis, summary, provider, model
)
select e.artist_id, a.workspace_id, e.client_id, e.id, f.id, repeat('e', 64),
  jsonb_build_object(
    'summary', 'Test photo.',
    'palette', 'Skin tones.',
    'subjects', jsonb_build_array('test'),
    'body_area', 'forearm',
    'image_kind', 'existing_tattoo',
    'composition', 'Vertical.',
    'quality_limitations', jsonb_build_array(),
    'existing_tattoo_visible', true),
  'Test photo.', 'qwen', '@cf/qwen/qwen3.8-27b'
from public.enquiry_files f
join public.enquiries e on e.id = f.enquiry_id
join public.artists a on a.id = e.artist_id
where f.enquiry_id = (select (r ->> 'enquiry_id')::uuid from t_v2);
select is(
  (select jsonb_agg(i -> 'role') from jsonb_array_elements(
     crm_private.enquiry_reference_analyses((select (r ->> 'enquiry_id')::uuid from t_v2)) -> 'images') i),
  '["existing_tattoo","design_reference"]'::jsonb,
  'reference_analyses carry each photo''s role in CRM order');

select * from finish(true);
rollback;
