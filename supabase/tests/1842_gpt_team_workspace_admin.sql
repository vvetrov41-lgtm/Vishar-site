-- 1842_gpt_team_workspace_admin.sql
--
-- Unified GPT v2 Team and Workspace administration wrappers
-- (specs/gpt-team-workspace-admin): closed surface, the administration
-- ceiling, context-derived Artist and workspace, narrowing to the active
-- workspace, receipts, and delegation of the CRM RPCs' own role checks.

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
     'gpt_list_team_profiles', 'gpt_set_team_profile_role', 'gpt_set_team_profile_active',
     'gpt_list_team_memberships', 'gpt_upsert_artist_membership', 'gpt_list_directory_profiles',
     'gpt_list_workspace_team', 'gpt_upsert_workspace_membership', 'gpt_list_artist_memberships',
     'gpt_preview_artist_membership', 'gpt_grant_artist_membership', 'gpt_seat_artist_owner',
     'gpt_list_workspaces', 'gpt_create_workspace', 'gpt_update_workspace', 'gpt_list_workspace_artists',
     'gpt_get_artist_control_plane_context', 'gpt_create_artist', 'gpt_update_artist',
     'gpt_get_artist_onboarding_state', 'gpt_get_tenant_invite_policy')),
  'every Team and Workspace wrapper is an authenticated-only SECURITY DEFINER function'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in (
     'gpt_delete_my_account', 'gpt_get_control_plane_access', 'gpt_transfer_workspace_ownership',
     'gpt_get_self_service_signup_policy', 'gpt_set_self_service_signup')),
  0,
  'account deletion, ownership transfer, signup policy and the access gate stay CRM screen actions'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'gpt\_%'
     and (pg_get_function_arguments(p.oid) ~ '\mp_artist_id\M' or pg_get_function_arguments(p.oid) ~ '\mp_workspace_id\M')
     and p.proname in ('gpt_list_team_profiles', 'gpt_set_team_profile_role', 'gpt_upsert_artist_membership',
       'gpt_upsert_workspace_membership', 'gpt_update_workspace',
       'gpt_create_artist', 'gpt_update_artist', 'gpt_grant_artist_membership', 'gpt_seat_artist_owner')),
  0,
  'no administration wrapper accepts an Artist or workspace id'
);

-- Fixtures: an installation owner, a manager on Vladimir and a manager on
-- Kristina only. Vladimir and Kristina each have their own solo workspace.
insert into auth.users (id, email) values
  ('df121111-1111-4111-8111-111111111111', 'gpt-team-owner@example.test'),
  ('df122222-2222-4222-8222-222222222222', 'gpt-team-vladimir@example.test'),
  ('df123333-3333-4333-8333-333333333333', 'gpt-team-kristina@example.test');
insert into public.profiles (id, email, display_name, role, is_active) values
  ('df121111-1111-4111-8111-111111111111', 'gpt-team-owner@example.test', 'GPT Team Owner', 'owner', true),
  ('df122222-2222-4222-8222-222222222222', 'gpt-team-vladimir@example.test', 'GPT Team Vladimir Manager', 'booking_manager', true),
  ('df123333-3333-4333-8333-333333333333', 'gpt-team-kristina@example.test', 'GPT Team Kristina Manager', 'booking_manager', true);
insert into public.artist_memberships (profile_id, artist_id, access_level, is_active) values
  ('df122222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111', 'manager', true),
  ('df123333-3333-4333-8333-333333333333', 'a2222222-2222-4222-8222-222222222222', 'manager', true);

create temporary table fixture_ws as
select (select workspace_id from public.artists where id = 'a1111111-1111-4111-8111-111111111111') as vladimir,
       (select workspace_id from public.artists where id = 'a2222222-2222-4222-8222-222222222222') as kristina;
grant select on fixture_ws to authenticated;
select ok((select vladimir is distinct from kristina from fixture_ws), 'the two fixture Artists live in different workspaces');

create function pg_temp.claims(p text) returns void language sql as $$
  select set_config('request.jwt.claims', p, true)::void;
$$;
grant execute on function pg_temp.claims(text) to authenticated;

set local role authenticated;
select pg_temp.claims('{"sub":"df121111-1111-4111-8111-111111111111","role":"authenticated"}');
select public.configure_gpt_action_client('vishar-unified-gpt', 'oauth-unified-team', true, true);
select throws_ok(
  $$select public.configure_gpt_unified_domain_access('vladimir-gpt-actions', false, false, true)$$,
  '42501', null,
  'a legacy artist-bound client can never receive the administration ceiling'
);

select pg_temp.claims('{"sub":"df121111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-team"}');
select public.gpt_artist_context('a1111111-1111-4111-8111-111111111111');

-- Closed until the owner enables the administration ceiling.
select throws_ok($$select public.gpt_list_team_profiles()$$, '42501', null,
  'team profiles stay closed without the administration ceiling');
select throws_ok($$select public.gpt_list_workspaces()$$, '42501', null,
  'profile-scoped administration stays closed without the ceiling');
select throws_ok($$select public.gpt_update_artist('df12aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Closed', null, null, null)$$,
  '42501', null, 'Artist changes stay closed without the administration ceiling');

select pg_temp.claims('{"sub":"df121111-1111-4111-8111-111111111111","role":"authenticated"}');
select public.configure_gpt_unified_domain_access('vishar-unified-gpt', false, false, true);
select pg_temp.claims('{"sub":"df121111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-team"}');

-- Narrowing to the active Artist's workspace.
select ok(
  public.gpt_list_team_profiles()::text like '%df122222-2222-4222-8222-222222222222%',
  'team profiles include a member of the active Artist workspace'
);
select ok(
  public.gpt_list_team_profiles()::text not like '%df123333-3333-4333-8333-333333333333%',
  'team profiles never include a person who only works for another workspace'
);
select ok(
  (select coalesce(bool_and(a.workspace_id = (select vladimir from fixture_ws)), true)
   from jsonb_array_elements(public.gpt_list_team_memberships()) item
   join public.artists a on a.id = (item ->> 'artist_id')::uuid),
  'team memberships only cover Artists of the active workspace'
);
select ok(
  (select coalesce(bool_and((item ->> 'id')::uuid <> 'a2222222-2222-4222-8222-222222222222'), true)
   from jsonb_array_elements(public.gpt_list_workspace_artists()) item),
  'workspace Artists never include an Artist of another workspace'
);
select is(public.gpt_get_artist_control_plane_context() ->> 'artist_id', 'a1111111-1111-4111-8111-111111111111',
  'the control-plane context is the active Artist');
select lives_ok($$select public.gpt_list_workspace_team()$$, 'the workspace team of the active Artist reads');
select lives_ok($$select public.gpt_list_artist_memberships()$$, 'memberships of the active Artist read');
select lives_ok($$select public.gpt_get_artist_onboarding_state()$$, 'the onboarding checklist of the active Artist reads');
select lives_ok($$select public.gpt_get_tenant_invite_policy()$$, 'the invite policy of the active Artist reads');
select lives_ok($$select public.gpt_list_workspaces()$$, 'own workspaces read');
select lives_ok($$select public.gpt_list_directory_profiles()$$, 'the people directory reads for the owner');
select lives_ok(
  $$select public.gpt_preview_artist_membership('df122222-2222-4222-8222-222222222222', 'manager', true, false, false, false)$$,
  'a membership on the active Artist is previewed without saving it'
);

-- A person outside the active workspace cannot be changed through it.
select throws_ok(
  $$select public.gpt_set_team_profile_role('df12bbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'df123333-3333-4333-8333-333333333333', 'read_only')$$,
  '42501', null,
  'the CRM role of a person outside the active workspace cannot be changed'
);
select throws_ok(
  $$select public.gpt_set_team_profile_active('df12cccc-cccc-4ccc-8ccc-cccccccccccc', 'df123333-3333-4333-8333-333333333333', false)$$,
  '42501', null,
  'a person outside the active workspace cannot be switched off'
);

-- Receipts: a retry replays, a reused id with another body is refused.
create temporary table deactivate_v as
select public.gpt_set_team_profile_active('df12dddd-dddd-4ddd-8ddd-dddddddddddd', 'df122222-2222-4222-8222-222222222222', false) as result;
grant select on deactivate_v to authenticated;
select is((select result ->> 'is_active' from deactivate_v), 'false', 'a workspace member is switched off');
select is(
  public.gpt_set_team_profile_active('df12dddd-dddd-4ddd-8ddd-dddddddddddd', 'df122222-2222-4222-8222-222222222222', false)
    ->> 'idempotent_replay',
  'true',
  'a retried request replays the first result'
);
select throws_ok(
  $$select public.gpt_set_team_profile_active('df12dddd-dddd-4ddd-8ddd-dddddddddddd', 'df122222-2222-4222-8222-222222222222', true)$$,
  '22023', null,
  'a request_id reused for a different change is refused'
);
select lives_ok(
  $$select public.gpt_set_team_profile_active('df12eeee-eeee-4eee-8eee-eeeeeeeeeeee', 'df122222-2222-4222-8222-222222222222', true)$$,
  'the member is switched back on with a fresh request_id'
);

-- Omitted membership settings keep the member's current values: a role-only
-- change neither revokes capabilities nor re-enables a switched-off member.
select lives_ok(
  $$select public.gpt_upsert_artist_membership('df12a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1', 'df122222-2222-4222-8222-222222222222', 'manager', true, false, true, false, false)$$,
  'the manager gets finance view and session rights and is switched off on Vladimir'
);
select lives_ok(
  $$select public.gpt_upsert_artist_membership('df12a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2', 'df122222-2222-4222-8222-222222222222', 'artist')$$,
  'only the access level is changed'
);

-- Writes act on the context Artist only.
select lives_ok(
  $$select public.gpt_update_artist('df12ffff-ffff-4fff-8fff-ffffffffffff', 'Vladimir via GPT', null, null, null)$$,
  'the active Artist is renamed'
);

reset role;
select is(
  (select row(access_level::text, can_view_finance, can_manage_sessions, is_active)::text
   from public.artist_memberships
   where profile_id = 'df122222-2222-4222-8222-222222222222' and artist_id = 'a1111111-1111-4111-8111-111111111111'),
  row('artist', true, true, false)::text,
  'a role-only change keeps the omitted capabilities and keeps the member switched off'
);
set local role authenticated;
select pg_temp.claims('{"sub":"df121111-1111-4111-8111-111111111111","role":"authenticated","client_id":"oauth-unified-team"}');
select lives_ok(
  $$select public.gpt_upsert_artist_membership('df12a3a3-a3a3-43a3-83a3-a3a3a3a3a3a3', 'df122222-2222-4222-8222-222222222222', 'read_only')$$,
  'moving to read-only drops the omitted capabilities instead of failing'
);
reset role;
select is(
  (select row(access_level::text, can_view_finance, can_manage_sessions, is_active)::text
   from public.artist_memberships
   where profile_id = 'df122222-2222-4222-8222-222222222222' and artist_id = 'a1111111-1111-4111-8111-111111111111'),
  row('read_only', false, false, false)::text,
  'read-only carries no capability and still keeps the member switched off'
);
update public.artist_memberships set access_level = 'manager', is_active = true
where profile_id = 'df122222-2222-4222-8222-222222222222' and artist_id = 'a1111111-1111-4111-8111-111111111111';
select is((select display_name from public.artists where id = 'a1111111-1111-4111-8111-111111111111'), 'Vladimir via GPT',
  'the rename landed on the active Artist');
select isnt((select display_name from public.artists where id = 'a2222222-2222-4222-8222-222222222222'), 'Vladimir via GPT',
  'the other Artist is untouched');

-- A manager on Vladimir with the same ceiling-enabled client: the wrapper adds
-- no privilege, so owner-only CRM RPCs still refuse.
set local role authenticated;
select pg_temp.claims('{"sub":"df122222-2222-4222-8222-222222222222","role":"authenticated","client_id":"oauth-unified-team"}');
select public.gpt_artist_context('a1111111-1111-4111-8111-111111111111');
select throws_ok(
  $$select public.gpt_set_team_profile_role('df12acac-acac-4cac-8cac-acacacacacac', 'df122222-2222-4222-8222-222222222222', 'owner')$$,
  '42501', null,
  'a non-owner cannot raise any CRM role through the GPT'
);
select throws_ok(
  $$select public.gpt_upsert_artist_membership('df12adad-adad-4dad-8dad-adadadadadad', 'df122222-2222-4222-8222-222222222222', 'artist')$$,
  '42501', null,
  'a non-owner cannot use the owner-only artist membership upsert through the GPT'
);

select * from finish();
rollback;
