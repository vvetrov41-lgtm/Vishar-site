-- 238_control_plane_final_review.sql
--
-- Regression for the ownership-transfer boundary tightened in migration 0090.
-- The legacy installation owner is deliberately present here but holds no
-- membership in the workspace. Before 0090 this call succeeded, created a
-- second owner, demoted nobody and then logged the non-owner caller as the
-- ownership source.

begin;
select plan(4);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('f1100000-0000-4111-8111-111111111111', 'transfer-owner@example.test'),
  ('f1200000-0000-4222-8222-222222222222', 'transfer-member@example.test'),
  ('f1300000-0000-4333-8333-333333333333', 'installation-owner@example.test');

insert into public.profiles (id, email, display_name, role, is_active) values
  ('f1100000-0000-4111-8111-111111111111', 'transfer-owner@example.test',
   'Workspace Owner', 'booking_manager', true),
  ('f1200000-0000-4222-8222-222222222222', 'transfer-member@example.test',
   'Workspace Member', 'booking_manager', true),
  ('f1300000-0000-4333-8333-333333333333', 'installation-owner@example.test',
   'Installation Owner', 'owner', true);

insert into public.workspaces (
  id, slug, display_name, workspace_type, timezone, default_currency, is_active
) values (
  'f1400000-0000-4444-8444-444444444444',
  'transfer-boundary', 'Transfer Boundary Studio', 'studio',
  'Europe/London', 'GBP', true
);

insert into public.workspace_memberships (
  profile_id, workspace_id, workspace_role,
  can_manage_workspace, can_manage_team, can_manage_integrations, is_active
) values
  ('f1100000-0000-4111-8111-111111111111',
   'f1400000-0000-4444-8444-444444444444',
   'owner', true, true, true, true),
  ('f1200000-0000-4222-8222-222222222222',
   'f1400000-0000-4444-8444-444444444444',
   'booking_manager', false, false, false, true);

-- The installation-wide owner is active, but is not a member of this workspace.
select set_config(
  'request.jwt.claims',
  '{"sub":"f1300000-0000-4333-8333-333333333333","role":"authenticated"}',
  true
);
set local role authenticated;

select throws_ok(
  $$select public.transfer_workspace_ownership(
      'f1400000-0000-4444-8444-444444444444',
      'f1200000-0000-4222-8222-222222222222')$$,
  '42501', null,
  'installation authority is not a workspace ownership-transfer bypass'
);

reset role;

select is(
  (select wm.workspace_role::text
   from public.workspace_memberships wm
   where wm.workspace_id = 'f1400000-0000-4444-8444-444444444444'
     and wm.profile_id = 'f1100000-0000-4111-8111-111111111111'),
  'owner',
  'the sitting workspace owner remains the owner after the refused call'
);

select is(
  (select wm.workspace_role::text
   from public.workspace_memberships wm
   where wm.workspace_id = 'f1400000-0000-4444-8444-444444444444'
     and wm.profile_id = 'f1200000-0000-4222-8222-222222222222'),
  'booking_manager',
  'the intended recipient is not silently promoted'
);

select is(
  (select count(*)::int
   from public.workspace_memberships wm
   where wm.workspace_id = 'f1400000-0000-4444-8444-444444444444'
     and wm.workspace_role = 'owner'
     and wm.is_active),
  1,
  'the refused bypass cannot create a second active owner'
);

select * from finish(true);
rollback;
