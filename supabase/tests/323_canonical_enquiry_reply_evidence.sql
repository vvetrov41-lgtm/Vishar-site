-- 323_canonical_enquiry_reply_evidence.sql
--
-- "Without reply" means no person at the studio has answered the enquiry
-- through any channel the CRM can see, after it arrived and before the
-- client's next enquiry. Status is not evidence. Drafts, approvals, queued,
-- failed, cancelled and automated messages are not replies. Replies the CRM
-- could not see count when an operator fact attests them, without a time.

begin;
select no_plan();

-- ------------------------------------------------------------------ fixtures

insert into auth.users (id, email) values
  ('c3230000-0000-4000-8000-000000000001', 'reply-owner-323@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('c3230000-0000-4000-8000-000000000001', 'reply-owner-323@example.test', 'Reply Owner', 'owner', true);

create temporary table baseline as
select (crm_private.pulse_summary('a1111111-1111-4111-8111-111111111111') ->> 'enquiries_without_reply_30d')::int as without_reply,
       (crm_private.pulse_summary('a1111111-1111-4111-8111-111111111111') ->> 'enquiries_reply_attested_30d')::int as attested;

-- One client per case, cNN, and its enquiry eNN.
insert into public.clients (id, full_name, email)
select ('c323' || lpad(n::text, 4, '0') || '-0000-4000-8000-000000000000')::uuid,
       'Reply Case ' || n, 'reply-case-' || n || '-323@example.test'
from generate_series(1, 18) n;

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at, created_at
)
select ('e323' || lpad(n::text, 4, '0') || '-0000-4000-8000-000000000000')::uuid,
       ('c323' || lpad(n::text, 4, '0') || '-0000-4000-8000-000000000000')::uuid,
       'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-32' || lpad(n::text, 2, '0'),
       ('e323' || lpad(n::text, 4, '0') || '-9999-4000-8000-000000000000')::uuid,
       repeat(to_hex(n % 16), 64), 'new', 'complete', 'Reply Case ' || n,
       'reply-case-' || n || '-323@example.test', '2026-08-05', now(), now() - interval '10 days'
from generate_series(1, 18) n;

-- A conversation per client, opened long before the enquiry.
insert into public.communication_conversations (
  id, artist_id, channel, client_id, link_state, integration_key, external_contact_id, created_at
)
select ('d323' || lpad(n::text, 4, '0') || '-0000-4000-8000-000000000000')::uuid,
       'a1111111-1111-4111-8111-111111111111',
       case when n = 4 then 'instagram' else 'whatsapp' end::public.communication_channel,
       ('c323' || lpad(n::text, 4, '0') || '-0000-4000-8000-000000000000')::uuid,
       'linked', case when n = 4 then 'instagram_main' else 'vladimir-production' end,
       '4477009323' || lpad(n::text, 2, '0'), now() - interval '60 days'
from generate_series(1, 18) n;

create function pg_temp.msg(p_case int, p_direction text, p_origin text, p_status text, p_at interval)
returns void language sql as $$
  insert into public.communication_messages (
    conversation_id, artist_id, channel, direction, origin, status, body,
    provider_timestamp, error_code)
  select ('d323' || lpad(p_case::text, 4, '0') || '-0000-4000-8000-000000000000')::uuid,
         'a1111111-1111-4111-8111-111111111111', c.channel,
         p_direction::public.communication_direction, p_origin::public.communication_origin,
         p_status::public.communication_status, 'Fixture message',
         now() - p_at, case when p_status = 'failed' then 'provider_rejected' end
  from public.communication_conversations c
  where c.id = ('d323' || lpad(p_case::text, 4, '0') || '-0000-4000-8000-000000000000')::uuid;
$$;

create function pg_temp.enq(p_case int) returns uuid language sql as $$
  select ('e323' || lpad(p_case::text, 4, '0') || '-0000-4000-8000-000000000000')::uuid;
$$;
create function pg_temp.cli(p_case int) returns uuid language sql as $$
  select ('c323' || lpad(p_case::text, 4, '0') || '-0000-4000-8000-000000000000')::uuid;
$$;
create function pg_temp.replied(p_case int) returns boolean language sql as $$
  select crm_private.enquiry_has_artist_reply(pg_temp.enq(p_case));
$$;
create function pg_temp.first_reply(p_case int) returns timestamptz language sql as $$
  select replied_at from crm_private.enquiry_first_artist_reply(pg_temp.enq(p_case));
$$;

-- 1. New enquiry, no message at all.
-- (case 1: nothing inserted)

-- 2. Outbound WhatsApp written in the phone app after the enquiry.
select pg_temp.msg(2, 'outbound', 'provider_app', 'delivered', interval '9 days');

-- 3. Gmail sent mail after the enquiry, written in Gmail, not the CRM (the
-- Worker records it after checking the SENT label).
select crm_private.note_gmail_client_outbound('a1111111-1111-4111-8111-111111111111', pg_temp.cli(3), now() - interval '8 days');
-- The newest-message record alone says "outbound", which a scheduled,
-- not yet sent message also is: it is not evidence (case 1).
insert into crm_private.gmail_client_email_activity (artist_id, client_id, last_message_at, last_direction)
values ('a1111111-1111-4111-8111-111111111111', pg_temp.cli(1), now() - interval '8 days', 'outbound');

-- 4. Outbound Instagram after the enquiry.
select pg_temp.msg(4, 'outbound', 'provider_app', 'sent', interval '7 days');

-- 5. Only the client wrote.
select pg_temp.msg(5, 'inbound', 'contact', 'received', interval '9 days');
select pg_temp.msg(5, 'inbound', 'contact', 'received', interval '8 days');

-- 6. A person's email draft only.
insert into public.email_messages (artist_id, client_id, enquiry_id, status, to_email, subject, body, created_by_kind, created_by)
values ('a1111111-1111-4111-8111-111111111111', pg_temp.cli(6), pg_temp.enq(6), 'draft',
  'reply-case-6-323@example.test', 'Draft', 'Draft body', 'human', 'c3230000-0000-4000-8000-000000000001');

-- 7. Email approved (approve_email_draft) but never sent by Gmail.
insert into public.email_messages (artist_id, client_id, enquiry_id, status, to_email, subject, body,
  created_by_kind, created_by, approved_by, approved_at)
values ('a1111111-1111-4111-8111-111111111111', pg_temp.cli(7), pg_temp.enq(7), 'approved',
  'reply-case-7-323@example.test', 'Approved', 'Approved body', 'human',
  'c3230000-0000-4000-8000-000000000001', 'c3230000-0000-4000-8000-000000000001', now() - interval '9 days');
-- and an AI draft that was never sent
insert into public.email_messages (artist_id, client_id, enquiry_id, status, to_email, subject, body, created_by_kind)
values ('a1111111-1111-4111-8111-111111111111', pg_temp.cli(7), pg_temp.enq(7), 'draft',
  'reply-case-7-323@example.test', 'AI draft', 'AI body', 'ai');

-- 8. Failed and queued outbound, a cancelled email.
select pg_temp.msg(8, 'outbound', 'crm', 'failed', interval '9 days');
select pg_temp.msg(8, 'outbound', 'crm', 'queued', interval '8 days');
insert into public.email_messages (artist_id, client_id, enquiry_id, status, to_email, subject, body, created_by_kind)
values ('a1111111-1111-4111-8111-111111111111', pg_temp.cli(8), pg_temp.enq(8), 'draft',
  'reply-case-8-323@example.test', 'Cancelled', 'Cancelled body', 'ai');
update public.email_messages set status = 'cancelled' where client_id = pg_temp.cli(8);

-- 9. A CRM email Gmail accepted.
insert into public.email_messages (artist_id, client_id, enquiry_id, status, to_email, subject, body,
  created_by_kind, created_by, approved_by, approved_at, sent_at, provider, provider_message_id)
values ('a1111111-1111-4111-8111-111111111111', pg_temp.cli(9), pg_temp.enq(9), 'sent',
  'reply-case-9-323@example.test', 'Sent', 'Sent body', 'human',
  'c3230000-0000-4000-8000-000000000001', 'c3230000-0000-4000-8000-000000000001',
  now() - interval '9 days 1 hour', now() - interval '9 days', 'google_gmail', 'gmail-provider-323-9');

-- 10. The artist wrote, but only before the enquiry.
select pg_temp.msg(10, 'outbound', 'provider_app', 'read', interval '20 days');
insert into crm_private.gmail_client_outbound_messages (artist_id, client_id, sent_at)
values ('a1111111-1111-4111-8111-111111111111', pg_temp.cli(10), now() - interval '15 days');

-- 11. An old thread (60 days) with an old reply, and a new reply after the enquiry.
select pg_temp.msg(11, 'outbound', 'provider_app', 'read', interval '50 days');
select pg_temp.msg(11, 'inbound', 'contact', 'received', interval '10 days 1 hour');
select pg_temp.msg(11, 'outbound', 'provider_app', 'read', interval '6 days');

-- 12. One client, two enquiries: A (10 days ago) and B (3 days ago). The
-- only reply is 2 days ago, so it answers B and not A.
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at, created_at
) values ('e3230012-bbbb-4000-8000-000000000000', pg_temp.cli(12), 'a1111111-1111-4111-8111-111111111111',
  'ENQ-2099-3299', 'e3230012-9999-4bbb-8000-000000000000', repeat('9', 64), 'new', 'complete',
  'Reply Case 12', 'reply-case-12-323@example.test', '2026-08-05', now(), now() - interval '3 days');
select pg_temp.msg(12, 'outbound', 'provider_app', 'delivered', interval '2 days');

-- 13. Automated lifecycle message only (a reminder the automation sent).
select pg_temp.msg(13, 'outbound', 'automation', 'read', interval '9 days');

-- 14. Duplicated and retried deliveries: a failed try, then the same reply
-- recorded twice by the provider echo, and Gmail observing one mail twice.
select pg_temp.msg(14, 'outbound', 'crm', 'failed', interval '9 days 2 hours');
select pg_temp.msg(14, 'outbound', 'provider_app', 'delivered', interval '9 days 1 hour');
select pg_temp.msg(14, 'outbound', 'provider_app', 'delivered', interval '9 days 1 hour');
select crm_private.note_gmail_client_outbound('a1111111-1111-4111-8111-111111111111', pg_temp.cli(14), now() - interval '8 days');
select crm_private.note_gmail_client_outbound('a1111111-1111-4111-8111-111111111111', pg_temp.cli(14), now() - interval '8 days');

-- 15. Lewis Jacobs-like: answered in the WhatsApp phone app before echoes
-- were ingested, so the CRM holds no message at all; the operator moved the
-- enquiry to waiting_for_client.
insert into public.activity_log (event_type, actor_kind, actor_profile_id, enquiry_id, client_id, metadata, occurred_at)
values ('enquiry.status_changed', 'owner', 'c3230000-0000-4000-8000-000000000001', pg_temp.enq(15), pg_temp.cli(15),
  '{"from_status":"reviewing","to_status":"waiting_for_client"}', now() - interval '1 day');

-- 16. Answered outside the CRM; the operator cleared the client's reply item.
select pg_temp.msg(16, 'inbound', 'contact', 'received', interval '9 days');
insert into public.attention_acknowledgements (artist_id, item_kind, entity_id, observed_at, acknowledged_at, acknowledged_by)
values ('a1111111-1111-4111-8111-111111111111', 'conversation_reply',
  'd3230016-0000-4000-8000-000000000000', now() - interval '9 days', now() - interval '8 days',
  'c3230000-0000-4000-8000-000000000001');

-- Later the phone-app echo shows a message: it is not the first reply,
-- because the operator already attested an earlier one.
select pg_temp.msg(16, 'outbound', 'provider_app', 'read', interval '2 days');

-- 17. A status change by the system is not an attestation.
insert into public.activity_log (event_type, actor_kind, enquiry_id, client_id, metadata, occurred_at)
values ('enquiry.status_changed', 'system', pg_temp.enq(17), pg_temp.cli(17),
  '{"from_status":"new","to_status":"waiting_for_client"}', now() - interval '1 day');

-- 18. Excluded from analytics: never in the numbers.
update public.enquiries set excluded_from_analytics = true where id = pg_temp.enq(18);

-- ------------------------------------------------------------------ predicate

select ok(not pg_temp.replied(1), '1. a new enquiry with no sent message is without reply, whatever the newest-message record says');
select is(pg_temp.first_reply(2)::text, (select (now() - interval '9 days')::text),
  '2. an outbound WhatsApp after the enquiry is its first reply');
select is((select evidence_source from crm_private.enquiry_first_artist_reply(pg_temp.enq(3))),
  'gmail_mailbox', '3. mail sent from Gmail itself answers the enquiry');
select is((select channel from crm_private.enquiry_first_artist_reply(pg_temp.enq(4))),
  'instagram', '4. an outbound Instagram message answers the enquiry');
select ok(not pg_temp.replied(5), '5. only inbound messages: still without reply');
select ok(not pg_temp.replied(6), '6. an email draft is not a reply');
select ok(not pg_temp.replied(7), '7. an approved but unsent email, or an AI draft, is not a reply');
select ok(not pg_temp.replied(8), '8. failed, queued and cancelled messages are not a reply');
select is((select evidence_source from crm_private.enquiry_first_artist_reply(pg_temp.enq(9))),
  'crm_email', '9. a sent CRM email answers the enquiry');
select ok(not pg_temp.replied(10), '10. replies before the enquiry do not answer it');
select is(pg_temp.first_reply(11)::text, (select (now() - interval '6 days')::text),
  '11. in an old thread, the first reply after the enquiry is used, not the old one');
select ok(not pg_temp.replied(12), '12. a reply after the client''s next enquiry answers that one, not the earlier');
select ok(crm_private.enquiry_has_artist_reply('e3230012-bbbb-4000-8000-000000000000'),
  '12. and it answers the later enquiry');
select ok(not pg_temp.replied(13), '13. an automated lifecycle message is not the artist replying');
select is(pg_temp.first_reply(14)::text, (select (now() - interval '9 days 1 hour')::text),
  '14. a failed try before a delivered retry: the delivered one is the first reply');
select is((select count(*)::int from crm_private.gmail_client_outbound_messages where client_id = pg_temp.cli(14)),
  1, '14. the same Gmail message observed twice is one row');
select ok(pg_temp.replied(15), '15. Lewis-like: waiting_for_client set by the operator attests a reply');
select is(pg_temp.first_reply(15), null::timestamptz, '15. but claims no reply time');
select is((select attestation_source from crm_private.enquiry_reply_attestation(pg_temp.enq(15))),
  'operator_waiting_for_client', '15. the attestation says where it came from');
select ok(pg_temp.replied(16), '16. a cleared reply item attests the studio answered');
select ok(not pg_temp.replied(17), '17. a system status change is not an attestation');
select ok(pg_temp.first_reply(16) is not null
  and (select first_reply_at from crm_private.enquiry_reply_state(pg_temp.enq(16))) is null,
  '16. a visible message after an attested earlier reply is not taken as the first reply time');
select ok(pg_temp.first_reply(2) is not null and not exists (
  select 1 from crm_private.enquiry_first_artist_reply(pg_temp.enq(2), now() - interval '9 days 1 minute')),
  'evidence after the as-of time is not counted');

-- ------------------------------------------------------------------ summary

select is(
  (crm_private.pulse_summary('a1111111-1111-4111-8111-111111111111') ->> 'enquiries_without_reply_30d')::int
    - (select without_reply from baseline),
  -- 1, 5, 6, 7, 8, 10, 12 (A), 13, 17; 18 is excluded from analytics.
  9, 'the summary counts exactly the unanswered enquiries');
select is(
  (crm_private.pulse_summary('a1111111-1111-4111-8111-111111111111') ->> 'enquiries_reply_attested_30d')::int
    - (select attested from baseline),
  2, 'attested-only enquiries are reported separately');

-- The median uses provider reply times only: 2 (1d), 3 (2d), 4 (3d), 9 (1d),
-- 11 (4d), 12B (1d), 14 (~0.96d). Recomputed through the predicate.
select is(
  (crm_private.pulse_summary('a1111111-1111-4111-8111-111111111111') ->> 'median_first_reply_hours')::numeric,
  (select round((percentile_cont(0.5) within group (
     order by extract(epoch from fr.replied_at - e.created_at)) / 3600)::numeric, 1)
   from public.enquiries e
   cross join lateral crm_private.enquiry_reply_state(e.id) fr(answered, replied_at)
   where e.artist_id = 'a1111111-1111-4111-8111-111111111111' and e.archived_at is null
     and e.intake_state = 'complete' and not e.excluded_from_analytics
     and e.created_at >= now() - interval '30 days' and fr.replied_at is not null),
  'the median is enquiry creation to first provider-confirmed reply');
select is(
  (select round(extract(epoch from pg_temp.first_reply(9) - e.created_at) / 3600, 1)
   from public.enquiries e where e.id = pg_temp.enq(9)),
  24.0, 'a reply time is creation to provider send, not approval or draft time');

-- ------------------------------------------------------------------ Today and reminders

select ok(exists (
  select 1 from jsonb_array_elements(crm_private.pulse_items('a1111111-1111-4111-8111-111111111111', false, false)) i
  where i ->> 'key' = 'enquiry-' || pg_temp.enq(5)),
  'Today lists a new enquiry the client wrote about but nobody answered');
select ok(not exists (
  select 1 from jsonb_array_elements(crm_private.pulse_items('a1111111-1111-4111-8111-111111111111', false, false)) i
  where i ->> 'key' = 'enquiry-' || pg_temp.enq(3)),
  'Today drops a new enquiry answered from Gmail');
select ok(not exists (
  select 1 from jsonb_array_elements(crm_private.pulse_items('a1111111-1111-4111-8111-111111111111', false, false)) i
  where i ->> 'key' = 'enquiry-' || pg_temp.enq(6)),
  'a person''s unsent draft stays its own Today item, not a second new-enquiry row');
select ok(crm_private.unanswered_waiting_since('enquiry', 'a1111111-1111-4111-8111-111111111111', pg_temp.enq(7)) is not null,
  'the reminder still waits on an enquiry whose email was only approved');
select is(crm_private.unanswered_waiting_since('enquiry', 'a1111111-1111-4111-8111-111111111111', pg_temp.enq(2)),
  null::timestamptz, 'the reminder stops once the artist replied in WhatsApp');

-- ------------------------------------------------------------------ backend boundary

select throws_ok(
  $$select public.service_record_gmail_outbound_messages('a1111111-1111-4111-8111-111111111111', '[]'::jsonb)$$,
  '42501', null, 'outbound evidence recording is backend-only');
select throws_ok(
  $$select * from public.service_list_gmail_reply_candidates('a1111111-1111-4111-8111-111111111111', 3)$$,
  '42501', null, 'reply candidates are backend-only');
select throws_ok(
  $$select public.service_record_gmail_enquiry_reply_check('a1111111-1111-4111-8111-111111111111', 'e3230001-0000-4000-8000-000000000000', null)$$,
  '42501', null, 'reply checks are backend-only');

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(exists (
  select 1 from public.service_list_gmail_reply_candidates('a1111111-1111-4111-8111-111111111111', 10) c
  where c.enquiry_id = pg_temp.enq(1)),
  'an enquiry with no provider reply is a Gmail lookup candidate');
select ok(not exists (
  select 1 from public.service_list_gmail_reply_candidates('a1111111-1111-4111-8111-111111111111', 10) c
  where c.enquiry_id = pg_temp.enq(9)),
  'an answered enquiry is not looked up again');

select lives_ok(
  $$select public.service_record_gmail_enquiry_reply_check(
      'a1111111-1111-4111-8111-111111111111', 'e3230001-0000-4000-8000-000000000000', now() - interval '9 days 12 hours')$$,
  'the Worker records the first Gmail reply it found');
select is(
  public.service_record_gmail_outbound_messages('a1111111-1111-4111-8111-111111111111',
    jsonb_build_array(
      jsonb_build_object('client_id', 'c3230005-0000-4000-8000-000000000000', 'sent_at', now() - interval '7 days'),
      jsonb_build_object('client_id', 'c3230005-0000-4000-8000-000000000000', 'sent_at', now() - interval '7 days'),
      jsonb_build_object('client_id', 'f0000000-0000-4000-8000-000000000999', 'sent_at', now() - interval '7 days'))),
  1, 'outbound evidence is deduplicated and limited to this artist''s clients');
select throws_ok(
  $$select public.service_record_gmail_outbound_messages('a1111111-1111-4111-8111-111111111111',
      jsonb_build_array(jsonb_build_object('client_id', 'c3230005-0000-4000-8000-000000000000', 'sent_at', now() + interval '1 day')))$$,
  '22023', null, 'a future send time is refused');

select set_config('request.jwt.claims', '', true);

select ok(pg_temp.replied(1), 'the Gmail lookup answers case 1');
select ok(pg_temp.replied(5), 'and the recorded sent mail answers case 5');

select * from finish();
rollback;
