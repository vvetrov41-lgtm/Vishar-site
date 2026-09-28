-- 1840_gpt_provider_authorizers.sql
--
-- Unified GPT v2 provider authorizers: they return the server-owned Artist a
-- provider Worker may act for, only after the GPT client ceiling and CRM
-- capability pass, and never for an Artist the model names.

begin;
select no_plan();

select ok(
  (select bool_and(
     has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and not has_function_privilege('anon', p.oid, 'EXECUTE')
     and not has_function_privilege('service_role', p.oid, 'EXECUTE')
     and p.prosecdef
     and pg_get_function_identity_arguments(p.oid) !~ 'artist')
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('gpt_authorize_provider_action', 'gpt_authorize_gmail_client')),
  'provider authorizers are authenticated-only definers that take no Artist'
);

insert into auth.users (id, email) values ('d0011111-1111-4111-8111-111111111111', 'gpt-provider-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('d0011111-1111-4111-8111-111111111111', 'gpt-provider-owner@example.test', 'GPT Provider Owner', 'owner', true);

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated;

set local role authenticated;
select pg_temp.claims('{"sub":"d0011111-1111-4111-8111-111111111111","role":"authenticated"}');
select public.configure_gpt_action_client('vishar-unified-gpt', 'oauth-unified-provider', true, true);
select public.configure_gpt_enquiry_read_access('vishar-unified-gpt', true);

create temporary table provider_k as
select public.create_manual_enquiry(
  'd0021111-1111-4111-8111-111111111111', 'a2222222-2222-4222-8222-222222222222',
  jsonb_build_object('full_name', 'Provider Kristina Client', 'email', 'provider-kristina@example.test'),
  jsonb_build_object('project_type', 'Fine line', 'placement', 'Wrist', 'idea', 'Synthetic provider fixture'),
  true) as result;
create temporary table provider_v as
select public.create_manual_enquiry(
  'd0022222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111',
  jsonb_build_object('full_name', 'Provider Vladimir Client', 'email', 'provider-vladimir@example.test'),
  jsonb_build_object('project_type', 'Realism', 'placement', 'Arm', 'idea', 'Synthetic provider fixture'),
  true) as result;
grant select on provider_k, provider_v to authenticated;

select pg_temp.claims('{"sub":"d0011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-provider"}');
select public.gpt_artist_context('a1111111-1111-4111-8111-111111111111');

select throws_ok($$select public.gpt_authorize_provider_action('gmail_inbox')$$, '42501', null,
  'Gmail reads need the communications ceiling');
select throws_ok($$select public.gpt_authorize_provider_action('instagram_view')$$, '42501', null,
  'Instagram status needs the integrations ceiling');

select pg_temp.claims('{"sub":"d0011111-1111-4111-8111-111111111111","role":"authenticated"}');
select public.configure_gpt_full_management('vishar-unified-gpt', true, false, true);
select public.configure_gpt_unified_domain_access('vishar-unified-gpt', false, true, false);
select pg_temp.claims('{"sub":"d0011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-provider"}');

select is(public.gpt_authorize_provider_action('gmail_inbox') ->> 'artist_id', 'a1111111-1111-4111-8111-111111111111',
  'the Gmail inbox authorizer returns the active Artist');
select is(public.gpt_authorize_provider_action('instagram_manage') ->> 'artist_id', 'a1111111-1111-4111-8111-111111111111',
  'the Instagram manage authorizer returns the active Artist');
select throws_ok($$select public.gpt_authorize_provider_action('calendar_disconnect')$$, '22023', null,
  'only reviewed provider actions exist');
select is(
  public.gpt_authorize_gmail_client((select (result ->> 'client_id')::uuid from provider_v)) ->> 'client_id',
  (select result ->> 'client_id' from provider_v),
  'a Vladimir client history is authorized in the Vladimir context'
);
select throws_ok(
  $$select public.gpt_authorize_gmail_client((select (result ->> 'client_id')::uuid from provider_k))$$,
  '42501', null,
  'a Kristina-only client history is refused in the Vladimir context'
);

select public.gpt_artist_context('a2222222-2222-4222-8222-222222222222');
select is(public.gpt_authorize_provider_action('instagram_view') ->> 'artist_id', 'a2222222-2222-4222-8222-222222222222',
  'switching context moves the provider Artist with it');

select * from finish();
rollback;
