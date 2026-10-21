-- 341_multilingual_placement_conflicts.sql
-- Advisory facts: generalized, translated and specific body-area descriptions.
-- All fixture records are rolled back.
begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(crm_private.fact_placement_terms('Left outer forearm'), array['forearm']::text[],
  'original English forearm precision is retained');
select is(crm_private.fact_placement_terms('Рука (плечевая область, возможно, продлеваясь до полусleeve)'),
  array['arm', 'shoulder']::text[], 'the mixed-language AI brief resolves to known arm areas');
select is(crm_private.fact_placement_terms('not sure yet'), '{}'::text[],
  'an unspecified area is not treated as a contradiction');
select ok(not crm_private.fact_placement_is_conflict(
  crm_private.fact_placement_terms('Arm'),
  crm_private.fact_placement_terms('Рука (плечевая область, возможно, продлеваясь до полусleeve)')),
  'production incident: Arm versus the Russian shoulder/half-sleeve brief is compatible');
select ok(not crm_private.fact_placement_is_conflict(
  crm_private.fact_placement_terms('Arm'), crm_private.fact_placement_terms('Shoulder')),
  'broad arm is compatible with the English shoulder subregion');
select ok(not crm_private.fact_placement_is_conflict(
  crm_private.fact_placement_terms('Forearm'), crm_private.fact_placement_terms('Arm')),
  'broad arm is compatible with forearm');
select ok(crm_private.fact_placement_is_conflict(
  crm_private.fact_placement_terms('Forearm'), crm_private.fact_placement_terms('Shoulder')),
  'different specifically named arm subregions still conflict');
select ok(crm_private.fact_placement_is_conflict(
  crm_private.fact_placement_terms('Arm'), crm_private.fact_placement_terms('Правая икра')),
  'arm versus Russian calf remains a genuine conflict');
select ok(crm_private.fact_placement_is_conflict(
  crm_private.fact_placement_terms('Left forearm'), crm_private.fact_placement_terms('Right calf')),
  'existing English incompatibility still triggers');
select ok(not crm_private.fact_placement_is_conflict(
  crm_private.fact_placement_terms('Arm'), crm_private.fact_placement_terms('unclear')),
  'unknown AI area must not create a fake conflict');

insert into public.clients (id, workspace_id, full_name, email)
select 'd6400000-0000-4000-8000-000000000341', a.workspace_id,
  'Placement Regression Fixture', 'placement-regression-341@example.test'
from public.artists a where a.id='a1111111-1111-4111-8111-111111111111';

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at,
  placement, approximate_size
) values (
  'd6500000-0000-4000-8000-000000000341', 'd6400000-0000-4000-8000-000000000341',
  'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-9341',
  'd6510000-0000-4000-8000-000000000341', repeat('f',64),
  'reviewing', 'complete', 'Placement Regression Fixture',
  'placement-regression-341@example.test', '2026-08-05', now(), 'Arm', 'Half sleeve');

insert into public.client_ai_state (
  artist_id, workspace_id, client_id, summary, brief, missing_information, source_watermark, provider, model
)
select a.id, a.workspace_id, 'd6400000-0000-4000-8000-000000000341',
  'Fixture', jsonb_build_object(
    'project_summary', 'Synthetic project',
    'stage', 'awaiting_artist_review',
    'placement', 'Рука (плечевая область, возможно, продлеваясь до полусleeve)',
    'style', null, 'colour', null, 'size', 'Half sleeve', 'cover_up_context', null,
    'constraints', jsonb_build_array(), 'decisions_made', jsonb_build_array(),
    'open_questions', jsonb_build_array(), 'promises_to_client', jsonb_build_array(),
    'waiting_on', 'artist', 'last_interaction', 'Synthetic fixture',
    'discussed', jsonb_build_object(
      'session_estimate', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'price', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'deposit', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'candidate_dates', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'confirmed_dates', jsonb_build_object('value', null, 'status', 'not_discussed'))),
  '[]'::jsonb,
  crm_private.client_ai_watermark(a.id, 'd6400000-0000-4000-8000-000000000341'),
  'workers_ai', '@cf/meta/llama-3.1-8b-instruct-fast'
from public.artists a where a.id='a1111111-1111-4111-8111-111111111111';

select is(crm_private.client_fact_conflicts(
  'a1111111-1111-4111-8111-111111111111', 'd6400000-0000-4000-8000-000000000341'),
  '{}'::text[], 'canonical provenance path no longer produces the false conflict');
select is(crm_private.pulse_fact_conflicts(
  'a1111111-1111-4111-8111-111111111111', 'd6400000-0000-4000-8000-000000000341'),
  '{}'::text[], 'optimized Today path no longer produces the false conflict');

update public.client_ai_state
set brief=jsonb_set(brief, '{placement}', to_jsonb('Правая икра'::text))
where client_id='d6400000-0000-4000-8000-000000000341';

select is(crm_private.client_fact_conflicts(
  'a1111111-1111-4111-8111-111111111111', 'd6400000-0000-4000-8000-000000000341'),
  array['fact_conflict_placement']::text[], 'canonical path retains genuine conflicts');
select is(crm_private.pulse_fact_conflicts(
  'a1111111-1111-4111-8111-111111111111', 'd6400000-0000-4000-8000-000000000341'),
  array['fact_conflict_placement']::text[], 'optimized Today path retains genuine conflicts');

select * from finish(true);
rollback;
