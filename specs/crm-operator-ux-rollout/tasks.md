# Tasks

## Foundation

- [x] Verify canonical CRM base branch and exact SHA.
- [x] Verify exact-head CRM validation on the base SHA.
- [x] Create bounded task branch `agent/crm-operator-ux-rollout-20260920`.
- [x] Record calendar and self-booking as out of scope.
- [x] Record operator-parity decision for Enquiry Board as `available`.

## Phase 1: Enquiry Board

- [ ] Re-read current EnquiriesPage, permissions, transition API, and styles at the task head.
- [ ] Add board grouping and legal-target helper with unit tests.
- [ ] Add List / Board view switch preserving search and artist scope.
- [ ] Add compact board cards and responsive columns.
- [ ] Add safe move control using current allowed transitions and `transitionEnquiry`.
- [ ] Ensure `deposit_paid` cannot be manually selected.
- [ ] Add failure rollback/error UI.
- [ ] Add touch/keyboard-accessible move path; drag is convenience only.
- [ ] Run focused tests.
- [ ] Run exact-head CI and fix failures.

## Phase 2: Mobile Client Workspace

- [ ] Fresh-check branch/base before edits.
- [ ] Extract presentation sections without changing data authority.
- [ ] Add Work / Messages / History / Details tabs on narrow screens.
- [ ] Preserve desktop behavior and permission gates.
- [ ] Add mobile/regression tests.
- [ ] Run exact-head CI and fix failures.

## Phase 3: Follow-up Workspace

- [ ] Fresh-check final follow-up contracts and permissions.
- [ ] Add deterministic follow-up grouping helpers and tests.
- [ ] Add grouped workspace UI.
- [ ] Prefer linked enquiry → project → client routes.
- [ ] Reuse current follow-up mutation authority.
- [ ] Verify Today behavior is unchanged.
- [ ] Run exact-head CI and fix failures.

## Phase 4: Activity Feed

- [ ] Fresh-check final activity read/RPC and all callers.
- [ ] Add bounded/cursor server read if the current contract is unbounded.
- [ ] Add reusable ActivityFeed with desktop Load more.
- [ ] Add mobile incremental loading with retry/manual fallback.
- [ ] Migrate client/enquiry/project/general activity surfaces incrementally.
- [ ] Run exact-head CI and fix failures.

## Convergence

- [ ] Re-run operator-parity inventory for any new meaningful operator actions.
- [ ] Compare task branch against current canonical CRM base.
- [ ] Resolve conflicts from parallel work without overwriting newer changes.
- [ ] Run final exact-head validation.
- [ ] Record remaining acceptance criteria, if any.
- [ ] Production rollout/readback only after separate authorization.
