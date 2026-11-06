begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(to_regclass('crm_private.instagram_welcome_contacts') is not null,
  'welcome history is durable and private');
select ok(not has_table_privilege('authenticated', 'crm_private.instagram_welcome_contacts', 'SELECT'),
  'browser cannot read the welcome registry');
select ok(not has_function_privilege('authenticated',
  'public.service_set_instagram_welcome_mode(uuid,text,text,text[],boolean)', 'EXECUTE'),
  'browser cannot enable welcomes');
select is(crm_private.instagram_welcome_anniversary('2024-02-29 14:00:00+00'),
  '2025-02-28 14:00:00+00'::timestamptz, '12 calendar months clamp leap day');
select is(crm_private.instagram_welcome_anniversary('2026-11-06 11:00:00+00'),
  '2027-11-06 11:00:00+00'::timestamptz, 'calendar anniversary is not 365-day arithmetic');

select public.service_set_instagram_integration(
 'a1111111-1111-4111-8111-111111111111','vladimir-instagram','17841400000000001',
 'vladimir.synthetic',array['instagram_business_basic','instagram_business_manage_messages']);
-- CI starts with no connected real accounts. Configure fixture-only controls.
insert into crm_private.instagram_welcome_controls(artist_id,instagram_account_id,integration_key,website)
values ('a1111111-1111-4111-8111-111111111111','17841400000000001','vladimir-instagram','https://vishartattoo.com')
on conflict do nothing;
select is((select mode from crm_private.instagram_welcome_controls
 where instagram_account_id='17841400000000001'), 'off', 'default switch is off');
select throws_ok($$select public.service_set_instagram_welcome_mode(
 'a1111111-1111-4111-8111-111111111111','17841400000000001','live',array[]::text[],false)$$,
 '22023',null,'activation requires old Meta sender disabled');
select public.service_set_instagram_welcome_mode(
 'a1111111-1111-4111-8111-111111111111','17841400000000001','test',array['900000009001'],true);

select public.record_communication_inbound_message(
 'a1111111-1111-4111-8111-111111111111','instagram','vladimir-instagram','900000009002',
 'ig_annual_not_allowlisted',clock_timestamp(),'text','Hello');
select is((select count(*)::int from crm_private.instagram_welcome_contacts),0,
 'test mode never queues a non-allowlisted contact');
select public.record_communication_inbound_message(
 'a1111111-1111-4111-8111-111111111111','instagram','vladimir-instagram','900000009001',
 'ig_annual_first_message',clock_timestamp(),'text','Hello');
select public.record_communication_inbound_message(
 'a1111111-1111-4111-8111-111111111111','instagram','vladimir-instagram','900000009001',
 'ig_annual_first_message',clock_timestamp(),'text','Hello');
select public.record_communication_inbound_message(
 'a1111111-1111-4111-8111-111111111111','instagram','vladimir-instagram','900000009001',
 'ig_annual_second_message',clock_timestamp(),'text','Another message');
select is((select count(*)::int from public.integration_outbox where dedupe_key like 'instagram:welcome:%'),1,
 'duplicate and subsequent webhook messages create one reservation');
select is((select max_attempts from public.integration_outbox where dedupe_key like 'instagram:welcome:%'),1,
 'welcome requests have no automatic retry');
select ok((select body like '%https://vishartattoo.com/booking/%' and
 body like '%https://vishartattoo.com/faq/%' from public.communication_messages
 where id=(select communication_message_id from public.integration_outbox where dedupe_key like 'instagram:welcome:%')),
 'Vladimir uses the supplied website links');

update public.integration_outbox set status='leased',leased_by='instagram-annual-test',
 leased_at=now(),lease_expires_at=now()+interval '2 minutes'
 where dedupe_key like 'instagram:welcome:%';
select is((select public.service_begin_communication_send(id,'instagram-annual-test')->>'proceed'
 from public.integration_outbox where dedupe_key like 'instagram:welcome:%'),'true', 'first intent can proceed');
select is((select public.service_begin_communication_send(id,'instagram-annual-test')->>'proceed'
 from public.integration_outbox where dedupe_key like 'instagram:welcome:%'),'false', 'repeated intent cannot proceed');
select public.record_communication_outbox_result(id,'instagram-annual-test',false,null,'communication_send_result_unknown')
 from public.integration_outbox where dedupe_key like 'instagram:welcome:%';
select is((select state from crm_private.instagram_welcome_contacts),'unknown', 'unknown result remains blocked');
select public.record_communication_inbound_message(
 'a1111111-1111-4111-8111-111111111111','instagram','vladimir-instagram','900000009001',
 'ig_annual_after_unknown',clock_timestamp(),'text','New message');
select is((select count(*)::int from public.integration_outbox where dedupe_key like 'instagram:welcome:%'),1,
 'new inbound cannot release unknown outcome');

-- Evidence-confirmed completion models ACK without an external provider call.
update crm_private.instagram_welcome_contacts set state='sent',last_sent_at=now(),
 next_eligible_at=crm_private.instagram_welcome_anniversary(now());
select public.record_communication_inbound_message(
 'a1111111-1111-4111-8111-111111111111','instagram','vladimir-instagram','900000009001',
 'ig_annual_inside_year',clock_timestamp(),'text','New message');
select is((select count(*)::int from public.integration_outbox where dedupe_key like 'instagram:welcome:%'),1,
 'within 12 calendar months no new welcome');
update crm_private.instagram_welcome_contacts set last_sent_at=now()-interval '12 months',next_eligible_at=now();
select public.record_communication_inbound_message(
 'a1111111-1111-4111-8111-111111111111','instagram','vladimir-instagram','900000009001',
 'ig_annual_on_anniversary',clock_timestamp(),'text','New message');
select is((select count(*)::int from public.integration_outbox where dedupe_key like 'instagram:welcome:%'),2,
 'new inbound exactly at anniversary reserves a new cycle');
select public.service_set_instagram_welcome_mode(
 'a1111111-1111-4111-8111-111111111111','17841400000000001','off',array[]::text[],false);
update public.integration_outbox set status='leased',leased_by='instagram-annual-test',
 leased_at=now(),lease_expires_at=now()+interval '2 minutes'
 where dedupe_key like 'instagram:welcome:%' and status='pending';
select is((select public.service_begin_communication_send(id,'instagram-annual-test')->>'proceed'
 from public.integration_outbox where dedupe_key like 'instagram:welcome:%' and status='leased'),
 'false','kill switch is rechecked before provider intent');
-- Same IGSID in Kristina's account has independent history and her exact links.
select public.service_set_instagram_integration(
 'a2222222-2222-4222-8222-222222222222','kristina-instagram','17841400000000002',
 'kristina.synthetic',array['instagram_business_basic','instagram_business_manage_messages']);
insert into crm_private.instagram_welcome_controls(artist_id,instagram_account_id,integration_key,website)
values ('a2222222-2222-4222-8222-222222222222','17841400000000002','kristina-instagram','https://www.kristinavishar.com');
select public.service_set_instagram_welcome_mode(
 'a2222222-2222-4222-8222-222222222222','17841400000000002','test',array['900000009001'],true);
select public.record_communication_inbound_message(
 'a2222222-2222-4222-8222-222222222222','instagram','kristina-instagram','900000009001',
 'ig_annual_kristina_first',clock_timestamp(),'text','Hello');
select is((select count(*)::int from crm_private.instagram_welcome_contacts),2,
 'same contact has separate artist and business account history');
select is(replace(crm_private.instagram_welcome_text('https://www.kristinavishar.com'),
 'https://www.kristinavishar.com','https://vishartattoo.com'),
 crm_private.instagram_welcome_text('https://vishartattoo.com'),'both texts differ only in links');
update public.integration_outbox set status='leased',leased_by='instagram-kristina-test',
 leased_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '2 minutes'
 where dedupe_key like 'instagram:welcome:%' and artist_id='a2222222-2222-4222-8222-222222222222';
select public.service_begin_communication_send(id,'instagram-kristina-test')
 from public.integration_outbox where dedupe_key like 'instagram:welcome:%'
 and artist_id='a2222222-2222-4222-8222-222222222222';
select public.record_communication_outbox_result(id,'instagram-kristina-test',true,'ig_annual_success_ack')
 from public.integration_outbox where dedupe_key like 'instagram:welcome:%'
 and artist_id='a2222222-2222-4222-8222-222222222222';
select ok((select state='sent' and last_sent_at is not null
 and next_eligible_at=crm_private.instagram_welcome_anniversary(last_sent_at)
 from crm_private.instagram_welcome_contacts where artist_id='a2222222-2222-4222-8222-222222222222'),
 'real acknowledgement path records confirmed success and calendar cooldown');
select public.service_set_instagram_integration(
 'a2222222-2222-4222-8222-222222222222','kristina-instagram','17841400000000002',
 'kristina.synthetic',array['instagram_business_basic','instagram_business_manage_messages']);
select public.record_communication_inbound_message(
 'a2222222-2222-4222-8222-222222222222','instagram','kristina-instagram','900000009001',
 'ig_annual_after_reconnect',clock_timestamp(),'text','Hello again');
select is((select count(*)::int from public.integration_outbox where dedupe_key like 'instagram:welcome:%'
 and artist_id='a2222222-2222-4222-8222-222222222222'),1,'reconnect retains the cooldown');
-- Stale webhook and explicit pre-send rejection are safe without provider calls.
select public.service_set_instagram_welcome_mode(
 'a1111111-1111-4111-8111-111111111111','17841400000000001','test',array['900000009003','900000009004'],true);
select public.record_communication_inbound_message(
 'a1111111-1111-4111-8111-111111111111','instagram','vladimir-instagram','900000009003',
 'ig_annual_old_delivery',clock_timestamp()-interval '2 days','text','Delayed webhook');
select is((select count(*)::int from crm_private.instagram_welcome_contacts where external_contact_id='900000009003'),0,
 'stale historical delivery cannot trigger a welcome after activation');
select public.record_communication_inbound_message(
 'a1111111-1111-4111-8111-111111111111','instagram','vladimir-instagram','900000009004',
 'ig_annual_refusal_first',clock_timestamp(),'text','Hello');
update public.integration_outbox set status='leased',leased_by='instagram-unsent-test',
 leased_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '2 minutes'
 where id=(select outbox_id from crm_private.instagram_welcome_contacts where external_contact_id='900000009004');
select public.record_communication_outbox_result(id,'instagram-unsent-test',false,null,'instagram_welcome_ineligible')
 from public.integration_outbox
 where id=(select outbox_id from crm_private.instagram_welcome_contacts where external_contact_id='900000009004');
select is((select state from crm_private.instagram_welcome_contacts where external_contact_id='900000009004'),
 'unsent','definitely-unsent pre-provider failure does not consume annual welcome');
select public.record_communication_inbound_message(
 'a1111111-1111-4111-8111-111111111111','instagram','vladimir-instagram','900000009004',
 'ig_annual_refusal_next',clock_timestamp(),'text','Next inbound');
select is((select count(*)::int from public.integration_outbox where dedupe_key like 'instagram:welcome:%:900000009004:%'),2,
 'another attempt after definite failure needs a distinct new inbound');
select * from finish(true);
rollback;
