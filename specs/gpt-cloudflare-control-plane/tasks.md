# Tasks: GPT Cloudflare Control Plane

## Repository implementation

- [x] Rebuild the feature on fresh canonical `ef874daa9386642416688df54991f588c43460ac`.
- [x] Reserve migration `0134_gpt_cloudflare_control.sql` after canonical migrations through `0133`.
- [x] Add owner-only `can_use_cloudflare_control` GPT client ceiling.
- [x] Keep migration activation fail-closed for every GPT client.
- [x] Permit audited activation only for the reviewed owner-facing GPT v2 transition identities.
- [x] Add private `vishar-cloudflare-gateway` Worker with Cloudflare token secret custody.
- [x] Disable workers.dev, previews and public routes for the gateway.
- [x] Add private Service Binding from the GPT production Worker.
- [x] Add account/zone/Workers/Pages/D1/KV/R2 inventory operations.
- [x] Add Worker deploy/delete, DNS mutation, cache purge and Worker route mutation operations.
- [x] Reject caller-supplied provider token, raw account/zone ids, arbitrary path/method/upstream, SQL and RPC.
- [x] Protect control-plane Worker deletion and gateway self-deployment.
- [x] Add global/read/write tracked kill switches, all false by default.
- [x] Add dedicated Cloudflare OpenAPI Action schema on `gpt-operations.vishartattoo.com`.
- [x] Add focused Worker/router/config/OpenAPI tests and dry-run gateway bundle validation.
- [x] Update legacy GPT fixture grant compatibility for the new configuration RPC.
- [x] Align durable docs with Unified GPT v2 rather than a separate Operations GPT product.

## Pre-merge verification

- [ ] Fresh-check canonical exact SHA immediately before PR/merge.
- [ ] Verify branch diff contains only Cloudflare control-plane work.
- [ ] Open PR against `agent/platform-telegram-self-service`.
- [ ] Require exact-head CI green.
- [ ] Fix any exact-head failures before merge.

## Production rollout, separate mutation stage

- [ ] Fresh-read production Supabase migration head and non-secret GPT client state.
- [ ] Fresh-read current GPT v2 OAuth/client identity without printing secrets.
- [ ] Fresh-read Cloudflare GPT Worker routes/bindings/flags and gateway presence.
- [ ] Apply migration `0134`.
- [ ] Deploy private `vishar-cloudflare-gateway`.
- [ ] Set `CLOUDFLARE_API_TOKEN` directly as the gateway Worker secret without putting its value in chat or GitHub.
- [ ] Deploy GPT Worker Service Binding with Cloudflare flags still off.
- [ ] Enable Cloudflare database ceiling only for the live reviewed GPT v2 OAuth identity.
- [ ] Enable global + read flags and verify account/zones/workers inventory.
- [ ] Enable write after read acceptance.
- [ ] Perform one legitimate consequential operation and verify authoritative Cloudflare readback.
- [ ] Import/update the Cloudflare schema in the existing Unified GPT v2 Builder configuration.
- [ ] Verify non-owner/unreviewed-client denial and rollback controls.

Production rollout must not be marked complete from repository CI alone.
