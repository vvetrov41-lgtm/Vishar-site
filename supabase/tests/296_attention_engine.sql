-- 296_attention_engine.sql
--
-- Phase 2 deterministic attention layer (shadow mode). Pure rules first, then
-- fact derivation against synthetic rows. Everything is rolled back.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- Pure SLA rules
-- ---------------------------------------------------------------------------

create function pg_temp.sla(p_speaker text, p_reply text, p_in_hours int, p_out_hours int, p_stage text)
returns text language sql as $$
  select l.sla_state || '/' || l.sla_reason || '/' || l.waiting_on_candidate
  from crm_private.attention_sla(p_speaker, p_reply,
    '2026-09-24 12:00+00'::timestamptz - make_interval(hours => p_in_hours),
    '2026-09-24 12:00+00'::timestamptz - make_interval(hours => p_out_hours),
    p_stage, '2026-09-24 12:00+00'::timestamptz) l;
$$;

select is(pg_temp.sla('client', 'unknown', 2, 50, 'gathering_information'), 'ok/studio_reply_owed/artist',
  'a fresh client message is owed a reply but not yet late');
select is(pg_temp.sla('client', 'unknown', 30, 50, 'gathering_information'), 'due/studio_reply_owed/artist',
  'a client message older than 24 hours is due');
select is(pg_temp.sla('client', 'unknown', 80, 90, 'new_enquiry'), 'overdue/studio_reply_owed/artist',
  'a client message older than 72 hours is overdue');
select is(pg_temp.sla('client', 'no_reply_needed', 80, 90, 'booked'), 'ok/nothing_pending/nobody',
  '"thanks, see you then" marked no_reply_needed owes nothing');
select is(pg_temp.sla('client', 'unknown', 50, 90, 'new_enquiry'), 'overdue/studio_reply_owed/artist',
  'an untouched new enquiry is overdue after 48 hours');
select is(pg_temp.sla('client', 'unknown', 50, 90, 'gathering_information'), 'due/studio_reply_owed/artist',
  'other studio replies stay due until 72 hours');
select is(pg_temp.sla('studio', 'unknown', 300, 200, 'gathering_information'), 'due/client_follow_up_due/client',
  'the client silent for over a week after the studio spoke is a follow-up');
select is(pg_temp.sla('studio', 'unknown', 900, 600, 'gathering_information'), 'cold/client_silent/client',
  'the client silent for three weeks is cold, with no new event needed');
select is(pg_temp.sla('studio', 'unknown', 900, 600, 'booked'), 'ok/nothing_pending/nobody',
  'a booked client who has not written is not cold');

-- ---------------------------------------------------------------------------
-- Pure allowed-action rules
-- ---------------------------------------------------------------------------

select ok(not ('request_information' = any(crm_private.attention_allowed_actions('booked', 'paid', true, false, false))),
  'a booked client is never asked for intake information again');
select ok(not ('request_deposit' = any(crm_private.attention_allowed_actions('scheduling', 'paid', false, false, false))),
  'a paid deposit is never requested again');
select ok(not ('offer_dates' = any(crm_private.attention_allowed_actions('booked', 'paid', true, false, false))),
  'dates are not offered over an existing booking');
select ok(not ('await_client' = any(crm_private.attention_allowed_actions('gathering_information', 'none', false, false, true))),
  'the studio owing a reply cannot be told to wait for the client');
select ok(not ('request_information' = any(crm_private.attention_allowed_actions('awaiting_artist_review', 'none', false, true, false))),
  'a client with a booked consultation is not asked for intake information again');
select ok('request_information' = any(crm_private.attention_allowed_actions('new_enquiry', 'none', false, false, true)),
  'a new enquiry may ask for information');

-- ---------------------------------------------------------------------------
-- Fact derivation
-- ---------------------------------------------------------------------------

insert into public.clients (id, full_name, email) values
  ('e7011111-1111-4111-8111-111111111111', 'Attention Client', 'attention@example.test');

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at, created_at
) values (
  'e7021111-1111-4111-8111-111111111111', 'e7011111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-9701', 'e7031111-1111-4111-8111-111111111111',
  repeat('e', 64), 'new', 'complete', 'Attention Client', 'attention@example.test', '2026-08-05', now(),
  now() - interval '5 days'
);

insert into public.communication_conversations (
  id, artist_id, channel, client_id, link_state, integration_key, external_contact_id
) values ('e7041111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'e7011111-1111-4111-8111-111111111111', 'linked', 'vladimir-production', '447700900777');

insert into public.communication_messages (
  id, conversation_id, artist_id, channel, direction, origin, status, body, provider_timestamp
) values ('e7051111-1111-4111-8111-111111111111', 'e7041111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'inbound', 'contact', 'received',
  'Is Friday still OK?', now() - interval '30 hours');

select results_eq(
  $$ select last_speaker, reply_state, response_debt_candidate, last_inbound_source
     from crm_private.attention_comm_facts('a1111111-1111-4111-8111-111111111111', 'e7011111-1111-4111-8111-111111111111') $$,
  $$ values ('client'::text, 'unknown'::text, true, 'communication'::text) $$,
  'the client spoke last; the reply need is unknown until marked'
);

select is(
  crm_private.client_attention('a1111111-1111-4111-8111-111111111111', 'e7011111-1111-4111-8111-111111111111') ->> 'sla_state',
  'due', 'an unanswered 30-hour-old client message is due');
select is(
  crm_private.client_attention('a1111111-1111-4111-8111-111111111111', 'e7011111-1111-4111-8111-111111111111') ->> 'workflow_stage',
  'new_enquiry', 'an untouched new enquiry is at new_enquiry');

-- An operator acknowledgement after the message means the studio handled it
-- (20260924035000): the studio's turn, taken when it was cleared.
insert into public.attention_acknowledgements (artist_id, item_kind, entity_id, observed_at, acknowledged_at)
values ('a1111111-1111-4111-8111-111111111111', 'conversation_reply', 'e7041111-1111-4111-8111-111111111111',
        now() - interval '30 hours', now() - interval '1 hour');
select results_eq(
  $$ select reply_state, reply_state_source
     from crm_private.attention_comm_facts('a1111111-1111-4111-8111-111111111111', 'e7011111-1111-4111-8111-111111111111') $$,
  $$ values ('handled'::text, 'operator_ack'::text) $$,
  'an operator acknowledgement after the latest inbound marks it handled'
);
select is(
  crm_private.client_attention('a1111111-1111-4111-8111-111111111111', 'e7011111-1111-4111-8111-111111111111') ->> 'sla_state',
  'ok', 'a handled message is no longer due');
select is(
  crm_private.client_attention('a1111111-1111-4111-8111-111111111111', 'e7011111-1111-4111-8111-111111111111') ->> 'waiting_on_candidate',
  'client', 'after the studio handled the message, the client is the one expected to move');
select is(
  crm_private.client_attention('a1111111-1111-4111-8111-111111111111', 'e7011111-1111-4111-8111-111111111111') ->> 'workflow_stage',
  'gathering_information', 'a new enquiry the studio already engaged with is no longer an untouched lead');
select is(
  crm_private.client_attention('a1111111-1111-4111-8111-111111111111', 'e7011111-1111-4111-8111-111111111111',
    now() + interval '8 days') ->> 'sla_reason',
  'client_follow_up_due', 'follow-up timers run from the moment the message was handled');

-- A newer inbound makes the acknowledgement moot.
insert into public.communication_messages (
  id, conversation_id, artist_id, channel, direction, origin, status, body, provider_timestamp
) values ('e7061111-1111-4111-8111-111111111111', 'e7041111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'inbound', 'contact', 'received',
  'Also, can we make it bigger?', now() - interval '10 minutes');
select is(
  (select reply_state from crm_private.attention_comm_facts('a1111111-1111-4111-8111-111111111111', 'e7011111-1111-4111-8111-111111111111')),
  'unknown', 'a newer client message reopens the question');

-- An acknowledgement clicked late, for the version seen before the newer
-- message, does not cover the newer message.
update public.attention_acknowledgements
set acknowledged_at = now()
where artist_id = 'a1111111-1111-4111-8111-111111111111' and entity_id = 'e7041111-1111-4111-8111-111111111111';
select is(
  (select reply_state from crm_private.attention_comm_facts('a1111111-1111-4111-8111-111111111111', 'e7011111-1111-4111-8111-111111111111')),
  'unknown', 'an acknowledgement of an older version never silences a newer message');

-- A converted enquiry no longer creates a reply debt by itself.
insert into public.clients (id, full_name, email) values
  ('e70a1111-1111-4111-8111-111111111111', 'Converted Client', 'converted@example.test');
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'e70b1111-1111-4111-8111-111111111111', 'e70a1111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-9702', 'e70c1111-1111-4111-8111-111111111111',
  repeat('9', 64), 'converted', 'complete', 'Converted Client', 'converted@example.test', '2026-08-05', now()
);
select results_eq(
  $$ select last_speaker, response_debt_candidate
     from crm_private.attention_comm_facts('a1111111-1111-4111-8111-111111111111', 'e70a1111-1111-4111-8111-111111111111') $$,
  $$ values ('none'::text, false) $$,
  'an enquiry the studio has already moved on is not an unanswered message'
);

-- Stage and conflicts from authoritative rows.
insert into public.projects (id, client_id, artist_id, enquiry_id, title, description, deposit_status, status) values
  ('e7071111-1111-4111-8111-111111111111', 'e7011111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'e7021111-1111-4111-8111-111111111111', 'Attention', 'rollback only',
   'paid', 'active');

select is(
  (select workflow_stage from crm_private.attention_stage_facts('a1111111-1111-4111-8111-111111111111', 'e7011111-1111-4111-8111-111111111111')),
  'scheduling', 'a paid deposit without a session is scheduling');
select ok(
  'deposit_paid_without_booking' = any(crm_private.attention_conflicts('a1111111-1111-4111-8111-111111111111', 'e7011111-1111-4111-8111-111111111111')),
  'a paid deposit with no booking is reported as a conflict');

insert into public.sessions (id, artist_id, client_id, enquiry_id, project_id, appointment_type, status, start_at, end_at, duration_hours)
values ('e7081111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
  'e7011111-1111-4111-8111-111111111111', 'e7021111-1111-4111-8111-111111111111',
  'e7071111-1111-4111-8111-111111111111', 'tattoo_session', 'confirmed',
  date_trunc('hour', now()) + interval '10 days', date_trunc('hour', now()) + interval '10 days 4 hours', 4);

select is(
  crm_private.client_attention('a1111111-1111-4111-8111-111111111111', 'e7011111-1111-4111-8111-111111111111') ->> 'workflow_stage',
  'booked', 'a future confirmed tattoo session is booked, whatever the enquiry status says');
select ok(
  not (crm_private.client_attention('a1111111-1111-4111-8111-111111111111', 'e7011111-1111-4111-8111-111111111111')
       -> 'allowed_actions') ? 'request_information',
  'a booked client may not be asked for intake information');
select ok(
  not ('deposit_paid_without_booking' = any(crm_private.attention_conflicts('a1111111-1111-4111-8111-111111111111', 'e7011111-1111-4111-8111-111111111111'))),
  'the conflict clears once the booking exists');

insert into public.sessions (id, artist_id, client_id, enquiry_id, appointment_type, status, start_at, end_at, duration_hours)
values ('e7091111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
  'e7011111-1111-4111-8111-111111111111', 'e7021111-1111-4111-8111-111111111111', 'video_consultation', 'confirmed',
  date_trunc('hour', now()) + interval '2 days', date_trunc('hour', now()) + interval '2 days 30 minutes', 0.5);
select ok(
  'consultation_booked_enquiry_new' = any(crm_private.attention_conflicts('a1111111-1111-4111-8111-111111111111', 'e7011111-1111-4111-8111-111111111111')),
  'a booked consultation while the enquiry is still new is a conflict');

-- ---------------------------------------------------------------------------
-- Handled time and engagement are tied to the right acknowledgement
-- ---------------------------------------------------------------------------

insert into public.clients (id, full_name, email) values
  ('e7a01111-1111-4111-8111-111111111111', 'Two Enquiry Client', 'two@example.test');
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at,
  created_at, updated_at
) values
  ('e7a11111-1111-4111-8111-111111111111', 'e7a01111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-9711', 'e7a21111-1111-4111-8111-111111111111',
   repeat('a', 64), 'new', 'complete', 'Two Enquiry Client', 'two@example.test', '2026-08-05', now(),
   now() - interval '20 days', now() - interval '20 days'),
  ('e7a31111-1111-4111-8111-111111111111', 'e7a01111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-9712', 'e7a41111-1111-4111-8111-111111111111',
   repeat('b', 64), 'new', 'complete', 'Two Enquiry Client', 'two@example.test', '2026-08-05', now(),
   now() - interval '2 days', now() - interval '2 days');

-- The operator clears the OLD enquiry's item today; the new one stays untouched.
insert into public.attention_acknowledgements (artist_id, item_kind, entity_id, observed_at, acknowledged_at)
values ('a1111111-1111-4111-8111-111111111111', 'new_enquiry', 'e7a11111-1111-4111-8111-111111111111',
        now() - interval '20 days', now() - interval '1 hour');
select is(
  crm_private.client_attention('a1111111-1111-4111-8111-111111111111', 'e7a01111-1111-4111-8111-111111111111') ->> 'workflow_stage',
  'new_enquiry', 'clearing a sibling enquiry does not engage the newest one');

-- A Gmail reply item is keyed by the client and counts as handled.
insert into public.attention_acknowledgements (artist_id, item_kind, entity_id, observed_at, acknowledged_at)
values ('a1111111-1111-4111-8111-111111111111', 'gmail_reply', 'e7a01111-1111-4111-8111-111111111111',
        now() - interval '2 days', now() - interval '47 hours');
select is(
  crm_private.client_attention('a1111111-1111-4111-8111-111111111111', 'e7a01111-1111-4111-8111-111111111111') ->> 'reply_state',
  'handled', 'a cleared Gmail reply item, keyed by the client, counts as handled');
select is(
  crm_private.client_attention('a1111111-1111-4111-8111-111111111111', 'e7a01111-1111-4111-8111-111111111111') ->> 'workflow_stage',
  'gathering_information', 'and it engages the newest enquiry it followed');

-- handled_at is the click that covered the latest inbound, not the later,
-- unrelated click on the old enquiry.
select ok(
  (crm_private.client_attention('a1111111-1111-4111-8111-111111111111', 'e7a01111-1111-4111-8111-111111111111') ->> 'handled_at')::timestamptz
    < now() - interval '46 hours',
  'the handled time comes from the acknowledgement that covers the latest message');

-- ---------------------------------------------------------------------------
-- Shadow report and recording
-- ---------------------------------------------------------------------------

select ok(crm_private.attention_shadow_report() ?& array['clients', 'stage_disagreements', 'waiting_on_disagreements',
  'open_ai_actions_disallowed', 'sla_states', 'conflicts', 'without_valid_next_step'],
  'the shadow report carries the agreed aggregate keys');

select is(public.service_record_attention_shadow() ->> 'status', 'recorded', 'a shadow run is recorded');
select is(public.service_record_attention_shadow() ->> 'status', 'throttled', 'at most one shadow run per hour');

select ok(
  not has_table_privilege('service_role', 'crm_private.attention_shadow_runs', 'SELECT')
  and not has_table_privilege('authenticated', 'crm_private.client_reply_marks', 'SELECT'),
  'shadow runs and reply marks are private');

select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.service_record_attention_shadow() $$, '42501', null,
  'only the service backend records shadow runs');

select * from finish(true);
rollback;
