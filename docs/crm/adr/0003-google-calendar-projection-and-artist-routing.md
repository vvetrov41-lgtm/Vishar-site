# ADR 0003: Google Calendar projection and artist-specific routing

Date: 2026-08-04
Status: Proposed

## Context

Supabase remains the system of record for appointments. Confirmed appointments already enqueue durable calendar work through the integration outbox, but no Google account, OAuth grant or provider drain is connected.

Vladimir and Kristina require separate calendars. Browser input must never select an authoritative calendar account, OAuth identity or provider destination. Existing artist membership, appointment relationship validation and RPC authorization remain authoritative.

## Decision

Google Calendar is a derived projection of an appointment, not the source of truth.

Each active artist may have at most one enabled `google_calendar` integration metadata record. The database stores only non-secret routing metadata and sync state. OAuth refresh tokens, client secrets and provider credentials stay outside Supabase in encrypted runtime bindings or a dedicated secret store.

The outbox consumer resolves the provider route from the appointment artist and enabled integration metadata. It never accepts a calendar account, provider route or artist override from browser form data.

Supported operations are:

- create an event when an appointment becomes confirmed;
- update the event after an authorised reschedule or relevant appointment change;
- cancel/delete the event when an appointment is cancelled;
- retry safely with idempotency based on appointment ID and calendar version;
- record provider event ID, last synced version, last success time and a safe failure code.

Appointment writes succeed independently of provider availability. Calendar delivery is asynchronous and fail-closed: a missing or disabled artist route leaves the appointment authoritative in Supabase and records a safe integration failure without falling back to another artist or a global calendar.

## Event content

The event payload is generated server-side from database records. It may include:

- appointment type;
- start and end time;
- client display name;
- internal CRM record references;
- consultation mode;
- staff-only notes only when explicitly approved for calendar projection.

Sensitive intake text, private reference-image URLs, payment details and authentication data are excluded.

## Availability and conflicts

The existing database overlap query remains authoritative for CRM scheduling. Provider free/busy may later be used as additional advisory evidence, but it does not replace RLS, RPC authorization or the database conflict domain.

## Rescheduling

Rescheduling must use a dedicated authorised RPC that changes start/end atomically, increments `calendar_version`, logs activity and queues one `calendar_update` operation. Editing timestamps directly from the browser is not permitted.

## User interface

The CRM shows per-appointment calendar sync state:

- not connected;
- queued;
- synced;
- retrying;
- failed with a safe description.

The artist integration screen shows metadata-only connection state. It never displays refresh tokens, access tokens, OAuth codes or provider secrets.

## Staging and production

The foundation can be developed and tested without a real Google account by validating schema, routing, idempotency and rollback-only synthetic outbox flows.

Connecting real Google OAuth requires an explicit interactive owner step because Google consent cannot be completed by the repository workflow. Staging and production credentials, redirect URIs and calendar IDs remain separate.

## Consequences

- Supabase appointments remain durable when Google is unavailable.
- Artist-specific routing prevents cross-calendar leakage.
- Calendar operations become observable and retryable.
- A separate runtime drain and interactive OAuth setup are required before live event creation can be enabled.
- No production calendar connection is introduced by the foundation PR.
