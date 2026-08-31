# Tasks

## Repository and production baseline

- [x] Fresh-check canonical branch, exact SHA, open PRs, and exact-head CI.
- [x] Fresh-check production Supabase migration head and WhatsApp integration rows.
- [x] Run sanitized read-only Cloudflare production inventory for exact canonical tree.
- [x] Confirm drain remains disabled and has no cron.

## Implementation

- [x] Restrict existing-account backend provisioning to Vladimir.
- [x] Validate Meta token validity, exact App ID, and required WhatsApp scopes.
- [x] Prove fixed Phone Number ID belongs to fixed Vladimir WABA.
- [x] Delay all Cloudflare secret writes until Meta validation completes.
- [x] Write fixed credential envelope to drain and webhook Vladimir bindings.
- [x] Subscribe Vladimir WABA to the fixed app.
- [x] Read back Meta WABA/phone identity, app subscription, and both Cloudflare secret names.
- [x] Mark CRM `connected_at` only after all provider readbacks succeed.
- [x] Preserve the table ACL by using the bounded Vladimir-only connected-state RPC instead of direct authenticated `UPDATE`.
- [x] Keep token out of response, logs, Supabase configuration, and connected-state mutation body.
- [x] Restrict the CRM API client direct path to Vladimir and require connected readback proof.
- [x] Hide the direct System User token form for Kristina in the CRM page.
- [x] Update GPT operator-parity inventory with the explicit `ui_only` credential-custody decision.

## Regression validation

- [x] Invalid token.
- [x] Wrong App ID.
- [x] Missing WhatsApp permissions.
- [x] Wrong WABA.
- [x] Wrong Phone Number ID.
- [x] Wrong artist / Kristina blocked.
- [x] No Cloudflare writes before all Meta validation checks.
- [x] No CRM connected state before Meta subscription and Cloudflare readbacks.
- [x] Token and app secret absent from response/logs/Supabase mutation.
- [ ] Exact-head repository WhatsApp onboarding workflow green.
- [ ] Exact-head CRM tests/typecheck/build and secret scan green.

## Release and production acceptance

- [ ] Fresh-check canonical branch and parallel work immediately before merge.
- [ ] Merge bounded PR.
- [ ] Verify post-merge exact-head CI.
- [ ] Guarded CRM production deployment from immutable canonical SHA.
- [ ] Production readback of CRM Pages deployment and WhatsApp Worker topology.
- [ ] Confirm Vladimir remains unconnected before the human Meta credential step.
- [ ] Human assigns minimal System User assets and generates the System User token in Meta.
- [ ] Human pastes token directly into the Vladimir CRM form, never into chat.
- [ ] Verify production `connected_at` and fresh Cloudflare secret-name presence.
- [ ] Confirm Vladimir production WhatsApp connected before beginning Kristina work.
