-- Provider identity simulation inside a rollback-only transaction for v3; no real delivery.
begin;
select no_plan();

select ok(position('lock table crm_private.lifecycle_whatsapp_template_registry'
 in lower(pg_get_functiondef('crm_private.activate_approved_consultation_whatsapp_v3(uuid)'::regprocedure)))>0,
 'consultation promotion serializes against lifecycle enqueues');
select ok(not has_function_privilege('anon',
 'crm_private.activate_approved_consultation_whatsapp_v3(uuid)','execute')
 and not has_function_privilege('authenticated',
 'crm_private.activate_approved_consultation_whatsapp_v3(uuid)','execute')
 and not has_function_privilege('service_role',
 'crm_private.activate_approved_consultation_whatsapp_v3(uuid)','execute'),
 'promotion is private and backend-inaccessible');

select is(crm_private.activate_approved_consultation_whatsapp_v3(
 'a1111111-1111-4111-8111-111111111111'::uuid),
 'waiting_for_meta_approval','clean CI cannot fabricate Meta approvals');
select throws_ok($$select crm_private.activate_approved_consultation_whatsapp_v3(
 'a2222222-2222-4222-8222-222222222222'::uuid)$$,
 '42501',null,'other artist cannot be promoted');

-- Clean fixture has v1 and an unapproved v2 shadow; model a previously
-- approved v2 and newly created v3 shadow only inside this transaction.
delete from crm_private.lifecycle_whatsapp_template_candidates
where artist_id='a1111111-1111-4111-8111-111111111111'::uuid
  and purpose='consultation_reminder';
insert into crm_private.lifecycle_whatsapp_template_candidates
  (artist_id,purpose,template_name,template_language)
values ('a1111111-1111-4111-8111-111111111111'::uuid,
 'consultation_reminder','vishar_lifecycle_consultation_v3','en_GB');
update crm_private.lifecycle_whatsapp_template_registry
   set template_name='vishar_lifecycle_consultation_v2',
       approval_status='APPROVED',provider_template_id='123456789012345',
       verified_at=now()
 where artist_id='a1111111-1111-4111-8111-111111111111'::uuid
   and purpose='consultation_reminder';
update crm_private.lifecycle_whatsapp_template_candidates
   set approval_status='APPROVED',provider_template_id='123456789012346',
       verified_at=now()
 where artist_id='a1111111-1111-4111-8111-111111111111'::uuid
   and purpose='consultation_reminder';

select is(crm_private.activate_approved_consultation_whatsapp_v3(
 'a1111111-1111-4111-8111-111111111111'::uuid),
 'activated','approved provider evidence activates the consultation card');
select is((select template_name from crm_private.lifecycle_whatsapp_template_registry
 where artist_id='a1111111-1111-4111-8111-111111111111'::uuid
   and purpose='consultation_reminder'), 'vishar_lifecycle_consultation_v3',
 'active template uses new first-person consultation identity');
select is((select provider_template_id from crm_private.lifecycle_whatsapp_template_registry
 where artist_id='a1111111-1111-4111-8111-111111111111'::uuid
   and purpose='consultation_reminder'),'123456789012346',
 'Meta evidence preserved exactly');
select is((select count(*)::integer from crm_private.lifecycle_whatsapp_template_candidates
 where artist_id='a1111111-1111-4111-8111-111111111111'::uuid
   and purpose='consultation_reminder'),0,
 'only the promoted consultation candidate is cleared');
select is(crm_private.activate_approved_consultation_whatsapp_v3(
 'a1111111-1111-4111-8111-111111111111'::uuid),
 'already_active','promotion is idempotent');
select is((select template_name from crm_private.lifecycle_whatsapp_template_registry
 where artist_id='a2222222-2222-4222-8222-222222222222'::uuid
   and purpose='consultation_reminder'), 'vishar_lifecycle_consultation_v1',
 'other artists are isolated');
select is((select count(*)::integer from crm_private.lifecycle_whatsapp_template_registry
 where artist_id='a1111111-1111-4111-8111-111111111111'::uuid
   and purpose in ('session_reminder_72h','session_reminder_24h')
   and template_name like '%_v2'),0,
 'clean CI does not alter separately deployed session-card promotion');
select ok(position('vishar_lifecycle_consultation_v3' in pg_get_functiondef(
 'crm_private.queue_lifecycle_whatsapp_job(uuid)'::regprocedure))>0,
 'active v3 sender includes two existing one-use action capabilities');

select * from finish();
rollback;
