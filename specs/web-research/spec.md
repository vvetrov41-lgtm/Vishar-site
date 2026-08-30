# Feature Specification: CRM Web Research

## Status

- Feature: `web-research`
- State: Planned
- Owner/workstream: Vishar CRM
- Related roadmap: `docs/crm/PLATFORM_REFACTOR.md`, Phases V-W
- Initial planning PR: #527

## Problem

The unified Vishar GPT can use ordinary web search for ad-hoc current information, but Vishar CRM has no durable product capability for repeatable public-web research. There is no shared way to read a concrete site deeply, extract the same fields from several sites, save evidence, repeat the same study later, or compare how public pricing, booking policies, SEO structure or studio information changed over time.

Giving a GPT raw access to a scraping provider would create a second integration and security model outside CRM. It would also expose provider-specific operations directly to the assistant, make credential and usage governance harder, and leave CRM without the resulting research history.

The feature therefore introduces **Web Research as a Vishar CRM capability**. Firecrawl is the initial provider behind a Vishar-controlled server-side gateway, not the product surface and not an authorization authority.

## Goals

- Add bounded public-web research to the unified Vishar GPT through Vishar-owned semantic tools.
- Add a CRM Research area that can save research runs, public sources and normalized snapshots.
- Allow the same research definition to be repeated and compared over time.
- Keep ordinary GPT web search as the default for simple current-information lookups.
- Keep Firecrawl credentials, provider details, budgets and kill switches server-side.
- Reuse the existing profile, workspace, artist membership and capability model rather than creating Firecrawl-specific permissions.
- Prevent public web content, including prompt-injection text, from becoming an instruction or CRM mutation channel.
- Ensure private CRM/client information is never sent to Firecrawl.

## Non-goals

- Replacing ChatGPT built-in web search for ordinary factual questions, news, travel or one-off lookups.
- Giving ChatGPT direct access to a Firecrawl API key or raw provider API.
- Firecrawl Interact, arbitrary browser clicks, form filling, login automation or authenticated scraping in V1.
- Sending CRM client names, contact details, notes, finance data, images, message bodies, OAuth material or provider credentials to Firecrawl.
- An autonomous AI receptionist or autonomous client-facing actions triggered by scraped content.
- Unbounded crawling of the public internet.
- Treating a failed provider fetch as evidence that a watched page did not change.

## Actors and scope

- User/actor: an authenticated active CRM profile with the required workspace or artist Research capability.
- GPT actor: the unified Vishar GPT acting for the authenticated profile through the existing Vishar OAuth/action boundary.
- Scope: Research is workspace-owned and may optionally carry an artist context. Artist context is a selector and metadata boundary, not a grant to private artist CRM records.
- Provider: Firecrawl initially, behind a Vishar server-side adapter.
- Environments: local/CI and staging for implementation; production only after exact-head rollout and readback.

## User scenarios

### Scenario 1: Deep research from the unified GPT

Given an authenticated user asks the unified GPT to compare several public tattoo studio pricing or booking pages, when ordinary web search is insufficient for consistent extraction, then the GPT calls the Vishar Research gateway, receives bounded normalized public evidence with source URLs, and answers from that evidence without receiving Firecrawl credentials or raw provider control.

### Scenario 2: Read a concrete public page

Given the user provides a public URL, when the user asks what that page says about a deposit, cancellation policy, pricing or another public fact, then Vishar reads the page through the Research gateway, returns a normalized source-backed result, and rejects unsafe destinations before any provider credential is sent.

### Scenario 3: Bounded site crawl

Given the user wants to inspect a public studio site, when the requested scope is limited to paths such as `/booking`, `/faq` or `/pricing`, then the Research gateway crawls only within configured limits and cannot exceed the server-side hard page cap.

### Scenario 4: Save research in CRM

Given a completed public-web research operation, when an authorized user chooses to save it, then CRM creates a workspace-owned research run with its source records and normalized snapshot while preserving the public evidence needed to understand the result later.

### Scenario 5: Repeat and compare

Given a saved competitor-pricing or policy study, when the user runs it again later, then CRM reuses the saved bounded research definition, records a new snapshot and shows material differences without rewriting the previous snapshot.

### Scenario 6: Provider failure

Given Firecrawl is unavailable, rate-limited, times out or returns malformed output, when a research request runs, then Vishar reports an explicit unavailable/failed state, preserves any last-known-good saved snapshot and does not fabricate a result or mark the source as unchanged.

## Functional requirements

- FR-001: The product MUST expose Web Research through Vishar-owned operations rather than raw Firecrawl endpoints.
- FR-002: Phase V MUST provide semantic operations equivalent to `deep_web_search`, `read_web_page` and bounded `crawl_website`.
- FR-003: Built-in GPT web search MUST remain the normal path for simple current facts and small-source lookups; the Research gateway is for deep reading, consistent extraction, bounded crawling and repeatable studies.
- FR-004: `deep_web_search` MUST have a server-side result cap no greater than 10 in V1.
- FR-005: `read_web_page` MUST operate on one public URL per call in V1.
- FR-006: `crawl_website` MUST default to at most 10 pages and have a hard V1 cap no greater than 20 pages, regardless of caller input.
- FR-007: V1 MUST NOT expose Interact, browser clicking, form filling, arbitrary cookies, arbitrary outbound headers or authenticated browsing.
- FR-008: Provider results MUST be normalized into a Vishar-owned response contract that includes the public source URL and distinguishes provider failure from an empty result.
- FR-009: Phase V results MUST be transient by default and MAY use a bounded short-lived cache without creating durable database rows for every scrape.
- FR-010: Phase W MUST provide a CRM Research area with at least saved research runs, source records and normalized snapshots.
- FR-011: A saved research definition MUST be repeatable without silently changing its extraction fields, crawl scope or ownership.
- FR-012: Snapshot comparison MUST preserve earlier evidence and show material differences between runs rather than overwriting history.
- FR-013: Recurring monitoring MUST remain disabled until saved-run persistence and comparison are proven in production acceptance.
- FR-014: When recurring monitoring is later enabled, it MUST be bounded, idempotent, kill-switchable and auditable.
- FR-015: The CRM Research UI MUST support initial categories for Competitors, Studios, Pricing, SEO and Market research without making category names separate authorization domains.
- FR-016: Provider disablement MUST leave saved CRM Research evidence readable.

## Authorization and ownership requirements

- AR-001: Firecrawl MUST NOT become an authorization system. Vishar profile/workspace/artist membership remains authoritative.
- AR-002: Research runs MUST be workspace-owned and MAY carry an optional artist context.
- AR-003: Workspace Research access MUST NOT imply access to an artist's clients, finance, sessions, communications or other private artist-scoped data.
- AR-004: Any operation that combines Research with private artist-scoped data MUST independently pass the existing artist capability check.
- AR-005: The implementation MUST add Research permissions through the existing capability/workspace model, with intended logical capabilities `view_research`, `run_research` and `manage_research`, or an equivalent mapping proven during implementation planning.
- AR-006: A revoked user MUST lose access to saved research immediately according to authoritative current membership/capability state.
- AR-007: The unified GPT MUST continue to resolve the active profile and selected artist through the existing GPT context resolver; Web Research MUST NOT create a bypass or fallback artist.

## Security and trust requirements

- SR-001: The Firecrawl credential MUST remain server-side and MUST NOT be stored in browser-readable Postgres data, returned by RPC/API responses, embedded in OpenAPI schemas, logged or sent to ChatGPT.
- SR-002: URLs are untrusted input. The backend MUST accept only `http`/`https` and reject localhost, private, link-local, reserved and cloud-metadata destinations before provider credentials are sent.
- SR-003: DNS resolution and every redirect MUST be revalidated so DNS rebinding or a public-to-private redirect fails closed.
- SR-004: The caller MUST NOT be able to supply cookies, `Authorization` headers, provider credentials or arbitrary outbound headers.
- SR-005: Scraped content is untrusted data. Instructions found in a page MUST NOT alter system/tool policy, select another artist, broaden permissions, request CRM mutation or trigger a second privileged action solely because the page said to do so.
- SR-006: Private CRM/client content MUST NOT be included in Firecrawl requests. This includes client names, email addresses, phone numbers, enquiry/project notes, private images, finance data, communication bodies, OAuth material and provider credentials.
- SR-007: Public research may be combined with authorized CRM facts only after public evidence is retrieved, on the Vishar side of the provider boundary.
- SR-008: Cache keys and metadata MUST be scoped so one workspace cannot recover another workspace's private request metadata.
- SR-009: Observability MUST NOT log page bodies, credentials or private CRM data.
- SR-010: V1 MUST provide server-side global/provider-operation kill switches for the provider, search and crawl capabilities.

## Data and retention expectations

Phase V is transient. It may keep bounded cache entries with a finite TTL and provider-neutral telemetry, but a normal scrape does not become a permanent CRM record.

Phase W introduces durable concepts:

- `research_runs`: one requested or repeated research operation and its stable definition/ownership;
- `research_sources`: the public sources used by a run and safe retrieval metadata;
- `research_snapshots`: normalized evidence/results used for later comparison.

Exact table names and columns are implementation-plan decisions, not product requirements. Durable records must contain only the public evidence and metadata required for Research. They must not become a second store for private CRM/client content.

Retention and deletion policy MUST be explicitly defined before the first persistent migration. Disabling Firecrawl must never delete or rewrite last-known-good snapshots.

## Failure and recovery behavior

- Unsafe URL or redirect: reject before provider credentials are sent.
- Provider `429`, timeout or transport failure: return an explicit provider failure; do not fabricate data.
- Malformed provider output: reject or normalize to an explicit invalid-result state; do not save it as successful evidence.
- Cache failure: fall back to a bounded live provider request when permitted, or return an explicit failure; never cross workspace metadata boundaries.
- Kill switch disabled: return a stable tool-unavailable state and perform no provider request.
- Recurring run failure: preserve the prior successful snapshot, record the failed attempt and do not report "no change".
- Membership revoked during or after a run: subsequent reads and mutations must re-check current authorization.

## Acceptance criteria

- AC-001: Through the Vishar Research gateway, a public page can be read and a public pricing/deposit/policy fact returned with its source URL.
- AC-002: Five public studio/artist sites can be compared using the same requested extraction fields without silently changing the schema between sites.
- AC-003: A crawl can be constrained to selected paths and cannot exceed the hard server-side page limit even when the caller requests more.
- AC-004: Localhost, private IP, metadata targets, unsafe redirects and non-HTTP(S) schemes are rejected before provider credentials are sent.
- AC-005: Prompt-injection text in a scraped page does not alter GPT/tool authorization, initiate CRM mutations or change artist context.
- AC-006: Repeating an equivalent request can use the cache without exposing another workspace's request metadata.
- AC-007: Provider `429`, timeout and malformed output produce explicit failure states and no fabricated answer.
- AC-008: Each Research kill switch demonstrably stops the intended operation.
- AC-009: Unified-GPT E2E proves Web Research uses the authenticated profile and current selected artist context without creating a separate Firecrawl OAuth/client surface.
- AC-010: A saved CRM research run is readable only by currently authorized workspace/artist actors.
- AC-011: The same saved definition can be rerun and produces a new immutable comparison snapshot with source evidence.
- AC-012: Revoking the relevant membership/capability removes access immediately without deleting historical data.
- AC-013: A failed repeated/recurring fetch preserves the last-known-good snapshot and is not presented as "no change".
- AC-014: Provider request inspection and stored Research payload inspection prove private CRM/client content is absent.
- AC-015: Exact-head required CI is green for the implementation SHA, deployment is separately read back, and production acceptance verifies the actual active feature state.

## Dependencies and constraints

- Unified GPT profile-bound authorization/action surface must be re-verified at implementation time rather than assumed from this specification.
- The current production Supabase migration head and Cloudflare deployment/binding state must be resolved fresh before any schema or production mutation.
- Firecrawl provider limits, pricing and API contracts are external dependencies and must be verified against current provider documentation at implementation time.
- The initial provider may be replaced later without changing the product-level Research contract.

## Open questions

- Exact cache implementation and TTL policy.
- Exact retention period and deletion/export behavior for durable Research evidence.
- Whether workspace-level Research permissions need dedicated workspace capability columns or reuse an existing workspace manage/view pattern.
- Exact normalized comparison schema for different research categories.
- Whether recurring monitoring should reuse the existing automation scheduler directly or a dedicated bounded Research schedule projection.

These questions do not block the product specification. They must be resolved in the implementation plan before the relevant phase writes code or migrations.

## Requirement changes

- 2026-08-30: Initial Spec Kit feature specification created from CRM roadmap Phases V-W and the decision to make Firecrawl part of CRM rather than a direct GPT-only integration.
