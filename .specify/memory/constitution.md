# Vishar CRM Engineering Constitution

Version: 1.0.0
Upstream workflow reference: GitHub Spec Kit v1.0.0

This constitution defines stable engineering constraints for substantial Vishar CRM product and architecture work. It supplements, and never overrides, repository-specific instructions in `AGENTS.md`, `.agents/skills/`, `docs/ai/`, `docs/crm/`, CI, or deployment controls.

## I. Server authority

Browser-controlled or agent-controlled input must never authoritatively choose security-sensitive routing or ownership data.

Server-side trusted state must resolve at least:

- artist and workspace ownership;
- booking source identity;
- provider integration and provider account;
- Telegram destination;
- Calendar account;
- payment destination;
- OAuth credential or token custody.

Client-provided identifiers may be hints only when the server independently validates them against trusted state.

## II. Authorization before capability

Every artist-scoped or workspace-scoped read or mutation must prove authorization on the server side.

RLS, RPC role checks, membership checks, capability checks, grants, and privileged service paths must be evaluated together. A UI restriction is not an authorization boundary.

## III. Ordered database evolution

Supabase migrations are an ordered history. Existing production-applied migrations are immutable.

When investigating a database object, inspect every later migration that may replace, alter, grant, revoke, constrain, trigger, or otherwise change its effective behavior. Report the final effective definition at the exact target revision.

## IV. Exact-head evidence

Repository state is part of correctness.

Before substantial implementation or diagnosis:

1. resolve the relevant PR/branch and current head SHA;
2. resolve the real base and stacked parent when relevant;
3. verify the checked-out revision exactly;
4. separate historical evidence from evidence for the current head.

A green CI run for an older SHA is not validation of the current SHA.

## V. Durable external delivery

External provider delivery must preserve durable business state before or independently of best-effort provider calls.

Where appropriate, integrations must define:

- idempotency or deduplication;
- claim/lease or concurrency protection;
- retry behavior;
- stale-result handling;
- dead-letter or terminal failure behavior;
- auditable outcomes.

Provider success must not be treated as the only record of a business event.

## VI. Secret and credential custody

Secrets, provider credentials, OAuth tokens, signing keys, and service credentials remain server-side.

They must not be exposed through browser state, public endpoints, logs, agent prompts, generated specifications, test fixtures, or committed configuration.

## VII. Deployment is separate evidence

Code presence, a merged PR, or a green build does not prove deployment.

When production or staging state matters, verify the actual environment independently, including the relevant Supabase migration head, Cloudflare Worker/Pages deployment, routes, bindings, and feature behavior when accessible.

No Spec Kit workflow may automatically deploy production or mutate external production systems merely because implementation tasks are complete.

## VIII. Bounded change and reversible rollout

Each implementation workstream must have an explicit scope and must avoid unrelated cleanup.

For high-risk changes, prefer additive or reversible rollout steps, explicit compatibility boundaries, and a clear rollback/reference path. Never weaken ACL, RLS, authentication, validation, or secret handling to satisfy a test harness.

## IX. Specification traceability

For substantial product or architecture work, the durable specification must state observable behavior, constraints, failure cases, and acceptance criteria before implementation.

Technical plans must identify affected trust boundaries, migrations, provider routes, tests, CI evidence, and deployment verification when relevant.

Tasks must be traceable back to requirements. Completion means implementation plus evidence, not merely code written.

## X. Governance

This constitution is intentionally shorter and more stable than operational documentation.

- `AGENTS.md` controls repository-wide agent behavior.
- `.agents/skills/` controls task-specific procedures.
- `docs/ai/` controls navigation and engineering workflow details.
- `docs/crm/` and ADRs record architecture and durable decisions.
- feature specifications under `specs/` record what a bounded feature intends to achieve.

If these sources disagree, do not silently choose one. Verify current code and environment, identify the conflict, and resolve the source-of-truth question before high-risk mutation.
