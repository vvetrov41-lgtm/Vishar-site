# Implementation plan

Base: `agent/platform-telegram-self-service` at
`a002c11bbb71688789fb16b2b03d1ff43397f9db`, verified clean checkout.
Task branch: `fix/booking-card-thread-and-client-status`.

Existing server action consumes tokens and writes sessions.client_response plus
calendar version. Do not change booking lifecycle or notification dispatch.
Add a shared display helper and use it in appointment/client/month/week surfaces.
Refresh calendar/detail reads on window focus to pick up actions made elsewhere.

The final Gmail resolver is defined in 20260927120000. Add an ordered migration
preserving its signature, lease and route checks, returning a server-owned reply
policy in safe configuration only for verified booking-card jobs. Worker searches
bounded bilateral Gmail history when this policy is true and no explicit context
exists. Select latest suitable thread with inbound message, use last message's
safe headers and subject. Keep existing explicit-context behavior unchanged.

Parity: existing sessions read operations and consultation context cover response
facts; no new operator action is introduced. Thread choice is backend delivery.

Security: no new grants, RPCs, routes, provider selectors or credential surfaces.
Old Worker ignores additive metadata. DB migration precedes Worker rollout.
Rollback Worker/UI by prior SHA; additive policy can remain inert.

Analysis: requirements map to UI helper, resolver metadata, Worker selection and
positive/negative tests. No blocking contradictions. Exact-head CI and production
readback are distinct from local checks; rollout requires separate approval.

Local evidence: admin full suite passed 139 files / 1092 tests with TZ=UTC;
default Europe/London runtime caused four unrelated timezone assertions to fail.
Typecheck and production build passed. Gmail production suite passed 25 tests,
operator boundary suite 26 tests; migration order passed (257 total, one new).
Automatic threading excludes group participants and outbound-only threads;
empty search falls back to standalone, provider failure is retried, not hidden.
Existing booking client-action tests prove atomic response persistence. Extended
315 pgTAP fixture proves server-owned thread policy on enquiry-less cards.
SQL execution needs CI because local PostgreSQL/Docker are unavailable.
No production writes, client messages, confirmation overrides or notifications.
