# Feature Specification: Universal Google Calendar onboarding

## Status

- Feature: `universal-calendar-onboarding`
- State: Production rollout; edge path scope and final third-artist acceptance pending
- Owner/workstream: Vishar CRM Calendar production engineering
- Related work: supersedes the two-artist Calendar OAuth allowlist introduced by `0030_calendar_connection_status.sql` and `0045_calendar_actor_authorization.sql`

## Problem

Calendar OAuth was hardcoded to Vladimir and Kristina across Worker routing, security, drain configuration, CRM validation and database RPCs. Onboarding artist number three, ten or one hundred required a source change, deployment configuration change and database change.

The universal implementation removes artist identity from source configuration. Cloudflare Access proves operator identity, Supabase proves current artist-scoped `manage_integrations`, and the Google account is bound server-side to the authoritative artist.

## Goals

- Any active artist whose operator holds `manage_integrations` can connect and disconnect Google Calendar with no source-code change and no new artist-specific Worker variable.
- Artist identity, provider account expectation and integration key are resolved server-side from `artists`, `crm_private.artist_access` / `profile_access` / `artist_state` and `artist_integrations`.
- The artist identifier in the OAuth URL is a lookup hint only; the authoritative artist is whatever the backend-only RPC returns for the Access-verified operator.
- The refresh token stays in encrypted Cloudflare KV keyed by the authoritative artist UUID; Supabase keeps safe metadata only.
- Existing Vladimir and Kristina connections keep working with the same Google accounts, event presentation and no reconsent.
- PKCE, OAuth `state`, disconnect confirmation nonces and Cloudflare Access verification are preserved or strengthened.
- Calendar Access uses the same bounded named-operator identity policy as the private operator CRM. It must never use `Everyone`, an email-domain selector or another broad selector. Artist authorization remains in Supabase.

## Non-goals

- Storing OAuth refresh or access tokens in Supabase.
- Letting the browser choose an artist, provider account or credential.
- Changing the live production drain activation. Production already runs the Calendar drain every five minutes and this rollout must preserve that state rather than enable or disable it implicitly.
- Changing appointment or availability projection semantics; Supabase stays authoritative and Google Calendar stays a projection.
- Building a per-artist calendar-presentation editor UI.
- Making the retained staging database look current by applying migration `0137` alone. The retained staging project is historically behind canonical and must be reconciled as a complete ordered migration chain before a Calendar migration is mutated there.

## Actors and scope

- Actor: an Access-verified CRM operator, owner or booking manager with `can_manage_integrations`, for the exact artist being connected.
- Scope: `workers/calendar-oauth.js`, `workers/lib/calendar-oauth-security.js`, `workers/lib/google-calendar.js`, migration `0137`, `admin/src` Calendar connections, Calendar wrangler configuration, Cloudflare Access identity boundary, CI and release automation.
- Environments: CI, retained staging, production Supabase, production CRM Pages and production Calendar Worker.

## User scenarios

### Scenario 1: A new artist connects

Given an active artist with no calendar integration row and an operator holding `manage_integrations` for that artist, when the operator opens Settings -> Integrations -> Google Calendar -> Connect, the Worker resolves the artist server-side, runs PKCE consent, binds the verified Google account to that artist, stores the encrypted refresh token under `artist:<artist-uuid>`, and writes `google_calendar_<slug>` metadata with `is_enabled = true`.

### Scenario 2: Vladimir and Kristina keep working

Given the existing `google_calendar_vladimir` and `google_calendar_kristina` rows, the drain keeps projecting events with the same visibility, display name, colour and event label, and reconnect still requires the previously bound Google account.

### Scenario 3: Cross-artist attempt

Given an operator authorized for artist A only, when they request `/oauth/google/start/<artist-B-slug>` or replay OAuth state issued for artist B, the request is denied with `calendar_artist_access_denied` and no token is written.

### Scenario 4: Wrong Google account

Given an artist already bound to a Google account, when the operator consents with a different Google account, the callback revokes the fresh grant, writes nothing and returns `google_account_mismatch`.

### Scenario 5: Account reuse across artists

Given artist A bound to `x@gmail.com`, when artist B tries to bind the same Google account, the metadata write is rejected by the database and the fresh grant is revoked.

### Scenario 6: Rebinding after a mistake

Given a disconnected calendar integration, when an operator with `manage_integrations` clears the recorded Google account from the CRM, the next connect may bind a different Google account. While the integration is enabled the recorded account cannot be changed.

### Scenario 7: A future operator reaches Calendar OAuth

Given a named operator already admitted to the private CRM by Cloudflare Access and holding `manage_integrations` for an artist in Supabase, the Calendar Access application admits the same verified identity. Access does not decide artist ownership. The Worker then asks Supabase for the exact artist capability and fails closed if it is absent.

## Functional requirements

- FR1 `public.resolve_calendar_artist_route(p_actor_email text, p_artist_ref text)` is backend-only (`service_role`), accepts a UUID or slug hint, and returns artist identity, integration key, recorded Google account and event presentation only when the actor currently holds `manage_integrations` for that active artist. Unknown, inactive and unauthorized all return `null`.
- FR2 Worker start/disconnect routes accept any artist reference matching the `artists.slug` shape or a UUID and never derive authoritative configuration from the reference itself.
- FR3 OAuth state stores the authoritative artist UUID. The callback re-resolves and re-authorizes that UUID before any token exchange result is persisted.
- FR4 The disconnect confirmation nonce is bound to the authoritative artist UUID and actor email.
- FR5 No `VLADIMIR_*` or `KRISTINA_*` variable is read by any Calendar code path.
- FR6 Calendar rows in `artist_integrations` must have `provider = 'google'` and `integration_key = 'google_calendar_' || artists.slug`, enforced by trigger.
- FR7 One Google account backs at most one artist Calendar integration, enforced by a unique index.
- FR8 `public.list_calendar_connection_status()` returns one row per active artist the caller can manage, for any slug.
- FR9 Event presentation lives in `artist_integrations.configuration.presentation`, is preserved across connect/disconnect, and defaults to `visibility = 'public'` plus artist display name.
- FR10 `public.reset_calendar_expected_account(p_artist_id uuid)` clears the recorded Google account for an authorized operator only while the integration is disabled.
- FR11 `calendar.vishartattoo.com` derives its Cloudflare Access allow set from the CRM capability graph rather than from any hand-curated list. Synchronization refuses broad selector classes, mutates only the Calendar policy, reads the result back, and restores the previous Calendar policy if readback does not match.
- FR12 `public.list_calendar_access_operators()` is backend-only and returns only normalised email addresses plus an owner marker, for active profiles that hold manage-integrations on an active artist.
- FR13 The Access sync refuses to write an empty or owner-less allow set, so a directory failure can never lock the account out of its own connector or widen the boundary.
- FR14 A scheduled projection applies membership changes without a developer, and runs only from a canonical head whose required workflows are all green. It does not exist yet: GitHub fires cron only on the default branch, and the `crm-production` environment admits only the `release/private-crm-rc*` namespace, so `main` must be added to that environment's deployment branches first.
- FR15 The zone firewall rule that scopes `calendar.vishartattoo.com` to the connector's routes names no artist. It allows `/health`, `/oauth/google/callback` and any reference under `/oauth/google/start/` and `/oauth/google/disconnect/`, and blocks everything else, so onboarding an artist changes no Cloudflare object.

## Non-functional requirements

- Denial responses stay uniform: unknown artist, inactive artist and unauthorized operator all produce `calendar_artist_access_denied` (403), so the endpoint does not enumerate artists.
- Failure modes stay fail-closed: any Supabase resolution failure returns `calendar_actor_authorization_failed` (502) and writes nothing.
- A failed metadata write after successful token exchange deletes the stored envelope and revokes the Google grant.
- No token material, Google response body, KV key, Cloudflare credential or Access-policy email list is logged or returned by rollout automation.
- Access synchronization is exact-head gated, uses an isolated production release namespace, rechecks canonical immediately before mutation and verifies the Calendar hostname remains Access-gated afterward.

## Acceptance criteria

- AC1 Exact-head CI is green, including Worker tests, admin tests, pgTAP and PostgreSQL lint.
- AC2 Production migration `0137` is applied in order and production migration history matches canonical. The retained staging database must not receive isolated `0137` while it remains behind canonical; staging completion requires a separate ordered catch-up proof.
- AC3 Production readback shows the generic Calendar Worker with no `VLADIMIR_*` / `KRISTINA_*` variables, existing KV/secrets/custom domain preserved, and the pre-existing five-minute drain preserved.
- AC4 `list_calendar_connection_status()` supports a third artist and the generic CRM can target `/oauth/google/start/<slug>` without a source allowlist.
- AC5 Vladimir's and Kristina's rows remain connected with their existing account bindings and presentation settings after rollout.
- AC6 Cloudflare Access for Calendar has the same fingerprint as the CRM capability graph, contains every operator that currently holds manage-integrations, and the Calendar hostname remains Access-gated.
- AC7 A newly granted membership reaches the Access boundary with no source change, no Worker variable and no manual Cloudflare edit.
- AC8 `https://calendar.vishartattoo.com/oauth/google/start/<any-new-slug>` reaches the Cloudflare Access login redirect rather than a zone block page, while an off-scope path such as `/edge-scope-probe` is still blocked at the edge.
- AC7 A real third-artist connection completes end to end. This requires interactive Google consent from that artist and is the only interactive product acceptance step.

## Retained staging note

The retained `vishar-crm-staging` Supabase project is an old long-lived environment. Fresh readback on 2026-09-04 showed migration history only through `0044`, while production and canonical are beyond `0137`. Applying only `0137` would skip required dependencies and would not be a valid staging proof. Staging is therefore fail-closed until an ordered catch-up or disposable fully migrated environment is available.

## Access identity boundary

Migration `0137` made the *authorization* universal, but one manual step
survived: `calendar.vishartattoo.com` sits behind a Cloudflare Access policy
whose named-email selectors were curated by hand. Onboarding an artist still
meant a developer editing that list, so the flow was not self-service.

Cloudflare Access cannot evaluate a Supabase capability, and the alternatives it
does offer are all wrong here: `everyone` and an email-domain rule are far too
broad for a connector that mints Google refresh tokens, a reusable Access group
is the same hand-curated list one level down, and a service token cannot ride a
top-level browser navigation.

`0139` resolves it by inverting the source of truth. `list_calendar_access_operators()`
is a backend-only projection of the same manage-integrations predicate the
Worker already enforces, and the Access policy is rewritten from it. The edge
allow-set therefore cannot be broader than the capability it mirrors, and it
updates itself: granting a membership in the CRM is the only action onboarding
needs.

Access is now purely identity verification — it proves the operator controls a
mailbox that currently holds manage-integrations somewhere. It decides nothing
about *which* artist, which remains `resolve_calendar_artist_route` evaluated
per request.

## Edge path scope

A second per-artist allow-list survived `0139`, one layer in front of Access.
Probing production on 2026-09-04 gives a deterministic exact-path pattern:

```
/health                            302 Access login
/oauth/google/callback             302
/oauth/google/start/vladimir       302
/oauth/google/start/kristina       302
/oauth/google/disconnect/vladimir  302
/oauth/google/start/VLADIMIR       403 zone block page
/oauth/google/start/vladimir/      403
/oauth/google/start/sam            403
/random-path                       403
```

The 403 body is the zone-level Cloudflare block page, it is case-sensitive, and
it is specific to this hostname: `calendar-staging.vishartattoo.com` answers 302
on every path. There is exactly one Access application for
`calendar.vishartattoo.com` covering the bare hostname, so Access cannot be
producing a per-path decision. The only layer left in front of Access is the
zone firewall, and it enumerates the two launch artists.

That is also why a "0 rulesets" inventory line was not evidence of absence: the
production Cloudflare API token answers 403 to `/zones/{id}/rulesets`,
`/firewall/lockdowns`, `/firewall/rules` and `/firewall/access_rules/rules`. It
holds Access, DNS, Workers and Pages scopes but no Firewall Services scope, so
the layer that carries the enumeration is the one layer it cannot see.

`scripts/calendar-edge-scope-sync.mjs` replaces that one rule's expression with
the artist-free scope in FR15 and nothing else: it refuses unless exactly one
block rule at this hostname exists, reads back, verifies no neighbouring rule
moved, and restores the original expression otherwise. Deny-by-default off the
connector's four route shapes is preserved, and Access plus
`resolve_calendar_artist_route` still decide identity and artist.

## Open gaps

- The production Cloudflare API token cannot read or edit Firewall Services, so
  the FR15 rollout cannot run until that token's scope is widened. Everything
  else for it is implemented and tested.
- FR14 is unmet. The `*/15` cron shipped with `0139` never fired, because
  GitHub honours `schedule:` only on the default branch; the repository has no
  scheduled run in its history. Moving it to `main` is not sufficient on its
  own either, because the `crm-production` environment rejects any ref outside
  `release/private-crm-rc*`. Until `main` is admitted there, granting a
  membership reaches the Access boundary on the next marker-triggered sync
  rather than on its own.
- No CRM surface edits `configuration.presentation`; new artists get defaults. Changing a colour or event label still needs a backend write.
- Final third-artist acceptance requires the artist/operator to complete Google's interactive consent after the noninteractive Access boundary rollout is verified.
