-- 205_gpt_full_crm_management.sql
--
-- Full operational GPT management remains separately owner-enabled, fixed to
-- the OAuth client's artist, human-RBAC constrained and unavailable to anon or
-- service-role callers.

begin;
select no_plan();

select has_column('crm_private', 'gpt_action_clients', 'can_manage_crm',
  'GPT bindings have a separate operational CRM capability');
select has_column('crm_private', 'gpt_action_clients', 'can_manage_finance',
  'GPT bindings have a separate finance capability');
select has_column('crm_private', 'gpt_action_clients', 'can_manage_communications',
  'GPT bindings have a separate communications capability');
select ok(
  (select bool_and(not can_manage_crm and not can_manage_finance and not can_manage_communications)
   from crm_private.gpt_action_clients),
  'all full-management capabilities are disabled by default'
);

select ok(
  has_function_privilege('authenticated', 'public.gpt_get_enquiry_full(uuid)', 'EXECUTE'),
  'authenticated OAuth callers may use the full enquiry detail RPC when capability checks pass'
);
select ok(
  has_function_privilege('authenticated', 'public.gpt_update_enquiry(uuid,jsonb)', 'EXECUTE'),
  'authenticated OAuth callers may use the bounded enquiry update RPC'
);
select ok(
  has_function_privilege('authenticated', 'public.gpt_list_projects(public.project_status,integer)', 'EXECUTE'),
  'authenticated OAuth callers may list fixed-artist projects'
);
select ok(
  not has_function_privilege('anon', 'public.gpt_get_client(uuid)', 'EXECUTE'),
  'anonymous callers cannot use contact-detail GPT RPCs'
);
select ok(
  not has_function_privilege('service_role', 'public.gpt_get_client(uuid)', 'EXECUTE'),
  'service_role cannot use the user OAuth contact-detail surface'
);
select ok(
  not has_function_privilege('authenticated', 'crm_private.require_gpt_operational_context(text)', 'EXECUTE'),
  'the private full-management context resolver is not a browser RPC'
);

insert into auth.users (id, email) values
  ('db011111-1111-4111-8111-111111111111', 'gpt-full-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('db011111-1111-4111-8111-111111111111',
   'gpt-full-owner@example.test', 'GPT Full Owner', 'owner', true);

create function pg_temp.gpt_full_claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.gpt_full_claims(text)
  to authenticated, service_role;

set local role authenticated;
select pg_temp.gpt_full_claims(
  '{"sub":"db011111-1111-4111-8111-111111111111","role":"authenticated"}'
);

select lives_ok(
  $$select public.configure_gpt_action_client(
      'vladimir-gpt-actions', 'oauth-vladimir-full-test', true, true
    )$$,
  'owner can activate Vladimir GPT full-management fixture'
);
select lives_ok(
  $$select public.configure_gpt_action_client(
      'kristina-gpt-actions', 'oauth-kristina-full-test', true, true
    )$$,
  'owner can activate Kristina GPT fixture'
);
select lives_ok(
  $$select public.configure_gpt_enquiry_read_access('vladimir-gpt-actions', true)$$,
  'owner can enable Vladimir enquiry reads'
);
select lives_ok(
  $$select public.configure_gpt_enquiry_read_access('kristina-gpt-actions', true)$$,
  'owner can enable Kristina enquiry reads'
);
select lives_ok(
  $$select public.configure_gpt_full_management(
      'vladimir-gpt-actions', true, true, true
    )$$,
  'owner can enable all Vladimir operational capabilities'
);

create temporary table vladimir_full_enquiry as
select public.create_manual_enquiry(
  'db021111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  jsonb_build_object(
    'full_name', 'Vladimir Full Client',
    'email', 'vladimir-full@example.test',
    'phone', '+447700900511',
    'instagram', '@vladimir_full',
    'preferred_contact', 'Email',
    'travelling_from', 'Leeds'
  ),
  jsonb_build_object(
    'project_type', 'Black and grey realism',
    'placement', 'Forearm',
    'approximate_size', '20 cm',
    'cover_up', 'No',
    'preferred_timing', 'November',
    'idea', 'Synthetic full-management Vladimir fixture'
  ),
  true
) as result;
grant select on vladimir_full_enquiry to authenticated, service_role;

create temporary table kristina_full_enquiry as
select public.create_manual_enquiry(
  'db022222-2222-4222-8222-222222222222',
  'a2222222-2222-4222-8222-222222222222',
  jsonb_build_object(
    'full_name', 'Kristina Full Client',
    'email', 'kristina-full@example.test',
    'phone', '+447700900512',
    'instagram', '@kristina_full',
    'preferred_contact', 'Instagram'
  ),
  jsonb_build_object(
    'project_type', 'Watercolour',
    'placement', 'Upper arm',
    'preferred_timing', 'December',
    'idea', 'Synthetic full-management Kristina fixture'
  ),
  true
) as result;
grant select on kristina_full_enquiry to authenticated, service_role;

-- A normal CRM token is insufficient even for the owner.
select throws_ok(
  $$select * from public.gpt_get_enquiry_full(
    (select (result ->> 'enquiry_id')::uuid from vladimir_full_enquiry)
  )$$,
  '42501', null,
  'normal CRM token cannot use full-management GPT RPCs'
);

select pg_temp.gpt_full_claims(
  '{"sub":"db011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-vladimir-full-test"}'
);

select is(
  (select client_email from public.gpt_get_enquiry_full(
    (select (result ->> 'enquiry_id')::uuid from vladimir_full_enquiry)
  )),
  'vladimir-full@example.test',
  'single-record full detail may expose the canonical client email'
);
select is(
  (select client_phone from public.gpt_get_enquiry_full(
    (select (result ->> 'enquiry_id')::uuid from vladimir_full_enquiry)
  )),
  '+447700900511',
  'single-record full detail may expose the canonical client phone'
);
select is(
  (select count(*)::int from public.gpt_get_enquiry_full(
    (select (result ->> 'enquiry_id')::uuid from kristina_full_enquiry)
  )),
  0,
  'Vladimir GPT cannot read Kristina full enquiry detail'
);

select lives_ok(
  $$select public.gpt_update_enquiry(
      (select (result ->> 'enquiry_id')::uuid from vladimir_full_enquiry),
      '{"placement":"Outer forearm"}'::jsonb
    )$$,
  'Vladimir GPT can update its own enquiry through the canonical workflow RPC'
);
select is(
  (select placement from public.enquiries
   where id = (select (result ->> 'enquiry_id')::uuid from vladimir_full_enquiry)),
  'Outer forearm',
  'bounded enquiry update persisted only the requested field'
);
select throws_ok(
  $$select public.gpt_update_enquiry(
      (select (result ->> 'enquiry_id')::uuid from kristina_full_enquiry),
      '{"placement":"Forbidden"}'::jsonb
    )$$,
  '42501', null,
  'Vladimir GPT cannot mutate Kristina enquiry'
);

select lives_ok(
  $$select public.gpt_update_client(
      (select (result ->> 'client_id')::uuid from vladimir_full_enquiry),
      '{"instagram":"@vladimir_full_updated"}'::jsonb
    )$$,
  'Vladimir GPT can update a non-shared client in its own artist scope'
);
select is(
  (select instagram from public.clients
   where id = (select (result ->> 'client_id')::uuid from vladimir_full_enquiry)),
  '@vladimir_full_updated',
  'client update persisted through the canonical audited RPC'
);

create temporary table gpt_created_enquiry as
select public.gpt_create_manual_enquiry(
  'db023333-3333-4333-8333-333333333333',
  jsonb_build_object(
    'full_name', 'GPT Created Client',
    'email', 'gpt-created@example.test'
  ),
  jsonb_build_object(
    'project_type', 'Portrait',
    'placement', 'Calf',
    'idea', 'Synthetic manual creation through fixed artist GPT'
  ),
  true
) as result;
grant select on gpt_created_enquiry to authenticated, service_role;
select is(
  (select artist_id from public.enquiries
   where id = (select (result ->> 'enquiry_id')::uuid from gpt_created_enquiry)),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'manual GPT enquiry creation derives Vladimir artist from OAuth client_id'
);

create temporary table converted_project as
select public.gpt_convert_enquiry_to_project(
  (select (result ->> 'enquiry_id')::uuid from vladimir_full_enquiry),
  'Vladimir full-management project',
  'Initial description'
) as result;
grant select on converted_project to authenticated, service_role;

select lives_ok(
  $$select public.gpt_update_project_details(
      (select (result ->> 'project_id')::uuid from converted_project),
      'Updated full-management project',
      'Updated description'
    )$$,
  'GPT can edit title and description of its fixed-artist project'
);
select lives_ok(
  $$select public.gpt_set_project_status(
      (select (result ->> 'project_id')::uuid from converted_project),
      'active'
    )$$,
  'GPT can manage project lifecycle inside its fixed artist scope'
);
select is(
  (select status::text from public.projects
   where id = (select (result ->> 'project_id')::uuid from converted_project)),
  'active',
  'project status change persisted'
);

select lives_ok(
  $$select public.gpt_create_internal_note(
      'Synthetic private note',
      (select (result ->> 'client_id')::uuid from vladimir_full_enquiry),
      (select (result ->> 'enquiry_id')::uuid from vladimir_full_enquiry),
      null,
      null
    )$$,
  'GPT can create an internal note only through linked fixed-artist records'
);
select is(
  (select count(*)::int from public.gpt_list_internal_notes(
    null,
    (select (result ->> 'enquiry_id')::uuid from vladimir_full_enquiry),
    null, null, 20
  )),
  1,
  'GPT can list internal notes for its own enquiry'
);

create temporary table full_follow_up as
select public.gpt_create_follow_up(
  'Synthetic GPT follow-up',
  now() + interval '2 days',
  (select (result ->> 'client_id')::uuid from vladimir_full_enquiry),
  (select (result ->> 'enquiry_id')::uuid from vladimir_full_enquiry),
  null, null,
  'Synthetic follow-up details'
) as result;
grant select on full_follow_up to authenticated, service_role;
select lives_ok(
  $$select public.gpt_cancel_follow_up(
      (select (result ->> 'follow_up_id')::uuid from full_follow_up)
    )$$,
  'GPT can cancel its own open follow-up'
);
select is(
  (select status::text from public.follow_ups
   where id = (select (result ->> 'follow_up_id')::uuid from full_follow_up)),
  'cancelled',
  'follow-up cancellation persisted'
);

select lives_ok(
  $$select public.gpt_create_availability_block(
      'personal',
      '2030-01-05T10:00:00Z'::timestamptz,
      '2030-01-05T12:00:00Z'::timestamptz,
      false,
      'Synthetic GPT availability test'
    )$$,
  'GPT appointment-write capability can create a fixed-artist availability block'
);
select is(
  (select count(*)::int from public.gpt_list_availability_blocks(
    '2030-01-05T00:00:00Z', '2030-01-06T00:00:00Z', false
  )),
  1,
  'GPT lists only its artist availability block'
);

-- Kristina is active for appointment/enquiry reads but full management remains default-off.
select pg_temp.gpt_full_claims(
  '{"sub":"db011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-kristina-full-test"}'
);
select throws_ok(
  $$select * from public.gpt_get_enquiry_full(
    (select (result ->> 'enquiry_id')::uuid from kristina_full_enquiry)
  )$$,
  '42501', null,
  'Kristina full-management surface fails closed until owner enables it'
);

reset role;
select is(
  (select count(*)::int
   from public.activity_log
   where event_type = 'gpt.client_configured'
     and metadata ? 'manage_crm'),
  1,
  'full-management capability enablement is owner-audited'
);
select ok(
  exists (
    select 1 from public.activity_log
    where event_type = 'project.status_changed'
      and artist_id = 'a1111111-1111-4111-8111-111111111111'
  ),
  'new project lifecycle mutation is artist-audited'
);

select * from finish();
rollback;
