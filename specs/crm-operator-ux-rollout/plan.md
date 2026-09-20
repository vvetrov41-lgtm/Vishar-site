# Plan

## Base and branch

- Repository: `vvetrov41-lgtm/Vishar-site`
- Canonical CRM base at branch creation: `agent/platform-telegram-self-service`
- Verified base SHA: `db81572972463919d76805f2aefd281eba5f4c33`
- Task branch: `agent/crm-operator-ux-rollout-20260920`
- Exact-head CRM validation on the base SHA was green before the task branch was created.

## Phase 1: Enquiry Board

Implement a second presentation over the existing enquiry query and transition authority.

1. Add pure board grouping/target-resolution helpers.
2. Add Board/List mode control without removing the current list.
3. Render compact board columns from existing statuses:
   - New: `new`, `reviewing`
   - Waiting: `waiting_for_client`
   - Ready: `accepted`, `quote_sent`
   - Deposit: `deposit_requested`, `deposit_paid`
   - Booked: `converted`
4. Keep `declined` and `closed` in the existing filtered/list workflow rather than primary columns.
5. Use `listStatusTransitions` + role-aware `availableTransitions` to decide legal card moves.
6. Persist status only through `transitionEnquiry` / `transition_enquiry_status`.
7. Never offer `deposit_paid` as a manual board target.
8. Provide pointer/drag convenience only if it remains robust without adding an unnecessary dependency; always provide a touch/keyboard move control.
9. Preserve artist scope, search, client-name resolution, current route links, and scroll behavior.
10. Add tests before relying on CI.

## Phase 2: Mobile Client Workspace

Refactor presentation, not data authority.

1. Extract existing Client Detail sections into stable renderable blocks where needed.
2. Add narrow-screen Work / Messages / History / Details tabs.
3. Keep one route and current `useAsync` load; tab changes are local UI state.
4. Keep the current desktop flow and all permission gates.
5. Add mobile navigation/state tests and regression coverage for action visibility.

## Phase 3: Follow-up Workspace

1. Trace the existing follow-up API/RPC and permission boundary at the then-current exact branch head.
2. Add pure date grouping helpers: overdue, today, tomorrow, this week, later, completed.
3. Add a focused workspace/route only if the current navigation has no equivalent surface.
4. Link each row to enquiry → project → client in that priority order.
5. Reuse existing mutation authority to mark done/cancelled.
6. Keep Today semantics unchanged.

## Phase 4: Paginated Activity Feed

1. Trace the final effective activity read contract and all callers.
2. If the current contract is unbounded, add a bounded cursor/limit read before building infinite UI.
3. Add a reusable ActivityFeed presentation.
4. Desktop: explicit Load more.
5. Mobile: near-end loading with retry/manual fallback.
6. Migrate detail surfaces incrementally; do not replace authoritative activity storage.

## Trust and authorization boundaries

- Board state changes reuse the current server-side status transition RPC and its authorization.
- Browser grouping is presentation only and cannot widen allowed transitions.
- Artist scope remains a read/filter context, not an ownership authority.
- No provider, credential, Calendar, payment, or integration routing changes occur in this rollout.
- Existing RLS/capability checks remain authoritative.

## Validation and rollout

For every phase:

1. Fresh-check base/task branch heads before writing.
2. Run focused tests and admin typecheck/build through exact-head CI.
3. Inspect failures and repair the proven layer.
4. Keep phase diffs bounded.
5. Rebase/restack only after checking current base and parallel PRs.

Production deployment is deferred until the implementation workstream is converged and separately authorized. Calendar remains out of scope.
