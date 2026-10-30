-- Meta Utility template approval must be verified per artist and purpose.
-- Synthetic provider IDs exist only in this transaction, which is rolled back.
begin;
select no_plan();
create temporary table lifecycle_registry_artists as
select id,slug from public.artists where slug in ('vladimir','kristina');
grant select on lifecycle_registry_artists to public;
select is((select count(*)::integer from crm_private.lifecycle_whatsapp_template_registry
 where artist_id in (select id from lifecycle_registry_artists)),8,
 'both artists have four lifecycle template definitions');
select is((select count(*)::integer from crm_private.lifecycle_whatsapp_template_registry
 where approval_status='APPROVED'),0,
 'no template is assumed approved just because WhatsApp is connected');
select is((select count(*)::integer from crm_private.lifecycle_whatsapp_template_registry
 where provider_template_id is not null),0,
 'no fabricated provider approval identifiers are populated');
select ok(not has_function_privilege('anon',
 'public.service_record_lifecycle_whatsapp_template_status(uuid,text,text,text,text,text)','execute')
 and not has_function_privilege('authenticated',
 'public.service_record_lifecycle_whatsapp_template_status(uuid,text,text,text,text,text)','execute'),
 'customers cannot assert Meta approval');

select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select throws_ok($$select public.service_record_lifecycle_whatsapp_template_status(
 (select id from lifecycle_registry_artists where slug='vladimir'),
 'post_session_checkin','vishar_lifecycle_checkin_v1',
 'en_GB','APPROVED',null)$$,
 '22023',null,'approved requires provider identity');
select throws_ok($$select public.service_record_lifecycle_whatsapp_template_status(
 (select id from lifecycle_registry_artists where slug='vladimir'),
 'post_session_checkin','vishar_lifecycle_checkin_v1',
 'en_GB','APPROVED','invalid_provider_id')$$,
 '22023',null,'invalid provider id is rejected');
select throws_ok($$select public.service_record_lifecycle_whatsapp_template_status(
 (select id from lifecycle_registry_artists where slug='vladimir'),
 'post_session_checkin','wrong_template_name',
 'en_GB','APPROVED','1234567890')$$,
 '22023',null,'wrong template identity is rejected');
select lives_ok($$select public.service_record_lifecycle_whatsapp_template_status(
 (select id from lifecycle_registry_artists where slug='vladimir'),
 'post_session_checkin','vishar_lifecycle_checkin_v1',
 'en_GB','APPROVED','1234567890')$$,
 'backend may record a checked Meta provider identity');
reset role;
select is((select approval_status from crm_private.lifecycle_whatsapp_template_registry
 where artist_id=(select id from lifecycle_registry_artists where slug='vladimir')
 and purpose='post_session_checkin'),'APPROVED','one verified artist template is updated');
select is((select approval_status from crm_private.lifecycle_whatsapp_template_registry
 where artist_id=(select id from lifecycle_registry_artists where slug='kristina')
 and purpose='post_session_checkin'),'UNKNOWN',
 'Vladimir provider evidence never approves Kristina template');
select is((select count(*)::integer from crm_private.lifecycle_whatsapp_template_registry
 where artist_id=(select id from lifecycle_registry_artists where slug='vladimir')
 and approval_status='APPROVED'),1,
 'only the one recorded purpose is approved');

-- Template status and delivery activation are independent state.
select is((select count(*)::integer from crm_private.lifecycle_whatsapp_delivery_gates
 where artist_id in (select id from lifecycle_registry_artists) and not enabled),2,
 'both artists start with WhatsApp lifecycle delivery disabled');
select ok(not has_function_privilege('authenticated',
 'public.service_set_lifecycle_whatsapp_delivery_enabled(uuid,boolean)','execute')
 and not has_function_privilege('anon',
 'public.service_set_lifecycle_whatsapp_delivery_enabled(uuid,boolean)','execute'),
 'clients cannot open the lifecycle WhatsApp delivery gate');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select throws_ok($$select public.service_set_lifecycle_whatsapp_delivery_enabled(
 (select id from lifecycle_registry_artists where slug='vladimir'),true)$$,
 '23514',null,'one approved template is insufficient to activate delivery');
reset role;
select is((select enabled from crm_private.lifecycle_whatsapp_delivery_gates
 where artist_id=(select id from lifecycle_registry_artists where slug='vladimir')),
 false,'failed activation cannot turn on Vladimir');

-- A Meta API policy denial is stored only as a safe error class; the
-- failed target is not claimed again by the next five-minute scheduler.
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select lives_ok($$select public.service_record_lifecycle_whatsapp_template_failure(
 (select id from lifecycle_registry_artists where slug='kristina'),
 'session_reminder_72h','vishar_lifecycle_reminder_72h_v1',
 'en_GB','whatsapp_template_api_unavailable_for_account')$$,
 'Meta account restriction is deferred safely');
reset role;
select ok((select next_retry_at>now()+interval '5 hours'
 from crm_private.lifecycle_whatsapp_template_registry t
 where t.artist_id=(select id from lifecycle_registry_artists where slug='kristina')
 and t.purpose='session_reminder_72h'),
 'API restriction backs off for six hours');
select is((select last_failure_code from crm_private.lifecycle_whatsapp_template_registry t
 where t.artist_id=(select id from lifecycle_registry_artists where slug='kristina')
 and t.purpose='session_reminder_72h'),
 'whatsapp_template_api_unavailable_for_account',
 'only the sanitized failure category is persisted');

select * from finish();
rollback;
