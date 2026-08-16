-- 204_gpt_enquiry_reads.sql
--
-- Private GPT enquiry reads are separately enabled, OAuth-client artist scoped,
-- contact-detail-free and unavailable to anon/service-role callers.

begin;
select no_plan();

select has_column('crm_private', 'gpt_action_clients', 'can_read_enquiries',
  'GPT client bindings have a separate enquiry read permission');
select ok(
  (select bool_and(not can_read_enquiries) from crm_private.gpt_action_clients),
  'enquiry read permission is disabled by default for every logical GPT client'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.gpt_list_enquiries(timestamptz,timestamptz,public.enquiry_status,integer)',
    'EXECUTE'
  ),
  'authenticated OAuth callers may use the protected enquiry list RPC'
);
select ok(
  has_function_privilege('authenticated', 'public.gpt_get_enquiry(uuid)', 'EXECUTE'),
  'authenticated OAuth callers may use the protected enquiry detail RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.gpt_list_enquiries(timestamptz,timestamptz,public.enquiry_status,integer)',
    'EXECUTE'
  ),
  'anonymous callers cannot list GPT enquiries'
);
select ok(
  not has_function_privilege('service_role', 'public.gpt_get_enquiry(uuid)', 'EXECUTE'),
  'service_role cannot use the user OAuth enquiry detail surface'
);
select ok(
  not has_function_privilege('authenticated', 'crm_private.require_gpt_enquiry_context()', 'EXECUTE'),
  'the private enquiry OAuth context resolver is not a browser RPC'
);

insert into auth.users (id, email) values
  ('da011111-1111-4111-8111-111111111111', 'gpt-enquiry-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('da011111-1111-4111-8111-111111111111',
   'gpt-enquiry-owner@example.test', 'GPT Enquiry Owner', 'owner', true);

create function pg_temp.gpt_enquiry_claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.gpt_enquiry_claims(text)
  to authenticated, service_role;

set local role authenticated;
select pg_temp.gpt_enquiry_claims(
  '{"sub":"da011111-1111-4111-8111-111111111111","role":"authenticated"}'
);

select lives_ok(
  $$select public.configure_gpt_action_client(
      'vladimir-gpt-actions', 'oauth-vladimir-enquiry-test', true, true
    )$$,
  'owner can activate the Vladimir GPT fixture'
);
select lives_ok(
  $$select public.configure_gpt_action_client(
      'kristina-gpt-actions', 'oauth-kristina-enquiry-test', true, true
    )$$,
  'owner can activate the Kristina GPT fixture'
);
select lives_ok(
  $$select public.configure_gpt_enquiry_read_access('vladimir-gpt-actions', true)$$,
  'owner can explicitly enable Vladimir enquiry reads'
);
select lives_ok(
  $$select public.configure_gpt_enquiry_read_access('kristina-gpt-actions', true)$$,
  'owner can explicitly enable Kristina enquiry reads'
);

create temporary table vladimir_enquiry_result as
select public.create_manual_enquiry(
  'da021111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  jsonb_build_object(
    'full_name', 'Vladimir Enquiry Client',
    'email', 'vladimir-enquiry@example.test',
    'phone', '+447700900401',
    'instagram', '@vladimir_enquiry_test'
  ),
  jsonb_build_object(
    'project_type', 'Colour realism',
    'placement', 'Forearm',
    'approximate_size', '20 cm',
    'cover_up', 'No',
    'preferred_timing', 'November',
    'idea', 'Synthetic Vladimir enquiry read fixture'
  ),
  true
) as result;
grant select on vladimir_enquiry_result to authenticated, service_role;

create temporary table kristina_enquiry_result as
select public.create_manual_enquiry(
  'da022222-2222-4222-8222-222222222222',
  'a2222222-2222-4222-8222-222222222222',
  jsonb_build_object(
    'full_name', 'Kristina Enquiry Client',
    'email', 'kristina-enquiry@example.test',
    'phone', '+447700900402',
    'instagram', '@kristina_enquiry_test'
  ),
  jsonb_build_object(
    'project_type', 'Watercolour',
    'placement', 'Upper arm',
    'approximate_size', '15 cm',
    'cover_up', 'No',
    'preferred_timing', 'December',
    'idea', 'Synthetic Kristina enquiry read fixture'
  ),
  true
) as result;
grant select on kristina_enquiry_result to authenticated, service_role;

-- A normal CRM token, even for the owner, is insufficient without OAuth client_id.
select throws_ok(
  $$select * from public.gpt_list_enquiries(null, null, null, 20)$$,
  '42501', null,
  'a normal CRM token cannot use the GPT enquiry RPC'
);

select pg_temp.gpt_enquiry_claims(
  '{"sub":"da011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-vladimir-enquiry-test"}'
);
select is(
  (select count(*)::int from public.gpt_list_enquiries(null, null, null, 20)),
  1,
  'Vladimir GPT lists only Vladimir enquiries'
);
select is(
  (select client_name from public.gpt_list_enquiries(null, null, null, 20)),
  'Vladimir Enquiry Client',
  'Vladimir GPT receives the safe client name for its own enquiry'
);
select is(
  (select count(*)::int from public.gpt_get_enquiry(
    (select (result ->> 'enquiry_id')::uuid from kristina_enquiry_result)
  )),
  0,
  'Vladimir GPT cannot read Kristina enquiry detail'
);
select ok(
  not (
    to_jsonb((select x from public.gpt_get_enquiry(
      (select (result ->> 'enquiry_id')::uuid from vladimir_enquiry_result)
    ) x)) ?| array['submitted_email','submitted_phone','submitted_instagram','submitted_travelling_from']
  ),
  'GPT enquiry detail does not expose submitted contact fields'
);

select pg_temp.gpt_enquiry_claims(
  '{"sub":"da011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-kristina-enquiry-test"}'
);
select is(
  (select count(*)::int from public.gpt_list_enquiries(null, null, null, 20)),
  1,
  'Kristina GPT lists only Kristina enquiries'
);
select is(
  (select client_name from public.gpt_list_enquiries(null, null, null, 20)),
  'Kristina Enquiry Client',
  'Kristina GPT cannot receive the Vladimir enquiry'
);

-- The new capability can be independently revoked while appointment access stays active.
select pg_temp.gpt_enquiry_claims(
  '{"sub":"da011111-1111-4111-8111-111111111111","role":"authenticated"}'
);
select lives_ok(
  $$select public.configure_gpt_enquiry_read_access('kristina-gpt-actions', false)$$,
  'owner can revoke only the Kristina enquiry read capability'
);
select pg_temp.gpt_enquiry_claims(
  '{"sub":"da011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-kristina-enquiry-test"}'
);
select throws_ok(
  $$select * from public.gpt_list_enquiries(null, null, null, 20)$$,
  '42501', null,
  'revoked enquiry access fails closed even while the GPT integration remains active'
);

reset role;
select is(
  (select count(*)::int from public.activity_log
   where event_type = 'gpt.client_configured'
     and metadata ? 'enquiry_read_access'),
  3,
  'enquiry capability changes are owner-audited'
);

select * from finish();
rollback;
