# Plan

## Boundary

Extend the existing dormant `vishar-mcp` Worker. Do not add another Worker, route, service-role client or Meta credential binding.

## Implementation

1. Add a transport-neutral Meta diagnostic domain using the existing actor-scoped Supabase gateway.
2. Read only allow-listed columns from `artist_integrations` and `communication_messages`.
3. Require CRM capabilities before each diagnostic read.
4. Register the tools in `mcp-server.js` behind `MCP_META_TOOLS_ENABLED`.
5. Keep both global MCP and Meta-specific flags false in committed production config.
6. Add contract tests for flag gating, capability enforcement, field exclusion, bounded filters and forbidden arguments.
7. Extend MCP validation CI to run the new tests and dormant Worker dry-run.

## Validation

- Exact-head MCP contract tests.
- Exact-head Meta diagnostic tests.
- Wrangler dry-run of dormant MCP Worker.
- Repository secret scan.
- PR mergeability and fresh-base check.
- Post-merge canonical SHA and CI readback.

## Production

This change does not activate MCP or Meta diagnostics. Production activation requires a later fail-closed rollout with Cloudflare route/binding inventory, OAuth resource validation, rate limiting and post-deploy acceptance.
