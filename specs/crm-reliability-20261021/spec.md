# CRM reliability and independent booking acceptance

## Status
In implementation. Requested 2026-10-21; production closeout requires 24 hours after rollout.

## Problem and goals
FR-001: Eliminate confirmed attention-shadow SQL timeouts without increasing global timeouts or pool size.
FR-002: Preserve durable intake and delivery for Vladimir and Kristina, including correct server-owned artist routing.
FR-003: Independently verify both booking forms, browser steps, file rules, endpoint, validation and existing legitimate delivery evidence.
FR-004: Extend existing Health Watch with separate form results, repeated RPC failures, SQLSTATE 57014, heartbeat, intake/Storage and outbox age/failures and comparison with previous 24 hours. No traffic is not a failure.
FR-005: Audit current database/integration risks separately from historical advisor findings.

## Scenarios and failure behavior
An hourly shadow comparison computes each active client once and keeps the existing aggregate report and retention. A failed diagnostic cannot create, reject or modify an enquiry. Provider failures remain owned by existing durable outboxes; no speculative retry changes.
Each artist form receives a separate verdict. Missing browser/network access is unknown, never a pass or evidence of outage.

## Security and data
SR-001: Preserve service-only RPC execution, private report ACL, fixed search_path, artist/workspace ownership and RLS.
SR-002: No synthetic production customer data; only read-only aggregate diagnostics and proven no-persistence probes.
SR-003: No tokens, contacts, message bodies, raw headers or provider payloads in reports.

## Acceptance
AC-001: Regression proves one attention evaluation per active client and unchanged aggregate schema, values, archive filtering, denial and throttle.
AC-002: Separate PRs, exact-head CI, staging, fail-closed release preflight, deployed readback.
AC-003: Both forms independently pass browser/file/routing/delivery checks. No new lost/stuck intake or failed/dead outbox.
AC-004: A full 24-hour post-fix window has zero repeated shadow HTTP 500 and zero unexplained operation timeouts; previous-day comparison recorded.

## Non-goals and constraints
No redesign, provider access changes, fake customer data, global timeout/pool tuning or unrelated cleanup. No auto-sending client messages.

## Open questions
Hosted staging is at migration 0044 and lacks current attention objects. Safe convergence must precede hosted acceptance. Cloud Browser currently returns Site Unavailable for both requested URLs; live browser acceptance remains unproved.
