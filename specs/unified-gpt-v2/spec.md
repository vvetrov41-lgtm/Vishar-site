# Feature Specification: Unified GPT v2

## Status

- Feature: `unified-gpt-v2`
- State: In implementation
- Owner/workstream: Vishar CRM
- Related historical work: PR #389 unified profile-bound authorization, PR #390 golden-path validation, PR #377 unified production onboarding skill
- Current implementation branch: `agent/unified-gpt-v2`

## Problem

Vishar CRM already has a profile-bound authorization foundation that can serve several Artists through one authenticated CRM profile, but the production operating documentation and the live Custom GPT setup still center on two legacy artist-bound GPT applications. This leaves the product with two different identity models: the database understands one user-scoped Vishar GPT, while production onboarding guidance still treats an OAuth client as an Artist identity.

The result is unnecessary duplication, higher rollout risk, stale operational guidance and a future scaling problem whenever another Artist or manager needs GPT access.

## Goals

- Provide one Vishar CRM GPT for authenticated CRM users.
- Make the OAuth client identify the Vishar GPT application, never an Artist.
- Resolve accessible Artists from the signed-in CRM profile and current memberships.
- Let the user select an active Artist only through the server-validated Artist context contract.
- Reuse the existing CRM capability model for every read or mutation.
- Preserve the existing Vladimir and Kristina artist-bound GPTs as rollback compatibility until unified production acceptance is complete.
- Keep the current bounded Core and Operations Action sets, including explicit consequential-action classification.
- Provide durable GPT instructions and production onboarding guidance that match the implemented profile-bound model.
- Keep later notification/template editing and Web Research actions compatible with the same profile/context/capability boundary rather than creating new identity models.

## Non-goals

- Replacing CRM authorization with GPT instructions or OpenAPI descriptions.
- Giving the GPT arbitrary SQL, table access, arbitrary RPC access, service credentials or provider credentials.
- Letting a GPT action choose an Artist outside the dedicated context selector.
- Disabling legacy artist-bound GPTs before unified production acceptance.
- Adding notification/template editing Actions before the server-side Notification/Template Studio contract is final.
- Implementing Firecrawl/Web Research in this workstream; that remains under `specs/web-research/` and must reuse this unified identity boundary when integrated.
- Solving the independent intermittent Supabase backend 401 incident inside this feature.

## Actors and scope

- User/actor: an authenticated, active CRM profile.
- Artist scope: current `artist_memberships` and capability resolution are authoritative.
- GPT application: one profile-bound `vishar-unified-gpt` OAuth application.
- Legacy compatibility: existing artist-bound Vladimir and Kristina GPT clients remain active until separately retired.
- Environments affected: CI, staging/validation and production activation. Production activation is a separate stage from repository implementation.

## User scenarios

### Scenario 1: User with one accessible Artist

Given an authenticated CRM user has access to exactly one active Artist, when the unified GPT needs CRM data, then the server resolves that Artist without requiring the GPT to supply an Artist identity to ordinary business actions.

### Scenario 2: User with multiple accessible Artists

Given an authenticated CRM user has access to multiple active Artists and no current selection, when the GPT requests context, then it receives only the accessible Artist choices and must select one through the dedicated context action before artist-scoped work continues.

### Scenario 3: Revoked or invalid Artist selection

Given a previously selected Artist is no longer accessible, when the GPT makes a later request, then the server re-checks membership and refuses the stale selection instead of silently falling back to another Artist.

### Scenario 4: Daily CRM operation

Given a valid active Artist context, when the GPT reads or mutates clients, enquiries, projects, sessions, finance or communications, then the corresponding server-side GPT capability and CRM Artist capability must both permit the operation.

### Scenario 5: High-impact action

Given the GPT is about to send a client message, approve an email, record a payment or perform another consequential mutation, when the exact user intent is not established, then the GPT must not execute the mutation. OpenAPI consequential metadata and GPT instructions are interaction controls; database authorization remains authoritative regardless.

### Scenario 6: Legacy rollback

Given unified production activation fails or must be contained, when the unified client is disabled, then the existing artist-bound GPTs remain available without migration rollback or cross-Artist rebinding.

### Scenario 7: Future notification/template actions

Given Notification/Template Studio later exposes bounded server-side contracts, when those actions are added to GPT, then they must inherit the same authenticated profile, selected Artist and capability checks. They must not introduce a separate GPT identity, Artist parameter or provider credential path.

## Functional requirements

- FR-001: Production architecture MUST support one profile-bound Vishar GPT application for all authorized CRM profiles.
- FR-002: The OAuth client MUST identify the application and MUST NOT itself be authoritative Artist identity in profile-bound mode.
- FR-003: The unified GPT MUST expose a read context action that returns only Artists accessible to the current authenticated profile plus the current valid selection state.
- FR-004: The unified GPT MUST expose a context selection action that accepts one Artist identifier and revalidates current membership server-side before storing or using it.
- FR-005: Outside the dedicated Artist context route, GPT business actions MUST NOT accept caller-supplied `artist_id`.
- FR-006: Every business action MUST continue to resolve its Artist scope through the existing server-side GPT context helpers and capability checks.
- FR-007: The existing Core and Operations schemas MUST remain individually within the current ChatGPT Action import operation limit enforced by repository tests and together cover the canonical intended action surface without duplicate operation IDs.
- FR-008: Read-only operations MUST remain non-consequential and mutations/provider sends MUST remain consequential in the OpenAPI contract.
- FR-009: GPT instructions MUST require context resolution before ambiguous artist-scoped work and MUST forbid guessing inaccessible Artist identifiers.
- FR-010: GPT instructions MUST require explicit user intent for high-impact actions whose current contract already requires confirmation, including outbound client messages, email approval and manual payment recording.
- FR-011: Production onboarding documentation MUST describe the profile-bound unified client as the target architecture and legacy artist-bound clients as rollback compatibility only.
- FR-012: Activating the unified GPT MUST NOT disable or mutate the two legacy artist-bound clients in the same step.
- FR-013: Production activation MUST begin from a dormant unified client and enable only the capabilities intentionally accepted for the unified surface.
- FR-014: A provider or CRM transport failure MUST be surfaced as a failure and MUST NOT cause the GPT to retry a consequential mutation with altered parameters or switch Artist context automatically.
- FR-015: Future Notification/Template and Web Research actions MUST reuse the same profile/context/capability boundary when they are introduced.

## Security and trust requirements

- SR-001: Supabase Auth identity, active profile state, current Artist membership and server-side capability checks remain authoritative for every action.
- SR-002: `/v1/context` is the only reviewed GPT route allowed to accept `artist_id`, and that value is a selector subject to server revalidation, not authority.
- SR-003: The GPT Worker MUST use the caller's OAuth bearer token and the publishable Supabase key only. It MUST NOT carry a Supabase service-role or secret key for GPT business actions.
- SR-004: The caller MUST NOT supply OAuth client id, integration key, provider route, capability name, SQL, arbitrary RPC name or service credential through a GPT Action request.
- SR-005: OAuth client secrets and the Worker PKCE bridge secret remain server/editor-side and MUST NOT be committed, logged, stored in CRM tables or pasted into documentation.
- SR-006: Artist selection MUST fail closed on ambiguity, revocation, inactive Artist or inactive profile.
- SR-007: A capability advertised by OpenAPI MUST still fail closed when the database client ceiling or the current CRM membership/capability denies it.
- SR-008: Legacy fixed-Artist clients MUST remain unable to select or operate on another Artist.
- SR-009: External provider routing for Gmail, WhatsApp, Calendar, payments and future integrations remains server-owned after GPT context resolution.

## Failure and recovery behavior

- Missing/expired OAuth token: return an authentication failure and require reconnect rather than attempting anonymous fallback.
- No valid Artist selection where multiple Artists are accessible: return an explicit selection-required state.
- Revoked Artist access: refuse the action immediately; do not auto-select another Artist.
- Capability denied: return a bounded authorization error without exposing internal policy details.
- Concurrent record change: require refresh/re-read before retrying the mutation.
- Supabase/provider transient failure: report a transient failure. Consequential retries must preserve the same intended operation and idempotency identifier where the contract supports it.
- Unified rollout problem: disable or leave dormant the unified client while preserving legacy artist-bound GPTs.

## Data and retention expectations

The feature reuses existing production objects introduced by the platform refactor, including the profile-bound `gpt_action_clients` row, per-profile Artist context and action receipts. No new durable customer data is required for the initial v2 contract/onboarding increment.

Selected Artist context remains private server-side state. OAuth secrets are never stored in these database records. Existing bounded action receipts remain the durable evidence for idempotent GPT mutations where applicable.

## Acceptance criteria

- AC-001: Repository contract tests prove `artist_id` appears only in the dedicated context route across production GPT schemas.
- AC-002: A profile with two accessible Artists cannot perform artist-scoped GPT work until one valid Artist is selected.
- AC-003: Revoking the selected Artist membership invalidates subsequent GPT access without rewriting the stored selector to another Artist.
- AC-004: Legacy Vladimir/Kristina GPT clients remain functional and fixed to their respective Artist while the unified client is dormant or being validated.
- AC-005: Production onboarding/runbook and agent guidance consistently describe one profile-bound unified GPT as the target model.
- AC-006: GPT v2 instructions contain explicit context-selection, read-before-write, high-impact confirmation and safe failure behavior.
- AC-007: Core and Operations Action schemas remain within the repository-enforced Action count bounds, contain no duplicate operation IDs and use the same OAuth edge.
- AC-008: Required exact-head CI is green on the implementation PR.
- AC-009: Before production activation, a fresh readback proves the unified production client is profile-bound, OAuth-unconfigured/inactive or otherwise intentionally dormant, while legacy clients remain active.
- AC-010: Production acceptance later proves one real authenticated user can read context, select an authorized Artist when required and perform bounded read operations without seeing another unauthorized Artist.
- AC-011: Production cutover does not proceed while an unresolved infrastructure condition makes authorization/transport failures indistinguishable from GPT v2 defects unless the release has a proven containment strategy.

## Dependencies and constraints

- Existing profile-bound authorization foundation from migration `0084` and later production lineage.
- Existing production GPT Worker, OAuth relay/PKCE bridge and two Action custom domains.
- Existing CRM capability model and Artist memberships.
- External Custom GPT editor and Supabase OAuth client provisioning are external control-plane steps and may require a human if no connected management surface is available.
- The independent Supabase intermittent 401 incident must be considered before final production cutover.

## Open questions

- None for the repository implementation increment. Exact external GPT Builder availability and current production Cloudflare version are rollout-time fresh-checks, not specification ambiguity.

## Requirement changes

- 2026-08-30: Notification/template editing is explicitly deferred from the initial GPT v2 Action surface until its server-side CRM model is finalized, but the unified identity/capability boundary is required to support it later without redesign.
