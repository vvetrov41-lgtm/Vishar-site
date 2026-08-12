# ADR 0005: bounded Telegram automatic drain and rollout cutoff

Status: proposed, code prepared but runtime not deployed

## Decision

Automatic Telegram retries use a dedicated scheduled Worker and a bounded
database claim. The claim is authoritative: it joins the private
`crm_private.outbox_drain_rollouts` watermark and selects only
`telegram_notification` rows created at or after `automatic_after`.

The rollout migration inserts the cutoff without updating existing outbox
rows. Jobs that existed before the migration, including old failures and prior
validation targets, therefore remain ineligible even if Worker code changes.

The claim leases at most 20 due rows with `FOR UPDATE SKIP LOCKED`. The Worker
uses a lower default of 10, processes each row through the same
`processClaimedTelegramJob` path as exact-ID validation, resolves the
event-time artist route, selects only that route's encrypted binding, calls the
existing Telegram sender, and records the result through the existing
lease-owned acknowledgement RPC.

## Delivery semantics

Delivery is at least once, not exactly once. Telegram can accept a message
before the Worker loses connectivity to Supabase. If acknowledgement then
fails, the lease eventually expires and a later invocation may send the same
message again. The Worker reports this state as `unrecorded`; it does not claim
that the provider call was rolled back.

## Runtime boundary

`workers/telegram-drain-worker.js` has only a scheduled handler and fails
closed unless `TELEGRAM_DRAIN_ENABLED` is exactly `true`. Its disabled staging
Wrangler config has `workers_dev = false`, no route and no trigger. Deployment,
encrypted binding upload and cron creation require a separate approval and
guarded activation step.
