# Feature Specification: OpenAI Ads Conversions API

## Status

- Feature: `openai-ads-capi`
- State: Converged
- Owner/workstream: OpenAI Ads measurement
- Related PRs/issues: #696 (Worker), #697 (website companion)

## Problem

The public booking page can measure a confirmed enquiry with the OpenAI Ads Measurement Pixel, but browser-only measurement can be lost. The system needs an optional server-side copy of the same confirmed `lead_created` conversion without changing booking durability or collecting additional client PII.

## Goals

- Send a server-side `lead_created` event only after a tattoo enquiry is durably complete.
- Deduplicate the server event with the existing browser Pixel event by reusing the booking idempotency key as the event identifier.
- Preserve the site's explicit advertising-measurement consent boundary.
- Keep the CAPI credential server-side and make provider failure non-blocking for booking.
- Forward OpenAI attribution references when available after consent, without sending raw client identity data.

## Non-goals

- Do not track page views, AI-idea leads, book waitlist submissions, appointments, purchases, or subscriptions in this feature.
- Do not send raw or hashed email, phone, Instagram, name, tattoo description, files, IP address, or user agent to OpenAI.
- Do not change artist routing, booking-source ownership, Supabase authorization, Telegram routing, or CRM behavior.
- Do not deploy production or create/rotate provider secrets as part of code implementation.

## Actors and scope

- User/actor: visitor submitting the public Vishar tattoo enquiry form.
- Artist/workspace scope: existing server-authoritative booking source and artist resolution remain unchanged.
- Environments affected: code/CI; production requires a separately authorized Worker deployment and CAPI secret provisioning.

## User scenarios

### Scenario 1: consented confirmed enquiry

Given a visitor has granted OpenAI advertising measurement consent, when the booking Worker confirms the enquiry is durably complete, then the browser Pixel and server integration may emit the same `lead_created` conversion using one shared event identifier.

### Scenario 2: no measurement consent

Given a visitor has not granted OpenAI advertising measurement consent, when the enquiry completes, then no OpenAI server conversion is sent and the booking succeeds normally.

### Scenario 3: provider unavailable

Given a consented enquiry is durably complete, when OpenAI CAPI is unavailable, misconfigured, or rejects the request, then the client still receives booking success and the failure is limited to safe diagnostic logging.

### Scenario 4: idempotent replay

Given a completed enquiry is retried with the same idempotency key after an ambiguous network failure, when measurement consent is present, then any repeated server conversion uses the same event identifier so OpenAI can deduplicate it.

## Functional requirements

- FR-001: The system MUST use `lead_created` with `customer_action` data for confirmed tattoo enquiry conversions.
- FR-002: The server event MUST use the same idempotency key that the browser Pixel uses as its `event_id`.
- FR-003: The server MUST send conversion measurement only when an explicit OpenAI Ads measurement-consent marker is present and valid for the request.
- FR-004: The browser MAY forward the Pixel-provided `oppref` and `__obref` opaque references only after measurement consent.
- FR-005: The server MUST validate and bound all browser-provided measurement context before forwarding it.
- FR-006: `source_url` MUST be a sanitized HTTPS URL consistent with the already validated booking request origin and MUST exclude query strings and fragments.
- FR-007: CAPI dispatch MUST occur only after durable enquiry completion, including safe replay of an already-complete intake.
- FR-008: CAPI failure MUST NOT change the booking response, persistence state, notification state, or retry semantics.

## Security and trust requirements

- SR-001: Browser measurement fields MUST NOT select artist, booking source, provider account, credential, Telegram destination, or any other authoritative business route.
- SR-002: The CAPI bearer credential MUST exist only in a Worker secret named `OPENAI_ADS_CAPI_KEY`; it MUST NOT be committed, logged, returned, or exposed to the browser.
- SR-003: The Pixel ID used by the Worker MUST match the existing website Pixel ID used for the browser event.
- SR-004: No raw or hashed client identity fields are sent in this initial integration.
- SR-005: `oppref` and `obref` are treated as opaque provider references and are never decoded or logged.

## Failure and recovery behavior

- Missing CAPI secret: skip server measurement, log only a safe configuration code, preserve booking success.
- Invalid or absent consent context: skip server measurement, preserve booking success.
- Invalid source URL or oversized provider references: drop the invalid optional field or skip measurement as specified by validation, without affecting booking.
- Network/HTTP/provider failure: contain the failure inside the measurement task, never throw into the booking flow.
- Replayed completed enquiry: reuse the same event ID so duplicate server/browser events can be deduplicated.

## Data and retention expectations

No new database records are required. Measurement context is request-scoped only. The system does not persist OpenAI Ads consent, `oppref`, or `obref` in Supabase as part of this feature. The CAPI key remains in Cloudflare secret storage when production activation is later authorized.

## Acceptance criteria

- AC-001: A consented, durably completed enquiry schedules one `lead_created` CAPI payload with the same ID used by the Pixel.
- AC-002: A non-consented enquiry sends no CAPI request and still succeeds.
- AC-003: A CAPI error cannot turn a completed enquiry into an HTTP failure.
- AC-004: The CAPI request contains no client name, email, phone, Instagram, tattoo text, file metadata, IP address, or user agent.
- AC-005: `source_url` contains only a validated HTTPS origin/path with no query or fragment.
- AC-006: A replayed completed enquiry reuses the same conversion ID.
- AC-007: Production activation remains impossible without the separately provisioned `OPENAI_ADS_CAPI_KEY` secret.

## Dependencies and constraints

- Existing OpenAI Ads Pixel and its explicit consent state on `/booking/`.
- Existing durable booking idempotency key.
- OpenAI Ads Conversions API and the existing Vishar Tattoo conversion source.
- Cloudflare Worker runtime for server-side dispatch.

## Open questions

- None for code implementation. Ads Manager currently has the Vishar Tattoo web conversion source, but no configured conversion event setting. CAPI key provisioning, conversion-event configuration, Cloudflare secret storage, deployment, and controlled production verification remain separate rollout work.

## Requirement changes

- 2026-09-06: Initial feature specification created from the current Pixel implementation and current OpenAI Ads CAPI documentation.
- 2026-09-06: Converged implementation across PR #696 and companion PR #697 after exact-head CI passed; production activation remains explicitly deferred.
