# Tasks — Vishar CRM AI Five Pillars

## A. Baseline and specification

- [x] Create isolated branch from fresh `agent/platform-telegram-self-service` HEAD.
- [x] Confirm existing communications core/unified inbox.
- [x] Confirm existing notification/Telegram durable delivery path.
- [x] Confirm current AI intake queue and Qwen vision capability.
- [x] Write spec, plan, and tasks.

## B. Exact-head navigation

- [x] Inspect generic automation engine and decide whether it can be reused for
      CRM-agent jobs without weakening boundaries.
- [x] Inspect Telegram entity-target delivery support.
- [ ] Inspect GPT web-research/Firecrawl contract.
- [ ] Inspect current AI router/provider image input contract.
- [ ] Inspect enquiry file/private-storage access helpers and current AI orchestration.
- [ ] Inspect operator parity manifest and test conventions.

## C. Data layer

- [ ] Add immutable migration for derived client AI state.
- [ ] Add Next Action table with constrained enum/status and approval invariant.
- [ ] Add reference-image analysis table.
- [ ] Add durable/idempotent CRM-agent jobs; the generic automation queue is not
      reusable because it intentionally excludes personal/free-text payloads.
- [ ] Add service scheduling/claim/release/apply RPCs.
- [ ] Add artist-authorized unified client timeline projection.
- [ ] Add artist-authorized open Next Action digest read.
- [ ] Add idempotent notification enqueue on material Next Action.

## D. AI contracts and orchestration

- [ ] Add structured client-state schema + prompt.
- [ ] Add structured reference-image schema + prompt.
- [ ] Add `crm_client_state` task route.
- [ ] Add structured reference-image task route.
- [ ] Add server-side job drain/orchestrator.
- [ ] Feed persisted vision summaries into client-state/enquiry reasoning.
- [ ] Preserve existing enquiry intake safety and source-of-truth semantics.

## E. Scheduling hooks

- [ ] Schedule client-state refresh after durable enquiry changes.
- [ ] Schedule client-state refresh after supported inbound communication changes.
- [ ] Schedule client-state refresh from Gmail when stable client/source linkage exists.
- [ ] Schedule vision jobs for eligible private enquiry image files.
- [ ] Keep all hooks idempotent and non-blocking.

## F. Telegram / iPhone surface

- [ ] Render actionable artist-only notification through existing notification path.
- [ ] Expose bounded open-actions digest.
- [ ] Add read-only Telegram command/button integration if current bot contract safely
      supports it.
- [ ] Do not add autonomous client-send / booking / payment callbacks.

## G. Web references / Firecrawl

- [ ] Reuse existing web-research contract for external URLs where applicable.
- [ ] Ensure private CRM storage URLs are never sent to Firecrawl.
- [ ] Document any deferred external-reference association work explicitly.

## H. Validation

- [ ] Add/extend SQL and JS tests.
- [ ] Reconcile GPT operator parity.
- [ ] Run available repository validation/CI without deploying.
- [ ] Fresh-check branch HEAD and review diff.
- [ ] Record remaining rollout steps; do not deploy without explicit authorization.
