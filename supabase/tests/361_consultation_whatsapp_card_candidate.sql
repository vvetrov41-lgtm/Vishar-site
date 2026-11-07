-- Verify isolated candidate and original active template remain safe.
begin;
select no_plan();
select is((select count(*)::integer from crm_private.lifecycle_whatsapp_template_candidates
 where artist_id='a1111111-1111-4111-8111-111111111111'::uuid
 and purpose='consultation_reminder'
 and template_name='vishar_lifecycle_consultation_v2'
 and template_language='en_GB' and approval_status='UNKNOWN'
 and provider_template_id is null),1,
 'new consultation card needs real Meta approval');
select is((select template_name from crm_private.lifecycle_whatsapp_template_registry
 where artist_id='a1111111-1111-4111-8111-111111111111'::uuid
 and purpose='consultation_reminder'),
 'vishar_lifecycle_consultation_v1',
 'live consultation reminder unchanged until approved');
select is((select count(*)::integer from crm_private.lifecycle_whatsapp_template_candidates
 where artist_id='a2222222-2222-4222-8222-222222222222'::uuid
 and purpose='consultation_reminder'),0,
 'other artists not activated without Meta approval');
select ok(not has_table_privilege('anon',
 'crm_private.lifecycle_whatsapp_template_candidates','select')
 and not has_table_privilege('authenticated',
 'crm_private.lifecycle_whatsapp_template_candidates','select'),
 'candidate metadata is private');
select * from finish();
rollback;
