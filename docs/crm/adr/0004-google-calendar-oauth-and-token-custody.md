# ADR 0004: Google Calendar OAuth and token custody

Status: proposed for PR #180

## Context

PR #179 adds calendar projection state, artist-routed outbox operations and protected provider acknowledgement. It deliberately does not connect a real Google account.

Vladimir and Kristina require separate Google Calendar connections. Browser-supplied artist identifiers, calendar identifiers and provider destinations are not authoritative.

## Decision

Use a dedicated private calendar connector Worker, separate from the public intake endpoint.

- OAuth begins only from an authenticated owner CRM action.
- The CRM requests a short-lived, single-use connection intent for one authorised artist.
- The connector validates the CRM session and artist membership before redirecting to Google.
- OAuth uses PKCE, state, exact redirect URI and the narrow Google Calendar event scope.
- Google refresh tokens remain encrypted Worker secrets/storage and are never stored in Supabase, returned to the browser or written to logs.
- Supabase stores metadata only: artist, provider, connection state, provider account label, calendar identifier metadata and timestamps.
- The connector drains only artist-routed calendar outbox rows and calls the backend-only acknowledgement RPC from PR #179.
- Event create, update and cancel operations are idempotent and version-checked.
- Disconnect revokes the Google grant where possible, deletes encrypted token material and marks the metadata integration disconnected.
- Production and staging use different OAuth clients, redirect URIs, token stores and Supabase credentials.

## Security boundaries

- The public intake Worker remains outside Cloudflare Access and never receives OAuth routes.
- The calendar connector is private and must be protected by Cloudflare Access or an equivalent owner-only boundary for interactive routes.
- Scheduled outbox draining uses a backend-only trigger and service-role credentials.
- No OAuth code, access token, refresh token, client secret or session cookie is accepted through chat, committed to Git or stored in Supabase.

## Required configuration

The deployment requires a Google Cloud project with Calendar API enabled and a Web OAuth client configured with an exact staging redirect URI. Client ID and client secret are installed directly as encrypted Worker secrets.

## Out of scope

- Gmail and email reminders;
- Google Meet creation;
- production deployment;
- sharing one Google account between artists;
- browser-selected provider routing.
