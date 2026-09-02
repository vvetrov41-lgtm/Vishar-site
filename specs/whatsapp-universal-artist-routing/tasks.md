# Tasks: Universal artist WhatsApp routing

## Rules

- Every completed task needs exact implementation or environment evidence.
- Production rollout is separate from code and CI.
- No test customer, conversation or message may be created in production.

## Phase 0: Preflight

- [x] T001 Resolve canonical branch, exact SHA and open PR overlap. Evidence: canonical `797e86d8c68b886240fe1e953584db06c93e1f95`; PR #588 Firecrawl and PR #587/#578 Calendar do not touch WhatsApp files.
- [x] T002 Verify clean exact checkout and create `agent/whatsapp-universal-artist-routing`.
- [x] T003 Reconcile code, migration history and production state. Production is through `0127`; Vladimir is already connected from real inbound evidence; old all-artists branch is stale and cannot be merged directly.

## Phase 1: Database routing invariant and connected state

- [x] T010 Add the non-conflicting migration with exact artist WhatsApp key uniqueness and `<slug>-environment` enforcement. Evidence: `0129_whatsapp_universal_artist_routing.sql` with preflight drift checks, partial unique index and exact-key trigger. [FR-003, SR-002]
- [x] T011 Add the generic bounded authenticated WhatsApp completion RPC with fixed search path, narrow grants and no direct table-update widening. Evidence: `complete_artist_whatsapp_connection(uuid,text)` grants authenticated only and rechecks access/active/exact route. [FR-009, SR-001, SR-007]
- [x] T012 Add pgTAP positive and denial coverage, including conflicting keys and immutable safe configuration. Evidence: `266_whatsapp_universal_artist_routing.sql` plus the central role matrix. [AC-004]

## Phase 2: Universal provisioning

- [x] T020 Remove embedded-signup source allowlists and derive the exact route/binding from authorized production metadata. [FR-001, FR-002]
- [x] T021 Write self-describing per-artist credential envelopes and add Meta/subscription/two-Worker readbacks before connected completion. [FR-004, FR-008]
- [x] T022 Remove the frontend two-artist onboarding map while preserving the Vladimir-only manual emergency path. [FR-001]
- [x] T023 Add onboarding tests for Vladimir, Kristina-compatible behavior, a future artist, wrong route/WABA/phone, missing credentials and readback ordering. Evidence: production-onboarding boundary and CRM API tests pass. [AC-005]

## Phase 3: Dynamic inbound routing

- [x] T030 Discover encrypted artist WhatsApp bindings dynamically and validate self-describing envelope identity. [FR-005, SR-004]
- [x] T031 Add generic legacy envelope compatibility without hard-coded artist source entries. [FR-007, AC-001]
- [x] T032 Reject duplicate binding/artist/key/phone routes, partial identity, missing legacy identity and unknown provider pairs fail-closed. [FR-006, SR-005]
- [x] T033 Extend webhook tests for Vladimir legacy, a new artist and every collision/mismatch/missing-credential denial path. Evidence: 29 focused webhook cases pass. [AC-002, AC-003]

## Phase 4: Validation and publication

- [ ] T040 Run focused Worker/onboarding/CRM tests, typecheck, builds, secret scans and Wrangler dry runs.
- [x] T041 Reconcile `docs/gpt-actions/operator-parity.mjs`; existing `whatsapp.embedded_signup` remains correctly `ui_only`; parity validation passes 183 classified actions.
- [x] T042 Run `speckit-analyze` after implementation and resolve all blocking/high findings. Result: no blocking/high conflicts; migration ordering on open PR #588 remains an explicit merge dependency.
- [ ] T043 Fresh-check canonical/open PRs, commit only explicit files, push the bounded branch and open a PR.
- [ ] T044 Run required exact-head CI and resolve every failure. [AC-006]
- [ ] T045 Recheck base/mergeability/CI, merge, and verify post-merge canonical SHA/checks.

## Phase 5: Authorized production rollout

- [ ] T050 Preflight immutable SHA, migration dry-run, production target, Worker versions/routes/bindings/cron and rollback references.
- [ ] T051 Apply the production migration through the guarded workflow and read back migration/RPC/grants. [AC-007]
- [ ] T052 Deploy the exact merged webhook Worker and read back version, hostname, secret-name set and unchanged cron state. [AC-007]
- [ ] T053 Deploy the exact merged private CRM Pages artifact and read back commit/protected route. [AC-007]
- [ ] T054 Verify Vladimir's route/timestamp and unchanged real aggregate counts, plus unchanged Kristina safe metadata, without customer writes. [AC-001, AC-008]

## Phase 6: Convergence

- [ ] T060 Run `speckit-converge` against requirements, code, tests, exact-head CI and environment evidence.
- [ ] T061 Append and resolve any newly discovered gap; report `CONVERGED` only with rollout evidence.

## Phase 7: Meta publication and Kristina acceptance

- [x] T070 Reproduce and identify Kristina's provider blocker. Evidence: Meta returned `App not active`; dashboard app `1481226093843982` is `Not published`, with business verification complete but app settings/review incomplete. [FR-011, AC-010]
- [x] T071 Add a public Vishar CRM Meta privacy notice and deletion instructions without changing the existing booking privacy acknowledgement contract. Evidence: `privacy/meta/index.html` plus sitemap entry; static validation and secret scan green.
- [ ] T072 Publish the privacy page from an exact reviewed SHA and verify `https://vishartattoo.com/privacy/meta/` returns the intended notice.
- [ ] T073 Complete Meta app settings with the verified privacy/deletion URL, 1024px icon and business category.
- [ ] T074 Submit a WhatsApp-only App Review and Access Verification with accurate reviewer instructions; keep unrelated Instagram permissions out of this request.
- [ ] T075 While provider review is pending, optionally grant Kristina a bounded temporary app role and record its later removal requirement.
- [ ] T076 Verify the app is published and Kristina can launch consent without `App not active`, then complete the real generic onboarding and read back only safe route/binding metadata. [AC-009]

## Deferred work

- [ ] D001 Workspace-owned/shared WhatsApp accounts - deferred because this release covers individually owned artist accounts only.
- [ ] D002 A third artist's real provider E2E - deferred until another legitimate artist/account exists; Kristina is the required second-artist production acceptance.
