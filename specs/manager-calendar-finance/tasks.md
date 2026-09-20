# Tasks: Manager calendar and invoicing

## Discovery and design

- [x] T001 Fresh-check the canonical CRM base, release branches, open PRs and
      migration sequence; establish that the CRM lives on the product
      integration branch rather than `main`.
- [x] T002 Trace the existing scheduling RPCs, payment ledger, capability
      helpers and RLS conventions before designing anything.
- [x] T003 Specify behaviour, trust boundaries, non-goals and acceptance
      criteria.
- [x] T004 Plan the data model, calendar layers, interface, tests and rollout.

## Calendar

- [x] T005 Add zone-aware grid arithmetic as pure functions in
      `admin/src/lib/calendar-week.ts`.
- [x] T006 Add `WeekCalendarView` with a fixed-height slot ruler owning the drop
      targets and a time-positioned event layer above it.
- [x] T007 Extend `AppointmentsPage` with the Month/Week/Day switch, the
      optimistic hold and its rollback, and the conflict pre-check; leave the
      month grid and its read unchanged.
- [x] T008 Bound windowed appointment reads by interval overlap.
- [x] T009 Add the `manageSessions` branch to `canAccess` and
      `canManageArtistSessions` for the per-artist narrowing.

## Invoicing data

- [x] T010 Add `20260920120000_invoicing_core.sql`: the three tables, the
      nullable ledger link, the derivation functions, the guards, the triggers
      and the read-only RLS.
- [x] T011 Add `20260920121000_invoicing_rpcs.sql`: the eleven `security
      definer` writes and reads with their grants.
- [x] T012 Close the void-invoice payment path at both ends - the ledger trigger
      and the `void_invoice` precondition.

## Invoicing interface

- [x] T013 Add `invoice-api.ts` and register it on the session API.
- [x] T014 Add `/invoices`, `/invoices/:id` and the project panel, with the
      client-side refusals for over-payment, over-crediting, negative amounts
      and a double-pressed payment button.
- [x] T015 Add the printable invoice and credit-note document behind the same
      authorisation, with no PDF dependency.
- [x] T016 Add the navigation entry behind `viewFinance` and the localized copy
      in both interface languages.

## Verification

- [x] T017 Add `supabase/tests/293_invoicing.sql` and register the new RPCs and
      tables in `050_rls_roles.sql`.
- [x] T018 Add the calendar, drag and invoicing frontend test suites.
- [x] T019 Run typecheck, the full CRM suite, the production build, the artifact
      scan and the secret scan locally.
- [x] T020 Apply every migration in order on a throwaway PostgreSQL 16 cluster
      and run the whole pgTAP suite against it.
- [x] T021 Address the automated review: interval overlap, the two-layer grid,
      partial-day time off, per-currency totals, and the void-invoice payment
      path.
- [x] T022 Verify exact-head CI on the pushed head, including
      `supabase db reset`, `supabase test db` and `supabase db lint`, which
      cannot run in the agent environment.
- [x] T023 Move the durable feature intent into `specs/manager-calendar-finance/`
      and remove the superseded plan document.

## Remaining

- [x] T024 Independent full-diff review of PR #818, including RLS/IDOR,
      idempotency and invoice-wide payment ceilings; repair the findings.
- [x] T025 Record every new invoicing operator action explicitly in GPT/MCP
      parity as a bounded gap rather than silently changing the inventory.
- [ ] T026 Re-check base drift and mergeability, then merge the proven head.
- [ ] T027 Verify post-merge CI on the product integration branch.
- [ ] T028 Fresh-check the production Supabase migration head, then apply the
      two migrations through the guarded database release workflow from an
      approved release branch.
- [ ] T029 Deploy CRM Pages from the same approved release lineage and read back
      the deployed revision and migration head.
- [ ] T030 Read-only production acceptance without creating fake client or
      payment data.

Staging is intentionally not part of this rollout. Pointer/print behaviour is
covered by the existing keyboard/synthetic interaction tests and print CSS; no
staging environment is required before merge.

## Deferred

- [ ] T032 Duration editing by dragging a block's edge. Needs its own
      conflict-preview behaviour, touch target and keyboard equivalent; duration
      is edited today through the appointment row's start/end fields.
