# Vishar CRM MCP-ready architecture

Status: architecture-ready only. No public MCP endpoint is deployed by this change.

## Goal

Keep Vishar CRM domain operations reusable from more than one assistant transport. The current private Custom GPT continues to use the existing OAuth-protected HTTP/OpenAPI Actions surface, while a future MCP server for Claude or another MCP client can expose the same bounded CRM operations without duplicating provider logic or weakening artist isolation.

## Current Gmail contract

The canonical transport-neutral Gmail tool definitions live in:

`workers/lib/gmail-tool-contract.js`

They currently define exactly three bounded operations:

- `crm_email_history_search` -> current OpenAPI operation `searchEmailHistory`
- `crm_email_thread_get` -> current OpenAPI operation `getEmailThread`
- `crm_email_reply_draft_create` -> current OpenAPI operation `createGmailReplyDraft`

Each definition contains a JSON Schema input contract plus MCP-compatible tool annotations. It deliberately contains no artist id, provider account, integration key, OAuth token, refresh token, client secret or privileged Supabase credential.

## Security boundary

MCP is a transport, not an authorization boundary. A future MCP adapter must authenticate the CRM principal first and resolve the artist scope server-side. It must never accept `artist_id`, Google account identity, integration key or provider credentials as tool arguments.

The authoritative Gmail chain remains:

1. authenticated CRM principal and communications capability;
2. server-resolved enquiry and artist scope;
3. canonical CRM client email;
4. artist-specific Gmail integration;
5. backend-held encrypted refresh token;
6. Gmail API;
7. minimal normalized response.

Raw Gmail thread ids remain backend-only. Assistant transports receive only opaque CRM `thread_context_id` values.

## Email content

Inbound email text is untrusted external content. Any MCP adapter must preserve the existing `untrusted_content` semantics and must not treat message text as tool instructions, authorization, routing metadata or approval to perform mutations.

## Outbound email

There is intentionally no direct Gmail send tool in the transport-neutral contract.

The required workflow stays:

`read thread -> create CRM draft -> explicit human approval -> approved_email outbox -> Gmail drain -> audit/result state`

An MCP client may create a draft, but it must use the same CRM approval workflow before any provider send. Provider retries remain idempotent through the existing deterministic message-id and Gmail lookup logic.

## HTTP/OpenAPI adapter

The existing Custom GPT remains an HTTP/OpenAPI client. `workers/gpt-actions-production-full.js` uses the shared Gmail path matcher from the tool contract before forwarding requests through the `GMAIL_SERVICE` binding.

This keeps current production behaviour unchanged while preventing the Gmail tool inventory from becoming OpenAI-specific business logic.

## Future MCP adapter

A later bounded implementation can add a private MCP Worker/server which:

1. imports `toMcpToolDefinitions()` from `workers/lib/gmail-tool-contract.js`;
2. authenticates an approved CRM/MCP client;
3. resolves the bound artist server-side;
4. invokes the same Gmail service/domain boundary;
5. returns only the same minimal CRM-safe payloads;
6. keeps direct send, integration administration, arbitrary SQL/RPC and provider credentials out of the MCP tool surface.

The MCP deployment should be a separate production change with its own OAuth/client registration, rate limits, audit tests and exact-head CI. It must not reuse Google refresh tokens across artists and must not bypass existing CRM capabilities.

## Non-goals of this change

- no `/mcp` route;
- no public MCP server;
- no Claude-specific authentication configuration;
- no new provider scopes;
- no direct email-send tool;
- no generic database or RPC tool;
- no staging deployment.

## Regression coverage

`scripts/test-gmail-mcp-ready.mjs` verifies that the MCP-ready contract contains only the three bounded Gmail tools, has JSON Schema inputs and MCP-compatible annotations, contains no routing/credential fields, exposes no direct send tool, and does not accidentally publish an MCP endpoint.