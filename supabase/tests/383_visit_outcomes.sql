-- 383_visit_outcomes.sql
-- Post-visit workflow for Today: an artist confirms what happened at a tattoo
-- session or a free consultation. Covers the finance split (price, earlier
-- deposit, money received now, balance), idempotency, optimistic concurrency,
-- per-artist access, corrections with history, the Today card, and that
-- recording an outcome never sends or re-sends aftercare/check-in messages.
-- Every row is synthetic and rolled back; no provider call is made.
begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table t_vo_artist as
select a.id from public.artists a
join crm_private.artist_state st on st.artist_id = a.id and st.is_active
where a.slug = 'vladimir';
grant select on t_vo_artist to public;

update crm_private.visit_outcome_rollout set enabled_from = now() - interval '30 days';

insert into auth.users (id, email) values
  ('e7000000-0000-4000-8000-0000000000a1', 'vo-owner@example.test'),
  ('e7000000-0000-4000-8000-0000000000a2', 'vo-kristina-staff@example.test'),
  ('e7000000-0000-4000-8000-0000000000a3', 'vo-vladimir-manager@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('e7000000-0000-4000-8000-0000000000a1', 'vo-owner@example.test', 'VO Owner', 'owner', true),
  ('e7000000-0000-4000-8000-0000000000a2', 'vo-kristina-staff@example.test', 'VO Kristina staff', 'booking_manager', true),
  ('e7000000-0000-4000-8000-0000000000a3', 'vo-vladimir-manager@example.test', 'VO Vladimir manager', 'booking_manager', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level, can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  -- Full access to the other artist only.
  ('e7000000-0000-4000-8000-0000000000a2', 'a2222222-2222-4222-8222-222222222222',
   'manager', true, true, true, false, true),
  -- Sessions but no finance for Vladimir.
  ('e7000000-0000-4000-8000-0000000000a3', (select id from t_vo_artist),
   'manager', false, false, true, false, true);

create function pg_temp.as_profile(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    jsonb_build_object('sub', p, 'role', 'authenticated')::text, true)::void;
$$;
create function pg_temp.as_backend() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', true)::void;
$$;
grant execute on function pg_temp.as_profile(uuid) to public;
grant execute on function pg_temp.as_backend() to public;

-- ---------------------------------------------------------------- fixtures
insert into public.clients (id, full_name, email) values
  ('e7c00000-0000-4000-8000-00000000000a', 'VO Single Session', 'vo-a@example.test'),
  ('e7c00000-0000-4000-8000-00000000000b', 'VO Consecutive Block', 'vo-b@example.test'),
  ('e7c00000-0000-4000-8000-00000000000c', 'VO No Show', 'vo-c@example.test'),
  ('e7c00000-0000-4000-8000-00000000000d', 'VO Finance', 'vo-d@example.test'),
  ('e7c00000-0000-4000-8000-00000000000e', 'VO Consultation Booked', 'vo-e@example.test'),
  ('e7c00000-0000-4000-8000-00000000000f', 'VO Consultation Thinking', 'vo-f@example.test');

insert into public.projects (id, client_id, artist_id, status, title, hourly_rate, currency)
select v.id, v.client_id, (select id from t_vo_artist), 'active', v.title, 140, 'GBP'
from (values
  ('e7d00000-0000-4000-8000-00000000000a'::uuid, 'e7c00000-0000-4000-8000-00000000000a'::uuid, 'VO single'),
  ('e7d00000-0000-4000-8000-00000000000b'::uuid, 'e7c00000-0000-4000-8000-00000000000b'::uuid, 'VO block'),
  ('e7d00000-0000-4000-8000-00000000000c'::uuid, 'e7c00000-0000-4000-8000-00000000000c'::uuid, 'VO no show'),
  ('e7d00000-0000-4000-8000-00000000000d'::uuid, 'e7c00000-0000-4000-8000-00000000000d'::uuid, 'VO finance'),
  ('e7d00000-0000-4000-8000-00000000000e'::uuid, 'e7c00000-0000-4000-8000-00000000000e'::uuid, 'VO booked')
) v(id, client_id, title);

insert into public.sessions
  (id, artist_id, client_id, project_id, appointment_type, status, start_at, end_at,
   duration_hours, price, payment_status, currency, created_at)
select v.id, (select id from t_vo_artist), v.client_id, v.project_id,
       v.kind::public.appointment_type, v.status::public.session_status,
       date_trunc('hour', now()) + v.start_offset,
       date_trunc('hour', now()) + v.start_offset + v.duration,
       extract(epoch from v.duration) / 3600, v.price, v.pay::public.payment_status, 'GBP',
       now() - interval '40 days'
from (values
  -- A1: one ordinary session; the scheduler auto-completes it.
  ('e7500000-0000-4000-8000-0000000000a1'::uuid, 'e7c00000-0000-4000-8000-00000000000a'::uuid, 'e7d00000-0000-4000-8000-00000000000a'::uuid, 'tattoo_session', 'confirmed', interval '-6 hours', interval '4 hours', null::numeric, 'unpaid'),
  -- A2: postponed card.
  ('e7500000-0000-4000-8000-0000000000a2'::uuid, 'e7c00000-0000-4000-8000-00000000000a'::uuid, 'e7d00000-0000-4000-8000-00000000000a'::uuid, 'tattoo_session', 'completed', interval '-5 days', interval '3 hours', null, 'unpaid'),
  -- B1..B4: four consecutive days, newest last.
  ('e7500000-0000-4000-8000-0000000000b4'::uuid, 'e7c00000-0000-4000-8000-00000000000b'::uuid, 'e7d00000-0000-4000-8000-00000000000b'::uuid, 'tattoo_session', 'completed', interval '-3 days -5 hours', interval '4 hours', null, 'unpaid'),
  ('e7500000-0000-4000-8000-0000000000b3'::uuid, 'e7c00000-0000-4000-8000-00000000000b'::uuid, 'e7d00000-0000-4000-8000-00000000000b'::uuid, 'tattoo_session', 'completed', interval '-2 days -5 hours', interval '4 hours', null, 'unpaid'),
  ('e7500000-0000-4000-8000-0000000000b2'::uuid, 'e7c00000-0000-4000-8000-00000000000b'::uuid, 'e7d00000-0000-4000-8000-00000000000b'::uuid, 'tattoo_session', 'completed', interval '-1 days -5 hours', interval '4 hours', null, 'unpaid'),
  ('e7500000-0000-4000-8000-0000000000b1'::uuid, 'e7c00000-0000-4000-8000-00000000000b'::uuid, 'e7d00000-0000-4000-8000-00000000000b'::uuid, 'tattoo_session', 'completed', interval '-5 hours', interval '4 hours', null, 'unpaid'),
  -- C1: in progress; the client did not arrive.
  ('e7500000-0000-4000-8000-0000000000c1'::uuid, 'e7c00000-0000-4000-8000-00000000000c'::uuid, 'e7d00000-0000-4000-8000-00000000000c'::uuid, 'tattoo_session', 'confirmed', interval '-1 hour', interval '3 hours', null, 'unpaid'),
  -- D6..D11: finance cases, all on separate days.
  ('e7500000-0000-4000-8000-0000000000d6'::uuid, 'e7c00000-0000-4000-8000-00000000000d'::uuid, 'e7d00000-0000-4000-8000-00000000000d'::uuid, 'tattoo_session', 'completed', interval '-10 days', interval '5 hours', null, 'unpaid'),
  ('e7500000-0000-4000-8000-0000000000d7'::uuid, 'e7c00000-0000-4000-8000-00000000000d'::uuid, 'e7d00000-0000-4000-8000-00000000000d'::uuid, 'tattoo_session', 'completed', interval '-12 days', interval '7 hours', null, 'unpaid'),
  ('e7500000-0000-4000-8000-0000000000d8'::uuid, 'e7c00000-0000-4000-8000-00000000000d'::uuid, 'e7d00000-0000-4000-8000-00000000000d'::uuid, 'tattoo_session', 'completed', interval '-14 days', interval '7 hours', null, 'deposit_paid'),
  ('e7500000-0000-4000-8000-0000000000d9'::uuid, 'e7c00000-0000-4000-8000-00000000000d'::uuid, 'e7d00000-0000-4000-8000-00000000000d'::uuid, 'tattoo_session', 'completed', interval '-16 days', interval '4 hours', 600, 'unpaid'),
  ('e7500000-0000-4000-8000-0000000000da'::uuid, 'e7c00000-0000-4000-8000-00000000000d'::uuid, 'e7d00000-0000-4000-8000-00000000000d'::uuid, 'tattoo_session', 'completed', interval '-18 days', interval '4 hours', null, 'paid'),
  ('e7500000-0000-4000-8000-0000000000db'::uuid, 'e7c00000-0000-4000-8000-00000000000d'::uuid, 'e7d00000-0000-4000-8000-00000000000d'::uuid, 'tattoo_session', 'completed', interval '-20 days', interval '4 hours', null, 'unpaid'),
  -- Before the rollout: never a card.
  ('e7500000-0000-4000-8000-0000000000d0'::uuid, 'e7c00000-0000-4000-8000-00000000000d'::uuid, 'e7d00000-0000-4000-8000-00000000000d'::uuid, 'tattoo_session', 'completed', interval '-45 days', interval '4 hours', null, 'unpaid'),
  -- Consultations (free) and the client's existing tattoo booking.
  ('e7500000-0000-4000-8000-0000000000e1'::uuid, 'e7c00000-0000-4000-8000-00000000000e'::uuid, null, 'in_person_consultation', 'confirmed', interval '-3 hours', interval '30 minutes', null, 'unpaid'),
  ('e7500000-0000-4000-8000-0000000000e2'::uuid, 'e7c00000-0000-4000-8000-00000000000e'::uuid, 'e7d00000-0000-4000-8000-00000000000e'::uuid, 'tattoo_session', 'confirmed', interval '20 days', interval '6 hours', null, 'unpaid'),
  ('e7500000-0000-4000-8000-0000000000f1'::uuid, 'e7c00000-0000-4000-8000-00000000000f'::uuid, null, 'video_consultation', 'confirmed', interval '-26 hours', interval '30 minutes', null, 'unpaid'),
  ('e7500000-0000-4000-8000-0000000000f2'::uuid, 'e7c00000-0000-4000-8000-00000000000f'::uuid, null, 'in_person_consultation', 'confirmed', interval '-50 hours', interval '30 minutes', null, 'unpaid'),
  ('e7500000-0000-4000-8000-0000000000f3'::uuid, 'e7c00000-0000-4000-8000-00000000000f'::uuid, null, 'in_person_consultation', 'confirmed', interval '45 minutes', interval '30 minutes', null, 'unpaid')
) v(id, client_id, project_id, kind, status, start_offset, duration, price, pay);

-- Availability is governed by the scheduled start, not an arbitrary grace
-- period. These simulated clock instants use synthetic fixtures and make no
-- changes to the calendar or the production clock.
select ok(not exists (
  select 1 from crm_private.visit_outcome_due(
    (select id from t_vo_artist),
    (select start_at - interval '1 millisecond' from public.sessions where id = 'e7500000-0000-4000-8000-0000000000c1')) d
  where d.session_id = 'e7500000-0000-4000-8000-0000000000c1'),
  'session outcome is not offered before the scheduled start');
select ok(exists (
  select 1 from crm_private.visit_outcome_due(
    (select id from t_vo_artist),
    (select start_at from public.sessions where id = 'e7500000-0000-4000-8000-0000000000c1')) d
  where d.session_id = 'e7500000-0000-4000-8000-0000000000c1'),
  'session outcome is offered at the exact scheduled start');
select ok(exists (
  select 1 from crm_private.visit_outcome_due(
    (select id from t_vo_artist),
    (select start_at + interval '20 minutes' from public.sessions where id = 'e7500000-0000-4000-8000-0000000000c1')) d
  where d.session_id = 'e7500000-0000-4000-8000-0000000000c1'),
  'a 20-minute session can be confirmed without a 30-minute wait');
select ok(not exists (
  select 1 from crm_private.visit_outcome_due(
    (select id from t_vo_artist),
    (select end_at - interval '1 millisecond' from public.sessions where id = 'e7500000-0000-4000-8000-0000000000e1')) d
  where d.session_id = 'e7500000-0000-4000-8000-0000000000e1'),
  'free consultation outcome remains hidden before its scheduled end');
select ok(exists (
  select 1 from crm_private.visit_outcome_due(
    (select id from t_vo_artist),
    (select end_at from public.sessions where id = 'e7500000-0000-4000-8000-0000000000e1')) d
  where d.session_id = 'e7500000-0000-4000-8000-0000000000e1'),
  'free consultation outcome appears after its scheduled end');

-- D8: a £250 deposit already paid for this session.
insert into public.payment_requests (id, idempotency_key, artist_id, client_id, project_id,
  session_id, purpose, amount, currency, status)
values ('e7600000-0000-4000-8000-0000000000d8', 'e7610000-0000-4000-8000-0000000000d8',
  (select id from t_vo_artist), 'e7c00000-0000-4000-8000-00000000000d',
  'e7d00000-0000-4000-8000-00000000000d', 'e7500000-0000-4000-8000-0000000000d8',
  'deposit', 250, 'GBP', 'pending');
insert into public.payment_transactions (idempotency_key, payment_request_id, artist_id,
  transaction_type, direction, amount, currency, status, occurred_at, recorded_by, recorded_by_kind)
values ('e7620000-0000-4000-8000-0000000000d8', 'e7600000-0000-4000-8000-0000000000d8',
  (select id from t_vo_artist), 'manual_payment', 'credit', 250, 'GBP', 'succeeded',
  now() - interval '20 days', 'e7000000-0000-4000-8000-0000000000a1', 'human');

-- Lifecycle enrolment exactly as booking does it; the scheduler materialises
-- the jobs and sends what is due.
select crm_private.log_artist_activity((select id from t_vo_artist), 'appointment.scheduled', 'system',
  null, s.client_id, null, s.project_id, s.id, null,
  jsonb_build_object('appointment_type', s.appointment_type))
from public.sessions s
where s.id in ('e7500000-0000-4000-8000-0000000000a1', 'e7500000-0000-4000-8000-0000000000b1',
  'e7500000-0000-4000-8000-0000000000b2', 'e7500000-0000-4000-8000-0000000000b3',
  'e7500000-0000-4000-8000-0000000000b4', 'e7500000-0000-4000-8000-0000000000c1');

set local role service_role;
select lives_ok(
  $$select public.service_set_gmail_integration((select id from t_vo_artist),
     'google_gmail_visit_outcome_test', 'vo-artist@example.test',
     array['https://www.googleapis.com/auth/gmail.readonly',
           'https://www.googleapis.com/auth/gmail.send']::text[])$$,
  'synthetic Gmail route for rollback-only lifecycle checks');
select lives_ok($$select * from public.service_run_automation_tick(500)$$, 'scheduler tick before outcomes');
reset role;

create temporary table t_vo_mail_before as
select client_id, count(*)::int as n from public.email_messages
where client_id in ('e7c00000-0000-4000-8000-00000000000a', 'e7c00000-0000-4000-8000-00000000000b',
                    'e7c00000-0000-4000-8000-00000000000c')
group by client_id;
grant select on t_vo_mail_before to public;
create temporary table t_vo_outbox_before as
select count(*)::int as n from public.integration_outbox o
where o.kind in ('whatsapp_message', 'instagram_message', 'approved_email', 'transactional_email')
  and o.client_id in ('e7c00000-0000-4000-8000-00000000000a', 'e7c00000-0000-4000-8000-00000000000b',
                      'e7c00000-0000-4000-8000-00000000000c', 'e7c00000-0000-4000-8000-00000000000d',
                      'e7c00000-0000-4000-8000-00000000000e', 'e7c00000-0000-4000-8000-00000000000f');
grant select on t_vo_outbox_before to public;

-- -------------------------------------------- 4. auto-completed, unconfirmed
select is((select status::text from public.sessions where id = 'e7500000-0000-4000-8000-0000000000a1'),
  'completed', 'scenario 4: the scheduler completed the session by the clock');
select is((select count(*)::int from public.automation_jobs
           where session_id = 'e7500000-0000-4000-8000-0000000000a1'
             and message_purpose = 'post_session_aftercare' and status = 'completed'),
  1, 'scenario 4: the existing aftercare rule ran once');
select ok(exists (select 1 from jsonb_array_elements(crm_private.pulse_items((select id from t_vo_artist), true, true)) i
                  where i ->> 'key' = 'visit-outcome-e7500000-0000-4000-8000-0000000000a1'
                    and i ->> 'section' = 'visit_outcomes'
                    and i ->> 'reason' = 'visit_outcome_auto_completed'
                    and (i ->> 'urgent')::boolean = false),
  'scenario 4: an automatic completion still needs the artist outcome in Today');
select ok(not exists (select 1 from jsonb_array_elements(crm_private.pulse_items((select id from t_vo_artist), true, true)) i
                      where i ->> 'key' = 'visit-outcome-e7500000-0000-4000-8000-0000000000d0'),
  'rollout: visits that ended before the release create no retrospective card');
select ok(not exists (select 1 from jsonb_array_elements(crm_private.pulse_items((select id from t_vo_artist), true, true)) i
                      where i ->> 'key' = 'visit-outcome-e7500000-0000-4000-8000-0000000000f3'),
  'a consultation that has not finished is not asked about');
select is((select count(*)::int from jsonb_array_elements(crm_private.pulse_items((select id from t_vo_artist), true, true)) i
           where i ->> 'key' = 'visit-outcome-e7500000-0000-4000-8000-0000000000a1'),
  1, 'one card per appointment');
select ok(not exists (select 1 from jsonb_array_elements(crm_private.pulse_items((select id from t_vo_artist), true, true)) i
                      where i ->> 'key' like 'conflict-e7c00000-0000-4000-8000-00000000000f-past_session_unresolved'),
  'an unresolved past consultation is not also reported as a conflict');

-- ------------------------------------------------- 1, 6. cash in full
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a1');
set local role authenticated;
select is((public.get_visit_outcome_context('e7500000-0000-4000-8000-0000000000a1') -> 'finance' ->> 'due'),
  null, 'without a confirmed price the balance is not invented');
select is((public.get_visit_outcome_context('e7500000-0000-4000-8000-0000000000a1') ->> 'aftercare_sent')::boolean,
  true, 'context reports that aftercare was already sent');
create temporary table t_vo_a1 as
select public.record_visit_outcome('e7500000-0000-4000-8000-0000000000a1',
  'e7900000-0000-4000-8000-0000000000a1', 0, 'attended',
  jsonb_build_object('worked_minutes', 225, 'final_price', 700, 'received_now', 700,
                     'payment_method', 'cash', 'work_result', 'work_complete')) as r;
reset role;
grant select on t_vo_a1 to public;
select is((select r ->> 'payment_state' from t_vo_a1), 'paid', 'scenarios 1/6: cash in full is paid');
select is((select price from public.sessions where id = 'e7500000-0000-4000-8000-0000000000a1'),
  700::numeric, 'confirmed price is saved on the appointment');
select is((select payment_status::text from public.sessions where id = 'e7500000-0000-4000-8000-0000000000a1'),
  'paid', 'appointment badge reflects the ledger');
select is((select count(*)::int from public.payment_transactions t
           join public.payment_requests r on r.id = t.payment_request_id
           join public.invoice_line_items li on li.invoice_id = r.invoice_id
           where li.session_id = 'e7500000-0000-4000-8000-0000000000a1'),
  1, 'exactly one receipt is recorded');
select is((select r.payment_method_code from public.payment_requests r
           join public.invoice_line_items li on li.invoice_id = r.invoice_id
           where li.session_id = 'e7500000-0000-4000-8000-0000000000a1'),
  'cash', 'the receipt carries the payment method');
select is((select worked_minutes from public.visit_outcomes where session_id = 'e7500000-0000-4000-8000-0000000000a1'),
  225, 'actual working time is stored separately from the calendar slot');
select ok(not exists (select 1 from jsonb_array_elements(crm_private.pulse_items((select id from t_vo_artist), true, true)) i
                      where i ->> 'key' = 'visit-outcome-e7500000-0000-4000-8000-0000000000a1'),
  'the card leaves Today after saving');

-- --------------------------------------------- 14. repeated save (replay)
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a1');
set local role authenticated;
select is((public.record_visit_outcome('e7500000-0000-4000-8000-0000000000a1',
  'e7900000-0000-4000-8000-0000000000a1', 0, 'attended',
  jsonb_build_object('worked_minutes', 225, 'final_price', 700, 'received_now', 700,
                     'payment_method', 'cash', 'work_result', 'work_complete')) ->> 'replayed')::boolean,
  true, 'scenario 14: the same operation id replays the stored result');
select throws_ok($$select public.record_visit_outcome('e7500000-0000-4000-8000-0000000000a1',
  'e7900000-0000-4000-8000-0000000000a1', 0, 'attended',
  jsonb_build_object('worked_minutes', 225, 'final_price', 700, 'received_now', 600,
                     'payment_method', 'cash'))$$,
  '22023', null, 'scenario 14: an operation id cannot be reused for different terms');
-- ------------------------------------------- 15. concurrent edit (stale version)
select throws_ok($$select public.record_visit_outcome('e7500000-0000-4000-8000-0000000000a1',
  'e7900000-0000-4000-8000-00000000a1b2', 0, 'attended',
  jsonb_build_object('worked_minutes', 200, 'final_price', 700))$$,
  '40001', null, 'scenario 15: a second session with a stale version is refused');
reset role;
select is((select count(*)::int from public.payment_transactions t
           join public.payment_requests r on r.id = t.payment_request_id
           join public.invoice_line_items li on li.invoice_id = r.invoice_id
           where li.session_id = 'e7500000-0000-4000-8000-0000000000a1'),
  1, 'replays and refused requests add no money');

-- ---------------------------------------------------- 7. partial payment
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a1');
set local role authenticated;
select is((public.record_visit_outcome('e7500000-0000-4000-8000-0000000000d7',
  'e7900000-0000-4000-8000-0000000000d7', 0, 'attended',
  jsonb_build_object('worked_minutes', 420, 'final_price', 980, 'received_now', 500,
                     'payment_method', 'bank_transfer', 'work_result', 'next_session_needed')) ->> 'payment_state'),
  'part_paid', 'scenario 7: partial payment is part paid');
reset role;
select is((select outstanding from public.visit_outcomes where session_id = 'e7500000-0000-4000-8000-0000000000d7'),
  480::numeric, 'scenario 7: the remaining balance is kept');
select is((select payment_status::text from public.sessions where id = 'e7500000-0000-4000-8000-0000000000d7'),
  'part_paid', 'scenario 7: badge shows part paid');

-- ------------------------------------------------ 17. correction + history
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a1');
set local role authenticated;
select is((public.record_visit_outcome('e7500000-0000-4000-8000-0000000000d7',
  'e7900000-0000-4000-8000-000000000d71', 1, 'attended',
  jsonb_build_object('worked_minutes', 420, 'final_price', 980, 'received_now', 480,
                     'payment_method', 'cash', 'work_result', 'next_session_needed',
                     'notes', 'Balance paid at the start of the next visit')) ->> 'payment_state'),
  'paid', 'scenario 17: a correction can add the later balance');
select throws_ok($$select public.record_visit_outcome('e7500000-0000-4000-8000-0000000000d7',
  'e7900000-0000-4000-8000-000000000d72', 2, 'no_show', '{}'::jsonb)$$,
  '23514', null, 'scenario 17: money recorded here blocks turning the visit into a no-show');
select is(jsonb_array_length(public.list_visit_outcome_history('e7500000-0000-4000-8000-0000000000d7')),
  2, 'scenario 17: both versions are kept in history');
reset role;
select is((select count(*)::int from public.invoices i
           join public.invoice_line_items li on li.invoice_id = i.id
           where li.session_id = 'e7500000-0000-4000-8000-0000000000d7'),
  1, 'scenario 17: the correction reused the session invoice');
select is((select coalesce(sum(t.amount), 0) from public.payment_transactions t
           join public.payment_requests r on r.id = t.payment_request_id
           join public.invoice_line_items li on li.invoice_id = r.invoice_id
           where li.session_id = 'e7500000-0000-4000-8000-0000000000d7'),
  980::numeric, 'scenario 17: total receipts equal the price, no duplicate');
select throws_ok($$update public.visit_outcome_revisions set action = 'defer'$$,
  null, null, 'history is append-only');

-- ---------------------------------------------- 8. deposit plus balance
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a1');
set local role authenticated;
select is((public.get_visit_outcome_context('e7500000-0000-4000-8000-0000000000d8') -> 'finance' ->> 'deposit_paid')::numeric,
  250::numeric, 'scenario 8: the earlier deposit is read from the ledger');
select throws_ok($$select public.record_visit_outcome('e7500000-0000-4000-8000-0000000000d8',
  'e7900000-0000-4000-8000-000000000d80', 0, 'attended',
  jsonb_build_object('worked_minutes', 400, 'final_price', 980, 'received_now', 980, 'payment_method', 'cash'))$$,
  '23514', null, 'scenario 8: the deposit cannot be taken again as new money');
select is((public.record_visit_outcome('e7500000-0000-4000-8000-0000000000d8',
  'e7900000-0000-4000-8000-0000000000d8', 0, 'attended',
  jsonb_build_object('worked_minutes', 400, 'final_price', 980, 'received_now', 730, 'payment_method', 'cash')) ->> 'payment_state'),
  'paid', 'scenario 8: £980 = £250 deposit + £730 now');
reset role;
select is((select deposit_applied from public.visit_outcomes where session_id = 'e7500000-0000-4000-8000-0000000000d8'),
  250::numeric, 'scenario 8: deposit applied is recorded separately');
select is((select received_via_outcome from public.visit_outcomes where session_id = 'e7500000-0000-4000-8000-0000000000d8'),
  730::numeric, 'scenario 8: new income is only £730');
select is((select count(*)::int from public.payment_transactions
           where payment_request_id = 'e7600000-0000-4000-8000-0000000000d8'),
  1, 'scenario 8: the deposit transaction is untouched');

-- ------------------------------------ 9. bank transfer already registered
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a1');
set local role authenticated;
create temporary table t_vo_inv as
select (public.create_invoice('e7d00000-0000-4000-8000-00000000000d', 'e7630000-0000-4000-8000-0000000000d9',
          null, 'Existing bank transfer') ->> 'invoice_id')::uuid as id;
select public.set_invoice_line_item((select id from t_vo_inv), 'Tattoo session', 1, 600, null,
  'e7500000-0000-4000-8000-0000000000d9', null);
select public.issue_invoice((select id from t_vo_inv), null);
select public.record_invoice_payment((select id from t_vo_inv), 'e7640000-0000-4000-8000-0000000000d9',
  600, now() - interval '15 days', 'bank_transfer', null);
select throws_ok($$select public.record_visit_outcome('e7500000-0000-4000-8000-0000000000d9',
  'e7900000-0000-4000-8000-000000000d90', 0, 'attended',
  jsonb_build_object('worked_minutes', 240, 'final_price', 600, 'received_now', 50, 'payment_method', 'cash'))$$,
  '23514', null, 'scenario 9: nothing is left to collect after the registered transfer');
select is((public.record_visit_outcome('e7500000-0000-4000-8000-0000000000d9',
  'e7900000-0000-4000-8000-0000000000d9', 0, 'attended',
  jsonb_build_object('worked_minutes', 240, 'final_price', 600, 'received_now', 0)) ->> 'payment_state'),
  'paid', 'scenario 9: the registered transfer already settles the session');
reset role;
select is((select count(*)::int from public.payment_transactions t
           join public.payment_requests r on r.id = t.payment_request_id
           where r.invoice_id = (select id from t_vo_inv)),
  1, 'scenario 9: the bank transfer is not duplicated');

-- ----------------------------------------- 10. "Paid" badge, price missing
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a1');
set local role authenticated;
select is((public.record_visit_outcome('e7500000-0000-4000-8000-0000000000da',
  'e7900000-0000-4000-8000-0000000000da', 0, 'attended',
  jsonb_build_object('worked_minutes', 240, 'final_price', 500, 'paid_outside_crm', true)) ->> 'payment_state'),
  'paid', 'scenario 10: the missing price is filled without a new payment');
reset role;
select is((select count(*)::int from public.payment_requests where session_id = 'e7500000-0000-4000-8000-0000000000da')
          + (select count(*)::int from public.invoice_line_items where session_id = 'e7500000-0000-4000-8000-0000000000da'),
  0, 'scenario 10: no payment or invoice is created');
select is((select payment_status::text from public.sessions where id = 'e7500000-0000-4000-8000-0000000000da'),
  'paid', 'scenario 10: badge stays paid');

-- ------------------------------ ambiguous ledger: deposit not allocated
select pg_temp.as_backend();
insert into public.clients (id, full_name, email) values
  ('e7c00000-0000-4000-8000-000000000011', 'VO Unallocated Deposit', 'vo-g@example.test');
insert into public.projects (id, client_id, artist_id, status, title, hourly_rate, currency)
values ('e7d00000-0000-4000-8000-000000000011', 'e7c00000-0000-4000-8000-000000000011',
  (select id from t_vo_artist), 'active', 'VO unallocated', 140, 'GBP');
insert into public.sessions (id, artist_id, client_id, project_id, appointment_type, status,
  start_at, end_at, duration_hours, payment_status, currency, created_at)
values ('e7500000-0000-4000-8000-000000000011', (select id from t_vo_artist),
  'e7c00000-0000-4000-8000-000000000011', 'e7d00000-0000-4000-8000-000000000011',
  'tattoo_session', 'completed', date_trunc('hour', now()) - interval '22 days',
  date_trunc('hour', now()) - interval '22 days' + interval '4 hours', 4, 'deposit_paid', 'GBP',
  now() - interval '40 days');
insert into public.payment_requests (id, idempotency_key, artist_id, client_id, project_id,
  purpose, amount, currency, status)
values ('e7600000-0000-4000-8000-000000000011', 'e7610000-0000-4000-8000-000000000011',
  (select id from t_vo_artist), 'e7c00000-0000-4000-8000-000000000011',
  'e7d00000-0000-4000-8000-000000000011', 'deposit', 200, 'GBP', 'pending');
insert into public.payment_transactions (idempotency_key, payment_request_id, artist_id,
  transaction_type, direction, amount, currency, status, occurred_at, recorded_by, recorded_by_kind)
values ('e7620000-0000-4000-8000-000000000011', 'e7600000-0000-4000-8000-000000000011',
  (select id from t_vo_artist), 'manual_payment', 'credit', 200, 'GBP', 'succeeded',
  now() - interval '30 days', 'e7000000-0000-4000-8000-0000000000a1', 'human');
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a1');
set local role authenticated;
select ok((public.get_visit_outcome_context('e7500000-0000-4000-8000-000000000011') -> 'finance' -> 'warnings')
          ? 'unallocated_deposit',
  'a project deposit without a session allocation is reported for review');
select is(public.get_visit_outcome_context('e7500000-0000-4000-8000-000000000011') -> 'finance' ->> 'due',
  null, 'no balance is invented while the ledger needs review');
select throws_ok($$select public.record_visit_outcome('e7500000-0000-4000-8000-000000000011',
  'e7900000-0000-4000-8000-000000000110', 0, 'attended',
  jsonb_build_object('worked_minutes', 240, 'final_price', 560, 'received_now', 360, 'payment_method', 'cash'))$$,
  '23514', null, 'new money is refused until the deposit is reconciled');
select is((public.record_visit_outcome('e7500000-0000-4000-8000-000000000011',
  'e7900000-0000-4000-8000-000000000111', 0, 'attended',
  jsonb_build_object('worked_minutes', 240, 'final_price', 560)) ->> 'payment_state'),
  'needs_review', 'the outcome can still be saved, marked for review');
reset role;

-- ------------------------- finance capability is enforced on the server
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a3');
set local role authenticated;
select throws_ok($$select public.record_visit_outcome('e7500000-0000-4000-8000-0000000000db',
  'e7900000-0000-4000-8000-000000000db0', 0, 'attended',
  jsonb_build_object('worked_minutes', 240, 'final_price', 500))$$,
  '42501', null, 'a session manager without finance access cannot confirm money');
select is((public.record_visit_outcome('e7500000-0000-4000-8000-0000000000db',
  'e7900000-0000-4000-8000-0000000000db', 0, 'attended',
  jsonb_build_object('worked_minutes', 240)) ->> 'payment_state'),
  'not_recorded', 'attendance can be confirmed without finance access');
select is(public.get_visit_outcome_context('e7500000-0000-4000-8000-0000000000db') ->> 'finance',
  null, 'finance figures are hidden without view_finance');
reset role;

-- ------------------------------------------------ 16. other artist's records
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a2');
set local role authenticated;
select throws_ok($$select public.get_visit_outcome_context('e7500000-0000-4000-8000-0000000000a2')$$,
  '42501', null, 'scenario 16: another artist''s visit cannot be read');
select throws_ok($$select public.record_visit_outcome('e7500000-0000-4000-8000-0000000000a2',
  'e7900000-0000-4000-8000-000000000a20', 0, 'no_show', '{}'::jsonb)$$,
  '42501', null, 'scenario 16: another artist''s visit cannot be changed');
select throws_ok($$select public.record_visit_outcome('e7500000-0000-4000-8000-0000000000a1',
  'e7900000-0000-4000-8000-0000000000a1', 0, 'attended',
  jsonb_build_object('worked_minutes', 225, 'final_price', 700, 'received_now', 700,
                     'payment_method', 'cash', 'work_result', 'work_complete'))$$,
  '42501', null, 'scenario 16: a stored result is not replayed to another artist''s staff');
select throws_ok($$select count(*) from public.visit_outcomes$$,
  '42501', null, 'scenario 16: the table is not directly readable');
select ok(not exists (select 1 from jsonb_array_elements(public.get_today_pulse(null) -> 'items') i
                      where i ->> 'kind' = 'visit_outcome'
                        and i ->> 'artist_id' = (select id::text from t_vo_artist)),
  'scenario 16: Today never shows another artist''s visit cards');
reset role;

-- ----------------------------------------------------------- postpone
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a1');
set local role authenticated;
select is((public.defer_visit_outcome('e7500000-0000-4000-8000-0000000000a2',
  'e7900000-0000-4000-8000-0000000000a2', 0, now() + interval '3 hours') ->> 'state'),
  'deferred', 'the card can be postponed');
reset role;
select ok(not exists (select 1 from jsonb_array_elements(crm_private.pulse_items((select id from t_vo_artist), true, true)) i
                      where i ->> 'key' = 'visit-outcome-e7500000-0000-4000-8000-0000000000a2'),
  'a postponed card stays away until its time');
select ok(exists (select 1 from jsonb_array_elements(crm_private.pulse_items((select id from t_vo_artist), true, true,
                    now() + interval '4 hours')) i
                  where i ->> 'key' = 'visit-outcome-e7500000-0000-4000-8000-0000000000a2'),
  'a postponed card comes back when its time comes');
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a1');
set local role authenticated;
select throws_ok($$select public.defer_visit_outcome('e7500000-0000-4000-8000-0000000000a1',
  'e7900000-0000-4000-8000-000000000a1d', 1, now() + interval '3 hours')$$,
  '22023', null, 'a confirmed outcome cannot be postponed back into Today');
reset role;

-- -------------------------------------------- 5, 18. no-show, aftercare
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a1');
set local role authenticated;
select is((public.record_visit_outcome('e7500000-0000-4000-8000-0000000000c1',
  'e7900000-0000-4000-8000-0000000000c1', 0, 'no_show', '{}'::jsonb) ->> 'session_status'),
  'no_show', 'scenario 5: a no-show is recorded while the slot is still running');
reset role;
set local role service_role;
select pg_temp.as_backend();
select lives_ok($$select * from public.service_run_automation_tick(500)$$, 'scheduler tick after the no-show');
reset role;
select is((select count(*)::int from public.automation_jobs
           where session_id = 'e7500000-0000-4000-8000-0000000000c1'
             and message_purpose in ('post_session_aftercare', 'post_session_checkin')
             and status in ('pending', 'completed')),
  0, 'scenario 5: the scheduler withdrew aftercare and check-in for the no-show');
-- A later correction (the client did come) never releases the withdrawn messages.
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a1');
set local role authenticated;
select is((public.record_visit_outcome('e7500000-0000-4000-8000-0000000000c1',
  'e7900000-0000-4000-8000-0000000000c2', 1, 'attended',
  jsonb_build_object('worked_minutes', 60, 'final_price', 140)) ->> 'correction')::boolean,
  true, 'scenario 17: a no-show can be corrected');
reset role;
set local role service_role;
select pg_temp.as_backend();
select lives_ok($$select * from public.service_run_automation_tick(500)$$, 'scheduler tick after the correction');
reset role;
select is((select count(*)::int from public.automation_jobs
           where session_id = 'e7500000-0000-4000-8000-0000000000c1'
             and message_purpose = 'post_session_aftercare' and status = 'completed'),
  0, 'scenario 18: a correction does not send a withdrawn aftercare late');

-- ---------------------------------- 2, 3. consecutive sessions, no resend
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a1');
set local role authenticated;
select lives_ok($$select public.record_visit_outcome(s.id, md5('vo-block-' || s.id::text)::uuid, 0, 'attended',
  jsonb_build_object('worked_minutes', 240, 'final_price', 560, 'received_now', 560, 'payment_method', 'cash'))
  from public.sessions s where s.client_id = 'e7c00000-0000-4000-8000-00000000000b'$$,
  'scenarios 2/3: outcomes for four consecutive sessions are saved');
reset role;
select is((select count(*)::int from public.automation_jobs j
           join public.sessions s on s.id = j.session_id
           where s.client_id = 'e7c00000-0000-4000-8000-00000000000b'
             and j.message_purpose = 'post_session_aftercare' and j.status = 'completed'),
  1, 'scenarios 2/3: one aftercare guide for the whole consecutive block');
set local role service_role;
select pg_temp.as_backend();
select lives_ok($$select * from public.service_run_automation_tick(500)$$, 'scheduler tick after block outcomes');
reset role;
select ok((select coalesce(count(*), 0) from public.email_messages m
           where m.client_id = 'e7c00000-0000-4000-8000-00000000000b')
          = coalesce((select n from t_vo_mail_before where client_id = 'e7c00000-0000-4000-8000-00000000000b'), 0),
  'scenario 18: saving outcomes for the block sends no client email');
select ok((select coalesce(count(*), 0) from public.email_messages m
           where m.client_id = 'e7c00000-0000-4000-8000-00000000000a')
          = coalesce((select n from t_vo_mail_before where client_id = 'e7c00000-0000-4000-8000-00000000000a'), 0),
  'scenario 18: saving the single-session outcome sends no client email');
select is((select count(*)::int from public.integration_outbox o
           where o.kind in ('whatsapp_message', 'instagram_message', 'approved_email', 'transactional_email')
             and o.client_id in ('e7c00000-0000-4000-8000-00000000000a', 'e7c00000-0000-4000-8000-00000000000b',
                                 'e7c00000-0000-4000-8000-00000000000c', 'e7c00000-0000-4000-8000-00000000000d',
                                 'e7c00000-0000-4000-8000-00000000000e', 'e7c00000-0000-4000-8000-00000000000f')),
  (select n from t_vo_outbox_before),
  'scenario 18: outcomes and corrections queue no client email, WhatsApp or Instagram message');

-- -------------------------------------- 11, 13. consultation then booking
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a1');
set local role authenticated;
select is(jsonb_array_length(public.get_visit_outcome_context('e7500000-0000-4000-8000-0000000000e1') -> 'bookings'),
  1, 'scenario 13: the client''s existing tattoo booking is offered');
select is(public.get_visit_outcome_context('e7500000-0000-4000-8000-0000000000e1') ->> 'finance',
  null, 'consultations show no tattoo payment fields');
select throws_ok($$select public.record_visit_outcome('e7500000-0000-4000-8000-0000000000e1',
  'e7900000-0000-4000-8000-000000000e10', 0, 'booked', '{}'::jsonb)$$,
  '22023', null, 'scenario 11: "booked" needs an existing booking; no duplicate is created');
select throws_ok($$select public.record_visit_outcome('e7500000-0000-4000-8000-0000000000e1',
  'e7900000-0000-4000-8000-000000000e11', 0, 'booked',
  jsonb_build_object('linked_session_id', 'e7500000-0000-4000-8000-0000000000d6'))$$,
  '22023', null, 'scenario 13: another client''s booking cannot be linked');
select throws_ok($$select public.record_visit_outcome('e7500000-0000-4000-8000-0000000000e1',
  'e7900000-0000-4000-8000-000000000e12', 0, 'ready_to_book',
  jsonb_build_object('final_price', 50))$$,
  '22023', null, 'consultations are free: payment fields are refused');
select is((public.record_visit_outcome('e7500000-0000-4000-8000-0000000000e1',
  'e7900000-0000-4000-8000-0000000000e1', 0, 'booked',
  jsonb_build_object('linked_session_id', 'e7500000-0000-4000-8000-0000000000e2')) ->> 'session_status'),
  'completed', 'scenarios 11/13: the consultation is linked to the existing booking');
reset role;
select is((select count(*)::int from public.sessions where client_id = 'e7c00000-0000-4000-8000-00000000000e'),
  2, 'scenario 13: no duplicate booking is created');
select is((select linked_session_id from public.visit_outcomes where session_id = 'e7500000-0000-4000-8000-0000000000e1'),
  'e7500000-0000-4000-8000-0000000000e2'::uuid, 'the link is stored');

-- --------------------------------------------- 12. consultation, thinking
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a1');
set local role authenticated;
select throws_ok($$select public.record_visit_outcome('e7500000-0000-4000-8000-0000000000f3',
  'e7900000-0000-4000-8000-000000000f30', 0, 'thinking', '{}'::jsonb)$$,
  '22023', null, 'a consultation that has not finished cannot be closed');
create temporary table t_vo_f1 as
select public.record_visit_outcome('e7500000-0000-4000-8000-0000000000f1',
  'e7900000-0000-4000-8000-0000000000f1', 0, 'thinking',
  jsonb_build_object('follow_up_at', (now() + interval '7 days')::text)) as r;
select is((public.record_visit_outcome('e7500000-0000-4000-8000-0000000000f1',
  'e7900000-0000-4000-8000-0000000000f1', 0, 'thinking',
  jsonb_build_object('follow_up_at', (now() + interval '7 days')::text)) ->> 'replayed')::boolean,
  true, 'scenario 12: pressing save again replays');
reset role;
grant select on t_vo_f1 to public;
select is((select count(*)::int from public.follow_ups
           where client_id = 'e7c00000-0000-4000-8000-00000000000f'),
  1, 'scenario 12: one confirmed follow-up, never a duplicate');
select is((select status::text from public.sessions where id = 'e7500000-0000-4000-8000-0000000000f1'),
  'completed', 'scenario 12: the consultation is marked as held');
select is((select count(*)::int from public.enquiries where client_id = 'e7c00000-0000-4000-8000-00000000000f'),
  0, 'scenario 12: a consultation outcome does not invent an enquiry');

-- Correcting the consultation moves its one reminder; a later "declined" cancels it.
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a1');
set local role authenticated;
select lives_ok($$select public.record_visit_outcome('e7500000-0000-4000-8000-0000000000f1',
  'e7900000-0000-4000-8000-000000000f11', 1, 'thinking',
  jsonb_build_object('follow_up_at', (now() + interval '14 days')::text, 'notes', 'Wants a smaller size'))$$,
  'a consultation outcome can be corrected');
reset role;
select is((select count(*)::int from public.follow_ups
           where client_id = 'e7c00000-0000-4000-8000-00000000000f' and status = 'open'),
  1, 'a corrected reminder date moves the existing reminder, no duplicate');
select is((select artist_id from public.follow_ups where client_id = 'e7c00000-0000-4000-8000-00000000000f' limit 1),
  (select id from t_vo_artist), 'the reminder is created on the appointment artist, not re-derived from the client');
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a1');
set local role authenticated;
select lives_ok($$select public.record_visit_outcome('e7500000-0000-4000-8000-0000000000f1',
  'e7900000-0000-4000-8000-000000000f12', 2, 'declined', '{}'::jsonb)$$,
  'the outcome can change to declined');
reset role;
select is((select count(*)::int from public.follow_ups
           where client_id = 'e7c00000-0000-4000-8000-00000000000f' and status = 'open'),
  0, 'an obsolete reminder is cancelled when the new outcome needs none');

-- A manager without finance access corrects time and notes; money facts stay.
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a3');
set local role authenticated;
select lives_ok($$select public.record_visit_outcome('e7500000-0000-4000-8000-0000000000d7',
  'e7900000-0000-4000-8000-000000000d73', 2, 'attended',
  jsonb_build_object('worked_minutes', 410, 'work_result', 'next_session_needed', 'notes', 'Time corrected'))$$,
  'a session manager without finance access can correct the working time');
reset role;
select is((select final_price || ' ' || payment_state || ' ' || outstanding
           from public.visit_outcomes where session_id = 'e7500000-0000-4000-8000-0000000000d7'),
  '980.00 paid 0.00', 'confirmed price, payment state and balance are preserved');
select is((select worked_minutes from public.visit_outcomes where session_id = 'e7500000-0000-4000-8000-0000000000d7'),
  410, 'the corrected time is saved');

-- Consultation no-show.
select pg_temp.as_profile('e7000000-0000-4000-8000-0000000000a1');
set local role authenticated;
select is((public.record_visit_outcome('e7500000-0000-4000-8000-0000000000f2',
  'e7900000-0000-4000-8000-0000000000f2', 0, 'no_show', '{}'::jsonb) ->> 'session_status'),
  'no_show', 'a consultation no-show sets the appointment status');
reset role;
select ok(not exists (select 1 from jsonb_array_elements(crm_private.pulse_items((select id from t_vo_artist), true, true)) i
                      where i ->> 'key' in ('visit-outcome-e7500000-0000-4000-8000-0000000000f2',
                                            'visit-outcome-e7500000-0000-4000-8000-0000000000f1',
                                            'visit-outcome-e7500000-0000-4000-8000-0000000000e1')),
  'closed consultation cards do not come back');

-- API surface.
select ok(has_function_privilege('authenticated', 'public.record_visit_outcome(uuid,uuid,integer,text,jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.record_visit_outcome(uuid,uuid,integer,text,jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.get_visit_outcome_context(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'crm_private.visit_session_finance(uuid,numeric)', 'execute'),
  'only signed-in CRM users reach the outcome RPCs; private helpers stay private');
select * from finish(true);
rollback;
