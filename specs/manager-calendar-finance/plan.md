# Implementation Plan: Manager calendar and invoicing

## Target

- Canonical CRM base at planning preflight:
  `agent/platform-telegram-self-service` @ `db81572972463919d76805f2aefd281eba5f4c33`.
- Base moved during implementation and was merged in:
  `agent/platform-telegram-self-service` @ `0cec793a377a7b8e703f1e050f73e87468ffa534`.
- Bounded branch: `feature/manager-calendar-finance`.
- `main` carries the public site only. The CRM lives in `admin/` on the product
  integration branch, whose head is also the tip of the current
  `release/private-crm-rc*` branch. Selecting `main` as a base would have been
  wrong.
- Re-check canonical and branch ancestry immediately before merge and before any
  production mutation.

## What was already there

Stated because it decided the shape of the change.

- `public.reschedule_appointment` (`0120_artist_scheduling_policy.sql:701`)
  already re-checks `manage_sessions`, refuses terminal appointments, takes the
  artist schedule advisory lock, runs `crm_private.assert_booking_slot_free`,
  bumps `calendar_version`, writes `activity_log` and enqueues the calendar
  outbox job. Nothing about authorisation or conflict detection needed to move
  into the browser.
- `public.list_appointment_conflicts` returns the overlapping rows, so the
  interface can name a clash instead of reporting a generic failure.
- `public.payment_requests` and the append-only `public.payment_transactions`
  (`0018`) already model what was asked for and what settled, with status
  derived from the ledger by `crm_private.payment_request_expected_status`.
- `crm_private.has_artist_capability` and the public wrappers
  `can_view_artist_finance`, `can_manage_artist_finance`,
  `can_manage_artist_sessions` (`0015:465`) are the authorization primitives.
- No invoice, line item or credit note existed anywhere in the schema.

## Architecture

### Data

Two forward-only migrations.

`supabase/migrations/20260920120000_invoicing_core.sql`

- `public.invoice_status` enum: `draft`, `issued`, `partially_paid`, `paid`,
  `void`.
- `public.invoices`, `public.invoice_line_items`, `public.credit_notes`, each
  with `(id, artist_id)` unique so dependents can key on the pair and cross-artist
  links are impossible by construction.
- `invoice_line_items.line_total` is `generated always as stored`, so an inflated
  total in a request body has nowhere to land.
- `payment_requests.invoice_id`, `payment_method_code` and `external_reference`
  added as nullable columns with shape checks that accept null.
- `crm_private.invoice_totals(uuid)` derives currency, subtotal, discount, total,
  amount paid, amount credited and amount outstanding.
- `crm_private.invoice_status_for(public.invoices)` derives the status from a
  row, so a `BEFORE` trigger can judge the row it is about to write.
- Guards: invoice identity immutable; an issued invoice cannot be re-dated or
  re-priced; a void invoice is immutable; line items are draft-only; credit notes
  are append-only and capped at the unsettled remainder; a payment request cannot
  be moved between invoices; a ledger row cannot settle against a void invoice.
- Triggers recompute the cached `invoices.status` after any line item, credit
  note or settled transaction.
- RLS enabled and forced on all three tables, `select` granted to
  `authenticated` behind `can_view_artist_finance`, and deliberately no write
  policy or grant.

`supabase/migrations/20260920121000_invoicing_rpcs.sql`

Eleven `security definer` functions with fixed `search_path`, revoked from
`public, anon, service_role` and granted only to `authenticated`:
`get_invoice`, `list_invoices`, `create_invoice`, `set_invoice_line_item`,
`remove_invoice_line_item`, `set_invoice_details`, `issue_invoice`,
`void_invoice`, `attach_payment_request_to_invoice`, `record_invoice_payment`,
`create_credit_note`.

`list_invoices` is `security definer` because the totals live in `crm_private`,
which no API role may execute; it applies `can_view_artist_finance` per row, so
it returns exactly what the table's own policy would have returned.

`record_invoice_payment` creates its own immutable payment request for exactly
the amount and settles it, because a transaction has to belong to a request.
That is the existing system reused, not a second one.

### Calendar

- `admin/src/lib/calendar-week.ts`: pure, zone-aware. `zonedParts`,
  `zonedTimestamp` (two-pass, so a clock change resolves correctly),
  `startOfZonedDay`, `addZonedDays`, `startOfZonedWeek`, `buildWeekCalendar`,
  `rescheduleTarget`, `placeEntry` inputs. A drop resolves to a wall clock in
  the artist's zone; the length stays elapsed time.
- `admin/src/components/WeekCalendarView.tsx`: two layers. A fixed-height slot
  ruler owns the drop targets and keeps every column aligned with the hour
  gutter whatever is booked; an absolutely positioned event layer sits above it,
  placed by time and clipped to the visible hours, and stops taking pointer
  events mid-drag so a drop lands on the slot underneath.
- `AppointmentsPage` gains a Month/Week/Day switch, the optimistic hold and its
  rollback, and the conflict pre-check. The month grid and its read are
  untouched.
- `listAppointments` takes an optional window and bounds it by overlap
  (`end_at > from`, `start_at < to`), so an appointment that began before the
  window and is still running inside it is drawn.
- `canAccess` gains a `manageSessions` branch mirroring `has_artist_capability`;
  `canManageArtistSessions` narrows it to one artist.

### CRM interface

- `admin/src/lib/invoice-api.ts`: one named RPC per operation, ids not money.
- `/invoices` (list, status filter, per-currency outstanding), `/invoices/:id`
  (figures, line items, payments, credit notes, print), and
  `ProjectInvoicesPanel` on the project screen.
- The printable document is part of the invoice page, `display: none` on screen
  and revealed by `@media print`, so it is behind the same authorisation and
  there is no second URL.
- Navigation adds Invoices to the Money group behind `viewFinance`.

### Operator parity

No new GPT/MCP operation is introduced and no generic query surface is added.
The GPT action surface is unchanged by this feature.

## Deferred

Changing an appointment's duration by dragging a block's edge. The week grid
moves an appointment without resizing it; duration is edited through the
existing start/end fields on the appointment row, which already go through
`reschedule_appointment`. A resize handle needs its own conflict-preview
behaviour, its own touch target and its own keyboard equivalent, and none of
that is needed to answer "can this client come on Wednesday instead?". It is
deferred, not refused.

## Tests

- `admin/src/test/calendar-week.test.ts`: zone reading, Monday week start,
  wall-clock day arithmetic across the transition, the skipped 01:30, drop
  placement into BST, elapsed duration across the October transition, grid
  building, partial-day time off widening the grid.
- `admin/src/test/calendar-drag.test.tsx`: the move through the keyboard path
  and through synthetic drag events, the conflict pre-check ordering, rollback
  on refusal, the overlap-bounded window with an overnight booking, the slot
  ruler staying independent of bookings, and who is offered the drag.
- `admin/src/test/invoicing.test.tsx`: the figures as the server derived them,
  overdue, the printable document, draft-only pricing and details, payment
  including the over-payment and double-press refusals, deposit attachment,
  credit note with confirmation and its cap, void with confirmation, a void
  invoice offering nothing, per-currency totals, and the two permission tiers.
- `admin/src/test/permissions.test.ts`: `canManageArtistSessions` and the
  navigation entries.
- `supabase/tests/293_invoicing.sql`: schema surface, privileges, the GBP980 /
  GBP250 / GBP730 / paid path, replay, over-payment, over-credit, void refusals,
  the void-invoice payment path from both ends, cross-artist isolation, anon
  denial, and an untouched historical deposit.
- `supabase/tests/050_rls_roles.sql`: the eleven new RPCs in the callable
  allow-list and the three new tables in the forced-RLS list.

## Rollout

Code completion and production rollout are separate gates.

1. Exact-head PR CI on `feature/manager-calendar-finance`.
2. Fresh-check base drift and mergeability; merge only from the proven head.
3. Verify post-merge CI on the product integration branch.
4. Fresh-check the production Supabase migration head.
5. Apply the two migrations through the guarded database release workflow from
   an approved `release/private-crm-rc*` branch. Nothing in this branch applies
   them.
6. Deploy CRM Pages from the same approved release lineage.
7. Read back the production migration head and the deployed revision.
8. Read-only acceptance: open the week grid, move a real appointment and put it
   back, open an existing project's invoice panel. Do not create fake client or
   payment data.

## Migration safety

Both migrations are additive. Nothing is dropped, nothing is renamed, and no
existing row is written.

`payment_requests.invoice_id` is nullable with no default, so every deposit and
payment that exists today keeps `invoice_id is null`. `request_project_deposit`,
`request_session_deposit`, `record_manual_payment`, the Monzo reconciliation path
and `listProjectPaymentRequests` never mention the column. The two other new
columns are nullable with shape checks that accept null, so an insert written
before this change still satisfies them. pgTAP 293 pins this with a deposit
created the way the CRM creates one today.

## Rollback/recovery

Forward-only is the repository convention, so no `down` migration is committed.
If the layer had to be withdrawn before anything used it, the reverse is, in
order:

```sql
-- 1. The RPCs.
drop function if exists public.create_credit_note(uuid,uuid,numeric,text);
drop function if exists public.record_invoice_payment(uuid,uuid,numeric,timestamptz,text,text);
drop function if exists public.attach_payment_request_to_invoice(uuid,uuid);
drop function if exists public.void_invoice(uuid,text);
drop function if exists public.issue_invoice(uuid,date);
drop function if exists public.set_invoice_details(uuid,date,numeric,text);
drop function if exists public.remove_invoice_line_item(uuid);
drop function if exists public.set_invoice_line_item(uuid,text,numeric,numeric,uuid,uuid,integer);
drop function if exists public.create_invoice(uuid,uuid,date,text);
drop function if exists public.list_invoices(uuid,uuid,uuid,public.invoice_status,integer);
drop function if exists public.get_invoice(uuid);

-- 2. The triggers this change added to existing tables.
drop trigger if exists payment_transactions_refresh_invoice on public.payment_transactions;
drop trigger if exists payment_transactions_guard_invoice on public.payment_transactions;
drop trigger if exists payment_requests_invoice_link_guard on public.payment_requests;

-- 3. The link, then the tables.
alter table public.payment_requests drop constraint if exists payment_requests_invoice_artist_fkey;
alter table public.payment_requests drop column if exists invoice_id;
alter table public.payment_requests drop column if exists payment_method_code;
alter table public.payment_requests drop column if exists external_reference;
drop table if exists public.credit_notes;
drop table if exists public.invoice_line_items;
drop table if exists public.invoices;
drop type if exists public.invoice_status;
```

Step 3 destroys invoices, so it is only safe while none exists. Once an invoice
has been issued, the correct withdrawal is to stop offering the screens and
leave the tables in place: the documents are financial records.

The calendar half has no data of its own. Reverting it is reverting the frontend
commit; `reschedule_appointment` is unchanged by this feature.

## Backfill

Deliberately none, and not by omission.

A historical deposit cannot be attached to an invoice automatically, because
there is no invoice to attach it to - invoices did not exist. Inventing one per
historical deposit would create documents nobody issued and nobody sent, with
numbers in this year's sequence.

The path forward is per project and by hand, through the interface:

1. Open the project and raise an invoice.
2. Price it from the sessions actually worked.
3. Issue it.
4. Use **Count a deposit already taken** to attach the deposit the project
   already holds.

`attach_payment_request_to_invoice` is exactly that operation, and it refuses a
request belonging to another artist, client or project.

A bulk backfill, if ever wanted, needs its own migration, its own approval and a
dry run against a restored copy. It is not part of this change.
