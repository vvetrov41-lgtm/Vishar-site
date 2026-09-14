-- Regression coverage for qualified reference requests when generic structured
-- missing-information names are also present.
begin;
select no_plan();

select ok(
  not crm_private.client_ai_action_requests_attached_references(
    'A clearer reference image of the face would help.',
    'Could you upload one additional reference image showing the face straight on?',
    '["reference_images"]'::jsonb
  ),
  'an explicitly additional/specific reference request is preserved even with generic structured missing_information');

select ok(
  crm_private.client_ai_action_requests_attached_references(
    'References are still needed.',
    'Could you upload your reference images?',
    '["reference_images"]'::jsonb
  ),
  'a generic request for references already attached remains suppressible');

select * from finish();
rollback;
