# Implementation Plan: <feature-name>

## Specification

- Spec: `specs/<feature-id>/spec.md`
- Target repository: `vvetrov41-lgtm/Vishar-site`
- Target branch/PR: <resolve before implementation>
- Exact target SHA: <verify before implementation>

## Constitution check

Read `.specify/memory/constitution.md` and list any principles materially relevant to this feature.

- <principle -> implementation consequence>

## Current-state evidence

Before planning implementation details, record the current observed architecture at the verified target revision.

- Entry points:
- Database objects/migrations:
- Authorization boundary:
- Durable state boundary:
- Provider/integration path:
- Existing tests:
- Relevant ADR/docs:
- Unknown or externally unverifiable state:

## Proposed design

Describe the implementation approach and why it satisfies the specification.

### Data model and migrations

- New/changed objects:
- Migration ordering/compatibility:
- RLS/grants/RPC implications:
- Backfill or rollout needs:

### Server/Worker layer

- Routes/handlers:
- Validation:
- Trusted routing/ownership resolution:
- Idempotency/concurrency:

### CRM/UI layer

- User interactions:
- Authorization assumptions that MUST be enforced server-side:
- Loading/error states:

### External integrations

- Provider:
- Credential custody:
- Retry/acknowledgement:
- Failure handling:

### Observability and audit

- Durable activity/audit evidence:
- Logs/metrics where applicable:

## Security review

Explicitly address:

- browser-controlled values;
- artist/workspace authorization;
- privileged RPC/service-role paths;
- RLS and grants;
- secrets/tokens;
- cross-tenant leakage risk;
- denial-path tests.

Use `N/A` only with a reason.

## Test strategy

- Unit/contract tests:
- pgTAP/database tests:
- CRM/typecheck/build tests:
- denial/security tests:
- integration/smoke tests:
- exact-head CI required:

## Rollout plan

Separate code completion from environment mutation.

1. <code/PR stage>
2. <staging or validation stage>
3. <production migration/deploy stage, only if authorized>
4. <production verification>

## Rollback/reference plan

Describe how to stop or reverse the rollout, or why the change is safely additive.

## Risks

| Risk | Consequence | Mitigation |
| --- | --- | --- |
| <risk> | <impact> | <mitigation> |

## Plan completion gate

The plan is ready for task generation only when:

- the current target revision is known or explicitly deferred until implementation preflight;
- all material requirements map to an implementation area;
- trust boundaries are explicit;
- migration and compatibility implications are addressed;
- validation and deployment evidence are separated.
