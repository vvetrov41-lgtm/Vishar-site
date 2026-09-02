# GPT Cloudflare Control Plane

## Status

Draft implementation specification for a private Cloudflare control plane exposed to reviewed Vishar GPT clients.

Target stack parent: PR #588 (`agent/gpt-firecrawl-web-research`) at `e2d41cc3c716f8d06df0efd6dd6ea8dac9f21f25` when this feature branch was created.

Parallel migration owner: PR #589 reserves migration `0129`. This feature reserves `0130` and must be replayed or renumbered if the migration lineage changes before merge.

## Problem

The Cloudflare MCP transport is not available in the current ChatGPT environment. The owner still needs the Vishar GPT surface to inspect and operate the Cloudflare infrastructure used by Vishar CRM without exposing a Cloudflare API credential to ChatGPT, browser code, Supabase, GitHub, logs, or public endpoints.

A dedicated Cloudflare Worker named `vishar-cloudflare-gateway` already exists in the production account. Its `workers.dev` route is disabled and its `CLOUDFLARE_API_TOKEN` is stored as a Cloudflare Worker secret. The token is intentionally broad enough for developer administration.

## Product outcome

An authorized owner GPT can perform named Cloudflare infrastructure operations through the existing `vishar-gpt-actions-production` OAuth boundary. That Worker calls `vishar-cloudflare-gateway` over a Cloudflare Service Binding. The gateway then calls the Cloudflare REST API with its private bearer token.

The token may be broad. The GPT-facing contract must not be a generic HTTP proxy, generic RPC, arbitrary SQL surface, or arbitrary provider execute endpoint.

## Actors

- **Owner GPT client**: an active OAuth GPT client explicitly granted Cloudflare-control capability.
- **Vishar GPT production Worker**: public OAuth/rate-limit/host boundary and semantic action router.
- **Cloudflare gateway Worker**: private service-bound Worker that owns the Cloudflare API token and provider-specific request construction.
- **Cloudflare API**: external control plane.

## Security invariants

1. `CLOUDFLARE_API_TOKEN` exists only as a secret on `vishar-cloudflare-gateway`.
2. No request or response may return, echo, log, serialize, or forward that token outside the gateway's outbound Cloudflare request.
3. `vishar-cloudflare-gateway` has no public route, no `workers.dev` exposure, and is reached from GPT only by Service Binding.
4. Every GPT Cloudflare action requires a valid GPT OAuth bearer, active CRM profile, active GPT client context, explicit `can_use_cloudflare_control` client ceiling, and current `public.is_owner()` authorization.
5. GPT input may express resource names and desired changes, but it may not supply an authoritative Cloudflare account ID or arbitrary Cloudflare API path/host/method.
6. The gateway derives the Cloudflare account from the token-visible account set and fails closed unless exactly one account is visible.
7. Zone operations resolve an exact zone name server-side and fail closed on missing or ambiguous resolution.
8. Secret values are not accepted by any GPT Cloudflare action. Worker secret creation/rotation remains outside the GPT action surface.
9. D1 arbitrary SQL/raw/import/export, arbitrary KV value writes, arbitrary R2 object writes, API-token administration, billing, membership administration, and generic provider proxying are not part of this feature.
10. Consequential mutations are explicitly marked consequential in OpenAPI and use operation-specific validation.
11. Provider errors are normalized. Authorization headers and raw provider bodies that could contain sensitive data are never returned.
12. Response and request sizes are bounded.

## Initial action surface

### Read actions

- `getCloudflareAccount`
- `listCloudflareZones`
- `listCloudflareWorkers`
- `getCloudflareWorker`
- `listCloudflareWorkerDeployments`
- `listCloudflarePagesProjects`
- `listCloudflareD1Databases`
- `listCloudflareKvNamespaces`
- `listCloudflareR2Buckets`
- `listCloudflareDnsRecords`
- `listCloudflareWorkerRoutes`

### Write actions

- `deployCloudflareWorkerCode`
  - accepts a validated Worker script name and JavaScript/module source;
  - uses Cloudflare's script-content update endpoint so code changes do not intentionally replace Worker metadata or bindings;
  - rejects the gateway's own script name to avoid self-replacement through the control channel.
- `deleteCloudflareWorker`
  - requires exact script name plus an explicit confirmation field equal to the script name;
  - rejects deletion of `vishar-cloudflare-gateway` and `vishar-gpt-actions-production`.
- `upsertCloudflareDnsRecord`
  - resolves zone by exact name;
  - creates or updates a DNS record by explicit record ID/name/type semantics without arbitrary provider payload forwarding.
- `deleteCloudflareDnsRecord`
  - resolves zone by exact name;
  - requires record ID plus explicit confirmation.
- `purgeCloudflareCache`
  - supports either explicit URL list or `purge_everything=true`, never arbitrary purge payloads.
- `upsertCloudflareWorkerRoute`
  - resolves zone by exact name;
  - accepts route pattern and Worker script name only.
- `deleteCloudflareWorkerRoute`
  - resolves zone by exact name;
  - requires route ID plus explicit confirmation.

The first implementation may stage a subset of the write actions if a provider contract cannot be validated safely. Read-only inventory plus Worker-code deployment is still a useful first convergence point.

## Non-goals

- Recreating the entire Cloudflare API as one passthrough endpoint.
- Letting ChatGPT provide or retrieve Cloudflare API tokens or Worker secret values.
- Replacing Cloudflare dashboard account-security workflows.
- Bypassing existing GPT OAuth, profile, capability, rate-limit, host, or Artist-context controls.
- Moving Cloudflare credentials into Supabase.
- Automatically deploying this feature to production merely because code/CI is green.

## Failure behavior

- Disabled feature or operation: `404 not_found` before Cloudflare subrequests.
- Missing OAuth bearer: `401 oauth_token_required`.
- Invalid/expired OAuth or owner/capability denial: normalized authorization response, no gateway call.
- Missing Service Binding: `503 cloudflare_gateway_unavailable`.
- Missing gateway token: gateway returns `503 cloudflare_not_configured` without provider call.
- Account visibility count other than one: `503 cloudflare_account_scope_invalid`.
- Unknown/ambiguous exact zone: `404 zone_not_found` or `409 zone_ambiguous`.
- Invalid semantic input: `400` with stable error and field.
- Cloudflare provider failure: bounded normalized error without authorization material.
- Oversized provider response: `502 cloudflare_response_too_large`.

## Rollout boundary

Code, migration, OpenAPI and CI can be prepared in this branch. Production deployment, database migration application, GPT schema import, capability activation and Cloudflare Worker replacement are separate rollout mutations and require fresh exact-head / production-state checks before execution.
