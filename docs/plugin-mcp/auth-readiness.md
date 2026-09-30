# Plugin MCP OAuth release gate

Audit snapshot: 2026-09-30. Recheck every item against the exact release SHA and live services before enabling `MCP_PLUGIN_TOOLS_ENABLED`.

## Existing boundary

- The Plugin resource identifier is `https://mcp.vishartattoo.com/mcp`. The MCP Worker advertises Supabase Auth as its authorization server and requires a bearer token.
- The Worker decodes `iss`, `aud`, `exp`, `sub` and `client_id`, then asks Supabase Auth `/auth/v1/user` to validate the actor. Existing GPT Action handlers and database RPCs perform their own client, profile, Artist, workspace and capability checks.
- The current Plugin implementation accepts `aud=authenticated` and any syntactically valid OAuth `client_id` at its edge. It does not yet prove that the token was issued for this MCP resource. Its generated tools request the broad `email` OAuth scope; that scope controls identity data, while CRM authorization remains server-side.
- The old GPT Actions OAuth bridge is callback-specific. Its redirect URI validation and token exchange cannot simply be reused as a Plugin OAuth client.
- The production database has one inactive, unbound profile-mode GPT client and two active artist-mode clients at this snapshot. No Plugin OAuth client is bound to the profile-mode registration. The production migration head is `20260930150000`.

## Activation criteria

1. Obtain the live Supabase authorization-server metadata and prove `S256`, token authentication method, issuer and supported registration mode. Register a dedicated Plugin client with the exact callback shown by OpenAI, or verify compatible dynamic registration. Require explicit human consent.
2. Send the canonical `resource` through authorization and token exchange. Inspect a redacted token claim set and server-side authorization record to prove the MCP resource/audience binding. Reject an otherwise valid CRM/GPT token intended for another resource, including the legacy Action client.
3. Check issuer, resource/audience, expiry, client identity, requested scopes, revocation and authenticated user on every call. Exercise malformed, expired, revoked and wrong-resource tokens. Avoid exposing any token in logs or a report.
4. Bind only the approved Plugin OAuth client to the profile-mode GPT registration. Verify the signed-in user's Artist memberships, selected context and cross-workspace denial through the existing RPC boundary. Keep admin ceilings and provider/money gates at least as narrow as the legacy path.
5. Deploy initially with the full Plugin flag off. Read back the live Worker version, custom domain, `workers.dev`/preview status, bindings and flags. Enable only after exact-head CI and all above probes pass; keep GPT Actions working in parallel.

OpenAI Plugin authentication guidance requires the protected resource metadata, an OAuth 2.1 authorization-code flow with PKCE S256, and the `resource` parameter throughout the flow. Its access token must be rejected when the expected audience or scopes are absent. Supabase documents OAuth 2.1, MCP authentication and user-scoped RLS, but compatibility of this project's live resource-bound tokens still needs direct proof.

References: https://developers.openai.com/plugins/build/auth ; https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication
