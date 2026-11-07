-- Provider preapproval is metadata-only, in a rollback-only fixture.
-- It must never switch the active v1 send registry or emit real messages.
begin;
select no_plan();

create temporary table reminder_candidate_artists as
select id,slug from public.artists where slug in ('vladimir','kristina');
grant select on reminder_candidate_artists to public;

select is((select count(*)::integer
 from crm_private.lifecycle_whatsapp_template_candidates
 where artist_id=(select id from reminder_candidate_artists where slug='vladimir')),2,
 'only Vladimir has two pending reminder card candidates');
select is((select count(*)::integer
 from crm_private.lifecycle_whatsapp_template_candidates
 where artist_id=(select id from reminder_candidate_artists where slug='kristina')),0,
 'Kristina has no inadvertent v2 candidate');
select is((select count(*)::integer
 from crm_private.lifecycle_whatsapp_template_candidates
 where approval_status='UNKNOWN' and provider_template_id is null),2,
 'candidate approvals are not fabricated');
select is((select count(*)::integer
 from crm_private.lifecycle_whatsapp_template_registry
 where artist_id=(select id from reminder_candidate_artists where slug='vladimir')
 and purpose in ('session_reminder_72h','session_reminder_24h')
 and template_name like '%_v1'),2,
 'both active v1 send identities remain unchanged');
select ok(not has_table_privilege('authenticated',
 'crm_private.lifecycle_whatsapp_template_candidates','select')
 and not has_table_privilege('anon',
 'crm_private.lifecycle_whatsapp_template_candidates','select')
 and not has_table_privilege('service_role',
 'crm_private.lifecycle_whatsapp_template_candidates','select'),
 'candidate metadata is backend-only, not readable by clients or service_role');

-- Pure synthetic integration metadata; no WhatsApp provider API or messages.
insert into public.artist_integrations
 (artist_id,integration_type,provider,integration_key,external_account_label,is_enabled)
select id,'whatsapp','meta_cloud_api','vladimir-production',
 'Synthetic v2 candidate preflight',true
from reminder_candidate_artists where slug='vladimir'
and not exists (
  select 1 from public.artist_integrations i
  where i.artist_id=(select id from reminder_candidate_artists where slug='vladimir')
  and i.integration_type='whatsapp' and i.provider='meta_cloud_api' and i.is_enabled
);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select ok(exists(
 select 1 from public.service_claim_lifecycle_whatsapp_template_targets(20) c
 where c.purpose='session_reminder_72h'
 and c.template_name='vishar_lifecycle_reminder_72h_v2'
 and c.artist_id=(select id from reminder_candidate_artists where slug='vladimir')
), 'a backend maintenance claim discovers the 72-hour v2 candidate');
select ok(exists(
 select 1 from public.service_claim_lifecycle_whatsapp_template_targets(20) c
 where c.purpose='session_reminder_24h'
 and c.template_name='vishar_lifecycle_reminder_24h_v2'
 and c.artist_id=(select id from reminder_candidate_artists where slug='vladimir')
), 'a backend maintenance claim discovers the 24-hour v2 candidate');

select lives_ok($$select public.service_record_lifecycle_whatsapp_template_status(
 (select id from reminder_candidate_artists where slug='vladimir'),
 'session_reminder_72h','vishar_lifecycle_reminder_72h_v2',
 'en_GB','APPROVED','123456789012345')$$,
 'only a backend-provided Meta identity can mark v2 candidate approved');
select lives_ok($$select public.service_record_lifecycle_whatsapp_template_failure(
 (select id from reminder_candidate_artists where slug='vladimir'),
 'session_reminder_24h','vishar_lifecycle_reminder_24h_v2',
 'en_GB','whatsapp_template_rate_limited')$$,
 'provider error backoff applies to v2 without touching v1');
select throws_ok($$select public.service_record_lifecycle_whatsapp_template_status(
 (select id from reminder_candidate_artists where slug='vladimir'),
 'session_reminder_72h','wrong_candidate',
 'en_GB','APPROVED','123456789012345')$$,
 '22023',null,'unknown candidate identity is not accepted');
reset role;

select is((select approval_status from
 crm_private.lifecycle_whatsapp_template_candidates where
 artist_id=(select id from reminder_candidate_artists where slug='vladimir')
 and purpose='session_reminder_72h'),'APPROVED',
 'v2 candidate approval is stored separately');
select ok((select next_retry_at>now()+interval '55 minutes'
 from crm_private.lifecycle_whatsapp_template_candidates
 where artist_id=(select id from reminder_candidate_artists where slug='vladimir')
 and purpose='session_reminder_24h'),
 'v2 candidate rate limit is backed off for an hour');
select ok(not exists(select 1 from crm_private.lifecycle_whatsapp_template_registry
 where artist_id=(select id from reminder_candidate_artists where slug='vladimir')
 and purpose in ('session_reminder_72h','session_reminder_24h')
 and template_name like '%_v2'),
 'even verified v2 candidates do not switch live sends');
select * from finish();
rollback;
