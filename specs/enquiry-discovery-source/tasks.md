# Tasks: Enquiry discovery attribution

- [x] T001 Fresh-check canonical CRM base, open PRs, migration sequence, public booking architecture, and current Statistics implementation.
- [x] T002 Specify product behavior, compatibility, trust boundary, and acceptance criteria.
- [x] T003 Plan database, Worker, Statistics, tests, and rollout.
- [ ] T004 Add migration 0140 with nullable constrained `enquiries.discovery_source` and transactional booking-source intake persistence.
- [ ] T005 Add Worker validation and pass discovery attribution into durable enquiry intake.
- [ ] T006 Add the required discovery selector to the shared canonical public booking form.
- [ ] T007 Extend Statistics data projection and pure aggregation with a separate self-reported discovery breakdown.
- [ ] T008 Add localized Statistics UI and definitions without changing technical-source semantics.
- [ ] T009 Add/update pgTAP, Worker, Statistics API/pure/page tests and documentation.
- [ ] T010 Reconcile operator parity inventory; no new mutation/action is expected.
- [ ] T011 Run exact-head CI, fix failures, and converge against the spec.
- [ ] T012 Re-check canonical drift/mergeability and merge the proven head safely.
- [ ] T013 Verify post-merge canonical CI.
- [ ] T014 Fresh-check production Supabase/Cloudflare/Pages state and guarded release lineage.
- [ ] T015 Apply migration 0140, deploy the public booking/TattooAI Worker and CRM Pages through repo automation.
- [ ] T016 Perform production readback and read-only acceptance without creating fake customer/enquiry data.