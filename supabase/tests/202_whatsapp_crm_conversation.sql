-- 202_whatsapp_crm_conversation.sql
-- Migration 0051: CRM may open WhatsApp only from a durable enquiry.

begin;
select no_plan();

select has_function('public', 'ensure_whatsapp_conversation_for_enquiry', array['uuid'],
                    'safe enquiry-to-WhatsApp conversation RPC exists');
select ok(not has_function_privilege('anon', 'public.ensure_whatsapp_conversation_for_enquiry(uuid)', 'EXECUTE'),
          'anon cannot open a WhatsApp conversation');
select ok(has_function_privilege('authenticated', 'public.ensure_whatsapp_conversation_for_enquiry(uuid)', 'EXECUTE'),
          'authenticated CRM may call the conversation opener');
select ok(not has_function_privilege('service_role', 'public.ensure_whatsapp_conversation_for_enquiry(uuid)', 'EXECUTE'),
          'public Worker backend cannot impersonate a CRM conversation opener');
select ok((select prosecdef from pg_proc where oid='public.ensure_whatsapp_conversation_for_enquiry(uuid)'::regprocedure),
          'conversation opener is SECURITY DEFINER');
select ok((select 'search_path=pg_catalog, public, crm_private'=any(proconfig)
           from pg_proc where oid='public.ensure_whatsapp_conversation_for_enquiry(uuid)'::regprocedure),
          'conversation opener has fixed search_path');

insert into public.artist_integrations
  (id, artist_id, integration_type, provider, integration_key, configuration, is_enabled)
values
  ('db111111-1111-4111-8111-111111111111','a1111111-1111-4111-8111-111111111111','whatsapp','meta_cloud_api','vladimir-crm','{}',true),
  ('db222222-2222-4222-8222-222222222222','a2222222-2222-4222-8222-222222222222','whatsapp','meta_cloud_api','kristina-crm','{}',true);

insert into public.clients (id,full_name,email,phone) values
 ('cb111111-1111-4111-8111-111111111111','WA CRM Vladimir','wa.crm.v@example.test','+44 7700 900111'),
 ('cb222222-2222-4222-8222-222222222222','WA CRM Kristina','wa.crm.k@example.test','+44 7700 900222'),
 ('cb333333-3333-4333-8333-333333333333','WA Local Phone','wa.crm.local@example.test','07700 900333'),
 ('cb444444-4444-4444-8444-444444444444','WA Collision','wa.crm.collision@example.test','+44 7700 900111'),
 ('cb555555-5555-4555-8555-555555555555','WA Ambiguous Local','wa.crm.ambiguous@example.test','020 7946 0958');

insert into public.enquiries
 (id,client_id,idempotency_key,intake_fingerprint,intake_state,submitted_full_name,submitted_email,submitted_phone,
  submitted_preferred_contact,privacy_notice_version,privacy_acknowledged_at,artist_id)
values
 ('eb111111-1111-4111-8111-111111111111','cb111111-1111-4111-8111-111111111111','7b111111-1111-4111-8111-111111111111',repeat('a',64),'complete','WA CRM Vladimir','wa.crm.v@example.test','+44 7700 900111','WhatsApp','2026-07-29',now(),'a1111111-1111-4111-8111-111111111111'),
 ('eb222222-2222-4222-8222-222222222222','cb222222-2222-4222-8222-222222222222','7b222222-2222-4222-8222-222222222222',repeat('b',64),'complete','WA CRM Kristina','wa.crm.k@example.test','+44 7700 900222','WhatsApp','2026-07-29',now(),'a2222222-2222-4222-8222-222222222222'),
 ('eb333333-3333-4333-8333-333333333333','cb333333-3333-4333-8333-333333333333','7b333333-3333-4333-8333-333333333333',repeat('c',64),'complete','WA Local Phone','wa.crm.local@example.test','07700 900333','WhatsApp','2026-07-29',now(),'a1111111-1111-4111-8111-111111111111'),
 ('eb444444-4444-4444-8444-444444444444','cb444444-4444-4444-8444-444444444444','7b444444-4444-4444-8444-444444444444',repeat('d',64),'complete','WA Collision','wa.crm.collision@example.test','+44 7700 900111','WhatsApp','2026-07-29',now(),'a1111111-1111-4111-8111-111111111111'),
 ('eb555555-5555-4555-8555-555555555555','cb555555-5555-4555-8555-555555555555','7b555555-5555-4555-8555-555555555555',repeat('e',64),'complete','WA Ambiguous Local','wa.crm.ambiguous@example.test','020 7946 0958','WhatsApp','2026-07-29',now(),'a1111111-1111-4111-8111-111111111111');

insert into auth.users(id,email) values
 ('6b111111-1111-4111-8111-111111111111','wa.crm.owner@example.test'),
 ('6b222222-2222-4222-8222-222222222222','wa.crm.manager@example.test'),
 ('6b333333-3333-4333-8333-333333333333','wa.crm.reader@example.test');
insert into public.profiles(id,email,role,is_active) values
 ('6b111111-1111-4111-8111-111111111111','wa.crm.owner@example.test','owner',true),
 ('6b222222-2222-4222-8222-222222222222','wa.crm.manager@example.test','booking_manager',true),
 ('6b333333-3333-4333-8333-333333333333','wa.crm.reader@example.test','read_only',true);
insert into public.artist_memberships(profile_id,artist_id,access_level,can_manage_sessions,can_manage_integrations,is_active)
values
 ('6b222222-2222-4222-8222-222222222222','a1111111-1111-4111-8111-111111111111','manager',true,true,true),
 ('6b333333-3333-4333-8333-333333333333','a1111111-1111-4111-8111-111111111111','read_only',false,false,true);

create function pg_temp.wa_claims(p text) returns void language sql as $$select set_config('request.jwt.claims',p,true)::void$$;
grant execute on function pg_temp.wa_claims(text) to authenticated;

set local role authenticated;
select pg_temp.wa_claims('{"sub":"6b222222-2222-4222-8222-222222222222","role":"authenticated"}');
select is((public.ensure_whatsapp_conversation_for_enquiry('eb111111-1111-4111-8111-111111111111')->>'contact_wa_id'),
          '447700900111','manager gets server-normalised destination from the client record');
select is((public.ensure_whatsapp_conversation_for_enquiry('eb111111-1111-4111-8111-111111111111')->>'created')::boolean,
          false,'opening the same enquiry is idempotent');
select throws_ok($$select public.ensure_whatsapp_conversation_for_enquiry('eb222222-2222-4222-8222-222222222222')$$,
                 '42501','artist access is not permitted','Vladimir manager cannot open Kristina WhatsApp');
select is((public.ensure_whatsapp_conversation_for_enquiry('eb333333-3333-4333-8333-333333333333')->>'contact_wa_id'),
          '447700900333','UK local mobile is safely normalised before opening WhatsApp');
select throws_ok($$select public.ensure_whatsapp_conversation_for_enquiry('eb555555-5555-4555-8555-555555555555')$$,
                 '22023',null,'ambiguous local phone still fails closed instead of guessing a country');
select throws_ok($$select public.ensure_whatsapp_conversation_for_enquiry('eb444444-4444-4444-8444-444444444444')$$,
                 '23514',null,'one artist phone cannot silently attach to a second client');
reset role;

set local role authenticated;
select pg_temp.wa_claims('{"sub":"6b333333-3333-4333-8333-333333333333","role":"authenticated"}');
select throws_ok($$select public.ensure_whatsapp_conversation_for_enquiry('eb111111-1111-4111-8111-111111111111')$$,
                 '42501',null,'read-only cannot create or mutate WhatsApp conversations');
reset role;

set local role authenticated;
select pg_temp.wa_claims('{"sub":"6b111111-1111-4111-8111-111111111111","role":"authenticated"}');
select is((public.ensure_whatsapp_conversation_for_enquiry('eb222222-2222-4222-8222-222222222222')->>'integration_key'),
          'kristina-crm','owner opens Kristina conversation using Kristina integration only');
reset role;

select * from finish();
rollback;
