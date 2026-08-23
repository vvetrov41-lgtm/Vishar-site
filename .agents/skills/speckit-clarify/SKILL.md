---
name: speckit-clarify
description: Resolve material ambiguity in an existing Vishar feature specification before technical planning.
---

# Spec Kit: Clarify

Use after `speckit-specify` when unresolved ambiguity could materially change architecture, security, user behavior, data ownership, rollout, or acceptance criteria.

## Procedure

1. Read the active `spec.md` and `.specify/memory/constitution.md`.
2. Identify ambiguities that could produce meaningfully different implementations.
3. Prefer evidence from current repository docs, ADRs, code, or explicit user requirements before asking for clarification.
4. Do not ask about details that can be safely resolved from existing project context.
5. When a product decision genuinely cannot be inferred, surface the smallest decision needed.
6. Update `spec.md` with the resolved requirement and remove or narrow the corresponding open question.
7. Record material requirement changes in the spec's change log.

Do not create the technical plan until material ambiguity is resolved or explicitly accepted as a bounded assumption.
