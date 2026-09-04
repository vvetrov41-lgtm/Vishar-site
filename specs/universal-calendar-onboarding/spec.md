# Feature Specification: Universal Google Calendar onboarding

## Status

- Feature: `universal-calendar-onboarding`
- State: Implementation
- Owner/workstream: Vishar CRM Calendar production engineering
- Related work: supersedes the two-artist Calendar OAuth allowlist introduced by `0030_calendar_connection_status.sql` and `0045_calendar_actor_authorization.sql`

## Problem

Calendar OAuth is hardcoded to Vladimir and Kristina in four places at the same time:

- `workers/calendar-oauth.js` `artistConfig()` enumerates the two artists and reads `VLADIMIR_*` / `KRISTINA_*` Worker variables;
- the start and disconnect routes are `(vladimir|kristina)` regexes;
- `workers/lib/calendar-oauth-security.js` keeps `ALIASES`, a two-artist actor-email allowlist and per-artist `canManageCalendarAlias()` branches;
- `workers/lib/google-calendar.js` `artistCalendarConfig()` repeats the same env enumeration on the drain path;
- `public.set_calendar_connection_metadata()` and `public.list_calendar_connection_status()` reject any slug that is not `vladimir` or `kristina`.

Production already has a third active artist (`sam`, `d629dab2-4d89-4f0c-bb96-34eb6f44eedc`) whose operator holds `can_manage_integrations` and cannot connect a calendar at all. Onboarding artist number three, ten or one hundred currently requires a Worker code change, a Worker variable change and a database migration.

## Goals

- Any active artist whose operator holds `manage_integrations` can connect and disconnect Google Calendar with no source-code change and no new artist-specific Worker variable.
- Artist identity, provider account expectation and integration key are resolved server-side from `artists`, `crm_private.artist_access` / `profile_access` / `artist_state` and `artist_integrations`.
- The artist identifier in the OAuth URL is a lookup hint only; the authoritative artist is whatever the backend-only RPC returns for the Access-verified operator.
- The refresh token stays in encrypted Cloudflare KV keyed by the authoritative artist UUID; Supabase keeps safe metadata only.
- Existing Vladimir and Kristina connections keep working with the same Google accounts, the same event presentation and no reconsent.
- PKCE, OAuth `state`, disconnect confirmation nonces and Cloudflare Access verification are preserved or strengthened.

## Non-goals

- Storing OAuth refresh or access tokens in Supabase.
- Letting the browser choose an artist, provider account or credential.
- Enabling the production scheduled drain (`CALENDAR_DRAIN_ENABLED` stays `false` in production).
- Changing appointment or availability projection semantics; Supabase stays authoritative and Google Calendar stays a projection.
- Building a per-artist calendar-presentation editor UI (see Open gaps).

## Actors and scope

- Actor: an Access-verified CRM operator (owner, or booking manager with `can_manage_integrations`) for the exact artist being connected.
- Scope: `workers/calendar-oauth.js`, `workers/lib/calendar-oauth-security.js`, `workers/lib/google-calendar.js`, migration `0137`, `admin/src` Calendar connections surface, Calendar wrangler configuration, CI validation.
- Environments: CI, staging Supabase + Calendar Worker, production Supabase + Calendar Worker.

## User scenarios

### Scenario 1: A new artist connects

Given an active artist with no calendar integration row and an operator holding `manage_integrations` for that artist, when the operator opens Settings → Integrations → Google Calendar → Connect, then the Worker resolves the artist server-side, runs the PKCE consent flow, binds the verified Google account to that artist, stores the encrypted refresh token under `artist:<artist-uuid>`, and writes `google_calendar_<slug>` metadata with `is_enabled = true`.

### Scenario 2: Vladimir and Kristina keep working

Given the existing `google_calendar_vladimir` and `google_calendar_kristina` rows, when nothing else changes, then the drain keeps projecting events with the same visibility, display name, colour and event label, and a reconnect still requires the same Google account (`vvetrov41@gmail.com` / `tinaakaten@gmail.com`).

### Scenario 3: Cross-artist attempt

Given an operator authorized for artist A only, when they request `/oauth/google/start/<artist-B-slug>` or replay an OAuth `state` issued for artist B, then the request is denied with `calendar_artist_access_denied` and no token is written.

### Scenario 4: Wrong Google account

Given an artist already bound to a Google account, when the operator consents with a different Google account, then the callback revokes the fresh grant, writes nothing and returns `google_account_mismatch`.

### Scenario 5: Account reuse across artists

Given artist A bound to `x@gmail.com`, when artist B tries to bind the same Google account, then the metadata write is rejected by the database and the fresh grant is revoked.

### Scenario 6: Rebinding after a mistake

Given a disconnected calendar integration, when an operator with `manage_integrations` clears the recorded Google account from the CRM, then the next connect may bind a different Google account. While the integration is enabled the recorded account cannot be changed.

## Functional requirements

- FR1 `public.resolve_calendar_artist_route(p_actor_email text, p_artist_ref text)` is backend-only (`service_role`), accepts a UUID or a slug hint, and returns the artist identity, integration key, recorded Google account and event presentation only when the actor currently holds `manage_integrations` for that active artist. Unknown, inactive and unauthorized all return `null`.
- FR2 The Worker start/disconnect routes accept any artist reference matching the `artists.slug` shape or a UUID, and never derive configuration from the reference itself.
- FR3 The OAuth state record stores the authoritative artist UUID; the callback re-resolves and re-authorizes that UUID before any token exchange result is persisted.
- FR4 The disconnect confirmation nonce is bound to the authoritative artist UUID and the actor email.
- FR5 No `VLADIMIR_*` or `KRISTINA_*` variable is read by any calendar code path.
- FR6 `calendar` rows in `artist_integrations` must have `provider = 'google'` and `integration_key = 'google_calendar_' || artists.slug`, enforced by trigger.
- FR7 One Google account backs at most one artist calendar integration, enforced by a unique index.
- FR8 `public.list_calendar_connection_status()` returns one row per active artist the caller can manage, for any slug.
- FR9 Event presentation (visibility, display name, colour id, label name, label colour) lives in `artist_integrations.configuration.presentation`, is preserved across connect/disconnect, and defaults to `visibility = 'public'` plus the artist display name.
- FR10 `public.reset_calendar_expected_account(p_artist_id uuid)` clears the recorded Google account for an authorized operator only while the integration is disabled.

## Non-functional requirements

- Denial responses stay uniform: unknown artist, inactive artist and unauthorized operator all produce `calendar_artist_access_denied` (403), so the endpoint does not enumerate artists.
- Failure modes stay fail-closed: any Supabase resolution failure returns `calendar_actor_authorization_failed` (502) and writes nothing.
- A failed metadata write after a successful token exchange deletes the stored envelope and revokes the Google grant.
- No token material, Google response body or KV key is logged or returned.

## Acceptance criteria

- AC1 CI at the exact head is green, including `npm run test:worker` and the admin test suite.
- AC2 Migration `0137` applies to staging and production without altering any earlier migration.
- AC3 Production readback shows the Calendar Worker deployed from the generic code with no `VLADIMIR_*` / `KRISTINA_*` variables.
- AC4 `list_calendar_connection_status()` returns a row for `sam` for Sam's operator, and Sam's Connect button targets `/oauth/google/start/sam`.
- AC5 Vladimir's and Kristina's rows still read `connected = true` with their existing account labels after rollout.
- AC6 A real third-artist connection completes end to end. This requires Google consent from that artist and is the only interactive step.

## Open gaps

- No CRM surface edits `configuration.presentation`; new artists get the defaults. Changing a colour or event label still needs a backend write.
- Cloudflare Access policy for `calendar.vishartattoo.com` must include the new artist's operator email; that is Access configuration, not code.
