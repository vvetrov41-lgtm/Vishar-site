-- Provider review and explicit API error backoff are independent.
-- All artist route and status changes are synthetic and rolled back.
begin;
select no_plan();

create temporary table pending_meta_artist as
select id from public.artists where slug='vladimir';
grant select on pending_meta_artist to public;
insert into public.artist_integrations (
 artist_id,integration_type,provider,integration_key,external_account_label,is_enabled
)
select id,'whatsapp','meta_cloud_api','vladimir-production',
  'Synthetic review polling route',true
from pending_meta_artist a
where not exists (
 select 1 from public.artist_integrations i
 where i.artist_id=a.id and i.integration_type='whatsapp'
 and i.provider='meta_cloud_api' and i.integration_key='vladimir-production'
);

update crm_private.lifecycle_whatsapp_template_registry
 set approval_status='PENDING', provider_template_id=null,
     verified_at=now()-interval '16 minutes'
 where artist_id=(select id from pending_meta_artist)
   and purpose='post_session_aftercare';

select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select is((select count(*)::integer
 from public.service_claim_lifecycle_whatsapp_template_targets(20) t
 where t.artist_id=(select id from pending_meta_artist)
   and t.purpose='post_session_aftercare'),1,
 'PENDING template is polled again after 15 minutes');
reset role;

update crm_private.lifecycle_whatsapp_template_registry
 set verified_at=now()-interval '5 minutes'
 where artist_id=(select id from pending_meta_artist)
   and purpose='post_session_aftercare';

set local role service_role;
select is((select count(*)::integer
 from public.service_claim_lifecycle_whatsapp_template_targets(20) t
 where t.artist_id=(select id from pending_meta_artist)
   and t.purpose='post_session_aftercare'),0,
 'recent PENDING Meta review does not trigger another API request');
reset role;

update crm_private.lifecycle_whatsapp_template_registry
 set approval_status='APPROVED',provider_template_id='123456789012345',
     verified_at=now()-interval '20 minutes'
 where artist_id=(select id from pending_meta_artist)
   and purpose='post_session_aftercare';

set local role service_role;
select is((select count(*)::integer
 from public.service_claim_lifecycle_whatsapp_template_targets(20) t
 where t.artist_id=(select id from pending_meta_artist)
   and t.purpose='post_session_aftercare'),0,
 'APPROVED template retains the 24-hour polling cadence');
reset role;

update crm_private.lifecycle_whatsapp_template_registry
 set verified_at=now()-interval '25 hours'
 where artist_id=(select id from pending_meta_artist)
   and purpose='post_session_aftercare';

set local role service_role;
select is((select count(*)::integer
 from public.service_claim_lifecycle_whatsapp_template_targets(20) t
 where t.artist_id=(select id from pending_meta_artist)
   and t.purpose='post_session_aftercare'),1,
 'stale APPROVED status is checked again after 24 hours');
reset role;

update crm_private.lifecycle_whatsapp_template_registry
 set approval_status='PENDING',provider_template_id=null,
     verified_at=now()-interval '20 minutes'
 where artist_id=(select id from pending_meta_artist)
   and purpose='post_session_aftercare';
update crm_private.lifecycle_whatsapp_template_registry
 set next_retry_at=now()+interval '60 minutes',
     last_failure_code='whatsapp_template_rate_limited'
 where artist_id=(select id from pending_meta_artist)
   and purpose='post_session_aftercare';

set local role service_role;
select is((select count(*)::integer
 from public.service_claim_lifecycle_whatsapp_template_targets(20) t
 where t.artist_id=(select id from pending_meta_artist)
   and t.purpose='post_session_aftercare'),0,
 'provider error backoff overrides the 15-minute PENDING poll');
reset role;

select * from finish();
rollback;
