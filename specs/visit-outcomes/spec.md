# Visit outcomes in Today

Status: implemented (migration `20261113180000_visit_outcomes.sql`).

## Problem
`auto_complete_due_tattoo_sessions` marks a tattoo session `completed` when its
slot ends. That proves only that time passed: not attendance, working time,
final price or money received. Consultations are never completed by the clock.

## Behaviour
- Today gets a section **Visit outcomes** (`pulse_items` kind `visit_outcome`,
  section `visit_outcomes`, rank 40, never urgent). One card per appointment.
- Tattoo/touch-up: card from the scheduled start (a 20-minute visit can be
  recorded at minute 20, without waiting or moving the calendar event).
  Consultation: after its scheduled end.
- Cards only for visits ending after `crm_private.visit_outcome_rollout.enabled_from`
  (the migration apply time). Older visits: voluntary, from the appointment page.
- A card leaves Today when confirmed, or until a chosen time when postponed.
- The `past_session_unresolved` conflict is hidden for a client who has a card.
- No Telegram/WhatsApp/email notification is created for a missing outcome.

## Data
- `public.visit_outcomes`: one row per session (state `deferred|confirmed`,
  outcome, work result, worked minutes, confirmed price, deposit applied,
  earlier receipts, money received through outcomes, balance, payment state,
  method, linked booking, follow-up, notes, version, who/when).
- `public.visit_outcome_revisions`: append-only, unique `operation_id`
  (idempotency), request hash, snapshot, side effects, stored result.
- Both tables: RLS forced, service-only policy, no browser grants. Reads/writes
  only via `get_visit_outcome_context`, `record_visit_outcome`,
  `defer_visit_outcome`, `list_visit_outcome_history`,
  `list_client_visit_outcomes`, which check per-artist `view_sessions`,
  `manage_sessions`, `view_finance`, `manage_finance`.
- Optimistic concurrency: `p_expected_version` must equal the stored version
  (`40001` otherwise).

## Actual work
- The scheduled duration is displayed as a hint, never filled into the actual
  work field. The artist must enter a real duration (1–1440 minutes) before
  confirming a held tattoo session. Early completion needs no calendar change.
- A new receipt defaults to **empty / £0**, never the outstanding balance.
  A price suggestion likewise does not auto-fill the final price.

## Money
Price, earlier deposit, money received now and balance are separate. The ledger
position mirrors `admin/src/lib/session-checkout.ts` (`crm_private.visit_session_finance`).
New money is recorded only through the existing invoice path
(`create_invoice` / `set_invoice_line_item` / `issue_invoice` / `record_invoice_payment`)
in the same transaction, with ids derived from the operation id. Ambiguous
ledgers (unallocated deposit, mixed invoices, …) block new receipts. "Paid"
without a price: confirm the price with `paid_outside_crm`, no payment created.
Money recorded here blocks changing the outcome to no-show/cancelled.

## Automations
No new rule, trigger-catalog event or outbox kind. `attended` → `completed`
(existing aftercare/check-in rules, once per consecutive block, unchanged).
`no_show`/`cancelled` → the scheduler cancels pending post-session jobs. A
correction back to `completed` withdraws overdue pending post-session jobs; a
cancelled job is never revived; a sent message is reported, never "recalled".

## Tests
`supabase/tests/383_visit_outcomes.sql` (83 assertions, scenarios 1–18),
`admin/src/test/visit-outcomes.test.tsx`.
