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

## Migration safety, rollback and backfill

Two migrations, both forward-only and both additive:

| File | What it adds |
| --- | --- |
| `supabase/migrations/20260920120000_invoicing_core.sql` | `public.invoice_status`; tables `invoices`, `invoice_line_items`, `credit_notes`; columns `payment_requests.invoice_id`, `payment_requests.payment_method_code`, `payment_requests.external_reference`; the totals and status derivation; the guards; RLS and `select` grants |
| `supabase/migrations/20260920121000_invoicing_rpcs.sql` | Eleven `security definer` RPCs and their grants |

Nothing is dropped and nothing is renamed. No existing row is written by either
migration.

### Why existing records keep working

`payment_requests.invoice_id` is nullable and has no default. Every deposit and
every payment that exists today keeps `invoice_id is null`, and every read and
workflow that touches those rows is unchanged - `request_project_deposit`,
`request_session_deposit`, `record_manual_payment`, the Monzo reconciliation
path and `listProjectPaymentRequests` never mention the column. pgTAP 293 pins
this with a deposit created the way the CRM creates one today.

The two new `payment_requests` columns are nullable with shape checks that
accept null, so an insert written before this change still satisfies them.

### Rollback

Forward-only is the repository's convention, so no `down` migration is
committed. If the layer had to be withdrawn before anything used it, the
reverse is, in order:

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

### Backfill

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

If a bulk backfill is ever wanted, it needs its own migration, its own approval
and a dry run against a restored copy - not this change.

### Production

Not applied anywhere. This branch carries the migration files only; applying
them is the `deploy-private-production-database` gate's job, from an approved
release branch, which this is not.
