-- 325_manual_enquiry_translation.sql
--
-- Migration 20261004160000. A translation is started only by an artist with
-- access, cached per exact source text, invalidated when the text changes,
-- run only by the backend, and never raises a notification.

begin;
select no_plan();

select ok(has_function_privilege('authenticated', 'public.request_enquiry_translation(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.request_enquiry_translation(uuid,text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.request_enquiry_translation(uuid,text)', 'EXECUTE'),
  'only a signed-in CRM session can request a translation');
select ok(not has_function_privilege('authenticated', 'public.service_claim_enquiry_translation(uuid,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.service_claim_enquiry_translation(uuid,text)', 'EXECUTE'),
  'only the backend can claim a translation job');
select ok(not has_table_privilege('authenticated', 'crm_private.enquiry_translations', 'SELECT'),
  'the browser cannot read the translation table directly');

insert into auth.users (id, email) values
  ('f3250000-0000-4000-8000-000000000001', 'tr-owner@example.test'),
  ('f3250000-0000-4000-8000-000000000002', 'tr-outsider@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('f3250000-0000-4000-8000-000000000001', 'tr-owner@example.test', 'Translation Owner', 'owner', true),
  ('f3250000-0000-4000-8000-000000000002', 'tr-outsider@example.test', 'Outsider', 'booking_manager', true);
update public.artist_memberships set access_level = 'owner', is_active = true
where profile_id = 'f3250000-0000-4000-8000-000000000001' and artist_id = 'a1111111-1111-4111-8111-111111111111';
delete from public.artist_memberships where profile_id = 'f3250000-0000-4000-8000-000000000002';

insert into public.clients (id, full_name, email) values
  ('f3251000-0000-4000-8000-000000000001', 'Translation Client', 'tr-client@example.test');
insert into public.enquiries (
  id, client_id, artist_id, reference_number, idempotency_key, intake_fingerprint, status, intake_state,
  submitted_full_name, submitted_email, privacy_notice_version, privacy_acknowledged_at, idea
) values (
  'f3252000-0000-4000-8000-000000000001', 'f3251000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111', 'PENDING', 'f3253000-0000-4000-8000-000000000001', repeat('9', 64),
  'new', 'complete', 'Translation Client', 'tr-client@example.test', '2026-08-05', now(),
  'Half sleeve on my left inner forearm, around 15cm. No colour please.'
);
create temporary table notification_count as select count(*)::int as n from public.notifications;

-- An outsider gets nothing.
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"f3250000-0000-4000-8000-000000000002"}', true);
set local role authenticated;
select throws_ok($$select public.request_enquiry_translation('f3252000-0000-4000-8000-000000000001')$$,
  '42501', null, 'a profile without access to the artist cannot start a translation');
select throws_ok($$select public.get_enquiry_translation('f3252000-0000-4000-8000-000000000001')$$,
  '42501', null, 'nor read one');
reset role;

-- The owner starts one: a pending job, no text.
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"f3250000-0000-4000-8000-000000000001"}', true);
set local role authenticated;
create temporary table first_request as
select public.request_enquiry_translation('f3252000-0000-4000-8000-000000000001') as r;
grant select on first_request to public;
select is((select r ->> 'status' from first_request), 'pending', 'the first click creates a pending job');
select ok((select r ->> 'translation' is null and r ->> 'job_id' is not null from first_request),
  'a pending job has an id and no text');
select is(public.get_enquiry_translation('f3252000-0000-4000-8000-000000000001') ->> 'status', 'pending',
  'reading never starts model work and reports the pending job');
select throws_ok($$select public.request_enquiry_translation('f3252000-0000-4000-8000-000000000001', 'de')$$,
  '22023', null, 'only Russian is offered');
reset role;

-- The backend claims it with the exact source text and completes it.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
create temporary table claim as
select public.service_claim_enquiry_translation((select (r ->> 'job_id')::uuid from first_request), 'tattooai-translation') as c;
grant select on claim to public;
select is((select c ->> 'status' from claim), 'claimed', 'the backend claims the job');
select is((select c ->> 'source_text' from claim),
  'Half sleeve on my left inner forearm, around 15cm. No colour please.', 'the claim carries the exact original text');
select is(public.service_claim_enquiry_translation((select (r ->> 'job_id')::uuid from first_request), 'tattooai-translation') ->> 'status',
  'not_claimed', 'a leased job cannot be claimed twice');
select is(public.service_complete_enquiry_translation(
  (select (r ->> 'job_id')::uuid from first_request), (select (c ->> 'lease_token')::uuid from claim),
  'Полрукава на внутренней стороне левого предплечья, около 15 см. Без цвета, пожалуйста.', 'qwen', '@cf/qwen/qwen3.8-27b') ->> 'status',
  'succeeded', 'the backend stores the translation');
reset role;

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"f3250000-0000-4000-8000-000000000001"}', true);
set local role authenticated;
select is(public.get_enquiry_translation('f3252000-0000-4000-8000-000000000001') ->> 'translation',
  'Полрукава на внутренней стороне левого предплечья, около 15 см. Без цвета, пожалуйста.',
  'the artist reads the translation');
select is(public.request_enquiry_translation('f3252000-0000-4000-8000-000000000001') ->> 'status', 'succeeded',
  'pressing again on unchanged text returns the cached translation');
reset role;
select is((select count(*)::int from crm_private.enquiry_translations
  where enquiry_id = 'f3252000-0000-4000-8000-000000000001'), 1, 'the cache holds one row per source text');
select is((select idea from public.enquiries where id = 'f3252000-0000-4000-8000-000000000001'),
  'Half sleeve on my left inner forearm, around 15cm. No colour please.', 'the original text is never changed');

-- An edited message is never shown with a stale translation.
update public.enquiries set idea = 'Half sleeve on my RIGHT inner forearm.' where id = 'f3252000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"f3250000-0000-4000-8000-000000000001"}', true);
set local role authenticated;
select is(public.get_enquiry_translation('f3252000-0000-4000-8000-000000000001') ->> 'status', 'none',
  'after the text changes the old translation is not offered');
create temporary table second_request as
select public.request_enquiry_translation('f3252000-0000-4000-8000-000000000001') as r;
grant select on second_request to public;
select is((select r ->> 'status' from second_request), 'pending', 'the new text needs a new translation');
reset role;

-- A job whose text changed before the claim is refused; a failure is quiet.
update public.enquiries set idea = 'Changed again.' where id = 'f3252000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select is(public.service_claim_enquiry_translation((select (r ->> 'job_id')::uuid from second_request), 'tattooai-translation') ->> 'status',
  'not_claimed', 'a job for outdated text is never translated');
reset role;
select is((select status from crm_private.enquiry_translations where id = (select (r ->> 'job_id')::uuid from second_request)),
  'failed', 'it is closed as failed');
select is((select count(*)::int from public.notifications), (select n from notification_count),
  'no translation step creates a notification');

select * from finish(true);
rollback;
