# Implementation Plan: CRM Web Research

## Specification

- Spec: `specs/web-research/spec.md`
- Feature: `web-research`
- Target repository: `vvetrov41-lgtm/Vishar-site`
- Planning PR: #527
- Spec creation lineage: `agent/platform-telegram-self-service` at `95f9b2a469a1fafb8a3388a49d962291ff70ce8d`
- Planning branch before Spec Kit files: `agent/unified-gpt-firecrawl-plan` at `d709ae25d6a705b55e3fa240cdbd1b76ada44721`
- Implementation target SHA: MUST be re-resolved immediately before implementation; this plan does not freeze a future release head.

## Constitution check

- Server authority: URL input and GPT requests are untrusted. Vishar server-side code owns provider invocation, limits, redirects, workspace/artist context and persistence ownership.
- Authorization before capability: Research uses current profile/workspace/artist membership plus the existing capability layer; provider access never grants CRM access.
- Ordered database evolution: Phase V is designed to avoid a database migration. Phase W migration numbers and SQL are chosen only after fresh production migration-head reconciliation and full ordered migration tracing.
- Exact-head evidence: implementation, CI, merge, deployment and readback all use immutable exact SHAs; a green run on this planning PR is documentation validation only.
- Durable external delivery: persistent Research stores durable successful evidence before comparison/notification semantics depend on it; provider failure cannot rewrite last-known-good evidence.
- Secret custody: Firecrawl credentials remain encrypted server-side bindings/secrets and never enter browser state, Postgres-readable configuration, prompts or specs.
- Deployment is separate evidence: code, CI, Cloudflare deployment, Supabase migration state, GPT action configuration and production acceptance are separate gates.
- Bounded reversible rollout: provider operations start disabled, expose explicit kill switches and can be removed from the active surface without corrupting CRM business data.
- Specification traceability: every implementation task in `tasks.md` maps back to functional, authorization, security or acceptance requirements in `spec.md`.

## Current-state evidence at planning time

The exact implementation state must be re-verified later. The durable planning facts are:

- The CRM platform architecture already defines a unified capability model across CRM UI, MCP and unified GPT.
- The unified GPT plan/profile-bound authorization belongs to the same backend permission layer; Research must reuse it rather than add provider-specific identity.
- GPT production OpenAPI artifacts live under `docs/gpt-actions/` and must be treated as a Vishar action contract, not a raw Firecrawl contract.
- Worker/server code and CRM frontend live in the existing Vishar repository; the final gateway location must be chosen from current code after exact-head navigation.
- `docs/ai/security-boundaries.md` already requires server authority, narrow privileged surfaces and secret custody. Web Research extends these rules with outbound URL/SSRF and prompt-injection boundaries.
- Existing `specs/unified-communications/` establishes the repository's Spec Kit artifact style and separation between feature intent, technical plan, tasks and production evidence.
- The current planning work does not prove that Firecrawl credentials, routes, bindings, database tables or a unified production GPT are active.

## Architecture

### Product boundary

The product is **Vishar CRM Web Research**. Firecrawl is one provider implementation.

```text
Unified Vishar GPT            CRM Research UI
          \                         /
           \                       /
            -> Vishar Research Gateway
                       |
                 provider adapter
                       |
                   Firecrawl
                       |
                 public internet
```

Neither the GPT nor browser calls Firecrawl directly. This keeps provider credentials, usage controls, caching, request validation and future provider replacement behind one Vishar-owned boundary.

### Phase V: transient Research gateway

Phase V should ship before persistent CRM Research tables.

Initial semantic operations:

```text
deep_web_search(query, domains?, limit?)
read_web_page(url, extraction_schema?)
crawl_website(url, include_paths?, exclude_paths?, max_pages?)
```

The names describe Vishar behavior, not Firecrawl endpoint names. The adapter translates them into the provider's current Search/Scrape/Crawl API only after current provider documentation is rechecked.

V1 hard limits:

- search result count <= 10;
- one page per `read_web_page` request;
- crawl default <= 10 pages;
- crawl hard cap <= 20 pages;
- explicit timeout, response-byte, concurrency and per-profile/workspace usage limits;
- no Interact, arbitrary browser actions, cookies, login, arbitrary headers or form submission.

Phase V does not persist every scrape. It returns a normalized result and may use a short-lived cache.

### Phase W: persistent CRM Research

Phase W starts only after Phase V acceptance.

Logical durable entities:

```text
research_runs
research_sources
research_snapshots
```

The implementation may choose different exact SQL names if fresh repository design makes that safer, but their contracts remain distinct:

- run: stable ownership, research definition, state and execution metadata;
- source: public source identity and safe retrieval metadata used for the run;
- snapshot: normalized successful evidence that can be compared over time.

A run is workspace-owned and optionally artist-contextual. Public Research data does not inherit access to private artist records.

### CRM UI

Initial route/surface should be one Research domain in the private CRM, with filters or templates for:

- Competitors;
- Studios;
- Pricing;
- SEO;
- Market research.

The first persistent version needs:

- create/run a bounded research definition;
- save successful run;
- reopen sources;
- repeat the exact definition;
- compare current vs previous snapshot;
- show explicit failed-run state without replacing the last successful snapshot.

Recurring monitoring is withheld until this path is proven.

## Provider gateway design

### Credential custody

Use a server-side Firecrawl credential binding/secret. The implementation must inspect current Cloudflare layout and place the credential in the smallest appropriate runtime boundary. Do not add a secret to Supabase, public Worker vars, repository config, OpenAPI schema or CRM browser bundle.

Secret presence may be read back as boolean/redacted metadata only. Never print its value.

### URL and SSRF validation

Outbound URL validation occurs before provider invocation and again at relevant redirect/resolution boundaries.

Required controls:

1. parse and canonicalize URL server-side;
2. allow only `https` and, if specifically required, `http`;
3. reject embedded credentials/userinfo;
4. reject localhost and local hostnames;
5. resolve hostnames and reject loopback, private, link-local, reserved, multicast and metadata ranges for IPv4 and IPv6;
6. prevent DNS rebinding by revalidating resolved destinations at request time according to the selected outbound implementation;
7. reject or independently validate every redirect target;
8. do not accept caller-defined authorization/cookie/proxy headers;
9. cap redirects, body size and elapsed request time.

The exact network implementation must be tested against Cloudflare runtime behavior rather than assumed from Node semantics.

### Prompt-injection boundary

Provider output is content only. The normalization layer should separate source metadata from extracted text and should not permit scraped instructions to become tool directives.

Tests must include malicious public content asking the model to:

- ignore prior instructions;
- reveal secrets;
- call another CRM tool;
- select a different artist;
- send a message;
- change permissions;
- fetch an internal URL.

The expected result is that the content can be reported as page text but causes none of those actions.

### Private data minimization

A Research provider request is built only from public-web research inputs. Do not forward full user prompts if they contain private CRM material. When a user asks a mixed question such as "compare this competitor pricing with my client/project data", split execution:

1. construct a public-only Research request;
2. retrieve public evidence;
3. separately retrieve authorized CRM facts;
4. combine them in the Vishar/GPT response after both boundaries have succeeded.

Add contract tests with representative private-field names to prevent regression.

## Normalized response contract

The precise TypeScript/OpenAPI schema is an implementation artifact, but Phase V needs a provider-neutral contract with at least:

- operation type;
- success/failure state;
- source URL/title where applicable;
- normalized extracted data or bounded text;
- retrieval timestamp;
- cache hit/miss indicator where useful;
- stable safe error category;
- no provider credential or raw private provider metadata.

Raw provider responses should not be forwarded to the GPT or browser by default.

## Cache and usage controls

Cache design must be settled before implementation. Minimum invariants:

- finite TTL;
- key derived only from canonical public research inputs and extraction definition;
- no private CRM payload in cache key/body;
- no cross-workspace request-metadata disclosure;
- no cache entry can bypass current authorization for persistent Research reads;
- provider failure is not cached as a successful empty result.

Usage controls should allow global and actor/workspace caps so one user cannot exhaust provider credits. Provider credit accounting is observability, not financial authority.

## Kill switches

Phase V requires server-side switches equivalent to:

```text
FIRECRAWL_ENABLED
FIRECRAWL_SEARCH_ENABLED
FIRECRAWL_CRAWL_ENABLED
```

Names may adapt to current runtime conventions, but must remain independently controllable where the architecture supports it. Defaults are off until staging acceptance proves the adapter.

Phase W later requires a separate persistence/recurrence enablement boundary so disabling crawling does not hide saved evidence.

## Authorization and database plan

### Phase V

Prefer no new database authorization model. The gateway derives current user/profile/workspace/artist context from the existing Vishar action/CRM boundary. If Phase V needs quota state, choose a storage mechanism only after current Worker/KV/database architecture is inspected.

### Phase W

Before SQL:

1. read the Supabase skill and current production migration head;
2. trace final effective workspace membership and capability functions;
3. identify current RLS/grant patterns for workspace-owned and optionally artist-contextual data;
4. choose the next forward-only migration number from production truth;
5. add `view_research`, `run_research`, `manage_research` or an equivalent explicit mapping to the existing registry/model;
6. add RLS/RPC denial coverage for unrelated workspace, revoked membership, missing capability and mismatched artist context;
7. keep service-only helper objects outside direct browser grants.

Do not hard-code Vladimir/Kristina or create artist-specific Research tables.

## GPT action integration

The unified GPT should see Vishar semantic operations only. Extend current action/OpenAPI artifacts after exact current contract discovery.

Requirements:

- no Firecrawl API key in GPT Authentication settings;
- no raw Firecrawl URL surfaced as the action server;
- no second OAuth client solely for Research;
- Research tools inherit current authenticated profile/context;
- any artist selector remains subject to the existing context resolver;
- tool descriptions explicitly distinguish ordinary web search from deep/repeatable Research so Firecrawl is not used for every web question;
- provider unavailable/error results must be communicated as such, not silently replaced with unsupported claims.

If GPT editor changes are not automatable with available tools, that external UI action is a rollout step, not an implementation excuse. All server-side work and validation should be completed first.

## Observability and audit

Phase V telemetry should record only bounded safe metadata such as:

- request operation;
- authenticated profile/workspace identifiers where permitted by existing logging policy, preferably internal IDs rather than client data;
- timing;
- cache status;
- provider HTTP/error category;
- result/source counts;
- bounded provider credit/usage metadata;
- active exact deployment SHA/version.

Do not log:

- provider API key;
- page body/raw markdown by default;
- private CRM data;
- arbitrary user prompt containing client data;
- cookies/auth headers.

Phase W adds durable audit for run creation, execution state and recurrence changes without duplicating full scraped content into activity logs.

## Test strategy

### Unit and contract tests

- URL canonicalization and scheme rejection.
- IPv4/IPv6 private/link-local/metadata/loopback rejection.
- redirect target validation.
- DNS/rebinding behavior appropriate to chosen runtime.
- page/result/crawl hard limits cannot be overridden by caller.
- no arbitrary headers/cookies/authentication.
- normalized provider success, empty, `429`, timeout, malformed body and transport failure.
- kill-switch behavior.
- cache equivalence and tenant-metadata isolation.
- private CRM-field stripping/splitting.
- prompt-injection fixtures cannot drive privileged follow-up actions.

### CRM/GPT tests

- current profile/workspace/artist context is retained.
- unauthorized workspace cannot read/save another workspace's Research.
- revoked capability immediately denies reads/writes.
- GPT OpenAPI contains only Vishar Research operations and no provider credentials.
- ordinary search routing and Research routing are distinguishable in instructions/tool descriptions.

### Database tests for Phase W

- positive owner/member access.
- denied unrelated workspace.
- denied missing `run_research`/`manage_research`.
- artist context does not grant client/finance/communications access.
- snapshots append rather than overwrite.
- failed run cannot replace last successful snapshot.
- repeat/recurrence idempotency.
- RLS, grants, SECURITY DEFINER and fixed `search_path` where applicable.

### Required exact-head CI

Resolve current required workflows from the target branch immediately before implementation. At minimum the existing broad Static Validation and CRM/booking validation must pass on the exact implementation SHA; add focused Web Research validation so a future unrelated green workflow cannot hide provider-boundary regressions.

## Rollout plan

### Release V1: transient gateway

1. Fresh-check canonical branch/PR, exact SHA, current GPT/action contract, Cloudflare Worker/Pages layout and production target.
2. Recheck current Firecrawl API contract and account/credential requirements.
3. Implement provider adapter and URL/security guards with all kill switches off.
4. Add normalized response contract, hard limits, cache/usage controls and focused tests.
5. Add Vishar Research operations to the current backend and staging GPT/action surface.
6. Run exact-head local/CI validation and denial tests.
7. Deploy to staging, read back exact Worker/Pages version/bindings and run real public-source acceptance.
8. Enable only the minimum Phase V operations in production through existing guarded release machinery.
9. Production readback: exact SHA/version, route, binding presence, kill-switch state and no secret exposure.
10. Unified-GPT E2E: read one page, compare multiple sites, bounded crawl, unsafe URL rejection, provider failure and prompt-injection denial.

### Release W1: durable CRM Research

1. Fresh-check production Supabase migration head and final authorization functions.
2. Finalize retention, permission mapping and normalized snapshot schema.
3. Add forward-only migration plus pgTAP denial/ownership tests.
4. Add CRM Research API/UI for save, reopen, repeat and compare.
5. Run exact-head CI and staging acceptance.
6. Deploy migration/backend/UI through guarded production workflow.
7. Read back migration head, deployed SHA and actual Research RLS/access behavior.
8. Validate saved run and repeated snapshot using public sources without synthetic customer data.

### Release W2: recurring monitoring

Enable only after W1 is proven. Reuse the existing scheduler/automation principles: bounded frequency, idempotency, explicit ownership, kill switch, failure history and last-known-good preservation.

## Rollback/reference plan

- Phase V: disable Research provider operations through server-side kill switches and/or roll back the exact Worker/Pages deployment. No CRM business record depends on transient provider availability.
- Phase W: disable new Research writes/recurrence first; preserve historical runs/sources/snapshots as readable evidence. Roll back application callers to the last compatible release. Do not down-migrate production-applied schema destructively.
- Credential incident: rotate the Firecrawl secret through the provider/Cloudflare secret path without printing it, then verify old credential invalidation and safe binding presence.

## Risks

| Risk | Consequence | Mitigation |
| --- | --- | --- |
| Direct/raw provider exposure to GPT | Provider credential and policy become harder to govern | Vishar semantic gateway only; credential server-side |
| SSRF via requested URL or redirect | Internal/cloud metadata exposure | DNS/IP/redirect validation, no arbitrary headers, denial tests |
| Prompt injection in scraped page | Page tries to drive CRM/GPT actions | Treat output as data; explicit malicious-content tests |
| Private CRM data sent to provider | Privacy/security incident | Public-only provider request builder and contract tests |
| Unbounded crawling/credit use | Unexpected cost and load | Hard page/result/time/concurrency/usage caps and kill switches |
| Provider outage appears as "no change" | False business conclusions | Explicit failed run and immutable last-known-good snapshot |
| Research permission broadens artist access | Cross-scope data exposure | Workspace ownership plus independent artist capability checks |
| Provider-specific schema leaks into product | High switching cost | Vishar-owned normalized contracts and semantic operations |
| Recurrence enabled too early | Noisy/expensive unreliable monitoring | Defer recurrence until durable W1 acceptance |

## Plan completion gate

Before implementation begins:

- this spec/plan/tasks set is merged into the relevant canonical planning lineage;
- current Firecrawl documentation/account contract is re-verified;
- current unified GPT/action surface is traced at exact head;
- current Cloudflare and Supabase production state is freshly resolved;
- open questions that affect Phase V security/cache/usage are resolved in the plan;
- Phase W retention, permission and migration decisions are resolved before its SQL is written.

Implementation completion is not production completion. Each release needs exact-head CI, deployment, readback and actual acceptance.
