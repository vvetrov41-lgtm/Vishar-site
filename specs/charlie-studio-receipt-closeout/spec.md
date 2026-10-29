# Charlie Sims, 28 October 2026: studio-collected 30% closeout

## Facts verified in production
- First session 27 October, 7 hours: £980, `paid`.
- Deposit £250 and balance £730 already in immutable ledger, both paid.
- Second session 28 October, 3 hours: £420 at £140/h. Completed, but price was null and `payment_status=unpaid`.
- Artist confirms client paid £420 directly to Label Tattoo Private, in satisfaction of studio's **30% share of the entire £1,400 two-session project**. Artist's £980 receipts represent the other 70%; no studio/artist transfer is outstanding.
- A distinct client-facing-accounting invoice `INV-2026-00002` was recorded, not sent: £420 paid, method `studio_direct`, with explicit notes that the money is held by the studio and not the artist's bank.

## Bounded correction
The production-specific migration corrects only the 28 October session price to £420 and its payment status to `paid`. It does not create payments, requests, invoices, bank events, outbound messages or customers.

The migration fails closed on drift of the exact session identity, first-session accounting, invoice and studio-held receipt, single invoice line, single transaction, two-session project, 70/30 split, and total project receipts. It is idempotent and skips absent production records on CI/staging (no fake client data).

## Acceptance
1. All CI exact-head checks, migration reset/full pgTAP, release gates, production migration dry-run.
2. Production canonical release SHA and migration head readback.
3. Both Charlie sessions show `completed` and `paid`, prices £980 and £420.
4. First artist receipts stay £980; second studio receipt stays £420; exactly 3 payment requests and 3 succeeded credits; client outstanding £0.
5. No new financial ledger entry, duplicate studio/artist transfer or customer outbound notification from session correction.
