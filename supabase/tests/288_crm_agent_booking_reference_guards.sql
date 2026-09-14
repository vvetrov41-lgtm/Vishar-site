-- Regression coverage for CRM AI booking/reference source-of-truth guards.
begin;
select no_plan();

select ok(
  position('''has_scheduled_appointment''' in lower(pg_get_functiondef(
    'crm_private.client_ai_context(uuid,uuid)'::regprocedure))) > 0,
  'client AI context exposes authoritative scheduled-appointment state');
select ok(
  position('''references_attached''' in lower(pg_get_functiondef(
    'crm_private.client_ai_context(uuid,uuid)'::regprocedure))) > 0
  and position('''reference_file_count''' in lower(pg_get_functiondef(
    'crm_private.client_ai_context(uuid,uuid)'::regprocedure))) > 0,
  'client AI context exposes raw reference-file existence and count');
select ok(
  position('''appointment_type'', s.appointment_type' in lower(pg_get_functiondef(
    'crm_private.client_ai_context(uuid,uuid)'::regprocedure))) > 0,
  'client AI context tells the model whether the booking is a consultation or tattoo session');

select ok(
  position('''reference_files''' in lower(pg_get_functiondef(
    'crm_private.client_ai_watermark(uuid,uuid)'::regprocedure))) > 0
  and position('public.enquiry_files' in lower(pg_get_functiondef(
    'crm_private.client_ai_watermark(uuid,uuid)'::regprocedure))) > 0,
  'raw ready files participate in the client-state watermark');
select ok(
  position('''appointment_type'', s.appointment_type' in lower(pg_get_functiondef(
    'crm_private.client_ai_watermark(uuid,uuid)'::regprocedure))) > 0,
  'appointment type participates in the client-state watermark');
select ok(
  position('coalesce(s.appointment_type::text' in lower(pg_get_functiondef(
    'crm_private.session_ai_fingerprint(public.sessions)'::regprocedure))) > 0,
  'session refresh fingerprint includes appointment type');

select ok(
  position('update of status, appointment_type, start_at' in lower(pg_get_triggerdef((
    select oid from pg_trigger
    where tgrelid = 'public.sessions'::regclass
      and tgname = 'sessions_enqueue_client_ai'
      and not tgisinternal
  )))) > 0,
  'session AI refresh trigger fires when appointment type changes');
select ok(
  position('update public.client_ai_next_actions' in lower(pg_get_functiondef(
    'crm_private.enqueue_session_client_ai()'::regprocedure))) > 0
  and position('a.action_type = ''request_information''' in lower(pg_get_functiondef(
    'crm_private.enqueue_session_client_ai()'::regprocedure))) > 0
  and position('a.status = ''open''' in lower(pg_get_functiondef(
    'crm_private.enqueue_session_client_ai()'::regprocedure))) > 0,
  'creating/updating an active booking supersedes stale intake requests before notification delivery');

select ok(
  position('schedule_reference_image_analysis' in lower(pg_get_functiondef(
    'crm_private.enqueue_enquiry_file_client_ai()'::regprocedure))) > 0
  and position('schedule_client_ai_refresh' in lower(pg_get_functiondef(
    'crm_private.enqueue_enquiry_file_client_ai()'::regprocedure))) > 0,
  'ready files independently queue vision analysis and client-state refresh');
select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.enquiry_files'::regclass
      and tgname = 'enquiry_files_delete_client_ai'
      and not tgisinternal
  ),
  'removing a file also invalidates client AI state');

select ok(
  crm_private.client_ai_action_requests_attached_references(
    'Need reference images before proceeding.',
    'Please upload your reference photos.',
    '[]'::jsonb
  ),
  'generic request to upload already-attached references is detected');
select ok(
  crm_private.client_ai_action_requests_attached_references(
    'Need one missing item.',
    null,
    '["reference_images"]'::jsonb
  ),
  'reference request in missing_information is detected');
select ok(
  not crm_private.client_ai_action_requests_attached_references(
    'A close detail is still unclear.',
    'Could you send one additional reference showing the exact wing position?',
    '[]'::jsonb
  ),
  'an explicitly additional/specific reference remains allowed');

select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.client_ai_next_actions'::regclass
      and tgname = 'client_ai_next_actions_truth_guard'
      and not tgisinternal
  ),
  'next actions have a final database truth guard');
select ok(
  position('client_has_scheduled_appointment' in lower(pg_get_functiondef(
    'crm_private.guard_client_ai_next_action_truth()'::regprocedure))) > 0
  and position('client_has_reference_files' in lower(pg_get_functiondef(
    'crm_private.guard_client_ai_next_action_truth()'::regprocedure))) > 0,
  'final action guard checks both booking and reference facts');

select ok(
  not has_function_privilege('anon', 'crm_private.guard_client_ai_next_action_truth()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'crm_private.guard_client_ai_next_action_truth()', 'EXECUTE')
  and not has_function_privilege('service_role', 'crm_private.guard_client_ai_next_action_truth()', 'EXECUTE'),
  'truth guard helper is not callable through API roles');
select ok(
  not has_function_privilege('anon', 'crm_private.client_has_scheduled_appointment(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'crm_private.client_has_scheduled_appointment(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'crm_private.client_has_scheduled_appointment(uuid,uuid)', 'EXECUTE'),
  'booking fact helper is private');
select ok(
  not has_function_privilege('anon', 'crm_private.client_has_reference_files(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'crm_private.client_has_reference_files(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'crm_private.client_has_reference_files(uuid,uuid)', 'EXECUTE'),
  'reference fact helper is private');

select * from finish();
rollback;
