# CRM retention

## Problem

The owner recorded a policy on 2026-09-23: an enquiry that never became a
project, and its reference files, are kept for 1825 days after the last
activity. `retention_enabled` stays false and no executor exists, so applying
the policy depends on someone remembering. Kristina's privacy notice
(kristinavishar.com/privacy/, 2026-10-12) says the same: a five-year rule,
removal by hand, deletion on request at any time.

Production on 2026-10-13: 86 enquiries, the oldest created 2026-08-15, no
active holds. The first enquiry the rule could reach is in August 2031.

## Phase 1 (this change): observable, never deletes

1. `crm_private.retention_enquiry_assessment(as_of)` classifies every enquiry.
   Exclusions, in order: `policy_inactive`, `activity_unknown`,
   `converted_to_project`, `has_session`, `client_has_commercial_records`
   (any project, session, invoice, payment request or deposit request),
   `retention_hold` (enquiry or client), `recent_activity`. NULL = candidate.
2. Last activity is client-wide: enquiries, client record, activity log,
   communication threads and messages, WhatsApp threads and messages, Gmail
   messages and snapshots, internal notes, follow-ups and file uploads.
3. `public.retention_runs` audits every dry run: policy version, cutoff,
   counts by exclusion, candidate ids/dates only. No names, contact data,
   text or file paths.
4. `service_run_retention_dry_run()` runs at most once per 20 hours from the
   existing CRM agent drain (no new cron). It logs
   `retention.dry_run_completed`, and `retention.candidates_found` when the
   count is above zero; the Worker logs the count (warn when > 0).
5. `run_retention_dry_run()` lets the owner run one on demand.
6. `system_settings_dry_run_until_executor`: settings cannot leave
   dry-run-only mode while no executor exists.

## Phase 2 (before the first candidate; tripwire: retention.candidates_found)

Executor, separate PR, enabled only after the owner reviews a dry run:

- operates only on ids present in a reviewed dry run no older than 24 hours,
  re-assessed inside the deleting transaction (row locks, same exclusions);
- bounded batches; Storage objects removed first by the Worker, row deletion
  only after every object of the enquiry is confirmed gone;
- an audit row per deleted enquiry (id, artist, cutoff, file count), never the
  deleted content;
- drops `system_settings_dry_run_until_executor` in the same migration;
- client records stay out of scope until a `client_retention_days` decision.

## Privacy notice

Phase 1 changes nothing a client sees: data is still removed by hand, which
the notice states. When phase 2 is enabled, the notice changes to "deleted
automatically no later than five years after our last contact".
