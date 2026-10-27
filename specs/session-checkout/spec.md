# Session checkout: amount due per tattoo session

## Problem (27 October 2026)
The diary stores the appointment, its deposit, invoice, price and payment status separately. A completed Charlie Sims session had `sessions.price = NULL` and `sessions.payment_status = unpaid` despite a paid £250 session deposit and a separate paid £730 invoice. The artist could not see £730 due from the calendar entry. Project-level £1,400 estimates must never be confused with this session's charge.

## Required behaviour
- In a tattoo-session entry, expose a finance-authorised, phone-friendly "Payment for this session" panel that can be opened directly from the calendar and project appointment.
- Show **confirmed session price**, the explicitly assigned **net settled deposit**, recognised **payments/credits on invoices exclusively linked to this session**, and **remaining amount due**. Do not derive the charge from an entire project's estimate.
- For sessions with no stored price, label any suggestion **estimate only**, and require an explicit confirmation via the existing authorised price RPC before calling the amount final or recording a payment.
- Project-wide or grouped/unallocated deposits are **not automatically assigned** to a session. Present a warning and require explicit allocation. Never subtract one deposit from multiple sessions.
- An invoice with lines for multiple sessions or without an unambiguous session link must never be allocated by guessing. Do not silently show a fully settled status in that case.
- Existing paid invoices take precedence over the stale `sessions.payment_status` field. Warn about ledger/status mismatches.
- Allow adjustments of the stored price using the existing authorised workflow.
- After the operator explicitly confirms money was received, record the exact amount with the existing invoice payment RPC, idempotency, and no electronic charge. If a new invoice is needed, create an invoice linked to that single session; recover safely from interrupted intermediate steps.
- Support RU and EN, GBP/currency formatting, loading/failure, keyboard use and narrow mobile screens.
- Restrict financial data and controls to the existing per-artist finance capabilities; do not broaden RLS, grants, service credentials or artist selection.
- Project totals and prior deposits remain intact. Session display must not change client-facing booking cards or delivery.

## Acceptance cases
1. Charlie Sims 27 Oct: 7h × £140 = £980 confirmed, paid deposit £250, paid single-session invoice £730 -> **£0 due**. Before £730 arrival: **£730 due**. Do not double-count a deposit linked to the invoice.
2. Missing price: no authoritative due, suggested 7h rate visible only as a suggestion until saved.
3. Two sessions sharing one project deposit: never subtract £250 from each session; flag unallocated deposit.
4. Separate sessions, distinct deposits and invoices: no cross-session leakage.
5. Mixed-session invoice: mark balance ambiguous and disable one-click collection.
6. Refunded deposits or failed transactions: use settled net, not request face value.
7. Overpayment, conflicting currencies, disabled staff access and idempotent retries fail closed.
8. Invoice action requires explicit human confirmation of funds actually received; never trigger a payment provider or client communication.
9. Exact-head CI, access/denial tests, staging synthetic payments, mobile calendar click-through, and protected production readback are required before release.

## Operator parity
Existing GPT/MCP functions cover setting the session price, creating/issuing invoices, recording payments, getting invoice finance and listing payment requests. Checkout's combined, ambiguity-aware balance is **planned** as a bounded read contract; there is no new generic finance endpoint. Browser confirmation of physical cash receipt is a UI step using existing authorised write actions.
