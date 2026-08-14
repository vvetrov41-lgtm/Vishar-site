-- 186_gpt_oauth_consent_guard.sql
--
-- Consent UI database guard: active client, fixed artist and current human
-- capability are checked before Supabase authorization approval is possible.

begin;
select no_plan();

select ok(
  has_function_privilege(
    'authenticated',
    'public.get_gpt_action_consent_summary(text)',
    'EXECUTE'
  ),
  'authenticated CRM users may call the narrow consent summary RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.get_gpt_action_consent_summary(text)',
    'EXECUTE'
  ),
  'anonymous users cannot inspect GPT consent mappings'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.get_gpt_action_consent_summary(text)',
    'EXECUTE'
  ),
  'service_role is not a public GPT consent caller'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('f1011111-1111-4111-8111-111111111111', 'consent-owner@example.test'),
  ('f1022222-2222-4222-8222-222222222222', 'consent-kristina@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  (
    'f1011111-1111-4111-8111-111111111111',
    'consent-owner@example.test',
    'Consent Owner',
    'owner',
    true
  ),
  (
    'f1022222-2222-4222-8222-222222222222',
    'consent-kristina@example.test',
    'Consent Kristina Manager',
    'booking_manager',
    true
  );

insert into public.artist_memberships (
  profile_id, artist_id, access_level,
  can_view_finance, can_manage_finance,
  can_manage_sessions, can_manage_integrations, is_active
) values (
  'f1022222-2222-4222-8222-222222222222',
  'a2222222-2222-4222-8222-222222222222',
  'manager', false, false, true, false, true
);

update crm_private.gpt_action_clients
set oauth_client_id = case integration_key
      when 'vladimir-gpt-actions' then 'oauth-consent-vladimir'
      when 'kristina-gpt-actions' then 'oauth-consent-kristina'
    end,
    can_read_appointments = true,
    can_manage_appointments = true,
    is_active = true
where integration_key in ('vladimir-gpt-actions', 'kristina-gpt-actions');

create function pg_temp.consent_claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.consent_claims(text)
  to authenticated, service_role;

set local role authenticated;
select pg_temp.consent_claims(
  '{"sub":"f1022222-2222-4222-8222-222222222222","role":"authenticated"}'
);
select is(
  (select integration_key
   from public.get_gpt_action_consent_summary('oauth-consent-kristina')),
  'kristina-gpt-actions',
  'Kristina manager may consent to the Kristina GPT client'
);
select is(
  (select artist_id
   from public.get_gpt_action_consent_summary('oauth-consent-kristina')),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'Kristina consent summary exposes only the fixed Kristina artist id'
);
select is(
  (select can_manage_appointments
   from public.get_gpt_action_consent_summary('oauth-consent-kristina')),
  true,
  'Kristina consent summary accurately displays write capability'
);
select throws_ok(
  $$select * from public.get_gpt_action_consent_summary('oauth-consent-vladimir')$$,
  '42501',
  null,
  'Kristina manager cannot consent to the Vladimir GPT client'
);
select throws_ok(
  $$select * from public.get_gpt_action_consent_summary('oauth-consent-unknown')$$,
  '42501',
  null,
  'unknown OAuth clients fail closed'
);
reset role;

set local role authenticated;
select pg_temp.consent_claims(
  '{"sub":"f1011111-1111-4111-8111-111111111111","role":"authenticated"}'
);
select is(
  (select integration_key
   from public.get_gpt_action_consent_summary('oauth-consent-vladimir')),
  'vladimir-gpt-actions',
  'owner may consent to the Vladimir GPT client'
);
select is(
  (select integration_key
   from public.get_gpt_action_consent_summary('oauth-consent-kristina')),
  'kristina-gpt-actions',
  'owner may consent to the Kristina GPT client while its later actions remain fixed to Kristina'
);
reset role;

-- Disabling the logical client immediately closes the consent path.
update crm_private.gpt_action_clients
set is_active = false
where integration_key = 'kristina-gpt-actions';

set local role authenticated;
select pg_temp.consent_claims(
  '{"sub":"f1022222-2222-4222-8222-222222222222","role":"authenticated"}'
);
select throws_ok(
  $$select * from public.get_gpt_action_consent_summary('oauth-consent-kristina')$$,
  '42501',
  null,
  'disabled Kristina GPT client cannot be approved through consent UI'
);
reset role;

select * from finish();
rollback;
