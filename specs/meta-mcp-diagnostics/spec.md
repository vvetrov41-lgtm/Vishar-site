# Meta MCP Diagnostics

## Outcome

Allow the Vishar CRM MCP server to inspect CRM-side WhatsApp and Instagram connection health and message delivery status without introducing a second provider integration path.

## User value

An authenticated CRM operator can ask GPT whether a Meta channel is connected and whether recent WhatsApp/Instagram messages are queued, sent, delivered, read or failed, while the existing CRM remains the source of truth.

## Functional requirements

1. Add a read-only tool that returns WhatsApp/Instagram integration health for one Artist.
2. Add a read-only tool that returns bounded WhatsApp/Instagram message delivery metadata for one Artist, with optional channel/status filtering.
3. Both tools use the signed-in CRM actor token and existing Supabase RLS/capability checks.
4. Integration health requires `manage_integrations`, matching the current actor RLS policy on `artist_integrations`.
5. Message status requires `view_communications`.
6. The tools are independently hidden unless `MCP_META_TOOLS_ENABLED=true`.
7. The existing global MCP kill switch remains authoritative.

## Security and privacy requirements

- No direct Meta API calls.
- No Meta access tokens, refresh tokens, integration keys, OAuth client secrets or service-role credentials.
- No message body, attachment payload, external account label, integration configuration, provider message ID or created-by identity in tool reads.
- No SQL/table/RPC selector supplied by the caller.
- No send, reply, retry, webhook mutation, onboarding mutation or integration mutation capability.
- Capability failure stops before the diagnostic table read.
- Unknown/additional arguments fail closed.
- Results are bounded to at most 50 message status rows.

## Rollout requirements

- No database migration.
- No route or public endpoint addition.
- `MCP_ENABLED=false` remains in the dormant Worker config.
- `MCP_META_TOOLS_ENABLED=false` is the committed default.
- Activation is a separate production workstream requiring exact-head validation, OAuth/resource boundary validation, production Cloudflare readback and acceptance.

## Non-goals

- Direct provider health probes.
- Sending WhatsApp or Instagram messages through MCP.
- Meta account provisioning or credential rotation.
- Sentry runtime instrumentation. Sentry observability is intentionally a separate bounded change.
