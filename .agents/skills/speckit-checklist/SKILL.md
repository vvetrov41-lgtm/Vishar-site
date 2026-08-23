---
name: speckit-checklist
description: Create a requirement-quality or rollout-readiness checklist for a substantial Vishar feature without duplicating implementation tasks.
---

# Spec Kit: Checklist

Use when the feature has meaningful security, migration, provider, rollout, or requirement-quality risk.

## Procedure

1. Read the active spec, plan, constitution, and relevant Vishar workflow instructions.
2. Start from `.specify/templates/checklist-template.md`.
3. Tailor checks to the feature's actual risks.
4. Write checks as questions of requirement/design readiness, not as implementation tasks.
5. Include authorization, ownership, server authority, migration history, denial paths, exact-head evidence, and deployment separation when relevant.
6. Avoid generic checks that add no decision value.

## Output

Create a descriptive file under:

`specs/<feature-id>/checklists/<purpose>.md`

Examples: `requirements.md`, `security.md`, `rollout.md`.
