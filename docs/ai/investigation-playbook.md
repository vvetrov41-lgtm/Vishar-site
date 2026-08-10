# Engineering investigation playbook

Use these procedures after the exact-ref preflight in `branch-workflow.md`.

The purpose is to reduce navigation calls without replacing engineering judgment.

## Investigating an RPC

Given `RPC_NAME`:

1. Search the whole checkout for the exact name.
2. Identify every JavaScript/TypeScript caller.
3. Identify the SQL definition currently effective at the target head.
4. Search later migrations for replacement/hardening.
5. Find `GRANT EXECUTE`, `REVOKE`, owner/schema changes, and `SECURITY DEFINER` behavior.
6. Inspect internal role/artist/service checks.
7. Identify tables/policies the function bypasses or relies on.
8. Find pgTAP and Worker/CRM tests that exercise allowed and denied callers.
9. Verify returned fields do not cross a security boundary unexpectedly.
10. Report the complete chain with file paths and the exact head.

Useful commands:

```bash
bash scripts/ai/trace-rpc.sh RPC_NAME
bash scripts/ai/migration-history.sh RPC_NAME
```

## Investigating a Worker route

1. Find the router/entry point.
2. Find the route handler.
3. Trace request method/path checks.
4. Trace Origin/CORS separately. CORS headers are not authentication.
5. Trace body/file limits and validation.
6. Mark each browser-controlled value.
7. Mark each server-controlled configuration value.
8. Trace privileged RPC/storage/provider calls.
9. Trace error handling and safe logging.
10. Find tests for malformed, unauthorized, oversized, duplicate, provider-failure, and persistence-failure cases as applicable.

For booking intake, continue through finalization and outbox even if the initial question mentions only the Worker.

## Investigating a migration-defined workflow

Never stop at the migration whose filename looks most relevant.

1. Find the earliest definition of the symbol.
2. Read it in context.
3. Search every later migration for the same symbol or dependent object.
4. Determine the final function/table/policy/grant shape at the target head.
5. Inspect tests applied after the migration set.
6. Distinguish historical intent from effective current behavior.

## Investigating an outbox flow

Trace all of these stages:

```text
business mutation
  -> outbox enqueue
  -> dedupe/version key
  -> claim/lease
  -> safe job projection
  -> artist/provider route resolution
  -> credential custody
  -> provider call
  -> acknowledgement
  -> retry/dead letter
  -> activity/audit evidence
```

Check concurrency and stale-result behavior, not only the happy path.

## Investigating Google Calendar

At minimum inspect:

- the appointment mutation RPC;
- calendar version update;
- outbox enqueue;
- claim lease;
- Worker drain;
- artist route/provider resolution;
- token retrieval/decryption;
- Google provider call;
- acknowledgement;
- retry/dead-letter path;
- OAuth/token-custody ADR and current implementation.

A correct answer should explain which system is authoritative and what happens if a provider result arrives after the appointment changed again.

## Investigating artist routing

Build a provenance table for every routing input:

| Value | Source | Browser-controlled? | Validation/authority |
|---|---|---:|---|
| observed Origin | request transport | partially | exact server check |
| source key | Worker config | no | trusted booking resolver |
| form version | Worker config | no | trusted booking resolver |
| artist ID | database mapping | no | active source/artist constraints |
| outbox kind | durable DB event | no | kind-to-integration mapping |
| integration key | DB safe metadata | no | backend-only route resolver |
| provider credential | encrypted Worker binding/KV | no | backend lookup |

Treat the table above as a pattern. Rebuild it from the current code instead of copying it blindly.

## Investigating a CI failure

1. Identify the target PR and exact head SHA.
2. Identify the failed run/job and confirm its checked SHA.
3. Ignore superseded runs for root-cause evidence unless comparing regressions.
4. Read the first causal failure, not only the final job summary.
5. Reproduce against the exact head in a cloud/local checkout when feasible.
6. Classify the defect: production code, test harness, environment, dependency, workflow, or infrastructure.
7. Fix only the proven layer.
8. Re-run the narrowest useful validation, then the standard required CI.

Do not weaken production authorization or security controls to make a test harness pass.

## Investigating security

Use `security-boundaries.md` as a mandatory checklist. A code search result is a candidate, not proof. Verify callability, grants, data returned, and tests at the exact ref.

## Cross-repository investigation

Use `cross-repo-contracts.md`. Resolve and verify each repository independently. Never report a complete end-to-end chain using one repository's current head and another repository's remembered head.

## Report format

A useful investigation report should contain:

1. exact scope and refs;
2. observed chain;
3. authoritative boundaries;
4. evidence paths/symbols;
5. discrepancies or unknowns;
6. tests/CI evidence tied to the correct SHA;
7. whether any mutation was performed.

Avoid long repository tours. Lead with the answer and include only the code paths needed to support it.