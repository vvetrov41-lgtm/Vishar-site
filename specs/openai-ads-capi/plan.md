# Implementation Plan: OpenAI Ads Conversions API

## Target revision

- Repository: `vvetrov41-lgtm/Vishar-site`
- Worker base branch: `agent/platform-telegram-self-service`
- Verified base SHA: `0093b778b5567e6cc755b29e88dea6c22c2ee4ed`
- Website base branch: `main`
- Verified website SHA during planning: `e25e5218efeefe54af8914928be8d0a04552533c`
- Worker task branch: `agent/openai-ads-capi-worker`
- Website companion branch: separate branch from fresh `main` because the active CRM branch does not contain the already-shipped Pixel commits.

Exact heads must be rechecked before each write and before CI claims.

## Current implementation chain

Public `/booking/` creates one session-scoped idempotency key, submits it with the multipart enquiry, waits for the Worker to return `{ok:true}`, then sends the browser `lead_created` Pixel event with that same key as `event_id`.

The Worker validates the booking source and Origin, creates the durable intake, stores/acknowledges files, finalizes the enquiry, then attempts provider notification. An already-complete replay returns success with the original reference. This final durable boundary is the only acceptable point for CAPI conversion dispatch.

## Implementation areas

### Browser handoff

On the current `main` booking page:

- keep the existing Pixel consent logic unchanged;
- when and only when OpenAI Ads measurement consent is `granted`, append request-scoped fields for CAPI:
  - `openaiAdsMeasurementConsent=granted`;
  - sanitized current page origin/path without query or fragment;
  - raw `__oppref` value when available;
  - raw `__obref` value when available;
- never append client identity fields for CAPI matching.

The browser still sends the Pixel event only after Worker-confirmed success, using the existing idempotency key.

### Worker measurement context

Add a narrow helper under `workers/lib/` that:

- reads only the explicit measurement fields from the parsed FormData;
- requires the consent marker to be exactly `granted`;
- validates the source URL against the already validated request Origin;
- strips query/fragment and rejects non-HTTPS URLs;
- bounds opaque reference lengths and treats values as opaque;
- constructs a `lead_created` event with `action_source: web`, `opt_out: true`, and `customer_action` data;
- includes `oppref` at event level and `user.obref` only when present;
- sends no other `user` fields.

### CAPI dispatch

Use the existing Vishar Tattoo Pixel ID so browser/server dedupe matches. Read the bearer credential only from `env.OPENAI_ADS_CAPI_KEY`.

CAPI dispatch is best-effort and must be scheduled through the Worker execution context. The task catches construction, network, JSON/HTTP, and provider errors internally. Booking success does not await provider success.

Schedule after:

1. normal `finalize_enquiry_intake` completion; and
2. the already-complete replay branch.

Do not schedule for honeypot, validation failure, incomplete intake, storage failure, or non-booking routes.

### Worker entrypoint

Pass a bounded scheduling function based on `ctx.waitUntil()` into the enquiry route rather than exposing the execution context broadly.

### Privacy copy

Review the existing privacy notice on `main`. If it describes only browser Pixel transport, update it minimally to disclose that consented conversion measurement may also be sent server-to-server and that the initial CAPI implementation does not send raw client identity data.

## Data and migrations

No database migration. No new table, RPC, RLS policy, grant, or persisted measurement field.

## Authorization and trust boundaries

- Existing Origin/source/artist resolution remains authoritative and unchanged.
- Browser measurement fields can only opt a request into measurement and provide bounded attribution references; they cannot affect business routing or credentials.
- CAPI secret is Worker-only.
- No credential is stored in Supabase.
- No client PII is included in the CAPI payload.

## Provider integration

Endpoint: OpenAI Ads Conversions API for the existing Vishar Tattoo Pixel.

Failure handling is fail-open with respect to booking: a provider failure affects measurement only. Safe logging must not include bearer credentials, provider references, or client details.

## Tests

Add focused JavaScript tests for the helper and booking integration where the repository test harness supports it. At minimum validate:

- no consent means no dispatch;
- missing secret means no network call;
- confirmed consent creates the expected `lead_created` payload;
- same booking idempotency key becomes CAPI `id`;
- source URL sanitization and Origin matching;
- `oppref` / `obref` length and opacity handling;
- provider HTTP/network failure is contained;
- payload excludes client identity fields;
- completed replay uses the same ID.

Run existing booking/Worker validation available on the exact feature head. CI evidence must match the PR head SHA.

## Rollout

Code merge and production activation are separate stages.

Activation requires:

1. provision a Conversions API key for the existing conversion source in OpenAI Ads Manager;
2. add it to the production `tattooai` Worker as secret `OPENAI_ADS_CAPI_KEY` without exposing its value;
3. deploy the exact approved Worker SHA through the repository release path;
4. deploy the companion website consent-context change;
5. submit a controlled consented test enquiry only with explicit approval;
6. verify recent `lead_created` events in Ads Manager and confirm browser/server deduplication behavior.

## Rollback

- Remove/disable `OPENAI_ADS_CAPI_KEY` to make server measurement inert without affecting booking.
- Revert the Worker CAPI commit/PR if code rollback is required.
- Revert the companion browser context fields independently; the existing Pixel can continue operating by itself.

## External state not verified

Cloudflare live deployment/binding state is not directly readable in this ChatGPT runtime because a Cloudflare connector is not available here. No production Cloudflare mutation is part of this implementation stage.
