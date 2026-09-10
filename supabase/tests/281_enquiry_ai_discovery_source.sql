-- The AI validator must use the same discovery_source values as public.enquiries.
begin;
select plan(2);

create function pg_temp.ai_result(p_source text)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'fields', jsonb_build_object(
      'client_name',jsonb_build_object('value','Test Client','status','explicit'),
      'email',jsonb_build_object('value','test@example.test','status','explicit'),
      'phone',jsonb_build_object('value',null,'status','missing'),
      'project_description',jsonb_build_object('value','Tattoo enquiry','status','explicit'),
      'concept',jsonb_build_object('value','Tattoo concept','status','explicit'),
      'placement',jsonb_build_object('value','Arm','status','explicit'),
      'style',jsonb_build_object('value','realism','status','explicit'),
      'approximate_size',jsonb_build_object('value',null,'status','missing'),
      'colour',jsonb_build_object('value','black_and_grey','status','explicit'),
      'cover_up',jsonb_build_object('value',false,'status','explicit'),
      'budget',jsonb_build_object('value',null,'status','missing'),
      'preferred_dates',jsonb_build_object('value',null,'status','missing'),
      'reference_images_present',jsonb_build_object('value',true,'status','explicit'),
      'discovery_source',jsonb_build_object('value',p_source,'status','explicit'),
      'discovery_source_detail',jsonb_build_object('value',null,'status','missing'),
      'notes',jsonb_build_object('value',null,'status','missing')
    ),
    'summary','Tattoo enquiry.',
    'missing_information',jsonb_build_array('phone','approximate_size','budget','preferred_dates','discovery_source_detail','notes'),
    'draft_reply','Thanks for your enquiry. I will review the details and get back to you.'
  );
$$;

select is(
  crm_private.validate_enquiry_ai_result(pg_temp.ai_result('convention')),
  true,
  'canonical CRM discovery source is accepted by the AI result validator'
);

select is(
  crm_private.validate_enquiry_ai_result(pg_temp.ai_result('chatgpt')),
  false,
  'obsolete AI-only discovery source is rejected'
);

select * from finish();
rollback;
