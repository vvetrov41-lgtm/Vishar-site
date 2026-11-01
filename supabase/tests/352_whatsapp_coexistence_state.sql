-- Read-only Meta Coexistence evidence: backend-only, enum values only,
-- one row per artist with an enabled Meta route. Rolled back.
begin;
select no_plan();
create temporary table coexistence_artist as
select id from public.artists where slug='kristina';
grant select on coexistence_artist to public;

select ok(not has_function_privilege('anon',
 'public.service_record_whatsapp_coexistence_state(uuid,jsonb)','execute')
 and not has_function_privilege('authenticated',
 'public.service_record_whatsapp_coexistence_state(uuid,jsonb)','execute')
 and not has_function_privilege('authenticated',
 'public.service_claim_whatsapp_coexistence_targets(integer)','execute'),
 'clients cannot read or assert Coexistence evidence');

update public.artist_integrations set is_enabled=true
 where artist_id=(select id from coexistence_artist)
   and integration_type='whatsapp' and provider='meta_cloud_api';
insert into public.artist_integrations (
  artist_id, integration_type, provider, integration_key, external_account_label, is_enabled
)
select id, 'whatsapp', 'meta_cloud_api', 'kristina-production', 'Kristina WhatsApp', true
from coexistence_artist c
where not exists (select 1 from public.artist_integrations i
  where i.artist_id=c.id and i.integration_type='whatsapp' and i.provider='meta_cloud_api');

select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select ok((select count(*) from public.service_claim_whatsapp_coexistence_targets(4) t
 where t.artist_id=(select id from coexistence_artist))=1,
 'an enabled Meta route without evidence is probed');
select throws_ok($$select public.service_record_whatsapp_coexistence_state(
 (select id from coexistence_artist),'{"access_token":"x"}'::jsonb)$$,
 '22023',null,'unexpected fields such as tokens are refused');
select throws_ok($$select public.service_record_whatsapp_coexistence_state(
 (select id from coexistence_artist),'{"platform_type":"cloud api <b>"}'::jsonb)$$,
 '22023',null,'free text is refused');
select throws_ok($$select public.service_record_whatsapp_coexistence_state(
 (select id from coexistence_artist),'{"waba_read_error":"Unsupported get request"}'::jsonb)$$,
 '22023',null,'provider messages are refused');
select lives_ok($$select public.service_record_whatsapp_coexistence_state(
 (select id from coexistence_artist),
 '{"is_on_biz_app":true,"platform_type":"CLOUD_API","phone_status":"CONNECTED","waba_read_error":"100/33"}'::jsonb)$$,
 'backend records enum evidence');
select ok((select count(*) from public.service_claim_whatsapp_coexistence_targets(4) t
 where t.artist_id=(select id from coexistence_artist))=0,
 'fresh evidence is not probed again within the hour');
reset role;

select is((select platform_type from crm_private.whatsapp_coexistence_state
 where artist_id=(select id from coexistence_artist)),'CLOUD_API','platform type stored');
select is((select waba_read_error from crm_private.whatsapp_coexistence_state
 where artist_id=(select id from coexistence_artist)),'100/33','only the Graph code is stored');
select is((select enabled from crm_private.lifecycle_whatsapp_delivery_gates
 where artist_id=(select id from coexistence_artist)),false,
 'evidence never opens the lifecycle delivery gate');

select * from finish();
rollback;
