# Tasks: Unified GPT Team and Workspace administration

## Stage 1

- [x] Migration `20260930070000_gpt_team_workspace_administration.sql` with 26 wrappers and grants.
- [x] pgTAP `1842_gpt_team_workspace_admin.sql`.
- [x] 26 registry entries in `workers/lib/gpt-domain-operations.js`.
- [x] Parity inventory: 26 rows `available`.
- [x] Regenerate unified schemas (`team`, `workspace`).
- [x] Add `gpt-team.vishartattoo.com` to the production Worker config.
- [x] One-shot 12 → 13 rollout workflow and its test.
- [x] Worker rollout workflow and tests expect 13 domains.
- [x] Runbook: Team domain, activation order.
- [ ] Exact-head CI green, merge.

## Stage 1 production

- [ ] Fresh readback: canonical SHA, production migration head, GPT clients, Cloudflare.
- [ ] Guarded database release of `20260930070000`.
- [ ] Team domain rollout; readback of 13 hosts and Cloudflare.

## Stage 2

- [ ] Team API Worker service-call path and GPT service binding (security review).
- [ ] `inviteStaffMember`, `inviteArtist` via `gpt_authorize_` RPCs.
