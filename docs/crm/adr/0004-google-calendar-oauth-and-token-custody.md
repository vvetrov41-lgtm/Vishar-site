# ADR 0004: Google Calendar OAuth and token custody

Status: proposed for PR #180

## Context

PR #179 adds calendar projection state, artist-routed outbox operations and protected provider acknowledgement. It deliberately does not connect a real Google account.

Vladimir and Kristina require separate Google Calendar connections. Browser-supplied artist identifiers, calendar identifiers and provider destinations are not authoritative.

## Decision

Use a dedicated private calendar connector Worker, separate from the public intake endpoint.

- OAuth begins only from an authenticated owner CRM action.
- The connector validates the Cloudflare Access identity before redirecting to Google.
- OAuth uses PKCE, single-use state, an exact redirect URI and the narrow Google Calendar event scope.
- Google refresh tokens are encrypted with AES-GCM and stored only in the `CALENDAR_OAUTH_TOKENS` KV namespace under an artist-specific key.
- Supabase stores metadata only: artist, provider, connection state, provider account label, primary-calendar metadata and timestamps.
- The connector leases due calendar jobs through a backend-only `SKIP LOCKED` RPC. The claim contains the minimum appointment projection and no token, private note or service credential.
- Every job route is resolved again from the outbox row and must match the exact `artist_id`, provider, integration key and connected Google account label.
- The Worker decrypts only that artist's refresh-token envelope, refreshes the short-lived access token server-side and sends the create, update or cancel request to the artist's primary calendar.
- Event creation uses a deterministic event ID derived from artist and appointment identity. A replay patches that same event instead of creating a duplicate.
- Provider results are recorded only through the backend acknowledgement RPC. Lease ownership, appointment version, artist identity and operation semantics are revalidated in PostgreSQL.
- Stale provider responses retire the old outbox row without overwriting a newer appointment version.
- Cancellation deletes the provider event idempotently and clears the projection metadata only after database acknowledgement.
- Disconnect attempts Google token revocation, deletes the local encrypted envelope regardless of the provider response and marks the metadata integration disconnected.
- Production and staging use different OAuth clients, redirect URIs, token stores and Supabase credentials.

## Scheduling boundary

The Worker contains a scheduled-event handler for the drain, but PR #180 does not configure a cron trigger. No automatic or live calendar processing starts until the explicit synthetic staging E2E stage enables a guarded trigger.

## Security boundaries

- The public intake Worker remains outside Cloudflare Access and never receives OAuth routes.
- The calendar connector is private and must be protected by owner-only Cloudflare Access before interactive OAuth routes are used.
- Scheduled outbox draining uses backend-only RPCs and service-role credentials.
- The browser cannot submit an authoritative artist, provider account, integration key, calendar identifier or refresh token.
- No OAuth code, access token, refresh token, client secret or session cookie is accepted through chat, committed to Git or stored in Supabase.
- Vladimir and Kristina never share one refresh-token envelope or fallback route.
- Failed jobs use bounded retries and safe machine error codes; raw provider bodies are not stored or logged.

## Required configuration

The deployment requires a Google Cloud project with Calendar API enabled and a Web OAuth client configured with an exact staging redirect URI. Client ID and client secret are installed directly as encrypted Worker secrets.

The Worker also requires two KV bindings with exact names:

- `CALENDAR_OAUTH_STATE` for short-lived PKCE/state records;
- `CALENDAR_OAUTH_TOKENS` for encrypted artist refresh-token envelopes.

## Out of scope

- Gmail and email reminders;
- Google Meet creation;
- production deployment;
- sharing one Google account between artists;
- browser-selected provider routing;
- enabling a recurring drain before isolated synthetic staging validation.
