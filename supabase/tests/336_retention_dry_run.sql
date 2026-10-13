-- 336_retention_dry_run.sql
--
-- Retention phase 1: the assessment classifies enquiries correctly, the dry
-- run is audited without personal data, throttled, never deletes, and the
-- settings cannot leave dry-run-only mode while no executor exists.

begin;
select no_plan();

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated, service_role;

-- Fixtures: four clients of Vladimir's artist, one enquiry each.
insert into public.clients (id, full_name, phone, workspace_id)
select v.id, v.name, v.phone,
       (select workspace_id from public.artists where id = 'a1111111-1111-4111-8111-111111111111')
from (values
  ('c3361111-1111-4111-8111-111111111111'::uuid, 'Retention Candidate', '+44 7700 933611'),
  ('c3362222-2222-4222-8222-222222222222'::uuid, 'Retention Converted', '+44 7700 933622'),
  ('c3363333-3333-4333-8333-333333333333'::uuid, 'Retention Held', '+44 7700 933633'),
  ('c3364444-4444-4444-8444-444444444444'::uuid, 'Retention Session', '+44 7700 933644')
) v(id, name, phone);

insert into public.enquiries (
  id, client_id, reference_number, idempotency_key, intake_fingerprint,
  client_identifier_conflict, submitted_full_name, submitted_email, submitted_phone,
  submitted_preferred_contact, privacy_notice_version, privacy_acknowledged_at, artist_id
)
select v.id, v.client_id, v.ref, gen_random_uuid(), repeat('b', 64), false,
       'Retention Fixture', 'retention@example.test', '+44 7700 933600', 'Email',
       '2026-10-12', now(), 'a1111111-1111-4111-8111-111111111111'
from (values
  ('e3361111-1111-4111-8111-111111111111'::uuid, 'c3361111-1111-4111-8111-111111111111'::uuid, 'ENQ-2099-3361'),
  ('e3362222-2222-4222-8222-222222222222'::uuid, 'c3362222-2222-4222-8222-222222222222'::uuid, 'ENQ-2099-3362'),
  ('e3363333-3333-4333-8333-333333333333'::uuid, 'c3363333-3333-4333-8333-333333333333'::uuid, 'ENQ-2099-3363'),
  ('e3364444-4444-4444-8444-444444444444'::uuid, 'c3364444-4444-4444-8444-444444444444'::uuid, 'ENQ-2099-3364')
) v(id, client_id, ref);

insert into public.projects (client_id, enquiry_id, title)
values ('c3362222-2222-4222-8222-222222222222', 'e3362222-2222-4222-8222-222222222222', 'Converted fixture');

insert into public.retention_holds (client_id, reason_code)
values ('c3363333-3333-4333-8333-333333333333', 'legal_hold_fixture');

-- A project on the client alone (not linked to the enquiry) is still commercial.
insert into public.projects (client_id, title)
values ('c3364444-4444-4444-8444-444444444444', 'Unlinked project fixture');

create temp table fixture_ids(id uuid);
insert into fixture_ids values
  ('e3361111-1111-4111-8111-111111111111'), ('e3362222-2222-4222-8222-222222222222'),
  ('e3363333-3333-4333-8333-333333333333'), ('e3364444-4444-4444-8444-444444444444');

-- ---------------------------------------------------------------------------
-- Assessment
-- ---------------------------------------------------------------------------

select is(
  (select array_agg(coalesce(a.exclusion, 'CANDIDATE') order by a.enquiry_id)
   from crm_private.retention_enquiry_assessment(now() + interval '6 years') a
   where a.enquiry_id in (select id from fixture_ids)),
  array['CANDIDATE', 'converted_to_project', 'retention_hold', 'client_has_commercial_records'],
  'six years on: only the never-converted, unheld enquiry of a non-commercial client is a candidate'
);

select is(
  (select a.exclusion from crm_private.retention_enquiry_assessment(now()) a
   where a.enquiry_id = 'e3361111-1111-4111-8111-111111111111'),
  'recent_activity',
  'today the same enquiry is protected by recent activity'
);

select is(
  (select a.exclusion from crm_private.retention_enquiry_assessment(now() + interval '1824 days') a
   where a.enquiry_id = 'e3361111-1111-4111-8111-111111111111'),
  'recent_activity',
  'one day before 1825 days it is still protected'
);

-- A new inbound message from the client resets the clock.
insert into public.activity_log (event_type, actor_kind, client_id, created_at)
values ('client.contacted_fixture', 'system', 'c3361111-1111-4111-8111-111111111111', now() + interval '3 years');
select is(
  (select a.exclusion from crm_private.retention_enquiry_assessment(now() + interval '6 years') a
   where a.enquiry_id = 'e3361111-1111-4111-8111-111111111111'),
  'recent_activity',
  'later contact with the client extends retention'
);

-- Gmail contact whose 30-day snapshot has expired still counts: the durable
-- activity record keeps the newest message time.
insert into public.clients (id, full_name, phone, workspace_id)
values ('c3365555-5555-4555-8555-555555555555', 'Retention Gmail', '+44 7700 933655',
        (select workspace_id from public.artists where id = 'a1111111-1111-4111-8111-111111111111'));
insert into public.enquiries (
  id, client_id, reference_number, idempotency_key, intake_fingerprint,
  client_identifier_conflict, submitted_full_name, submitted_email, submitted_phone,
  submitted_preferred_contact, privacy_notice_version, privacy_acknowledged_at, artist_id
) values ('e3365555-5555-4555-8555-555555555555', 'c3365555-5555-4555-8555-555555555555', 'ENQ-2099-3365',
  gen_random_uuid(), repeat('b', 64), false, 'Retention Fixture', 'retention@example.test', '+44 7700 933600',
  'Email', '2026-10-12', now(), 'a1111111-1111-4111-8111-111111111111');
select is(
  (select a.exclusion from crm_private.retention_enquiry_assessment(now() + interval '6 years') a
   where a.enquiry_id = 'e3365555-5555-4555-8555-555555555555'),
  null,
  'without later contact the Gmail fixture is a candidate'
);
insert into crm_private.gmail_client_email_activity (artist_id, client_id, last_message_at, last_direction)
values ('a1111111-1111-4111-8111-111111111111', 'c3365555-5555-4555-8555-555555555555', now() + interval '4 years', 'inbound');
select is(
  (select a.exclusion from crm_private.retention_enquiry_assessment(now() + interval '6 years') a
   where a.enquiry_id = 'e3365555-5555-4555-8555-555555555555'),
  'recent_activity',
  'durable Gmail activity extends retention after the snapshot has expired'
);

-- Fail closed without a recorded policy.
update public.system_settings set enquiry_retention_days = null where id;
select is(
  (select count(*)::int from crm_private.retention_enquiry_assessment(now() + interval '6 years') a
   where a.exclusion is distinct from 'policy_inactive'),
  0,
  'no duration recorded: every enquiry is policy_inactive'
);
update public.system_settings set enquiry_retention_days = 1825 where id;

-- ---------------------------------------------------------------------------
-- Guard: no executor, so dry-run only
-- ---------------------------------------------------------------------------

select throws_ok(
  $$update public.system_settings set retention_dry_run_only = false where id$$,
  '23514', null,
  'settings cannot leave dry-run-only mode while no deletion executor exists'
);

-- ---------------------------------------------------------------------------
-- Dry runs: privileges, audit, throttle, nothing deleted
-- ---------------------------------------------------------------------------

select ok(not has_function_privilege('anon', 'public.service_run_retention_dry_run()', 'EXECUTE'), 'anon cannot run the scheduled dry run');
select ok(not has_function_privilege('authenticated', 'public.service_run_retention_dry_run()', 'EXECUTE'), 'staff cannot run the scheduled dry run');
select ok(has_function_privilege('service_role', 'public.service_run_retention_dry_run()', 'EXECUTE'), 'the backend runs the scheduled dry run');
select ok(not has_function_privilege('service_role', 'public.run_retention_dry_run()', 'EXECUTE'), 'the backend cannot use the owner dry run');
select ok(not has_function_privilege('authenticated', 'crm_private.retention_enquiry_assessment(timestamptz)', 'EXECUTE'), 'the assessment is private');

create temp table before_counts as
select (select count(*) from public.enquiries) as enquiries,
       (select count(*) from public.clients) as clients,
       (select count(*) from public.enquiry_files) as files,
       (select count(*) from public.projects) as projects;
grant select on before_counts to service_role;

select throws_ok($$ select public.service_run_retention_dry_run() $$, '42501', null, 'only the backend can run the scheduled dry run');

set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
select is(public.service_run_retention_dry_run() ->> 'status', 'recorded', 'a scheduled dry run is recorded');
select is(public.service_run_retention_dry_run() ->> 'status', 'throttled', 'at most one scheduled dry run per 20 hours');
reset role;

select is((select count(*)::int from public.retention_runs where trigger = 'scheduled'), 1, 'exactly one run is audited');
select ok(
  (select r.candidates::text !~* '(full_name|email|phone|Retention Fixture|example\.test)'
   from public.retention_runs r order by r.created_at desc limit 1),
  'the audit holds ids and dates only, no personal data'
);
select is(
  (select r.retention_days from public.retention_runs r order by r.created_at desc limit 1),
  1825, 'the run records the policy it applied'
);
select ok(
  exists (select 1 from public.activity_log l where l.event_type = 'retention.dry_run_completed'),
  'the dry run is written to the activity log'
);
select ok(
  (select b.enquiries = (select count(*) from public.enquiries)
      and b.clients = (select count(*) from public.clients)
      and b.files = (select count(*) from public.enquiry_files)
      and b.projects = (select count(*) from public.projects)
   from before_counts b),
  'a dry run deletes nothing'
);

select * from finish();
rollback;
