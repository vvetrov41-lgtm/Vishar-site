---
name: speckit-converge
description: Compare Vishar feature intent, plan, tasks, implementation, tests, CI evidence, and environment evidence; append explicit remaining work until the feature is genuinely complete or intentionally deferred.
---

# Spec Kit: Converge

Use after an implementation increment and before declaring a substantial feature complete.

## Procedure

1. Read the active `spec.md`, `plan.md`, `tasks.md`, constitution, relevant ADR/docs, and current implementation at the verified target head.
2. Check each functional, security, failure, and acceptance requirement against concrete implementation and test evidence.
3. Check that completed tasks have real evidence and that unfinished work was not silently removed.
4. Check exact-head CI. Historical green runs do not close current-head gaps.
5. When deployed behavior matters, check actual environment evidence separately. Code/merge/CI does not prove deployment.
6. Check for drift introduced during implementation: new assumptions, changed data model, altered authorization, provider behavior, or deferred compatibility work.
7. Append missing work to `tasks.md` with new task IDs rather than hiding it in prose.
8. If the implementation correctly changed the product requirement, update the spec deliberately and record the requirement change before convergence can succeed.

## Result

Report one of:

- `CONVERGED`: all in-scope requirements have implementation and validation evidence, with rollout evidence included when rollout is in scope.
- `IMPLEMENTATION CONVERGED / ROLLOUT PENDING`: code and exact-head validation are complete but authorized environment rollout remains.
- `NOT CONVERGED`: list the blocking gaps and ensure they exist in `tasks.md`.
- `CONVERGED WITH DEFERRED ITEMS`: only when each deferred item is explicit, out of current scope, and has rationale.
