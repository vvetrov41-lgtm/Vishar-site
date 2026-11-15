-- ChatGPT plugin parity: a finished consultation still marked `confirmed`
-- (the normal state: consultations are never auto-completed) can be
-- recorded as "Booked a tattoo" through the plugin, exactly as the Today card
-- in the CRM records it, with the same stored result and no message,
-- payment or calendar side effect. Rollback-only fixtures.
begin;
select no_plan();

insert into auth.users (id,email) values
 ('b5191111-1111-4111-8111-111111111111','outcome-parity-owner@example.test');
insert into public.profiles(id,email,display_name,role,is_active) values
 ('b5191111-1111-4111-8111-111111111111',
  'outcome-parity-owner@example.test','Outcome Parity Owner','owner',true);

insert into public.clients (id,workspace_id,full_name,email)
select v.client::uuid,a.workspace_id,v.name,v.email
from (values
 ('b5192222-2222-4222-8222-222222222222','a2222222-2222-4222-8222-222222222222','Sample Plugin Client','p519@example.test'),
 ('b5193333-3333-4333-8333-333333333333','a2222222-2222-4222-8222-222222222222','Sample Web Client','w519@example.test')) v(client,artist,name,email)
join public.artists a on a.id=v.artist::uuid;

insert into public.projects(id,client_id,artist_id,status,title) values
 ('b519aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','b5192222-2222-4222-8222-222222222222',
  'a2222222-2222-4222-8222-222222222222','active','Plugin sample project'),
 ('b519bbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','b5193333-3333-4333-8333-333333333333',
  'a2222222-2222-4222-8222-222222222222','active','Web sample project');

-- Two identical finished consultations, still confirmed and already on the
-- calendar, each with a tattoo booking already in the calendar; plus a
-- finished draft and a finished cancelled consultation that stay refused.
insert into public.sessions(id,artist_id,client_id,project_id,appointment_type,status,start_at,end_at,duration_hours,calendar_event_id,cancelled_at)
values
('b5194444-4444-4444-8444-444444444444','a2222222-2222-4222-8222-222222222222',
 'b5192222-2222-4222-8222-222222222222',null,'in_person_consultation','confirmed',
 date_trunc('hour',now())-interval '3 days', date_trunc('hour',now())-interval '3 days'+interval '30 minutes',0.5,'evt-plugin-519',null),
('b5195555-5555-4555-8555-555555555555','a2222222-2222-4222-8222-222222222222',
 'b5192222-2222-4222-8222-222222222222','b519aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','tattoo_session','confirmed',
 date_trunc('hour',now())+interval '9 days',date_trunc('hour',now())+interval '9 days 6 hours',6,null,null),
('b5196666-6666-4666-8666-666666666666','a2222222-2222-4222-8222-222222222222',
 'b5193333-3333-4333-8333-333333333333',null,'in_person_consultation','confirmed',
 date_trunc('hour',now())-interval '3 days', date_trunc('hour',now())-interval '3 days'+interval '30 minutes',0.5,'evt-web-519',null),
('b5197777-7777-4777-8777-777777777777','a2222222-2222-4222-8222-222222222222',
 'b5193333-3333-4333-8333-333333333333','b519bbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','tattoo_session','confirmed',
 date_trunc('hour',now())+interval '10 days',date_trunc('hour',now())+interval '10 days 6 hours',6,null,null),
('b5198888-8888-4888-8888-888888888888','a2222222-2222-4222-8222-222222222222',
 'b5192222-2222-4222-8222-222222222222',null,'video_consultation','draft',
 date_trunc('hour',now())-interval '2 days', date_trunc('hour',now())-interval '2 days'+interval '30 minutes',0.5,null,null),
('b5199999-9999-4999-8999-999999999999','a2222222-2222-4222-8222-222222222222',
 'b5192222-2222-4222-8222-222222222222',null,'video_consultation','cancelled',
 date_trunc('hour',now())-interval '1 day', date_trunc('hour',now())-interval '1 day'+interval '30 minutes',0.5,null,
 now()-interval '2 days');

-- Today cards start at the rollout date; production enabled them on
-- 2026-11-13. A fresh test database stamps "now", so move it back here.
update crm_private.visit_outcome_rollout set enabled_from = now() - interval '30 days';

select ok(
  exists (select 1 from crm_private.visit_outcome_due('a2222222-2222-4222-8222-222222222222', now()) d
          where d.session_id='b5194444-4444-4444-8444-444444444444'),
  'the confirmed finished consultation is offered as a Today visit outcome card'
);

create temp table outbox_before_519 as
select count(*)::integer n from public.integration_outbox
where session_id in ('b5194444-4444-4444-8444-444444444444','b5196666-6666-4666-8666-666666666666');

create function pg_temp.gpt_claims(p text) returns void language sql as $f$
 select set_config('request.jwt.claims',p,true)::void;
$f$;
grant execute on function pg_temp.gpt_claims(text) to authenticated;
set local role authenticated;
select pg_temp.gpt_claims('{"sub":"b5191111-1111-4111-8111-111111111111","role":"authenticated"}');
select lives_ok(
  $$select public.configure_gpt_action_client('vishar-unified-gpt','oauth-visit-outcome-519',true,true)$$,
  'owner enables a human authenticated GPT client for this test'
);
select lives_ok(
  $$select public.configure_gpt_full_management('vishar-unified-gpt',true,false,true)$$,
  'CRM management allowed but finance disabled'
);

-- Web CRM: the Today card answer for the second consultation.
select is((public.record_visit_outcome(
  'b5196666-6666-4666-8666-666666666666','b5199000-0000-4000-8000-000000000001',0,'booked',
  jsonb_build_object('linked_session_id','b5197777-7777-4777-8777-777777777777'))->>'session_status'),
  'completed', 'web CRM records a confirmed finished consultation and completes it');

-- ChatGPT plugin: the same answer for the first consultation.
select pg_temp.gpt_claims('{"sub":"b5191111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-visit-outcome-519"}');
select lives_ok(
  $$select public.gpt_artist_context('a2222222-2222-4222-8222-222222222222')$$,
  'owner selects Kristina with the GPT context'
);
select is((public.gpt_get_visit_outcome_context('b5194444-4444-4444-8444-444444444444')->'bookings'->0->>'id'),
  'b5195555-5555-4555-8555-555555555555', 'plugin read lists the booking already in the calendar');
create temp table plugin_519 as select public.gpt_record_consultation_booked_outcome(
 'b5194444-4444-4444-8444-444444444444','b5199000-0000-4000-8000-000000000002',0,
 'b5195555-5555-4555-8555-555555555555') result;
grant select on plugin_519 to authenticated;
select is((select result->>'outcome' from plugin_519),'booked',
  'plugin records the confirmed finished consultation as booked');
select is((select result->>'session_status' from plugin_519),'completed',
  'plugin moves the consultation to completed through the shared workflow');
select is((public.gpt_record_consultation_booked_outcome(
 'b5194444-4444-4444-8444-444444444444','b5199000-0000-4000-8000-000000000002',0,
 'b5195555-5555-4555-8555-555555555555')->>'replayed'),'true',
 'a retried plugin call is an idempotent replay');
select throws_ok(
  $$select public.gpt_record_consultation_booked_outcome(
    'b5198888-8888-4888-8888-888888888888','b5199000-0000-4000-8000-000000000003',0,
    'b5195555-5555-4555-8555-555555555555')$$,
  '22023', null, 'an unconfirmed (draft) consultation stays refused');
select throws_ok(
  $$select public.gpt_record_consultation_booked_outcome(
    'b5199999-9999-4999-8999-999999999999','b5199000-0000-4000-8000-000000000004',0,
    'b5195555-5555-4555-8555-555555555555')$$,
  '22023', null, 'a cancelled consultation stays refused');

reset role;
select is((select status::text from public.sessions where id='b5194444-4444-4444-8444-444444444444'),'completed',
  'plugin path: consultation is completed');
select is((select status::text from public.sessions where id='b5195555-5555-4555-8555-555555555555'),'confirmed',
  'plugin path: the linked tattoo booking is untouched');
select ok((
  select p.outcome = w.outcome and p.state = w.state
     and p.linked_session_id = 'b5195555-5555-4555-8555-555555555555'
     and w.linked_session_id = 'b5197777-7777-4777-8777-777777777777'
     and p.final_price is null and w.final_price is null
     and p.received_via_outcome = 0 and w.received_via_outcome = 0
     and p.payment_state is null and w.payment_state is null
     and p.follow_up_id is null and w.follow_up_id is null
     and p.version = w.version
  from public.visit_outcomes p, public.visit_outcomes w
  where p.session_id='b5194444-4444-4444-8444-444444444444'
    and w.session_id='b5196666-6666-4666-8666-666666666666'),
  'plugin and web CRM store the same outcome shape');
select ok(
  (select metadata->>'completion_source' from public.activity_log
   where session_id='b5194444-4444-4444-8444-444444444444' and event_type='appointment.status_changed')
  = (select metadata->>'completion_source' from public.activity_log
   where session_id='b5196666-6666-4666-8666-666666666666' and event_type='appointment.status_changed'),
  'both paths log the same status change source');
select is((select count(*)::integer from public.integration_outbox
  where session_id in ('b5194444-4444-4444-8444-444444444444','b5196666-6666-4666-8666-666666666666')),
  (select n from outbox_before_519), 'neither path edits the calendar event');
select is((select count(*)::integer from public.automation_jobs
  where session_id in ('b5194444-4444-4444-8444-444444444444','b5196666-6666-4666-8666-666666666666')),0,
  'neither path schedules a client message');
select is((select count(*)::integer from public.follow_ups
  where client_id in ('b5192222-2222-4222-8222-222222222222','b5193333-3333-4333-8333-333333333333')),0,
  'neither path creates a follow-up');
select ok(not exists (select 1 from crm_private.visit_outcome_due('a2222222-2222-4222-8222-222222222222', now()) d
  where d.session_id in ('b5194444-4444-4444-8444-444444444444','b5196666-6666-4666-8666-666666666666')),
  'both consultations leave the Today visit outcome list');

select * from finish(true);
rollback;
