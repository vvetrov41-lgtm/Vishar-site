-- 031_privacy_notice_versions.sql
--
-- Regression coverage for the durable intake privacy gate. A rolling release
-- may briefly have tabs open on either of the two immediately preceding
-- notices while the current form submits the newest version. 2026-10-12 is
-- Kristina's own notice (kristinavishar.com/privacy/).

begin;
select plan(2);

select ok(
  strpos(
    pg_get_functiondef('public.create_enquiry_intake(uuid,jsonb,jsonb,jsonb)'::regprocedure),
    'v_privacy_version not in (''2026-07-29'', ''2026-09-09'', ''2026-09-14'', ''2026-10-12'')'
  ) > 0,
  'intake accepts the previous and current notice versions, including Kristina''s 2026-10-12 notice'
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
