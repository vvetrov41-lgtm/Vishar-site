# GPT Actions production rollout

This runbook covers the Vishar CRM target architecture: **one profile-bound Vishar GPT for authenticated CRM users**, with modular semantic Action domains that approach authorized operator parity with the CRM. The existing Vladimir and Kristina artist-bound GPT clients remain compatibility and rollback surfaces until a later, separately accepted retirement stage.

Do not infer live production state from this file. Before every activation, capability change, schema repartition or external GPT update, perform fresh readback of the exact repository head, production Supabase, Cloudflare GPT edge and the external GPT/OAuth configuration.

## Target identity model

```text
Custom GPT OAuth token
  -> OAuth application: vishar-unified-gpt
  -> auth.uid(): signed-in CRM profile
  -> current workspace / Artist memberships
  -> server-owned active Artist context
  -> GPT client capability ceiling
  -> operation-specific CRM capability
  -> bounded Vishar domain operation
```

The OAuth client identifies the **application**, not an Artist. In profile-bound mode, `crm_private.gpt_action_clients.artist_id` is null by design. Artist scope is derived from the signed-in profile and current memberships on every request.

The database, not GPT instructions, OpenAPI or the transport, is authoritative.

## Current deployed transport versus target product surface

At the time this runbook was corrected, repository production artifacts still represented the current GPT Action transport as:

- Core host: `https://gpt-actions.vishartattoo.com`;
- Operations host: `https://gpt-operations.vishartattoo.com`;
- Core schema: `docs/gpt-actions/openapi.production.core.yaml`;
- Operations schema: `docs/gpt-actions/openapi.production.operations.yaml`;
- model instructions: `docs/gpt-actions/instructions.v2.md`.

Those files describe the **current deployed/importable surface**, not the final Unified GPT product boundary. Current repository tests show 28 Core plus 29 Operations operations with a hard per-schema ceiling of 30. That layout has insufficient headroom for full CRM/integration parity.

Before a new Unified GPT Builder rollout, the action surface must be reconciled against `specs/unified-gpt-v2/` and the operator-parity inventory. Communications must return to a separate semantic domain, and additional domains such as Scheduling, Finance, Automation/Notifications, Integrations/Admin and Research may be separate schemas as required by the current inventory.

All domains share one OAuth application identity and the same server-owned profile/workspace/Artist authorization model.

## Operator-parity rule

For every meaningful user action available in Vishar CRM or through a supported Vishar integration, the platform must either:

1. expose a narrow named GPT/MCP domain operation through the existing authorization model; or
2. record a deliberate UI-only boundary with a concrete reason, such as unavoidable provider OAuth/consent, device-local binary interaction, or the absence of a safe server contract.

Do not create generic SQL, arbitrary RPC, arbitrary provider proxy or `executeAnything` operations to achieve parity.

The parity inventory covers at least:

- Clients;
- Enquiries;
- Projects;
- Sessions / Scheduling / Calendar;
- Finance / deposits / Monzo;
- Communications: Gmail, WhatsApp, Instagram and future supported channels;
- Notifications / Follow-ups / Templates / Automations;
- Integrations;
- Booking Sources;
- Team / Artist / Workspace administration;
- Web Research / Project Web References / saved Research.

## Fixed production boundaries

- Production Supabase project: `vfjexhfdbrjmuxfdvbdx`.
- Production CRM origin: `https://crm.vishartattoo.com`.
- Fixed Supabase OAuth callback through the Worker: `https://gpt-actions.vishartattoo.com/oauth/callback`.
- Retained staging must never be used as the production OAuth/database target.
- The GPT Worker forwards the signed-in user's OAuth bearer token plus the production publishable key. It carries no Supabase service-role/secret key for GPT business actions.
- `/v1/context` is the only GPT route allowed to accept an `artist_id`, and the database treats it only as a selector subject to current membership checks.
- No generic SQL, table or arbitrary RPC action exists.
- OAuth/integration credentials, raw provider routing identities and provider secrets are never GPT Action parameters.

## Production clients

The intended transition is:

```text
vishar-unified-gpt
  binding_mode = profile
  artist_id = null
  one confidential production OAuth client

legacy rollback compatibility:
  vladimir-gpt-actions -> fixed Vladimir Artist
  kristina-gpt-actions -> fixed Kristina Artist
```

The unified client must start dormant: no OAuth client id, inactive, capability ceilings false. Configure it only after external OAuth/GPT configuration and current production edge are freshly verified.

**Never deactivate or repoint the Vladimir/Kristina legacy clients in the same activation step as the unified client.** Their continued operation is the immediate rollback path.

## Artist context

`public.gpt_artist_context(uuid)` is the narrow context contract.

- Context read returns only Artists the current profile may access plus valid active selection state.
- Context selection accepts one Artist id returned by the authorized context read and rechecks active profile, active Artist and current membership.
- A profile with multiple accessible Artists and no valid selection fails closed rather than defaulting to the first Artist.
- A stale selection becomes unusable immediately when membership/profile/Artist access is revoked. The server does not silently switch to another Artist.
- Legacy artist-bound GPT clients remain fixed to their configured Artist and cannot use context selection to escape that scope.

Every ordinary business action remains free of caller-supplied `artist_id`.

## Action domain rules

The canonical product surface is a transport-neutral operation/parity inventory. OpenAPI schemas are projections of it.

Rules for Custom GPT imports:

- hard repository ceiling: no imported schema above 30 operations;
- target: keep each semantic domain at or below 25 operations where practical;
- a domain at 26+ requires repartition review before unrelated additions;
- operation IDs are globally unique across the imported Vishar schemas;
- exact-union tests must prove that the intended Custom GPT surface is neither missing nor duplicating operations;
- all schemas use the same OAuth application and same active Artist context;
- schema/domain movement must not change database authorization or provider routing semantics.

Historical work already proved the minimum three-domain shape: Core / Operations / Communications. Future grouping may be more explicit, for example Core, Scheduling, Finance, Communications, Automation & Notifications, Integrations & Admin, and Research.

Do not proceed with a new Builder import merely because the current two schemas individually fit under 30. Sustainable headroom and the current parity inventory are rollout requirements.

## Provider boundaries

### Gmail

Gmail history, thread reads, drafts and the approval/send pipeline resolve the selected Artist's authorized mailbox server-side. The GPT never selects a mailbox or receives Google tokens.

### WhatsApp

Conversation/history/send and safe integration-management operations derive Artist, WABA/phone route and credentials server-side. Raw Meta identifiers and credentials are not GPT selectors.

### Instagram

Instagram communication actions belong to the Communications domain only after the actual provider integration is production-accepted. They reuse the same conversation ownership and Artist context.

### Google Calendar

Scheduling and safe sync/status operations use the existing Calendar boundary. Provider OAuth remains server-side.

### Monzo

Finance tools use the authoritative reconciliation workflow, including the separation of candidate listing, matching, ignoring and confirmation/settlement. No generic bank API proxy exists.

### Telegram

Internal personal/workspace notification destinations and safe integration controls use existing server contracts. Client-facing Telegram requires a separate reviewed Communications product contract if ever introduced.

### Firecrawl / Web Research

Firecrawl is only a provider behind the Vishar Research gateway. The Unified GPT Research domain includes more than three provider calls: transient deep research, Project Web References, saved Research runs/sources/snapshots and comparison, and later bounded monitoring. Private CRM/client content is never forwarded to Firecrawl.

## OAuth and fixed Worker callback

Create one confidential production Supabase OAuth client for `vishar-unified-gpt` only after rollout preflight and sustainable Action repartition are complete.

Configure every imported Vishar Action domain with the same OAuth application:

- authorization URL: `https://gpt-actions.vishartattoo.com/oauth/authorize`
- token URL: `https://gpt-actions.vishartattoo.com/oauth/token`
- scope: `email`
- token exchange: Basic authorization header
- privacy policy: `https://gpt-actions.vishartattoo.com/privacy`
- schemas from the same immutable repository SHA

The callback displayed by the GPT editor is untrusted input to the relay and is validated by the Worker. Supabase receives only the fixed Worker callback:

`https://gpt-actions.vishartattoo.com/oauth/callback`

The OAuth client secret is shown only during creation/rotation and must be entered directly into the external GPT editor. Never put it in GitHub, CRM data, logs, documentation or chat.

## S256 PKCE bridge

Supabase OAuth requires Authorization Code with S256 PKCE. The production Worker preserves that boundary for GPT clients that do not supply a PKCE challenge themselves:

1. GPT calls `/oauth/authorize` with Client ID, validated callback and `state`.
2. Worker generates a verifier and S256 challenge, substitutes the fixed Worker callback and forwards the authorization request to Supabase.
3. GPT callback, original state, client ID, verifier and expiry remain only inside authenticated encrypted bridge state.
4. Supabase returns the authorization code to the fixed Worker callback.
5. Worker returns an opaque bridge code to the validated GPT callback.
6. GPT exchanges the bridge code at `/oauth/token` with its confidential client credentials.
7. Worker restores the Supabase code/verifier and performs the upstream token exchange.

`GPT_OAUTH_BRIDGE_SECRET` remains a Cloudflare Worker secret and must not enter tracked config or PostgreSQL.

## Capability model

The Action schema is not permission. Database client ceilings and CRM permissions remain authoritative.

Current legacy GPT client ceilings include appointment read/manage, enquiry read, CRM management, finance and communications. The full operator-parity work may require additional explicit ceilings/capability mappings as new domains are exposed. Add them only through reviewed server contracts and audited configuration paths.

A client ceiling never grants more than the signed-in user's current Artist/workspace capability.

Do not directly edit `crm_private.gpt_action_clients` merely because a release is otherwise green.

## Consequential actions

Every write, provider send, settlement, cancellation, permission change or other consequential mutation remains marked consequential in its tool contract. Read-only operations remain non-consequential.

`docs/gpt-actions/instructions.v2.md` is the model behavior contract. In particular:

- manual payment recording/settlement requires exact money intent;
- outbound client messages require explicit exact-content intent/approval;
- email approval/send requires explicit approval;
- appointment changes use current record/version state;
- permission/integration/template/rule changes require the user's actual requested target/change;
- ambiguous transport failure is followed by authoritative state readback before consequential retry;
- retries never change Artist, amount, target, content or date merely to get a successful response.

These interaction rules never replace database authorization or idempotency.

## Notification / Template / Automation extension

Notification/Template Studio is a required Unified GPT domain after its bounded server editing contract is finalized. It must distinguish:

- template definitions;
- notification rules/timing;
- already scheduled notification instances;
- sent/history evidence.

GPT tools may list/read/preview/edit approved fields, manage permitted rule/timing state and enable/disable where the CRM permits it. Sent history remains immutable, and the server-defined effect on already scheduled notifications must be explicit rather than guessed.

Automations similarly expose only typed reviewed rule operations. No generic rule DSL or arbitrary action execution is introduced for GPT.

## Future Vishar MCP/App

Custom GPT Actions are the current production transport. The domain contracts must remain transport-neutral so the same operations can later be exposed through a Vishar remote MCP/App.

MCP/App is a transport evolution, not a second backend or permission system. It reuses the authenticated CRM human identity, current memberships/context, capabilities and provider boundaries.

## Pre-activation fresh-check

Before creating/binding the unified production OAuth client, establish all of the following from live state:

1. Canonical branch HEAD and exact SHA.
2. No conflicting GPT workstream has moved the same contracts.
3. Required exact-head CI is green.
4. Production Supabase project/migration head matches current release lineage.
5. `vishar-unified-gpt` is still `binding_mode=profile` with `artist_id IS NULL` and intentionally dormant.
6. Vladimir/Kristina legacy clients are still active and fixed to their Artists.
7. Current GPT Worker version, custom domains, workers.dev/preview exposure, bindings, rate limit and enable flags are read back from Cloudflare.
8. OAuth discovery endpoints and fixed callback behavior are current.
9. The operator-parity inventory and intended modular schema split are current, all schemas are within capacity with headroom, and exact-union tests are green.
10. The external Custom GPT configuration is known before schema/authentication replacement.
11. Known infrastructure incidents, especially intermittent backend authorization/transport failures, are assessed so they cannot be mistaken for a v2 authorization defect during cutover.

A remembered handoff or old runbook snapshot is not sufficient evidence.

## Activation sequence

### Stage A: repository and surface readiness

1. Merge the exact-head green Unified GPT product contract and parity inventory.
2. Repartition the Action surface into semantic domains with sustainable headroom.
3. Validate exact union, OAuth/context invariants and provider boundaries.
4. Deploy/read back any Action host/router changes before external Builder configuration.
5. No legacy GPT binding change belongs to this stage.

### Stage B: OAuth application

1. Create one confidential production OAuth client for the unified GPT with only the fixed Worker callback.
2. Enter the secret directly into the Custom GPT editor. Do not expose it to repository/chat.
3. Record only the non-secret OAuth client id through the authorized configuration path for `vishar-unified-gpt`.
4. Re-read the database row and verify it remains profile-bound.

### Stage C: capability activation

1. Enable only intended unified GPT capability ceilings through an audited authorized path.
2. Keep legacy clients unchanged.
3. Re-read the unified row and capability state.

### Stage D: exact schema/instruction import

1. Import every required modular Action schema from the same immutable repository SHA.
2. Apply `instructions.v2.md` to the single Custom GPT.
3. Verify every Action domain uses the same OAuth application and production host expected by the exact-SHA contract.

### Stage E: acceptance

Start read-only:

1. Authenticate as a legitimate CRM user.
2. Call Artist context and verify only accessible Artists appear.
3. Select intended Artist if needed and verify context readback.
4. Prove an unauthorized Artist cannot be selected.
5. Read representative records across each enabled domain.
6. Prove provider state follows the selected Artist and previous-Artist records do not leak after switching.

Only after read-only acceptance, exercise consequential actions through legitimate real work when available. Do not create fake production clients, payments or messages for testing.

## Rollback and containment

Use the least destructive containment:

1. Disable/deactivate the unified client or affected capability/domain through an authorized path.
2. Leave Vladimir/Kristina legacy GPT clients active and unchanged.
3. If all GPT Actions must close, use the existing Worker containment path.
4. If OAuth relay itself must close, use the OAuth relay containment path.
5. Revoke/delete the unified OAuth client only for credential compromise or deliberate retirement.
6. Disable Research provider operations without deleting saved Research evidence when Research is the affected domain.

Do not weaken RLS, RPC ACLs, memberships, PKCE, provider credential custody, rate limits or idempotency as rollback shortcuts.

## Historical operator workflows

`.github/workflows/gpt-production-bootstrap.yml` and `.github/workflows/gpt-production-activate.yml` are historical operator workflows tied to the original artist-bound rollout branches. They remain useful as evidence for how the OAuth edge/PKCE bridge was established, but **they are not the Unified GPT v2 activation procedure** and must not be repurposed by moving old release branches.

Any future Worker code rollout must use a newly verified bounded release path for the current canonical lineage and current Cloudflare state. Unified client/OAuth activation is a separate control-plane operation and must not mutate legacy clients as a side effect.
