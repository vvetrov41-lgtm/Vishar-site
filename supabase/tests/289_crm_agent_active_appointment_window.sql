-- Regression coverage for the active-appointment window used by CRM AI.
begin;
select no_plan();

select ok(
  position('s.end_at >= clock_timestamp()' in lower(pg_get_functiondef(
    'crm_private.client_has_scheduled_appointment(uuid,uuid)'::regprocedure))) > 0,
  'historical proposed/confirmed sessions do not suppress later intake forever');

select ok(
  position('s.status in (''proposed'', ''confirmed'')' in lower(pg_get_functiondef(
    'crm_private.client_has_scheduled_appointment(uuid,uuid)'::regprocedure))) > 0
  and position('s.cancelled_at is null' in lower(pg_get_functiondef(
    'crm_private.client_has_scheduled_appointment(uuid,uuid)'::regprocedure))) > 0,
  'only live proposed/confirmed non-cancelled appointments count as scheduled');

select * from finish();
rollback;
