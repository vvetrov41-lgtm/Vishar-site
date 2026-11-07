-- Synthetic provider evidence in a rollback-only transaction. No actual
-- WhatsApp messages, test clients or production identifiers are generated.
begin;
select no_plan();

create temporary table reminder_v2_artists as
select id,slug from public.artists where slug in ('vladimir','kristina');
grant select on reminder_v2_artists to public;

select ok(not has_function_privilege('anon',
 'crm_private.activate_approved_whatsapp_reminder_v2(uuid)','execute')
 and not has_function_privilege('authenticated',
 'crm_private.activate_approved_whatsapp_reminder_v2(uuid)','execute')
 and not has_function_privilege('service_role',
 'crm_private.activate_approved_whatsapp_reminder_v2(uuid)','execute'),
 'promotion operation is not available through public or backend Data API');

select is(crm_private.activate_approved_whatsapp_reminder_v2(
 (select id from reminder_v2_artists where slug='vladimir')),
 'waiting_for_meta_approval',
 'clean fixture cannot activate an unapproved Meta template');

select throws_ok($$select crm_private.activate_approved_whatsapp_reminder_v2(
 (select id from reminder_v2_artists where slug='kristina'))$$,
 '42501',null,'cannot promote another artist');

-- Fake provider approvals exist only inside this transaction, which is
-- rolled back. The real production migration never manufactures approvals.
update crm_private.lifecycle_whatsapp_template_registry t
set approval_status='APPROVED',provider_template_id='123456789012345',
    verified_at=now()
where t.artist_id=(select id from reminder_v2_artists where slug='vladimir')
  and t.purpose in ('session_reminder_72h','session_reminder_24h');
update crm_private.lifecycle_whatsapp_template_candidates c
set approval_status='APPROVED',provider_template_id='123456789012346',
    verified_at=now(),last_failure_code=null
where c.artist_id=(select id from reminder_v2_artists where slug='vladimir')
  and c.purpose in ('session_reminder_72h','session_reminder_24h');

select is(crm_private.activate_approved_whatsapp_reminder_v2(
 (select id from reminder_v2_artists where slug='vladimir')),
 'activated','approved provider candidates become the live reminder identities');
select is((select count(*)::integer from
 crm_private.lifecycle_whatsapp_template_registry t
 where t.artist_id=(select id from reminder_v2_artists where slug='vladimir')
 and ((t.purpose='session_reminder_72h'
   and t.template_name='vishar_lifecycle_reminder_72h_v2')
   or (t.purpose='session_reminder_24h'
   and t.template_name='vishar_lifecycle_reminder_24h_v2'))
 and t.approval_status='APPROVED'
 and t.provider_template_id='123456789012346'),2,
 'both new templates preserve verified provider evidence');
select is((select count(*)::integer
 from crm_private.lifecycle_whatsapp_template_candidates c
 where c.artist_id=(select id from reminder_v2_artists where slug='vladimir')),0,
 'candidate shadow identities are cleared after activation');
select is(crm_private.activate_approved_whatsapp_reminder_v2(
 (select id from reminder_v2_artists where slug='vladimir')),
 'already_active','a repeated activation is idempotent');

select is((select count(*)::integer from
 crm_private.lifecycle_whatsapp_template_registry t
 where t.artist_id=(select id from reminder_v2_artists where slug='kristina')
 and t.purpose in ('session_reminder_72h','session_reminder_24h')
 and t.template_name like '%_v1'),2,
 'Kristina keeps her original WhatsApp reminders');
select is((select count(*)::integer from
 crm_private.lifecycle_whatsapp_template_registry t
 where t.artist_id=(select id from reminder_v2_artists where slug='vladimir')
 and t.purpose in ('consultation_reminder','post_session_aftercare',
                   'post_session_checkin')
 and t.template_name like '%_v1'),3,
 'consultations, aftercare and check-in are unaffected');

select * from finish();
rollback;
