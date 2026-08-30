# Tasks: CRM Web Research

## Rules

- Every implementation task traces to `spec.md` or `plan.md`.
- Firecrawl is an implementation provider, not the authorization or product boundary.
- Phase W does not start until Phase V production acceptance is proven.
- Recurring monitoring does not start until persistent Phase W1 save/repeat/compare acceptance is proven.
- Deployment is never complete from code or CI evidence alone.
- Before every write/merge/deploy, re-check the relevant exact head because parallel Vishar workstreams may move the base.

## Phase 0: Implementation preflight

- [ ] T001 Re-resolve canonical repository branch, relevant PR/stack, exact head SHA, base SHA and required exact-head workflows. [AC-015]
- [ ] T002 Verify clean exact target checkout and create a bounded implementation branch from that SHA. [AC-015]
- [ ] T003 Trace current unified GPT OAuth/profile-context resolver, action Worker/routes and all production OpenAPI artifacts. [AR-007, AC-009]
- [ ] T004 Fresh-check actual production Cloudflare Worker/Pages routes, bindings, kill-switch conventions and deployment release machinery relevant to GPT/CRM actions. [SR-001, AC-015]
- [ ] T005 Read the Supabase skill and fresh-check production migration head plus current workspace/artist authorization model, without writing a migration yet. [AR-001, AR-003]
- [ ] T006 Re-verify current Firecrawl Search/Scrape/Crawl API contract, credential model, limits and pricing from provider documentation. [FR-001, FR-002]
- [ ] T007 Resolve Phase V cache backend, TTL, per-profile/workspace usage policy and exact safe observability fields. [FR-009, SR-008, SR-009]

## Phase 1: Provider-independent Research gateway foundation

- [ ] T010 Define provider-neutral TypeScript contracts for `deep_web_search`, `read_web_page` and `crawl_website`, including source metadata and explicit failure states. [FR-001, FR-002, FR-008]
- [ ] T011 Implement a public-only request builder that cannot include CRM client names, contacts, notes, images, finance, communications, OAuth material or arbitrary private prompt payloads. [SR-006, SR-007, AC-014]
- [ ] T012 Implement server-side operation/result/time/response/concurrency limits with search <= 10, read = one URL and crawl hard cap <= 20. [FR-004, FR-005, FR-006, AC-003]
- [ ] T013 Add global/search/crawl server-side kill switches, disabled by default for rollout. [SR-010, AC-008]
- [ ] T014 Add provider-neutral safe error taxonomy for disabled, invalid URL, rate limited, timeout, transport failure, malformed provider output and empty successful result. [FR-008, AC-007]
- [ ] T015 Add focused unit/contract tests for gateway contracts, limits and failure normalization. [FR-004, FR-008]

## Phase 2: Outbound URL and SSRF security boundary

- [ ] T020 Implement canonical URL parsing and reject non-HTTP(S), embedded credentials and malformed destinations. [SR-002, AC-004]
- [ ] T021 Implement IPv4/IPv6 rejection for localhost, loopback, private, link-local, reserved, multicast and cloud metadata targets. [SR-002, AC-004]
- [ ] T022 Implement DNS-resolution/revalidation behavior appropriate to the actual Cloudflare runtime and prove DNS rebinding cannot bypass the destination policy. [SR-003, AC-004]
- [ ] T023 Revalidate every redirect target, cap redirects and fail closed before credentials reach an unsafe destination. [SR-003, AC-004]
- [ ] T024 Prohibit caller-defined cookies, Authorization and arbitrary outbound headers. [SR-004]
- [ ] T025 Add denial tests for unsafe schemes, IPv4/IPv6 ranges, metadata hosts, public-to-private redirects and rebinding scenarios. [AC-004]

## Phase 3: Firecrawl adapter

- [ ] T030 Add the Firecrawl provider adapter behind the Research gateway using only currently verified Search/Scrape/Crawl contracts. [FR-001, FR-002]
- [ ] T031 Add the Firecrawl credential only through the smallest appropriate encrypted Cloudflare/server-side secret boundary; never commit or expose its value. [SR-001]
- [ ] T032 Add credential presence/readback checks using only redacted/presence metadata. [SR-001, AC-015]
- [ ] T033 Normalize Search/Scrape/Crawl responses into Vishar contracts and ensure raw provider payloads are not passed through by default. [FR-008]
- [ ] T034 Implement and test provider `429`, timeout, transport and malformed-output behavior with no fabricated or successful-empty fallback. [AC-007]
- [ ] T035 Verify Interact, browser clicks, form fill, login, cookies and arbitrary headers are absent from the V1 public action surface. [FR-007]

## Phase 4: Cache, budgets and observability

- [ ] T040 Implement bounded finite-TTL caching based only on canonical public research inputs and stable extraction definition. [FR-009]
- [ ] T041 Prove equivalent repeat requests can hit cache without leaking another workspace's private request metadata. [SR-008, AC-006]
- [ ] T042 Implement global and actor/workspace usage limits sufficient to prevent one caller from exhausting provider capacity. [FR-004, FR-006]
- [ ] T043 Add safe telemetry for operation, timing, provider category, result counts, cache state, bounded usage and exact deployed version, excluding page bodies and private CRM data. [SR-009]
- [ ] T044 Add tests proving provider failure is never cached or represented as a successful "no result/no change" response. [AC-007, AC-013]

## Phase 5: Prompt-injection and mixed-data boundary

- [ ] T050 Mark scraped provider output as untrusted content and keep it separate from tool/control instructions. [SR-005]
- [ ] T051 Add malicious-page fixtures that ask the model/tool layer to ignore instructions, expose secrets, call CRM mutations, change artist, send a message or fetch internal URLs. [SR-005, AC-005]
- [ ] T052 Prove none of those fixtures can trigger a privileged follow-up action or broaden authorization. [AC-005]
- [ ] T053 Implement the mixed-question split: public-only Research fetch first, separately authorized CRM retrieval second, combination only inside Vishar/GPT after both boundaries succeed. [SR-006, SR-007]
- [ ] T054 Add regression tests with representative private CRM field names and payload shapes to prove they never enter provider requests. [AC-014]

## Phase 6: Unified GPT action integration

- [ ] T060 Extend the current Vishar GPT action backend with semantic Research operations, not Firecrawl raw endpoints. [FR-001, FR-002]
- [ ] T061 Extend current GPT OpenAPI/action artifacts with only Vishar Research schemas and no Firecrawl credential/authentication surface. [SR-001, AR-007, AC-009]
- [ ] T062 Preserve current profile-bound OAuth and artist-context resolver; Research must not create a second OAuth client or fallback artist. [AR-007, AC-009]
- [ ] T063 Add tool descriptions/routing guidance so ordinary built-in GPT web search remains preferred for simple lookups and Research is selected for deep/repeatable work. [FR-003]
- [ ] T064 Add contract tests proving `artist_id`/workspace context cannot become an authorization bypass through Research parameters. [AR-003, AR-004, AR-007]
- [ ] T065 Run local GPT action/OpenAPI tests and secret scans. [SR-001]

## Phase 7: Phase V staging and production rollout

- [ ] T070 Run focused Research unit/security suites plus all required exact-head repository CI on the Phase V SHA. [AC-015]
- [ ] T071 Deploy Phase V to staging with provider/search/crawl switches initially off; read back exact version, routes, binding presence and switch state. [AC-008, AC-015]
- [ ] T072 Enable staging operations and prove one public page pricing/deposit/policy read with its source. [AC-001]
- [ ] T073 Compare five public studio/artist sites using one stable extraction schema. [AC-002]
- [ ] T074 Prove path-constrained bounded crawl cannot exceed the hard cap. [AC-003]
- [ ] T075 Prove unsafe URL/redirect/rebinding cases fail before provider invocation. [AC-004]
- [ ] T076 Prove prompt-injection fixtures cannot alter GPT/tool behavior. [AC-005]
- [ ] T077 Prove cache isolation, provider failure states and each kill switch. [AC-006, AC-007, AC-008]
- [ ] T078 Complete unified-GPT staging E2E with the authenticated profile/current artist context. [AC-009]
- [ ] T079 Re-check base/PR/exact-head CI and release only the proven immutable Phase V SHA through the existing guarded production path. [AC-015]
- [ ] T080 Read back production deployment/version/routes/binding presence/switch state and repeat bounded real public-source acceptance. [AC-001, AC-003, AC-009, AC-015]

## Phase 8: Phase W persistence design preflight

- [ ] T090 Confirm Phase V production acceptance is complete before any persistent Research migration is written. [FR-010]
- [ ] T091 Fresh-check canonical repo head and production Supabase migration head; choose the next forward-only migration number from live truth. [AC-015]
- [ ] T092 Trace final effective workspace membership, capability registry, artist capability, RLS and grant functions at the Phase W exact target SHA. [AR-001, AR-003, AR-004]
- [ ] T093 Resolve durable Research retention/deletion/export rules before schema creation. [FR-010, Data and retention expectations]
- [ ] T094 Resolve exact Research permission mapping, including workspace-level semantics and artist-context checks, before migration. [AR-005]
- [ ] T095 Finalize stable normalized definitions for run/source/snapshot and comparison behavior. [FR-010, FR-011, FR-012]

## Phase 9: Phase W database and API

- [ ] T100 Add forward-only Research persistence migration with workspace ownership and optional artist context. [FR-010, AR-002]
- [ ] T101 Add Research capabilities through the existing registry/workspace model, never a Firecrawl ACL. [AR-001, AR-005]
- [ ] T102 Add authoritative RLS/RPC checks for list/read/create/repeat/manage operations. [AR-003, AR-004, AR-006]
- [ ] T103 Add pgTAP positive and denial cases for unrelated workspace, revoked membership, missing capability and mismatched artist context. [AC-010, AC-012]
- [ ] T104 Implement append-only successful snapshots so reruns cannot overwrite earlier evidence. [FR-012, AC-011]
- [ ] T105 Implement failed-run recording that preserves the last successful snapshot and never becomes "no change". [FR-016, AC-013]
- [ ] T106 Add service-only helper boundaries with narrow grants, fixed `search_path` and no browser-accessible privileged tables where applicable. [AR-001, SR-001]

## Phase 10: CRM Research UI

- [ ] T110 Add one private CRM Research area with Competitors, Studios, Pricing, SEO and Market research category/filter surfaces. [FR-015]
- [ ] T111 Add create/run UI for a bounded research definition using the same backend Research gateway as GPT. [FR-001, FR-010]
- [ ] T112 Add saved-run list/detail with source evidence and explicit run state. [FR-010]
- [ ] T113 Add repeat action that preserves the saved extraction/crawl definition. [FR-011]
- [ ] T114 Add snapshot comparison that shows material changes without mutating prior evidence. [FR-012, AC-011]
- [ ] T115 Add failure UI that distinguishes provider failure from successful no-change and retains the prior successful snapshot. [AC-013]
- [ ] T116 Add current-authorization tests so a revoked user immediately loses Research access without deletion. [AR-006, AC-012]
- [ ] T117 Add RU/EN and narrow/mobile/accessibility coverage consistent with private CRM conventions.

## Phase 11: Phase W rollout

- [ ] T120 Run migration replay, full pgTAP, CRM tests/build, focused Research security tests, secret scan and required exact-head CI. [AC-015]
- [ ] T121 Deploy migration/backend/UI to staging, read back migration head and exact application versions, then run save/reopen/repeat/compare acceptance. [AC-010, AC-011]
- [ ] T122 Inspect provider requests and stored Research payloads to prove private CRM/client content is absent. [AC-014]
- [ ] T123 Re-check base/PR/CI and deploy the exact Phase W release through guarded production automation. [AC-015]
- [ ] T124 Production readback: exact migration head, Worker/Pages versions, Research routes and actual RLS/access behavior. [AC-010, AC-012, AC-015]
- [ ] T125 Use legitimate public research only to save and repeat one production run; verify snapshot comparison and failure preservation without creating synthetic customer data. [AC-011, AC-013]

## Phase 12: Recurring monitoring

- [ ] T130 Keep recurrence disabled until T125 acceptance is complete. [FR-013]
- [ ] T131 Design recurrence on the existing scheduler/automation principles with bounded frequency, idempotency, ownership, usage limit and kill switch. [FR-014]
- [ ] T132 Add durable failure history and guarantee provider failure cannot replace last-known-good evidence. [FR-014, AC-013]
- [ ] T133 Add exact-head tests and staging acceptance for concurrent/idempotent repeated execution. [FR-014]
- [ ] T134 Enable production recurrence only after deploy/readback/acceptance proves the bounded schedule and kill switch.

## Phase 13: Convergence

- [ ] T140 Run Spec Kit consistency analysis after each material implementation phase.
- [ ] T141 Reconcile any valid implementation-driven requirement changes back into `spec.md` and `plan.md` instead of silently diverging.
- [ ] T142 Converge every acceptance criterion against code, tests, exact-head CI, deployment readback and actual production evidence.
- [ ] T143 Explicitly defer any remaining non-goal/open question with rationale and a safe boundary.

## Deferred work

- [ ] D001 Firecrawl Interact/browser automation. Reason: it creates a materially larger trust and mutation surface and is not needed for the initial CRM Research value.
- [ ] D002 Authenticated/private-site crawling. Reason: conflicts with the V1 public-only data-minimization boundary and would require a new credential/consent design.
- [ ] D003 Autonomous Research-triggered CRM/client actions. Reason: scraped public content is untrusted evidence and must not directly initiate business mutations.
