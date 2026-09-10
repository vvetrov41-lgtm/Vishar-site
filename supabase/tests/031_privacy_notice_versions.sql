-- 031_privacy_notice_versions.sql
--
-- Regression coverage for the durable intake privacy gate. The live public
-- form may submit the current notice while an already-open tab may still carry
-- the immediately previous version during a rolling deployment.

begin;
select plan(2);

select ok(
  strpos(
    pg_get_functiondef('public.create_enquiry_intake(uuid,jsonb,jsonb,jsonb)'::regprocedure),
    'v_privacy_version not in (''2026-07-29'', ''2026-09-09'')'
  ) > 0,
  'intake accepts exactly the previous and current privacy notice versions during rollout'
);

select ok(
  strpos(
    pg_get_functiondef('public.create_enquiry_intake(uuid,jsonb,jsonb,jsonb)'::regprocedure),
    'v_privacy_version <> ''2026-07-29'''
  ) = 0,
  'the obsolete single-version privacy gate is removed'
);

select * from finish();
rollback;
