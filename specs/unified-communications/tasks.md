# Tasks: Unified enquiry communications

## Rules

- Every implementation task traces to the specification or plan.
- Deployment is never completed from code or CI evidence alone.
- The next phase starts only after the preceding provider/UI acceptance gate is met.

## Phase 0: Preflight

- [x] T001 Resolve canonical branch, exact head SHA and open PR state. Evidence: `agent/platform-telegram-self-service` at `3b8b66a1945322b3dd95830000ce119ce3fe0bfd`; no open PR.
- [x] T002 Verify exact clean checkout and create bounded stage 1 branch.
- [x] T003 Reconcile current code, production migration head, safe WhatsApp metadata and communications counts. Production is through `0117`; both routes are enabled with empty configuration; Vladimir has no inbound message evidence.
- [ ] T004 Verify the exact Meta App ID and Configuration ID pair plus configuration generation/status in Meta without changing Kristina. [FR-001, FR-005]

## Phase 1: WhatsApp Embedded Signup recovery

- [x] T010 Add the reviewed Facebook SDK cross-domain frame origin to production CSP and fail artifact validation if it disappears. [FR-002, AC-001]
- [x] T011 Add typed, credential-free diagnostics for SDK load, login callback, CANCEL/ERROR step, incomplete finish payload and timeout. [FR-003, FR-004]
- [x] T012 Preserve synchronous iPhone tap launch and add focused ordering/failure tests. [FR-002, AC-001]
- [x] T013 Verify frontend/backend App ID consistency and Configuration ID artifact presence. [FR-001]
- [x] T014 Run CRM unit tests, typecheck, build, artifact scan and focused WhatsApp production tests. [AC-001, AC-002]
- [ ] T015 Run exact-head required CI on the stage 1 PR and resolve every failure. [AC-010]
- [ ] T016 Deploy the exact stage 1 private CRM Pages artifact and read back SHA, CSP and Access boundary. [AC-010]
- [ ] T017 Complete Vladimir's iPhone Safari Embedded Signup and read back only Vladimir's safe route/binding evidence. [AC-001, AC-002, AC-005]
- [ ] T018 Send one real approved inbound WhatsApp message and one CRM reply; verify both directions and provider acknowledgement. [AC-003, AC-004]

## Phase 2: Unified channel states in the enquiry

- [ ] T020 Replace the legacy enquiry WhatsApp action mix with one Communications block showing Email, WhatsApp and Instagram states. [FR-006]
- [ ] T021 Preserve current external-open and conversation-create behaviors only where they remain explicit and unambiguous. [FR-006, FR-012]
- [ ] T022 Add RU/EN and narrow-viewport tests for the channel state block. [FR-013]

## Phase 3: WhatsApp and Instagram enquiry conversations

- [ ] T030 Trace final effective communications SQL/RPC definitions, grants and RLS after migration `0069`. [SR-001, SR-004, SR-005]
- [ ] T031 Implement enquiry-first conversation lookup and authorized same-artist unique client fallback linking. [FR-007]
- [ ] T032 Add recent WA/Instagram messages, reply and open-full-dialog actions to the enquiry. [FR-008]
- [ ] T033 Add positive, unauthorized, cross-artist and ambiguous fallback tests. [SR-005, AC-006, AC-007]
- [ ] T034 Remove `EnquiryWhatsAppPanel` only after the common component passes compatibility tests. [FR-012]

## Phase 4: Email adapter

- [ ] T040 Trace final Gmail/email SQL, thread context, approval and outbox paths after migration `0059`. [SR-006]
- [ ] T041 Add a frontend email adapter that emits the common conversation/message interface without moving physical rows. [FR-009]
- [ ] T042 Show relevant enquiry/client Gmail history and preserve thread context. [FR-009]
- [ ] T043 Queue replies through the protected approved/queued Gmail pipeline; add denial/idempotency tests. [FR-010, SR-006, AC-008]

## Phase 5: Unified timeline and release

- [ ] T050 Merge adapter items into a timestamp-ordered, channel-labelled timeline. [FR-011]
- [ ] T051 Complete RU/EN, mobile layout, keyboard/accessibility and failure-state validation. [FR-013, AC-009]
- [ ] T052 Run all local tests, full pgTAP when SQL changed, secret scans and exact-head required CI. [AC-010]
- [ ] T053 Build an immutable release candidate, deploy through guarded workflows and read back Supabase/Workers/Pages exact state. [AC-010]
- [ ] T054 Complete WA, Instagram and email E2E acceptance using legitimate existing production records only.

## Phase 6: Convergence

- [ ] T060 Re-run specification consistency analysis after each material stage.
- [ ] T061 Converge implementation, tests, CI, rollout and production evidence against every acceptance criterion.
- [ ] T062 Resolve or explicitly defer every remaining gap with rationale.

## Deferred work

- [ ] D001 Decide whether to merge email and Meta messages into one physical database model. Reason: the adapter meets the current product goal with less migration and authorization risk.
