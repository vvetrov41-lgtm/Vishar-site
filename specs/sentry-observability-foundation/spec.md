# Privacy-safe Sentry observability foundation

## Outcome

Create a provider-neutral external observability boundary that a later Sentry Cloudflare adapter can consume without exposing CRM customer data, message content or provider credentials.

## Functional requirements

1. External observability accepts only a narrow allow-list of technical operational fields.
2. Customer/entity identifiers such as client, enquiry, artist, file, conversation and message identifiers are not external-safe fields.
3. Message bodies, attachments, names, email addresses, phone numbers, routes, provider responses and credentials are not external-safe fields.
4. Raw `Error` objects, nested objects and arrays are never serialized by the boundary.
5. String values must be bounded technical tokens rather than arbitrary free text.
6. Numeric values are bounded.
7. The reporter is disabled by default.
8. The reporter receives its transport by injection and has no provider/network dependency in this change.
9. Transport failures are fail-open for the CRM request path.
10. Dedicated CI validates the privacy boundary and repository secret scan.

## Security and privacy requirements

- No Sentry DSN, auth token, API key or secret is committed.
- No Sentry SDK dependency is added in this foundation change.
- No automatic request/user/session capture is introduced.
- No stack trace or raw exception serialization is introduced.
- No production route, Worker binding or environment mutation is introduced.
- No database migration is introduced.
- Future Sentry integration must consume only the sanitized operational payload from this boundary, keep default PII capture disabled, and preserve fail-open observability behavior.

## Non-goals

- Sending events to Sentry in production.
- Browser/session replay.
- Performance tracing.
- Product analytics or PostHog instrumentation.
- Replacing the existing internal structured logger.

## Phase 2 — Sentry activation (this change)

The provider-neutral boundary above is now consumed by a real Sentry transport.

### What was added

- `workers/lib/sentry-transport.js` — parses a DSN, builds a Sentry envelope from
  an already-sanitized payload, and POSTs it with a 2s abort timeout.
- `workers/lib/worker-observability.js` — binds the reporter to Worker runtime
  config (`SENTRY_ENABLED`, `SENTRY_DSN`, `SENTRY_RELEASE`).
- Bounded coverage in `workers/cloudflare-gateway.js`: 5xx dispatch outcomes and
  one explicit release probe on `POST /internal/observability/probe`.
- `.github/workflows/sentry-observability-production-rollout.yml` — guarded
  activation behind the same exact-head/canonical-lineage gates as other
  production releases.

### Why not the Sentry Cloudflare SDK

`@sentry/cloudflare`'s `withSentry` wrapper automatically captures request URLs,
query strings, headers and raw exceptions. That is exactly the data this project
forbids, and enabling it would put capture decisions outside
`sanitizeOperationalEvent`. A direct envelope POST keeps the allow-list the only
path to Sentry, which is what the phase-1 spec requires of any future adapter.
The cost is that Sentry's tracing and auto-instrumentation are unavailable; that
is an accepted trade for a provably PII-free pipeline.

### Boundaries preserved

- Sentry sees only the eleven allow-listed technical fields. Tags and extras are
  copied field by field; nothing is spread from caller input.
- No `exception`, `stacktrace`, `request`, `user`, `server_name` or breadcrumb
  data is ever serialized.
- The DSN lives only in a Worker secret installed by the rollout. It is not in
  tracked config, is piped through stdin at install time, and is sent in the
  `X-Sentry-Auth` header rather than the envelope body.
- The gateway Worker stays private: no route, no `workers.dev`, no preview URLs,
  so the probe endpoint is not reachable from the internet.
- Every transport failure, timeout and misconfiguration is swallowed. A Sentry
  outage cannot change a CRM response.

### Chosen coverage

Deliberately narrow to start: server-side failure classes on one private Worker,
plus a probe that proves the pipeline. Widening coverage is a separate change.
