# Event-driven booking delivery (staged rollout)

Production measurements on 25 November showed Calendar creates and booking confirmations waiting for a five-minute cron. The database networking approach was rejected after a rolled-back hosted staging probe showed pg_net grants belong to supabase_admin and cannot be revoked by postgres. Do not install pg_net.

The browser and GPT gateway send a best-effort wake after a successful allowlisted booking/finance RPC. The wake worker verifies the existing bearer with the production read-only hint RPC; no new shared secret or privileged DB key is needed. It queues only bounded lane/due hints, never appointment or customer data. Existing artist permissions, OAuth ceilings, MFA, outbox claims, send intent and dedupe remain authoritative. Cron remains the recovery path, including automatic or provider-originated changes not yet wired into the fast path.

## Release gate

1. Exact-head CI: full worker/CRM/pgTAP, function manifest, lint, auth boundaries, stale versions, concurrent claims and due times. Staging's retained remote DB is at an older migration head; use isolated CI DB and Worker mocks until staging parity is safely established.
2. Provision a dedicated queue and exact production custom domain. Deploy Calendar, WhatsApp and Instagram internal-only drain routes via their existing approved release gates; Gmail already exposes its internal drain. Verify live bindings, source and cron.
3. Deploy the dedicated wake worker from the immutable approved SHA with OUTBOX_WAKE_ENABLED=false, exact production SUPABASE_URL, production publishable key and rate-limit binding. Verify no public provider-drain endpoints and no unapproved routes.
4. Apply the reviewed DB migration via the established production DB gate. Deploy exact-source CRM Pages and GPT gateway after successful provider-worker rollout. Verify disabled/unauthenticated wake ingress and CSP. Enable wake only through a reviewed production config release. No production secrets or user data in logs.
5. Verify natural real bookings on both artists. Measure calendar sync and provider acceptance from job creation; tattoo card debounce remains 120 seconds until atomic price/deposit readiness is verified. Consultation debounce remains 10 seconds. Do not claim final delivery time from provider acceptance alone.

Rollback: set OUTBOX_WAKE_ENABLED=false via the approved config gate. All existing five-minute cron triggers and outbox work remain unchanged; no messages or events need to be replayed.

## Coordinated schema release

The review-channel migration 20261125204000 is already on the canonical branch. The wake migration is still unapplied, so its source version is now 20261125210000. Wait for the review database rollout and verify its exact applied head before merging this PR. The existing single-migration production gate admits only 20261125204000 -> 20261125210000; do not use out-of-order migration flags or release both migrations together.

The bounded booking wake release uses two isolated backend-auth refs: `release/private-crm-rc<number>-backend-auth-outbox-wake-prepare` and `release/private-crm-rc<number>-backend-auth-outbox-wake-activate`. Both require current canonical SHA, the five canonical CI runs and the existing production deploy kill switch. Prepare creates only the dedicated empty queue and disabled Worker; activation requires provider code and flags, the installed private-hints RPC, exact queue/binding readback and denial of unauthenticated access. Activation readback failure restores the previous disabled Worker version.
