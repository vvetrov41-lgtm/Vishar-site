-- 394_cancelled_slot_candidates.sql
-- Fill a cancelled slot: for a cancelled appointment whose time is still
-- ahead and free, list up to five clients who could take it, with reason,
-- fit, contact and a draft message. Read-only: nothing is sent, queued or
-- written. Every row is synthetic and rolled back.
begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table t_sf_artist as
select a.id, a.timezone, a.workspace_id from public.artists a
join crm_private.artist_state st on st.artist_id = a.id and st.is_active
where a.slug = 'vladimir';
grant select on t_sf_artist to public;

insert into auth.users (id, email) values
  ('e9400000-0000-4000-8000-0000000000a1', 'sf-manager@example.test'),
  ('e9400000-0000-4000-8000-0000000000a2', 'sf-other-artist@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('e9400000-0000-4000-8000-0000000000a1', 'sf-manager@example.test', 'SF Manager', 'booking_manager', true),
  ('e9400000-0000-4000-8000-0000000000a2', 'sf-other-artist@example.test', 'SF Other', 'booking_manager', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level, can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('e9400000-0000-4000-8000-0000000000a1', (select id from t_sf_artist),
   'manager', false, false, true, false, true),
  ('e9400000-0000-4000-8000-0000000000a2', 'a2222222-2222-4222-8222-222222222222',
   'manager', true, true, true, false, true);

create function pg_temp.as_profile(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    jsonb_build_object('sub', p, 'role', 'authenticated')::text, true)::void;
$$;
grant execute on function pg_temp.as_profile(uuid) to public;

-- Slot day: ten days ahead, 11:00-17:00 in the artist's time zone.
create temporary table t_sf_day as
select ((now() at time zone (select timezone from t_sf_artist))::date + 10) as d;
grant select on t_sf_day to public;
create function pg_temp.local_at(p_days int, p_time time) returns timestamptz language sql stable as $$
  select (((select d from t_sf_day) + p_days) + p_time) at time zone (select timezone from t_sf_artist);
$$;
grant execute on function pg_temp.local_at(int, time) to public;

-- ---------------------------------------------------------------- fixtures
insert into public.clients (id, full_name, email, phone, workspace_id)
select v.*, (select workspace_id from t_sf_artist) from (values
  ('e9c00000-0000-4000-8000-000000000001'::uuid, 'Sam Canceller', 'sf-s@example.test', null::text),
  ('e9c00000-0000-4000-8000-000000000002', 'Dana Deposit', 'sf-d@example.test', '+447700900001'),
  ('e9c00000-0000-4000-8000-000000000003', 'Bea Booked', 'sf-b@example.test', null),
  ('e9c00000-0000-4000-8000-000000000004', 'Theo Touchup', 'sf-t@example.test', null),
  ('e9c00000-0000-4000-8000-000000000005', 'Una Unsubscribed', 'sf-u@example.test', null),
  ('e9c00000-0000-4000-8000-000000000006', 'Pat Project', 'sf-p@example.test', null),
  ('e9c00000-0000-4000-8000-000000000007', 'Eve Enquiry', 'sf-e@example.test', null),
  ('e9c00000-0000-4000-8000-000000000008', 'Archie Archived', 'sf-a@example.test', null)
) v(id, full_name, email, phone);

insert into public.projects (id, client_id, artist_id, status, title, deposit_status, estimated_hours, estimated_sessions, currency)
select v.id, v.client_id, (select id from t_sf_artist), v.status::public.project_status, v.title,
       v.dep::public.deposit_status, v.hours, v.sessions, 'GBP'
from (values
  ('e9d00000-0000-4000-8000-000000000001'::uuid, 'e9c00000-0000-4000-8000-000000000001'::uuid, 'active', 'SF own', 'paid', 6::numeric, 1),
  ('e9d00000-0000-4000-8000-000000000002'::uuid, 'e9c00000-0000-4000-8000-000000000002'::uuid, 'active', 'SF deposit', 'paid', 10::numeric, 2),
  ('e9d00000-0000-4000-8000-000000000003'::uuid, 'e9c00000-0000-4000-8000-000000000003'::uuid, 'active', 'SF booked', 'paid', 6::numeric, 1),
  ('e9d00000-0000-4000-8000-000000000004'::uuid, 'e9c00000-0000-4000-8000-000000000004'::uuid, 'active', 'SF touch', 'not_required', null, null),
  ('e9d00000-0000-4000-8000-000000000005'::uuid, 'e9c00000-0000-4000-8000-000000000005'::uuid, 'active', 'SF unsub', 'paid', 6::numeric, 1),
  ('e9d00000-0000-4000-8000-000000000006'::uuid, 'e9c00000-0000-4000-8000-000000000006'::uuid, 'active', 'SF long', 'requested', 8::numeric, 1),
  ('e9d00000-0000-4000-8000-000000000008'::uuid, 'e9c00000-0000-4000-8000-000000000008'::uuid, 'active', 'SF archived', 'paid', 6::numeric, 1)
) v(id, client_id, status, title, dep, hours, sessions);

update public.clients set archived_at = now() where id = 'e9c00000-0000-4000-8000-000000000008';

insert into public.communication_suppressions (client_id, channel, reason, is_active)
values ('e9c00000-0000-4000-8000-000000000005', 'whatsapp', 'unsubscribed', true);

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, idea, privacy_notice_version,
  privacy_acknowledged_at, created_at
) values ('e9e00000-0000-4000-8000-000000000007', 'e9c00000-0000-4000-8000-000000000007',
  (select id from t_sf_artist), 'SF-394-0007', 'e9e00000-0000-4000-8000-0000000000f7',
  repeat('7', 64), 'reviewing', 'complete', 'Eve Enquiry', 'sf-e@example.test',
  'Small fine-line piece', '2026-01-01', now() - interval '5 days', now() - interval '5 days');

insert into public.sessions
  (id, artist_id, client_id, project_id, appointment_type, status, start_at, end_at,
   duration_hours, currency, cancelled_at)
select v.id, (select id from t_sf_artist), v.client_id, v.project_id,
       v.kind::public.appointment_type, v.status::public.session_status,
       v.start_at, v.end_at, extract(epoch from v.end_at - v.start_at) / 3600, 'GBP',
       case when v.status = 'cancelled' then now() - interval '1 hour' end
from (values
  -- The cancelled tattoo slot.
  ('e9500000-0000-4000-8000-000000000001'::uuid, 'e9c00000-0000-4000-8000-000000000001'::uuid, 'e9d00000-0000-4000-8000-000000000001'::uuid,
   'tattoo_session', 'cancelled', pg_temp.local_at(0, '11:00'), pg_temp.local_at(0, '17:00')),
  -- Bea already has a future session.
  ('e9500000-0000-4000-8000-000000000002'::uuid, 'e9c00000-0000-4000-8000-000000000003'::uuid, 'e9d00000-0000-4000-8000-000000000003'::uuid,
   'tattoo_session', 'confirmed', pg_temp.local_at(20, '11:00'), pg_temp.local_at(20, '17:00')),
  -- Theo finished his tattoo eight weeks before the slot.
  ('e9500000-0000-4000-8000-000000000003'::uuid, 'e9c00000-0000-4000-8000-000000000004'::uuid, 'e9d00000-0000-4000-8000-000000000004'::uuid,
   'tattoo_session', 'completed', pg_temp.local_at(-56, '11:00'), pg_temp.local_at(-56, '15:00')),
  -- A cancelled consultation slot five days after the tattoo slot.
  ('e9500000-0000-4000-8000-000000000004'::uuid, 'e9c00000-0000-4000-8000-000000000001'::uuid, null,
   'in_person_consultation', 'cancelled', pg_temp.local_at(5, '10:00'), pg_temp.local_at(5, '10:30')),
  -- A cancelled slot already in the past.
  ('e9500000-0000-4000-8000-000000000005'::uuid, 'e9c00000-0000-4000-8000-000000000001'::uuid, null,
   'in_person_consultation', 'cancelled', date_trunc('hour', now()) - interval '2 days', date_trunc('hour', now()) - interval '2 days' + interval '30 minutes'),
  -- A cancelled slot that another booking has since taken.
  ('e9500000-0000-4000-8000-000000000006'::uuid, 'e9c00000-0000-4000-8000-000000000001'::uuid, null,
   'in_person_consultation', 'cancelled', pg_temp.local_at(6, '10:00'), pg_temp.local_at(6, '10:30')),
  ('e9500000-0000-4000-8000-000000000007'::uuid, 'e9c00000-0000-4000-8000-000000000003'::uuid, null,
   'in_person_consultation', 'confirmed', pg_temp.local_at(6, '10:00'), pg_temp.local_at(6, '10:30'))
) v(id, client_id, project_id, kind, status, start_at, end_at);

-- Snapshot what could change, to prove the read writes nothing.
create temporary table t_sf_before as
select (select count(*) from public.sessions) s, (select count(*) from public.follow_ups) f,
       (select count(*) from public.integration_outbox) o;
grant select on t_sf_before to public;

-- ---------------------------------------------------------------- access
set local role anon;
select throws_ok(
  $$select public.list_cancelled_slot_candidates('e9500000-0000-4000-8000-000000000001')$$,
  '42501', null, 'anon cannot read slot candidates');
reset role;

set local role authenticated;
select pg_temp.as_profile('e9400000-0000-4000-8000-0000000000a2');
select throws_ok(
  $$select public.list_cancelled_slot_candidates('e9500000-0000-4000-8000-000000000001')$$,
  '42501', null, 'a member of another artist cannot read slot candidates');

select pg_temp.as_profile('e9400000-0000-4000-8000-0000000000a1');
select throws_ok(
  $$select public.list_cancelled_slot_candidates('e9500000-0000-4000-8000-0000000000ff')$$,
  '23503', null, 'an unknown appointment is reported as missing');

-- ---------------------------------------------------------------- tattoo slot
create temporary table t_sf_tattoo as
select public.list_cancelled_slot_candidates('e9500000-0000-4000-8000-000000000001') as r;

select is((select r #>> '{slot,state}' from t_sf_tattoo), 'open', 'a future free cancelled slot is open');
select is((select r #>> '{slot,duration_hours}' from t_sf_tattoo)::numeric, 6::numeric, 'slot length is six hours');

select is(
  (select array_agg(c ->> 'client_name' order by ord) from t_sf_tattoo,
     jsonb_array_elements(r -> 'candidates') with ordinality as x(c, ord)),
  array['Dana Deposit', 'Theo Touchup', 'Pat Project'],
  'deposit without a date first, then touch-up due, then project without a date');

select is(
  (select array_agg(c ->> 'reason' order by ord) from t_sf_tattoo,
     jsonb_array_elements(r -> 'candidates') with ordinality as x(c, ord)),
  array['deposit_paid_no_date', 'touch_up_due', 'project_no_date'],
  'each candidate carries its reason');

select is(
  (select array_agg(c ->> 'fit' order by ord) from t_sf_tattoo,
     jsonb_array_elements(r -> 'candidates') with ordinality as x(c, ord)),
  array['fits', 'fits', 'longer'],
  'five hours per session fits, a touch-up fits, an eight-hour session is longer');

select is(
  (select (r -> 'candidates' -> 0 ->> 'phone') from t_sf_tattoo), '+447700900001',
  'the candidate phone is returned for a manual message');

select ok(
  (select (r -> 'candidates' -> 0 ->> 'draft_message') like 'Hi Dana, a slot has just opened up on % from 11:00 to 17:00.%' from t_sf_tattoo),
  'the draft greets the client by first name with the slot time in the artist time zone');

select ok(
  (select (r -> 'candidates' -> 1 ->> 'draft_message') like '%touch-up%' from t_sf_tattoo),
  'the touch-up draft talks about a touch-up');

select ok(
  not exists (
    select 1 from t_sf_tattoo, jsonb_array_elements(r -> 'candidates') c
    where c ->> 'client_name' in ('Sam Canceller', 'Bea Booked', 'Una Unsubscribed', 'Archie Archived', 'Eve Enquiry')
  ),
  'own client, already booked, unsubscribed, archived and consultation-only clients are left out');

-- ---------------------------------------------------------------- consultation slot
select is(
  (select array_agg(c ->> 'client_name')
     from jsonb_array_elements(public.list_cancelled_slot_candidates('e9500000-0000-4000-8000-000000000004') -> 'candidates') c),
  array['Eve Enquiry'],
  'a consultation slot is offered to a recent enquiry still waiting for a consultation');

select ok(
  (public.list_cancelled_slot_candidates('e9500000-0000-4000-8000-000000000004') -> 'candidates' -> 0 ->> 'draft_message')
    like 'Hi Eve, a consultation slot has just opened up on % at 10:00.%',
  'the consultation draft names the consultation time');

-- ---------------------------------------------------------------- closed slots
select is(public.list_cancelled_slot_candidates('e9500000-0000-4000-8000-000000000005') #>> '{slot,state}', 'past',
  'a slot already in the past is reported as past');
select is(jsonb_array_length(public.list_cancelled_slot_candidates('e9500000-0000-4000-8000-000000000005') -> 'candidates'), 0,
  'a past slot has no candidates');
select is(public.list_cancelled_slot_candidates('e9500000-0000-4000-8000-000000000006') #>> '{slot,state}', 'taken',
  'a slot another booking now covers is reported as taken');
select is(jsonb_array_length(public.list_cancelled_slot_candidates('e9500000-0000-4000-8000-000000000006') -> 'candidates'), 0,
  'a taken slot has no candidates');
select is(public.list_cancelled_slot_candidates('e9500000-0000-4000-8000-000000000002') #>> '{slot,state}', 'not_cancelled',
  'a confirmed appointment is not a free slot');
select is(jsonb_array_length(public.list_cancelled_slot_candidates('e9500000-0000-4000-8000-000000000002') -> 'candidates'), 0,
  'a confirmed appointment has no candidates');

reset role;

-- ---------------------------------------------------------------- read-only
select is(
  (select row(s, f, o)::text from t_sf_before),
  row((select count(*) from public.sessions), (select count(*) from public.follow_ups),
      (select count(*) from public.integration_outbox))::text,
  'reading candidates creates no appointment, follow-up or outgoing message');

select ok(
  not has_function_privilege('authenticated', 'crm_private.slot_fill_candidates(uuid, timestamptz)', 'execute'),
  'the private candidate builder is not callable by browsers');

select * from finish();
rollback;
