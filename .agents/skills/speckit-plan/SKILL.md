---
name: speckit-plan
description: Turn an approved Vishar feature specification into a technical implementation plan grounded in the current repository architecture and safety boundaries.
---

# Spec Kit: Plan

## Preconditions

- A durable `specs/<feature-id>/spec.md` exists.
- Material product ambiguity is resolved or explicitly bounded.

## Procedure

1. Read `AGENTS.md`, `.specify/memory/constitution.md`, the active spec, and relevant Vishar engineering skills/docs.
2. Resolve the current target revision before making implementation claims. If planning happens before a target branch exists, mark exact-head verification as a mandatory implementation preflight.
3. Investigate current implementation rather than planning from memory.
4. Start from `.specify/templates/plan-template.md`.
5. Map every material requirement to an implementation area.
6. Explicitly cover data/migrations, server/Worker behavior, CRM/UI, authorization, provider integrations, tests, CI, rollout, and rollback when applicable.
7. Separate code completion from staging/production mutation.
8. List unknown external state instead of inventing it.

## Output

Create or update:

`specs/<feature-id>/plan.md`

Do not implement code in this step.
