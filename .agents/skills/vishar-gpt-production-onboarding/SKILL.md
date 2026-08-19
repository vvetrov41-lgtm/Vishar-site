---
name: vishar-gpt-production-onboarding
description: Provision, migrate, repair, and verify the Vishar CRM production Custom GPT using one CRM-user-centric OAuth application, membership-validated active artist context, capability authorization, the production GPT Action surfaces, and live runtime evidence. Use for unified GPT rollout, OAuth client replacement, Builder configuration, active-artist troubleshooting, legacy fixed-artist migration, or production GPT verification. Do not use to bypass CRM membership, provider isolation, protected production gates, or credential custody.
---

# Vishar GPT Production Onboarding

Use this skill for the production Vishar CRM Custom GPT lifecycle.

This is an operational runbook, not a snapshot. Vishar-site is branch-heavy, the GPT stack evolves through Draft PRs, and OpenAI, Supabase, and Cloudflare product behavior can change. Resolve the exact repository and live state before every stage.

## 1. Non-negotiable identity model

The target production architecture is user-centric:

```text
Custom GPT
  -> CRM OAuth / authenticated CRM user
  -> CRM profile
  -> current artist memberships
  -> server-owned active artist context
  -> per-artist GPT policy
  -> operation-specific CRM capability
  -> artist-scoped CRM action
```

The OAuth `client_id` identifies the Vishar GPT application. It must not be the authoritative artist identity in the unified architecture.

Artist authority comes from current CRM membership plus a server-validated active artist context. Capability authorization is checked after identity and membership resolution.

Never make any of these authoritative because they came from ChatGPT, an OpenAPI request, browser input, or a user prompt:

- `artist_id`;
- profile/user UUID;
- OAuth `client_id` as artist identity;
- integration key;
- provider account identifier;
- provider recipient identifier.

A model-visible artist key may name a candidate for `setActiveArtist` if the current implementation exposes that operation. The database must validate the candidate against the authenticated user's current memberships before changing context.

## 2. Legacy fixed-artist clients are transition only

Older production GPT versions may still use a legacy model where an OAuth client maps to one fixed artist. Treat that path as compatibility/rollback state, not the architecture to reproduce for a new shared GPT.

Do not:

- create another artist-specific GPT merely because the legacy runbook did so;
- create one OAuth client per artist for the unified GPT;
- infer the intended new architecture from a surviving legacy column such as `oauth_client_id`;
- revoke or delete legacy clients before the unified GPT is proven and a separate retirement step is approved.

If the exact production code still requires the legacy path, report that as current runtime state and determine the bounded migration needed. Do not silently pretend the unified design is already deployed.

## 3. Required preflight

Before implementation, Builder configuration, OAuth changes, or production mutation:

1. Read root `AGENTS.md`.
2. Read:
   - `docs/ai/README.md`;
   - `docs/ai/branch-workflow.md`;
   - `docs/ai/security-boundaries.md`;
   - `docs/ai/repository-map.md`;
   - `.agents/skills/vishar-code-navigation/SKILL.md`;
   - the current GPT ADRs/runbooks;
   - relevant current GPT migrations and tests.
3. Resolve from GitHub:
   - current product PR/lineage;
   - head branch and exact SHA;
   - base branch and exact SHA;
   - stacked parents;
   - migration ownership;
   - open competing GPT/release PRs;
   - exact-head CI.
4. Verify production Supabase state read-only:
   - current migration head;
   - active CRM/GPT application records;
   - current legacy/unified identity mode where present;
   - artist memberships relevant to the operator;
   - current GPT capability policies;
   - no cross-artist provider fallback.
5. Inspect the exact GPT implementation rather than relying on historical filenames. Locate:
   - OAuth bridge authorization/token/callback handling;
   - canonical identity/context resolver;
   - context Actions if present;
   - Core schema;
   - Operations schema;
   - Communications schema;
   - canonical union/split regression;
   - production Wrangler/runtime config;
   - GPT Worker routes and provider service bindings.
6. Verify the deployed Cloudflare state independently using the Cloudflare MCP procedure from `vishar-code-navigation`.
7. Verify current official OpenAI documentation before relying on GPT Builder UI labels, OAuth fields, callback shape, Actions limits, or schema restrictions.
8. Verify current Supabase OAuth behavior before relying on historical OAuth App UI labels or token-auth assumptions.

Handoff text and old PR bodies are context, not evidence.

## 4. Cloudflare MCP live-state procedure

For production GPT preflight and post-deploy verification, use the already connected Cloudflare MCP as the preferred live-state interface when it supports the needed read.

Check, without revealing secret values:

- GPT Worker/service existence;
- active deployment/version metadata;
- Custom Domains and routes;
- bindings and Service Bindings;
- Cron Triggers if any;
- Pages/runtime relationships where relevant;
- non-secret configuration metadata.

Repository config is intended state. Cloudflare MCP observations are evidence of actual live Cloudflare state.

Do not replace live-state inspection with assumptions from `wrangler.toml`, old Actions logs, or dashboard screenshots when MCP can answer the question.

Wrangler remains appropriate for repository validation, build, dry-run, and repository-approved deploy workflows. MCP access does not grant permission to mutate production directly.

If MCP is unavailable or cannot expose a required read safely, use the narrowest safe fallback and record the limitation.

## 5. Secret custody

Never request, print, paste into chat, commit, log, or persist any of these values:

- OAuth Client Secret;
- access token;
- refresh token;
- OAuth authorization code;
- Supabase secret/service-role key;
- Cloudflare secret;
- cookie or session token;
- Gmail token;
- Monzo token;
- WhatsApp/Instagram provider credential;
- any other provider credential.

Non-secret identifiers such as Client ID, GPT callback URL, integration key, exact SHA, schema URL, and privacy URL may be recorded when useful as evidence.

If a user must copy a Client Secret between trusted external UIs, instruct them to move it directly. Do not ask them to paste it into ChatGPT or a repository prompt.

## 6. Prove the OAuth bridge before creating or replacing a client

Read the exact current Worker implementation first.

Verify at minimum:

- authorization endpoint;
- token endpoint;
- bridge callback;
- allowed ChatGPT callback hosts/path rules;
- sealed/state integrity behavior;
- redirect URI validation;
- token endpoint authentication method;
- refresh behavior;
- revocation/retirement behavior;
- whether all Action sets intentionally share the same OAuth application.

Do not copy callback rules from this skill if the code changed.

The expected unified property is:

```text
one Vishar GPT
  -> one confidential OAuth application
  -> one authenticated CRM user identity
  -> membership-scoped active artist context
```

Core, Operations, and Communications may have separate GPT Builder Action configurations and callback URLs, but they must resolve the same CRM identity and server-owned active artist context when the current architecture specifies a shared application.

Do not turn separate Builder callbacks into separate artist identities.

## 7. Verify the unified application and artist policies separately

The unified OAuth application and per-artist GPT policy are different concepts.

Verify the current database model and canonical configuration paths. The intended separation is:

```text
OAuth application
  identifies Vishar GPT

CRM user/profile + memberships
  identifies which artists the user may access

active artist context
  chooses one currently accessible artist

per-artist GPT policy + CRM capability
  determines whether a requested operation is allowed
```

A membership alone does not automatically grant finance, communications, appointment management, or another privileged capability.

A GPT application registration must not become a hidden source of cross-artist access.

Use owner-controlled, audited configuration RPCs/operators when the current schema provides them. Do not substitute direct table edits merely because they are easier.

## 8. Active artist behavior

Derive the exact behavior from current migrations/tests, but preserve these invariants:

- one accessible artist may be selected automatically if the server resolver supports that behavior;
- with multiple accessible artists, the active context is remembered server-side per authenticated user/application where designed;
- a saved context is revalidated on every action;
- membership revocation invalidates access immediately;
- switching context never carries entity/provider authority from the previous artist;
- inaccessible artist keys fail closed;
- artist UUIDs and provider identifiers are not accepted from GPT context Actions.

If the current surface contains operations equivalent to:

```text
listAccessibleArtists
getActiveArtist
setActiveArtist
```

verify their exact current names and schemas rather than hardcoding historical definitions.

The UX goal is not to ask for the artist on every request. Ask/select only when context is genuinely ambiguous or the user explicitly requests a switch.

## 9. Provider isolation under one GPT

One GPT does not mean one provider account.

For every provider-backed action, prove that backend routing starts from the authenticated user's validated active artist and then resolves only that artist's integration.

At minimum inspect current handling for providers that exist at the exact product head, such as:

- Gmail;
- Monzo;
- WhatsApp;
- Instagram;
- Calendar.

Never allow:

- provider fallback from Artist A to Artist B;
- reuse of an old Gmail thread after switching artist unless the downstream RPC revalidates ownership;
- reuse of a Monzo candidate/request from another artist;
- reuse of a messaging conversation from another artist;
- browser/model-selected provider account authority.

Provider credentials remain backend-owned.

## 10. Action surface and exact-SHA schemas

The production architecture may split the GPT across multiple Action sets because Builder limits can change and individual schemas must remain bounded.

The current intended logical split is:

- Core;
- Operations;
- Communications.

Do not trust historical operation counts. Run/read the current split/union regression at the exact candidate SHA and verify the current OpenAI limit from official documentation.

The union must be intentional and regression-tested for:

- no duplicate operation IDs across sets unless explicitly required by a documented migration compatibility path;
- no missing canonical operations;
- each imported schema below the current Builder limit;
- correct production `servers` domain;
- correct OAuth security declaration;
- no caller-authoritative artist/provider identity fields.

When Builder supports importing schema by URL, prefer exact-SHA raw repository URLs over moving branch URLs so configuration is reproducible.

Verify every schema file exists at the exact SHA before giving its URL to the user.

## 11. Builder configuration

Before giving manual steps, derive exact values from the candidate code and current official OpenAI UI/documentation.

For a unified GPT:

- configure each Action set in the same Custom GPT;
- use the same unified OAuth Client ID/secret across Action sets when the current architecture requires it;
- keep each schema URL and privacy URL in its correct field;
- validate each callback against the current bridge rules;
- do not add arbitrary per-Action-set callbacks to Supabase if the current bridge intentionally terminates them through one fixed server callback;
- do not create separate Vladimir/Kristina OAuth credentials for the new unified GPT.

If physical Builder interaction is required, give the user the exact path/button/field and each non-secret value in a separate copyable block. Never ask for a secret to be pasted into chat.

## 12. GPT instruction invariants

The final Custom GPT instructions should reflect server authority, not attempt to enforce security in prose.

At minimum preserve these behavioral rules where applicable:

- CRM Actions are the source of truth for current CRM state;
- never invent current clients, enquiries, projects, appointments, availability, finance, communications, files, follow-ups, or activity;
- use the current active artist context;
- if the user explicitly requests another accessible artist, use the supported context-switch Action;
- never invent or submit an `artist_id` to bypass context;
- never attempt access to an artist absent from `listAccessibleArtists`/equivalent;
- never request or expose secrets/tokens/OAuth codes/provider credentials;
- never use arbitrary SQL/table/security administration through the GPT;
- consequential writes require clear user intent and any stronger existing confirmation boundary;
- financial settlement boundaries remain separate from matching/reconciliation hints;
- email/message send boundaries remain as defined by the current communications implementation;
- provider/account selection remains server-owned.

Security must remain enforceable if these instructions are ignored.

## 13. E2E verification for unified context

Do not treat a plausible GPT answer as proof.

Use primary production evidence and safe read-only actions first.

Verify at least:

1. OAuth authorization/token exchange succeeds for the expected unified Client ID.
2. The authenticated CRM profile is the intended user.
3. Accessible artist enumeration matches current active memberships and policy.
4. With one accessible artist, normal operations resolve correctly without cross-artist data.
5. With multiple accessible artists, active context can be read and switched only to an accessible artist.
6. After a switch, Core resolves the new artist.
7. Operations resolves the same artist.
8. Communications resolves the same artist.
9. Finance operations require the finance capability in addition to membership.
10. Gmail/Monzo/messaging/calendar provider routes remain artist-owned.
11. A stale entity/provider identifier from the previous artist fails after switching.
12. An inaccessible artist key fails closed.
13. Caller-supplied UUID/client/integration/provider identity fields are rejected or absent from the schema.
14. `anon` and unrelated API roles cannot execute private context/admin surfaces.

Minimize PII in evidence and logs.

## 14. Legacy-to-unified transition

A safe production migration normally has these phases, subject to the current exact implementation:

```text
legacy fixed-artist GPTs remain available
  -> deploy backward-compatible database/Worker foundation
  -> create/configure one unified confidential OAuth application
  -> keep it disabled until server/runtime verification is complete
  -> configure one shared Custom GPT Action surface
  -> enable unified application through the canonical audited path
  -> user OAuth + read-only E2E
  -> cross-artist/context-switch verification
  -> provider isolation verification
  -> observe production logs/runtime
  -> only later retire legacy policies/clients under a separate approved cleanup
```

Rollback should disable/contain the unified application without deleting provider integrations or destroying the old OAuth clients before the new path is proven.

Do not combine migration, user validation, and irreversible legacy cleanup into one blind step.

## 15. OAuth `invalid_credentials` diagnosis

If authorization/consent succeeds but token exchange returns `invalid_credentials`, focus on the exact OAuth application/client authentication path before changing artist context logic.

Check, from current primary evidence:

- Builder Client ID matches the intended current unified client;
- client is active and not deleted;
- client type is correct;
- token endpoint auth method matches the current Builder configuration;
- secret entered in Builder belongs to that exact client version;
- every Action set was updated if the client was replaced;
- Worker bridge did not alter Basic/client authentication incorrectly.

If a current client is suspect and the platform supports versioned replacement, prefer a fresh versioned client over repeatedly mutating an uncertain credential, but bind it to the unified GPT application, not to one artist.

Retire the superseded client only after the replacement is proven.

## 16. Schema/import diagnosis

If Builder reports an invalid OpenAPI document:

- prove the imported URL resolves to the exact YAML/JSON schema, not privacy HTML;
- verify the document starts with the expected OpenAPI version;
- verify `servers` contains the intended production domain;
- run the repository split/union tests;
- verify the current OpenAI operation limit from official documentation;
- compare the exact imported SHA with the deployed Worker candidate.

Do not solve operation-count errors by silently dropping required operations or weakening schema regressions.

## 17. Production mutation boundary

Cloudflare MCP read access does not expand mutation authority.

Allowed autonomously unless a narrower workstream says otherwise:

- GitHub/read-only runtime inspection;
- Cloudflare MCP read-only inspection;
- Supabase read-only inspection;
- bounded repository implementation;
- migrations/tests;
- local Wrangler validation/dry-run;
- Draft PR;
- exact-head CI fixes;
- release/operator preparation.

Do not directly deploy production through MCP because it is technically possible.

Production rollout should use the repository's protected exact-SHA GitHub Actions path and the `crm-production` approval boundary when the current release architecture specifies it.

Do not merge or mark Draft PRs Ready without explicit authorization.

Do not mutate retained staging unless the workstream explicitly requires staging.

## 18. Post-deploy verification

After an explicitly authorized production rollout:

1. verify the exact deployed SHA/version;
2. use Cloudflare MCP to read back Worker, domains/routes, bindings, and relevant runtime state;
3. verify production Supabase migration/application/context state;
4. verify OAuth bridge behavior;
5. perform read-only unified GPT E2E;
6. prove active-artist consistency across all Action sets;
7. prove cross-artist denial;
8. prove provider isolation;
9. verify no secret/provider credential appeared in logs or committed artifacts;
10. verify legacy rollback path remains available until separately retired.

Do not claim successful production activation from workflow success alone if live-state evidence is available.

## 19. Required final evidence

A completed production GPT onboarding/migration report should record, without secrets:

- repository;
- product PR/branch;
- exact product SHA;
- base/stack lineage;
- migration ownership and production migration head;
- exact-head CI results;
- OAuth identity mode actually deployed;
- unified application non-secret Client ID if operationally useful;
- Action sets and exact-SHA schemas;
- Cloudflare MCP live-state evidence;
- Supabase live-state evidence;
- accessible artist/context behavior;
- capability-denial evidence;
- cross-artist denial evidence;
- provider-isolation evidence;
- legacy compatibility/rollback state;
- manual user actions performed;
- production mutations performed;
- environments deliberately untouched.

## 20. Stop conditions

Do not stop between stages merely to ask whether to continue.

Stop only when physical user participation is required, for example:

- logging into GPT Builder/Supabase/another external UI;
- copying a secret directly between trusted UIs;
- completing OAuth consent;
- clicking a protected production approval;
- another action that available tools cannot perform safely.

When stopping, provide the exact UI path, button, field, and non-secret values, then state what will be verified immediately afterward.
