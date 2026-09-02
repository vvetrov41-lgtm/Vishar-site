# Tasks: GPT Cloudflare Control Plane

## A. Authorization and migration

- [ ] A1. Add `0130_gpt_cloudflare_control.sql` with owner-only per-client capability ceiling.
- [ ] A2. Add `gpt_authorize_cloudflare_control()` and owner configuration RPC with narrow grants.
- [ ] A3. Enable only the reviewed Vladimir GPT client in migration data, leaving other clients false.
- [ ] A4. Add positive and denial pgTAP coverage.

## B. Private provider gateway

- [ ] B1. Add route-less `wrangler.cloudflare-gateway.production.toml`.
- [ ] B2. Add `workers/cloudflare-gateway.js` with fixed Cloudflare API origin and secret-only bearer injection.
- [ ] B3. Resolve exactly one account server-side and exact zones server-side.
- [ ] B4. Add bounded inventory operations for account, zones, Workers, deployments, Pages, D1, KV, R2, DNS and Worker routes.
- [ ] B5. Add bounded Worker code deployment preserving provider configuration metadata.
- [ ] B6. Add protected/confirmed Worker deletion.
- [ ] B7. Add bounded DNS upsert/delete, cache purge and Worker route upsert/delete.
- [ ] B8. Normalize provider failures and cap payload sizes without leaking credentials.

## C. GPT action boundary

- [ ] C1. Add `workers/lib/gpt-cloudflare-control.js`.
- [ ] C2. Require global/operation switches, OAuth, owner/client authorization and explicit field allow-lists before Service Binding.
- [ ] C3. Never forward caller OAuth to the Cloudflare gateway.
- [ ] C4. Add `CLOUDFLARE_GATEWAY` Service Binding to GPT production config.
- [ ] C5. Route Cloudflare actions from the combined GPT handler without disturbing Web Research or CRM actions.

## D. ChatGPT contract and parity

- [ ] D1. Add `openapi.production.cloudflare.yaml` on `gpt-operations.vishartattoo.com`, <=25 operations.
- [ ] D2. Mark every mutation consequential and every read non-consequential.
- [ ] D3. Ensure schemas expose no account id, secret value, arbitrary provider path/method or provider credential field.
- [ ] D4. Update operator parity with the owner-only Cloudflare infrastructure surface and intentional exclusions.

## E. Validation

- [ ] E1. Add focused gateway tests.
- [ ] E2. Add focused GPT action-boundary tests.
- [ ] E3. Add gateway config/dry-run validation.
- [ ] E4. Update package scripts without removing existing checks.
- [ ] E5. Run focused local validation where available.
- [ ] E6. Open a draft stacked PR and require exact-head GitHub CI.
- [ ] E7. Reconcile PR #588/#589 migration lineage before final merge.

## F. Production rollout (separate authorization stage)

- [ ] F1. Fresh-check canonical SHA, stacked dependencies, exact-head CI and production Cloudflare state.
- [ ] F2. Verify `vishar-cloudflare-gateway` exists, remains private, and has the expected secret name without reading the value.
- [ ] F3. Apply database migration with production readback.
- [ ] F4. Deploy gateway code while preserving its existing secret.
- [ ] F5. Deploy GPT Service Binding/router with feature switches off.
- [ ] F6. Import/update ChatGPT Action schema.
- [ ] F7. Enable owner capability and read operations first; perform readback.
- [ ] F8. Enable mutations incrementally and verify each class.
