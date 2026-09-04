# Feature Specification: Universal Google Calendar onboarding

## Status

- Feature: `universal-calendar-onboarding`
- State: Production rollout, final third-artist acceptance pending
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
- FR11 `calendar.vishartattoo.com` uses the private operator CRM's exact named-email allow set as its Cloudflare Access identity boundary. Synchronization refuses broad selector classes, mutates only the Calendar policy, reads the result back, and restores the previous Calendar policy if readback does not match.

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
- AC6 Cloudflare Access for Calendar has the same exact named-email allow-set fingerprint as the private operator CRM and the Calendar hostname remains Access-gated.
- AC7 A real third-artist connection completes end to end. This requires interactive Google consent from that artist and is the only interactive product acceptance step.

## Retained staging note

The retained `vishar-crm-staging` Supabase project is an old long-lived environment. Fresh readback on 2026-09-04 showed migration history only through `0044`, while production and canonical are beyond `0137`. Applying only `0137` would skip required dependencies and would not be a valid staging proof. Staging is therefore fail-closed until an ordered catch-up or disposable fully migrated environment is available.

## Open gaps

- No CRM surface edits `configuration.presentation`; new artists get defaults. Changing a colour or event label still needs a backend write.
- Final third-artist acceptance requires the artist/operator to complete Google's interactive consent after the noninteractive Access boundary rollout is verified.
