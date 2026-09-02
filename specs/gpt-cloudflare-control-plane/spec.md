# GPT Cloudflare Control Plane

## Goal

Give Vishar CRM Unified GPT v2 a first-class Cloudflare developer control surface without exposing the Cloudflare API token or turning the GPT Worker into a generic provider proxy.

The provider token may be broad. Authority presented to GPT remains server-owned and semantic.

## Product identity

The product target is the existing **Vishar CRM Unified GPT v2**. The `gpt-operations.vishartattoo.com` host is an Action transport only.

During the OAuth migration window, either the reviewed `vladimir-gpt-actions` compatibility client or `vishar-unified-gpt` may be the OAuth application actually used by GPT v2. Repository migrations must not guess or silently repoint that identity. Production activation is based on fresh non-secret client readback.

## Required authorization

A Cloudflare action is allowed only when all are true:

- normal GPT production Worker configuration is valid;
- the route-specific Cloudflare feature switch is enabled;
- the request carries a valid GPT OAuth bearer;
- `crm_private.require_gpt_client_context()` resolves the registered active GPT client and current CRM context;
- the signed-in CRM profile is owner;
- that GPT client has `can_use_cloudflare_control = true`.

The client ceiling defaults false. Migration `0134_gpt_cloudflare_control.sql` must not automatically enable any client.

Owner configuration may enable Cloudflare control only for reviewed owner-facing transition identities (`vladimir-gpt-actions` and `vishar-unified-gpt`) and only when the target client is active and has an OAuth client id. The configuration action is audited without provider credentials.

## Secret custody

`CLOUDFLARE_API_TOKEN` exists only as a secret on `vishar-cloudflare-gateway`.

It must never be:

- returned to GPT;
- forwarded to the GPT production Worker;
- committed to Wrangler config, GitHub, SQL or docs;
- accepted in Action input;
- written to activity logs.

The gateway adds `Authorization: Bearer ...` only on the final request to `https://api.cloudflare.com/client/v4`.

## Network boundary

`vishar-cloudflare-gateway` has:

- `workers_dev = false`;
- `preview_urls = false`;
- no public route or custom domain;
- one private Service Binding caller from `vishar-gpt-actions-production`.

The gateway never accepts caller-selected upstream URL, provider hostname, bearer token, account id, zone id, arbitrary HTTP method or arbitrary API path.

## Account and zone authority

Account identity is resolved server-side from the token-visible account set. Initial production requires exactly one visible account. Zone operations accept a zone DNS name, then resolve an exact matching zone inside that account.

A future multi-account implementation must add a server-owned account registry/configuration. It must not make a caller-supplied raw account id authoritative.

## Initial semantic operations

Read:

- account summary;
- zones;
- Workers;
- one Worker summary;
- Worker deployments;
- Pages projects;
- D1 databases;
- KV namespaces;
- R2 buckets;
- DNS records for a named zone;
- Worker routes for a named zone.

Write:

- deploy bounded Worker module source;
- delete a Worker with exact name confirmation;
- create/update DNS record;
- delete DNS record with exact id confirmation;
- purge cache by in-zone URLs or explicit whole-zone purge;
- create/update Worker route;
- delete Worker route with exact id confirmation.

The provider token can include additional developer/admin permissions. Those permissions are intentionally dormant until a corresponding named Vishar operation is implemented and reviewed. This preserves developer headroom without exposing arbitrary provider execution.

## Self-protection

The gateway and GPT production control-plane Workers are protected resources. The gateway must refuse destructive deletion of protected Workers, and direct deployment to the gateway itself is forbidden. Expanding self-protection to other control-plane mutations is allowed without changing the public Action contract.

## Input and output constraints

- JSON objects only for mutation requests.
- Exact allowed-field sets per operation.
- Bounded request and provider-response sizes.
- Worker source bounded to 512 KiB in the initial implementation.
- DNS names and route patterns are validated against the resolved zone.
- Cache URLs must resolve inside the named zone.
- Provider redirects are refused.
- Provider errors are normalized and must not echo secrets or unnecessary request metadata.

## OpenAPI

The Cloudflare schema uses the existing production OAuth endpoints and `gpt-operations.vishartattoo.com` server. Reads are non-consequential; mutations are consequential. No schema input may contain provider token, account id, zone id, arbitrary path/method, SQL, RPC or generic payload execution.

## Acceptance

Repository acceptance requires exact-head CI with database, Worker, OpenAPI/config and dry-run bundle checks green.

Production acceptance additionally requires:

- production migration `0134` present;
- private gateway deployed with no public exposure;
- secret-name presence verified without reading the value;
- service binding points to the intended gateway;
- tracked Cloudflare flags remain off until activation;
- live GPT v2 OAuth client identified from current state;
- only that reviewed owner-facing client ceiling enabled;
- authenticated read inventory succeeds from GPT v2;
- non-owner and unreviewed-client denial is proven;
- one legitimate consequential operation succeeds with authoritative Cloudflare readback;
- rollback remains available through flags and the database ceiling.
