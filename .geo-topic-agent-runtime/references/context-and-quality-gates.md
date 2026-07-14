# Context And Quality Gates

## Context Packaging

Use compact artifacts by default:

- CSV for flat inventories;
- JSON for small summary and config;
- JSONL for per-row evidence;
- Markdown for human reports.

Do not pass whole raw provider responses, whole workspaces, or large nested JSON into checker contexts unless a compact projection cannot answer the check and the reason is recorded.

## Stage Gates

For full or production-grade runs, every stage must have:

- input universe or explicit reason it is unavailable;
- processed count;
- output artifact path;
- skipped/blocked status when applicable;
- evidence refs;
- next valid action.

Required stage names:

- `adaptation`
- `project_context`
- `accessibility`
- `fanout`
- `serp_ai_analysis`
- `content_plan`
- `semantic_tz_handoff`
- `placement_strategy`
- `monitoring_plan`
- `final_claim_guard`

## Claim Guard

The final report must distinguish:

- accepted evidence;
- lower-assurance assumptions;
- skipped provider calls;
- blocked credentials;
- user decisions needed;
- work that is only planned.

Completion cannot be claimed from a convenient subset. If no live provider data exists, the agent can be complete as an offline GEO workflow run, but the evidence strength must be labeled.


## Final Evidence Contract

Use `references/final-evidence-contract.json` before making a full live-proven 100% claim. Every external evidence item must be `external_pass`; explicitly descoped items create only a limited `ready_with_descopes` claim with visible limitations.
