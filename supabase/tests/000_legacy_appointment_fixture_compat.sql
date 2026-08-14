-- 000_legacy_appointment_fixture_compat.sql
--
-- Migration 0031 adds a strict five-minute boundary trigger to sessions.
-- Older pgTAP files intentionally create synthetic sessions from arbitrary
-- `now()` values while testing unrelated RLS, payment, ownership and workflow
-- behaviour. Those legacy fixtures predate the time-grid constraint and can
-- otherwise fail before reaching the behaviour they are meant to exercise.
--
-- Keep production enforcement unchanged. This test-only bootstrap disables
-- only the new trigger for the legacy pgTAP files. The dedicated
-- 183_appointment_five_minute_step.sql test re-enables the real sessions
-- trigger outside its rollback transaction before validating the strict
-- five-minute function, so later tests also run with enforcement restored.

select no_plan();

alter table public.sessions
  disable trigger sessions_validate_appointment_time_step;

select pass(
  'legacy pgTAP fixtures run without the migration-0031 trigger until dedicated test 183'
);

select * from finish(true);
