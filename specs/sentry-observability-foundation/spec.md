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
