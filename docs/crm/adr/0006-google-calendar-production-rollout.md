# ADR 0006: Google Calendar production rollout

Status: proposed for the production Calendar connector deployment

Supersedes nothing. Extends ADR 0003 (projection and artist routing) and
ADR 0004 (OAuth and token custody) from staging to production.

## Context

ADR 0004 deliberately placed production deployment out of scope. The Calendar
projection, outbox drain, OAuth connector and cancelled-event recovery are now
validated on retained staging, and the production database already carries every
Calendar migration through `0041`. What remains is a production runtime.

The production environment differs from staging in ways that change the design
rather than only its values:

- the `vishartattoo.com` zone is on the Cloudflare **Free** plan, which allows
  exactly one WAF rate-limiting rule per zone, and that rule already protects the
  staging intake, GPT Actions and Team admin surfaces;
- production Supabase holds real client data once the CRM is in use, so a
  staging-shaped token store or Supabase credential is not an acceptable
  fallback;
- Google's own guidance is to separate testing and production projects, and an
  External OAuth app left in Testing issues refresh tokens that expire after
  seven days.

## Decision

### 1. A separate Google Cloud production project

Production uses its **own Google Cloud project**, not a second OAuth client
inside the staging project.

Two reasons, both load-bearing:

- **Refresh-token lifetime.** An External OAuth app in **Testing** publishing
  status issues refresh tokens with a seven-day lifetime. A connector whose
  tokens silently expire every week is not a production integration: the drain
  would begin failing on day eight with no user-visible cause. The production
  app must reach **In production** publishing status, and publishing status is a
  property of the project's OAuth consent screen, not of an individual client.
  Staging deliberately stays in Testing, so the two cannot share one project.
- **Blast radius.** Consent-screen changes, scope changes, verification state and
  client deletion are all project-scoped. Sharing a project would let a staging
  experiment revoke production's authorisation.

The production project needs the Google Calendar API enabled, an OAuth consent
screen configured for the two artist accounts, and a Web OAuth client whose only
authorised redirect URI is exactly:

```
https://calendar.vishartattoo.com/oauth/google/callback
```

No wildcard, no trailing-slash variant, no `http`, and no authorised JavaScript
origins — the flow is server-side authorization-code with PKCE. The scope set is
unchanged from staging: `openid email
https://www.googleapis.com/auth/calendar.events`.

Staging's Google project, client, redirect URI and publishing status are not
modified by this decision.

### 2. Rate limiting uses an isolated Workers binding, not the zone WAF rule

The production Calendar Worker declares its own
[Workers rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
and enforces it in code. It does **not** extend the zone's single WAF
rate-limiting rule.

The zone rule is a shared, scarce resource: the Free plan permits one, and the
existing rule covers the staging intake path, the GPT Actions OAuth and `/v1/`
paths, and the Team admin invite endpoint. Widening its expression would couple
the Calendar connector's protection to three unrelated surfaces, so every future
Calendar change would carry the risk of breaking booking or Team admin
protection, and editing the rule clears its currently-triggered actions.

The Workers binding avoids all of that:

- it is declared on one Worker script and applies to that script only;
- it creates no zone ruleset rule, so the one-rule quota is untouched and the
  existing rule keeps protecting the surfaces it already protects;
- `namespace_id` is a developer-chosen positive integer that names the limiter
  within the account. It is not a Cloudflare object identifier, so nothing has to
  be provisioned and the value can live in tracked configuration.

`namespace_id` is **account-wide**: two Workers that declare the same integer
share one set of counters. `1001` was therefore verified free before it was
chosen — all ten Workers in the account were read successfully and none declares
a rate limiter, and no tracked Wrangler configuration in this repository
declares `[[ratelimits]]` or any `namespace_id`. Any future limiter added to
another Worker must pick a different integer, and the same check must be
repeated rather than assumed.

The trade-off is accepted deliberately: the binding is documented as permissive,
eventually consistent and counted per Cloudflare location, so it is a guard
against runaway automation rather than an accounting mechanism. That is the
correct shape for this Worker, whose real authorisation boundary is Cloudflare
Access and whose legitimate traffic is a single owner performing an OAuth flow a
handful of times.

Retained staging declares no binding and keeps the controls it already has.

### 3. Rate-limit key design

The bucket key is `<route class>:<actor>`.

**Route class** is a closed enumeration — `health`, `oauth_start`,
`oauth_callback`, `oauth_disconnect`, `other`. Deriving it from the raw pathname
would let a caller mint unlimited buckets by rotating unmatched paths, so
everything the router does not recognise shares the single `other` bucket.

**Actor** is the Access session, identified by the SHA-256 of the raw
`Cf-Access-Jwt-Assertion` header. Cloudflare's guidance is not to key on client
addresses because they are shared, and this Worker is only reachable behind an
owner-only Access application, so the session is both narrower and more
meaningful. The header is hashed rather than parsed: an unverified JWT payload is
attacker-controlled, so keying on a claim inside it would let a caller rotate the
bucket at will, whereas a new hash requires a genuinely new Access session.
Requests arriving with no assertion — which Access should already have stopped —
collapse onto one bucket per connecting address.

The limit is 30 requests per 60 seconds per bucket. A human OAuth round trip is a
handful of requests, so this is generous for the owner and tight against
automation. The binding accepts only 10 or 60 as a period.

The check runs first in `fetch()`, before routing and before Access JWT
verification, so a refused request costs no JWKS fetch, no Google call and no KV
read.

### 4. The tracked production configuration is deliberately not deployable

`wrangler.calendar.production.toml` carries everything that is known and stable:
Worker name, entrypoint, disabled `workers_dev` and `preview_urls`, the custom
domain, the rate limiter, the artist routing, the Access team domain, the CRM
return targets, the exact Google redirect URI, and `CALENDAR_DRAIN_ENABLED =
"false"`.

It deliberately omits three values whose Cloudflare and Supabase objects do not
exist yet — the production Supabase URL, the Access audience, and the two KV
namespace ids. Committing placeholders would produce a file that reads as
deployable and is not, and inventing identifiers would be worse than omitting
them.

`scripts/generate-calendar-production-deploy-config.mjs` injects them from
protected `crm-production` environment configuration at deploy time, strips the
dashboard-owned route, and then re-asserts every safety property on the generated
artefact itself. It fails closed when any input is missing, malformed, or equal
to its retained-staging counterpart.

### 5. Two production KV namespaces, never shared with staging

`CALENDAR_OAUTH_STATE` and `CALENDAR_OAUTH_TOKENS` are bound to **new**
production namespaces. Reusing staging's is prohibited and is refused by both the
configuration validator and the deploy generator.

The token key is `artist:{artistId}` and the artist UUIDs are identical in both
Supabase projects, so a shared namespace would collide key for key: a staging
deploy could overwrite production refresh tokens, and the staging Worker —
deployed from unmerged draft branches by PR-body-triggered workflows — could read
them. ADR 0004 already requires separate token stores; this makes the requirement
enforceable.

### 6. The initial deployment is doubly inert

The scheduled drain is disabled two independent ways:

1. `CALENDAR_DRAIN_ENABLED = "false"`, and `scheduled()` requires the exact
   string `"true"`;
2. no `[triggers]` block, so the platform never invokes `scheduled()` at all.

Both are asserted on the tracked config by
`scripts/validate-calendar-production.mjs`, re-asserted on the generated deploy
config by the generator, and reported in the workflow summary. Enabling the
production drain is a separate, separately approved change that must add both.

### 7. The CRM stays unaware until separately approved

`deploy-private-production-crm.yml` continues to build with
`VITE_CALENDAR_CONNECTOR_ORIGIN: ''`, so the deployed private CRM renders the
Calendar page with its Connect and Disconnect controls suppressed. Exposing them
is a later, separate change.

This ordering means a failed or withdrawn Calendar deployment is invisible in the
CRM and requires no CRM rollback.

## Security boundaries

- Every route, including the Google callback, requires a verified
  `Cf-Access-Jwt-Assertion` bound to the **production** Access audience. The
  Access application therefore covers the whole hostname with no path exclusion.
- The OAuth `state` record stays bound to the verified owner email.
- Refresh tokens remain AES-GCM encrypted in KV and never enter Supabase, the
  browser, Git or a workflow log.
- The deploy workflow reads secret **names** only, and never their values.
- No RLS policy, RPC grant, Storage policy, Access policy, WAF rule or
  rate-limit threshold is loosened. Every change is additive and narrowing.
- The production encryption key is generated fresh and is distinct from
  staging's.

## Out of scope

- enabling the production scheduled drain;
- exposing the connector in the production CRM build;
- creating any Google project, client or consent screen;
- any Cloudflare, Supabase or Google mutation from this repository change;
- Monzo and payment activation, which remain dormant.
