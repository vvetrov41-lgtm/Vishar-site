# Checklist: <feature-name> / <checklist-purpose>

Use checklists to validate requirement quality or rollout readiness, not to duplicate implementation tasks.

## Requirements quality

- [ ] CHK001 Every requirement describes observable behavior rather than an implementation preference.
- [ ] CHK002 Success, denial, and failure behavior are explicit where relevant.
- [ ] CHK003 Artist/workspace ownership and authorization expectations are explicit.
- [ ] CHK004 Browser-controlled values and server-authoritative values are distinguishable.
- [ ] CHK005 Data retention, audit, and sensitive-data expectations are stated where relevant.
- [ ] CHK006 Acceptance criteria are independently verifiable.

## Architecture readiness

- [ ] CHK010 Current implementation was checked at the correct revision.
- [ ] CHK011 Ordered migration history was considered for changed database objects.
- [ ] CHK012 RLS, grants, privileged RPCs, and service-role paths were considered together.
- [ ] CHK013 External provider credential custody is explicit.
- [ ] CHK014 Idempotency, concurrency, retry, stale result, and terminal failure behavior are addressed where applicable.

## Validation readiness

- [ ] CHK020 Positive and denial-path tests are identified.
- [ ] CHK021 Required pgTAP/Worker/CRM validation is identified.
- [ ] CHK022 Exact-head CI evidence is required before completion claims.
- [ ] CHK023 Environment deployment and production verification are separate from code completion.

## Scope control

- [ ] CHK030 Non-goals are explicit enough to prevent unrelated cleanup.
- [ ] CHK031 Deferred work remains visible with rationale.
- [ ] CHK032 No task requires weakening authorization, RLS, validation, or secret handling to make tests pass.
