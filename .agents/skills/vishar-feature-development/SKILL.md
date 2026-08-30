---
name: vishar-feature-development
description: Route Vishar-site product and architecture work through the appropriate lightweight or Spec Kit-compatible workflow. Use for substantial feature development, architecture changes, multi-layer CRM work, or work expected to span multiple sessions or PRs.
---

# Vishar Feature Development

Use this skill to choose the development workflow before implementation.

This router does not replace task-specific engineering skills. It decides when durable specification artifacts are required and then hands implementation to the existing Vishar engineering procedures.

## 1. Classify the task

Classify the requested work as one of three levels.

### Small

Use the normal repository instructions and the relevant Vishar skill. Do not create Spec Kit artifacts by default.

Typical examples:

- isolated copy or UI text fix;
- narrow test repair with an already proven cause;
- small documentation correction;
- one-file implementation change with no new architecture or trust boundary.

### Medium

Use a bounded written implementation plan plus the relevant Vishar skill. Create a full feature spec only when ambiguity or cross-session continuity makes it useful.

Typical examples:

- a contained CRM UI capability;
- a small RPC plus UI caller with established authorization patterns;
- an isolated provider behavior change that does not alter ownership or credential routing.

### Substantial

Use the Spec Kit-compatible workflow before implementation.

A task is substantial when any of these are true:

- introduces a new product capability or subsystem;
- changes architecture, authorization, ownership, trust boundaries, or provider routing;
- spans multiple layers such as database + Worker + CRM + external provider;
- requires multiple migrations, PRs, staged rollout steps, or coordinated compatibility work;
- is expected to continue across multiple agent sessions;
- has enough ambiguity that implementation could satisfy the prompt while missing the intended product behavior.

## 2. Substantial workflow

For substantial work, use this sequence unless a justified step is unnecessary:

1. Read `AGENTS.md` and `.specify/memory/constitution.md`.
2. Run the `speckit-specify` workflow.
3. Run `speckit-clarify` when material requirements remain ambiguous.
4. Run `speckit-plan`.
5. Run `speckit-tasks`.
6. Run `speckit-analyze` before implementation.
7. Before repository claims or edits, use the relevant Vishar engineering/navigation skill and prove the exact target revision.
8. Run `speckit-implement` in bounded increments.
9. Run exact-head validation required by repository instructions.
10. Run `speckit-converge` and repeat implementation/convergence until remaining gaps are explicit.
11. Treat staging/production verification as a separate authorized stage.

## 3. Source-of-truth boundaries

Spec Kit artifacts define feature intent and planned work. They do not override current implementation evidence or repository safety rules.

The following remain authoritative for their domain:

- `AGENTS.md`: repository-wide agent rules;
- `.specify/memory/constitution.md`: stable engineering invariants;
- Vishar task-specific skills: investigation and mutation procedures;
- `docs/ai/`: exact-head, navigation, security, CI, and cross-repository procedures;
- `docs/crm/` and ADRs: durable architecture decisions;
- current code, ordered migrations, tests, CI, and deployed environment: observed implementation state.

If a spec conflicts with current architecture or a newer ADR, stop before high-risk mutation and make the conflict explicit.

## 4. CRM operator-parity decision

For every new or materially changed **user-facing Vishar CRM capability**, explicitly reconcile the change against `docs/gpt-actions/operator-parity.mjs` before declaring the feature complete.

The parity decision must classify the capability as one of:

- `available`: an existing bounded GPT/MCP operation already covers the same authorized user action;
- `gap`: a safe bounded server contract exists but GPT exposure still needs implementation;
- `planned`: the product behavior is accepted but the safe server/provider contract is not complete yet;
- `ui_only`: an unavoidable provider consent, account-security, device-local binary interaction, or similarly concrete interactive boundary prevents safe tool execution.

Rules:

1. Missing GPT coverage by accident is a product gap, not an implicit UI-only decision.
2. Adding a CRM screen, button, RPC, or provider-management action must update the parity inventory when it introduces or changes a meaningful operator action.
3. New Action operations must use one of the semantic domains in the parity inventory and preserve the repository hard limit of 30 operations per imported schema with a target of at most 25.
4. Do not create generic SQL, arbitrary RPC, arbitrary provider proxy, or broad execute endpoints to obtain parity.
5. The GPT/MCP transport never becomes an authorization layer. Existing profile, workspace, Artist membership, and capability checks remain authoritative.
6. Provider OAuth/consent may be initiated by a bounded tool, but the human-only consent screen itself remains a documented UI-only boundary.
7. A substantial CRM feature is not converged while a newly introduced operator action is absent from the parity inventory without an explicit classification.

## 5. Safety boundary

Spec completion never grants permission to:

- merge or mark a PR Ready;
- deploy staging or production;
- mutate Supabase, Cloudflare, external accounts, secrets, or provider configuration;
- weaken authorization or security controls;
- overwrite unrelated work.

Use the permissions and deployment rules of the active workstream.

## 6. Handoff expectation

For substantial features, future handoffs should point to the durable artifacts instead of restating the whole feature history.

Preferred handoff shape:

```text
Feature: specs/<feature-id>/
Target PR/branch: <current target>
Exact head: <sha if verified>
Resume from: <task id>
Open gaps: <short list>
Required next validation: <short list>
```

Do not duplicate large sections of `spec.md`, `plan.md`, or `tasks.md` into the handoff.
