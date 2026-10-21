# Reliability work and evidence

- [x] T001 Verify canonical checkout, main/canonical divergence, current CI and live migration head.
- [x] T002 Correlate 500 and 57014 stacks; distinguish idle pool closes.
- [x] T003 Compare nonexecuting plans and bounded read-only execution samples.
- [x] T004 Read repository constitution/navigation/spec workflows and record patch plan.
- [ ] T010 Add materialized-scope migration and evaluation-count/semantic regression (FR-001, AC-001).
- [ ] T011 Run exact-head CI and full pgTAP/lint (AC-002).
- [ ] T012 Resolve staging drift safely and validate there before release (AC-002).
- [ ] T013 Gated release, migration/function/ACL readback and live acceptance (AC-002).
- [ ] T020 Independently verify Vladimir form browser, assets, required refs, endpoint, file constraints and server-side routing (FR-002/003).
- [ ] T021 Independently verify Kristina form with its own result (FR-002/003).
- [ ] T022 Correlate real intake, Storage and Telegram outbox without fake production data (AC-003).
- [ ] T030 Identify and update existing Health Watch; compare 24h windows and use absence-of-traffic-safe thresholds (FR-004).
- [ ] T040 Audit new SECURITY DEFINER, RLS/Storage, index workload, Today and real provider statuses (FR-005).
- [ ] T050 Observe 24 hours after confirmed rollout and close only with evidence (AC-004).
- [ ] T060 Converge against all acceptance criteria; preserve every unresolved gap.

Blockers observed: hosted staging head 0044 (client_ai_state absent); both requested form URLs show Site Unavailable in this Cloud Browser. Neither is a production outage diagnosis.
