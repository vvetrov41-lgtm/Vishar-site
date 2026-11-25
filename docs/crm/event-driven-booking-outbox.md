# Event-driven booking delivery (staged rollout)

Production measurements on 25 November showed calendar creates waiting on a 5-minute cron, and booking confirmations waiting on that same cadence. This patch adds transaction-committed wake hints and retains existing outbox claiming, version checks, channel selection, send intent, and cron recovery.

## Rollout gate

1. Required exact-head CI and staging boundary tests (including authenticated ingress, disabled mode, queue retry, stale revisions, concurrent claims, no extra sends).
2. Provision a dedicated production queue and random 32-byte hex secret in Cloudflare Worker secret storage; never expose it to the repository, logs or clients. Deploy Calendar, WhatsApp and Instagram internal-only drain routes via their existing approved release gates, verify active source and bindings. Gmail uses its existing service method.
3. Deploy the dedicated wake worker from the immutable approved SHA. Default is disabled; configure the queue producer and consumer, production-only service bindings, and the dedicated custom domain. Verify disabled and invalid-auth requests fail closed. Enable the worker only after verifying its bindings and rollback path.
4. Apply the database migration through the existing production DB release gate. Provision pg_net separately with effective ACL verification: anon/authenticated must not have schema USAGE or queue access, including inherited grants. Do not activate if hosted ownership prevents hardening. Verify the trigger is present. Only after the worker and ACL are ready, provision the same dedicated secret into production Vault as crm_outbox_wake_secret. The HTTP queue carries only a short-lived HMAC bound to lane and due time, never the secret. Never provision the production secret in staging.
5. Verify natural real bookings on both artists with no synthetic production clients or repeated sends. Measure commit-to-calendar and card-ready-to-provider acceptance; retain the original booking card debounce (consultation 10 seconds, tattoo 120 seconds) until a separate financial atomicity acceptance proves it can safely be shortened. Do not promise provider delivery or read receipt latency.

Rollback: remove the Vault wake secret, disable the worker, retain all existing five-minute cron triggers and DB outbox. No queued jobs need to be replayed or recreated. No external worker or provider credentials are shared.
