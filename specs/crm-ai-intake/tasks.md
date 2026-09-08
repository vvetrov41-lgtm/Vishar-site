# Tasks: CRM AI intake
- [x] T001 Verify exact canonical checkout, relevant CI and production database.
- [x] T002 Finish live release/privacy/Gmail investigation and reconcile design.
- [x] T010 Add scoped jobs, lease/atomic draft RPCs and pgTAP denial/concurrency tests.
- [x] T020 Add strict extraction, router orchestration, safe booking trigger and recovery.
- [x] T021 Connect supported existing Gmail path with deterministic source identity.
- [x] T030 Add enquiry result/retry/draft UI and operator parity inventory.
- [ ] T040 Run behavioral tests, database tests and CRM validation; resolve failures.
- [ ] T050 Review requirements against implementation and exact-head CI.
- [ ] T060 Merge safely, deploy through protected workflows, read back and verify real acceptance.
- [x] T061 Publish accurate text-AI privacy disclosure before enabling processing. Images remain disabled. PR #742 merged to main.

Analysis before implementation: all functional/security requirements have a bounded implementation and validation path. High risks are stale staging schema (use full migration CI), client identity races (reuse workspace locks), privacy activation (gate until disclosure), Gmail source ambiguity (trace actual handler before connecting). No model-authorized mutations or unrelated work permitted.
