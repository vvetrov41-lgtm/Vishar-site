# Plan

Target: agent/platform-telegram-self-service at exact SHA 1d37d6c208a270465e8721d54e821c492a2c9f40.

- Add backend-only SQL routing from a leased enquiry outbox job to an idempotent profile notification.
- Add a narrow service-only recovery RPC for dead destination-unavailable jobs with no delivery evidence.
- Allow-list only the routing RPC in the Worker. Recovery remains operator-only.
- Make the shared-bot production outbox path provider-free; the existing personal delivery queue owns send and acknowledgement.
- Reduce Notifications UI to the single profile Telegram card and update copy.
- Add Worker and pgTAP coverage for routing, no-direct-send, ACL, idempotency, recovery refusal, delivery readback and last_success_at.
- Keep provider credentials, chat IDs and browser-selected routing outside all public results.
- Roll out through exact-head CI, merge, protected database/Worker deployment, then production readback and guarded Dmitriy recovery.
- Rollback is a revert plus the protected production release path. Do not revert a successful delivery or requeue a job with delivery evidence.

Operator parity: linking still requires Telegram's interactive consent/chat action and remains UI-only. No new general CRM operator capability is introduced.
