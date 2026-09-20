# CRM operator UX rollout

## Goal

Reduce the number of taps, page changes, and long-scroll navigation required for day-to-day artist CRM work, using proven interaction patterns from open-source CRM projects without replacing Vishar CRM's existing domain model, permissions, workflow authority, communications, payments, or lifecycle automation.

Calendar and self-booking are explicitly out of scope for this rollout.

## Required behavior

### Enquiry board

- Enquiries have both List and Board views; neither removes the other.
- The Board groups existing enquiry statuses into a small number of readable workflow columns rather than inventing new database statuses.
- Search and artist scope behave consistently in List and Board views.
- A card shows the client name, concise tattoo context, current workflow state, and age/last-action context needed to triage it.
- Moving an enquiry never performs a direct status update. It uses the existing allowed-transition model and the authoritative status transition RPC.
- Ambiguous target columns require the operator to choose a concrete allowed status.
- Invalid or failed moves leave the authoritative status unchanged and restore the card to its previous column.
- `deposit_paid` remains ledger-controlled and cannot be fabricated by the board.
- Touch users always have a non-drag move control; drag interaction must not be the only way to change stage.
- Closed/declined enquiries do not consume the primary active board.

### Mobile client workspace

- The existing client workspace remains one route and one data load.
- On narrow screens, operational content is divided into Work, Messages, History, and Details tabs.
- Switching tabs does not refetch the client workspace merely because presentation changed.
- Desktop keeps the existing information architecture unless a small shared-component refactor is required.
- No information or action currently available on Client Detail is lost.

### Follow-up workspace

- Follow-ups can be reviewed by Overdue, Today, Tomorrow, This week, Later, and Completed groups.
- Each row opens the most specific linked working context, preferring enquiry, then project, then client.
- Marking a follow-up done reuses existing authority and permission boundaries.
- Today remains the short daily triage screen and is not replaced by the follow-up workspace.

### Activity feed

- Activity can be consumed incrementally rather than loading an unbounded history.
- Desktop exposes an explicit Load more control.
- Mobile may auto-load the next page near the end of the feed while retaining an accessible manual/retry path.
- Client, enquiry, project, and general activity surfaces share the same event presentation where practical.
- Existing activity rows remain authoritative; do not reconstruct audit history from unrelated tables.

## Constraints

- No Calendar UI/backend changes.
- No self-booking changes.
- No changes to enquiry, project, session, payment, communications, or lifecycle domain semantics unless a later implementation task proves a strictly necessary compatibility change.
- Preserve artist scope, role/capability checks, RLS, audit behavior, and server authority.
- No new direct browser write path that bypasses existing RPCs.
- Avoid new frontend dependencies unless the interaction cannot be implemented safely with the existing stack.

## Operator parity

The enquiry-board status move is not a new operator capability. It is a new presentation of the existing `enquiries.set_status` action, which is already classified as `available` in `docs/gpt-actions/operator-parity.mjs` via `setEnquiryStatus` / `public.gpt_set_enquiry_status`.

Later phases must repeat this parity check for any newly introduced meaningful operator action.

## Failure behavior

- A stale board must not overwrite a newer server status.
- Permission or transition refusal is shown as a bounded operator error, not hidden by optimistic UI.
- Search/filter changes cannot strand cards in the wrong column.
- Mobile presentation failure must not make desktop actions unavailable.
- Activity pagination failure keeps already loaded events visible and allows retry.

## Acceptance criteria

1. The rollout plan and tasks are durable under `specs/crm-operator-ux-rollout/`.
2. Each implementation phase is bounded and independently reviewable.
3. Enquiry Board passes unit/UI tests for grouping, safe transitions, search/scope behavior, failure rollback, and touch fallback.
4. Mobile Client Detail preserves all existing capabilities while reducing long-scroll navigation.
5. Follow-up grouping is deterministic around date boundaries and timezone handling.
6. Activity retrieval is server-bounded/paginated before UI infinite loading is considered complete.
7. Existing CRM validation remains green at every exact implementation head.
8. Production deployment/readback is a separate authorized stage and is not implied by code completion.
