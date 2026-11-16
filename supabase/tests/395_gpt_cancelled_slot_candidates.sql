-- 395_gpt_cancelled_slot_candidates.sql
-- Fill a cancelled slot, stage 3: the ChatGPT plugin reads the same list as
-- the CRM panel, only for the active GPT artist and a human OAuth token.
-- Synthetic rows only, always rolled back.
begin;
select no_plan();

select ok(
  has_function_privilege('authenticated', 'public.gpt_list_cancelled_slot_candidates(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.gpt_list_cancelled_slot_candidates(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.gpt_list_cancelled_slot_candidates(uuid)', 'execute'),
  'GPT slot candidates need an authenticated human'
);

insert into auth.users (id, email) values
  ('e9510000-0000-4000-8000-0000000000a1', 'slot-gpt-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('e9510000-0000-4000-8000-0000000000a1', 'slot-gpt-owner@example.test', 'Slot GPT Owner', 'owner', true);

insert into public.clients (id, workspace_id, full_name, email, phone)
select v.id::uuid, a.workspace_id, v.name, v.email, v.phone
from (values
  ('e9510000-0000-4000-8000-000000000c01', 'a1111111-1111-4111-8111-111111111111', 'Sid Canceller', 'slot-gpt-s@example.test', null),
  ('e9510000-0000-4000-8000-000000000c02', 'a1111111-1111-4111-8111-111111111111', 'Dora Deposit', 'slot-gpt-d@example.test', '+447700900002'),
  ('e9510000-0000-4000-8000-000000000c03', 'a2222222-2222-4222-8222-222222222222', 'Kit Canceller', 'slot-gpt-k@example.test', null)
) v(id, artist, name, email, phone)
join public.artists a on a.id = v.artist::uuid;

insert into public.projects (id, client_id, artist_id, status, title, deposit_status, estimated_hours, estimated_sessions, currency) values
  ('e9510000-0000-4000-8000-000000000d01', 'e9510000-0000-4000-8000-000000000c01', 'a1111111-1111-4111-8111-111111111111', 'active', 'Slot GPT own', 'paid', 6, 1, 'GBP'),
  ('e9510000-0000-4000-8000-000000000d02', 'e9510000-0000-4000-8000-000000000c02', 'a1111111-1111-4111-8111-111111111111', 'active', 'Slot GPT deposit', 'paid', 6, 1, 'GBP'),
  ('e9510000-0000-4000-8000-000000000d03', 'e9510000-0000-4000-8000-000000000c03', 'a2222222-2222-4222-8222-222222222222', 'active', 'Slot GPT Kristina', 'paid', 6, 1, 'GBP');

insert into public.sessions (id, artist_id, client_id, project_id, appointment_type, status, start_at, end_at, duration_hours, cancelled_at) values
  ('e9510000-0000-4000-8000-000000000e01', 'a1111111-1111-4111-8111-111111111111',
   'e9510000-0000-4000-8000-000000000c01', 'e9510000-0000-4000-8000-000000000d01', 'tattoo_session', 'cancelled',
   date_trunc('day', now()) + interval '37 days 3 hours', date_trunc('day', now()) + interval '37 days 9 hours', 6, now() - interval '1 hour'),
  ('e9510000-0000-4000-8000-000000000e02', 'a2222222-2222-4222-8222-222222222222',
   'e9510000-0000-4000-8000-000000000c03', 'e9510000-0000-4000-8000-000000000d03', 'tattoo_session', 'cancelled',
   date_trunc('day', now()) + interval '38 days 3 hours', date_trunc('day', now()) + interval '38 days 9 hours', 6, now() - interval '1 hour');

create function pg_temp.gpt_claims(p text) returns void language sql as $f$
  select set_config('request.jwt.claims', p, true)::void;
$f$;
grant execute on function pg_temp.gpt_claims(text) to authenticated;

create temporary table t_slot_gpt_before as
select (select count(*) from public.automation_jobs) as jobs,
       (select count(*) from public.integration_outbox) as outbox;

set local role authenticated;
select pg_temp.gpt_claims('{"sub":"e9510000-0000-4000-8000-0000000000a1","role":"authenticated"}');
select lives_ok(
  $$select public.configure_gpt_action_client('vishar-unified-gpt', 'oauth-slot-fill-395', true, true)$$,
  'owner enables a human authenticated GPT client for this test'
);
select lives_ok(
  $$select public.configure_gpt_full_management('vishar-unified-gpt', true, false, true)$$,
  'CRM management allowed, finance disabled'
);

select pg_temp.gpt_claims('{"sub":"e9510000-0000-4000-8000-0000000000a1","role":"authenticated"}');
select throws_ok(
  $$select public.gpt_list_cancelled_slot_candidates('e9510000-0000-4000-8000-000000000e01')$$,
  '42501', null, 'a CRM session without the GPT OAuth client cannot use the GPT wrapper'
);

select pg_temp.gpt_claims('{"sub":"e9510000-0000-4000-8000-0000000000a1","role":"authenticated","client_id":"oauth-slot-fill-395"}');
select lives_ok(
  $$select public.gpt_artist_context('a1111111-1111-4111-8111-111111111111')$$,
  'owner selects Vladimir with the GPT context'
);
select is(
  public.gpt_list_cancelled_slot_candidates('e9510000-0000-4000-8000-000000000e01'),
  public.list_cancelled_slot_candidates('e9510000-0000-4000-8000-000000000e01'),
  'GPT wrapper returns exactly what the CRM panel reads'
);
select ok(
  public.gpt_list_cancelled_slot_candidates('e9510000-0000-4000-8000-000000000e01')->'candidates'
    @> '[{"client_id":"e9510000-0000-4000-8000-000000000c02","reason":"deposit_paid_no_date"}]'::jsonb,
  'paid deposit without a date is offered to the plugin'
);
select throws_ok(
  $$select public.gpt_list_cancelled_slot_candidates('e9510000-0000-4000-8000-000000000e02')$$,
  '42501', null, 'Kristina''s slot is outside the active Vladimir GPT scope'
);
select throws_ok(
  $$select public.gpt_list_cancelled_slot_candidates('e9510000-0000-4000-8000-0000000000ff')$$,
  '42501', null, 'unknown appointment is refused without revealing anything'
);

reset role;
select is((select count(*) from public.automation_jobs), (select jobs from t_slot_gpt_before), 'reading queues no automation job');
select is((select count(*) from public.integration_outbox), (select outbox from t_slot_gpt_before), 'reading queues no outbound message');

select * from finish(true);
rollback;
