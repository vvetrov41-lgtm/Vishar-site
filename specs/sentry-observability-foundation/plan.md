# Plan

## Boundary

Add a reusable external operational observability module without changing any existing Worker request path or production configuration.

## Implementation

1. Add `workers/lib/observability.js` with a strict external-safe field allow-list and bounded value validation.
2. Reject customer/entity identifiers, free text, nested payloads and raw exceptions by construction.
3. Add a disabled-by-default reporter with an injected transport.
4. Swallow transport failures so observability can never fail the CRM request path.
5. Add focused negative tests for PII, credentials, provider payloads, raw errors, malformed values and transport failures.
6. Add path-scoped GitHub Actions validation plus repository secret scan.

## Validation

- Exact-head observability boundary tests.
- Exact-head secret scan.
- Existing repository validation triggered by the PR.
- Fresh canonical/base and parallel-PR check before merge.
- Post-merge canonical SHA and workflow readback.

## Later Sentry rollout

A separate bounded change may add the official Cloudflare Sentry SDK/transport only after dependency locking, Cloudflare secret/binding inventory, environment separation and fail-closed rollout checks are available. That adapter must receive only payloads produced by this foundation boundary.
