---
name: speckit-constitution
description: Review or deliberately update the stable Vishar Spec Kit engineering constitution. Use only for project-wide engineering principle changes, not normal feature work.
---

# Spec Kit: Constitution

The current constitution lives at `.specify/memory/constitution.md`.

## Default behavior

Read the constitution for substantial feature work, but do not rewrite it merely because a feature has unusual requirements.

## Update procedure

Only update the constitution when the requested change is a durable project-wide engineering principle.

Before changing it:

1. Read `AGENTS.md`, relevant `docs/ai/`, `docs/crm/` and ADRs.
2. Determine whether the proposed rule is truly stable across features.
3. Avoid copying operational procedures that belong in task-specific skills.
4. Preserve stronger existing security and deployment constraints unless the user explicitly authorizes an architectural governance change.
5. Record the constitution version change and explain the material principle change in the PR/workstream.

Feature-specific constraints belong in that feature's `spec.md` or `plan.md`, not in the constitution.
