# Tasks: OpenAI Ads Conversions API

## Phase 1: exact-head and requirements

- [x] T001 Verify active CRM Worker base branch and exact SHA. [AC-003, AC-007]
- [x] T002 Verify current `main` Pixel implementation, consent flow, Pixel ID, and browser event ID behavior. [AC-001, AC-002]
- [x] T003 Verify current OpenAI Ads CAPI request shape, `lead_created`, consent-sensitive attribution references, and deduplication requirements. [FR-001, FR-002, FR-004]
- [x] T004 Produce spec and implementation plan before code changes. [SR-001..SR-005]

## Phase 2: Worker implementation

- [ ] T101 Add a narrow OpenAI Ads CAPI helper with consent/context validation, payload construction, server-only auth, and contained failure behavior. [FR-001..FR-008]
- [ ] T102 Pass a bounded background scheduler from the `tattooai` entrypoint into enquiry intake. [FR-008]
- [ ] T103 Capture request-scoped measurement context without persisting it and schedule CAPI only after durable completion. [FR-003, FR-007]
- [ ] T104 Schedule the same event ID for already-complete idempotent replays. [FR-002, AC-006]
- [ ] T105 Add focused tests or validation harness coverage for consent, payload shape, source sanitization, secret absence, provider failure, PII exclusion, and replay dedupe. [AC-001..AC-007]

## Phase 3: Website companion patch

- [ ] T201 Create a separate feature branch from the fresh current `main`, preserving the already-shipped Pixel implementation.
- [ ] T202 Append CAPI measurement context only when OpenAI Ads consent is `granted`: source URL, `__oppref`, and `__obref`. [FR-003..FR-006]
- [ ] T203 Keep existing browser `lead_created` timing and event ID unchanged. [FR-001, FR-002]
- [ ] T204 Review/update privacy copy for server-side conversion measurement if required. [SR-004, SR-005]

## Phase 4: validation and convergence

- [ ] T301 Re-read every changed file from its exact feature head and verify no unrelated diffs.
- [ ] T302 Verify Worker payload contains no raw/hashed client identity data, IP, user agent, tattoo text, or files. [AC-004]
- [ ] T303 Verify all provider failures are contained and cannot change a completed enquiry response. [AC-003]
- [ ] T304 Run available exact-head checks/CI and record only runs whose SHA matches the tested feature head.
- [ ] T305 Create draft PR(s) with explicit rollout, rollback, security boundary, and external-state notes.
- [ ] T306 Converge spec/tasks against the final PR diff and leave production activation tasks explicitly deferred.

## Phase 5: production activation, deferred until separately authorized

- [ ] T401 Provision the OpenAI Ads Conversions API key for the existing Vishar Tattoo conversion source.
- [ ] T402 Store it only as the production `tattooai` Worker secret `OPENAI_ADS_CAPI_KEY`.
- [ ] T403 Deploy the exact approved Worker and website heads using their repository release paths.
- [ ] T404 Perform an explicitly approved controlled consented enquiry test.
- [ ] T405 Verify recent conversion events and browser/server deduplication in Ads Manager.

Production activation tasks are intentionally not authorized by the current implementation request.
