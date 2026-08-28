---
name: speckit-analyze
description: Check a Vishar feature's spec, plan, and tasks for inconsistency, missing coverage, unsafe assumptions, and untraceable work before implementation.
---

# Spec Kit: Analyze

Use after tasks are drafted and before implementation, and again when material scope changes.

## Procedure

1. Read `spec.md`, `plan.md`, `tasks.md`, `.specify/memory/constitution.md`, and relevant repository instructions.
2. Do not edit code during analysis.
3. Check requirement coverage: every material requirement and acceptance criterion should have a plausible implementation and validation path.
4. Check contradiction: spec, plan, tasks, ADRs, and current repository evidence must not silently disagree.
5. Check trust boundaries: ownership, authorization, browser-controlled values, privileged RPCs, RLS/grants, credentials, and provider routing must be represented where relevant.
6. Check migration completeness: plans/tasks must account for ordered migration history and compatibility.
7. Check evidence quality: old CI, remembered production state, or code presence must not be treated as current deployment evidence.
8. Check scope: unrelated cleanup and speculative future work should not be smuggled into implementation tasks.
9. Classify findings as BLOCKING, HIGH, MEDIUM, or LOW.
10. Update artifacts only when the correction is unambiguous. Otherwise record the conflict and required decision.

## Completion gate

Implementation may begin when no unresolved BLOCKING inconsistency remains and HIGH findings have an explicit resolution or accepted bounded risk.
