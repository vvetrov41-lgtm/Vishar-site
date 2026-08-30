# Implementation Plan: Unified GPT v2

## Specification

- Spec: `specs/unified-gpt-v2/spec.md`
- Target repository: `vvetrov41-lgtm/Vishar-site`
- Target branch: `agent/unified-gpt-v2`
- Verified base branch: `agent/platform-telegram-self-service`
- Verified base SHA at branch creation: `c3c06f88dbb37b95cd4d8f391d05f76953272324`
- Production Supabase project: `vfjexhfdbrjmuxfdvbdx`
- Production migration head observed before implementation: `0117_deposit_requirement_semantics`

## Constitution check

- Server authority: only the dedicated context route may accept an Artist selector; business actions continue to derive authority in PostgreSQL.
- Authorization before capability: profile membership selects scope, then client ceilings and operation-specific CRM capabilities gate the action.
- Ordered database evolution: migration `0084` is already in production lineage; this increment does not rewrite it or introduce a replacement migration without new evidence.
- Exact-head evidence: every implementation/merge/rollout stage rechecks the current canonical and task branch heads.
- Secret custody: OAuth secrets and `GPT_OAUTH_BRIDGE_SECRET` remain outside repository and database payloads.
- Deployment is separate evidence: merging docs/tests does not activate `vishar-unified-gpt`.
- Bounded/reversible rollout: legacy Vladimir/Kristina GPT clients remain active until unified acceptance and provide rollback containment.

## Current-state evidence

- Entry points: `workers/gpt-actions-production-full.js` -> `workers/lib/gpt-actions-combined.js` -> named GPT RPC routes.
- Action routing: `workers/lib/gpt-full-actions.js` maps bounded paths to named `gpt_*` RPCs and rejects caller-supplied Artist/routing/SQL fields.
- Context route: `/v1/context` in `gpt-actions-combined.js` is the only route accepting `artist_id`; it calls `public.gpt_artist_context` with the caller OAuth token.
- Production schemas: `docs/gpt-actions/openapi.production.core.yaml` and `openapi.production.operations.yaml`, 28 + 29 operations, same OAuth edge.
- Production Worker config: `vishar-gpt-actions-production`, custom domains `gpt-actions.vishartattoo.com` and `gpt-operations.vishartattoo.com`, no workers.dev/preview URL, Worker-side rate limit, tracked flags inert.
- Database objects: production has `vishar-unified-gpt` in `binding_mode=profile`, `artist_id IS NULL`, OAuth unconfigured, inactive, all capability ceilings false. Legacy Vladimir and Kristina rows are artist-bound, active and configured.
- Authorization boundary: `require_gpt_registered_client` / `require_gpt_client_context` / `require_gpt_operational_context` and `gpt_artist_context` rederive identity, membership and action capability on every request.
- Existing tests: unified context Worker tests, migration/pgTAP authorization tests, production OpenAPI split tests, production config tests and full GPT Worker suites.
- Existing operating doc defect: `docs/crm/gpt-actions-production-runbook.md` still describes the old target model as one confidential OAuth client per Artist and therefore conflicts with the deployed profile-bound foundation.
- External state not yet used as rollout proof: current Cloudflare deployed GPT Worker version and actual Custom GPT Builder configuration. These are mandatory rollout-time fresh-checks.

## Proposed design

The initial implementation is additive and intentionally avoids database or production mutation. It makes the repository contract match the already-deployed authorization foundation, adds model-facing v2 operating instructions, and adds regression tests so the old artist-bound target architecture cannot quietly return.

### Data model and migrations

- New/changed objects: none in the initial repository increment.
- Production `vishar-unified-gpt` row remains dormant until external OAuth/Builder configuration and release acceptance are ready.
- No legacy binding is changed or deleted.
- A new migration is required only if implementation discovers a missing server-side capability, not merely to activate the existing row.

### Server/Worker layer

- Preserve `/v1/context` as the sole Artist selector.
- Preserve all named business routes and the caller-token + publishable-key Supabase boundary.
- Do not add arbitrary RPC, SQL, provider routing or direct Artist parameters.
- Keep the two current action domains and shared OAuth edge.
- Add contract tests that cross-check instructions/runbook against implemented context and action boundaries.

### CRM/UI layer

- Existing OAuth consent UI already understands `binding_mode=profile` and describes membership-scoped access.
- No new CRM UI is required for this increment.
- Notification/template editing remains a separate CRM feature. When its server contract stabilizes, GPT actions can be added through the same selected Artist/capability path.

### External integrations

- Supabase OAuth: one confidential OAuth client will later be created for `vishar-unified-gpt`, using the fixed Worker callback already required by the PKCE bridge.
- Custom GPT: one Vishar GPT will import both bounded Action schemas and use the same OAuth application identity.
- Cloudflare: the existing GPT Worker remains the edge; no new Worker or provider credential is introduced per Artist.
- Gmail/WhatsApp/Calendar/payment routing remains server-owned and Artist-scoped after context resolution.

### Observability and audit

- Existing `gpt_action_receipts` continue to evidence idempotent GPT mutations.
- Existing `gpt.client_configured` activity is retained for client capability/configuration changes.
- Production acceptance records exact Worker/DB/OAuth client non-secret identity and action readback, never secret values.

## Security review

- Browser/GPT-controlled values: Artist identifier is permitted only on `/v1/context`; all other identity/routing fields remain forbidden.
- Artist authorization: current profile membership must authorize context selection; action capability is rechecked independently.
- Privileged RPC/service-role paths: GPT Worker continues to use the user OAuth token and publishable key, not service-role credentials.
- RLS and grants: no grant changes in this increment. Existing pgTAP remains required.
- Secrets/tokens: no OAuth client secret or bridge secret in repo, DB, logs or chat.
- Cross-tenant leakage: stale/revoked selection fails closed; no automatic fallback to another Artist.
- Denial-path tests: inaccessible context selection, forbidden identity fields, legacy cross-Artist denial and capability ceiling tests remain mandatory.

## Test strategy

- Unit/contract: add a v2 repository contract test for instructions/runbook and production schema invariants.
- Existing Worker suites: run unified-context, full-action, OAuth relay, production config and OpenAPI split tests.
- Database: full Supabase reset + pgTAP in normal CRM validation, including unified GPT authorization tests.
- CRM: normal tests/typecheck/build because OAuth consent UI is part of the boundary even if unchanged.
- Secret scan and production Worker dry-run remain required.
- Exact-head CI: `Static Validation` and `CRM and booking validation`; GPT-specific validation included through worker suite.

## Rollout plan

1. Repository contract increment: spec/plan/tasks, unified-first production runbook, durable GPT v2 instructions/onboarding guidance, regression tests. No production mutation.
2. Merge only after exact-head CI and fresh base recheck.
3. Rollout preflight later: recheck canonical SHA, production migration head, active legacy clients, dormant profile-bound unified client, current Cloudflare GPT Worker/routes/bindings/flags, current GPT Builder configuration and unresolved intermittent 401 evidence.
4. Create one confidential Supabase OAuth client for `vishar-unified-gpt` if an authorized management surface is available. The client secret goes directly into the Custom GPT editor, never through repository/chat.
5. Bind only the non-secret OAuth client id to the dormant profile-bound database client and enable the intended capability ceilings after exact target checks. Keep legacy clients active.
6. Import exact-SHA Core and Operations OpenAPI schemas into one Custom GPT, using the same OAuth application.
7. Acceptance: authenticate as a real CRM user, read Artist context, prove authorized selection/denial, perform bounded read-only operations first, then only legitimate consequential operations when naturally available.
8. Do not retire legacy GPTs until unified acceptance is complete and infrastructure reliability is sufficient to distinguish authorization defects from transport failures.

## Rollback/reference plan

- Repository changes are additive documentation/tests and can be reverted normally before production activation.
- During rollout, first containment is to deactivate/disable the unified profile-bound client while leaving legacy clients untouched.
- Worker Actions/OAuth relay kill switches remain available for broader containment.
- OAuth client revocation is reserved for credential compromise or full retirement, not ordinary functional rollback.
- No backward database migration is required for unified client containment.

## Risks

| Risk | Consequence | Mitigation |
| --- | --- | --- |
| Stale artist-bound runbook | Operator creates another per-Artist GPT and undermines platform model | Rewrite runbook and regression-test unified wording/invariants |
| GPT guesses Artist | Cross-Artist access attempt or confusing denial | Context-first instructions plus server revalidation and artist_id ban elsewhere |
| Legacy clients disabled too early | No reliable rollback | Explicitly preserve them through acceptance |
| Supabase intermittent 401 | False diagnosis of GPT authorization failure | Treat as rollout blocker/known infrastructure signal and validate read-only first |
| External Builder/OAuth drift | Repository contract green but GPT cannot authenticate | Fresh-check external control plane before activation, fixed callback and exact schemas |
| Future notification/template actions bypass context | Second authorization model | Spec requires reuse of profile/context/capability boundary |
| Consequential retry after transport uncertainty | Duplicate send/payment/mutation | Preserve idempotency identity, re-read state, never alter parameters or Artist automatically |

## Plan completion gate

- Current base SHA and production migration head were freshly observed.
- Existing profile-bound production row and legacy clients were freshly verified.
- Trust boundaries and legacy rollback are explicit.
- Initial increment needs no migration.
- Production activation is separate from repository implementation and requires new environment readback.
