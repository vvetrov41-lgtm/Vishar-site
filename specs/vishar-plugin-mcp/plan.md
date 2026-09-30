# Plan — Vishar CRM Plugin MCP migration

## Architecture

Use the existing `vishar-mcp` Worker and `mcp.vishartattoo.com` endpoint. Add a generated Unified Plugin tool registry beside the existing small read-only MCP domain, rather than creating another edge stack.

The Plugin registry is compiled from the same Unified GPT sources:

1. `operator-parity.current.mjs` decides which operator actions are eligible and supplies consequence metadata.
2. `build-gpt-unified-openapi.mjs` / committed unified schemas remain the exact external request-contract source for legacy and declarative operations.
3. A new build step compiles those contracts to a static MCP tool manifest used by the Worker.
4. Tool calls are adapted back into the existing `handleGptActionsRequest` execution path with the actor bearer token preserved, so the existing route/RPC/provider authorization remains authoritative.

This yields one execution path for GPT Actions and MCP during migration.

## Phases

### Phase 1 — Contract compiler and parity tests

- Add a generated MCP manifest for the 13 Unified domains.
- Keep stable operation IDs in metadata; expose deterministic MCP-safe names.
- Map MCP arguments to the existing Action path/query/body contract.
- Attach safety annotations from parity consequence.
- Exclude all `ui_only`, owner-excluded and invitation-stage operations.
- Add drift tests comparing the generated manifest with Unified GPT projections.

No production feature flag is enabled in this phase.

### Phase 2 — Runtime adapter

- Add the Plugin tool registry behind `MCP_PLUGIN_TOOLS_ENABLED=false` by default.
- Resolve an MCP tool by name and construct the existing bounded HTTP request in-memory.
- Call the existing GPT action handler with the same actor bearer token and environment.
- Normalize Action JSON responses into MCP structured tool results.
- Preserve body/response limits and safe error mapping.
- Keep current read-only MCP, Meta and Gmail gates unchanged.

### Phase 3 — Plugin auth/package

- Verify the MCP protected-resource metadata against current Plugin requirements.
- Add/adjust scopes only where required; do not use model instructions as an authorization boundary.
- Create the private Plugin package/skill pointing to `https://mcp.vishartattoo.com/mcp`.
- Preserve relevant Unified GPT operating instructions and human-consent rules.

### Phase 4 — Production activation

- Extend existing MCP rollout gates/readback for `MCP_PLUGIN_TOOLS_ENABLED`.
- Deploy disabled first; prove route remains fail-closed.
- Activate only at immutable canonical SHA with required CI green and no DB drift.
- Read back Cloudflare bindings/version/routes and secret boundary.
- Run authenticated read acceptance first, then narrowly scoped write acceptance without fake customer data.

### Phase 5 — Cutover

- Connect the private Plugin.
- Verify representative operations from every enabled consequence class/domain.
- Keep GPT Actions as rollback/transition path until Plugin acceptance is complete.
- Retire GPT-specific infrastructure only in a later bounded workstream.