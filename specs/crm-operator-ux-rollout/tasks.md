# Tasks

## Foundation

- [x] Verify canonical CRM base branch and exact SHA.
- [x] Verify exact-head CRM validation on the base SHA.
- [x] Create bounded task branch `agent/crm-operator-ux-rollout-20260920`.
- [x] Record calendar and self-booking as out of scope.
- [x] Record operator-parity decision for Enquiry Board as `available`.

## Phase 1: Enquiry Board

- [x] Re-read current EnquiriesPage, permissions, transition API, and styles at the task head.
- [x] Add board grouping and legal-target helper with unit tests.
- [x] Add List / Board view switch preserving search and artist scope.
- [x] Add compact board cards and responsive columns.
- [x] Add safe move control using current allowed transitions and `transitionEnquiry`.
- [x] Ensure `deposit_paid` cannot be manually selected.
- [x] Add failure rollback/error UI.
- [x] Add touch/keyboard-accessible move path; drag is convenience only.
- [x] Run focused tests.
- [x] Run exact-head CI and fix failures.

## Phase 2: Mobile Client Workspace

- [x] Fresh-check branch/base before edits.
- [x] Extract presentation sections without changing data authority.
- [x] Add Work / Messages / History / Details tabs on narrow screens.
- [x] Preserve desktop behavior and permission gates.
- [x] Add mobile/regression tests.
- [x] Run exact-head CI and fix failures.

## Phase 3: Follow-up Workspace

- [x] Fresh-check final follow-up contracts and permissions.
- [x] Add deterministic follow-up grouping helpers and tests.
- [x] Add grouped workspace UI.
- [x] Prefer linked enquiry → project → client routes.
- [x] Reuse current follow-up mutation authority.
- [x] Verify Today behavior is unchanged.
- [x] Run exact-head CI and fix failures.

## Phase 4: Activity Feed

- [x] Fresh-check final activity read/RPC and all callers.
- [x] Add bounded/cursor server read if the current contract is unbounded.
- [x] Add reusable ActivityFeed with desktop Load more.
- [x] Add mobile incremental loading with retry/manual fallback.
- [x] Migrate client/enquiry/project/general activity surfaces incrementally.
- [x] Run exact-head CI and fix failures.

## Convergence

- [x] Re-run operator-parity inventory for any new meaningful operator actions.
  - Enquiry Board status movement reuses `enquiries.set_status` / `setEnquiryStatus`: `available`.
  - Follow-up completion reuses `followups.complete` / `completeFollowUp`: `available`.
  - Activity pagination remains the existing `activity.list` read capability: `available`.
  - Mobile client tabs are presentation-only and introduce no new operator mutation.
- [x] Compare task branch against current canonical CRM base.
- [x] Resolve parallel base movement without overwriting newer changes.
- [x] Run final exact-head validation.
- [x] Record remaining acceptance criteria: production deployment, readback, and live acceptance only.
- [ ] Complete production rollout/readback after explicit rollout authorization.
