-- 030_intake.sql
--
-- The atomic intake RPC: idempotent replay, client matching, conflict
-- handling, file manifests, activity and outbox jobs.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values ('11111111-1111-4111-8111-111111111111', 'owner@example.test');
insert into public.profiles (id, email, role, is_active)
values ('11111111-1111-4111-8111-111111111111', 'owner@example.test', 'owner', true);

-- Reusable payloads. `pg_temp` keeps them out of the schema entirely and they
-- disappear with the rollback.
create function pg_temp.files(n integer)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'mime_type', 'image/jpeg',
    'safe_extension', 'jpg',
    'byte_size', 2048,
    'original_filename', 'reference-' || i || '.jpg'
  )), '[]'::jsonb)
  from generate_series(1, n) as i;
$$;

create function pg_temp.enquiry_meta()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'project_type', 'Colour realism',
    'placement', 'Outer forearm',
    'approximate_size', '20 cm',
    'cover_up', 'No',
    'preferred_timing', 'Flexible',
    'idea', 'A realistic raven with natural lighting.',
    'source', '/booking/',
    'landing_page', 'https://vishartattoo.com/booking/',
    'referrer', 'https://www.google.com/',
    'utm_source', 'google',
    'utm_medium', 'organic'
  );
$$;

-- ---------------------------------------------------------------------------
-- First intake creates everything
-- ---------------------------------------------------------------------------

create temporary table t_first as
select public.create_enquiry_intake(
  'aaaaaaaa-0000-4000-8000-000000000001',
  jsonb_build_object('full_name', 'Ada Client', 'email', 'Ada@Example.TEST',
                     'phone', '+44 7700 900001', 'preferred_contact', 'Email',
                     'travelling_from', 'Manchester'),
  pg_temp.enquiry_meta(),
  pg_temp.files(2)
) as r;

select ok((select (r ->> 'replayed')::boolean is false from t_first),
          'a first submission is not a replay');
select ok((select r ->> 'reference_number' ~ '^ENQ-[0-9]{4}-[0-9]{4,}$' from t_first),
          'intake returns a formatted reference number');
select is((select jsonb_array_length(r -> 'files') from t_first), 2,
          'intake returns one manifest per expected file');
select is((select r ->> 'intake_state' from t_first), 'files_pending',
          'a new enquiry starts in files_pending, not complete');
select is((select r ->> 'client_match_method' from t_first), 'created',
          'a brand new client is created');
select ok((select not (r ->> 'client_conflict')::boolean from t_first),
          'a first submission reports no client conflict');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);

select is((select count(*)::int from public.enquiries), 1, 'exactly one enquiry row exists');
select is((select count(*)::int from public.enquiry_files), 2, 'two file manifests exist');
select is((select count(distinct upload_state)::int from public.enquiry_files), 1,
          'every manifest starts in the same state');
select is((select upload_state::text from public.enquiry_files limit 1), 'pending',
          'manifests are created pending, before any upload is attempted');

select ok(
  (select bool_and(f.storage_path = 'clients/' || e.client_id || '/enquiries/' || e.id
                                  || '/references/' || f.id || '.jpg')
   from public.enquiry_files f join public.enquiries e on e.id = f.enquiry_id),
  'every manifest carries a canonical, server-derived storage path'
);

select is((select count(*)::int from public.activity_log where event_type = 'enquiry.created'), 1,
          'intake writes exactly one enquiry.created activity row');
select is((select count(*)::int from public.activity_log where event_type = 'client.created'), 1,
          'intake writes a client.created activity row for a new client');

select is((select count(*)::int from public.integration_outbox
           where kind = 'telegram_notification'), 1,
          'intake enqueues one Telegram notification');
select ok(
  (select dedupe_key = 'telegram:enquiry_created:' || (select id from public.enquiries)
   from public.integration_outbox where kind = 'telegram_notification'),
  'the Telegram job uses a deterministic dedupe key'
);
select is((select status::text from public.integration_outbox limit 1), 'pending',
          'the notification is queued, not delivered inside the transaction');

-- The outbox payload must not become a second copy of the client's data.
select throws_ok(
  $$insert into public.integration_outbox (kind, dedupe_key, payload)
    values ('telegram_notification', 'telegram:leak:1', '{"email":"leak@example.test"}'::jsonb)$$,
  '23514', null,
  'an outbox payload carrying an email address is rejected'
);

-- ---------------------------------------------------------------------------
-- Replay
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table t_replay as
select public.create_enquiry_intake(
  'aaaaaaaa-0000-4000-8000-000000000001',
  jsonb_build_object('full_name', 'Ada Client', 'email', 'Ada@Example.TEST'),
  pg_temp.enquiry_meta(),
  pg_temp.files(2)
) as r;

select ok((select (r ->> 'replayed')::boolean from t_replay), 'the same key reports a replay');
select is((select f.r ->> 'enquiry_id' from t_first f), (select r ->> 'enquiry_id' from t_replay),
          'a replay returns the original enquiry id');
select is((select f.r ->> 'reference_number' from t_first f), (select r ->> 'reference_number' from t_replay),
          'a replay returns the original reference number');
select is((select count(*)::int from public.enquiries), 1, 'a replay creates no second enquiry');
select is((select count(*)::int from public.enquiry_files), 2, 'a replay creates no extra manifests');
select is((select count(*)::int from public.activity_log where event_type = 'enquiry.created'), 1,
          'a replay writes no second creation activity');
select is((select count(*)::int from public.integration_outbox), 1,
          'a replay enqueues no second notification');

-- ---------------------------------------------------------------------------
-- Client matching
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Same email, different case and spacing: same client.
create temporary table t_same_email as
select public.create_enquiry_intake(
  'aaaaaaaa-0000-4000-8000-000000000002',
  jsonb_build_object('full_name', 'Ada C', 'email', '  ada@EXAMPLE.test '),
  pg_temp.enquiry_meta(), pg_temp.files(1)
) as r;

select is((select r ->> 'client_match_method' from t_same_email), 'email',
          'a differently-cased email matches the existing client');
select is((select f.r ->> 'client_id' from t_first f), (select r ->> 'client_id' from t_same_email),
          'the matched client is the original one');
select is((select count(*)::int from public.clients), 1, 'no duplicate client is created');

-- Different email, same international phone: matched on phone.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table t_phone as
select public.create_enquiry_intake(
  'aaaaaaaa-0000-4000-8000-000000000003',
  jsonb_build_object('full_name', 'Ada Again', 'email', 'ada.other@example.test',
                     'phone', '+447700900001'),
  pg_temp.enquiry_meta(), pg_temp.files(1)
) as r;

select is((select r ->> 'client_match_method' from t_phone), 'phone',
          'a matching international phone number matches the client when the email is new');

-- A name match must never be enough.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table t_name as
select public.create_enquiry_intake(
  'aaaaaaaa-0000-4000-8000-000000000004',
  jsonb_build_object('full_name', 'Ada Client', 'email', 'different@example.test'),
  pg_temp.enquiry_meta(), pg_temp.files(1)
) as r;

select is((select r ->> 'client_match_method' from t_name), 'created',
          'an identical name with a new email creates a NEW client, never a match');
select isnt((select f.r ->> 'client_id' from t_first f), (select r ->> 'client_id' from t_name),
            'the name match did not attach to the existing client');

-- A national-format phone is not a match key, so it cannot cause a merge.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table t_national as
select public.create_enquiry_intake(
  'aaaaaaaa-0000-4000-8000-000000000005',
  jsonb_build_object('full_name', 'Local Number', 'email', 'local@example.test',
                     'phone', '07700 900001'),
  pg_temp.enquiry_meta(), pg_temp.files(1)
) as r;

select is((select r ->> 'client_match_method' from t_national), 'created',
          'a national-format phone does not match an international one');

-- ---------------------------------------------------------------------------
-- Email / phone conflict
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table t_conflict as
select public.create_enquiry_intake(
  'aaaaaaaa-0000-4000-8000-000000000006',
  -- email belongs to the "different@example.test" client, phone to the first one
  jsonb_build_object('full_name', 'Conflicted', 'email', 'different@example.test',
                     'phone', '+447700900001'),
  pg_temp.enquiry_meta(), pg_temp.files(1)
) as r;

select ok((select (r ->> 'client_conflict')::boolean from t_conflict),
          'two identifiers resolving to two clients is reported as a conflict');
select is((select r ->> 'client_match_method' from t_conflict), 'email_with_phone_conflict',
          'the conflict is resolved deterministically in favour of the email match');
select is((select n.r ->> 'client_id' from t_name n), (select r ->> 'client_id' from t_conflict),
          'the enquiry attaches to the email-matched client');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
select is((select count(*)::int from public.activity_log where event_type = 'client.identifier_conflict'), 1,
          'the conflict is recorded for human review');
select ok(
  (select (metadata ->> 'requires_review')::boolean from public.activity_log
   where event_type = 'client.identifier_conflict'),
  'the conflict activity is flagged as needing review'
);

-- Nothing was merged.
select is((select count(*)::int from public.clients), 3,
          'the conflict merged nothing: all three distinct clients still exist');

-- ---------------------------------------------------------------------------
-- Input validation
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok(
  $$select public.create_enquiry_intake(gen_random_uuid(),
      jsonb_build_object('full_name', 'No Email'), pg_temp.enquiry_meta(), pg_temp.files(1))$$,
  '22023', null,
  'intake without a valid email is refused'
);

select throws_ok(
  $$select public.create_enquiry_intake(gen_random_uuid(),
      jsonb_build_object('full_name', '   ', 'email', 'x@example.test'),
      pg_temp.enquiry_meta(), pg_temp.files(1))$$,
  '22023', null,
  'intake without a name is refused'
);

select throws_ok(
  $$select public.create_enquiry_intake(gen_random_uuid(),
      jsonb_build_object('full_name', 'Too Many', 'email', 'many@example.test'),
      pg_temp.enquiry_meta(), pg_temp.files(4))$$,
  '22023', null,
  'more than three reference files is refused'
);

select throws_ok(
  $$select public.create_enquiry_intake(gen_random_uuid(),
      jsonb_build_object('full_name', 'None', 'email', 'none@example.test'),
      pg_temp.enquiry_meta(), pg_temp.files(0))$$,
  '22023', null,
  'zero reference files is refused'
);

select throws_ok(
  $$select public.create_enquiry_intake(null,
      jsonb_build_object('full_name', 'No Key', 'email', 'nokey@example.test'),
      pg_temp.enquiry_meta(), pg_temp.files(1))$$,
  '22023', null,
  'intake without an idempotency key is refused'
);

-- ---------------------------------------------------------------------------
-- Completion and failure
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok(
  format($$select public.finalize_enquiry_intake(%L)$$, (select r ->> 'enquiry_id' from t_first)),
  '22023', null,
  'an intake cannot be finalised while a manifest is still pending'
);

select public.mark_enquiry_file_uploaded(f.id) from public.enquiry_files f;

select lives_ok(
  format($$select public.finalize_enquiry_intake(%L)$$, (select r ->> 'enquiry_id' from t_first)),
  'an intake finalises once every manifest is ready'
);

select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
select is((select intake_state::text from public.enquiries where id = (select r ->> 'enquiry_id' from t_first)::uuid),
          'complete', 'the finalised enquiry is complete');
select is((select count(*)::int from public.activity_log where event_type = 'enquiry.intake_completed'), 1,
          'completion is recorded in the activity log');

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.fail_enquiry_intake((select r ->> 'enquiry_id' from t_name)::uuid, 'storage_upload_failed');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
select is((select intake_state::text from public.enquiries where id = (select r ->> 'enquiry_id' from t_name)::uuid),
          'failed', 'a failed intake is marked failed');
select is((select intake_error_code from public.enquiries where id = (select r ->> 'enquiry_id' from t_name)::uuid),
          'storage_upload_failed', 'a short machine error code is stored');

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  format($$select public.fail_enquiry_intake(%L, 'Upload failed: client@example.test could not be saved')$$,
         (select r ->> 'enquiry_id' from t_name)),
  '22023', null,
  'a free-text error message is refused, so no PII can reach intake_error_code'
);

-- Incomplete intakes are visible to reconciliation and stay out of the queue.
select ok(
  (select count(*) from public.list_incomplete_intakes(0, 50)) >= 1,
  'incomplete intakes are listed for reconciliation'
);

select * from finish(true);
rollback;
