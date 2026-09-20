# Tasks: WhatsApp-linked Google Contact sync

## Rules

- Every implementation task traces to requirements/plan sections.
- Environment mutation is separate from code/CI.
- Deployment is never considered complete from code or CI evidence alone.

## Phase 0: Preflight

- [x] T001 Resolve current canonical branch/base and exact head SHA. Base observed: `agent/platform-telegram-self-service@de181914ed5ad46c8303709748881f314bff6284`.
- [x] T002 Create bounded feature branch from the exact observed head: `agent/whatsapp-google-contact-sync`.
- [x] T003 Reconcile spec/plan with production schema, current Google OAuth Worker, WhatsApp auto-link trigger, current production/staging migration heads, and People API contract.
- [ ] T004 Recheck canonical head immediately before implementation writes and record any drift.

## Phase 1: Foundation

- [ ] T010 Add a dedicated `google_contact_create` outbox enum migration, separate from migrations that use the new value. [FR-008]
- [ ] T011 Add backend-only enqueue/reconciliation/claim/ack database contracts, partial queue index and non-blocking post-link trigger. [FR-001, FR-002, FR-003, FR-004, FR-008, FR-009]
- [ ] T012 Extend backend-only outbox routing so Contacts jobs resolve only through the owning artist's enabled pinned Google integration. [FR-009, SR-001, SR-002, SR-004]
- [ ] T013 Add capability metadata enable/disable contract and reconciliation on successful Contacts-authorised connection. [FR-010, FR-011]

## Phase 2: Core implementation

- [ ] T020 Add Google People API provider module with scope validation, search warmup, exact canonical E.164 matching, minimal create payload and provider error classification. [FR-004, FR-005, FR-006, FR-007, FR-010]
- [ ] T021 Add dedicated Google Contacts outbox drain and integrate it into the existing scheduled Google Worker without making WhatsApp ingestion dependent on it. [FR-002, FR-007, FR-008]
- [ ] T022 Extend Google OAuth requested scopes to Contacts, persist granted scope in the encrypted token envelope, enable capability only after successful consent, and disable it on disconnect. [FR-010, FR-011]
- [ ] T023 Update Calendar/Google connection UI copy and reconnect error handling to disclose Contacts access and automatic WhatsApp-client contact sync. [AC-010]
- [ ] T024 Update operator parity inventory: Google provider consent remains `ui_only`; automatic background contact projection introduces no manual GPT operation. [AC-011]

## Phase 3: Authorization and failure paths

- [ ] T030 Prove unmatched/unlinked WhatsApp, archived/invalid clients, cross-artist rows, disabled integration and malformed jobs cannot produce a Google write. [SR-001, SR-002, SR-005, AC-004, AC-005]
- [ ] T031 Prove existing exact phone is never overwritten and duplicate create is suppressed on retries. [FR-005, FR-007, SR-006, AC-002, AC-003]
- [ ] T032 Prove missing scope/token/account pin/provider failures never roll back or block WhatsApp/client linkage and use bounded retry/dead states. [FR-002, FR-008, AC-006]
- [ ] T033 Prove logs/audit/provider body contain no unapproved client/enquiry/message/project data. [FR-006, SR-003, SR-007, AC-007]

## Phase 4: Tests and validation

- [ ] T040 Add Worker provider/drain/OAuth unit-contract tests and wire them into `npm run test:worker`. [AC-002, AC-003, AC-005, AC-006, AC-007]
- [ ] T041 Add pgTAP/database tests for trigger, dedupe, claim/lease, route denial, ack retry/dead and reconciliation. [AC-001, AC-004, AC-005, AC-006]
- [ ] T042 Update CRM tests and run admin test/typecheck/build plus Calendar production bundle validation. [AC-010]
- [ ] T043 Run required exact-head GitHub Actions and record run/SHA evidence. [AC-008]

## Phase 5: Convergence

- [ ] T050 Re-run consistency/security review after implementation and update artifacts for any legitimate design drift.
- [ ] T051 Compare spec, plan, tasks, implementation and exact-head CI.
- [ ] T052 Resolve or explicitly defer every convergence gap.

## Phase 6: Environment rollout

- [ ] T060 Fresh-check canonical head, release lineage, production migration head, exact-head required CI, production Worker target, routes/bindings/secret-name presence and staging drift before any mutation.
- [ ] T061 Apply additive production migrations through the approved fail-closed release path and independently read back functions/triggers/enum/grants.
- [ ] T062 Deploy the Google Worker through its approved production gate with dry-run and independent route/binding/trigger readback.
- [ ] T063 If the existing Google token lacks Contacts permission, complete one human Google OAuth reconnect/consent; then verify the server-side capability flag and token-scope behavior without exposing token material.
- [ ] T064 Verify reconciliation/drain against legitimate existing/newly linked client state and confirm exactly one Google contact is created or safely skipped as existing. [AC-009]
- [ ] T065 If required for WhatsApp display acceptance, verify the phone is configured to sync that Google Contacts account; no server-side workaround is claimed for device-local settings.
- [ ] T066 Record rollback/reference deployment state and final production evidence.

## Deferred work

- [ ] D001 Automatic update/delete of CRM-created Google contacts after later CRM client edits/archive. Reason: initial requested capability is safe create-once contact addition; modifying/deleting address-book data materially increases blast radius.


## Phase 7: 2026-09-20 enquiry-preference extension

Active bounded continuation. Earlier task checkboxes above are historical artifacts from the original workstream; the original capability is already present in canonical production code. These tasks track only the newly requested enquiry-origin path.

- [x] T070 Fresh-check canonical CRM branch and production migration head. Canonical base: `2ab4e7f42c4ae99b88c46e820e81f547abb4341e`; production migration head: `20260920160027_google_contacts_terminal_provider_diagnostics`. [Constitution IV, VII]
- [x] T071 Verify current provider path can complete an outbox job and inspect the effective enquiry intake path. Wayne Arcibald's production Google Contact outbox row is now `succeeded`; direct Google Contacts name search did not independently prove the contact, so provider acceptance remains separately tracked. [AC-009]
- [x] T072 Update spec/plan/tasks before implementation to define trusted enquiry-preference eligibility and denial guards. [FR-001, FR-013, FR-014, AC-012, AC-013]
- [x] T073 Add one forward-only migration with private shared eligibility predicate, enquiry trigger, enqueue/claim/reconciliation replacements and unchanged service-only/provider boundaries. Implemented in `20260920185000_google_contacts_whatsapp_preferred_enquiry.sql`. [FR-001, FR-004, FR-008, FR-009, FR-013, FR-014]
- [x] T074 Extend pgTAP regression coverage for enquiry-only eligibility, non-WhatsApp/conflict/phone-mismatch denial, trigger non-blocking behavior, dedupe and claim validity. `google_contacts_sync.sql` now has 37 passing assertions on a clean migration reset. [AC-001, AC-004, AC-012, AC-013]
- [x] T075 Run local/static database validation available in CI and exact-head GitHub Actions on the extension SHA. PR #835 head `a440458d09b71c5d563c2674cad9ffd7ffda9035`: Static Validation and CRM and booking validation passed, including migration reset, pgTAP and SQL lint. [AC-008]
- [x] T076 Fresh-check canonical drift and merge only if the extension remains bounded and exact-head CI is green. PR #835 merged to canonical as `7712e81d2c194f68b017026fd386350b6e8b8b1a`.
- [ ] T077 Roll out the additive migration through the existing production database release guard, then read back exact function definitions, trigger and migration head. [Constitution VII]
- [ ] T078 Verify production behavior without fabricating customer data: inspect a legitimate new/existing WhatsApp-preferred enquiry path and resulting outbox/provider state; if no legitimate event is available, leave this acceptance criterion explicitly open rather than creating a fake production client. [AC-009, AC-012]
