# Feature Specification: Manager calendar and invoicing

## Status

- Feature: `manager-calendar-finance`
- State: Implemented, awaiting review and manual acceptance
- Owner/workstream: Vishar CRM
- Related PRs/issues: PR #818 on `feature/manager-calendar-finance`

## Problem

Two gaps, one in each half of the operator's day.

The calendar shows a month grid and a day list. Moving an appointment means
opening a row and retyping two `datetime-local` values, which is the wrong
gesture for the question "can this client come on Wednesday instead?" - the
operator has to hold the week in their head because the screen will not show it.

Money is a ledger without documents. `payment_requests` and the append-only
`payment_transactions` record what was asked for and what settled, and deposits
ride on them, but there is no invoice, no line item and no credit note anywhere
in the schema. A client who asks "what am I actually paying for?" cannot be sent
an answer, and a quoted figure that turns out wrong can only be corrected by
editing or deleting the record of what was quoted.

## Goals

- Show the diary as a week and as a day, in the artist's own time zone.
- Let a manager move an appointment by dragging it, with the server still
  deciding whether the move is allowed.
- Give the CRM an invoice with line items, payments and credit notes, layered
  over the payment ledger that already exists.
- Keep every deposit and payment taken before this feature working untouched.
- Produce a printable invoice and credit note without adding a PDF dependency.

## Non-goals

- Self-booking and any public client-facing booking or payment surface.
- A public client area or portal.
- VAT, tax periods, nominal ledgers or any bookkeeping beyond what the product
  already does.
- A second payment system. Money still moves only through
  `payment_transactions`.
- A third-party calendar service, or a second calendar screen beside the
  existing one.
- Changing Telegram, Gmail, WhatsApp or enquiry-form routing.
- Backfilling historical deposits onto invented invoices.

## Actors and scope

- User/actor: authenticated CRM staff. The calendar's drag affordance is for
  whoever may manage a given artist's sessions; the invoice write controls are
  for whoever may manage that artist's finance.
- Artist/workspace scope: every record stays scoped by `artist_id`. Vladimir and
  Kristina remain separated by `artist_memberships`, and a membership on one
  gives nothing on the other.
- Environments affected: CRM Pages and Supabase. No Worker, no public site, no
  provider integration.

## User scenarios

### Scenario 1: Moving an appointment

Given a manager viewing the week, when they drag a client's session from Monday
onto Wednesday at 13:00, then the server checks the slot and the appointment is
at the new time after a reload.

### Scenario 2: A slot that is taken

Given the same drag onto a time another appointment occupies, when the server
reports the clash, then the appointment does not move, the block returns to
where it was, and the message names the time that is taken.

### Scenario 3: Clocks changing

Given a session at 10:00 GMT in March, when a manager drops it on a date after
British Summer Time begins, then it reads 10:00 on the new date, and a
seven-hour session is still seven hours long.

### Scenario 4: Someone else's artist

Given a manager whose membership covers Kristina only, when they open a week
containing a Vladimir booking, then they can read it and are offered no way to
move it.

### Scenario 5: Invoicing a project

Given a project with sessions worked, when the operator raises an invoice,
prices it at seven hours at GBP140, issues it, and counts the GBP250 deposit the
project already holds, then the invoice reads GBP980 total, GBP250 paid and
GBP730 outstanding, and becomes `paid` once the balance is settled.

### Scenario 6: Correcting an issued invoice

Given an issued GBP980 invoice, when the operator issues a GBP140 credit note
with a reason, then the invoice still shows GBP980 as issued and GBP840 as the
corrected amount owed, and the credit note carries its own number and cannot be
edited afterwards.

### Scenario 7: An invoice raised in error

Given an issued invoice with nothing settled and no open payment request, when
the operator voids it with a reason, then it can never again be edited, issued,
credited or paid.

## Functional requirements

### Calendar

- FR-001: `/appointments` MUST offer Month, Week and Day views. The existing
  month grid MUST keep its current behaviour.
- FR-002: Week and day grids MUST compute day boundaries, entry placement and
  drop times in the artist's IANA time zone, not the browser's.
- FR-003: A drag MUST preserve elapsed duration, and a drop MUST land on the
  wall-clock time the operator chose.
- FR-004: Every drag MUST have an equivalent keyboard path.
- FR-005: A drop MUST call the existing `reschedule_appointment` RPC and MUST
  NOT create a second appointment.
- FR-006: The interface MUST ask `list_appointment_conflicts` before asking for
  the move, so a clash can be named rather than reported generically.
- FR-007: The moved block MUST sit at the dropped position until the server
  answers and MUST return to the server's position on any refusal.
- FR-008: A second move MUST be ignored while one is outstanding.
- FR-009: Reads that bound a window MUST bound it by overlap, so an appointment
  that started earlier and is still running inside the window is drawn.
- FR-010: Changing an appointment's duration stays where it already is - the
  start/end fields on the appointment row. The week grid moves an appointment
  without resizing it.
- FR-011: No client notification is sent by a move. The existing calendar outbox
  job is the only side effect, exactly as before.

### Invoicing

- FR-020: An invoice MUST belong to one artist, one client and one project, and
  MUST carry a human-readable number, currency, status, issue date, optional due
  date and notes.
- FR-021: A line item MUST carry a description, quantity, unit price and a total
  the database computes, and MAY cite a session on the invoice's project.
- FR-022: Line items MUST be editable only while the invoice is a draft.
- FR-023: Subtotal, total, amount paid, amount credited and amount outstanding
  MUST be derived from line items, settled transactions and credit notes on
  every read, never stored independently.
- FR-024: Status MUST be one of `draft`, `issued`, `partially_paid`, `paid`,
  `void`, derived from the invoice's lifecycle markers and the ledger.
- FR-025: Overdue MUST be computed at read time from the due date in the
  artist's time zone, without a scheduled job.
- FR-026: An invoice MUST be settled through the existing payment ledger. A
  payment request already taken - a deposit - MUST be attachable to an invoice
  so it counts without being re-entered.
- FR-027: Recording a payment MUST be idempotent per attempt and MUST be capped
  at the outstanding balance.
- FR-028: A credit note MUST be a separate numbered, immutable record with a
  reason, MUST reference its invoice, MUST NOT exceed the unsettled remainder,
  and MUST NOT edit or delete the invoice it corrects.
- FR-029: Void MUST be refused for an invoice with settled money or an open
  payment request, and MUST be terminal once applied.
- FR-030: The CRM MUST offer invoices inside the project screen, as a filterable
  list, and as one invoice's own screen.
- FR-031: A printable invoice and credit note MUST be produced from the same
  authorised data, with no PDF library added.
- FR-032: Outstanding totals across a list MUST NOT add different currencies
  together.

### Permissions

- FR-040: Reading invoices follows `view_finance` on the invoice's artist.
- FR-041: Every invoice, payment and credit-note write follows `manage_finance`
  on that artist.
- FR-042: Moving an appointment follows `manage_sessions` on that appointment's
  artist.
- FR-043: No role gains a capability. The interface narrows what it offers to
  what the database would already allow.

## Security and trust requirements

- SR-001: The browser MUST NOT be able to choose the artist, client, project or
  amount of anything. Every write RPC re-derives them from the record named.
- SR-002: The three invoicing tables MUST have RLS enabled and forced, `select`
  granted to `authenticated` behind `can_view_artist_finance`, and no insert,
  update or delete policy or grant at all.
- SR-003: Every write MUST be a `security definer` function with a fixed
  `search_path` that calls `require_artist_access(..., 'manage_finance')` on the
  artist it resolved itself.
- SR-004: Changing an id in a URL MUST NOT open another artist's invoice.
- SR-005: A payment MUST NOT be recordable against another artist's, client's or
  project's invoice, and a payment request MUST NOT be movable between invoices
  once attached.
- SR-006: A void invoice MUST NOT be able to acquire money by any route,
  including a provider payment arriving on a request attached while it was still
  open.
- SR-007: Negative and zero amounts MUST be refused by the database, not only by
  the browser.
- SR-008: Recorded payment method and external reference are operator-entered
  descriptive metadata. They MUST be shape-constrained and MUST NOT carry a
  credential, a full card number or an account number.
- SR-009: Financial documents MUST NOT be reachable anonymously. The printable
  document lives behind the same authorisation as the screen; there is no second
  URL.
- SR-010: The browser's permission mirror is an affordance filter, never the
  boundary. `reschedule_appointment` and every finance RPC refuse regardless of
  what the interface offered.

## Failure and recovery behavior

- A refused move leaves the appointment where the server says it is and says why.
- A refused payment or credit note leaves the invoice showing the server's
  figures rather than an optimistic guess.
- A repeated payment request with the same idempotency key replays instead of
  charging twice; a fresh key above the outstanding balance is refused outright.
- An invoice whose line items change while it is a draft has its status
  recomputed by trigger, so a cached status can never disagree with the ledger.
- A failed deployment is fail-closed and is not complete until readback and
  acceptance succeed.

## Data and retention expectations

Invoices, line items and credit notes are artist-scoped financial records and
follow the existing artist scope, RLS and retention behaviour. Credit notes and
payment transactions are append-only; an issued invoice is never rewritten to
correct a figure. `payment_requests.invoice_id` is nullable and stays null on
every record created before this feature.

## Acceptance criteria

### Met

- AC-001: Month, week and day views exist on one screen; the month grid is
  unchanged.
- AC-002: A week drag moves an appointment through `reschedule_appointment` and
  the new time survives a reload.
- AC-003: A conflict leaves the appointment in place and names the clashing time.
- AC-004: A server refusal rolls the block back to its stored position.
- AC-005: A GMT session dropped into BST keeps its wall-clock time, and a
  seven-hour session stays seven hours across the October transition.
- AC-006: A manager without `can_manage_sessions` on an artist, and a manager
  holding only the other artist, are offered no drag.
- AC-007: Seven hours at GBP140 totals GBP980; a GBP250 deposit leaves GBP730;
  full settlement reads `paid`.
- AC-008: A GBP140 credit note corrects a GBP980 invoice to GBP840 while the
  original total stays visible.
- AC-009: Over-payment, over-crediting, negative amounts, a second press of a
  payment button, and a credit note on a draft are each refused.
- AC-010: An invoice with settled money or an open request cannot be voided; a
  void invoice cannot be issued, paid, credited or edited.
- AC-011: A void invoice cannot acquire money even when a request attached while
  open later settles.
- AC-012: Changing an invoice id in the URL does not open another artist's
  invoice; a membership without finance access sees none.
- AC-013: Existing deposits and payments keep `invoice_id` null and behave as
  before.
- AC-014: The printable document carries artist, client, invoice number, dates,
  line items, totals, payments, credit notes, balance and currency.
- AC-015: Outstanding totals are reported per currency.
- AC-016: Exact-head CI is green: `supabase db reset`, `supabase test db`,
  `supabase db lint`, CRM typecheck/tests/build, artifact scan, secret scan.

### Outstanding

- AC-017: Human review of PR #818.
- AC-018: Manual acceptance in a real browser - a pointer drag across days, the
  conflict path, and the print dialog's rendering of the invoice document.
- AC-019: Staging verification, then production migration and deploy through the
  guarded database and CRM release gates, with readback.

## Dependencies and constraints

- The existing payment ledger: `payment_requests`, `payment_transactions` and
  their guards in `0018`.
- The existing scheduling RPCs and artist schedule lock in `0120`.
- `crm_private.has_artist_capability` and its public wrappers in `0015`.
- Ordered forward-only Supabase migrations.
- No new runtime dependency in `admin/package.json`.

## Architecture

- `admin/src/lib/calendar-week.ts` holds the zone-aware grid arithmetic as pure
  functions; `WeekCalendarView.tsx` renders two layers - a fixed-height slot
  ruler that owns the drop targets, and an event layer positioned by time.
- `public.invoices`, `public.invoice_line_items` and `public.credit_notes` sit
  above the ledger. `payment_requests.invoice_id` is the only link, and it is
  nullable.
- `crm_private.invoice_totals` derives every figure; `invoice_status_for`
  derives the status from `issued_at`, `voided_at` and those figures; triggers
  keep the cached `invoices.status` honest after any line item, credit note or
  settled transaction.
- Eleven `security definer` RPCs are the whole write surface.

## Open questions

- None blocking. Duration editing by dragging a block's edge is deferred, not
  refused - see the plan's deferred section.

## Requirement changes

- 2026-09-20: `set_invoice_details` was added after the first pass, so a draft
  can carry a due date, discount and note rather than only line items.
- 2026-09-20: Five findings from an automated review were folded in - interval
  overlap on windowed reads, the two-layer grid, partial-day time off widening
  the grid, per-currency totals, and the void-invoice payment path in SR-006.
