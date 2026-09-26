-- 301_client_fact_provenance.sql
--
-- Phase 6b: stated facts carry their source, and a decidable contradiction
-- between the enquiry form and a current AI brief becomes an attention
-- conflict. Nothing is overwritten. Everything is rolled back.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Pure helpers.
select is(crm_private.fact_placement_terms('Left outer forearm'), array['forearm'],
  'side and position words are not body areas');
select ok(crm_private.fact_placement_terms('Inner forearm') && crm_private.fact_placement_terms('left forearm, near the wrist'),
  'two descriptions of the same area share a term');
select is(crm_private.fact_placement_terms('not sure yet'), '{}'::text[],
  'an undecided placement names no area');
select is(crm_private.fact_size_cm('About 15 cm tall'), 15::numeric, 'centimetres');
select is(crm_private.fact_size_cm('roughly 6 inches'), 6 * 2.54, 'inches convert');
select is(crm_private.fact_size_cm('palm sized'), null::numeric, 'no measurement, no number');

insert into public.clients (id, workspace_id, full_name, email) values
  ('d6400000-0000-4000-8000-000000000001',
   (select workspace_id from public.artists where id = 'a1111111-1111-4111-8111-111111111111'),
   'Provenance Client', 'provenance@example.test');
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at,
  placement, approximate_size
) values (
  'd6500000-0000-4000-8000-000000000001', 'd6400000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-9961', 'd6510000-0000-4000-8000-000000000001',
  repeat('e', 64), 'reviewing', 'complete', 'Provenance Client', 'provenance@example.test', '2026-08-05', now(),
  'Left outer forearm', 'About 15 cm');

-- A current brief that agrees with the form.
insert into public.client_ai_state (
  artist_id, workspace_id, client_id, summary, brief, missing_information, source_watermark, provider, model
)
select 'a1111111-1111-4111-8111-111111111111', a.workspace_id, 'd6400000-0000-4000-8000-000000000001',
  'Synthetic summary.',
  jsonb_build_object(
    'project_summary', 'Synthetic.', 'stage', 'awaiting_artist_review', 'placement', 'Inner forearm',
    'style', null, 'colour', null, 'size', '16cm', 'cover_up_context', null,
    'constraints', jsonb_build_array(), 'decisions_made', jsonb_build_array(),
    'open_questions', jsonb_build_array(), 'promises_to_client', jsonb_build_array(),
    'waiting_on', 'artist', 'last_interaction', 'Synthetic.',
    'discussed', jsonb_build_object(
      'session_estimate', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'price', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'deposit', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'candidate_dates', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'confirmed_dates', jsonb_build_object('value', null, 'status', 'not_discussed'))),
  '[]'::jsonb,
  crm_private.client_ai_watermark('a1111111-1111-4111-8111-111111111111', 'd6400000-0000-4000-8000-000000000001'),
  'workers_ai', '@cf/meta/llama-3.1-8b-instruct-fast'
from public.artists a where a.id = 'a1111111-1111-4111-8111-111111111111';

select is(jsonb_array_length(crm_private.client_fact_sources(
  'a1111111-1111-4111-8111-111111111111', 'd6400000-0000-4000-8000-000000000001')), 4,
  'placement and size from the form and from the brief, each with its source');
select ok(crm_private.client_fact_sources(
  'a1111111-1111-4111-8111-111111111111', 'd6400000-0000-4000-8000-000000000001')
  @> jsonb_build_array(jsonb_build_object('key', 'placement', 'source', 'enquiry_form', 'stated_by', 'client',
       'reference', (select reference_number from public.enquiries where id = 'd6500000-0000-4000-8000-000000000001'))),
  'the form value names the enquiry it came from');
select ok(crm_private.client_fact_sources(
  'a1111111-1111-4111-8111-111111111111', 'd6400000-0000-4000-8000-000000000001')
  @> '[{"key":"size","source":"ai_brief","stated_by":"model","current":true}]'::jsonb,
  'the brief value names the model and whether the brief is current');
select is(crm_private.client_fact_conflicts(
  'a1111111-1111-4111-8111-111111111111', 'd6400000-0000-4000-8000-000000000001'), '{}'::text[],
  'agreeing sources raise nothing');

-- The brief now says something else: raised, and nothing is overwritten.
update public.client_ai_state
set brief = brief || jsonb_build_object('placement', 'Right calf', 'size', '40 cm')
where client_id = 'd6400000-0000-4000-8000-000000000001';
select is(crm_private.client_fact_conflicts(
  'a1111111-1111-4111-8111-111111111111', 'd6400000-0000-4000-8000-000000000001'),
  array['fact_conflict_placement', 'fact_conflict_size'],
  'a different body area and a much larger size are both raised');
select ok('fact_conflict_placement' = any(crm_private.attention_conflicts(
  'a1111111-1111-4111-8111-111111111111', 'd6400000-0000-4000-8000-000000000001')),
  'the contradiction reaches attention like any other conflict');
select is((select placement from public.enquiries where id = 'd6500000-0000-4000-8000-000000000001'),
  'Left outer forearm', 'the form value is untouched');

-- A stale brief is not evidence: it is already flagged as stale instead.
update public.clients set full_name = 'Provenance Client Renamed'
where id = 'd6400000-0000-4000-8000-000000000001';
select is(crm_private.client_fact_conflicts(
  'a1111111-1111-4111-8111-111111111111', 'd6400000-0000-4000-8000-000000000001'), '{}'::text[],
  'a stale brief raises no fact conflict');
select ok('ai_brief_stale' = any(crm_private.attention_conflicts(
  'a1111111-1111-4111-8111-111111111111', 'd6400000-0000-4000-8000-000000000001')),
  'the stale brief is reported as stale');

-- Access.
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}', true);
select throws_ok($$select crm_private.client_fact_sources('a1111111-1111-4111-8111-111111111111', 'd6400000-0000-4000-8000-000000000001')$$,
  '42501', null, 'the private helper is not callable from the API');
reset role;
select ok(not has_function_privilege('anon', 'public.get_client_fact_provenance(uuid,uuid)', 'execute'),
  'anon cannot read provenance');
select ok(not has_function_privilege('service_role', 'public.get_client_fact_provenance(uuid,uuid)', 'execute'),
  'the CRM read is for signed-in operators only');

select * from finish(true);
rollback;
