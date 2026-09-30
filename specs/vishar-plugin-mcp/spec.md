# Vishar CRM Plugin MCP migration

## Objective

Replace the expiring Custom GPT Action transport with one private ChatGPT Plugin backed by the existing Vishar CRM MCP resource server, while preserving the current CRM authorization, Artist context, Supabase RLS, idempotency, provider custody and production release boundaries.

The migration must reuse the current Unified GPT operation contracts instead of creating a second independently maintained CRM API.

## Source of truth

- Canonical CRM branch at workstream start: `agent/platform-telegram-self-service`.
- Unified operator inventory: `docs/gpt-actions/operator-parity.current.mjs`.
- Unified GPT schemas: `docs/gpt-actions/unified/*.yaml`.
- Declarative new-operation registry: `workers/lib/gpt-domain-operations.js`.
- Existing action gateway: `workers/lib/gpt-actions-combined.js`.
- Existing MCP transport/auth boundary: `workers/lib/mcp-server.js` and `workers/lib/mcp-domain.js`.
- Production MCP host: `https://mcp.vishartattoo.com/mcp`.

Generated Plugin/MCP contracts must be derived from those sources and fail validation when they drift.

## Functional requirements

### FR-1 One MCP endpoint

The Plugin uses one Streamable HTTP MCP endpoint at `https://mcp.vishartattoo.com/mcp`. The 13 former GPT Action domains become tool groups, not separate MCP servers or hosts.

### FR-2 Unified operation parity

Every non-UI-only operation included by the current Unified GPT projection must have an MCP tool contract unless this specification explicitly excludes it. Tool input schemas must preserve the same required fields, validation ranges, enum values and additional-property rejection as the existing Action contract.

The migration must not introduce arbitrary SQL, arbitrary RPC, arbitrary table access, arbitrary URL fetching or model-selectable provider credentials.

### FR-3 Reuse existing execution paths

MCP tools must execute through the already audited GPT/CRM operation mappings or the same named RPC/provider boundary. Do not duplicate CRM business logic in the MCP layer.

The signed-in actor token remains the authority passed to Supabase. The MCP Worker must not receive a Supabase service-role key or provider secret merely to obtain feature parity.

### FR-4 Preserve deliberate exclusions

These owner-excluded operations remain UI-only and must not become MCP tools:

- `deleteMyAccount`
- `transferWorkspaceOwnership`
- `setSelfServiceSignup`
- `getSelfServiceSignupPolicy`
- `getControlPlaneAccess`

Device-local upload, pre-profile signup and external provider consent remain human/UI handoffs as classified in the parity inventory.

`inviteStaffMember` and `inviteArtist` remain outside the initial Plugin write surface until their separate invitation/security review is accepted.

### FR-5 Consequence and safety metadata

Each generated MCP tool must carry truthful safety metadata derived from the parity inventory and execution contract. At minimum distinguish:

- read-only operations;
- ordinary CRM writes;
- provider-send/external-side-effect operations;
- money operations;
- permission/administration operations.

Metadata must not mark a write as read-only or a potentially destructive operation as safe/idempotent unless the underlying contract proves it.

### FR-6 Actor and Artist isolation

The model must never select authority by passing `artist_id`, `workspace_id`, `oauth_client_id`, `integration_key`, access tokens, refresh tokens, client secrets, service-role credentials, SQL or RPC names to ordinary tools.

Artist selection remains the bounded context operation backed by server-side membership checks. Every subsequent operation re-checks the signed-in profile, active Artist context, client ceiling and CRM capability/RLS rules.

### FR-7 OAuth resource-server boundary

The Plugin connects using the MCP protected-resource flow. The MCP server must publish protected-resource metadata, challenge unauthenticated requests, and accept only bearer credentials that the downstream CRM/Supabase boundary validates for the signed-in human.

OAuth/provider consent that physically requires the account holder remains a user step. Secrets are entered only in their target service and are never committed or echoed.

### FR-8 Backward-safe activation

Full Plugin tools are feature-gated independently from the already deployed read-only MCP surface. Tracked production configuration remains fail-closed. Enabling the Plugin tool surface must not silently enable Gmail, Meta, provider-send, money or permission tools beyond their explicit gates and existing capability checks.

### FR-9 Plugin package

The repository must contain a reproducible private Plugin package definition/skill that points to the MCP endpoint and explains Vishar CRM operating rules. Plugin instructions must preserve the model-level guidance from Unified GPT v2 where it remains applicable, but server-side authorization must never depend on those instructions.

### FR-10 Validation and release

Before production mutation:

1. regenerate/check the MCP tool manifest from the current parity/OpenAPI sources;
2. prove excluded and UI-only operations are absent;
3. prove tool names are unique and schemas reject undeclared authority fields;
4. run existing MCP transport/domain tests and Wrangler dry-run;
5. run exact-head required CI;
6. verify production Supabase migration head and Cloudflare route/bindings;
7. re-check canonical branch immediately before mutation.

After production mutation:

1. read back the exact active Worker version and bindings;
2. prove workers.dev/preview exposure remains disabled;
3. prove no privileged credential is bound;
4. exercise unauthenticated discovery/auth challenge;
5. with an authorized real actor, list tools and run non-destructive acceptance reads;
6. verify representative bounded writes only through existing legitimate records or controlled rollback-safe mechanisms; do not create fake production customers.

## Acceptance criteria

- A private Vishar CRM Plugin can discover and call the approved MCP tools through one endpoint.
- Tool coverage equals the approved non-UI-only Unified GPT surface for the release candidate, with explicit exclusions above.
- No operation gains broader data or permission scope than its existing CRM/GPT counterpart.
- No service-role/provider secret is present in the Plugin package, MCP tool arguments or MCP Worker bindings.
- Production deployment is exact-head, fail-closed, read back and acceptance-verified.
- The old GPT Action deployment remains available as rollback/transition infrastructure until Plugin acceptance is complete.