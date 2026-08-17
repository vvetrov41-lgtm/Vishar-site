---
name: vishar-gpt-production-onboarding
description: Provision, replace, repair, and verify one artist-scoped Vishar CRM production Custom GPT using Supabase OAuth, the Cloudflare GPT OAuth bridge, Core and Operations OpenAPI Actions, and production log evidence. Use when creating a new Vladimir/Kristina artist GPT, rotating or replacing its OAuth client, repairing invalid_credentials, configuring both Action sets, validating ChatGPT callbacks, or repeating the production GPT onboarding process. Do not use for arbitrary OAuth administration, cross-artist access, or public booking flows.
---

# Vishar GPT Production Onboarding

Use this skill to create or replace a private production Custom GPT for exactly one artist without weakening artist isolation or exposing credentials.

This is an operational runbook, not a snapshot. Vishar-site is branch-heavy and OpenAI/Supabase product UI can change. Resolve the current repository and external state before every stage.

## 1. Non-negotiable security model

The production GPT architecture is:

```text
Custom GPT
  -> OpenAI OAuth client configuration
  -> Cloudflare OAuth bridge
  -> Supabase OAuth server
  -> artist-scoped GPT Action Worker
  -> bounded GPT RPC surface
```

The authoritative artist route is the Supabase OAuth `client_id` bound server-side in `crm_private.gpt_action_clients`.

Never allow ChatGPT, an OpenAPI request, browser input, or a user prompt to select `artist_id`.

Never request, print, paste into chat, commit, log, or persist any of these values:

- OAuth Client Secret;
- access token;
- refresh token;
- OAuth authorization code;
- Supabase secret/service-role key;
- Cloudflare secret;
- cookie or session token;
- provider credential.

Client IDs, GPT callback URLs, integration keys, schema URLs, and privacy URLs are not secrets and may be recorded as evidence.

## 2. Required preflight

Before any implementation or production mutation:

1. Read root `AGENTS.md`.
2. Read:
   - `docs/ai/README.md`;
   - `docs/ai/branch-workflow.md`;
   - `docs/ai/security-boundaries.md`;
   - `.agents/skills/vishar-code-navigation/SKILL.md`.
3. Resolve the current top product PR from GitHub. Do not assume an old GPT PR is still the correct product base.
4. Record:
   - product PR number;
   - exact product head branch;
   - exact product head SHA;
   - exact base branch and SHA;
   - whether the PR is open/draft/unmerged;
   - exact-head CI status.
5. Verify production and retained staging Supabase project health read-only.
6. Inspect the GPT implementation at the exact product head:
   - `workers/gpt-actions-production.js`;
   - `workers/gpt-actions-production-full.js`;
   - `wrangler.gpt-actions.production.toml`;
   - `docs/gpt-actions/openapi.production.yaml`;
   - `docs/gpt-actions/openapi.production.core.yaml`;
   - `docs/gpt-actions/openapi.production.operations.yaml`;
   - `scripts/test-gpt-openapi-split.mjs`;
   - relevant later GPT migrations and tests.
7. Verify the currently deployed GPT Worker/domain state independently. Code presence is not proof of deployment.
8. Before relying on GPT Builder fields or limits, verify the current official OpenAI Actions documentation. UI labels and platform limits can change.

Do not mutate retained staging as part of production Custom GPT onboarding.

## 3. Current production constants to verify, not blindly reuse

At the time this skill was written, the production architecture used:

```text
OAuth Authorization URL
https://gpt-actions.vishartattoo.com/oauth/authorize
```

```text
OAuth Token URL
https://gpt-actions.vishartattoo.com/oauth/token
```

```text
Supabase bridge callback
https://gpt-actions.vishartattoo.com/oauth/callback
```

```text
Core action domain
https://gpt-actions.vishartattoo.com
```

```text
Operations action domain
https://gpt-operations.vishartattoo.com
```

```text
Core privacy URL
https://gpt-actions.vishartattoo.com/privacy
```

```text
Operations privacy URL
https://gpt-operations.vishartattoo.com/privacy
```

OAuth scope:

```text
email
```

Token endpoint authentication method in GPT Builder:

```text
Basic
```

Supabase OAuth client type:

```text
confidential
```

Supabase token endpoint authentication method:

```text
client_secret_basic
```

These values must be re-verified against the exact current Worker, Wrangler config, OpenAPI schemas, and deployed runtime before reuse.

## 4. Prove the callback bridge before creating a client

The production Worker currently accepts only HTTPS ChatGPT callbacks with:

- host exactly `chat.openai.com` or `chatgpt.com`;
- no username/password/query/hash in the supplied callback;
- path matching `/aip/<gpt-id>/oauth/callback`.

The Worker stores the exact ChatGPT callback inside sealed bridge state and uses only the fixed Supabase redirect URI:

```text
https://gpt-actions.vishartattoo.com/oauth/callback
```

Therefore, while this bridge implementation remains current:

- do not add per-GPT `chat.openai.com` callbacks to Supabase OAuth redirect URIs;
- do not add the Operations callback to Supabase separately;
- keep the Supabase OAuth client redirect list limited to the Worker bridge callback unless current code proves the architecture changed.

If `safeChatGPTCallback`, `OAUTH_BRIDGE_CALLBACK`, allowed callback hosts, or bridge behavior changed, stop and derive the procedure from the new exact implementation.

## 5. Resolve the artist integration before creating OAuth

Identify the intended artist and the existing artist-scoped GPT integration row.

Use the current production database read-only to confirm:

- `integration_key`;
- bound `artist_id`;
- existing `oauth_client_id` if any;
- `is_active`;
- appointment read/manage flags;
- enquiry read flag;
- `can_manage_crm`;
- `can_manage_finance`;
- `can_manage_communications`.

Do not derive artist ownership from display names alone. Verify the database binding.

Never create a second integration key just to rotate an OAuth client unless the product architecture explicitly requires it.

## 6. Create a new Supabase OAuth App

Use Supabase production Authentication -> OAuth Apps.

Use a versioned name so replacements are unambiguous:

```text
Vishar CRM - <Artist> GPT Production v<N>
```

Set redirect URI to exactly:

```text
https://gpt-actions.vishartattoo.com/oauth/callback
```

Use:

```text
Client type: Confidential
```

```text
Token endpoint authentication method: client_secret_basic
```

After creation:

- record the new Client ID;
- verify the OAuth App is active and not deleted;
- verify redirect URIs exactly;
- verify client type and token auth method;
- have the user copy the Client Secret directly from Supabase into a secure temporary location;
- never ask the user to paste the Client Secret into chat.

The secret may be shown only once. Treat loss of the secret as a credential-recovery problem, not a reason to expose it through another channel.

## 7. Bind the OAuth client to the artist

The canonical application path is owner-controlled. Re-read the current signatures and authorization checks before invoking any configuration RPC.

Current relevant owner RPCs include:

```text
public.configure_gpt_action_client(
  p_integration_key text,
  p_oauth_client_id text,
  p_is_active boolean,
  p_can_manage_appointments boolean
)
```

and:

```text
public.configure_gpt_full_management(
  p_integration_key text,
  p_manage_crm boolean,
  p_manage_finance boolean,
  p_manage_communications boolean
)
```

Important rules:

- verify the final effective SQL definition and grants at the current product head;
- invoke owner-only configuration through an authenticated owner context;
- do not forge or imitate a user JWT merely to satisfy `is_owner()`;
- do not silently replace the canonical audited path with an unaudited direct table update;
- if only an administrative SQL context is available and the canonical RPC requires owner Auth context, use an already approved repository/operator path or require the minimum owner action rather than weakening the check.

After configuration, read back the row and prove:

- integration key unchanged;
- artist unchanged;
- OAuth Client ID equals the newly created client;
- active state is correct;
- required capability flags are correct;
- an appropriate activity/audit event exists if the canonical configuration path records one.

Do not proceed to Builder E2E until this read-back matches the intended artist exactly.

## 8. Use exact-SHA OpenAPI schema URLs

The production GPT currently has 52 operations split into two ChatGPT Action sets because each imported schema must remain within the Builder operation limit.

Current split tests require:

```text
Core: 26 operations
Operations: 26 operations
Total: 52 unique operations
```

Do not import the 52-operation monolith directly into one Action set.

Generate raw GitHub URLs from the verified exact product head SHA, not from a moving branch name.

Core template:

```text
https://raw.githubusercontent.com/vvetrov41-lgtm/Vishar-site/<EXACT_PRODUCT_SHA>/docs/gpt-actions/openapi.production.core.yaml
```

Operations template:

```text
https://raw.githubusercontent.com/vvetrov41-lgtm/Vishar-site/<EXACT_PRODUCT_SHA>/docs/gpt-actions/openapi.production.operations.yaml
```

Why exact SHA URLs:

- the imported schema is reproducible;
- Builder cannot silently follow a moving draft branch;
- production evidence can be tied to one exact product revision.

Before giving these URLs to the user, verify both files exist at the exact SHA and their `servers` entries point to the expected production domains.

## 9. Configure the Core Action set

In GPT Builder create the first Action set and choose schema import by URL.

Import the exact-SHA Core schema URL.

Do not use the Privacy Policy URL as the Schema URL.

Configure OAuth with the new Client ID and the Client Secret copied directly by the user from Supabase.

Use separately:

```text
Authorization URL
https://gpt-actions.vishartattoo.com/oauth/authorize
```

```text
Token URL
https://gpt-actions.vishartattoo.com/oauth/token
```

```text
Scope
email
```

```text
Token Exchange Method
Basic
```

Set Core Privacy Policy URL:

```text
https://gpt-actions.vishartattoo.com/privacy
```

After saving, record the Core callback URL shown by GPT Builder.

Validate it against the current Worker callback rule. A current valid example shape is:

```text
https://chat.openai.com/aip/<gpt-id>/oauth/callback
```

or:

```text
https://chatgpt.com/aip/<gpt-id>/oauth/callback
```

Do not add this callback to Supabase while the bridge architecture described above remains current.

## 10. Configure the Operations Action set

Create a second Action set in the same Custom GPT.

Import the exact-SHA Operations schema URL.

Use the same artist-specific Supabase OAuth Client ID and the same Client Secret as Core.

Configure the same Authorization URL, Token URL, scope, and Basic token exchange method.

Set Operations Privacy Policy URL:

```text
https://gpt-operations.vishartattoo.com/privacy
```

Record the Operations callback URL and validate it independently.

Core and Operations have separate ChatGPT callback URLs, but both are intentionally handled by the same dynamic production OAuth bridge.

## 11. GPT instructions must preserve server authority

The Custom GPT instructions must state at minimum:

- CRM Actions are the source of truth for current CRM state;
- never invent current clients/enquiries/projects/appointments/availability/finance/messages/files/follow-ups/activity;
- artist scope is permanently determined by the OAuth client;
- never ask for, accept, construct, or send `artist_id`;
- never attempt cross-artist access;
- never request or expose secrets/tokens/OAuth codes/provider credentials;
- never use arbitrary SQL/table/RPC/security administration;
- files are metadata-only where the Action surface specifies that boundary;
- consequential writes execute only on clear user instruction;
- manual payment recording requires explicit confirmation that real payment has already been received;
- outbound WhatsApp sends require explicit instruction/approval;
- email is draft-first unless the user explicitly asks to approve/send;
- appointment scheduling/rescheduling must use the conflict check and current calendar version where required;
- server-owned deposit/payment policy must not be overridden.

Adapt language and user-facing wording per artist, but do not weaken these rules.

## 12. Core E2E verification

Use a read-only Core request first, for example:

```text
Покажи мои заявки.
```

The user may need to complete physical OAuth sign-in and consent in GPT Builder/Preview. This is an expected manual boundary.

Do not treat the GPT answer alone as proof.

Independently verify production evidence:

1. Auth log shows `/oauth/authorize` for the expected new Client ID.
2. Auth log shows `/oauth/token` with HTTP `200` for that Client ID.
3. API log shows `POST /rest/v1/rpc/gpt_list_enquiries` with HTTP `200`.
4. If the GPT displays a specific enquiry, safely verify its `artist_id` in production and prove it belongs to the intended artist.
5. Do not expose another artist's PII while checking isolation.

Only after this evidence is complete mark Core as verified.

## 13. Operations E2E verification

Use a read-only Operations request, for example:

```text
Покажи мои записи с 1 по 30 ноября 2026.
```

Use a current/relevant date window when repeating this runbook.

Complete the separate OAuth flow if GPT Builder prompts again.

Independently verify:

1. a new `/oauth/token` HTTP `200` for the expected Client ID if Operations performed a fresh authorization;
2. `POST /rest/v1/rpc/gpt_list_appointments` HTTP `200`;
3. returned appointment scope is the intended artist;
4. no cross-artist record is exposed.

Only after this evidence is complete mark Operations as verified.

## 14. Diagnose `invalid_credentials`

Symptom in GPT Builder:

```text
Access token is missing or invalid, received 400 ... /oauth/token
invalid client credentials
```

First prove where the flow fails.

If `/oauth/authorize` and consent succeed but Supabase `/oauth/token` returns `400 invalid_credentials`, then callback routing and authorization are already substantially working. Focus on client authentication.

Check, in order:

1. Builder Client ID exactly equals the intended current Supabase OAuth client.
2. Supabase client is active/not deleted.
3. Client type is `confidential`.
4. Token endpoint auth method is `client_secret_basic`.
5. GPT Builder Token Exchange Method is `Basic`.
6. The secret entered in Builder is the secret for that exact client version.
7. Core and Operations were both updated if the client was replaced.

If a regenerated secret is known to have been entered correctly but token exchange still returns the same `invalid_credentials`, prefer creating a fresh versioned OAuth client (`v<N+1>`) rather than repeatedly mutating a suspect client.

Then:

- bind the new Client ID to the same artist integration;
- re-enable the same capabilities;
- update Core OAuth configuration;
- update Operations OAuth configuration;
- re-run both E2E checks;
- retire the superseded OAuth client only after the new client is fully proven.

A real production incident followed this pattern: secret regeneration on one client still produced `invalid_credentials`; a newly created versioned OAuth client succeeded. Preserve that diagnostic lesson without hardcoding the historical client IDs.

## 15. Diagnose schema import failures

### `Could not find a valid URL in servers`

A known failure mode is accidentally importing the privacy HTML into the Schema field.

If Schema begins with HTML such as:

```text
<!doctype html>
```

or contains the privacy notice title, the wrong URL was imported.

Fix:

- clear the Schema field;
- use `Import from URL` with the exact-SHA OpenAPI YAML URL;
- keep Privacy Policy URL in its dedicated field;
- confirm the schema starts with `openapi: 3.1.0`;
- confirm `servers` contains the correct GPT action domain.

### Too many operations

If Builder rejects a monolithic schema or operation count changed:

- run/read `scripts/test-gpt-openapi-split.mjs` at the exact current product head;
- re-derive the supported split from current tests and OpenAI platform limits;
- do not delete operations ad hoc merely to satisfy Builder.

## 16. Diagnose OAuth consent routing failures

If Supabase authorization succeeds but the CRM consent page opens the normal dashboard or does not render consent:

- verify the currently deployed private CRM includes pathname handling for `/oauth/consent`;
- verify the production CRM deployed SHA, not only repository code;
- inspect the current OAuth consent router regression tests;
- do not change Supabase redirect URIs as a workaround for a CRM pathname router defect.

This defect has occurred before when a later production stack omitted an earlier consent pathname hotfix.

## 17. Diagnose callback or authorization failures

For a `400` from the bridge authorization endpoint, validate the callback against the exact current `safeChatGPTCallback` implementation.

Do not guess a callback URL.

Record the URL generated by GPT Builder and verify:

- HTTPS;
- exact permitted host;
- exact `/aip/<id>/oauth/callback` form;
- no unexpected query/hash/userinfo.

If OpenAI changes callback host/path conventions, update Worker validation deliberately with tests before onboarding rather than weakening validation to a wildcard.

## 18. Diagnose Action `401/403` after successful OAuth

If token exchange is `200` but Action calls fail:

1. read current `crm_private.gpt_action_clients` binding;
2. prove the token `client_id` equals that binding;
3. check `is_active`;
4. check the specific capability flag;
5. verify the signed-in human has active artist membership/permission required by the RPC;
6. inspect the final effective RPC definition and grants;
7. verify Worker route allow-list and action endpoint mapping;
8. check API logs for the exact failing RPC.

Do not solve an authorization failure by weakening RLS, grants, owner checks, artist membership, or Worker allow-lists.

## 19. Retire superseded OAuth clients

After both Core and Operations are independently verified on the new client:

1. prove the artist integration row references only the new Client ID;
2. prove the old Client ID has no active GPT binding;
3. verify no other integration references the old client;
4. remove/deactivate the old OAuth App through the supported Supabase Auth Admin API or Dashboard;
5. do not directly edit managed `auth.oauth_clients` SQL rows unless Supabase explicitly documents that as the supported administrative path;
6. verify the new client remains active after cleanup.

Never delete the old client before the replacement has passed both E2E Action sets.

## 20. Required final evidence

A completed onboarding/replacement report must record, without secrets:

```text
Repository
Product PR
Product exact head SHA
Product base SHA
Exact-head CI status
Production Supabase health
Retained staging health
Artist/integration key
New OAuth Client ID
Supabase redirect URI
Core exact-SHA schema URL
Operations exact-SHA schema URL
Core ChatGPT callback URL
Operations ChatGPT callback URL
Core /oauth/token result and timestamp
Core gpt_list_enquiries result and timestamp
Operations /oauth/token result and timestamp
Operations gpt_list_appointments result and timestamp
Final capability flags
Artist-isolation evidence
Old-client cleanup status
Production mutations performed
Staging mutations performed
```

Never include Client Secret, tokens, authorization codes, cookies, or secret-key material in this evidence.

## 21. Completion criteria

The process is complete only when all of these are true:

- current product/deployment state was freshly checked;
- new OAuth client is bound to exactly one intended artist;
- required capabilities are enabled through an authorized path;
- Core imports from exact-SHA OpenAPI URL;
- Operations imports from exact-SHA OpenAPI URL;
- both Builder callback URLs pass the Worker validator;
- Core OAuth token exchange is `200`;
- Core read Action is `200` and artist-scoped;
- Operations OAuth token exchange is `200` when a separate exchange occurs;
- Operations read Action is `200` and artist-scoped;
- no secret was exposed;
- superseded client has no active artist binding;
- retained staging was not mutated;
- no unrelated production system was changed.

## 22. Do not do these things

Never:

- paste a Client Secret into chat;
- commit a Client Secret;
- ask ChatGPT to send `artist_id`;
- add arbitrary ChatGPT callbacks to Supabase while the dynamic bridge is current;
- use a privacy HTML URL as an OpenAPI schema URL;
- import a moving branch schema when an exact-SHA URL is available;
- infer external activation from repository code alone;
- declare OAuth fixed solely because consent rendered;
- declare an Action fixed solely because the GPT displayed a plausible answer;
- bypass owner/artist checks by fabricating JWT claims;
- weaken RLS/RPC ACL/Worker allow-lists to make onboarding succeed;
- reuse an old OAuth client without first proving its current state;
- delete the old OAuth client before both replacement Action sets pass E2E;
- mutate retained staging during production GPT onboarding.
