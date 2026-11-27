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
