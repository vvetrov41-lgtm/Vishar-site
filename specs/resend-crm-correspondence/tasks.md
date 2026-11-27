# Tasks
- [x] Confirm verified Resend domain and existing Cloudflare forwarding.
- [x] Locate Gmail worker and separate cover-up guide PR #1359.
- [x] Validate alias read normalization with exact-head CI (4f8eb25f6bfac74134ee85cce6c7a183d428970e; Gmail, static and CRM checks passed).
- [ ] Trace metadata snapshot/discovery and effective database definitions/grants; reconcile with operator parity.
- [ ] Implement durable provider selection, receipt/uncertain-send reconciliation and outbound history.
- [x] Implement isolated test-only Resend request adapter and mock tests (new head CI pending).\n- [ ] Configure domain-scoped sending-only key securely, wire controlled test only after durable receipt path exists.
- [ ] Verify privacy notice, free limits, delivery failures, thread and cross-artist denial behavior.
- [ ] Controlled test to owner and actual reply verification; no real clients.
- [ ] Guarded production activation and post-release verification; disable monitoring only after all acceptance criteria pass.
