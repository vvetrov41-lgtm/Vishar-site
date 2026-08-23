---
name: speckit-specify
description: Create or update a durable feature specification for substantial Vishar-site product or architecture work. Focus on what and why, not implementation details.
---

# Spec Kit: Specify

Use for substantial work routed through `vishar-feature-development`.

## Procedure

1. Read `AGENTS.md`, `.specify/memory/constitution.md`, and `docs/ai/spec-driven-development.md`.
2. Choose or reuse `specs/<feature-id>/`.
3. Start from `.specify/templates/spec-template.md` when creating a new spec.
4. Describe observable product/system behavior, goals, non-goals, actors, scenarios, failure behavior, security/trust requirements, dependencies, and verifiable acceptance criteria.
5. Keep implementation choices out of the specification unless they are externally imposed constraints.
6. Preserve explicit unknowns under `Open questions` rather than inventing details.
7. If an existing spec changes materially, record the requirement change and reason.

## Vishar-specific requirements

For CRM/integration work, the spec must make artist/workspace scope and authorization expectations explicit. If browser input can contain routing identifiers, state which outcomes must be server-authoritative.

For provider workflows, specify durable business behavior when the provider is unavailable or returns a late/stale result.

## Output

Create or update:

`specs/<feature-id>/spec.md`

Do not implement code in this step.
