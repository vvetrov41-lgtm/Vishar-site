# Plugin MCP OAuth release gate

Audit snapshot: 2026-09-30. Recheck every item against the exact release SHA and live services before enabling a bound Plugin OAuth client.

## Existing boundary

- The Plugin resource identifier is `https://mcp.vishartattoo.com/mcp`. The MCP Worker advertises Supabase Auth as its authorization server and requires a bearer token.
- The Worker decodes `iss`, `aud`, `exp`, `sub`, `scope`, `resource` and `client_id`, then asks Supabase Auth `/auth/v1/user` to validate the actor. Existing GPT Action handlers and database RPCs perform their own client, profile, Artist, workspace and capability checks.
- The Plugin implementation requires the token to be bound to the MCP resource, include the `email` scope, and match the exact dedicated `MCP_PLUGIN_OAUTH_CLIENT_ID`. Without that client binding, OAuth discovery is allowed but every bearer token is rejected before any CRM handler is called.
- The old GPT Actions OAuth bridge is callback-specific. Its redirect URI validation and token exchange cannot be reused as the Plugin client.
- The production database currently contains only legacy manually registered GPT OAuth clients. No dedicated Plugin OAuth client is pinned at this snapshot. The production migration head is `20260930150000`.
- The private Vishar CRM Plugin package has been created from `plugins/vishar-crm/`; this does not activate the production MCP resource server or grant CRM access.

## Two-phase production rollout

### Phase A — discovery bootstrap

1. Use the dedicated `MCP Plugin production bootstrap` workflow from an immutable same-tree release commit whose parent is the exact canonical CRM SHA.
2. Re-prove exact-head CI, production Supabase target, migration dry-run, Cloudflare route/bindings and tracked fail-closed flags immediately before mutation.
3. Stage the custom domain with every MCP flag disabled and prove both OAuth metadata and `/mcp` return 404.
4. Re-deploy with only `MCP_ENABLED=true` and `MCP_PLUGIN_TOOLS_ENABLED=true`; keep Gmail and Meta MCP flags false and do not bind `MCP_PLUGIN_OAUTH_CLIENT_ID`.
5. Read back the Worker, custom domain, service binding, rate limit and flags. Acceptance requires protected-resource metadata to return 200 while unauthenticated and bogus-token MCP calls return 401. Because no OAuth client ID is bound, all bearer access remains fail-closed.

### Phase B — dedicated client binding and acceptance

1. Let ChatGPT identify/register its OAuth client through the supported OpenAI flow (CIMD, DCR or a predefined client as actually negotiated by the live authorization metadata). Do not reuse either legacy GPT client.
2. Read the newly created Supabase OAuth client back without exposing any client secret. Verify its registration type, redirect URI/client metadata, creation time and that it belongs to the Vishar CRM Plugin connection.
3. Prove the authorization server supports PKCE S256 and that the authorization/token flow carries the canonical `resource=https://mcp.vishartattoo.com/mcp` value. Inspect only a redacted claim set; never log or report a raw token.
4. Pin that exact client ID as `MCP_PLUGIN_OAUTH_CLIENT_ID` in the MCP Worker and reject every other OAuth client, including the legacy GPT clients.
5. Exercise malformed, expired, revoked, wrong-resource, wrong-scope and wrong-client tokens, plus Artist membership and cross-workspace denial through the existing server-side CRM boundary.
6. Complete a signed-in live Plugin acceptance on legitimate existing CRM data. Prefer read-only calls first; do not create fake clients, appointments, deposits or payments. Keep legacy GPT Actions live in parallel until parity is proven.

## Activation criteria

- Immutable release lineage and all required exact-head CI are green.
- Production Supabase has no pending migration drift.
- `mcp.vishartattoo.com` is bound only to `vishar-mcp-production`; `workers.dev` and preview URLs are disabled.
- The MCP Worker contains only the publishable Supabase key, rate limit and bounded `GPT_ACTIONS_SERVICE` binding; no service-role key, provider credential or OAuth client secret is installed.
- Protected-resource metadata identifies the exact MCP resource and Supabase authorization server.
- The dedicated Plugin client is the only accepted OAuth `client_id`; wrong-resource or legacy tokens fail closed.
- Gmail/Meta MCP side surfaces remain disabled during the Plugin migration unless separately reviewed.
- Production readback and signed-in Plugin acceptance succeed before the legacy GPT path is considered removable.

References: https://developers.openai.com/plugins/build/auth ; https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication
