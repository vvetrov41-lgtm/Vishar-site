-- 324_reply_semantics_followup.sql
--
-- Follow-up semantics for "the artist answered":
--   * an operator can attest a reply the CRM could not see (a manual
--     Instagram enquiry like Kara Dimma's), and it never leaves analytics;
--   * a Gmail first-reply time needs a complete lookup of the window;
--   * only provider-accepted messages move an enquiry to reviewing or count
--     as the studio's turn in the attention facts.

begin;
select no_plan();

insert into auth.users (id, email) values
  ('c3240000-0000-4000-8000-000000000001', 'reply-owner-324@example.test'),
  ('c3240000-0000-4000-8000-000000000002', 'reply-reader-324@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('c3240000-0000-4000-8000-000000000001', 'reply-owner-324@example.test', 'Reply Owner', 'owner', true),
  ('c3240000-0000-4000-8000-000000000002', 'reply-reader-324@example.test', 'Reply Reader', 'read_only', true);

insert into public.clients (id, full_name, email, instagram) values
  ('c3241111-0000-4000-8000-000000000000', 'Kara-like Client', 'placeholder-324@test.com', '@kara_like_324'),
  ('c3242222-0000-4000-8000-000000000000', 'Gmail Client', 'gmail-324@example.test', null),
  ('c3243333-0000-4000-8000-000000000000', 'Queued Client', 'queued-324@example.test', null),
  ('c3244444-0000-4000-8000-000000000000', 'Silent Client', 'silent-324@example.test', null);

insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, submitted_instagram, submitted_preferred_contact,
  privacy_notice_version, privacy_acknowledged_at, created_at
) values
  ('e3241111-0000-4000-8000-000000000000', 'c3241111-0000-4000-8000-000000000000',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-3241', 'e3241111-9999-4000-8000-000000000000',
   repeat('a', 64), 'reviewing', 'complete', 'Kara-like Client', 'placeholder-324@test.com', '@kara_like_324', 'Instagram',
   '2026-08-05', now(), now() - interval '5 days'),
  ('e3242222-0000-4000-8000-000000000000', 'c3242222-0000-4000-8000-000000000000',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-3242', 'e3242222-9999-4000-8000-000000000000',
   repeat('b', 64), 'new', 'complete', 'Gmail Client', 'gmail-324@example.test', null, 'Email',
   '2026-08-05', now(), now() - interval '5 days'),
  ('e3243333-0000-4000-8000-000000000000', 'c3243333-0000-4000-8000-000000000000',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-3243', 'e3243333-9999-4000-8000-000000000000',
   repeat('c', 64), 'new', 'complete', 'Queued Client', 'queued-324@example.test', null, 'WhatsApp',
   '2026-08-05', now(), now() - interval '5 days'),
  ('e3244444-0000-4000-8000-000000000000', 'c3244444-0000-4000-8000-000000000000',
   'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-3244', 'e3244444-9999-4000-8000-000000000000',
   repeat('d', 64), 'new', 'complete', 'Silent Client', 'silent-324@example.test', null, 'Email',
   '2026-08-05', now(), now() - interval '5 days');

-- The artist has a Gmail mailbox, so Gmail could always hold an earlier reply.
insert into public.artist_integrations (artist_id, integration_type, provider, integration_key, external_account_label, is_enabled)
select 'a1111111-1111-4111-8111-111111111111', 'email', 'google', 'google_gmail_reply_324', 'studio-324@example.test', true
where not exists (
  select 1 from public.artist_integrations i
  where i.artist_id = 'a1111111-1111-4111-8111-111111111111' and i.integration_type = 'email'
    and i.provider = 'google' and i.is_enabled);

create temporary table baseline as
select (crm_private.pulse_summary('a1111111-1111-4111-8111-111111111111') ->> 'enquiries_without_reply_30d')::int as without_reply;
grant select on baseline to authenticated;

-- ------------------------------------------------ 1. reply recorded outside the CRM

select ok(not crm_private.enquiry_has_artist_reply('e3241111-0000-4000-8000-000000000000'),
  'a manual Instagram enquiry with no visible message starts without reply');

select throws_ok(
  $$select public.set_enquiry_reply_outside_crm('e3241111-0000-4000-8000-000000000000', 'instagram')$$,
  '42501', null, 'recording a reply needs a signed-in operator');

select set_config('request.jwt.claims',
  '{"sub":"c3240000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$select public.set_enquiry_reply_outside_crm('e3241111-0000-4000-8000-000000000000', 'instagram')$$,
  '42501', null, 'a read-only profile cannot record a reply');
reset role;

select set_config('request.jwt.claims',
  '{"sub":"c3240000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$select public.set_enquiry_reply_outside_crm('e3241111-0000-4000-8000-000000000000', 'carrier_pigeon')$$,
  '22023', null, 'an unknown channel is refused');
select lives_ok(
  $$select public.set_enquiry_reply_outside_crm('e3241111-0000-4000-8000-000000000000', 'instagram')$$,
  'the owner records that the client was answered in Instagram');
select is(
  (public.get_enquiry_reply_state('e3241111-0000-4000-8000-000000000000') ->> 'outside_crm_channel'),
  'instagram', 'the operator sees the recorded channel');
select is(
  (public.get_enquiry_reply_state('e3241111-0000-4000-8000-000000000000') ->> 'answered')::boolean,
  true, 'and that the enquiry counts as answered');
reset role;

select is((select attestation_source from crm_private.enquiry_reply_state('e3241111-0000-4000-8000-000000000000')),
  'operator_recorded_reply', 'the answer rests on the operator''s statement');
select is((select first_reply_at from crm_private.enquiry_reply_state('e3241111-0000-4000-8000-000000000000')),
  null::timestamptz, 'no reply time is invented');
select is((select excluded_from_analytics from public.enquiries where id = 'e3241111-0000-4000-8000-000000000000'),
  false, 'the enquiry stays in analytics');
select ok(exists (
  select 1 from public.activity_log l
  where l.enquiry_id = 'e3241111-0000-4000-8000-000000000000' and l.event_type = 'enquiry.reply_attested'
    and l.actor_kind = 'owner' and l.metadata ->> 'channel' = 'instagram'),
  'the statement is in the audit trail');

set local role authenticated;
select lives_ok(
  $$select public.set_enquiry_reply_outside_crm('e3241111-0000-4000-8000-000000000000', null, false)$$,
  'the owner can take the statement back');
reset role;
select ok(not crm_private.enquiry_has_artist_reply('e3241111-0000-4000-8000-000000000000'),
  'and the enquiry is without reply again');
set local role authenticated;
select public.set_enquiry_reply_outside_crm('e3241111-0000-4000-8000-000000000000', 'instagram');
reset role;
select set_config('request.jwt.claims', '', true);

-- ------------------------------------------------ 2. Gmail time needs a complete lookup

select crm_private.note_gmail_client_outbound('a1111111-1111-4111-8111-111111111111',
  'c3242222-0000-4000-8000-000000000000', now() - interval '2 days');
select is((select answered from crm_private.enquiry_reply_state('e3242222-0000-4000-8000-000000000000')),
  true, 'a SENT Gmail message answers the enquiry');
select is((select first_reply_at from crm_private.enquiry_reply_state('e3242222-0000-4000-8000-000000000000')),
  null::timestamptz, 'but until the window was read in full it is not the first reply time');

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.service_record_gmail_enquiry_reply_check('a1111111-1111-4111-8111-111111111111',
  'e3242222-0000-4000-8000-000000000000', now() - interval '4 days', true);
select is((select first_reply_at from crm_private.enquiry_reply_state('e3242222-0000-4000-8000-000000000000'))::text,
  (select (now() - interval '4 days')::text),
  'a complete lookup gives the earliest SENT message, earlier than the one seen first');

-- More SENT mail than one run could page: answered, time unknown.
select public.service_record_gmail_enquiry_reply_check('a1111111-1111-4111-8111-111111111111',
  'e3244444-0000-4000-8000-000000000000', now() - interval '1 day', false);
select is((select answered from crm_private.enquiry_reply_state('e3244444-0000-4000-8000-000000000000')),
  true, 'an incomplete lookup that found SENT mail answers the enquiry');
select is((select first_reply_at from crm_private.enquiry_reply_state('e3244444-0000-4000-8000-000000000000')),
  null::timestamptz, 'without claiming its first reply time');
select is((select attestation_source from crm_private.enquiry_reply_state('e3244444-0000-4000-8000-000000000000')),
  'gmail_sent_time_unknown', 'and says why');
select is((select count(*)::int from crm_private.gmail_client_outbound_messages
           where client_id = 'c3244444-0000-4000-8000-000000000000'),
  0, 'an incomplete lookup records no reply time');

-- The previous Worker build calls the three-argument form: never complete.
select public.service_record_gmail_enquiry_reply_check('a1111111-1111-4111-8111-111111111111',
  'e3243333-0000-4000-8000-000000000000', null);
select is((select complete from crm_private.gmail_enquiry_reply_checks
           where enquiry_id = 'e3243333-0000-4000-8000-000000000000'),
  false, 'a one-page lookup is never taken as complete');

select ok(not exists (
  select 1 from public.service_list_gmail_reply_candidates('a1111111-1111-4111-8111-111111111111', 10) c
  where c.enquiry_id = 'e3242222-0000-4000-8000-000000000000'),
  'a complete lookup that found the first reply is not repeated');
select set_config('request.jwt.claims', '', true);

-- ------------------------------------------------ 3. reviewing waits for a sent message

insert into public.communication_conversations (
  id, artist_id, channel, client_id, link_state, integration_key, external_contact_id
) values ('d3243333-0000-4000-8000-000000000000', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'c3243333-0000-4000-8000-000000000000', 'linked', 'vladimir-production', '447700932433');
insert into public.communication_messages (id, conversation_id, artist_id, channel, direction, origin, status, body)
values ('d3243333-1111-4000-8000-000000000000', 'd3243333-0000-4000-8000-000000000000',
  'a1111111-1111-4111-8111-111111111111', 'whatsapp', 'outbound', 'crm', 'queued', 'On its way');
select is((select status::text from public.enquiries where id = 'e3243333-0000-4000-8000-000000000000'),
  'new', 'a queued message does not move the enquiry');
update public.communication_messages set status = 'failed', error_code = 'provider_rejected'
where id = 'd3243333-1111-4000-8000-000000000000';
select is((select status::text from public.enquiries where id = 'e3243333-0000-4000-8000-000000000000'),
  'new', 'a failed message does not move it either');

-- ------------------------------------------------ 4. attention facts ignore unsent studio messages

insert into public.communication_messages (conversation_id, artist_id, channel, direction, origin, status, body, provider_timestamp)
values ('d3243333-0000-4000-8000-000000000000', 'a1111111-1111-4111-8111-111111111111',
  'whatsapp', 'inbound', 'contact', 'received', 'Hello?', now() - interval '3 hours');
update public.communication_messages set provider_timestamp = now() - interval '1 hour'
where id = 'd3243333-1111-4000-8000-000000000000';
select is((select last_speaker from crm_private.attention_comm_facts(
             'a1111111-1111-4111-8111-111111111111', 'c3243333-0000-4000-8000-000000000000')),
  'client', 'a failed studio message after the client''s is not the studio''s turn');
select is((select last_outbound_at from crm_private.attention_comm_facts(
             'a1111111-1111-4111-8111-111111111111', 'c3243333-0000-4000-8000-000000000000')),
  null::timestamptz, 'and is not the studio''s last outbound time');

update public.communication_messages set status = 'delivered', error_code = null
where id = 'd3243333-1111-4000-8000-000000000000';
select is((select status::text from public.enquiries where id = 'e3243333-0000-4000-8000-000000000000'),
  'reviewing', 'once delivered the enquiry moves to reviewing');
select is((select last_speaker from crm_private.attention_comm_facts(
             'a1111111-1111-4111-8111-111111111111', 'c3243333-0000-4000-8000-000000000000')),
  'studio', 'and the delivered message is the studio''s turn');

-- ------------------------------------------------ 5. the numbers

-- The baseline was taken with all four unanswered: 3241 attested, 3242
-- Gmail, 3243 delivered WhatsApp, 3244 Gmail time unknown.
select is(
  (crm_private.pulse_summary('a1111111-1111-4111-8111-111111111111') ->> 'enquiries_without_reply_30d')::int
    - (select without_reply from baseline),
  -4, 'all four enquiries, unanswered at the start, are no longer counted without reply');

select * from finish();
rollback;
