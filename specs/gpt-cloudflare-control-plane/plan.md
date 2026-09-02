# Plan: GPT Cloudflare Control Plane

## Revision target

Implementation branch: `agent/gpt-cloudflare-control-plane-v2`.

Fresh canonical base at branch creation: `ef874daa9386642416688df54991f588c43460ac` on `agent/platform-telegram-self-service`.

The external product target is **Vishar CRM Unified GPT v2**. `gpt-operations.vishartattoo.com` is only an Action transport/domain, not a separate GPT product. During the v2 OAuth transition the reviewed Vladimir compatibility client may still be the live OAuth application, so production activation must use live readback rather than migration-time assumptions.

## Architecture

```text
ChatGPT Action
  -> gpt-operations.vishartattoo.com
  -> vishar-gpt-actions-production
       - host guard and rate limit
       - OAuth bearer
       - owner + GPT-client Cloudflare ceiling
       - semantic Cloudflare action validation
  -> CLOUDFLARE_GATEWAY Service Binding
  -> vishar-cloudflare-gateway
       - no public route / workers.dev / preview URL
       - CLOUDFLARE_API_TOKEN Worker secret
       - server-owned account and zone resolution
       - operation-specific Cloudflare REST calls
       - response/error normalization
  -> https://api.cloudflare.com/client/v4
```

The Cloudflare token may carry broad developer permissions. The security boundary is the private gateway: GPT never receives the provider token, cannot select an upstream host, cannot supply account/zone ids as authority, and cannot issue arbitrary provider paths or HTTP methods.

## Database authorization

Migration `0134_gpt_cloudflare_control.sql` adds:

- `crm_private.gpt_action_clients.can_use_cloudflare_control boolean not null default false`;
- `public.gpt_authorize_cloudflare_control()` requiring current GPT context, owner role and the client ceiling;
- owner-only audited `public.configure_gpt_cloudflare_control_access(integration_key, enabled)`.

The migration activates no GPT client. Both `vladimir-gpt-actions` and `vishar-unified-gpt` are reviewed owner-facing transition identities that may be enabled only after live production readback proves which OAuth client GPT v2 currently uses and that it is active. Kristina and future GPT clients remain excluded until separately reviewed.

## Private gateway

`workers/cloudflare-gateway.js` is reachable only through a Worker Service Binding. It hard-codes the Cloudflare API origin and resolves the token-visible Vishar account server-side.

Initial semantic coverage:

- account and zone inventory;
- Workers inventory, deployment history, source deployment and deletion;
- Pages projects;
- D1 databases;
- KV namespaces;
- R2 buckets;
- DNS list/upsert/delete;
- cache purge;
- Worker route list/upsert/delete.

The provider token can be broader than this initial surface so future reviewed semantic actions do not require token replacement. New capabilities are added as named contracts, not by introducing a generic Cloudflare proxy.

Control-plane Workers are protected from destructive self-management. Destructive resource operations require explicit confirmation values where the operation has a stable resource id/name.

## GPT router and kill switches

`workers/lib/gpt-cloudflare-control.js` owns `/v1/cloudflare/...` routes. Every route:

1. checks tracked feature switches;
2. requires OAuth bearer;
3. calls `gpt_authorize_cloudflare_control`;
4. validates an exact request-field allow-list;
5. calls the private `CLOUDFLARE_GATEWAY` service binding;
6. returns a bounded normalized response.

Tracked production defaults remain fail-closed:

- `CLOUDFLARE_CONTROL_ENABLED = "false"`;
- `CLOUDFLARE_CONTROL_READ_ENABLED = "false"`;
- `CLOUDFLARE_CONTROL_WRITE_ENABLED = "false"`.

## OpenAPI

`docs/gpt-actions/openapi.production.cloudflare.yaml` is a dedicated Action-domain schema on `gpt-operations.vishartattoo.com`. It uses the same Unified GPT OAuth application and does not expose provider credentials, account ids, arbitrary paths/methods, SQL or RPC execution.

## Validation

Focused tests cover:

- fail-closed database authorization and owner-only configuration;
- private gateway configuration and token non-disclosure;
- exact-one token-visible account resolution;
- zone resolution;
- semantic input allow-lists;
- Worker/Pages/D1/KV/R2/DNS/routes mappings;
- destructive confirmation and protected control-plane Workers;
- service-binding transport without forwarding the caller OAuth token;
- tracked kill-switch defaults;
- OpenAPI host/auth/action contract;
- dry-run bundle validation.

## Rollout sequence

1. Merge only after exact-head CI is green.
2. Fresh-read production Supabase migration/client state and Cloudflare Worker/binding state without exposing secrets.
3. Apply migration `0134`.
4. Deploy `vishar-cloudflare-gateway` and set `CLOUDFLARE_API_TOKEN` directly as a Worker secret. Never place the token in GitHub, SQL, chat or tracked Wrangler config.
5. Deploy GPT Worker code with the private service binding and all Cloudflare flags still off.
6. Confirm the actual production OAuth client used by GPT v2.
7. Enable that reviewed client through `configure_gpt_cloudflare_control_access`.
8. Enable global + read flags and verify account/zones/workers inventory from GPT v2.
9. Enable write only after read acceptance, then exercise one legitimate bounded mutation with authoritative readback.
10. Import/update the Cloudflare Action schema in the existing GPT v2 configuration.

Rollback is feature-flag disable first, then GPT client ceiling disable, followed by prior Worker deployment/version restoration if code rollback is required. Provider token rotation is independent and does not require exposing its value.
