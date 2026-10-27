# Implementation plan

Target baseline: `vvetrov41-lgtm/Vishar-site` `agent/platform-telegram-self-service`, SHA `5d1a99d7454f34ed7a2fc41ad30176e539910091` at 2026-10-27.

## Increment A: contained CRM UI
- Build a pure, testable balance reducer using existing `sessions_finance`, `payment_requests`, `payment_transactions` and `get_invoice` reads.
- Refuse to infer price or ownership of shared deposits and multi-session invoices. Render a visible unknown/ambiguous state instead of a plausible but wrong amount.
- Lazy-load per-session finance through existing scoped browser API only when the operator opens the checkout panel, not for the whole calendar grid.
- Embed in month-selected-day appointment row and project appointment row; link a loaded invoice to its existing invoice detail UI.
- Allow confirmed session-price updates via existing `setAppointmentPrice`, and use existing invoice payment RPC for confirmed receipts with exact amount/idempotency; never claim provider capture.
- Regression-test session attribution, refunds, mixed invoices, missing price, currency mismatch and stale session status.

## Increment B: persistent financial reconciliation
- Investigate final effective SQL for invoice/deposit allocation and `sessions.payment_status` before adding any migration; no direct production DDL.
- Add a bounded server read projection for authoritative per-session checkout if browser aggregation is too ambiguous or costly; preserve per-artist RLS/role checks and GPT operator parity.
- Introduce safe session-level settlement workflow for any cases not covered by single-session invoices, with uniqueness/idempotency and rollback.
- Add pgTAP and owner/manager/other-artist denial tests, performance limits, ledger consistency invariants.
- Test complete mobile end-of-session checkout with synthetic staging transactions.

## Release gates
Draft PR and exact-head CI -> staging with synthetic data -> independent mobile browser checks -> explicit merge approval -> private CRM-only guarded production workflow -> readback of deployed SHA, payment balances and access isolation. No production migration or live client mutation during development. Existing public booking/Telegram/Meta flows must not be touched.
