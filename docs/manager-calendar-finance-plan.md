# Manager calendar and invoicing: discovery and patch plan

Base branch: `agent/platform-telegram-self-service` (product integration branch;
its HEAD is also the tip of `release/private-crm-rc814-google-contacts-reconcile-20260920`).
Base SHA: `db81572972463919d76805f2aefd281eba5f4c33`.
Work branch: `feature/manager-calendar-finance`.

No production deploy, no production migration, no release branch is touched by
this change.

## What is already there

Scheduling is complete on the server and thin in the browser.

- `public.sessions` is the one appointment table. `admin/src/lib/appointment-api.ts`
  reads it and calls three RPCs: `schedule_appointment`, `set_appointment_status`,
  `reschedule_appointment`.
- `public.reschedule_appointment` (`supabase/migrations/0120_artist_scheduling_policy.sql:701`)
  already re-checks `manage_sessions`, refuses terminal appointments, takes an
  advisory lock on the artist schedule, runs `crm_private.assert_booking_slot_free`,
  bumps `calendar_version`, writes `activity_log` and enqueues the Google Calendar
  outbox job. Nothing about conflict detection or authorisation needs to move to
  the browser.
- `public.list_appointment_conflicts` returns the overlapping rows, so the
  interface can name the clash instead of only reporting one.
- `/appointments` (`admin/src/pages/AppointmentsPage.tsx`) renders one month grid
  plus a day list. Rescheduling exists only as two `datetime-local` inputs inside
  `AppointmentRow`. There is no week view and no direct manipulation.

Money is a ledger, not a document.

- `public.payment_requests` and the append-only `public.payment_transactions`
  (`supabase/migrations/0018_payment_requests_transactions.sql`) hold requested
  amounts and immutable settlement rows. Status is derived from the ledger by
  `crm_private.payment_request_expected_status`; a request whose net paid is
  non-zero cannot be cancelled.
- Deposits are payment requests with `purpose = 'deposit'`, created by
  `request_project_deposit` / `request_session_deposit` and settled either by
  Monzo reconciliation or `record_manual_payment`.
- There is no invoice, no line item and no credit note anywhere in the schema.

Authorisation is in the database.

- `crm_private.has_artist_capability(artist, capability)` and its public
  wrappers `can_view_artist_finance`, `can_manage_artist_finance`,
  `can_manage_artist_sessions` (`supabase/migrations/0015_artists_memberships.sql:465`).
- Finance tables grant `select` to `authenticated` behind
  `can_view_artist_finance(artist_id)` and have no insert/update/delete policy at
  all. Every write is a `security definer` RPC.
- `admin/src/lib/permissions.ts` mirrors this for the interface only, with
  `canAccess()` narrowing `viewFinance` / `manageFinance` / `manageIntegrations`
  to per-artist membership flags.

Vladimir and Kristina are two rows in `public.artists`. Separation is
`artist_id` plus `artist_memberships`, surfaced through `useArtistScope()`.

Time zone: every artist row carries `timezone` (`Europe/London` in fixtures and
in `control-plane-api.ts:216`). The calendar code currently uses the browser's
local zone through `new Date(...).getFullYear()` and friends.

## What this change adds

### 1. Manager calendar

Extends `/appointments`; no second calendar screen.

- `admin/src/lib/calendar-week.ts` - pure, zone-aware. Day boundaries and grid
  offsets are computed in the artist's IANA zone with `Intl.DateTimeFormat`
  rather than the browser's zone, so a drag across the March/October transition
  keeps the wall-clock time the operator dropped it on.
- `admin/src/components/WeekCalendarView.tsx` - day and week grid, pointer drag
  plus a keyboard path, with the dragged appointment rendered at the drop
  position until the server answers.
- `AppointmentsPage` gains a Month / Week / Day switch. Month stays exactly as
  it is.
- Drop calls `listAppointmentConflicts` first for a named clash, then
  `rescheduleAppointment`. On any refusal the optimistic position is discarded
  and the server row is shown again.
- Dragging is offered only when the viewer may manage that artist's sessions.
  `canAccess()` gains a `manageSessions` branch reading
  `ArtistMembership.can_manage_sessions`, mirroring `has_artist_capability`.
  No capability is added to any role.

### 2. Invoicing

One migration, `supabase/migrations/20260920120000_invoicing_core.sql`,
forward-only:

- `public.invoices`, `public.invoice_line_items`, `public.credit_notes`.
- `public.payment_requests.invoice_id` - a new nullable column. Nothing is
  renamed, nothing is dropped, and every existing deposit and payment keeps
  working with `invoice_id is null`.
- Amounts are derived, never stored twice:
  `crm_private.invoice_totals(invoice)` sums line items, settled credits from
  `payment_transactions` of the linked requests, and credit notes.
- Status is derived the same way (`draft`, `issued`, `partially_paid`, `paid`,
  `void`), with `overdue` computed at read time from `due_date` so no cron is
  needed.
- RLS: `select` to `authenticated` behind `can_view_artist_finance`. No write
  policy. Writes go through `security definer` RPCs that require
  `manage_finance` on the invoice's own artist: `create_invoice`,
  `set_invoice_line_item`, `remove_invoice_line_item`, `issue_invoice`,
  `void_invoice`, `attach_payment_request_to_invoice`,
  `record_invoice_payment`, `create_credit_note`, plus the reads
  `get_invoice`, `list_invoices`.
- A credit note never edits its invoice: it is its own numbered row with a
  reason, and it reduces outstanding through the totals function.

Interface: `/invoices`, `/invoices/:id`, an invoices panel on the project
screen, and a print-friendly document rendered from the same data with plain
CSS. No PDF library is added.

## Explicitly out of scope

Self-booking, a public client area, VAT and tax returns, a second payment
system, any third-party calendar service, and any change to Telegram, Gmail or
WhatsApp routing.
