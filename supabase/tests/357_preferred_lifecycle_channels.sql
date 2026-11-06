-- Routing regression: no real messaging or provider invocation.
begin;
select no_plan();

insert into public.clients(id,full_name,email,preferred_contact)
values ('ec101111-1111-4111-8111-111111111111',
        'Lifecycle Channel Fixture','lifecycle-channel@example.test','WhatsApp');

select is(crm_private.lifecycle_selected_channel(
  'ec101111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111'),'whatsapp',
  'explicit WhatsApp preference wins over email availability');

update public.clients set preferred_contact='Email'
where id='ec101111-1111-4111-8111-111111111111';
select is(crm_private.lifecycle_selected_channel(
  'ec101111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111'),'email',
  'explicit Email preference wins over inferred channel');

update public.clients set preferred_contact='Instagram'
where id='ec101111-1111-4111-8111-111111111111';
select is(crm_private.lifecycle_selected_channel(
  'ec101111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111'),'instagram',
  'Instagram preference is preserved rather than silently using email');

update public.clients set preferred_contact=null
where id='ec101111-1111-4111-8111-111111111111';
select is(crm_private.lifecycle_selected_channel(
  'ec101111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111'),'email',
  'unknown preference with no conversation defaults to available email');

select ok(not has_function_privilege('anon',
 'crm_private.lifecycle_selected_channel(uuid,uuid)','execute')
 and not has_function_privilege('authenticated',
 'crm_private.lifecycle_selected_channel(uuid,uuid)','execute'),
 'channel choice is not a public data-leaking function');

select ok((select count(*)=2
 from crm_private.lifecycle_whatsapp_template_registry
 where purpose='consultation_reminder' and approval_status='UNKNOWN'
   and provider_template_id is null),
 'consultation WhatsApp starts with no fabricated Meta approval');

select ok(pg_get_functiondef(
 'crm_private.execute_client_lifecycle_job(uuid)'::regprocedure)
 like '%crm_private.lifecycle_selected_channel%',
 'executor uses explicit channel preference');

select ok(pg_get_functiondef(
 'public.service_resolve_whatsapp_lifecycle_payload(uuid,text)'::regprocedure)
 like '%crm_private.lifecycle_selected_channel%'
 and pg_get_functiondef(
 'public.service_resolve_whatsapp_lifecycle_payload(uuid,text)'::regprocedure)
 like '%consultation_reminder%',
 'WhatsApp pre-send validator enforces preference and consultation type');

select ok(pg_get_functiondef(
 'crm_private.lifecycle_delivery_snapshot_current(uuid)'::regprocedure)
 like '%crm_private.lifecycle_selected_channel%',
 'email pre-send snapshot rejects stale channel after preference change');

select * from finish();
rollback;
