# GPT Actions production rollout

This runbook promotes the already-tested private GPT appointment action surface to production without changing the RPC or RLS model introduced by migrations 0032-0034.

## Fixed boundaries

- Production Supabase project: `vfjexhfdbrjmuxfdvbdx`.
- Production CRM origin: `https://crm.vishartattoo.com`.
- Production GPT action host: `https://gpt-actions.vishartattoo.com`.
- Base production GPT branch: `agent/gpt-production-actions`.
- Current OAuth compatibility branch: `agent/gpt-production-pkce-bridge`.
- Retained staging is never targeted by this rollout.
- The Worker carries no Supabase service-role or secret key. It forwards the signed-in user's Supabase OAuth bearer token and only the public project key.
- Artist scope is never accepted from ChatGPT. `auth.jwt()->>'client_id'` resolves through `crm_private.gpt_action_clients` to exactly one artist.
- Client search returns only CRM client ID and name. No phone, email, Instagram, address, finance or arbitrary query surface exists.
- Appointment create/reschedule/cancel remain consequential actions and use existing idempotency/calendar-version checks.
- There is no GPT action for WhatsApp, Telegram, email, payments or arbitrary CRM writes.

## Why rollout uses release operator branches

The protected `crm-production` GitHub environment allows approved release branches and correctly rejects pull-request merge refs. Production workflows therefore run only when a dedicated release operator branch is fast-forwarded to the exact, already-green product head. Each production workflow verifies that its release SHA is byte-for-byte equal to its declared product branch before any production mutation.

No code is merged to `main`, no feature PR is marked Ready, and the operator branch must not carry an extra rollout commit.

## Phase 1: backend bootstrap

1. Exact product head must pass normal `Static Validation` and `CRM and booking validation`.
2. Fresh-check production DB state and confirm the expected migration/GPT rows.
3. Create `release/private-crm-rc26-gpt-actions` at the parent RC25 SHA, then fast-forward it to the exact green `agent/gpt-production-actions` head. That push is the bootstrap trigger.
4. `gpt-production-bootstrap.yml` re-verifies that release SHA equals product head, re-runs focused production GPT tests, audit, bundle check and secret scan.
5. It enables the production Supabase OAuth server with dynamic registration disabled.
6. It deploys only `vishar-gpt-actions-production` at `gpt-actions.vishartattoo.com` with OAuth relay enabled and appointment actions disabled.
7. Expected external state after the phase: `/privacy` = 200, incomplete `/oauth/authorize` = 400, `/v1/appointments` = 404.
8. No OAuth client is created and no GPT database binding is activated in this phase.

## Phase 2: create two production OAuth clients

Create one confidential Supabase OAuth client for Vladimir's private GPT and one for Kristina's private GPT. Use `authorization_code,refresh_token` and `client_secret_basic`.

The client secret is shown only during OAuth client creation and must be copied directly into that GPT's OAuth configuration. Never put it in GitHub, CRM data, ChatGPT conversation text, logs or documentation.

For each GPT configure:

- authorization URL: `https://gpt-actions.vishartattoo.com/oauth/authorize`
- token URL: `https://gpt-actions.vishartattoo.com/oauth/token`
- scope: `email`
- token exchange: Basic/client-secret authentication
- OpenAPI schema: `docs/gpt-actions/openapi.production.yaml`
- privacy policy: `https://gpt-actions.vishartattoo.com/privacy`

The callback displayed by the GPT editor is treated as an untrusted-but-validated downstream callback. The Worker accepts only HTTPS callbacks on `chat.openai.com` or `chatgpt.com` with the exact `/aip/<gpt-id>/oauth/callback` shape. It does not use a wildcard redirect at Supabase.

Supabase receives one fixed Worker callback instead:

`https://gpt-actions.vishartattoo.com/oauth/callback`

Register that exact fixed Worker callback on each production OAuth client. This decouples Supabase's exact redirect registration from GPT editor callback changes while preserving an exact upstream redirect URI.

## Phase 3: bind the non-secret client IDs

After the two OAuth clients exist, bind only their non-secret client IDs to the existing production rows:

- `vladimir-gpt-actions` -> Vladimir production OAuth client ID
- `kristina-gpt-actions` -> Kristina production OAuth client ID

Use the existing owner-only `configure_gpt_action_client(...)` path. Both rows must be active, readable and manageable. Do not store or pass client secrets to this RPC.

Verify directly in production that there are exactly two active GPT client rows, both have non-null distinct OAuth client IDs, and no retained-staging OAuth client ID is reused.

## Phase 4: enable the action edge

Immediately before activation, perform a **fresh live Supabase check** of the production project. Confirm that both production GPT rows are active, both have distinct non-null OAuth client IDs, and neither client ID matches retained staging. CI deliberately does not mutate or manufacture this state.

The original action-edge activation used `release/private-crm-rc27-gpt-actions-enable` at the exact green `agent/gpt-production-actions` head.

Expected unauthenticated state after activation:

- `/privacy` = 200
- incomplete `/oauth/authorize` = 400
- `/v1/appointments` without OAuth bearer = 401

A 200 from an action endpoint without an OAuth token is a release blocker.

## Phase 5: production smoke test

Use the two private GPTs separately. For each artist:

1. complete OAuth sign-in as an authorised production CRM user;
2. search a known client by name;
3. list a bounded appointment window;
4. read one appointment;
5. check a non-mutating conflict window first;
6. perform an appointment mutation only when it is valid production work, then verify the CRM activity event and Calendar outbox result;
7. prove the other artist's records are not visible.

Do not create synthetic production client records just for this test. Use existing legitimate production records and avoid mutations unless there is a real intended appointment change.

## Phase 6: Custom GPT to Supabase S256 PKCE bridge

Supabase OAuth 2.1 requires Authorization Code with S256 PKCE. The observed Custom GPT authorization request does not supply `code_challenge` or `code_challenge_method`, so the production Worker must bridge the two protocols without disabling Supabase PKCE.

The bridge has these properties:

1. ChatGPT sends its normal confidential-client authorization request to `/oauth/authorize` with Client ID, exact GPT callback and `state`.
2. The Worker validates the GPT callback, generates a random PKCE verifier, derives an S256 challenge, replaces the upstream redirect URI with the fixed Worker callback, and sends the S256 request to Supabase.
3. The original GPT callback, state, client ID, verifier and short expiry are carried only inside an AES-GCM authenticated encrypted bridge state.
4. Supabase redirects its authorization code to the fixed Worker callback. The Worker converts that upstream code into a second encrypted short-lived bridge code and redirects the browser to the original validated GPT callback with the original `state`.
5. ChatGPT posts that opaque bridge code to `/oauth/token` using the existing confidential Client ID/Secret authentication.
6. The Worker verifies the Basic-auth Client ID against the encrypted bridge payload, restores the Supabase authorization code, fixed Worker callback and PKCE verifier, then performs the Supabase token exchange.
7. The Supabase authorization code and PKCE verifier are never exposed to ChatGPT in plaintext. The client secret is never stored by the Worker and is forwarded only in the token endpoint Authorization header.
8. Refresh-token requests continue to use the same confidential Client ID/Secret authentication and are forwarded to Supabase without changing artist scope.

The AES-GCM bridge secret is generated by the protected production workflow and stored only as the Cloudflare Worker secret `GPT_OAUTH_BRIDGE_SECRET`. It must not exist in tracked Wrangler config, GitHub files, Supabase, CRM tables, logs or GPT settings.

Before deploying the bridge:

1. append the exact fixed Worker callback to both production Supabase OAuth clients;
2. leave both existing production OAuth client IDs and secrets unchanged;
3. leave the database artist bindings unchanged;
4. verify retained staging is not targeted;
5. require normal CI and secret scan green on the exact bridge head.

Deploy only from `release/private-crm-rc28-gpt-pkce-bridge`, which must point exactly to the green `agent/gpt-production-pkce-bridge` head. The protected `crm-production` gate remains mandatory.

After deployment, retry OAuth from a new GPT chat. A changed GPT callback does not require another Supabase redirect update as long as it remains a valid HTTPS ChatGPT `/aip/<gpt-id>/oauth/callback` URL. The Worker validates the downstream callback on every authorization request, while Supabase sees only the fixed Worker callback.

## Rollback

Least destructive containment order:

1. set `GPT_ACTIONS_ENABLED=false` on the production Worker while leaving the privacy route available;
2. if OAuth must also be closed, set `GPT_OAUTH_RELAY_ENABLED=false`;
3. deactivate the affected `crm_private.gpt_action_clients` row through the existing owner configuration path;
4. revoke/delete the affected Supabase OAuth client if its credential is suspected compromised.

Do not weaken RPC ACLs, RLS, artist membership checks, Supabase PKCE or Calendar protections as a rollback shortcut.
