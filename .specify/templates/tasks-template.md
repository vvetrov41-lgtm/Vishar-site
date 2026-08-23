# Tasks: <feature-name>

## Rules

- Every implementation task should trace to one or more requirements or plan sections.
- Keep tasks small enough to validate independently.
- Mark parallel-safe tasks with `[P]` only when they do not edit the same files or depend on unfinished state.
- Do not mark deployment complete from code or CI evidence alone.

## Phase 0: Preflight

- [ ] T001 Resolve current target PR/branch, base, stacked parent if relevant, and exact head SHA.
- [ ] T002 Verify checkout/ref and clean working state before implementation claims.
- [ ] T003 Reconcile spec/plan assumptions with current code, migrations, ADRs, and external state that can be checked safely.

## Phase 1: Foundation

- [ ] T010 <foundation task> [FR-...]

## Phase 2: Core implementation

- [ ] T020 <implementation task> [FR-...]

## Phase 3: Authorization and failure paths

- [ ] T030 <authorization/denial task> [SR-...]
- [ ] T031 <retry/idempotency/failure task> [FR-...]

## Phase 4: Tests and validation

- [ ] T040 <unit/contract test task> [AC-...]
- [ ] T041 <database/pgTAP task if applicable> [AC-...]
- [ ] T042 <CRM build/typecheck/UI task if applicable> [AC-...]
- [ ] T043 Run required exact-head CI and record run/SHA evidence.

## Phase 5: Convergence

- [ ] T050 Run `speckit-analyze` or equivalent consistency review after task changes.
- [ ] T051 Run `speckit-converge` against spec, plan, tasks, implementation, tests, and current exact-head evidence.
- [ ] T052 Resolve or explicitly defer every convergence gap with rationale.

## Phase 6: Environment rollout, only when authorized

- [ ] T060 Apply staging/production migration or deploy step according to the active workstream approval boundary.
- [ ] T061 Verify actual environment state independently of merged code or CI.
- [ ] T062 Record rollback/reference state and final production evidence.

## Deferred work

Keep intentionally deferred items visible instead of silently deleting them.

- [ ] D001 <deferred item> - Reason: <reason>
