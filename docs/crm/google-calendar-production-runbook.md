# Google Calendar production runbook

Companion to `docs/crm/adr/0006-google-calendar-production-rollout.md`.

This runbook covers the first production deployment of the Calendar connector
Worker. That deployment is deliberately inert: the connector is reachable and
can be connected to Google, but the scheduled drain is disabled and declares no
cron, so no calendar event is created, updated or deleted by it.

Nothing in this repository performs any step marked **manual**. Those steps are
Vladimir's, and several of them require his own Google sign-in.

---

## 0. Preconditions

| Check | Expected |
|---|---|
| Production Supabase migrations | `0001`–`0041` applied (Calendar chain complete) |
| Production `integration_outbox` | empty |
| Production `artist_availability_blocks` | empty |
| Production `artist_integrations` | no `calendar` rows |
| Deployed private CRM | `VITE_CALENDAR_CONNECTOR_ORIGIN` empty |
| Retained staging | untouched, still on its own Google client, KV namespaces and Supabase project |

Re-verify these rather than trusting this table; it records a point in time.

---

## 1. Google Cloud production project — manual

A **separate project from staging**. See ADR 0006 §1 for why.

1. Create a new Google Cloud project for production.
2. Enable the **Google Calendar API** on it.
3. Configure the OAuth consent screen as **External**, and authorise both artist
   accounts: `vvetrov41@gmail.com` and `tinaakaten@gmail.com`.
4. Move the app to **In production** publishing status.

   An External app left in **Testing** issues refresh tokens that expire after
   **seven days**. The connector would begin failing on day eight with no
   user-visible cause. This step is not optional.

5. Create a **Web application** OAuth client with exactly one authorised
   redirect URI:

   ```
   https://calendar.vishartattoo.com/oauth/google/callback
   ```

   No wildcard, no trailing slash variant, no `http`, and no authorised
   JavaScript origins.

6. Record the client ID and client secret for step 4 below. Do not paste them
   into a chat, a workflow file, a pull request or Git.

Do not modify the staging Google project, its client, its redirect URI or its
publishing status.

---

## 2. Cloudflare resources — manual, Phase 2B

Create in this order. Steps 2.2 and 2.3 must precede any deploy, because their
identifiers are inputs to the generated deploy configuration.

1. **KV namespaces** — two new ones, for example titled
   `CALENDAR_OAUTH_STATE_PRODUCTION` and `CALENDAR_OAUTH_TOKENS_PRODUCTION`.
   Record both 32-character ids. Never reuse the staging namespaces.

2. **Access application** — self-hosted, domain `calendar.vishartattoo.com`,
   covering the whole hostname with no path exclusion. One allow policy
   including only `vvetrov41@gmail.com`. Session duration 24h. Set the
   HTTP-only cookie attribute, matching the production CRM application rather
   than the looser staging Calendar application. Record the application's
   **audience (AUD)** tag.

   The Google callback is a top-level browser navigation on this hostname and
   carries the Access cookie, so it must stay inside the application. Excluding
   the callback path would break the OAuth flow *and* remove its identity check.

3. **Custom Domain** — bind `calendar.vishartattoo.com` to the
   `vishar-calendar-production` Worker. The deploy workflow strips the route
   from the generated config precisely so it can never create or alter this.

4. **WAF custom rule** — a path boundary for the hostname, allowing only the
   Worker's real routes and blocking everything else. This is the fourth of the
   Free plan's five custom rules.

Note that no rate-limiting change is required. The connector carries its own
isolated Workers rate limiter; the zone's single shared WAF rate-limiting rule
is not read or modified.

---

## 3. GitHub `crm-production` environment — manual

| Kind | Name | Value |
|---|---|---|
| var | `CRM_PRODUCTION_CALENDAR_WORKER` | `vishar-calendar-production` |
| var | `CRM_PRODUCTION_CALENDAR_ACCESS_AUD` | the AUD from step 2.2 |
| var | `CRM_PRODUCTION_CALENDAR_KV_STATE_ID` | the state namespace id from step 2.1 |
| var | `CRM_PRODUCTION_CALENDAR_KV_TOKENS_ID` | the tokens namespace id from step 2.1 |
| var | `CRM_PRODUCTION_CALENDAR_DEPLOY_ENABLED` | `false` until the moment of deploy |
| var | `CRM_PRODUCTION_SUPABASE_URL` | already configured, reused |
| secret | `CRM_PRODUCTION_CLOUDFLARE_API_TOKEN` | already configured, reused |
| secret | `CRM_PRODUCTION_CLOUDFLARE_ACCOUNT_ID` | already configured, reused |

Every one of these is validated before the workflow makes any network call, and
each is refused if it equals its retained-staging counterpart.

---

## 4. Worker secrets — manual

Install directly on `vishar-calendar-production` with `wrangler secret put`.
The workflow verifies these by **name** only and never reads a value.

| Secret | Notes |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | from the production Google project |
| `GOOGLE_OAUTH_CLIENT_SECRET` | from the production Google project |
| `CALENDAR_TOKEN_ENCRYPTION_KEY` | 32 fresh random bytes, base64url, **distinct from staging's** |
| `SUPABASE_SECRET_KEY` | production Supabase service credential |

---

## 5. Deploy

Always run validation-only first.

```
Workflow: Deploy private production Calendar connector
Branch:   release/private-crm-rc<N>
Inputs:   approved_sha = <exact release branch HEAD SHA>
          deploy = false
          approval_phrase = (empty)
```

When that is green, set `CRM_PRODUCTION_CALENDAR_DEPLOY_ENABLED` to `true` and
re-run with:

```
          deploy = true
          approval_phrase = DEPLOY_PRIVATE_CRM_CALENDAR
```

Then set `CRM_PRODUCTION_CALENDAR_DEPLOY_ENABLED` back to `false`.

The run fails closed if the branch is not a `release/private-crm-rc*` branch, if
`approved_sha` does not byte-match the workflow source SHA, if the deploy flag
is not explicitly enabled, or if the approval phrase is not exact.

---

## 6. Post-deploy verification

1. `curl -i https://calendar.vishartattoo.com/health` must return a Cloudflare
   Access response (302/303/307/401/403). A `200` means Access is not gating the
   hostname — treat that as an incident and go to rollback step R2.
2. Sign in through Access, then fetch `/health` again. It must report
   `scheduledDrain: false`.
3. Confirm `crm.vishartattoo.com` still loads and still shows no Calendar
   Connect controls.
4. Confirm the zone's WAF rate-limiting rule is unchanged and still has exactly
   one rule.

---

## 7. Connecting Google — manual, requires Google sign-in

Only after the deployment is verified.

1. Vladimir authenticates to `calendar.vishartattoo.com` through Access
   (one-time PIN to `vvetrov41@gmail.com`).
2. `/oauth/google/start/vladimir` → **Vladimir signs into Google as
   `vvetrov41@gmail.com`**. Any other Google account is rejected by
   `validateGoogleAccount`.
3. `/oauth/google/start/kristina` → **Kristina signs into Google as
   `tinaakaten@gmail.com`** at the consent screen. Vladimir initiates the flow
   from his own Access session; only the Google sign-in is Kristina's.

Because production has no availability blocks and an empty outbox, a successful
connect enqueues zero jobs. With the drain disabled and no cron, nothing is sent
to Google afterwards.

---

## 8. Rollback

Ordered least-destructive first. Because the CRM build still has an empty
connector origin, none of these are visible to CRM users.

| # | Trigger | Action |
|---|---|---|
| R1 | Deploy validation failed | Nothing to undo — every gate runs before the first live call |
| R2 | Worker deployed but misbehaving, or Access not gating | Delete the `calendar.vishartattoo.com` Custom Domain. Immediately unreachable; the managed `AAAA` record is removed with it. Worker and KV preserved for diagnosis |
| R3 | Worker itself is wrong | `wrangler rollback`, or redeploy the previous version |
| R4 | A Google connection must be undone | `POST /oauth/google/disconnect/<alias>` — revokes the Google refresh token, deletes the KV envelope regardless of Google's response, and marks the integration disabled through the backend RPC |
| R5 | Token store must be destroyed | After R4, delete the two **production** KV namespaces. Never delete the staging namespaces |
| R6 | Full withdrawal | Delete the Worker; delete the Access application; remove the WAF custom rule; delete or revoke the production Google OAuth client. The zone rate-limiting rule needs no action because it was never modified |

There is no database rollback path and none is needed: this deployment applies
no migration, and the Calendar schema is already live and inert.

---

## 9. What is deliberately *not* in this runbook

- enabling the scheduled drain — a separate change that must add both a
  `[triggers]` cron and `CALENDAR_DRAIN_ENABLED = "true"`, with its own approval
  phrase and its own inverted CI assertion;
- exposing the connector in the production CRM build;
- any Monzo or payment activation.
