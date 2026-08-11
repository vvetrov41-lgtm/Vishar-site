-- 193_manual_crm_intake.sql
--
-- Private CRM manual enquiry creation is authenticated, artist-scoped,
-- idempotent and provider-inert.

begin;
select no_plan();

select ok(
  has_function_privilege(
    'authenticated',
    'public.create_manual_enquiry(uuid,uuid,jsonb,jsonb,boolean)',
    'EXECUTE'
  ),
  'authenticated CRM sessions may call the protected manual intake RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.create_manual_enquiry(uuid,uuid,jsonb,jsonb,boolean)',
    'EXECUTE'
  ),
  'anonymous callers cannot call manual intake'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.create_manual_enquiry(uuid,uuid,jsonb,jsonb,boolean)',
    'EXECUTE'
  ),
  'service_role is not a manual staff-intake caller'
);
select ok(
  not has_table_privilege('authenticated', 'public.enquiries', 'INSERT'),
  'manual intake does not widen direct enquiry table writes'
);
select ok(
  not has_table_privilege('authenticated', 'public.clients', 'INSERT'),
  'manual intake does not widen direct client table writes'
);

insert into auth.users (id, email) values
  ('d8111111-1111-4111-8111-111111111111', 'manual-manager@example.test'),
  ('d8122222-2222-4222-8222-222222222222', 'manual-reader@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('d8111111-1111-4111-8111-111111111111', 'manual-manager@example.test',
   'Manual Manager', 'booking_manager', true),
  ('d8122222-2222-4222-8222-222222222222', 'manual-reader@example.test',
   'Manual Reader', 'read_only', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('d8111111-1111-4111-8111-111111111111',
   'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, false, true),
  ('d8122222-2222-4222-8222-222222222222',
   'a1111111-1111-4111-8111-111111111111',
   'read_only', false, false, false, false, true);

create function pg_temp.manual_claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.manual_claims(text) to authenticated, service_role;

set local role authenticated;
select pg_temp.manual_claims(
  '{"sub":"d8111111-1111-4111-8111-111111111111","role":"authenticated"}'
);

create temporary table manual_result as
select public.create_manual_enquiry(
  'd8211111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  jsonb_build_object(
    'full_name', 'Manual Synthetic Client',
    'email', 'manual-client@example.test',
    'phone', '+447700900321',
    'instagram', '@manual_synthetic',
    'preferred_contact', 'Email',
    'travelling_from', 'Synthetic Test City'
  ),
  jsonb_build_object(
    'project_type', 'Synthetic manual tattoo enquiry',
    'placement', 'Forearm',
    'approximate_size', '15 cm',
    'cover_up', 'No',
    'preferred_timing', 'Synthetic timing',
    'idea', 'Synthetic manual intake fixture only'
  ),
  true
) as result;
grant select on manual_result to authenticated, service_role;

select is(
  (select result ->> 'intake_state' from manual_result),
  'complete',
  'manual intake is immediately complete without public upload finalisation'
);
select is(
  (select (result ->> 'replayed')::boolean from manual_result),
  false,
  'the first manual intake is not an idempotent replay'
);

reset role;
select pg_temp.manual_claims('{"role":"service_role"}');

select is(
  (select artist_id from public.enquiries
   where id = (select (result ->> 'enquiry_id')::uuid from manual_result)),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'manual enquiry is bound to the explicitly authorized artist'
);
select is(
  (select source from public.enquiries
   where id = (select (result ->> 'enquiry_id')::uuid from manual_result)),
  'crm_manual',
  'manual source provenance is server-authored'
);
select is(
  (select booking_source_id from public.enquiries
   where id = (select (result ->> 'enquiry_id')::uuid from manual_result)),
  null::uuid,
  'manual intake does not invent a public booking source'
);
select is(
  (select privacy_notice_version from public.enquiries
   where id = (select (result ->> 'enquiry_id')::uuid from manual_result)),
  '2026-07-29',
  'manual intake records the current privacy notice version only after staff confirmation'
);
select ok(
  (select privacy_acknowledged_at is not null from public.enquiries
   where id = (select (result ->> 'enquiry_id')::uuid from manual_result)),
  'manual intake records the acknowledged-at boundary'
);
select is(
  (select count(*)::int from public.enquiry_files
   where enquiry_id = (select (result ->> 'enquiry_id')::uuid from manual_result)),
  0,
  'manual intake creates no synthetic file manifests'
);
select is(
  (select count(*)::int from public.integration_outbox
   where enquiry_id = (select (result ->> 'enquiry_id')::uuid from manual_result)),
  0,
  'manual intake creates no external integration outbox work'
);
select is(
  (select count(*)::int from public.activity_log
   where enquiry_id = (select (result ->> 'enquiry_id')::uuid from manual_result)
     and event_type = 'enquiry.manual_created'
     and actor_kind = 'user'
     and actor_profile_id = 'd8111111-1111-4111-8111-111111111111'),
  1,
  'manual creation has one artist-scoped human audit event'
);

set local role authenticated;
select pg_temp.manual_claims(
  '{"sub":"d8111111-1111-4111-8111-111111111111","role":"authenticated"}'
);

select is(
  (public.create_manual_enquiry(
    'd8211111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111',
    jsonb_build_object(
      'full_name', 'Manual Synthetic Client',
      'email', 'manual-client@example.test',
      'phone', '+447700900321',
      'instagram', '@manual_synthetic',
      'preferred_contact', 'Email',
      'travelling_from', 'Synthetic Test City'
    ),
    jsonb_build_object(
      'project_type', 'Synthetic manual tattoo enquiry',
      'placement', 'Forearm',
      'approximate_size', '15 cm',
      'cover_up', 'No',
      'preferred_timing', 'Synthetic timing',
      'idea', 'Synthetic manual intake fixture only'
    ),
    true
  ) ->> 'enquiry_id'),
  (select result ->> 'enquiry_id' from manual_result),
  'same idempotency key and canonical payload replay the original manual enquiry'
);
select is(
  (public.create_manual_enquiry(
    'd8211111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111',
    jsonb_build_object(
      'full_name', 'Manual Synthetic Client',
      'email', 'manual-client@example.test',
      'phone', '+447700900321',
      'instagram', '@manual_synthetic',
      'preferred_contact', 'Email',
      'travelling_from', 'Synthetic Test City'
    ),
    jsonb_build_object(
      'project_type', 'Synthetic manual tattoo enquiry',
      'placement', 'Forearm',
      'approximate_size', '15 cm',
      'cover_up', 'No',
      'preferred_timing', 'Synthetic timing',
      'idea', 'Synthetic manual intake fixture only'
    ),
    true
  ) ->> 'replayed'),
  'true',
  'same manual request reports an idempotent replay'
);

select throws_ok(
  $$select public.create_manual_enquiry(
    'd8211111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111',
    '{"full_name":"Manual Synthetic Client","email":"manual-client@example.test"}'::jsonb,
    '{"idea":"changed payload"}'::jsonb,
    true
  )$$,
  '22023', null,
  'reusing an idempotency key with a changed payload is rejected'
);

select throws_ok(
  $$select public.create_manual_enquiry(
    'd8222222-2222-4222-8222-222222222222',
    'a2222222-2222-4222-8222-222222222222',
    '{"full_name":"Cross Artist","email":"cross-artist@example.test"}'::jsonb,
    '{}'::jsonb,
    true
  )$$,
  '42501', 'artist access is not permitted',
  'a booking manager cannot create a manual enquiry for an artist outside their membership'
);

select throws_ok(
  $$select public.create_manual_enquiry(
    'd8233333-3333-4233-8233-333333333333',
    'a1111111-1111-4111-8111-111111111111',
    '{"full_name":"Privacy Missing","email":"privacy-missing@example.test"}'::jsonb,
    '{}'::jsonb,
    false
  )$$,
  '22023', null,
  'manual intake cannot fabricate a privacy acknowledgement'
);

select pg_temp.manual_claims(
  '{"sub":"d8122222-2222-4222-8222-222222222222","role":"authenticated"}'
);
select throws_ok(
  $$select public.create_manual_enquiry(
    'd8244444-4444-4244-8244-444444444444',
    'a1111111-1111-4111-8111-111111111111',
    '{"full_name":"Read Only","email":"readonly-manual@example.test"}'::jsonb,
    '{}'::jsonb,
    true
  )$$,
  '42501', null,
  'read-only staff cannot create manual enquiries'
);

reset role;
select pg_temp.manual_claims('{"role":"service_role"}');
select is(
  (select count(*)::int from public.activity_log
   where enquiry_id = (select (result ->> 'enquiry_id')::uuid from manual_result)
     and event_type = 'enquiry.manual_created'),
  1,
  'idempotent replay does not duplicate the manual creation audit event'
);
select is(
  (select count(*)::int from public.integration_outbox
   where enquiry_id = (select (result ->> 'enquiry_id')::uuid from manual_result)),
  0,
  'denial and replay paths still leave no provider work'
);

select * from finish();
rollback;
