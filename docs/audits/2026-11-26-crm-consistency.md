# Vishar CRM — production consistency audit, 2026-11-26

## Evidence and scope

Read-only production Supabase catalog and aggregate queries (BEGIN READ ONLY / ROLLBACK), 26 November 2026, approximately 23:24 UTC. Repository target: `agent/platform-telegram-self-service` at `8b11a71c43594466c0ece5549e39daaf0143a7c2`. Exact GitHub commit and individual files verified; no full local checkout or ordered migration trace completed. Website main is a distinct branch and must not be treated as the CRM source. Live effective SQL definitions were read from pg_proc/pg_views; this is production evidence, not proof of source migration equivalence. No client identifiers, contact details, credentials or individual payment amounts are retained. No production mutations, provider sends, active security probes or deployment. No new application changes or test claims.

## Confirmed defect F1 — worked-time statistics

Severity: medium, high remediation priority because it affects business reporting.

- 17 completed tattoo sessions: 13 have confirmed visit outcomes (8 paid, 5 part-paid); 4 have no recorded outcome and remain unpaid. The 13 confirmed outcomes agree with session payment status and final price.
- Four confirmed outcomes differ from session planned duration. The four rows included in statistics_sessions total 19 recorded actual hours versus 21 scheduled hours; aggregate overstatement of 2 hours across these rows. This is not a finding of incorrect booking intervals.
- Production public.record_visit_outcome stores worked_minutes in visit_outcomes (body lines 380, 412, 421), updates price/payment_status (251, 312–315), and leaves sessions.duration_hours untouched.
- Production public.statistics_sessions projects sessions.duration_hours; crm_private.statistics_core body lines 63–70 chooses planned duration, then lines 186–193 sums that value for completed work. Upcoming/forecast branches use scheduled hours deliberately.
- Repository exact target admin/src/lib/statistics-api.ts calls get_statistics, and admin/src/pages/StatisticsPage.tsx lines 320–321 displays current.sessions.hours. Both web and GPT share the database statistics core according to the API module. Full GPT caller and ordered migration trace still required.
- Acceptance: completed attended work with confirmed positive worked_minutes uses that actual duration. When actual time is absent, explicitly distinguish historical scheduled fallback from confirmed actual time; do not fabricate actual minutes. Future estimates remain scheduled; consultation and no-show totals unchanged; preserve date windows, artist/finance scopes, inclusion exclusions, currency and existing response compatibility. Do not rewrite session duration/start/end or historical payments. Add synthetic tests covering 7h planned/5h actual, longer actual, missing/deferred outcomes, two artists, correction/replay, no-show/consultation, future forecast and prior/current windows. Determine latest effective migration and callers on exact CRM trunk, stage the additive migration and run full DB/CRM/Worker checks before requesting protected release. This is a patch plan, not a migration.

## Operational observations

- Four completed tattoo sessions have no outcome; five have partial payment. These require artist verification before recording receipts or changing statuses. No evidence that all nine are unpaid in reality.
- All recorded paid requests reconcile to succeeded transaction net totals: paid underfunded 0, fully funded non-paid (excluding cancelled) 0, cancelled with positive net 0. Manual receipt RPC checks finance authority; GPT wrapper additionally checks bound artist. Ledger trigger refreshes payment request status; paid deposit trigger queues confirmation; project-level deposit projection intentionally filters session-linked requests. Verify per-session/group allocation and UI readers in further testing.
- 26 synced calendar rows have version gap 1, exclusively completed/no-show. Confirmed rows all have gap 0 and an event ID. Effective session_is_calendar_eligible returns true only for confirmed, while terminal status transitions increment calendar_version without queueing projection changes. This is an observed status semantics discrepancy, not proof of Google calendar drift. One historical failed cancelled row has no event ID. No active failed sync observed. Verify desired terminal semantics and provider projection before changing anything.
- 355 succeeded / 13 dead outbox entries at snapshot; no pending/processing rows or expired leases. Recent dead: one Instagram send result unknown (24 Nov). Do not retry an unknown provider result automatically; reconcile evidence first. Other dead entries are historical or intentional cancellations. Scheduler heartbeat healthy at observation (age 241 seconds, stale false).
- Four missing outcome sessions need manual review; do not infer receipts, prices or worked minutes.

## Security observations (limited)

73 public tables have RLS enabled, 72 have FORCE RLS; zero direct anonymous SELECT/INSERT/UPDATE/DELETE grants. Nine public views are security_invoker and none anonymously selectable. Zero observed cross-artist/project/client inconsistencies in payment-request and visit-outcome joins; zero session/payment/project client-workspace mismatches. 30 sessions and 5 payment requests lack explicit client_artist_links; the effective client_artist_ids function intentionally derives scope from enquiries, projects, sessions and conversations as well as explicit links, so missing explicit link alone is not a security defect. Do not backfill automatically.

Public SECURITY DEFINER functions executable by anon: get_scheduler_heartbeat_status (timestamp/age/stale only) and self_service_signup_policy (open flag only), not client data. Authenticated security-definer endpoints require per-function authorization review; no broad conclusion from RLS or function counts. Supabase advisors report RLS-without-policy, mutable search_path, anonymous/authenticated security-definer execute and leaked-password-protection warnings; the response lacks object-level details. Independently inspect object-specific warnings, settings and intent before repair. Twenty public tables have no policies and none of those are directly selectable by authenticated users; deny-by-default can be intentional. One table not FORCE RLS requires scope review. No confirmed exploit established by this pass.

## Next work

1. Trace the final statistics_core migration and tests on the exact CRM trunk; implement F1 in isolated branch with regression tests and staging acceptance. No production SQL via MCP.
2. Review missing visit outcomes with artist records (no inferred payments). Reconcile unknown Instagram send read-only, without duplicate delivery.
3. Review effective permissions and provider routes, especially cross-artist denial tests, booking/Calendar/WhatsApp/Instagram/email, storage and grant/security-definer boundaries. Obtain full checkout and migration parity, test with synthetic fixtures.
4. Determine whether terminal calendar projection version should be separate or explicitly acknowledged, with tests for complete/no-show/cancel/reschedule; never blindly queue 26 historical events.
5. Shared engineering baseline was merged to website main, but the active CRM trunk has its own engineering rules and needs its own compatible skill onboarding. Preserve existing Spec Kit, branch and protected database release rules.

This is the initial bounded production audit, not a completed end-to-end security review. Cloudflare runtime, provider accounts, exact migration parity, UI e2e and live cross-role denial tests remain unverified. No production changes made.
