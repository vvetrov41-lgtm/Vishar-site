# Feature Specification: Universal artist WhatsApp routing

## Status

- Feature: `whatsapp-universal-artist-routing`
- State: In implementation
- Owner/workstream: Vishar CRM WhatsApp production engineering
- Related PRs/issues: supersedes the stale unmerged `agent/whatsapp-embedded-signup-all-artists` implementation

## Problem

Vladimir's production WhatsApp is operational, but onboarding and inbound routing still contain source-code allowlists for known artists. Adding another artist by copying those entries can create duplicate Worker binding selectors or ambiguous provider routes. The CRM also relies on `connected_at` bookkeeping that older live connections did not originally populate.

## Goals

- Let any authorized active artist connect a production WhatsApp Business account through the existing Meta Embedded Signup flow.
- Resolve inbound artist ownership from server-controlled encrypted bindings plus the signed WABA and Phone Number ID, without a source-code artist allowlist or a default artist.
- Keep one separately encrypted credential envelope per artist in each WhatsApp Worker.
- Reject duplicate integration selectors, mismatched provider identities, missing credentials and ambiguous routes fail-closed.
- Preserve Vladimir's working production connection and existing messages without repeating Meta setup or rotating credentials.
- Show provider-backed connections as connected using truthful server evidence.

## Non-goals

- Reconnect or otherwise change Kristina's provider account in this workstream.
- Store Meta tokens, app secrets, WABA IDs or Phone Number IDs in Supabase-readable configuration.
- Enable a new drain schedule, create a WABA, transfer a phone number, or change Meta Business ownership.
- Add workspace-owned WhatsApp accounts or automatic studio-wide sharing.
- Replace the Vladimir-only emergency existing-account token path.

## Actors and scope

- User/actor: an active CRM owner or booking manager with `can_manage_integrations` for the selected artist.
- Artist/workspace scope: artist-owned production WhatsApp integrations only; every route remains isolated to one artist.
- Environments affected: CI and production. Staging metadata remains separate and cannot select production bindings.

## User scenarios

### Scenario 1: A future artist connects WhatsApp

Given an active artist with an enabled `<artist-slug>-production` WhatsApp route and an authorized operator, when Embedded Signup returns a valid authorization code and Meta confirms exactly one selected WABA/phone pair, then the CRM writes that artist's separate encrypted bindings, verifies the provider and binding readbacks, subscribes the WABA, and marks only that route connected.

### Scenario 2: A signed inbound message is routed

Given multiple artist credential bindings, when Meta sends a correctly signed webhook containing a WABA and Phone Number ID, then exactly one binding must match both the signature and provider identity before the Worker supplies artist ID and integration key to the ingestion RPC.

### Scenario 3: Ambiguous or invalid routing fails closed

Given duplicate binding selectors, duplicate provider phone identity, an identity mismatch inside a credential envelope, an unknown WABA/phone pair, a bad signature, or missing credentials, when a webhook or provisioning request arrives, then no message is persisted for a guessed/default artist and no other artist's credential is used.

### Scenario 4: Vladimir remains online

Given Vladimir's existing legacy encrypted envelopes and real production messages, when the universal Worker is deployed, then his route continues to accept signed inbound traffic without a Meta reconnection or secret rotation.

## Functional requirements

- FR-001: The CRM MUST offer Embedded Signup to every active artist the operator is authorized to manage, after that artist's exact production route is prepared and enabled.
- FR-002: The provisioning backend MUST resolve the integration key and binding name from authoritative artist/route data, not from a source-code artist allowlist or a browser-supplied selector.
- FR-003: A production artist WhatsApp integration key MUST equal `<current-artist-slug>-production` and MUST be unique within artist-owned WhatsApp routes.
- FR-004: Each newly provisioned encrypted envelope MUST carry its own artist ID, integration key, WABA ID, Phone Number ID, access token and app secret, and MUST be stored under the deterministic binding name for that integration key.
- FR-005: The webhook Worker MUST discover artist routes from encrypted artist bindings at runtime and MUST NOT contain a default artist.
- FR-006: The webhook Worker MUST require an exact signature plus WABA ID plus Phone Number ID match to one route before ingestion.
- FR-007: The rollout MUST retain a generic compatibility path for pre-existing legacy envelopes that lack embedded artist identity, using existing server environment metadata rather than hard-coded artist entries in source.
- FR-008: Provisioning MUST verify Meta identity, WABA/phone membership, WABA subscription and both Worker secret-name inventories before connected state is recorded.
- FR-009: A generic authenticated completion operation MUST update only the exact authorized, enabled, empty-configuration production WhatsApp route and MUST generate the timestamp server-side.
- FR-010: Existing provider-backed Vladimir state MUST remain intact; no synthetic production client, conversation or message may be created for acceptance.

## Security and trust requirements

- SR-001: Browser `artist_id`, authorization code and session IDs are untrusted requests. Server-side profile, membership, capability, active-artist and route checks remain authoritative.
- SR-002: Browser input MUST NOT select an integration key, binding name, provider account, credential or webhook destination.
- SR-003: Meta tokens, app secrets, WABA IDs and Phone Number IDs MUST remain in Cloudflare Worker secrets and transient provider calls, never in Postgres-readable configuration, logs, GPT/MCP payloads or audit metadata.
- SR-004: Credential envelopes MUST be internally self-consistent: their integration key must reproduce the actual binding name and their artist ID must be valid.
- SR-005: Duplicate artist IDs, integration keys, binding names or provider Phone Number IDs in the active webhook route set MUST make routing unavailable rather than choosing one.
- SR-006: The privileged WhatsApp ingestion RPC allowlist and its existing same-artist/integration checks MUST remain unchanged unless separately proven necessary.
- SR-007: Existing RLS, `manage_integrations` capability checks and no-direct-update table grants MUST remain authoritative; UI visibility alone grants nothing.

## Failure and recovery behavior

- No Cloudflare secret write occurs before CRM authorization, exact route validation, code exchange and Meta WABA/phone validation succeed.
- If one Worker secret write succeeds and a later step fails, the route is not marked connected. Retrying overwrites only the same deterministic artist binding names.
- A malformed or colliding route configuration fails closed for webhook ingestion and emits only a stable credential-free error code.
- Unknown signed WABA/phone events are acknowledged without persistence so the Worker never guesses an artist.
- Provider or Cloudflare failure does not delete existing conversations/messages or disable Vladimir's route.

## Data and retention expectations

Supabase continues to store only safe artist integration metadata, conversations, messages and content-free audit records. Credential envelopes stay in Cloudflare secrets. The only new durable database behavior is a routing-key invariant and a server-generated connected timestamp for the exact authorized route. Existing production rows are not rewritten except when a real future provisioning completes.

## Acceptance criteria

- AC-001: Production readback shows Vladimir's exact route enabled and connected, with the same real conversation/message counts and empty safe configuration after rollout.
- AC-002: Unit tests prove routing for Vladimir legacy credentials, a newly provisioned third artist, and multiple valid artists without source allowlists.
- AC-003: Tests prove duplicate route keys/binding names, duplicate Phone Number IDs, wrong WABA/phone pairs, partial embedded identity and missing credentials fail closed without an ingestion RPC.
- AC-004: pgTAP proves exact `<slug>-production` keys, global artist WhatsApp key uniqueness, authorization denial, disabled/non-empty routes and server-generated completion timestamps.
- AC-005: Provisioning contract tests prove an authorized future artist receives a derived binding, while unauthorized artists, mismatched route keys, invalid WABA/phone membership and missing Cloudflare readbacks perform no connected-state update.
- AC-006: Exact-head required CI is green for the final PR SHA.
- AC-007: Production migration, webhook Worker and CRM Pages deployments are tied to the merged exact SHA and independently read back.
- AC-008: Production acceptance uses existing legitimate Vladimir data and safe service-level probes only; Kristina's route and customer data remain unchanged.

## Dependencies and constraints

- The existing Meta app, Embedded Signup configuration and Cloudflare credential-management bindings remain available.
- Cloudflare does not expose secret values for readback; verification is limited to exact secret names and runtime behavior.
- Migration number `0128` is already used by open parallel PR #588, so this workstream reserves the next non-conflicting migration number and rechecks canonical before merge.
- WhatsApp provider consent is interactive and remains `ui_only` in the GPT operator-parity inventory.

## Open questions

None. Workspace-owned WhatsApp routing is explicitly deferred.

## Requirement changes

- 2026-09-01: Created from the verified production state. The earlier `connected_at=null` issue is already reconciled by migration `0127`, so no second Vladimir backfill is required.
- 2026-09-01: Implementation analysis found no blocking or high-severity spec/code conflict. Production contains only exact `vladimir-production` and `kristina-production` routes, so migration `0129` passes its fail-before-write drift predicates without rewriting either row.
