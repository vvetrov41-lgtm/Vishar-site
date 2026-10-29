# Release tasks
- [x] Diagnose production bank event, client, paid project and missing receipt.
- [x] Check neighbouring PRs #1125/#1126 and select separate bounded branch.
- [x] Author bank-to-legacy-project reconciliation RPC and finance UI.
- [x] Add rollback-only pgTAP regression tests.
- [ ] Pass exact-head database migration validation and full pgTAP.
- [ ] Pass CRM typecheck, Vitest and production build.
- [ ] Isolated staging with one synthetic project and verified event.
- [ ] Protected deployment, production migration + CRM readback.
- [ ] Authorized reconciliation of Quaid £150 and verify single provider credit,
      paid request, remaining £410 and no duplicate client messages.
