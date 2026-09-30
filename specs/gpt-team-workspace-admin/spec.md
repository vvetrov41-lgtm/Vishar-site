# Spec: Unified GPT Team and Workspace administration

Status: accepted by the owner on 2026-09-30 ("open them"). Parent feature: `specs/unified-gpt-v2/`.

## Problem

The operator-parity inventory (`docs/gpt-actions/operator-parity.current.mjs`) still lists 28 `implement_now` actions, all in the Team, Workspace and own-account groups. The runbook held them back because exposing team, membership, role, workspace-ownership, signup-policy and account-deletion operations to the GPT needed an explicit owner decision. That decision is now made: expose them, except five the owner then chose to keep as CRM screen actions (see Scope).

## Scope

28 actions:

- **Kept in the CRM (owner decision, `ui_only` kind `owner_excluded`):** `account.delete`, `workspace.ownership.transfer`, `signup.policy.get`, `signup.availability.set`, `workspace.control_plane_access`. They are irreversible, installation-wide or a UI gate, and a chat adds risk without saving work.
- **Stage 1 (this feature's first PR): 21 database-backed actions.** Each gets one named `public.gpt_*` wrapper over the RPC the CRM screen already calls.
- **Stage 2: `team.invite` and `team.artist_invite`.** They run through the Team API Worker (`workers/team-admin.js`), which today admits only browser calls from the CRM origin and holds the Supabase secret key. Letting the GPT Worker reach it is a trust-boundary change and ships as its own PR with a security review.

## Requirements

- FR-1: Every Team/Workspace wrapper requires the registered GPT client and the `administration` ceiling (`can_administer_workspace`). Only the profile-bound unified client can hold it (existing check constraint).
- FR-2: The model never supplies an Artist or workspace id. Artist-scoped actions act on the server-owned active Artist. Workspace-scoped actions act on the workspace that owns the active Artist (`crm_private.require_gpt_context_workspace`).
- FR-3: Installation-wide owner reads (`list_profiles`, `list_team_memberships`) are narrowed to the active Artist's workspace, so an owner acting through the GPT sees the same Artist scope as every other GPT domain.
- FR-4: Profile ids of the person being changed (`profile_id`, `to_profile_id`) are inputs. The called CRM RPC keeps its own owner / `manage_team` / workspace-administrator checks with `auth.uid()`. The wrapper adds no privilege.
- FR-5: Every write takes a `request_id` and uses the GPT receipt table, so a retried request cannot apply twice and a reused id with a different body is refused.
- FR-6: Membership writes keep every omitted setting at the member's current value (new members get the CRM defaults), so a role change never revokes capabilities or re-enables a switched-off member. Moving to read-only drops capabilities, which read-only cannot hold. Owner levels are not offered where the CRM RPC always refuses them.
- FR-7: The Team domain gets its own Action host, `gpt-team.vishartattoo.com`, already reserved in the inventory. Workspace stays on `gpt-workspace.vishartattoo.com`. Both stay at or below 25 operations.
- FR-8: No generic SQL, RPC or proxy operation is added, and no credential, token or provider identifier crosses the GPT boundary.

## Non-goals

- Changing the CRM RPCs' own authorization.
- Changing the legacy Vladimir/Kristina artist-bound clients. The `administration` ceiling cannot be set on them.
- Enabling the ceiling. That is the owner's separate activation step (`configure_gpt_unified_domain_access`).

## Acceptance

- AC-1: All 21 Stage 1 actions are `available` in the parity inventory, the five kept actions are `ui_only`/`owner_excluded`, and `team.invite` and `team.artist_invite` stay `implement_now` until Stage 2.
- AC-2: pgTAP proves each wrapper refuses without the `administration` ceiling, refuses a legacy artist-bound client, derives Artist/workspace from context, and delegates to the CRM RPC's own checks.
- AC-3: Generated schemas: `openapi.team.yaml` on `gpt-team.vishartattoo.com` and an updated `openapi.workspace.yaml`, 12 operations each, both at or below 25, fresh against the registry.
- AC-4: Production receives the migration only through the guarded database release, and the thirteenth domain only through a one-shot, rollback-proven topology workflow.
