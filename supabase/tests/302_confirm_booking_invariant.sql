-- 302_confirm_booking_invariant.sql
--
-- confirm_booking is allowed only by authoritative facts: an accepted proposed
-- tattoo date for the current calendar version, a settled deposit on that
-- session's project, and no booking-state conflict. The prompt is not the
-- guard. Everything is rolled back.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- Pure rule: fail-closed without the readiness fact
-- ---------------------------------------------------------------------------

select ok(not ('confirm_booking' = any(crm_private.attention_allowed_actions('new_enquiry', 'none', false, false, true))),
  'a new enquiry never offers confirm_booking (it did before 20260924080000)');
select ok(not ('confirm_booking' = any(crm_private.attention_allowed_actions('scheduling', 'paid', false, false, false))),
  'a paid deposit alone does not offer confirm_booking');
select ok(not ('confirm_booking' = any(crm_private.attention_allowed_actions('scheduling', 'paid', false, false, false, null))),
  'an unknown readiness fact is treated as not ready');
select ok('confirm_booking' = any(crm_private.attention_allowed_actions('booked', 'paid', true, false, false, true)),
  'with the readiness fact the action is allowed, even while the proposed session counts as upcoming');
select ok(not ('offer_dates' = any(crm_private.attention_allowed_actions('booked', 'paid', true, false, false, true))),
  'offer_dates stays withheld once a session exists');

-- ---------------------------------------------------------------------------
-- Fact derivation
-- ---------------------------------------------------------------------------

insert into public.clients (id, full_name, email) values
  ('e9811111-1111-4111-8111-111111111111', 'Booking Client', 'booking@example.test');
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'e9821111-1111-4111-8111-111111111111', 'e9811111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-9811', 'e9831111-1111-4111-8111-111111111111',
  repeat('9', 64), 'converted', 'complete', 'Booking Client', 'booking@example.test', '2026-08-05', now()
);
insert into public.projects (id, client_id, artist_id, enquiry_id, title, description, deposit_status, status) values
  ('e9841111-1111-4111-8111-111111111111', 'e9811111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'e9821111-1111-4111-8111-111111111111', 'Booking', 'rollback only',
   'paid', 'active');
insert into public.sessions (id, artist_id, client_id, enquiry_id, project_id, appointment_type, status, start_at, end_at, duration_hours)
values ('e9851111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
  'e9811111-1111-4111-8111-111111111111', 'e9821111-1111-4111-8111-111111111111',
  'e9841111-1111-4111-8111-111111111111', 'tattoo_session', 'proposed',
  date_trunc('hour', now()) + interval '9 days', date_trunc('hour', now()) + interval '9 days 3 hours', 3);

create function pg_temp.ready() returns boolean language sql as $$
  select crm_private.attention_confirm_booking_ready('a1111111-1111-4111-8111-111111111111', 'e9811111-1111-4111-8111-111111111111');
$$;
create function pg_temp.allowed() returns jsonb language sql as $$
  select crm_private.client_attention('a1111111-1111-4111-8111-111111111111', 'e9811111-1111-4111-8111-111111111111') -> 'allowed_actions';
$$;
create function pg_temp.accept() returns void language sql as $$
  update public.sessions
  set client_response = 'attendance_confirmed', client_response_at = now(),
      client_response_calendar_version = calendar_version
  where id = 'e9851111-1111-4111-8111-111111111111';
$$;

select is(pg_temp.ready(), false, 'a proposed date the client has not accepted is not ready');
select ok(not (pg_temp.allowed() ? 'confirm_booking'), 'so allowed_actions withholds confirm_booking');

select pg_temp.accept();
select is(pg_temp.ready(), true, 'an accepted proposed date with a paid deposit is ready');
select ok(pg_temp.allowed() ? 'confirm_booking', 'and client_attention offers confirm_booking');
select is(
  (crm_private.client_attention('a1111111-1111-4111-8111-111111111111', 'e9811111-1111-4111-8111-111111111111') ->> 'confirm_booking_ready')::boolean,
  true, 'the readiness fact is exposed for readback');

-- Deposit requirement.
update public.projects set deposit_status = 'requested' where id = 'e9841111-1111-4111-8111-111111111111';
select is(pg_temp.ready(), false, 'a requested but unpaid deposit blocks confirmation');
update public.projects set deposit_status = 'refunded' where id = 'e9841111-1111-4111-8111-111111111111';
select is(pg_temp.ready(), false, 'a refunded deposit blocks confirmation');
update public.projects set deposit_status = 'not_required' where id = 'e9841111-1111-4111-8111-111111111111';
select is(pg_temp.ready(), true, 'a deposit that is genuinely not required satisfies the requirement');

-- Project state.
update public.projects set status = 'completed' where id = 'e9841111-1111-4111-8111-111111111111';
select is(pg_temp.ready(), false, 'a closed project cannot take a new booking');
update public.projects set status = 'active' where id = 'e9841111-1111-4111-8111-111111111111';

-- Booking-state conflict: an earlier appointment that was never resolved.
insert into public.sessions (id, artist_id, client_id, enquiry_id, appointment_type, status, start_at, end_at, duration_hours)
values ('e9861111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
  'e9811111-1111-4111-8111-111111111111', 'e9821111-1111-4111-8111-111111111111', 'video_consultation', 'confirmed',
  date_trunc('hour', now()) - interval '5 days', date_trunc('hour', now()) - interval '5 days' + interval '30 minutes', 0.5);
select is(pg_temp.ready(), false, 'an unresolved past appointment blocks confirmation');
update public.sessions set status = 'completed' where id = 'e9861111-1111-4111-8111-111111111111';
select is(pg_temp.ready(), true, 'once the conflict is resolved the accepted date is ready again');

-- The acceptance belongs to one exact version of the appointment.
update public.sessions set start_at = start_at + interval '1 day', end_at = end_at + interval '1 day'
where id = 'e9851111-1111-4111-8111-111111111111';
select is(pg_temp.ready(), false, 'moving the date clears the client''s acceptance, so it is no longer ready');
select pg_temp.accept();
select is(pg_temp.ready(), true, 'the client accepts the new date');

-- A confirmed session is already booked: nothing left to confirm.
update public.sessions set status = 'confirmed' where id = 'e9851111-1111-4111-8111-111111111111';
select is(pg_temp.ready(), false, 'a confirmed session needs no confirm_booking');

-- ---------------------------------------------------------------------------
-- Enforcement: the model cannot open confirm_booking without the facts
-- ---------------------------------------------------------------------------

update crm_private.crm_agent_config set deterministic_state = true where singleton;
insert into public.client_ai_state (artist_id, workspace_id, client_id, summary, brief, source_watermark, provider, model)
select a.id, a.workspace_id, 'e9811111-1111-4111-8111-111111111111', 'Synthetic summary',
  jsonb_build_object(
    'project_summary', 'Synthetic', 'stage', 'booked', 'placement', null, 'style', null, 'colour', null,
    'size', null, 'cover_up_context', null, 'constraints', '[]'::jsonb, 'decisions_made', '[]'::jsonb,
    'open_questions', '[]'::jsonb, 'promises_to_client', '[]'::jsonb, 'waiting_on', 'artist',
    'last_interaction', null,
    'discussed', jsonb_build_object(
      'session_estimate', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'price', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'deposit', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'candidate_dates', jsonb_build_object('value', null, 'status', 'not_discussed'),
      'confirmed_dates', jsonb_build_object('value', null, 'status', 'not_discussed'))),
  repeat('d', 64), 'workers_ai', '@cf/meta/llama-3.1-8b-instruct-fast'
from public.artists a where a.id = 'a1111111-1111-4111-8111-111111111111';

insert into public.client_ai_next_actions (
  artist_id, workspace_id, client_id, client_ai_state_id, action_type, reason, priority,
  draft_reply, missing_information, source_watermark, provider, model
)
select st.artist_id, st.workspace_id, st.client_id, st.id, 'confirm_booking', 'Synthetic.', 'high',
       null, '[]'::jsonb, repeat('e', 64), 'workers_ai', '@cf/meta/llama-3.1-8b-instruct-fast'
from public.client_ai_state st where st.client_id = 'e9811111-1111-4111-8111-111111111111';

select results_eq(
  $$ select status::text, superseded_reason from public.client_ai_next_actions
     where client_id = 'e9811111-1111-4111-8111-111111111111' and action_type = 'confirm_booking' $$,
  $$ values ('superseded'::text, 'rule_disallowed'::text) $$,
  'a model confirm_booking without authoritative acceptance is superseded, whatever the prompt said');

select ok(
  not has_function_privilege('service_role', 'crm_private.attention_confirm_booking_ready(uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'crm_private.attention_confirm_booking_ready(uuid,uuid)', 'execute')
  and not has_function_privilege('anon', 'crm_private.attention_confirm_booking_ready(uuid,uuid)', 'execute'),
  'the readiness fact is internal to the attention layer');

select * from finish();
rollback;
