# Tasks
- [x] Confirm verified Resend domain and existing Cloudflare forwarding.
- [x] Locate Gmail worker and separate cover-up guide PR #1359.
- [x] Validate alias read normalization with exact-head CI (4f8eb25f6bfac74134ee85cce6c7a183d428970e; Gmail, static and CRM checks passed).
- [ ] Trace metadata snapshot/discovery and effective database definitions/grants; reconcile with operator parity.
- [ ] Implement durable provider selection, receipt/uncertain-send reconciliation and outbound history.
- [x] Implement isolated test-only Resend request adapter and mock tests (Gmail and Static CI passed on 0cd65ecb73d2b1d5e3573a96d06b9fdeb91c2c34; full CRM CI still pending at inspection).
- [ ] Configure domain-scoped sending-only key securely, wire controlled test only after durable receipt path exists.
- [ ] Verify privacy notice, free limits, delivery failures, thread and cross-artist denial behavior.
- [ ] Controlled test to owner and actual reply verification; no real clients.
- [ ] Guarded production activation and post-release verification; disable monitoring only after all acceptance criteria pass.
- [x] Implement inert signed webhook verification and mock denial tests (Gmail CI passed; full Worker CI requires redirect compatibility fix).

- [x] Correct Worker redirect incompatibility; reject 3xx without following redirects (new head CI pending).

- [x] Extend domain alias recognition to metadata snapshot, complete discovery and background reply capture; denial tests added. Exact-head CI pending. Gmail SENT evidence still requires Gmail SENT label; external-provider outbound evidence requires durable Resend receipt.

- [x] Confirm existing secret binding and owner-approved shared credential strategy; adapter updated. No new API key required; new head CI pending.

- [x] Inspect live email/outbox constraints read-only and draft isolated private receipt/event ledger SQL under specs (not an executable migration; no production schema changes). Atomic reservation, legacy claim/ack guards and migration validation remain open.
- [x] Exact-head c156a80d286dc76a8ade33a6c4528e11a91af4d0 passed all three CI workflows. Inbound Gmail self-send test observed SENT only; forwarding still unverified by independent sender.

- [x] Generate and test actual ledger migration with pinned Supabase CLI in isolated CI run 46122997607; all four checks passed. Promote verified SQL to canonical migration, no worker dispatch enabled; new head CI pending.

- [x] Wire owner-only test dispatch to reservation and receipt RPC contract; add queue mock tests. Draft SQL excludes reserved rows from legacy Gmail claims and rejects legacy acknowledgements. Live legacy function hashes matched base manifest before editing. Candidate migration and manifest must pass isolated CI before promotion. No production flags enabled; owner client record absent in live DB.
