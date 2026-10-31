# Implementation and release plan

1. Reuse the already deployed `crm_private.enquiry_meta_attribution`, `lead_event_id` and existing Meta consent/CAPI flow; no second tracking pixel or submission event.
2. Create an RLS-protected artist-account timezone map, initially scoped to the owner-verified Vladimir account `2128002004809955` / `Africa/Cairo`.
3. Derive, validate and persist consented paid-social UTM IDs at Meta-attribution insert time, without extending the intake fingerprint.
4. Backfill only the pre-existing Meta-consented rows. Keep missing data null.
5. Add a private reconciliation view with original event UTC time, London date, IANA account date, CAPI outbox status, source provenance and event ID.
6. Verify pgTAP on the exact PR head in an aligned DB test environment. Inspect security advisors and migration ordering.
7. Only after review and release validation, deploy DB migration with backup/rollback plan and inspect read-only results. Compare daily Meta Insights using the account timezone and conversion-time attribution.
8. If an operator-facing report is requested, add a separate artist-authorized bounded read contract and GPT/MCP parity entry. Never expose the private view to general CRM clients.

No change to Meta account timezone, daily budget, campaign state, conversion optimisation or artist integrations.
