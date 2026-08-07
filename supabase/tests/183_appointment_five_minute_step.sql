-- Restore migration-0031 enforcement before the dedicated five-minute tests.
-- This is intentionally outside the rollback transaction so every later pgTAP
-- file also sees the real sessions trigger enabled.
alter table public.sessions
  enable trigger sessions_validate_appointment_time_step;

begin;

select plan(12);

select has_function(
  'crm_private',
  'validate_appointment_time_step',
  array[]::text[],
  'five-minute appointment validator exists'
);

select has_trigger(
  'public',
  'sessions',
  'sessions_validate_appointment_time_step',
  'sessions enforce five-minute appointment boundaries'
);

create temporary table appointment_time_step_probe (
  id integer primary key,
  start_at timestamptz not null,
  end_at timestamptz not null,
  notes text
);

-- Simulate retained rows created before migration 0031. Each old boundary must
-- remain valid until that specific boundary is changed.
insert into appointment_time_step_probe (id, start_at, end_at, notes) values
  (1, '2026-08-10 09:01:00+00', '2026-08-10 09:06:00+00', 'legacy one'),
  (2, '2026-08-10 10:01:00+00', '2026-08-10 10:06:00+00', 'legacy two'),
  (3, '2026-08-10 11:01:00+00', '2026-08-10 11:06:00+00', 'legacy three');

create trigger appointment_time_step_probe_validate
  before insert or update of start_at, end_at
  on appointment_time_step_probe
  for each row execute function crm_private.validate_appointment_time_step();

select lives_ok(
  $$insert into appointment_time_step_probe values (10, '2026-08-10 12:00:00+00', '2026-08-10 12:05:00+00', 'aligned')$$,
  'aligned appointment times are accepted'
);

select throws_ok(
  $$insert into appointment_time_step_probe values (11, '2026-08-10 13:01:00+00', '2026-08-10 13:05:00+00', 'bad start')$$,
  '22023',
  'appointment times must use five-minute increments',
  'misaligned appointment start is rejected on creation'
);

select throws_ok(
  $$insert into appointment_time_step_probe values (12, '2026-08-10 14:00:00+00', '2026-08-10 14:06:00+00', 'bad end')$$,
  '22023',
  'appointment times must use five-minute increments',
  'misaligned appointment end is rejected on creation'
);

select throws_ok(
  $$insert into appointment_time_step_probe values (13, '2026-08-10 15:00:00.001+00', '2026-08-10 15:05:00+00', 'sub-minute')$$,
  '22023',
  'appointment times must use five-minute increments',
  'seconds and microseconds cannot bypass the five-minute grid'
);

select lives_ok(
  $$update appointment_time_step_probe set end_at = '2026-08-10 12:10:00+00' where id = 10$$,
  'aligned appointment reschedule is accepted'
);

select throws_ok(
  $$update appointment_time_step_probe set end_at = '2026-08-10 12:07:00+00' where id = 10$$,
  '22023',
  'appointment times must use five-minute increments',
  'misaligned appointment reschedule is rejected'
);

select lives_ok(
  $$update appointment_time_step_probe set notes = 'unchanged legacy schedule' where id = 1$$,
  'unrelated updates preserve a retained off-grid appointment'
);

select lives_ok(
  $$update appointment_time_step_probe set start_at = '2026-08-10 09:00:00+00' where id = 1$$,
  'an aligned start change does not invalidate an untouched legacy end'
);

select lives_ok(
  $$update appointment_time_step_probe set end_at = '2026-08-10 10:10:00+00' where id = 2$$,
  'an aligned end change does not invalidate an untouched legacy start'
);

select throws_ok(
  $$update appointment_time_step_probe set start_at = '2026-08-10 11:02:00+00' where id = 3$$,
  '22023',
  'appointment times must use five-minute increments',
  'a changed legacy boundary must join the five-minute grid'
);

select * from finish();
rollback;
