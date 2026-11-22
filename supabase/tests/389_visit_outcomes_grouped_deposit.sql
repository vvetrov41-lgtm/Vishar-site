-- 389_visit_outcomes_grouped_deposit.sql
-- One deposit paid for several sessions (a deposit group) is allocated to each
-- session by its member row. The first visit outcome release treated such a
-- payment as "unallocated" and refused to compute a balance. Covers: the share
-- of a fully paid group counts once, the other members are untouched, a session
-- outside the group gets no deposit, an incomplete group asks for review, and
-- recording an independent receipt never touches the deposit transaction.
-- Synthetic rows, rolled back; no provider call.
begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table t_gd_artist as
select a.id from public.artists a
join crm_private.artist_state st on st.artist_id = a.id and st.is_active
where a.slug = 'vladimir';
grant select on t_gd_artist to public;

insert into auth.users (id, email) values
  ('e8000000-0000-4000-8000-0000000000a1', 'gd-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('e8000000-0000-4000-8000-0000000000a1', 'gd-owner@example.test', 'GD Owner', 'owner', true);

create function pg_temp.as_profile(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    jsonb_build_object('sub', p, 'role', 'authenticated')::text, true)::void;
$$;
grant execute on function pg_temp.as_profile(uuid) to public;

insert into public.clients (id, full_name, email) values
  ('e8c00000-0000-4000-8000-00000000000a', 'GD Grouped Deposit', 'gd-a@example.test'),
  ('e8c00000-0000-4000-8000-00000000000b', 'GD Incomplete Group', 'gd-b@example.test');

insert into public.projects (id, client_id, artist_id, status, title, hourly_rate, currency)
select v.id, v.client_id, (select id from t_gd_artist), 'active', v.title, 140, 'GBP'
from (values
  ('e8d00000-0000-4000-8000-00000000000a'::uuid, 'e8c00000-0000-4000-8000-00000000000a'::uuid, 'GD full group'),
  ('e8d00000-0000-4000-8000-00000000000b'::uuid, 'e8c00000-0000-4000-8000-00000000000b'::uuid, 'GD partial group')
) v(id, client_id, title);

-- Project A: four sessions in the group (first one already held) and a fifth
-- session that is not part of the group. Project B: one group, only part paid.
insert into public.sessions
  (id, artist_id, client_id, project_id, appointment_type, status, start_at, end_at,
   duration_hours, price, payment_status, currency, created_at)
select v.id, (select id from t_gd_artist), v.client_id, v.project_id,
       'tattoo_session', v.status::public.session_status,
       date_trunc('hour', now()) + v.start_offset,
       date_trunc('hour', now()) + v.start_offset + interval '7 hours',
       7, 980, 'deposit_paid', 'GBP', now() - interval '40 days'
from (values
  ('e8500000-0000-4000-8000-0000000000a1'::uuid, 'e8c00000-0000-4000-8000-00000000000a'::uuid, 'e8d00000-0000-4000-8000-00000000000a'::uuid, 'completed', interval '-10 hours'),
  ('e8500000-0000-4000-8000-0000000000a2'::uuid, 'e8c00000-0000-4000-8000-00000000000a'::uuid, 'e8d00000-0000-4000-8000-00000000000a'::uuid, 'confirmed', interval '1 day'),
  ('e8500000-0000-4000-8000-0000000000a3'::uuid, 'e8c00000-0000-4000-8000-00000000000a'::uuid, 'e8d00000-0000-4000-8000-00000000000a'::uuid, 'confirmed', interval '14 days'),
  ('e8500000-0000-4000-8000-0000000000a4'::uuid, 'e8c00000-0000-4000-8000-00000000000a'::uuid, 'e8d00000-0000-4000-8000-00000000000a'::uuid, 'confirmed', interval '15 days'),
  ('e8500000-0000-4000-8000-0000000000a5'::uuid, 'e8c00000-0000-4000-8000-00000000000a'::uuid, 'e8d00000-0000-4000-8000-00000000000a'::uuid, 'completed', interval '-5 days'),
  ('e8500000-0000-4000-8000-0000000000b1'::uuid, 'e8c00000-0000-4000-8000-00000000000b'::uuid, 'e8d00000-0000-4000-8000-00000000000b'::uuid, 'completed', interval '-3 days'),
  ('e8500000-0000-4000-8000-0000000000b2'::uuid, 'e8c00000-0000-4000-8000-00000000000b'::uuid, 'e8d00000-0000-4000-8000-00000000000b'::uuid, 'confirmed', interval '10 days')
) v(id, client_id, project_id, status, start_offset);

insert into public.artist_payment_policies (
  id, artist_id, version, deposit_mode, fixed_amount, payment_deadline_hours,
  transfer_allowed, refund_policy_version, is_active, created_by
) values (
  'e8900000-0000-4000-8000-000000000001', (select id from t_gd_artist), 9001,
  'fixed', 250.00, 72, true, 'v1', false, 'e8000000-0000-4000-8000-0000000000a1');

insert into public.payment_requests (id, idempotency_key, artist_id, client_id, project_id,
  purpose, amount, currency, status)
values
  ('e8600000-0000-4000-8000-0000000000a1', 'e8610000-0000-4000-8000-0000000000a1',
   (select id from t_gd_artist), 'e8c00000-0000-4000-8000-00000000000a',
   'e8d00000-0000-4000-8000-00000000000a', 'deposit', 1000, 'GBP', 'pending'),
  ('e8600000-0000-4000-8000-0000000000b1', 'e8610000-0000-4000-8000-0000000000b1',
   (select id from t_gd_artist), 'e8c00000-0000-4000-8000-00000000000b',
   'e8d00000-0000-4000-8000-00000000000b', 'deposit', 500, 'GBP', 'pending');

insert into public.payment_transactions (idempotency_key, payment_request_id, artist_id,
  transaction_type, direction, amount, currency, status, occurred_at, recorded_by, recorded_by_kind)
values
  ('e8620000-0000-4000-8000-0000000000a1', 'e8600000-0000-4000-8000-0000000000a1',
   (select id from t_gd_artist), 'manual_payment', 'credit', 1000, 'GBP', 'succeeded',
   now() - interval '20 days', 'e8000000-0000-4000-8000-0000000000a1', 'human'),
  -- Group B asked for 500 but only 200 reached the ledger.
  ('e8620000-0000-4000-8000-0000000000b1', 'e8600000-0000-4000-8000-0000000000b1',
   (select id from t_gd_artist), 'manual_payment', 'credit', 200, 'GBP', 'succeeded',
   now() - interval '20 days', 'e8000000-0000-4000-8000-0000000000a1', 'human');

insert into public.session_deposit_groups (id, artist_id, client_id, project_id, payment_request_id,
  idempotency_key, currency, total_amount, session_count, policy_id, policy_version, created_by)
values
  ('e8700000-0000-4000-8000-0000000000a1', (select id from t_gd_artist), 'e8c00000-0000-4000-8000-00000000000a',
   'e8d00000-0000-4000-8000-00000000000a', 'e8600000-0000-4000-8000-0000000000a1',
   'e8710000-0000-4000-8000-0000000000a1', 'GBP', 1000, 4, 'e8900000-0000-4000-8000-000000000001', 9001,
   'e8000000-0000-4000-8000-0000000000a1'),
  ('e8700000-0000-4000-8000-0000000000b1', (select id from t_gd_artist), 'e8c00000-0000-4000-8000-00000000000b',
   'e8d00000-0000-4000-8000-00000000000b', 'e8600000-0000-4000-8000-0000000000b1',
   'e8710000-0000-4000-8000-0000000000b1', 'GBP', 500, 2, 'e8900000-0000-4000-8000-000000000001', 9001,
   'e8000000-0000-4000-8000-0000000000a1');

insert into public.session_deposit_group_members (group_id, session_id, artist_id, amount, currency, duration_minutes)
select 'e8700000-0000-4000-8000-0000000000a1', s.id, s.artist_id, 250, 'GBP', 420
from public.sessions s
where s.id in ('e8500000-0000-4000-8000-0000000000a1', 'e8500000-0000-4000-8000-0000000000a2',
               'e8500000-0000-4000-8000-0000000000a3', 'e8500000-0000-4000-8000-0000000000a4');
insert into public.session_deposit_group_members (group_id, session_id, artist_id, amount, currency, duration_minutes)
select 'e8700000-0000-4000-8000-0000000000b1', s.id, s.artist_id, 250, 'GBP', 420
from public.sessions s
where s.id in ('e8500000-0000-4000-8000-0000000000b1', 'e8500000-0000-4000-8000-0000000000b2');

-- ------------------------------------------------ the first held session
select pg_temp.as_profile('e8000000-0000-4000-8000-0000000000a1');
set local role authenticated;

select is((public.get_visit_outcome_context('e8500000-0000-4000-8000-0000000000a1') -> 'finance' ->> 'deposit_paid')::numeric,
  250::numeric, 'a grouped deposit gives this session exactly its own share');
select is(jsonb_array_length(public.get_visit_outcome_context('e8500000-0000-4000-8000-0000000000a1') -> 'finance' -> 'warnings'),
  0, 'a deposit group is not reported as unallocated');
select is((public.get_visit_outcome_context('e8500000-0000-4000-8000-0000000000a1') -> 'finance' ->> 'due')::numeric,
  730::numeric, 'the balance is the price minus the session share, not minus the whole £1000');

select throws_ok($$select public.record_visit_outcome('e8500000-0000-4000-8000-0000000000a1',
  'e8900000-0000-4000-8000-0000000000f1', 0, 'attended',
  jsonb_build_object('worked_minutes', 420, 'final_price', 980, 'received_now', 980, 'payment_method', 'cash'))$$,
  '23514', null, 'the deposit share cannot be taken again as new money');

select is((public.record_visit_outcome('e8500000-0000-4000-8000-0000000000a1',
  'e8900000-0000-4000-8000-0000000000f2', 0, 'attended',
  jsonb_build_object('worked_minutes', 420, 'final_price', 980, 'received_now', 730, 'payment_method', 'cash',
                     'work_result', 'next_session_needed')) ->> 'payment_state'),
  'paid', '£980 = £250 deposit share + £730 now is paid in full');
reset role;

select is((select deposit_applied from public.visit_outcomes where session_id = 'e8500000-0000-4000-8000-0000000000a1'),
  250::numeric, 'the deposit share is stored as the deposit applied');
select is((select received_via_outcome from public.visit_outcomes where session_id = 'e8500000-0000-4000-8000-0000000000a1'),
  730::numeric, 'new income is only £730');
select is((select count(*)::int from public.payment_transactions
           where payment_request_id = 'e8600000-0000-4000-8000-0000000000a1'),
  1, 'the deposit transaction is untouched');
select is((select coalesce(sum(t.amount), 0) from public.payment_transactions t
           join public.payment_requests r on r.id = t.payment_request_id
           where r.project_id = 'e8d00000-0000-4000-8000-00000000000a'),
  1730::numeric, 'project receipts are the £1000 deposit plus £730, nothing duplicated');
select is((select payment_status::text from public.sessions where id = 'e8500000-0000-4000-8000-0000000000a1'),
  'paid', 'the appointment badge follows the ledger');

-- --------------------------------------- the other members are unaffected
select pg_temp.as_profile('e8000000-0000-4000-8000-0000000000a1');
set local role authenticated;
select is((public.get_visit_outcome_context('e8500000-0000-4000-8000-0000000000a2') -> 'finance' ->> 'deposit_paid')::numeric,
  250::numeric, 'the next session still has its own £250 share');
select is((public.get_visit_outcome_context('e8500000-0000-4000-8000-0000000000a4') -> 'finance' ->> 'due')::numeric,
  730::numeric, 'the last session still owes £730 after its share');

-- ------------------------ a session outside the group has no deposit share
select is((public.get_visit_outcome_context('e8500000-0000-4000-8000-0000000000a5') -> 'finance' ->> 'deposit_paid')::numeric,
  0::numeric, 'a session that is not a group member gets no deposit');
select is(jsonb_array_length(public.get_visit_outcome_context('e8500000-0000-4000-8000-0000000000a5') -> 'finance' -> 'warnings'),
  0, 'and the group is not an ambiguity for it');
select is((public.get_visit_outcome_context('e8500000-0000-4000-8000-0000000000a5') -> 'finance' ->> 'due')::numeric,
  980::numeric, 'so its balance is the full price');

-- ----------------------- a group that is only partly paid asks for review
select ok((public.get_visit_outcome_context('e8500000-0000-4000-8000-0000000000b1') -> 'finance' -> 'warnings')
          ? 'unallocated_deposit',
  'a partly paid group is not attributed to a session');
select is((public.record_visit_outcome('e8500000-0000-4000-8000-0000000000b1',
  'e8900000-0000-4000-8000-0000000000f3', 0, 'attended',
  jsonb_build_object('worked_minutes', 420, 'final_price', 980, 'received_now', 500, 'payment_method', 'cash')) ->> 'payment_state'),
  'needs_review', 'the receipt is saved and the balance still needs a group allocation review');
select is((public.get_visit_outcome_context('e8500000-0000-4000-8000-0000000000b1')
  -> 'finance' ->> 'invoiced_paid')::numeric, 500::numeric,
  'the independent cash receipt is counted once');
reset role;

select * from finish(true);
rollback;
