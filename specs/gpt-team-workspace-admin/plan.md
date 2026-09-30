# Plan: Unified GPT Team and Workspace administration

## Stage 1: 26 database-backed operations (one PR)

### Database: `supabase/migrations/20260930120000_gpt_team_workspace_administration.sql`

One `public.gpt_*` wrapper per action, `security definer`, fixed `search_path`, granted to `authenticated` only. Every wrapper first calls one of the existing foundation guards with the `administration` ceiling:

| Guard | Used for |
| --- | --- |
| `require_gpt_domain_context('administration', null)` | actions on the active Artist (memberships, owner seat, Artist settings, onboarding, invite policy) |
| `require_gpt_context_workspace('administration', null)` | actions on the workspace that owns the active Artist (workspace team, workspace membership, workspace settings, ownership transfer, add Artist, list Artists, installation-wide reads narrowed to that workspace) |
| `require_gpt_profile_scope('administration')` | actions about the signed-in person or the installation (own account deletion, control-plane access, own workspaces, create workspace, directory, signup policy) |

The capability argument is `null` on purpose: the called CRM RPC performs the owner, `manage_team`, workspace-administrator or founder check with `auth.uid()`, and duplicating it in the wrapper would drift.

Narrowing (FR-3):

- `gpt_list_team_profiles` returns only profiles with an Artist or workspace membership in the context workspace.
- `gpt_list_team_memberships` returns only memberships on Artists of the context workspace.
- `gpt_set_team_profile_role` / `gpt_set_team_profile_active` refuse a target profile with no membership in the context workspace, so an owner cannot use an Artist-scoped GPT to change people outside the studio it is working in.

Writes use `crm_private.gpt_receipt_begin/finish` with a `request_id`.

### Worker registry: `workers/lib/gpt-domain-operations.js`

26 `op()` entries, domain `Team` or `Workspace`. No path or body parameter named `artist_id` or `workspace_id` (the registry's forbidden list already rejects them). `previewArtistMembership` is a GET with query parameters, so it stays non-consequential like its `read` inventory row.

### Inventory and schemas

- `docs/gpt-actions/operator-parity.current.mjs`: 26 rows `N` → `A`.
- `node scripts/build-gpt-unified-openapi.mjs` writes `openapi.team.yaml` (12) and updates `openapi.workspace.yaml` (17).

### Topology: 12 → 13 Action domains

- `wrangler.gpt-actions.production.toml` gains `gpt-team.vishartattoo.com`.
- New one-shot `.github/workflows/gpt-production-team-domain-rollout.yml` on branch `release/private-crm-rc967-inventory-gpt-team-domain`, same guards as the 4 → 12 rollout: exact canonical SHA, exact-head CI, no pending migration, Cloudflare preflight, rollback config proven by dry-run, DoH probes with a job-budget deadline, automatic rollback to the twelve-domain config.
- `gpt-production-worker-rollout.yml` and its tests expect 13 domains. The 4 → 12 workflow stays as history; its lineage gate refuses any new trigger.

### Tests

- `supabase/tests/1842_gpt_team_workspace_admin.sql` (pgTAP): ceiling refusal, legacy-client refusal, context derivation, narrowing, receipt replay and mismatch, delegation of the CRM checks.
- `scripts/test-gpt-domain-operations.mjs`, `scripts/test-gpt-operator-parity.mjs`, `scripts/test-gpt-unified-domain-rollout.mjs`, `scripts/test-gpt-worker-rollout.mjs`, new `scripts/test-gpt-team-domain-rollout.mjs`.

### Production order

1. Merge with exact-head CI green.
2. Database release of `20260930120000` through `deploy-private-production-database.yml` from an exact `release/private-crm-rc*` SHA.
3. Team domain rollout (ships the Worker code and the thirteenth host), then readback of all 13 hosts and Cloudflare.
4. Owner enables the `administration` ceiling with `configure_gpt_unified_domain_access` once the unified OAuth client is bound.

## Stage 2: invitations

`team.invite` and `team.artist_invite` through the Team API Worker. Needs a service binding from the GPT Worker and a service-call path in `workers/team-admin.js` that does not weaken its CRM-origin check for browser calls. Separate PR with security review.
