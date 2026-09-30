-- 1839_gpt_unified_integrations.sql
--
-- Unified GPT v2 Integrations, Booking Sources and own-account wrappers:
-- closed surface, the integrations ceiling, Artist-filtered status and
-- ownership of booking sources.

begin;
select no_plan();

select ok(
  (select bool_and(
     has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and not has_function_privilege('anon', p.oid, 'EXECUTE')
     and not has_function_privilege('service_role', p.oid, 'EXECUTE')
     and p.prosecdef)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in (
     'gpt_list_integration_status', 'gpt_list_calendar_connection_status', 'gpt_reset_calendar_expected_account',
     'gpt_set_whatsapp_route_enabled', 'gpt_get_telegram_connector_info', 'gpt_configure_telegram_bot_username',
     'gpt_list_telegram_destinations', 'gpt_begin_telegram_link', 'gpt_disconnect_telegram_destination',
     'gpt_list_booking_sources', 'gpt_create_booking_source', 'gpt_update_booking_source',
     'gpt_get_account_overview', 'gpt_set_my_display_name', 'gpt_set_my_language')),
  'every integration and account wrapper is an authenticated-only SECURITY DEFINER function'
);
-- Team and Workspace administration wrappers exist since the owner opened them
-- on 2026-09-30; their boundary is tested in 1842_gpt_team_workspace_admin.sql.

insert into auth.users (id, email) values
  ('df011111-1111-4111-8111-111111111111', 'gpt-integrations-owner@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('df011111-1111-4111-8111-111111111111', 'gpt-integrations-owner@example.test', 'GPT Integrations Owner', 'owner', true);

-- A newer, disabled staging route of the same Artist: the GPT switch must still
-- act on the production route.
insert into public.artist_integrations (artist_id, integration_type, provider, integration_key, configuration, is_enabled, updated_at)
values ('a1111111-1111-4111-8111-111111111111', 'whatsapp', 'meta_cloud_api', 'vladimir-staging', '{}'::jsonb, false, now() + interval '1 day');

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated;

set local role authenticated;
select pg_temp.claims('{"sub":"df011111-1111-4111-8111-111111111111","role":"authenticated"}');
select public.configure_gpt_action_client('vishar-unified-gpt', 'oauth-unified-integrations', true, true);
select public.configure_gpt_enquiry_read_access('vishar-unified-gpt', true);

create temporary table source_k as
select public.create_booking_source('a2222222-2222-4222-8222-222222222222', 'hosted', 'Parity Kristina form', null, 'tattoo-enquiry', false) as id;
grant select on source_k to authenticated;

select pg_temp.claims('{"sub":"df011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-integrations"}');
select public.gpt_artist_context('a1111111-1111-4111-8111-111111111111');

select throws_ok($$select public.gpt_list_integration_status()$$, '42501', null,
  'integration status stays closed without the integrations ceiling');
select throws_ok($$select public.gpt_list_booking_sources()$$, '42501', null,
  'booking sources stay closed without the integrations ceiling');

-- Own account needs no domain ceiling.
select lives_ok($$select public.gpt_get_account_overview()$$, 'the signed-in user reads their own account');
select lives_ok($$select public.gpt_set_my_display_name('GPT Integrations Owner')$$, 'the signed-in user renames themselves');
select is(public.gpt_set_my_language('ru') ->> 'language', 'ru', 'the signed-in user changes their CRM language');

select pg_temp.claims('{"sub":"df011111-1111-4111-8111-111111111111","role":"authenticated"}');
select public.configure_gpt_unified_domain_access('vishar-unified-gpt', false, true, false);
select pg_temp.claims('{"sub":"df011111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-integrations"}');

select ok(
  (select coalesce(bool_and(
     (item ->> 'owner_kind' = 'artist' and item ->> 'owner_id' = 'a1111111-1111-4111-8111-111111111111')
     or item ->> 'owner_kind' = 'workspace'), true)
   from jsonb_array_elements(public.gpt_list_integration_status()) item),
  'integration status only shows the active Artist and its workspace'
);
select ok(
  (select coalesce(bool_and(item ->> 'artist_id' = 'a1111111-1111-4111-8111-111111111111'), true)
   from jsonb_array_elements(public.gpt_list_calendar_connection_status()) item),
  'calendar status only shows the active Artist'
);
select lives_ok($$select public.gpt_list_telegram_destinations()$$, 'Telegram destinations read');
select throws_ok($$select public.gpt_begin_telegram_link('group')$$, '22023', null,
  'Telegram destination kind is a closed choice');

create temporary table source_v as
select public.gpt_create_booking_source('df0a1111-1111-4111-8111-111111111111', 'hosted', 'Parity Vladimir form', null, 'tattoo-enquiry', false) as result;
grant select on source_v to authenticated;
select ok((select result ? 'booking_source_id' from source_v), 'a booking source is created for the active Artist');
select is(
  public.gpt_create_booking_source('df0a1111-1111-4111-8111-111111111111', 'hosted', 'Parity Vladimir form', null, 'tattoo-enquiry', false)
    - 'idempotent_replay',
  (select result - 'idempotent_replay' from source_v),
  'a retried create with the same request_id replays the first result instead of adding a duplicate'
);
select is(
  (select count(*)::int from jsonb_array_elements(public.gpt_list_booking_sources()) item
   where item ->> 'display_label' = 'Parity Vladimir form'),
  1,
  'exactly one booking source exists after the retry'
);

create temporary table source_ext as
select public.gpt_create_booking_source('df0a2222-2222-4222-8222-222222222222', 'external', 'Parity site', 'https://forms.example.com:8443', 'tattoo-enquiry', true) as result;
grant select on source_ext to authenticated;
select lives_ok(
  $$select public.gpt_update_booking_source((select (result ->> 'booking_source_id')::uuid from source_ext), 'Parity site renamed', null, null)$$,
  'an active external source is renamed without resending its origin'
);
select is(
  (select item ->> 'allowed_origin' from jsonb_array_elements(public.gpt_list_booking_sources()) item
   where item ->> 'display_label' = 'Parity site renamed'),
  'https://forms.example.com:8443',
  'an omitted origin keeps the stored origin, including an explicit port'
);
select lives_ok(
  $$select public.gpt_update_booking_source((select (result ->> 'booking_source_id')::uuid from source_v), 'Renamed form', null, null)$$,
  'the active Artist booking source is renamed'
);
select throws_ok(
  $$select public.gpt_update_booking_source((select id from source_k), 'Hijacked', null, true)$$,
  '42501', null,
  'a Kristina booking source cannot be changed from the Vladimir context'
);
select ok(
  not (public.gpt_list_booking_sources()::text like '%Parity Kristina form%'),
  'the Vladimir context never lists a Kristina booking source'
);

select lives_ok($$select public.gpt_set_whatsapp_route_enabled(false)$$,
  'the WhatsApp route switch goes through the CRM integration contract');
select is(
  (public.gpt_configure_telegram_bot_username('@vishar_parity_bot') ->> 'bot_username'),
  'vishar_parity_bot',
  'a Telegram username written as @name is stored as the bare name'
);

reset role;
select is(
  (select is_enabled from public.artist_integrations
   where artist_id = 'a1111111-1111-4111-8111-111111111111' and integration_key = 'vladimir-production'),
  false,
  'the WhatsApp switch acts on the production route derived from the Artist slug'
);
select is(
  (select count(*)::int from public.artist_integrations
   where artist_id = 'a1111111-1111-4111-8111-111111111111' and integration_type = 'whatsapp'
     and integration_key = 'vladimir-staging' and not is_enabled),
  1,
  'the staging route of the same Artist is left as it was'
);

select * from finish();
rollback;
