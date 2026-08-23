---
name: speckit-tasks
description: Break a Vishar feature plan into traceable, bounded implementation and validation tasks.
---

# Spec Kit: Tasks

## Preconditions

- `spec.md` and `plan.md` exist for the active feature.

## Procedure

1. Read the active spec, plan, constitution, and relevant repository workflow instructions.
2. Start from `.specify/templates/tasks-template.md`.
3. Create tasks that are concrete enough to implement and validate independently.
4. Trace implementation and validation tasks to requirements or acceptance criteria where practical.
5. Keep exact-head preflight before implementation claims.
6. Include positive, denial, failure, migration, and compatibility validation when applicable.
7. Keep deployment/environment mutation in a separate phase and only when the workstream authorizes it.
8. Keep intentionally deferred items visible with rationale.
9. Mark tasks parallel-safe only when they have no shared write surface or unfinished dependency.

## Output

Create or update:

`specs/<feature-id>/tasks.md`

Do not execute implementation tasks in this step.
