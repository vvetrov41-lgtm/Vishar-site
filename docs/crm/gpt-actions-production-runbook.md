# GPT Actions production rollout

This runbook promotes the already-tested private GPT appointment action surface to production without changing the RPC or RLS model introduced by migrations 0032-0034.

## Fixed boundaries

- Production Supabase project: `vfjexhfdbrjmuxfdvbdx`.
- Production CRM origin: `https://crm.vishartattoo.com`.
- Production GPT action host: `https://gpt-actions.vishartattoo.com`.
- Retained staging is never targeted by this rollout.
- The Worker carries no Supabase service-role or secret key. It forwards the signed-in user's Supabase OAuth bearer token and only the public project key.
- Artist scope is never accepted from ChatGPT. `auth.jwt()->>'client_id'` resolves through `crm_private.gpt_action_clients` to exactly one artist.
- Client search returns only CRM client ID and name. No phone, email, Instagram, address, finance or arbitrary query surface exists.
- Appointment create/reschedule/cancel remain consequential actions and use existing idempotency/calendar-version checks.
- There is no GPT action for WhatsApp, Telegram, email, payments or arbitrary CRM writes.

## Phase 1: backend bootstrap

1. Exact head must pass normal `Static Validation` and `CRM and booking validation`.
2. Add the PR marker `<!-- DEPLOY_GPT_PRODUCTION_BOOTSTRAP -->`.
3. `gpt-production-bootstrap.yml` enables the production Supabase OAuth server with dynamic registration disabled.
4. It deploys only `vishar-gpt-actions-production` at `gpt-actions.vishartattoo.com` with OAuth relay enabled and appointment actions disabled.
5. Expected external state after the phase: `/privacy` = 200, incomplete `/oauth/authorize` = 400, `/v1/appointments` = 404.
6. No OAuth client is created and no GPT database binding is activated in this phase.

## Phase 2: create two production OAuth clients

Create one confidential Supabase OAuth client for Vladimir's private GPT and one for Kristina's private GPT. Use `authorization_code,refresh_token`, `client_secret_basic`, and the exact callback URL shown by the corresponding GPT editor. Do not guess or normalize the callback URL.

The client secret is shown only during OAuth client creation and must be copied directly into that GPT's OAuth configuration. Never put it in GitHub, CRM data, ChatGPT conversation text, logs or documentation.

For each GPT configure:

- authorization URL: `https://gpt-actions.vishartattoo.com/oauth/authorize`
- token URL: `https://gpt-actions.vishartattoo.com/oauth/token`
- scope: `email`
- token exchange: Basic/client-secret authentication
- OpenAPI schema: `docs/gpt-actions/openapi.production.yaml`
- privacy policy: `https://gpt-actions.vishartattoo.com/privacy`

OpenAI's GPT editor supplies the callback URL. Use that exact value for the matching Supabase OAuth client.

## Phase 3: bind the non-secret client IDs

After the two OAuth clients exist, bind only their non-secret client IDs to the existing production rows:

- `vladimir-gpt-actions` -> Vladimir production OAuth client ID
- `kristina-gpt-actions` -> Kristina production OAuth client ID

Use the existing owner-only `configure_gpt_action_client(...)` path. Both rows must be active, readable and manageable. Do not store or pass client secrets to this RPC.

Verify directly in production that there are exactly two active GPT client rows, both have non-null distinct OAuth client IDs, and no staging OAuth client ID is reused.

## Phase 4: enable the action edge

Immediately before activation, perform a **fresh live Supabase check** of the production project. Confirm that both production GPT rows are active, both have distinct non-null OAuth client IDs, and neither client ID matches retained staging. CI deliberately does not mutate or manufacture this state.

Only after that live check passes, add `<!-- ENABLE_GPT_PRODUCTION_ACTIONS -->` to the same draft PR. `gpt-production-activate.yml` redeploys the same Worker with OAuth relay and GPT actions enabled.

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

## Rollback

Least destructive containment order:

1. set `GPT_ACTIONS_ENABLED=false` on the production Worker while leaving the privacy route available;
2. if OAuth must also be closed, set `GPT_OAUTH_RELAY_ENABLED=false`;
3. deactivate the affected `crm_private.gpt_action_clients` row through the existing owner configuration path;
4. revoke/delete the affected Supabase OAuth client if its credential is suspected compromised.

Do not weaken RPC ACLs, RLS, artist membership checks or Calendar protections as a rollback shortcut.
