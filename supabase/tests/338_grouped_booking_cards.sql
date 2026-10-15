-- Synthetic-only end-to-end group confirmation. This rolls back and never contacts Meta/Google/Gmail.
begin;
select no_plan();
select set_config('request.jwt.claims','{"role":"service_role"}',true);

insert into auth.users(id,email) values
 ('c7111111-1111-4111-8111-111111111111','group-cards-owner@example.test');
insert into public.profiles(id,email,display_name,role,is_active) values
 ('c7111111-1111-4111-8111-111111111111','group-cards-owner@example.test','Group Cards Owner','owner',true);
update public.artist_memberships set access_level='owner',can_view_finance=true,
 can_manage_finance=true,can_manage_sessions=true,can_manage_integrations=true,is_active=true
where profile_id='c7111111-1111-4111-8111-111111111111'
 and artist_id='a1111111-1111-4111-8111-111111111111';

insert into public.clients(id,full_name,email,phone) values
 ('c7121111-1111-4111-8111-111111111111','Synthetic Group Card','group-card-client@example.test','+447700900611');
insert into public.enquiries(
 id,client_id,artist_id,reference_number,idempotency_key,intake_fingerprint,status,
 intake_state,submitted_full_name,submitted_email,privacy_notice_version,privacy_acknowledged_at
) values (
 'c7171111-1111-4111-8111-111111111111','c7121111-1111-4111-8111-111111111111',
 'a1111111-1111-4111-8111-111111111111','PENDING',
 'c7172222-2222-4222-8222-222222222222',repeat('7',64),'accepted','complete',
 'Synthetic Group Card','group-card-client@example.test','2026-08-05',now()
);
insert into public.projects(id,client_id,enquiry_id,artist_id,title,status,currency) values
 ('c7131111-1111-4111-8111-111111111111',
 'c7121111-1111-4111-8111-111111111111',
 'c7171111-1111-4111-8111-111111111111',
 'a1111111-1111-4111-8111-111111111111','Group confirmation fixture','active','GBP');
insert into crm_private.gmail_thread_contexts(artist_id,client_id,enquiry_id,provider_thread_id,subject,created_at,updated_at)
values ('a1111111-1111-4111-8111-111111111111',
 'c7121111-1111-4111-8111-111111111111',
 'c7171111-1111-4111-8111-111111111111','group-card-synthetic-thread','Tattoo booking',now(),now());

insert into public.sessions(id,client_id,project_id,artist_id,appointment_type,status,
 start_at,end_at,duration_hours,price,currency) values
 ('c7141111-1111-4111-8111-111111111111','c7121111-1111-4111-8111-111111111111',
 'c7131111-1111-4111-8111-111111111111','a1111111-1111-4111-8111-111111111111',
 'tattoo_session','confirmed',date_trunc('day',now())+interval '80 days 11 hours',
 date_trunc('day',now())+interval '80 days 18 hours',7,980,'GBP'),
 ('c7142222-2222-4222-8222-222222222222','c7121111-1111-4111-8111-111111111111',
 'c7131111-1111-4111-8111-111111111111','a1111111-1111-4111-8111-111111111111',
 'tattoo_session','confirmed',date_trunc('day',now())+interval '81 days 11 hours',
 date_trunc('day',now())+interval '81 days 18 hours',7,980,'GBP'),
 ('c7143333-3333-4333-8333-333333333333','c7121111-1111-4111-8111-111111111111',
 'c7131111-1111-4111-8111-111111111111','a1111111-1111-4111-8111-111111111111',
 'tattoo_session','confirmed',date_trunc('day',now())+interval '82 days 11 hours',
 date_trunc('day',now())+interval '82 days 18 hours',7,980,'GBP');

select is((select count(*)::int from crm_private.booking_cards where
 project_id='c7131111-1111-4111-8111-111111111111'),0,
 'unpaid sessions produce no confirmation cards');

select set_config('request.jwt.claims',
 '{"sub":"c7111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
select lives_ok($$select public.configure_monzo_easy_bank_transfer(
 'a1111111-1111-4111-8111-111111111111','https://monzo.com/pay/r/synthetic-group-card',true)$$,
 'synthetic operator has a payment route');
create temporary table group_request as
 select public.request_grouped_session_deposit(
 array['c7141111-1111-4111-8111-111111111111',
       'c7142222-2222-4222-8222-222222222222',
       'c7143333-3333-4333-8333-333333333333']::uuid[],
 'c7151111-1111-4111-8111-111111111111','copy_link') as result;
grant select on group_request to authenticated,service_role;
select is((select (result->>'amount')::numeric from group_request),750::numeric,
 'one payment request contains three derived £250 deposits');

select lives_ok($$select public.record_manual_payment(
 (select (result->>'payment_request_id')::uuid from group_request),
 'c7161111-1111-4111-8111-111111111111',750,now(),'crm_manual_payment')$$,
 'synthetic group is marked paid through the canonical ledger');
select set_config('request.jwt.claims','{"role":"service_role"}',true);

create temporary view group_cards as select b.* from crm_private.booking_cards b
where b.project_id='c7131111-1111-4111-8111-111111111111' and b.superseded_at is null;
select is((select count(*)::int from group_cards),3,'three separate session facts are retained');
select is((select count(*)::int from crm_private.booking_card_groups g
 join public.session_deposit_groups pg on pg.id=g.group_id
 where pg.project_id='c7131111-1111-4111-8111-111111111111'),1,
 'the three paid appointments form exactly one grouped card');
select is((select count(*)::int from crm_private.booking_card_deliveries d
 join group_cards b on b.id=d.booking_card_id),1,
 'the group queues ONE email, not three');
select is((select count(*)::int from crm_private.appointment_client_action_tokens t
 join group_cards b on b.id=t.booking_card_id
 join crm_private.booking_card_group_action_tokens gt on gt.token_id=t.id),2,
 'one confirm and one reschedule capability cover all three dates');
select is((select session_count from crm_private.booking_group_card_summary(
 (select anchor_card_id from crm_private.booking_card_groups g
 join public.session_deposit_groups pg on pg.id=g.group_id
 where pg.project_id='c7131111-1111-4111-8111-111111111111'))),3,
 'group summary contains all three appointments');
select is((select total_remaining from crm_private.booking_group_card_summary(
 (select anchor_card_id from crm_private.booking_card_groups g
 join public.session_deposit_groups pg on pg.id=g.group_id
 where pg.project_id='c7131111-1111-4111-8111-111111111111'))),2190::numeric,
 'group shows £730 remaining per day, £2,190 total');
select ok((select m.body like '%sessions are booked%'
 from public.email_messages m join group_cards b on b.id=m.booking_card_id),
 'the client receives plural group confirmation text');
select ok((select m.body like '%Confirm all sessions:%'
 from public.email_messages m join group_cards b on b.id=m.booking_card_id),
 'one grouped confirmation link is rendered in Email');

-- The link may be resolved and used by the same public appointment action route.
create temporary table confirmed_token(raw_token text);
insert into confirmed_token(raw_token)
select a.raw_token from crm_private.issue_booking_card_client_actions(
 (select anchor_card_id from crm_private.booking_card_groups g
 join public.session_deposit_groups pg on pg.id=g.group_id
 where pg.project_id='c7131111-1111-4111-8111-111111111111')) a
where a.action='confirm_attendance';
select is((select count(*)::int from confirmed_token),1,'one group confirmation token issued');
select is((select action::text from public.service_resolve_appointment_client_action(
 (select raw_token from confirmed_token))),'confirm_attendance',
 'existing backend action endpoint resolves group capability');

select is((select public.service_apply_appointment_client_action(
 (select raw_token from confirmed_token))->>'session_count'),'3',
 'one click applies to the three unchanged appointments');
select is((select count(*)::int from public.sessions where
 project_id='c7131111-1111-4111-8111-111111111111'
 and client_response='attendance_confirmed'),3,
 'every member independently records attendance confirmed');
select throws_ok(format('select public.service_apply_appointment_client_action(%L)',
 (select raw_token from confirmed_token)),'42501',null,
 'the same confirmation cannot be replayed');
-- A newly issued group link becomes invalid if any sibling date changes,
-- even when the anchor itself has not changed.
create temporary table stale_token(raw_token text);
insert into stale_token(raw_token)
select a.raw_token from crm_private.issue_booking_card_client_actions(
 (select anchor_card_id from crm_private.booking_card_groups g
 join public.session_deposit_groups pg on pg.id=g.group_id
 where pg.project_id='c7131111-1111-4111-8111-111111111111')) a
where a.action='confirm_attendance';
update public.sessions set calendar_version=calendar_version+1,
 start_at=start_at+interval '5 minutes',end_at=end_at+interval '5 minutes'
where id='c7142222-2222-4222-8222-222222222222';
select throws_ok(format('select public.service_apply_appointment_client_action(%L)',
 (select raw_token from stale_token)),'42501',null,
 'an edited date invalidates the entire old group link atomically');
select * from finish();
rollback;
