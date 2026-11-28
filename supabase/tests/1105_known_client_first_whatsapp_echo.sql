-- Synthetic pgTAP regression; no live provider or production records.
begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.artist_integrations
 (id, artist_id, integration_type, provider, integration_key, configuration, is_enabled)
values ('f9328111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
 'whatsapp', 'meta_cloud_api', 'vladimir-production', '{}'::jsonb, true);
insert into public.clients (id, workspace_id, full_name, email, phone)
select v.id::uuid, a.workspace_id, v.name, v.email, v.phone
from (values
 ('d5280000-0000-4000-8000-000000000001','Known first echo','first-echo@example.test','+447700900981','a1111111-1111-4111-8111-111111111111'),
 ('d5280000-0000-4000-8000-000000000002','Ambiguous echo one','ambiguous-echo1@example.test','+447700900982','a1111111-1111-4111-8111-111111111111'),
 ('d5280000-0000-4000-8000-000000000003','Ambiguous echo two','ambiguous-echo2@example.test','07700900982','a1111111-1111-4111-8111-111111111111'),
 ('d5280000-0000-4000-8000-000000000004','Other artist echo','other-echo@example.test','+447700900983','a2222222-2222-4222-8222-222222222222')
) as v(id,name,email,phone,artist_id)
join public.artists a on a.id=v.artist_id::uuid;
insert into public.enquiries (id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
 intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at)
select ('d5380000-0000-4000-8000-00000000000'||i)::uuid,
 ('d5280000-0000-4000-8000-00000000000'||i)::uuid,
 case when i=4 then 'a2222222-2222-4222-8222-222222222222'::uuid else 'a1111111-1111-4111-8111-111111111111'::uuid end,
 'ENQ-2099-98'||lpad(i::text,2,'0'), ('d5390000-0000-4000-8000-00000000000'||i)::uuid,
 repeat(i::text,64), 'new', 'complete', c.full_name, c.email, '2026-08-05', now()
from generate_series(1,4) i join public.clients c on c.id=('d5280000-0000-4000-8000-00000000000'||i)::uuid;

select is((public.record_communication_outbound_echo(
 'a1111111-1111-4111-8111-111111111111','whatsapp','vladimir-production',
 '447700900981','wamid.SYNTHETICFIRSTECHO001',now(),'text','First manual reply','[]'::jsonb
)->>'changed')::boolean,true,'first outbound echo for known enquiry is saved');
select is((select client_id::text from public.communication_conversations where channel='whatsapp' and external_contact_id='447700900981'),
 'd5280000-0000-4000-8000-000000000001','client is linked');
select is((select enquiry_id::text from public.communication_conversations where channel='whatsapp' and external_contact_id='447700900981'),
 'd5380000-0000-4000-8000-000000000001','enquiry is linked');
select ok((select last_inbound_at is null and last_outbound_at is not null and link_state='linked'
 from public.communication_conversations where channel='whatsapp' and external_contact_id='447700900981'),
 'outbound-only conversation does not open inbound window');
select is((select direction::text||':'||origin::text||':'||status::text from public.communication_messages
 where provider_message_id='wamid.SYNTHETICFIRSTECHO001'),'outbound:provider_app:sent','message is genuine provider evidence');
select is((select status::text from public.enquiries where id='d5380000-0000-4000-8000-000000000001'),
 'reviewing','existing status trigger marks enquiry contacted');
select ok(exists(select 1 from crm_private.enquiry_first_artist_reply('d5380000-0000-4000-8000-000000000001',now())
 where channel='whatsapp' and evidence_source='communication_message'),'existing reply evidence suppresses unanswered workflow');
select is((public.record_communication_outbound_echo(
 'a1111111-1111-4111-8111-111111111111','whatsapp','vladimir-production',
 '447700900981','wamid.SYNTHETICFIRSTECHO001',now(),'text','First manual reply','[]'::jsonb
)->>'changed')::boolean,false,'provider replay is a no-op');
select is((select count(*)::int from public.communication_messages where provider_message_id='wamid.SYNTHETICFIRSTECHO001'),1,'no duplicate messages');
select is((public.record_communication_outbound_echo(
 'a1111111-1111-4111-8111-111111111111','whatsapp','vladimir-production',
 '447700900984','wamid.SYNTHETICFIRSTUNKNOWN',now(),'text','Personal message','[]'::jsonb
)->>'changed')::boolean,false,'unknown number remains ignored');
select is((public.record_communication_outbound_echo(
 'a1111111-1111-4111-8111-111111111111','whatsapp','vladimir-production',
 '447700900982','wamid.SYNTHETICFIRSTAMBIG',now(),'text','Ambiguous message','[]'::jsonb
)->>'changed')::boolean,false,'ambiguous client remains ignored');
select is((public.record_communication_outbound_echo(
 'a1111111-1111-4111-8111-111111111111','whatsapp','vladimir-production',
 '447700900983','wamid.SYNTHETICFIRSTOTHER',now(),'text','Other artist message','[]'::jsonb
)->>'changed')::boolean,false,'other artist client remains ignored');
select is((select count(*)::int from public.communication_conversations where external_contact_id in ('447700900982','447700900983','447700900984')),0,'no unlinked personal or cross-artist threads created');
select * from finish(true);
rollback;
