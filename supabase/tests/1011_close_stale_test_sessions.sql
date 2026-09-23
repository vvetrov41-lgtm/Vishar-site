-- 1011_close_stale_test_sessions.sql
--
-- Audit L-4: a past, still-open session whose enquiry is excluded from
-- Statistics is closed through the same transition set_appointment_status
-- uses, audited, idempotently, and without reaching any provider.
-- Everything is synthetic and rolled back.

begin;
select no_plan();

insert into public.clients (id, full_name, email) values
  ('fc111111-1111-4111-8111-111111111111', 'L4 Test Client', 'l4-client@example.test');

insert into public.enquiries (
  id, client_id, reference_number, idempotency_key, intake_fingerprint,
  intake_state, submitted_full_name, submitted_email,
  privacy_notice_version, privacy_acknowledged_at, artist_id,
  excluded_from_analytics
) values
  ('fc200000-0000-4000-8000-000000000001', 'fc111111-1111-4111-8111-111111111111',
   'ENQ-2099-9811', 'fc300000-0000-4000-8000-000000000001', repeat('c', 64), 'complete',
   'L4 Test Client', 'l4-client@example.test', '2026-07-29', now(),
   'a1111111-1111-4111-8111-111111111111', true),
  ('fc200000-0000-4000-8000-000000000002', 'fc111111-1111-4111-8111-111111111111',
   'ENQ-2099-9812', 'fc300000-0000-4000-8000-000000000002', repeat('d', 64), 'complete',
   'L4 Test Client', 'l4-client@example.test', '2026-07-29', now(),
   'a1111111-1111-4111-8111-111111111111', false);

insert into public.projects (id, client_id, artist_id, enquiry_id, title, description) values
  ('fc400000-0000-4000-8000-000000000001', 'fc111111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'fc200000-0000-4000-8000-000000000001', 'L4 test', 'rollback only'),
  ('fc400000-0000-4000-8000-000000000002', 'fc111111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'fc200000-0000-4000-8000-000000000002', 'L4 real', 'rollback only');

insert into public.sessions (id, artist_id, client_id, enquiry_id, project_id, appointment_type, status, start_at, end_at, duration_hours)
select v.id, 'a1111111-1111-4111-8111-111111111111', 'fc111111-1111-4111-8111-111111111111',
       v.enquiry_id, v.project_id, 'tattoo_session', v.status::public.session_status,
       date_trunc('hour', now()) + v.lead, date_trunc('hour', now()) + v.lead + interval '2 hours', 2
from (values
  ('fc000000-0000-4000-8000-000000000001'::uuid, 'confirmed', interval '-16 days',
   'fc200000-0000-4000-8000-000000000001'::uuid, 'fc400000-0000-4000-8000-000000000001'::uuid),
  ('fc000000-0000-4000-8000-000000000002'::uuid, 'proposed', interval '-15 days',
   'fc200000-0000-4000-8000-000000000001'::uuid, 'fc400000-0000-4000-8000-000000000001'::uuid),
  ('fc000000-0000-4000-8000-000000000003'::uuid, 'confirmed', interval '-15 days',
   'fc200000-0000-4000-8000-000000000002'::uuid, 'fc400000-0000-4000-8000-000000000002'::uuid),
  ('fc000000-0000-4000-8000-000000000004'::uuid, 'confirmed', interval '10 days',
   'fc200000-0000-4000-8000-000000000001'::uuid, 'fc400000-0000-4000-8000-000000000001'::uuid)
) as v(id, status, lead, enquiry_id, project_id);

create temporary table t_outbox_before as select count(*)::int as n from public.integration_outbox;

select is(crm_private.close_stale_test_session('fc000000-0000-4000-8000-000000000001', 'audit_l4_test'),
  'closed', 'a past confirmed test session is closed');
select is(crm_private.close_stale_test_session('fc000000-0000-4000-8000-000000000002', 'audit_l4_test'),
  'closed', 'a past proposed test session is closed');
select is(crm_private.close_stale_test_session('fc000000-0000-4000-8000-000000000001', 'audit_l4_test'),
  'already_closed', 'closing twice is a no-op');
select is(crm_private.close_stale_test_session('fc000000-0000-4000-8000-000000000003', 'audit_l4_test'),
  'not_marked_test', 'a session whose enquiry counts in Statistics is refused');
select is(crm_private.close_stale_test_session('fc000000-0000-4000-8000-000000000004', 'audit_l4_test'),
  'not_past', 'a future session is refused');
select is(crm_private.close_stale_test_session('fc000000-0000-4000-8000-0000000000ff', 'audit_l4_test'),
  'not_found', 'an unknown session is refused');
select throws_ok(
  $$select crm_private.close_stale_test_session('fc000000-0000-4000-8000-000000000003', 'Bad Reason')$$,
  '22023', null, 'a reason code is required');

select set_eq(
  $$select s.id::text, s.status::text, (s.cancelled_at is not null)
    from public.sessions s where s.client_id = 'fc111111-1111-4111-8111-111111111111'$$,
  $$values
      ('fc000000-0000-4000-8000-000000000001', 'cancelled', true),
      ('fc000000-0000-4000-8000-000000000002', 'cancelled', true),
      ('fc000000-0000-4000-8000-000000000003', 'confirmed', false),
      ('fc000000-0000-4000-8000-000000000004', 'confirmed', false)$$,
  'only the two test sessions change, and nothing is deleted');

select set_eq(
  $$select l.session_id::text as sid, l.metadata ->> 'from_status' as f, l.metadata ->> 'to_status' as t
    from public.activity_log l
    where l.client_id = 'fc111111-1111-4111-8111-111111111111'
      and l.event_type = 'appointment.status_changed'
      and l.actor_kind = 'system'
      and l.metadata ->> 'close_reason' = 'audit_l4_test'$$,
  $$values
      ('fc000000-0000-4000-8000-000000000001', 'confirmed', 'cancelled'),
      ('fc000000-0000-4000-8000-000000000002', 'proposed', 'cancelled')$$,
  'each close writes one audited status change');

select is((select count(*)::int from public.integration_outbox), (select n from t_outbox_before),
  'closing reaches no provider');

select ok(
  not has_function_privilege('service_role', 'crm_private.close_stale_test_session(uuid,text)', 'execute')
  and not has_function_privilege('authenticated', 'crm_private.close_stale_test_session(uuid,text)', 'execute')
  and not has_function_privilege('anon', 'crm_private.close_stale_test_session(uuid,text)', 'execute'),
  'no API role can call the close helper');

select * from finish();
rollback;
