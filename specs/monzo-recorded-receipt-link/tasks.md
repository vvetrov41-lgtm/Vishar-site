# Tasks
- [x] Read production bank candidate, manual invoice transaction and mismatch.
- [x] Identify hard guard: Monzo matcher only permits open deposits.
- [x] Author ledger-safe evidence link migration and Payments UI.
- [ ] Verify SQL syntax, function security and exact-head CI.
- [ ] Add rollback-only pgTAP covering candidate link, cross-artist, duplicate, unsupported/ignored status, mismatched amount/date and no new payment.
- [ ] Stage with synthetic accounts and check negative isolation.
- [ ] Merge under release invariants, guarded DB deploy and CRM deploy.
- [ ] Production readback: link Charlie £730 to existing invoice with no extra credit; confirm candidate is processed.
- [ ] Update GPT/MCP operator parity for link action after released.

Release: NOT YET DEPLOYED. No production bank or invoice association has been changed.
