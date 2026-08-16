# Monzo production rollout runbook

This runbook activates the artist-scoped Monzo connector for the production CRM. It covers two distinct responsibilities that must not be conflated:

- **A. Deposit request / payment-link flow.** Server-owned, already live. The CRM and GPT both resolve the amount through `public.request_session_deposit`, which calls `crm_private.resolve_session_deposit_tier`. The payment link itself is the existing validated Monzo payment URL stored per artist. This flow does not depend on the Monzo Developer API and must keep working whether or not a Monzo API connection exists.
- **B. Monzo Developer API OAuth / account / webhook / reconciliation-observation flow.** The connector Worker described below. It observes; it never creates a payment link and never settles a payment.

Registering a Monzo OAuth client does not create payment links, and connecting the API does not change any deposit amount.

## Fixed runtime boundary

- Dedicated Worker: `vishar-monzo-api-production`.
- Worker entrypoint: `workers/monzo-api-gateway.js` — never `workers/monzo-api.js`, which carries no rate limiter of its own.
- Tracked config: `wrangler.monzo-api.production.toml`.
- Custom Domain: exactly `monzo.vishartattoo.com`. `workers_dev=false`, `preview_urls=false`.
- No cron, no `[triggers]`.
- Production Supabase project only: `vfjexhfdbrjmuxfdvbdx`. The retained staging project `gwaliusblwrzisrwnsvs` must never appear in the production artifact.
- `MONZO_RECONCILIATION_ENABLED` starts and stays `"false"` until the OAuth, account and webhook runtime is proven correct in production.

## Public and protected surface

Exactly one path shape is publicly reachable:

```text
POST /webhooks/monzo/<43-128 character opaque key>
```

Everything else — `/health` and every `/oauth/monzo/*` management, setup, status, accounts, select-account, register-webhook and disconnect route — is owner-protected. `/health` is deliberately inside the protected boundary: it returns configuration posture, which is not something an anonymous caller should be able to enumerate.

Protection is layered, and both layers are required:

| layer | control |
| --- | --- |
| Cloudflare Access | `Vishar Monzo production owner access` on `monzo.vishartattoo.com`, allow policy, owner email only |
| Cloudflare Access | `Vishar Monzo production public webhook` on `monzo.vishartattoo.com/webhooks/monzo/*`, bypass policy, scoped to that exact path |
| Worker | `verifiedMonzoOwnerEmail` re-verifies the Access JWT signature, issuer, audience, expiry and the authenticated email against `MONZO_ACCESS_TEAM_DOMAIN`, `MONZO_ACCESS_AUD` and `MONZO_OWNER_EMAILS` |

There is no host-wide bypass. The bypass application exists only because Monzo delivers webhooks unauthenticated and cannot complete an Access challenge.

## Rate limiting

`MONZO_WEBHOOK_RATE_LIMIT` is an isolated Workers rate-limiting binding, namespace `1102`, 60 requests per 60 seconds. It is distinct from the Monzo staging limiter (`1101`) and the Calendar limiter (`1001`), so production webhook traffic never shares a counter with another surface.

Two properties matter and are covered by `scripts/test-monzo-webhook-rate-limit.mjs`:

- the limiter is applied on **every** webhook request, including while reconciliation is disabled, and a missing or erroring limiter returns 503 rather than falling through;
- all opaque webhook routes share one stable limiter key, so rotating or probing webhook paths cannot buy a fresh budget.

A Workers binding is used rather than a zone WAF rate-limiting rule because the Cloudflare Free zone allows exactly one such rule, and that rule already protects unrelated booking, GPT Actions and Team admin surfaces.

## Artist isolation

All routing is artist-scoped, with no global Monzo fallback.

| artist | alias route | artist id var | provider account key |
| --- | --- | --- | --- |
| Vladimir | `/oauth/monzo/*/vladimir` | `VLADIMIR_ARTIST_ID` | `monzo_ebt_<artist id without dashes>` |
| Kristina | `/oauth/monzo/*/kristina` | `KRISTINA_ARTIST_ID` | `monzo_ebt_<artist id without dashes>` |

Each artist has an independent OAuth state entry, encrypted token envelope, selected account, webhook key and connection state. Encrypted envelopes are keyed `artist:<artist id>` in `MONZO_OAUTH_TOKENS`. An artist with no valid configured connection fails closed; the connector never falls back to the other artist's credential.

Connecting Vladimir does not connect Kristina. Each must complete its own OAuth and in-app approval, using that artist's own Monzo login.

## Cloudflare objects

Provisioned inspect-first. Do not recreate; verify.

| object | name | id |
| --- | --- | --- |
| KV | `vishar-monzo-oauth-state-production` | `d169a7a09514481985ef5a2c85a641bc` |
| KV | `vishar-monzo-oauth-tokens-production` | `f0a905f38e544139ac2f4bd8d7444c61` |
| KV | `vishar-monzo-webhook-routes-production` | `09a94dba732f41bbac401c7491a694be` |
| Access app | `Vishar Monzo production owner access` | aud `a5398f7b94c4b67846e9a5dbcf80bbbe138f1869786c08060f3466228d0718e1` |
| Access app | `Vishar Monzo production public webhook` | aud `e617fadaf3b17866fbecc104f5738689f07bb47f4beb599c94bad921bde64ee6` |

KV namespace ids and Access audience tags are account-scoped object identifiers and public JWT claims respectively. Neither is a credential. Pinning them in tracked configuration is what lets `wrangler deploy --strict` prove that a release cannot rebind the encrypted token store or accept a token minted for a different Access application.

## Required encrypted Worker secrets

The Worker must carry exactly these four on `vishar-monzo-api-production`. Three are supplied by hand; `MONZO_TOKEN_ENCRYPTION_KEY` is generated by the bootstrap step and no human ever sees it.

| secret | source |
| --- | --- |
| `MONZO_OAUTH_CLIENT_ID` | production Monzo confidential OAuth client |
| `MONZO_OAUTH_CLIENT_SECRET` | same client |
| `MONZO_TOKEN_ENCRYPTION_KEY` | generated in-runner during bootstrap; never rotated afterwards |
| `SUPABASE_SECRET_KEY` | production Supabase service credential |

Monzo issues refresh tokens only to **confidential** clients, so the production client must be registered as confidential. The production client must not be shared with the staging Worker: Monzo permits exactly one active access token per user per client, so a shared client would let staging and production evict each other's sessions.

Never print, paste, commit, log or copy these values into an agent prompt, PR body or workflow artifact.

## Activation order

Encrypted Worker secrets cannot be installed before the Worker exists, and the full deploy gate refuses to run until they are present. The bootstrap step below breaks that dependency without weakening anything: it deploys the same artifact with the same bindings and the same Access boundary, but with no provider credentials, so every route answers `monzo_not_configured` 503 until the real rollout runs.

### How the rollout is triggered before merge

`deploy-private-production-monzo.yml` is `workflow_dispatch`, and GitHub only registers a dispatchable workflow from the default branch. While this work lives on a feature branch the dispatch API answers 404 for it, so it cannot be started that way and merging first would put production ahead of proof.

The pre-merge path is `monzo-production-operator.yml`, using the same `pull_request`-event pattern as every other branch-local operator run in this repository. Editing the pull request body to contain one activation marker carrying the **exact current head SHA** starts the corresponding phase:

```text
<!-- RUN_MONZO_PRODUCTION_VALIDATE:<head sha> -->
<!-- RUN_MONZO_PRODUCTION_BOOTSTRAP:<head sha> -->
<!-- RUN_MONZO_PRODUCTION_ROLLOUT:<head sha> -->
```

Exactly one marker may be present for a given head SHA. Any new commit changes the head SHA, so a marker left in the body expires immediately and can never authorise a later tree. Opening the pull request or pushing to it triggers nothing.

The operator holds no Cloudflare or Supabase credential and cannot deploy. Every mutating phase calls `deploy-private-production-monzo.yml`, which owns the whole gate: the `crm-production` environment approval, `CRM_PRODUCTION_MONZO_DEPLOY_ENABLED`, the exact approval phrases and the release-branch-tip check all still apply. Validation runs in a separate job with no environment and no secrets, so it never consumes a production approval. Once this work reaches the default branch, `workflow_dispatch` becomes available and drives the identical gate.

### Order

1. Fresh-check product exact head, ancestry and normal exact-head CI.
2. Set `CRM_PRODUCTION_MONZO_DEPLOY_ENABLED=true` in the `crm-production` environment.
3. Add the validate marker for the current head SHA to validate configuration, Worker tests, compile, secret scan and artifact scan without touching production.
4. Replace it with the bootstrap marker, which runs the gate with approval phrase `BOOTSTRAP_PRIVATE_CRM_MONZO_INERT` and stops for `crm-production` approval. This creates the Worker and its `monzo.vishartattoo.com` Custom Domain, and generates `MONZO_TOKEN_ENCRYPTION_KEY` inside the runner — 32 random bytes, base64url, piped straight into `wrangler secret put`, never echoed, never written to a file, never leaving the protected environment. An existing key is never replaced, because rotating it would strand every encrypted token envelope.
5. Register the production Monzo OAuth client with redirect URI exactly `https://monzo.vishartattoo.com/oauth/monzo/callback`, confidential.
6. Add the remaining three encrypted secrets to the Worker — `MONZO_OAUTH_CLIENT_ID`, `MONZO_OAUTH_CLIENT_SECRET`, `SUPABASE_SECRET_KEY`. The staging `SUPABASE_SECRET_KEY` must never be reused here.
7. Replace it with the rollout marker, which runs the gate with approval phrase `DEPLOY_PRIVATE_CRM_MONZO_ONLY` and again stops for `crm-production` approval. The workflow verifies the pre-provisioned secret **names** (never values), deploys with `--strict`, then probes the boundary.
8. Confirm the post-deploy probe: `/health` and `/oauth/monzo/*` return an Access challenge; the webhook path reaches the Worker rather than an Access challenge.
9. Connect each artist separately through the CRM Payments page, owner-only launcher.
10. Leave `MONZO_RECONCILIATION_ENABLED=false`.

## Connection lifecycle

`oauth_authorized` → `approval_pending` → `account_selected` → `webhook_registered`, with `reauthorization_required` reachable from any state.

- Monzo grants the access token **no permissions** until the account owner approves in the Monzo app. Token exchange succeeding proves nothing. A 403 from any data endpoint is treated as `approval_pending`, not as a failure.
- Account selection submitted by the browser is only a request. The server refetches `/accounts` with the artist-scoped credential and rejects anything not present in that authenticated response. Closed accounts are filtered out.
- Same-user reauthorisation preserves the selected account, webhook route and registered webhook. Different-user reauthorisation fails closed with `monzo_user_mismatch`, logs the new token out, and leaves the existing connection untouched.
- Disconnect is owner-only and its confirmation token is single-use. Local removal is authoritative: the route and encrypted envelope are deleted even if provider webhook deletion or logout fails, so a stale provider callback cannot reach reconciliation. The CRM never reports an account as connected after a local removal succeeded.
- Refreshing a Monzo token invalidates the previous one and is a one-time operation. Concurrent refreshes are handled by re-reading encrypted storage and accepting only a newer record bound to the same artist, user and OAuth client.

## Webhook contract

Monzo does not sign webhook deliveries. There is no signature, HMAC or shared secret in the provider contract, and the unguessable path is the only secret in the system. The incoming body is therefore treated as an untrusted notification hint and nothing more.

Before any reconciliation candidate is produced the server:

1. resolves the artist route internally from the opaque key, never from the payload;
2. cross-checks the stored route against the encrypted connection record;
3. verifies the credential still belongs to the expected Monzo user and OAuth client;
4. refetches the transaction by id with the artist-scoped credential;
5. proves the transaction appears in that account's own authenticated transaction list, matching on amount, currency and creation time;
6. requires an inbound GBP transfer credit: positive integer minor units, GBP, no `decline_reason`, `is_load` false, no merchant, and a recognised transfer scheme when the provider supplies one.

Amount, currency and account from the payload are never used as evidence. Monzo retries a failed delivery up to five times with exponential backoff and publishes no ordering or at-most-once guarantee, so handling is idempotent on the transaction id.

## Reconciliation boundary

Reconciliation is **candidate-only by design**. No code path in this Worker marks a payment request or a session paid, and no automatic settlement exists to enable. Human payment recording remains authoritative.

Turning `MONZO_RECONCILIATION_ENABLED` on is a separate, separately approved change and only permits candidate creation once the OAuth, account and webhook runtime has been proven correct in production.

## Deposit policy

Server-owned, derived only from `sessions.start_at` / `sessions.end_at`:

| session duration | deposit |
| --- | --- |
| up to 60 minutes | GBP 50 |
| 61–180 minutes | GBP 100 |
| 181–300 minutes | GBP 150 |
| more than 300 minutes | GBP 250 |

A session over seven hours still uses GBP 250. Multi-day work takes one deposit per reserved session, so two full-day appointments are two separate GBP 250 deposits.

Browser, GPT and manager input can never lower the amount: `crm_private.resolve_session_deposit_tier` is revoked from `public`, `anon`, `authenticated` and `service_role`, and a trigger enforces the calculated amount on the lower-level `create_payment_request` path as well as the convenience RPC. Already-issued payment requests are immutable, and a pending request fails closed rather than silently repricing after a reschedule.

## What this runbook does not authorise

- Marking any payment paid from provider observation.
- Enabling automatic settlement.
- Creating synthetic production clients, appointments, payments or transactions.
- Resetting or deleting retained staging.
- Placing production credentials or live financial data into staging.
- Widening Access, WAF or rate-limit boundaries to make a step easier.
