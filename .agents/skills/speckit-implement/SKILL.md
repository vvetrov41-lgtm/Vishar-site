---
name: speckit-implement
description: Execute approved Vishar feature tasks in bounded increments while preserving exact-head, security, migration, CI, and deployment boundaries.
---

# Spec Kit: Implement

## Preconditions

- `spec.md`, `plan.md`, and `tasks.md` exist.
- `speckit-analyze` has no unresolved blocking inconsistency.
- The active workstream grants permission for the intended repository writes.

## Procedure

1. Read `AGENTS.md`, the constitution, active feature artifacts, and the relevant Vishar engineering skill.
2. Before implementation claims, verify the current PR/branch/base/head required by the repository workflow.
3. Reconcile the task list with the exact checked revision. Do not blindly implement a stale task against changed architecture.
4. Execute the smallest coherent set of tasks.
5. Keep the diff bounded to the feature. Do not fold unrelated cleanup into the workstream.
6. For database work, inspect later migration history before changing an object and preserve production-applied migration immutability.
7. Add or update positive and denial/failure tests alongside behavior changes.
8. Update `tasks.md` as evidence-backed work completes. Do not mark a task complete merely because code was written.
9. Run the relevant local/static validation available to the agent.
10. For completion claims, require exact-head CI evidence according to repository rules.

## Environment boundary

Do not deploy or mutate Supabase, Cloudflare, external provider accounts, secrets, staging, or production unless the active workstream explicitly authorizes that stage.

A completed implementation phase is allowed to end before environment rollout.
