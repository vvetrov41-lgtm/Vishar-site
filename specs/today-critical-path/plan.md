# Implementation plan

Independent deduplicated Today resource hooks and subsection loading, two-minute stale snapshots with short pulse/schedule freshness, artist readiness gating and privacy-safe navigation/request/content timing. Replace repeated per-client communication/ack scans with one materialized artist-scoped batch while retaining canonical booking, stage, SLA and conflict helpers. Compare JSON with production data read-only before changing DB. Add an isolated push entry to the existing validation-first database-only workflow because branch-local workflow_dispatch is unavailable; require canonical exact SHA, green CI, migration ordering, dry-run and definition-drift guards. Deploy both public and operator Pages using existing narrow workflows. No Worker, Telegram, provider or auth-boundary changes.

See docs/patch-plans/today-critical-path.md for measured baseline and operational boundaries.
