-- 299_conversation_link_suggestion.sql
--
-- Phase 5: a deterministic "looks like this client" suggestion for an unknown
-- sender. Exact and unique only, inside the scope linking enforces, and
-- nothing is written. Everything is rolled back.

begin;
select no_plan();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('d5111111-1111-4111-8111-111111111111', 'triage-manager@example.test');
insert into public.profiles (id, email, role, is_active) values
  ('d5111111-1111-4111-8111-111111111111', 'triage-manager@example.test', 'booking_manager', true);
insert into public.artist_memberships (
  profile_id, artist_id, access_level, can_manage_sessions, can_manage_integrations, is_active
) values ('d5111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111',
  'manager', true, false, true);

insert into public.communication_conversations (
  id, artist_id, channel, link_state, integration_key, external_contact_id, external_username
) values
  -- The number of a client whose phone is recorded only AFTER this message,
  -- so the WhatsApp auto-link trigger could not have linked it.
  ('d5400000-0000-4000-8000-000000000001', 'a1111111-1111-4111-8111-111111111111',
   'whatsapp', 'unmatched', 'vladimir-production', '447700900991', null),
  -- A number nobody has.
  ('d5400000-0000-4000-8000-000000000002', 'a1111111-1111-4111-8111-111111111111',
   'whatsapp', 'unmatched', 'vladimir-production', '447700900999', null),
  -- The handle, in a different case and without the @.
  ('d5400000-0000-4000-8000-000000000003', 'a1111111-1111-4111-8111-111111111111',
   'instagram', 'unmatched', 'vladimir-production', '17841400000000001', 'known.ink');

-- A known client of artist A with a phone and an Instagram handle.
insert into public.clients (id, workspace_id, full_name, email, phone, instagram) values
  ('d5200000-0000-4000-8000-000000000001',
   (select workspace_id from public.artists where id = 'a1111111-1111-4111-8111-111111111111'),
   'Known Phone Client', 'known-phone@example.test', '+44 7700 900991', '@Known.Ink');
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'd5300000-0000-4000-8000-000000000001', 'd5200000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-9901', 'd5310000-0000-4000-8000-000000000001',
  repeat('5', 64), 'reviewing', 'complete', 'Known Phone Client', 'known-phone@example.test', '2026-08-05', now()
);

create function pg_temp.triage_claims(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p, 'role', 'authenticated')::text, true)::void;
$$;
grant execute on function pg_temp.triage_claims(uuid) to authenticated;

set local role authenticated;
select pg_temp.triage_claims('d5111111-1111-4111-8111-111111111111');

-- The exact phone match no longer waits for a suggestion: the client-side
-- relink (20261004180000) linked it once the client entered this artist's
-- scope, so there is nothing left to suggest.
select is(public.get_conversation_link_suggestion('d5400000-0000-4000-8000-000000000001') ->> 'status',
  'linked', 'an exact unique phone match was linked from the client side');
select is(public.get_conversation_link_suggestion('d5400000-0000-4000-8000-000000000002') ->> 'status',
  'none', 'an unknown number suggests nobody');
select is(public.get_conversation_link_suggestion('d5400000-0000-4000-8000-000000000003') ->> 'client_id',
  'd5200000-0000-4000-8000-000000000001', 'an exact Instagram handle match is suggested regardless of case and @');

-- Nothing was written by the suggestion itself.
reset role;
select is((select link_state::text from public.communication_conversations
           where id = 'd5400000-0000-4000-8000-000000000003'), 'unmatched',
  'a suggestion never links anything by itself');

-- A second known client with the same number makes it ambiguous.
insert into public.clients (id, workspace_id, full_name, email, phone) values
  ('d5200000-0000-4000-8000-000000000002',
   (select workspace_id from public.artists where id = 'a1111111-1111-4111-8111-111111111111'),
   'Shared Phone Client', 'shared-phone@example.test', '07700 900991');
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'd5300000-0000-4000-8000-000000000002', 'd5200000-0000-4000-8000-000000000002',
  'a1111111-1111-4111-8111-111111111111', 'ENQ-2099-9902', 'd5310000-0000-4000-8000-000000000002',
  repeat('6', 64), 'reviewing', 'complete', 'Shared Phone Client', 'shared-phone@example.test', '2026-08-05', now()
);
update public.clients set phone = '+447700900991' where id = 'd5200000-0000-4000-8000-000000000002';
-- With two clients on the number, an unlinked conversation stays unlinked
-- (neither trigger guesses) and the suggestion reports the ambiguity.
update public.communication_conversations
set client_id = null, enquiry_id = null, link_state = 'unmatched'
where id = 'd5400000-0000-4000-8000-000000000001';
select is((select link_state::text from public.communication_conversations
           where id = 'd5400000-0000-4000-8000-000000000001'), 'unmatched',
  'an ambiguous number is never linked automatically');

set local role authenticated;
select pg_temp.triage_claims('d5111111-1111-4111-8111-111111111111');
select is(public.get_conversation_link_suggestion('d5400000-0000-4000-8000-000000000001') ->> 'status',
  'ambiguous', 'two known clients with one number are an ambiguity, never a guess');
select ok(not (public.get_conversation_link_suggestion('d5400000-0000-4000-8000-000000000001') ? 'client_id'),
  'an ambiguous answer names no client');

-- A client reached only through another artist is not suggested.
reset role;
insert into public.clients (id, workspace_id, full_name, email, phone) values
  ('d5200000-0000-4000-8000-000000000003',
   (select workspace_id from public.artists where id = 'a2222222-2222-4222-8222-222222222222'),
   'Other Artist Client', 'other-artist@example.test', '+447700900999');
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status,
  intake_state, submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at
) values (
  'd5300000-0000-4000-8000-000000000003', 'd5200000-0000-4000-8000-000000000003',
  'a2222222-2222-4222-8222-222222222222', 'ENQ-2099-9903', 'd5310000-0000-4000-8000-000000000003',
  repeat('7', 64), 'reviewing', 'complete', 'Other Artist Client', 'other-artist@example.test', '2026-08-05', now()
);
set local role authenticated;
select pg_temp.triage_claims('d5111111-1111-4111-8111-111111111111');
select is(public.get_conversation_link_suggestion('d5400000-0000-4000-8000-000000000002') ->> 'status',
  'none', 'a client outside this artist''s scope is never suggested');

-- Access.
select pg_temp.triage_claims(null);
select throws_ok($$select public.get_conversation_link_suggestion('d5400000-0000-4000-8000-000000000001')$$,
  '42501', null, 'an anonymous caller is refused');
reset role;
select ok(not has_function_privilege('anon', 'public.get_conversation_link_suggestion(uuid)', 'execute'),
  'anon cannot call the suggestion');
select ok(not has_function_privilege('authenticated', 'crm_private.conversation_link_candidates(uuid)', 'execute'),
  'the candidate search itself is private');

select * from finish(true);
rollback;
