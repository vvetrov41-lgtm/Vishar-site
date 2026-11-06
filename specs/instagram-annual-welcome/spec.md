# Instagram annual auto-welcome

State: In implementation. Requested 2026-11-06; supersedes first-contact research.

## Intent and scope

Send the user's exact English welcome to incoming Instagram contacts of Vladimir
and Kristina, at most once per 12 calendar months. Only the two website links
differ. Existing contacts are eligible for their first post-launch welcome.
No history import, staging, new Worker, independent queue or CRM UI is needed.

## Requirements

- FR1: Persistent identity is artist + business Instagram account + sender IGSID;
  reconnects, conversation deletion, Worker restart and template changes do not reset it.
- FR2: Confirmed success starts a 12 calendar month cooldown in Europe/London.
  Leap-day anniversaries clamp to February's last day. Eligibility requires a new
  inbound message, never a timer-driven outbound anniversary message.
- FR3: New inbound messages atomically reserve and queue at most one welcome.
  Duplicate delivery, concurrent messages and expired leases cannot create extra sends.
- FR4: An uncertain outcome blocks future welcomes indefinitely pending evidence.
  Never automatically retry a request that may have been accepted by Meta.
- FR5: Use separate disabled-by-default account controls, rechecked at send intent.
  Disabling preserves history. Test mode accepts only explicitly agreed IGSIDs.
- FR6: Preserve Instagram replies/cards, WhatsApp, Gmail and bookings.

## Trust and failures

Only authenticated Meta webhook ingestion can reserve. Database resolves ownership
and current account; browser input cannot choose routing or enable automation.
Registry and controls are private with RLS and no browser grants. Credentials stay
in the existing KV store. Use existing durable outbox and pre-POST send intent.
DB failure rolls back reservation; no provider call occurs in the DB.
Fail closed for stale events, disabled routes, window expiry or account mismatch.
An attempt that fails before provider intent is terminal for that inbound event;
another new inbound may reserve after a definitely unsent result.

## Acceptance and deployment

Prove duplicate/concurrent reservation, 12-month boundary, leap day, unknown outcome,
account isolation, reconnect, feature disable, expiry, ACLs and normal message paths.
Use fixture-only local/CI tests, plus read-only production verification.
Production database and existing Worker may be prepared autonomously with controls off.
Do not change Meta Instant Reply or activate real sends without confirmation.
No real test sends until user identifies and agrees test contacts. Then disable the
old Meta sender and pilot Vladimir before Kristina. Unknown outcome may miss a
welcome; avoiding repeats has priority over delivery coverage.

## Open acceptance dependencies

Agreed test IGSIDs and activation confirmation are not yet supplied.
