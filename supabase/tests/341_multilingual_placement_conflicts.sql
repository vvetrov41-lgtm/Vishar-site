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

-- Exact dimensions are comparable; a relative position is not a length.
select is(crm_private.fact_size_cm('Starts 2 inches below my elbow, about 8 inches in total'),
  20.32::numeric, 'prefer the explicit total to the starting offset');
select is(crm_private.fact_size_cm('Starts 2 inches below the elbow, overall length: 8 inches'),
  20.32::numeric, 'an overall length can also precede the measurement');
select is(crm_private.fact_size_cm('5 cm wide by 12 cm tall'), null::numeric,
  'two different dimensions without a total are ambiguous');
select is(crm_private.fact_size_cm('20 cm / about 7.87 inches'), null::numeric,
  'different equivalent-unit approximations are left to the artist');

update public.enquiries
set approximate_size = 'Starts 2 inches below my elbow, about 8 inches in total'
where id = 'd6500000-0000-4000-8000-000000000341';
update public.client_ai_state
set brief = brief || '{"placement":"forearm","size":"8 inches in total"}'::jsonb,
    source_watermark = crm_private.client_ai_watermark(artist_id, client_id)
where client_id = 'd6400000-0000-4000-8000-000000000341';
select is(crm_private.pulse_fact_conflicts(
  'a1111111-1111-4111-8111-111111111111', 'd6400000-0000-4000-8000-000000000341'),
  '{}'::text[], 'an active enquiry with the same total size stops generating the false conflict');

-- An open thread keeps the client in Today after an enquiry becomes terminal.
insert into public.communication_conversations (
  id, artist_id, channel, client_id, link_state, integration_key, external_contact_id
) values (
  'd6600000-0000-4000-8000-000000000341', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'd6400000-0000-4000-8000-000000000341',
  'linked', 'vladimir-production', '447700909341'
);
update public.client_ai_state
set brief = jsonb_set(brief, '{size}', '"4 inches"'::jsonb),
    source_watermark = crm_private.client_ai_watermark(artist_id, client_id)
where client_id = 'd6400000-0000-4000-8000-000000000341';

create temp view fixture_fact_conflicts_today as
select i->>'reason' as reason
from jsonb_array_elements(crm_private.pulse_items('a1111111-1111-4111-8111-111111111111', false, false)) i
where i->>'client_id' = 'd6400000-0000-4000-8000-000000000341'
  and i->>'reason' like 'fact_conflict_%';
select is((select reason from fixture_fact_conflicts_today), 'fact_conflict_size',
  'Today still shows a genuine size conflict on an active enquiry');

update public.enquiries set status = 'declined'
where id = 'd6500000-0000-4000-8000-000000000341';
update public.client_ai_state
set source_watermark = crm_private.client_ai_watermark(artist_id, client_id)
where client_id = 'd6400000-0000-4000-8000-000000000341';

select ok(exists (select 1 from crm_private.pulse_active_clients('a1111111-1111-4111-8111-111111111111')
  where client_id = 'd6400000-0000-4000-8000-000000000341'),
  'the open thread still puts the client in Today scope');
select is((select count(*) from fixture_fact_conflicts_today), 0::bigint,
  'declining the enquiry removes the conflict despite the open thread');
select is(crm_private.client_fact_conflicts(
  'a1111111-1111-4111-8111-111111111111', 'd6400000-0000-4000-8000-000000000341'),
  '{}'::text[], 'the client view agrees that the declined enquiry needs no conflict review');
select ok(crm_private.client_fact_sources(
  'a1111111-1111-4111-8111-111111111111', 'd6400000-0000-4000-8000-000000000341')
  @> '[{"source":"enquiry_form","key":"size","value":"Starts 2 inches below my elbow, about 8 inches in total"}]',
  'the original form text stays visible in provenance');

update public.enquiries set status = 'closed'
where id = 'd6500000-0000-4000-8000-000000000341';
update public.client_ai_state
set source_watermark = crm_private.client_ai_watermark(artist_id, client_id)
where client_id = 'd6400000-0000-4000-8000-000000000341';
select is((select count(*) from fixture_fact_conflicts_today), 0::bigint,
  'a closed enquiry also stays out of Today conflicts');

select * from finish(true);
rollback;
