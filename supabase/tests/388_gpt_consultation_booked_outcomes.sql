-- Exactly the same RPC used by the visit result form, gated behind
-- a human OAuth token and active GPT Artist context.
-- Local pgTAP fixtures only, always rolled back.
begin;
select no_plan();

select ok(
  has_function_privilege('authenticated',
    'public.gpt_record_consultation_booked_outcome(uuid,uuid,integer,uuid)','execute')
  and not has_function_privilege('anon',
    'public.gpt_record_consultation_booked_outcome(uuid,uuid,integer,uuid)','execute')
  and not has_function_privilege('service_role',
    'public.gpt_record_consultation_booked_outcome(uuid,uuid,integer,uuid)','execute'),
  'recording a consultation through the GPT requires an authenticated human'
);
select ok(
  has_function_privilege('authenticated','public.gpt_get_visit_outcome_context(uuid)','execute')
  and not has_function_privilege('anon','public.gpt_get_visit_outcome_context(uuid)','execute'),
  'visit outcome read is artist-scoped and unavailable anonymously'
);

insert into auth.users (id,email) values
 ('b5151111-1111-4111-8111-111111111111','outcome-gpt-owner@example.test');
insert into public.profiles(id,email,display_name,role,is_active) values
 ('b5151111-1111-4111-8111-111111111111',
  'outcome-gpt-owner@example.test','Visit Outcome Owner','owner',true);

insert into public.clients (id,workspace_id,full_name,email)
select v.client::uuid,a.workspace_id,v.name,v.email
from (values
 ('b5152222-2222-4222-8222-222222222222','a1111111-1111-4111-8111-111111111111','Sample Vladimir Consultation','v515@example.test'),
 ('b5153333-3333-4333-8333-333333333333','a2222222-2222-4222-8222-222222222222','Sample Kristina Consultation','k515@example.test')) v(client,artist,name,email)
join public.artists a on a.id=v.artist::uuid;

-- Existing bookings must belong to real projects; these two fixture
-- projects exist only inside this rollback-only pgTAP transaction.
insert into public.projects(id,client_id,artist_id,status,title) values
 ('b515aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','b5152222-2222-4222-8222-222222222222',
  'a1111111-1111-4111-8111-111111111111','active','Vladimir sample project'),
 ('b515bbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','b5153333-3333-4333-8333-333333333333',
  'a2222222-2222-4222-8222-222222222222','active','Kristina sample project');

insert into public.sessions(id,artist_id,client_id,project_id,appointment_type,status,start_at,end_at,duration_hours)
values
('b5154444-4444-4444-8444-444444444444','a1111111-1111-4111-8111-111111111111',
'b5152222-2222-4222-8222-222222222222',null,'in_person_consultation','completed',
 date_trunc('hour',now())-interval '7 days', date_trunc('hour',now())-interval '7 days'+interval '30 minutes',0.5),
('b5155555-5555-4555-8555-555555555555','a1111111-1111-4111-8111-111111111111',
'b5152222-2222-4222-8222-222222222222','b515aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','tattoo_session','confirmed',
 date_trunc('hour',now())+interval '7 days',date_trunc('hour',now())+interval '7 days 7 hours',7),
('b5156666-6666-4666-8666-666666666666','a2222222-2222-4222-8222-222222222222',
'b5153333-3333-4333-8333-333333333333',null,'in_person_consultation','completed',
 date_trunc('hour',now())-interval '6 days',date_trunc('hour',now())-interval '6 days'+interval '30 minutes',0.5),
('b5157777-7777-4777-8777-777777777777','a2222222-2222-4222-8222-222222222222',
'b5153333-3333-4333-8333-333333333333','b515bbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','tattoo_session','confirmed',
 date_trunc('hour',now())+interval '8 days',date_trunc('hour',now())+interval '8 days 7 hours',7),
('b5158888-8888-4888-8888-888888888888','a1111111-1111-4111-8111-111111111111',
'b5152222-2222-4222-8222-222222222222',null,'in_person_consultation','confirmed',
 date_trunc('hour',now())+interval '1 day',date_trunc('hour',now())+interval '1 day 30 minutes',0.5);

create function pg_temp.gpt_claims(p text) returns void language sql as $f$
 select set_config('request.jwt.claims',p,true)::void;
$f$;
grant execute on function pg_temp.gpt_claims(text) to authenticated;
set local role authenticated;
select pg_temp.gpt_claims('{"sub":"b5151111-1111-4111-8111-111111111111","role":"authenticated"}');
select lives_ok(
  $$select public.configure_gpt_action_client('vishar-unified-gpt','oauth-visit-outcome-515',true,true)$$,
  'owner enables a human authenticated GPT client for this test'
);
select lives_ok(
  $$select public.configure_gpt_full_management('vishar-unified-gpt',true,false,true)$$,
  'CRM management allowed but finance disabled'
);
select pg_temp.gpt_claims('{"sub":"b5151111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-visit-outcome-515"}');
select lives_ok(
  $$select public.gpt_artist_context('a1111111-1111-4111-8111-111111111111')$$,
  'owner selects Vladimir with the GPT context'
);
select is((public.gpt_get_visit_outcome_context('b5154444-4444-4444-8444-444444444444')->>'version')::integer,0,
  'outcome read returns the expected first-write version');
select throws_ok(
  'select public.gpt_get_visit_outcome_context(''b5155555-5555-4555-8555-555555555555'')',
  '22023', 'only consultation visit outcomes can be read here',
  'GPT appointment read cannot expose a tattoo outcome with finance disabled'
);

select throws_ok(
  $$select public.gpt_record_consultation_booked_outcome(
    'b5156666-6666-4666-8666-666666666666',
    'b5159000-0000-4000-8000-000000000002',0,
    'b5157777-7777-4777-8777-777777777777')$$,
  '42501', null, 'cannot write Kristina outcome while Vladimir is selected'
);
select throws_ok(
  $$select public.gpt_record_consultation_booked_outcome(
    'b5158888-8888-4888-8888-888888888888',
    'b5159000-0000-4000-8000-000000000003',0,
    'b5155555-5555-4555-8555-555555555555')$$,
  '22023', null, 'future or not completed consultation is not recordable'
);
select throws_ok(
  $$select public.gpt_record_consultation_booked_outcome(
    'b5154444-4444-4444-8444-444444444444',
    'b5159000-0000-4000-8000-000000000004',0,
    'b5157777-7777-4777-8777-777777777777')$$,
  '22023', null, 'cannot link a booking belonging to another artist and client'
);
create temp table outcome_515 as select public.gpt_record_consultation_booked_outcome(
 'b5154444-4444-4444-8444-444444444444',
 'b5159000-0000-4000-8000-000000000001',0,
 'b5155555-5555-4555-8555-555555555555') result;
grant select on outcome_515 to authenticated;

select is((select result->>'outcome' from outcome_515),'booked',
 'completed consultation receives the booked outcome');
select is((select result->>'session_status' from outcome_515),'completed',
 'already completed calendar status remains completed');
select is((public.gpt_record_consultation_booked_outcome(
 'b5154444-4444-4444-8444-444444444444',
 'b5159000-0000-4000-8000-000000000001',0,
 'b5155555-5555-4555-8555-555555555555')->>'replayed'),'true',
 'repeated operation ID returns idempotent replay');
-- The private outcome and immutable revision tables are deliberately not
-- granted to authenticated browser roles. Inspect them as the pgTAP owner.
reset role;
select is((select count(*)::integer from public.visit_outcome_revisions
where session_id='b5154444-4444-4444-8444-444444444444'),1,
 'one write and replay create only one revision');
select throws_ok(
  $$select public.gpt_record_consultation_booked_outcome(
    'b5154444-4444-4444-8444-444444444444',
    'b5159000-0000-4000-8000-000000000005',0,
    'b5155555-5555-4555-8555-555555555555')$$,
  '23514', null, 'separate operation cannot silently overwrite a confirmed outcome');
select ok((select outcome='booked' and linked_session_id='b5155555-5555-4555-8555-555555555555'
 and final_price is null and received_via_outcome=0 and payment_state is null
 from public.visit_outcomes where session_id='b5154444-4444-4444-8444-444444444444'),
 'free consultation records a link with zero collected payment and no liability');
select is((select count(*)::integer from public.automation_jobs where session_id='b5154444-4444-4444-8444-444444444444'),0,
 'consultation write does not send or schedule client messages');

set local role authenticated;
select lives_ok(
  'select public.gpt_artist_context(''a2222222-2222-4222-8222-222222222222'')',
  'owner selects Kristina with the same OAuth session');
select is((public.gpt_record_consultation_booked_outcome(
 'b5156666-6666-4666-8666-666666666666',
 'b5159000-0000-4000-8000-000000000006',0,
 'b5157777-7777-4777-8777-777777777777')->>'outcome'),'booked',
 'Kristina can record her own successful consultation');

-- Chat visit and web checkout share one ledger and versioned outcome.
select ok(
  has_function_privilege('authenticated',
    'public.gpt_record_tattoo_visit(uuid,uuid,integer,integer,numeric,numeric,text,text,text)','execute')
  and not has_function_privilege('anon',
    'public.gpt_record_tattoo_visit(uuid,uuid,integer,integer,numeric,numeric,text,text,text)','execute')
  and not has_function_privilege('service_role',
    'public.gpt_record_tattoo_visit(uuid,uuid,integer,integer,numeric,numeric,text,text,text)','execute'),
  'a chat tattoo receipt requires an authenticated human'
);
reset role;
insert into public.sessions(id,artist_id,client_id,project_id,appointment_type,status,start_at,end_at,duration_hours)
values ('b5155555-5555-4555-8555-555555555556','a1111111-1111-4111-8111-111111111111',
  'b5152222-2222-4222-8222-222222222222','b515aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','tattoo_session','completed',
  date_trunc('hour',now())-interval '4 days',date_trunc('hour',now())-interval '4 days'+interval '7 hours',7);
set local role authenticated;
select public.gpt_artist_context('a1111111-1111-4111-8111-111111111111');
select throws_ok(
  $$select public.gpt_record_tattoo_visit('b5155555-5555-4555-8555-555555555556',
    'b5159000-0000-4000-8000-000000000011',0,300,null,450,'studio_direct')$$,
  '42501', null, 'chat visit rejects a GPT client without finance permission');

select pg_temp.gpt_claims('{"sub":"b5151111-1111-4111-8111-111111111111","role":"authenticated"}');
select public.configure_gpt_full_management('vishar-unified-gpt',true,true,true);
select pg_temp.gpt_claims('{"sub":"b5151111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-visit-outcome-515"}');
select lives_ok($$select public.record_session_receipt('b5155555-5555-4555-8555-555555555556',
  'b5159000-0000-4000-8000-000000000012','deposit',250,'cash')$$,
  'the web can record the deposit before the visit is confirmed in chat');
select is((public.gpt_get_visit_outcome_context('b5155555-5555-4555-8555-555555555556')->'finance'->>'deposit_paid')::numeric,
  250::numeric, 'chat immediately reads the same deposit');
select is((public.gpt_record_tattoo_visit('b5155555-5555-4555-8555-555555555556',
  'b5159000-0000-4000-8000-000000000013',0,300,null,450,'studio_direct')->>'outstanding')::numeric,
  0::numeric, 'five actual hours and the studio receipt settle the visit atomically');
select is((public.gpt_record_tattoo_visit('b5155555-5555-4555-8555-555555555556',
  'b5159000-0000-4000-8000-000000000013',0,300,null,450,'studio_direct')->>'idempotent_replay'),
  'true', 'replaying a chat receipt writes nothing');
select throws_ok(
  $$select public.gpt_record_tattoo_visit('b5155555-5555-4555-8555-555555555556',
    'b5159000-0000-4000-8000-000000000014',0,300,null,450,'studio_direct')$$,
  '40001', null, 'a second write based on a stale outcome cannot record the receipt');
select throws_ok(
  $$select public.gpt_record_tattoo_visit('b5157777-7777-4777-8777-777777777777',
    'b5159000-0000-4000-8000-000000000015',0,300,null,450,'studio_direct')$$,
  '42501', null, 'cannot write another artist’s visit');
select ok((select (v->'outcome'->>'worked_minutes')::int=300 and (v->'outcome'->>'final_price')::numeric=700
  and v->'outcome'->>'payment_state' = 'paid' and (v->'finance'->>'invoiced_paid')::numeric=450
  and (v->'session'->>'scheduled_minutes')::int=420
  from (select public.get_visit_outcome_context('b5155555-5555-4555-8555-555555555556') as v) readback),
  'the web reads actual hours and exact settlement while the reserved slot stays intact');
select is(public.gpt_record_tattoo_visit('b5155555-5555-4555-8555-555555555556',
  'b5159000-0000-4000-8000-000000000016',1,p_notes=>'Session finished as planned')->>'payment_state',
  'paid', 'a correction can preserve price and payment while adding a note');
reset role;
select is((select count(*)::int from public.payment_transactions t join public.payment_requests p on p.id=t.payment_request_id
  where p.project_id='b515aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),2,'the deposit and one balance receipt are the only ledger credits');

select * from finish(true);
rollback;
