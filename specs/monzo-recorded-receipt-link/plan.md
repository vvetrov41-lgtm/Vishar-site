# Plan / gates

Base: `agent/platform-telegram-self-service` at `5d1a99d7454f34ed7a2fc41ad30176e539910091`. Production database migration head observed `20261021090000` on 2026-10-27.

1. New `monzo_recorded_receipt_links` mapping table, no table grants to browser roles, RLS on, unique candidate and unique manual receipt.
2. `link_monzo_recorded_receipt` SECURITY DEFINER RPC: authorisation + verified bank event + immutable manual payment + invoice/artist/currency/timestamp gates, idempotency and activity log. Never insert/update `payment_transactions`.
3. Extend `list_monzo_reconciliation_candidates` with already-recorded options and evidence link state, preserving existing deposit matching.
4. Add RU/EN Payments selector with explicit confirmation, linking by verified transaction ID rather than client name; no silent selection.
5. Tests: migration ordering, pgTAP positive/negative, bank duplicate and cross-artist denial, UI selection, invoice totals before/after (no credit added).
6. Run full exact-head CI -> isolated staging -> protected DB deploy/CRM deploy -> production readback and acceptance. Release blocked if any gate fails.

This is separate from PR #1125 (session checkout UI), which does not depend on this migration.
