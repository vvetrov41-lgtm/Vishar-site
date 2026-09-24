# Plan

Phases are separate bounded PRs against `agent/platform-telegram-self-service`.
Each goes: fresh base → implementation → tests → exact-head CI → merge →
production release through the canonical release branches → readback.

| Phase | Deliverable | Release path |
|---|---|---|
| 0 | `crm_private.ai_runs`, `service_record_ai_run`, `service_ai_run_summary`; router per-attempt facts; wiring in intake, client state, reference image | private production release (DB) + TattooAI Worker release |
| 1 | Controlled request-shape probe; offline eval fixtures in CI; guarded live eval; route decision from telemetry | TattooAI Worker release |
| 2 | Composable attention rule functions + one bounded projection, shadow comparison | private production release |
| 3 | Versioned narrow client-state contract using `allowed_actions`; draft failure no longer discards analysis | DB + TattooAI Worker |
| 4 | `get_today_pulse` shared by CRM Today and Telegram `/today`; operator feedback | DB + CRM Pages + Telegram scheduler |
| 5 | Unmatched conversation triage and safe linking suggestions | DB + CRM |
| 6 | Fact claims with provenance; client state consumes them | DB + TattooAI Worker |

## Phase 0 design notes

- The Worker names only the job it holds; the database copies the source event
  and watermark from the job row.
- Every text column in `ai_runs` is a closed vocabulary or strict token
  pattern; the attempt array is validated key by key.
- Telemetry is written after the job's own state change and is fail-open: the
  Worker swallows errors and the RPC answers `rejected` instead of raising.
- 90-day retention enforced on write, 200 rows per insert.
- Validation failures are reported as a location code (`brief.stage`), never a
  value.
- Prompt versions are pinned to prompt hashes in `scripts/test-ai-telemetry.mjs`.
