# Phase Q-R: MCP domain contracts and dormant transport

Status: implemented as a dormant code path. Nothing is deployed, routed or enabled by this phase.

## Purpose

MCP is a transport over Vishar CRM, not a second authorization system. Phase Q-R exposes a small, reviewable set of CRM domain tools that use the same authenticated profile, Artist memberships, capability registry, RLS and named RPCs already used by the private CRM.

There is no generic SQL tool, generic table tool, generic RPC tool, provider credential tool, integration administration tool or direct client-message send tool.

## Artist context

`crm_list_artist_contexts` is the discovery operation. It returns only Artists the signed-in profile can already access together with the capabilities that profile already has on each Artist.

Artist-scoped tools accept an `artist_id` returned by that operation. The identifier is a selector, never an authority token. Before any scoped read, the domain layer re-checks the required capability for that exact Artist through `public.list_capabilities`. RLS remains authoritative below that check.

This means a model can ask to work in Vladimir or Kristina context, but naming another Artist cannot create access to that Artist.

## Core domain surface

The initial Phase Q-R core is intentionally narrow and read-oriented:

- `crm_list_artist_contexts`
- `crm_list_enquiries`
- `crm_get_enquiry`
- `crm_list_projects`
- `crm_list_appointments`
- `crm_list_automation_rules`

Operational projections are fixed in code. Finance columns, provider routing, Storage paths and secrets are not exposed. The adapter carries only the caller's CRM access token and the Supabase publishable key. It never holds a Supabase service key.

## Gmail reuse

The existing transport-neutral Gmail contract remains canonical:

- `crm_email_history_search`
- `crm_email_thread_get`
- `crm_email_reply_draft_create`

When explicitly enabled in a future deployment, the MCP adapter delegates these tools to the existing Gmail Worker through a service binding and forwards the same human CRM bearer token. It does not reproduce Google OAuth, refresh-token custody, mailbox routing or Gmail API logic.

The Gmail contract still has no direct send tool. Outbound mail remains:

`read -> CRM draft -> explicit human approval -> existing approved-email outbox -> Gmail drain`

Inbound email content keeps its existing `untrusted_content` marker.

## MCP protocol

The dormant adapter targets MCP `2026-07-28` and is stateless:

- `POST /mcp` only;
- bearer authentication required before any MCP operation;
- `MCP-Protocol-Version`, `Mcp-Method` and, for `tools/call`, `Mcp-Name` must agree with the JSON-RPC request;
- protocol/client capability metadata is required on every request;
- `server/discover`, `tools/list` and `tools/call` are supported;
- no MCP session id, server-side conversational state or KV session store is introduced.

Tool lists are marked private-cacheable because future capability-aware projection may vary by authenticated profile.

## Deployment boundary

`wrangler.mcp.toml` is deliberately inert:

- `workers_dev = false`;
- `preview_urls = false`;
- no route;
- `MCP_ENABLED = false`;
- Gmail tools disabled;
- no OAuth resource registration;
- no service binding;
- no secret or publishable key committed.

A production MCP rollout is a separate guarded change. It must add the production hostname, OAuth resource/client registration, publishable key, rate limit and any Gmail service binding only after the S-T user-centric authorization work is validated.

## Relationship to S-T

Phase Q-R does not change `crm_private.gpt_action_clients` and does not try to solve the current Custom GPT client-to-one-Artist binding. S-T owns that migration.

The important boundary established here is that the assistant transport does not become the permission system. S-T can move Custom GPT authentication to profile membership plus active Artist context without giving MCP or GPT arbitrary database/provider authority.

## Validation

`scripts/test-mcp-domain-contracts.mjs` pins:

- fail-closed feature flag and bearer wall;
- MCP 2026-07-28 version/header agreement;
- bounded tool inventory;
- no SQL/RPC/provider credential arguments;
- capability check before Artist-scoped row access;
- user bearer plus publishable-key forwarding only;
- Gmail delegation to the existing service boundary;
- draft-only outbound Gmail surface;
- safe error projection.

`.github/workflows/mcp-domain-validation.yml` runs those contract tests and a Wrangler dry-run of the dormant Worker. No job in this phase deploys it.
