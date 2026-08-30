# Tasks: Unified GPT v2

## Rules

- Every implementation task traces to the feature requirements or acceptance criteria.
- Production activation is separate from repository completion.
- Legacy Vladimir/Kristina GPT clients remain rollback compatibility until a later retirement decision.
- Notification/template editing and Web Research actions are deferred integrations, not reasons to create a second GPT identity model.

## Phase 0: Preflight

- [x] T001 Resolve canonical branch and exact base SHA before branch creation. Base: `agent/platform-telegram-self-service` at `c3c06f88dbb37b95cd4d8f391d05f76953272324`.
- [x] T002 Fresh-check open PRs and isolate this workstream from parallel CRM frontend work.
- [x] T003 Fresh-check production Supabase migration head (`0117`) and current GPT client modes/capability state.
- [x] T004 Trace the current GPT Worker, context route, OpenAPI split and production operating docs at the verified base.

## Phase 1: Durable contract

- [x] T010 Create `spec.md` defining one profile-bound GPT, server-validated Artist context, legacy rollback and future extension boundaries. [FR-001..FR-015, SR-001..SR-009]
- [x] T011 Create `plan.md` grounded in current Worker/database/production client evidence and separate repository work from external activation. [AC-005, AC-009]
- [x] T012 Create this traceable task list and keep deferred integrations explicit.

## Phase 2: Repository implementation

- [ ] T020 Rewrite `docs/crm/gpt-actions-production-runbook.md` so the target model is one profile-bound `vishar-unified-gpt`, with artist-bound clients documented only as compatibility/rollback. [FR-011, FR-012, AC-005]
- [ ] T021 Add durable GPT v2 model instructions covering context-first behavior, selection ambiguity, read-before-write, consequential confirmation, idempotent retry and bounded error handling. [FR-009, FR-010, FR-014, AC-006]
- [ ] T022 Add/update repository-local production onboarding guidance for unified GPT setup without exposing secrets and without per-Artist OAuth clients. [FR-001, FR-011, SR-005]
- [ ] T023 Ensure future Notification/Template Studio and Web Research integration points are documented as extensions of the same identity/context boundary. [FR-015]

## Phase 3: Contract and security tests

- [ ] T030 Add a v2 contract test that fails if production guidance returns to `OAuth client = Artist`, if legacy clients are described as the target architecture, or if the v2 instructions omit context/confirmation/failure requirements. [AC-005, AC-006]
- [ ] T031 Keep `/v1/context` as the only schema/action location allowed to accept `artist_id`; run existing unified-context/OpenAPI tests. [FR-004, FR-005, SR-002, AC-001]
- [ ] T032 Revalidate that both Core and Operations use the same OAuth edge, remain within the action-count bounds and retain unique operation IDs. [FR-007, AC-007]
- [ ] T033 Revalidate that reads/mutations retain correct `x-openai-isConsequential` classification and high-impact descriptions. [FR-008, FR-010]
- [ ] T034 Revalidate Worker secret/credential boundary and forbidden identity/routing fields. [SR-003..SR-005]
- [ ] T035 Run full database/pgTAP authorization suite through normal CI to preserve profile ambiguity, revocation, capability ceiling and legacy fixed-Artist denial behavior. [AC-002..AC-004]

## Phase 4: Exact-head validation and merge

- [ ] T040 Open a bounded PR against the freshly rechecked canonical base.
- [ ] T041 Require `Static Validation` green on the exact PR head.
- [ ] T042 Require `CRM and booking validation` green on the exact PR head, including Worker tests and full Supabase replay/pgTAP.
- [ ] T043 Inspect and fix any failed workflow rather than waiving it.
- [ ] T044 Recheck canonical base/parallel PR state and PR mergeability immediately before merge.
- [ ] T045 Merge only the bounded GPT v2 contract/onboarding increment and read back the new canonical HEAD.

## Phase 5: Convergence

- [ ] T050 Run Spec Kit consistency analysis against spec, plan, tasks and implemented files.
- [ ] T051 Confirm no repository artifact still presents artist-bound OAuth clients as the target architecture.
- [ ] T052 Confirm all unimplemented items are either rollout tasks or explicitly deferred integrations.

## Phase 6: Unified production activation, separate stage

- [ ] T060 Fresh-check canonical exact SHA, exact-head CI, production migration head, current Cloudflare GPT Worker version/routes/bindings/flags, OAuth discovery and current Custom GPT configuration. [AC-009]
- [ ] T061 Confirm `vishar-unified-gpt` remains `binding_mode=profile`, `artist_id IS NULL`, dormant before activation, and both legacy clients remain active. [FR-012, FR-013, AC-009]
- [ ] T062 Reassess the intermittent Supabase 401 incident. Do not perform final cutover while it makes auth/transport failures materially ambiguous unless containment is proven. [AC-011]
- [ ] T063 Create/configure one confidential production OAuth client for the unified application through an authorized control plane. Keep the secret out of repository/chat and register only the fixed Worker callback.
- [ ] T064 Bind the non-secret OAuth client id to `vishar-unified-gpt` and enable only intended capability ceilings through an auditable authorized path. Keep legacy clients unchanged.
- [ ] T065 Configure one Custom GPT with the exact-SHA Core and Operations schemas and the v2 instructions, using the same OAuth application identity.
- [ ] T066 Production read-only acceptance: authenticate, read context, select authorized Artist when needed, prove unauthorized Artist denial, read representative CRM records. [AC-010]
- [ ] T067 Consequential acceptance only through legitimate intended real operations, preserving confirmation/idempotency boundaries. Do not fabricate production clients, messages or payments.
- [ ] T068 Record production DB/Cloudflare/GPT readback and rollback reference. Only then consider a separate legacy retirement workstream.

## Deferred work

- [ ] D001 Notification/template editing Actions - Reason: wait for the final server-side Notification/Template Studio contract, then expose bounded actions through this same profile/context/capability model.
- [ ] D002 Firecrawl/Web Research Actions - Reason: implemented under `specs/web-research/`; when ready, reuse this same unified GPT OAuth/profile context rather than a provider-specific GPT identity.
- [ ] D003 Legacy Vladimir/Kristina GPT retirement - Reason: only after unified GPT production acceptance and an explicit safe retirement stage.
