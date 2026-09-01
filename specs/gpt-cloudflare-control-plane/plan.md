# Plan: GPT Cloudflare Control Plane

## Revision target

Feature branch created from PR #588 exact head `e2d41cc3c716f8d06df0efd6dd6ea8dac9f21f25`.

Do not modify PR #588 or PR #589 branches. This branch is stacked on #588 so its diff contains only Cloudflare-control-plane work. Before final merge, reconcile #589's reserved migration `0129` and retarget/replay onto the then-canonical lineage.

## Architecture

```text
ChatGPT Action
  -> gpt-operations.vishartattoo.com
  -> vishar-gpt-actions-production
       - host guard
       - rate limit
       - OAuth bearer
       - Supabase owner + client-capability authorization
       - semantic Cloudflare action validation
  -> CLOUDFLARE_GATEWAY Service Binding
  -> vishar-cloudflare-gateway
       - no public route
       - CLOUDFLARE_API_TOKEN Worker secret
       - account/zone resolution
       - operation-specific Cloudflare REST requests
       - response/error normalization
  -> api.cloudflare.com/client/v4
```

## Implementation layers

### 1. Database authorization

Add migration `0130_gpt_cloudflare_control.sql`:

- `crm_private.gpt_action_clients.can_use_cloudflare_control boolean not null default false`;
- `public.gpt_authorize_cloudflare_control()`:
  - call `crm_private.require_gpt_client_context()`;
  - require `public.is_owner()`;
  - require current GPT client ceiling;
- `public.configure_gpt_cloudflare_control_access(integration_key, enabled)` owner-only configuration RPC;
- grant execution only to `authenticated` where appropriate;
- enable the reviewed Vladimir GPT client only in this release;
- add activity log metadata without provider credentials.

Add pgTAP coverage for owner success, non-owner denial, inactive/unknown client denial, disabled ceiling denial, configuration authorization and expected defaults.

### 2. Private Cloudflare gateway Worker

Add `workers/cloudflare-gateway.js` and `wrangler.cloudflare-gateway.production.toml`.

Tracked config requirements:

- `name = "vishar-cloudflare-gateway"`;
- `workers_dev = false`;
- `preview_urls = false`;
- no routes;
- no plaintext Cloudflare token variable;
- production environment marker only.

Gateway contract is internal and operation-specific. It does not accept a caller-selected upstream host, bearer token, account ID or arbitrary API path.

Gateway resolves exactly one token-visible account using the Cloudflare Accounts API and caches only the non-secret account id/name in isolate memory. Zone operations resolve exact zone names within that account.

Provider request helper:

- hard-code `https://api.cloudflare.com/client/v4`;
- add `Authorization: Bearer ${env.CLOUDFLARE_API_TOKEN}` only at outbound fetch;
- use `redirect: "error"`;
- cap provider response bytes;
- return normalized error codes/messages, stripping provider request metadata that is not required by GPT.

### 3. GPT semantic action router

Add `workers/lib/gpt-cloudflare-control.js` and route it from `workers/lib/gpt-actions-combined.js` before generic CRM action handling.

Every route:

1. recognizes only `/v1/cloudflare/...` paths;
2. checks feature/operation kill switches;
3. requires OAuth bearer;
4. calls `gpt_authorize_cloudflare_control` using the caller bearer and publishable Supabase key;
5. validates an explicit JSON schema-like field allow-list;
6. calls `env.CLOUDFLARE_GATEWAY.fetch(...)` with an internal semantic path/body;
7. returns only the bounded normalized response.

The caller OAuth token is not forwarded to the gateway.

### 4. Service Binding and kill switches

Update `wrangler.gpt-actions.production.toml` with:

```toml
[[services]]
binding = "CLOUDFLARE_GATEWAY"
service = "vishar-cloudflare-gateway"
```

Add tracked defaults:

- `CLOUDFLARE_CONTROL_ENABLED = "false"`
- read/write sub-switches as needed, all false by default in tracked production config.

A guarded rollout workflow may enable reviewed switches only after exact-head validation and production readback.

### 5. OpenAPI and operator parity

Create a dedicated production schema `docs/gpt-actions/openapi.production.cloudflare.yaml` using the existing `gpt-operations.vishartattoo.com` host and shared OAuth URLs.

Keep the schema at or below 25 actions. Mark reads non-consequential and mutations consequential. Do not expose `account_id`, provider tokens, arbitrary paths/methods, secret values or generic payload objects.

Update `docs/gpt-actions/operator-parity.mjs` with an explicit Cloudflare infrastructure group. The group is owner-only and must classify unsupported generic provider actions as intentionally excluded rather than accidental gaps.

### 6. Tests

Add focused tests:

- `scripts/test-cloudflare-gateway.mjs`
  - no token/no provider call;
  - account scope exactly-one invariant;
  - zone exact resolution;
  - no arbitrary upstream/path/method forwarding;
  - token never appears in response;
  - list Workers/Pages/D1/KV/R2/DNS/routes mappings;
  - Worker content update uses the provider's content endpoint and bounded source;
  - protected Worker delete denial;
  - DNS/cache/route mutation validation;
  - provider error/response-size handling.
- `scripts/test-gpt-cloudflare-control.mjs`
  - non-route fallthrough;
  - kill switches before authorization/provider work;
  - missing OAuth denial;
  - authorization call before service binding;
  - caller bearer not forwarded to service binding;
  - missing binding denial;
  - exact input allow-lists;
  - normalized service responses.
- config/OpenAPI tests to assert no public gateway route and exact Service Binding.

Wire focused tests into `test:worker`, `test:gpt-production`, and a dry-run bundle check for the gateway.

## Cloudflare API contracts used

The implementation uses documented semantic endpoints rather than a generic proxy, including:

- account-scoped Worker script list/content/deployment APIs;
- account-scoped Pages projects, D1 database list, KV namespace list and R2 bucket list;
- account-filtered zone list;
- zone-scoped DNS record, Worker route and cache-purge APIs.

Worker code deployment uses the script-content update endpoint because Cloudflare documents it as updating content without intentionally touching configuration or metadata.

## Rollout sequence

1. Complete spec, code and focused tests on this branch.
2. Open a draft PR stacked on #588.
3. Wait for #588 and #589 lineage to settle; rebase/retarget and renumber migration if required.
4. Require exact-head CI green.
5. Fresh-read production Cloudflare Worker presence, `workers.dev` disabled state, Service Binding target, and secret-name presence without reading secret value.
6. Apply database migration.
7. Deploy `vishar-cloudflare-gateway` code without replacing its existing secret.
8. Deploy GPT Worker Service Binding + action router with all Cloudflare feature switches off.
9. Import/update the Cloudflare OpenAPI Action schema.
10. Enable Cloudflare control capability for the reviewed owner GPT client.
11. Enable read operations first and verify account/zones/workers inventory.
12. Enable Worker-code write and other reviewed mutations incrementally with production readback after each class.
13. Keep rollback as kill-switch disable + prior Worker deployment/version restoration.
