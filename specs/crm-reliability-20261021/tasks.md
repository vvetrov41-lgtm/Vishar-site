# Reliability work and evidence

- [x] T001 Verify canonical checkout, main/canonical divergence, current CI and live migration head.
- [x] T002 Correlate 500 and 57014 stacks; distinguish idle pool closes.
- [x] T003 Compare nonexecuting plans and bounded read-only execution samples.
- [x] T004 Read repository constitution/navigation/spec workflows and record patch plan.
- [x] T010 Add materialized-scope migration and evaluation-count/semantic regression (FR-001, AC-001).
- [x] T011 Run exact-head CI and full pgTAP/lint (AC-002).
- [ ] T012 Resolve staging drift safely and validate there before release (AC-002).
- [x] T013 Gated release, migration/function/ACL readback and live acceptance (AC-002).
- [ ] T020 Independently verify Vladimir form browser, assets, required refs, endpoint, file constraints and server-side routing (FR-002/003).
- [ ] T021 Independently verify Kristina form with its own result (FR-002/003).
- [x] T022 Correlate real intake, Storage and Telegram outbox without fake production data (AC-003).
- [x] T030 Identify and update existing Health Watch; compare 24h windows and use absence-of-traffic-safe thresholds (FR-004).
- [ ] T040 Audit new SECURITY DEFINER, RLS/Storage, index workload, Today and real provider statuses (FR-005).
- [ ] T050 Observe 24 hours after confirmed rollout and close only with evidence (AC-004).
- [ ] T060 Converge against all acceptance criteria; preserve every unresolved gap.

Blockers observed: hosted staging head 0044 (client_ai_state absent); both requested form URLs show Site Unavailable in this Cloud Browser. Neither is a production outage diagnosis.

## Production checkpoint, 2026-10-21

- PR #1118 merged; exact-head CI 93377401d7a93ea07af4e0f1e008a21f6b13a597 green. PR #1120 merged after combined exact-head CI f767b1e28b0d33513639b8cb009bdf79ff8946bc green.
- Release a9e060db6f6c2351e5907188a58ac9ffd6a52ca6 passed all five required exact-SHA workflows. Database-only workflow run 39566705751 passed clean no-seed Supabase, full pgTAP/lint, sole-pending-migration guard, remote dry-run, apply and post-apply dry-run.
- Production apply completed 2026-10-21T08:09:17Z. Readback at 08:09:55Z: migration head 20261021074511, MATERIALIZED scope, SECURITY DEFINER, fixed search_path, private report ACL intact. Read-only SELECT EXPLAIN ANALYZE after deploy: 1864.519ms (original baseline 6191.402ms).
- Validation environment distinction: clean isolated Supabase stacks in CI/release validated the exact schema/patch. Retained hosted staging gwaliusblwrzisrwnsvs remains at 0044 and was not blindly upgraded. T012's hosted staging upgrade remains unresolved; do not report it completed.
- PR #1121 merged as fffc394ab8c9598ddbe9fafa3b70bcc9b947eee3. Its exact head a9dde20c11d05c5d3843e21b1108dabc80a43b9a passed browser, static and full CRM/DB CI. Post-merge validation is a separate check.
- Browser workflow 39566086888: Kristina SURFACE_PASS; Vladimir SURFACE_PASS_WITH_WARNINGS solely for optional Cloudflare Insights beacon. All production write methods were blocked, no form was filled/submitted/uploaded. Full step transitions, file-size/server validation are not proved by this surface check.
- Independent Kristina source d1a14299de043f727d56101a83d9d029afd9c677 (kisa) has green Site quality CI 38483257132 including iPhone/desktop booking scenarios. Its JS requires at least one design reference and caps prepared files at 4 MiB, 3 per category.
- Existing legitimate 48h intake evidence, independently per artist: Vladimir 1 complete correctly routed enquiry, 1 ready file present in crm-files, Telegram succeeded; Kristina 1 complete correctly routed enquiry, 4 ready files present, Telegram succeeded.
- Existing Health Watch prompt updated with separate form verdicts, same-RPC thresholds, parsed SQLSTATE, 24h comparison, heartbeat/outbox/intake/Storage checks, no-traffic-safe semantics and idle pool closure distinction. No new service cron.
- 24h read-only acceptance scheduled for 2026-10-22T08:10:40Z. Window begins at actual deploy 08:09:17Z; never substitute pre-deploy stability. Last immediate health read: heartbeat age 50s, new failed/dead outbox 0; natural next hourly report still pending at that read.
- P2 baseline: security/performance advisors collected separately from incidents. Reviewed recent client/privacy function ACL/search_path and authorization call paths. Kristina's scheduled provider health at 07:00 reports AVAILABLE but templates UNKNOWN / whatsapp_template_api_unavailable_for_account and cards disabled; no independent direct Meta API acceptance. Today statistics are cumulative, not a browser critical-path acceptance.
- Automatic review refused the legacy production POST contract probe because synthetic data might persist. It was not retried or bypassed; replaced by read-only browser inspection and existing legitimate delivery evidence.

Convergence: NOT CONVERGED. Core timeout fix is deployed/read back; 24h observation, complete form regression coverage, hosted staging reconciliation and remaining P2 checks are still open. No user-only blocker identified.
