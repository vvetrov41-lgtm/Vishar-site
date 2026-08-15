-- 199_crm_record_editing_references.sql
-- Scoped canonical edits and post-intake reference attachment.

begin;
select no_plan();

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('91111111-1111-4111-8111-111111111111', 'edit-owner@example.test'),
  ('92222222-2222-4222-8222-222222222222', 'edit-manager@example.test'),
  ('93333333-3333-4333-8333-333333333333', 'edit-readonly@example.test');

insert into public.profiles (id, email, role, is_active) values
  ('91111111-1111-4111-8111-111111111111', 'edit-owner@example.test', 'owner', true),
  ('92222222-2222-4222-8222-222222222222', 'edit-manager@example.test', 'booking_manager', true),
  ('93333333-3333-4333-8333-333333333333', 'edit-readonly@example.test', 'read_only', true);

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values
  ('92222222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111',
   'manager', false, false, true, false, true),
  ('93333333-3333-4333-8333-333333333333', 'a1111111-1111-4111-8111-111111111111',
   'read_only', false, false, false, false, true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to anon, authenticated, service_role;

set local role authenticated;
select pg_temp.claims('{"sub":"91111111-1111-4111-8111-111111111111","role":"authenticated"}');

create temporary table edit_enquiry as
select public.create_manual_enquiry(
  '90000000-0000-4000-8000-000000000001',
  'a1111111-1111-4111-8111-111111111111',
  jsonb_build_object(
    'full_name', 'Editing Client',
    'email', 'editing@example.test',
    'preferred_contact', 'WhatsApp',
    'travelling_from', 'London'
  ),
  jsonb_build_object(
    'project_type', 'Black & Grey Realism',
    'placement', 'Forearm',
    'preferred_timing', 'October',
    'idea', 'Original idea'
  ),
  true
) as r;
grant select on edit_enquiry to authenticated, service_role;
reset role;

-- Manager can edit mutable canonical/project data in their artist scope.
set local role authenticated;
select pg_temp.claims('{"sub":"92222222-2222-4222-8222-222222222222","role":"authenticated"}');

select lives_ok(
  format(
    $$select public.update_client_details(%L, %L::jsonb)$$,
    (select r ->> 'client_id' from edit_enquiry),
    '{"travelling_from":"UK","instagram":"zenaadii"}'
  ),
  'booking manager can edit canonical client details in their managed artist scope'
);

select is(
  (select travelling_from from public.clients where id = (select (r ->> 'client_id')::uuid from edit_enquiry)),
  'UK',
  'canonical client travelling_from is updated'
);

select lives_ok(
  format(
    $$select public.update_enquiry_details(%L, %L::jsonb)$$,
    (select r ->> 'enquiry_id' from edit_enquiry),
    '{"preferred_timing":"November","idea":"Refined idea"}'
  ),
  'booking manager can edit enquiry project details in their managed artist scope'
);

select is(
  (select preferred_timing from public.enquiries where id = (select (r ->> 'enquiry_id')::uuid from edit_enquiry)),
  'November',
  'enquiry project details are updated'
);
select is(
  (select submitted_travelling_from from public.enquiries where id = (select (r ->> 'enquiry_id')::uuid from edit_enquiry)),
  'London',
  'editing the canonical client does not rewrite the immutable submitted snapshot'
);

select ok(
  exists (
    select 1 from public.activity_log a
    where a.client_id = (select (r ->> 'client_id')::uuid from edit_enquiry)
      and a.event_type = 'client.updated'
      and a.metadata -> 'changed_fields' ? 'travelling_from'
      and a.metadata::text not like '%UK%'
  ),
  'client audit records changed field names without the new PII value'
);

create temporary table prepared_reference as
select public.prepare_enquiry_reference_upload(
  (select (r ->> 'enquiry_id')::uuid from edit_enquiry),
  'reference.jpg', 'image/jpeg', 1024
) as r;
grant select on prepared_reference to authenticated, service_role;

select is(
  (select upload_state::text from public.enquiry_files
   where id = (select (r ->> 'file_id')::uuid from prepared_reference)),
  'pending',
  'reference manifest is pending before Storage upload'
);

select lives_ok(
  format(
    $$insert into storage.objects (bucket_id, name) values ('crm-files', %L)$$,
    (select r ->> 'storage_path' from prepared_reference)
  ),
  'existing artist-scoped Storage policy accepts only the prepared canonical path'
);

select lives_ok(
  format(
    $$select public.finalize_enquiry_reference_upload(%L)$$,
    (select r ->> 'file_id' from prepared_reference)
  ),
  'manager can finalize the manifest after the private object exists'
);

select is(
  (select upload_state::text from public.enquiry_files
   where id = (select (r ->> 'file_id')::uuid from prepared_reference)),
  'ready',
  'finalized reference becomes ready'
);

select throws_ok(
  format(
    $$select public.remove_enquiry_reference_manifest(%L)$$,
    (select r ->> 'file_id' from prepared_reference)
  ),
  '42501', null,
  'booking manager cannot remove stored references because deletion remains owner-only'
);
reset role;

-- Read-only remains unable to mutate even though the RPC names are reachable
-- through PostgREST for authenticated users.
set local role authenticated;
select pg_temp.claims('{"sub":"93333333-3333-4333-8333-333333333333","role":"authenticated"}');
select throws_ok(
  format(
    $$select public.update_enquiry_details(%L, '{"idea":"forged"}'::jsonb)$$,
    (select r ->> 'enquiry_id' from edit_enquiry)
  ),
  '42501', null,
  'read_only cannot edit an enquiry'
);
select throws_ok(
  format(
    $$select public.prepare_enquiry_reference_upload(%L, 'x.jpg', 'image/jpeg', 100)$$,
    (select r ->> 'enquiry_id' from edit_enquiry)
  ),
  '42501', null,
  'read_only cannot prepare a reference upload'
);
reset role;

-- API-role ACL remains narrow. service_role does not need these staff workflows.
select ok(has_function_privilege('authenticated', 'public.update_client_details(uuid,jsonb)', 'EXECUTE'),
  'authenticated may call update_client_details and is then checked inside the RPC');
select ok(has_function_privilege('authenticated', 'public.update_enquiry_details(uuid,jsonb)', 'EXECUTE'),
  'authenticated may call update_enquiry_details and is then checked inside the RPC');
select ok(has_function_privilege('authenticated', 'public.prepare_enquiry_reference_upload(uuid,text,text,bigint)', 'EXECUTE'),
  'authenticated may prepare a reference upload');
select ok(not has_function_privilege('anon', 'public.prepare_enquiry_reference_upload(uuid,text,text,bigint)', 'EXECUTE'),
  'anon cannot prepare a reference upload');
select ok(not has_function_privilege('service_role', 'public.prepare_enquiry_reference_upload(uuid,text,text,bigint)', 'EXECUTE'),
  'service_role is not granted the staff reference workflow');

select * from finish(true);
rollback;
