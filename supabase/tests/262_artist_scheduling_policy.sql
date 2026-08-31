-- 262_artist_scheduling_policy.sql
--
-- The booking-type conflict policy, asserted where it is actually enforced.
--
-- Before 0120 the authoritative path checked artist time off and nothing else:
-- two tattoo sessions could occupy the same seven hours, and the only overlap
-- protection was an advisory read plus a checkbox in the browser. These tests
-- exist so that cannot regress silently, and so the deliberately permissive
-- half - a consultation alongside a tattoo session - is pinned as a rule
-- rather than surviving as an accident.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated, service_role;

create function pg_temp.as_owner() returns void language sql as $$
  select pg_temp.claims('{"sub":"fb111111-1111-4111-8111-111111111111","role":"authenticated"}');
$$;
grant execute on function pg_temp.as_owner() to authenticated, service_role;

insert into auth.users (id, email) values
  ('fb111111-1111-4111-8111-111111111111', 'scheduling-owner@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('fb111111-1111-4111-8111-111111111111', 'scheduling-owner@example.test',
   'Scheduling Owner', 'owner', true);

insert into public.clients (id, full_name, email) values
  ('fb311111-1111-4111-8111-111111111111', 'Scheduling Client', null),
  ('fb322222-2222-4222-8222-222222222222', 'Second Scheduling Client', null);

set local role authenticated;
select pg_temp.as_owner();

-- ---------------------------------------------------------------------------
-- Defaults exist without anybody visiting a settings screen
-- ---------------------------------------------------------------------------

select is(
  (public.get_artist_scheduling_preferences('a1111111-1111-4111-8111-111111111111')
    ->> 'tattoo_earliest_start'),
  '09:00',
  'an artist has a usable earliest tattoo start without configuring anything'
);

select is(
  (public.get_artist_scheduling_preferences('a1111111-1111-4111-8111-111111111111')
    ->> 'consultation_during_tattoo')::boolean,
  true,
  'consultations during a tattoo session are permitted by default, as this studio works'
);

select is(
  (public.get_artist_scheduling_preferences('a1111111-1111-4111-8111-111111111111')
    -> 'tattoo_preferred_starts'),
  '["09:00", "10:00", "11:00"]'::jsonb,
  'the habitual starts are the ones the studio actually uses'
);

-- ---------------------------------------------------------------------------
-- Tattoo vs tattoo: BLOCK
-- ---------------------------------------------------------------------------

select lives_ok(
  $$select public.schedule_appointment(
      'a1111111-1111-4111-8111-111111111111',
      'fb311111-1111-4111-8111-111111111111',
      'tattoo_session',
      '2026-09-14 10:00:00+00'::timestamptz,
      '2026-09-14 17:00:00+00'::timestamptz,
      'confirmed')$$,
  'a seven-hour tattoo session books into a free day'
);

select throws_ok(
  $$select public.schedule_appointment(
      'a1111111-1111-4111-8111-111111111111',
      'fb322222-2222-4222-8222-222222222222',
      'tattoo_session',
      '2026-09-14 14:00:00+00'::timestamptz,
      '2026-09-14 18:00:00+00'::timestamptz,
      'confirmed')$$,
  '22023',
  'another tattoo session already occupies this time',
  'a second tattoo session overlapping the first is refused by the database'
);

select lives_ok(
  $$select public.schedule_appointment(
      'a1111111-1111-4111-8111-111111111111',
      'fb322222-2222-4222-8222-222222222222',
      'tattoo_session',
      '2026-09-14 17:00:00+00'::timestamptz,
      '2026-09-14 19:00:00+00'::timestamptz,
      'confirmed')$$,
  'a tattoo session starting exactly when the previous one ends is allowed, because the range is half-open'
);

select throws_ok(
  $$select public.schedule_appointment(
      'a1111111-1111-4111-8111-111111111111',
      'fb322222-2222-4222-8222-222222222222',
      'touch_up',
      '2026-09-14 11:00:00+00'::timestamptz,
      '2026-09-14 12:00:00+00'::timestamptz,
      'confirmed')$$,
  '22023',
  'another tattoo session already occupies this time',
  'a touch-up is tattoo work and cannot overlap a tattoo session'
);

-- ---------------------------------------------------------------------------
-- Consultation vs tattoo: ALLOW. This is the rule that makes the studio work.
-- ---------------------------------------------------------------------------

select lives_ok(
  $$select public.schedule_appointment(
      'a1111111-1111-4111-8111-111111111111',
      'fb322222-2222-4222-8222-222222222222',
      'in_person_consultation',
      '2026-09-14 09:00:00+00'::timestamptz,
      '2026-09-14 09:30:00+00'::timestamptz,
      'confirmed')$$,
  'a consultation before the tattoo session is allowed'
);

select lives_ok(
  $$select public.schedule_appointment(
      'a1111111-1111-4111-8111-111111111111',
      'fb322222-2222-4222-8222-222222222222',
      'in_person_consultation',
      '2026-09-14 13:00:00+00'::timestamptz,
      '2026-09-14 13:30:00+00'::timestamptz,
      'confirmed')$$,
  'a consultation DURING the tattoo session is allowed by the explicit policy'
);

-- ---------------------------------------------------------------------------
-- Consultation vs consultation: BLOCK beyond the cap
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select public.schedule_appointment(
      'a1111111-1111-4111-8111-111111111111',
      'fb311111-1111-4111-8111-111111111111',
      'video_consultation',
      '2026-09-14 13:15:00+00'::timestamptz,
      '2026-09-14 13:45:00+00'::timestamptz,
      'confirmed')$$,
  '22023',
  'another consultation already occupies this time',
  'a second overlapping consultation is refused, so consultations cannot stack without limit'
);

-- ---------------------------------------------------------------------------
-- Time off blocks both families
-- ---------------------------------------------------------------------------

select lives_ok(
  $$select public.create_artist_availability_block(
      'a1111111-1111-4111-8111-111111111111',
      'day_off',
      '2026-09-20 00:00:00+00'::timestamptz,
      '2026-09-21 00:00:00+00'::timestamptz,
      true, 'Scheduling policy test day off')$$,
  'a day off is recorded'
);

select throws_ok(
  $$select public.schedule_appointment(
      'a1111111-1111-4111-8111-111111111111',
      'fb311111-1111-4111-8111-111111111111',
      'tattoo_session',
      '2026-09-20 10:00:00+00'::timestamptz,
      '2026-09-20 16:00:00+00'::timestamptz,
      'confirmed')$$,
  '22023',
  'artist availability blocks this time',
  'time off still blocks a tattoo session'
);

select throws_ok(
  $$select public.schedule_appointment(
      'a1111111-1111-4111-8111-111111111111',
      'fb311111-1111-4111-8111-111111111111',
      'in_person_consultation',
      '2026-09-20 10:00:00+00'::timestamptz,
      '2026-09-20 10:30:00+00'::timestamptz,
      'confirmed')$$,
  '22023',
  'artist availability blocks this time',
  'time off blocks a consultation too - a day away is a day away'
);

-- ---------------------------------------------------------------------------
-- The advisory read agrees with the write path
-- ---------------------------------------------------------------------------

select is(
  (select count(*) from public.list_booking_conflicts(
     'a1111111-1111-4111-8111-111111111111',
     'in_person_consultation',
     '2026-09-14 13:00:00+00'::timestamptz,
     '2026-09-14 13:20:00+00'::timestamptz)
   where blocks),
  1::bigint,
  'the advisory read flags the overlapping consultation as blocking, not the tattoo session'
);

select is(
  (select count(*) from public.list_booking_conflicts(
     'a1111111-1111-4111-8111-111111111111',
     'tattoo_session',
     '2026-09-14 12:00:00+00'::timestamptz,
     '2026-09-14 13:00:00+00'::timestamptz)
   where blocks),
  1::bigint,
  'for a tattoo session the overlapping tattoo session is what blocks'
);

-- ---------------------------------------------------------------------------
-- Preferences are editable, and turning the policy off restores exclusivity
-- ---------------------------------------------------------------------------

select lives_ok(
  $$select public.set_artist_scheduling_preferences(
      'a1111111-1111-4111-8111-111111111111',
      '08:00', '19:00', array['08:00','10:00'],
      '08:00', '20:00', false, 1)$$,
  'an operator with manage_sessions can change the artist scheduling preferences'
);

select is(
  (public.get_artist_scheduling_preferences('a1111111-1111-4111-8111-111111111111')
    ->> 'tattoo_earliest_start'),
  '08:00',
  'the stored earliest start is what is read back'
);

select throws_ok(
  $$select public.schedule_appointment(
      'a1111111-1111-4111-8111-111111111111',
      'fb311111-1111-4111-8111-111111111111',
      'in_person_consultation',
      '2026-09-14 15:00:00+00'::timestamptz,
      '2026-09-14 15:30:00+00'::timestamptz,
      'confirmed')$$,
  '22023',
  'this artist does not take consultations during a tattoo session',
  'with consultation_during_tattoo off, the permissive rule stops applying'
);

-- ---------------------------------------------------------------------------
-- Per-day overrides are their own concept, not overloaded time off
-- ---------------------------------------------------------------------------

select lives_ok(
  $$select public.set_artist_schedule_override(
      'a1111111-1111-4111-8111-111111111111',
      '2026-09-15'::date, '08:00', '15:00', 'Early finish')$$,
  'a per-day override records a different working window'
);

select is(
  (select tattoo_latest_finish from public.list_artist_schedule_overrides(
     'a1111111-1111-4111-8111-111111111111',
     '2026-09-15'::date, '2026-09-15'::date)),
  '15:00',
  'the override is read back for that day only'
);

select lives_ok(
  $$select public.set_artist_schedule_override(
      'a1111111-1111-4111-8111-111111111111', '2026-09-15'::date, null, null, null)$$,
  'clearing both boundaries removes the override rather than storing a row that says nothing'
);

select is(
  (select count(*) from public.list_artist_schedule_overrides(
     'a1111111-1111-4111-8111-111111111111',
     '2026-09-15'::date, '2026-09-15'::date)),
  0::bigint,
  'the cleared override is gone'
);

-- ---------------------------------------------------------------------------
-- Direct table access stays closed
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select 1 from public.artist_scheduling_preferences limit 1$$,
  '42501',
  null,
  'scheduling preferences are reachable only through their RPCs'
);

select throws_ok(
  $$select 1 from public.artist_schedule_overrides limit 1$$,
  '42501',
  null,
  'schedule overrides are reachable only through their RPCs'
);

select * from finish();
rollback;
