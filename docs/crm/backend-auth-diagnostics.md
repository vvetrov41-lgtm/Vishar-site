# Intermittent backend auth diagnostics

This is instrumentation, not a root-cause fix. The gateway hypothesis is not proven.

## Source and runtime baseline

On 2026-08-27 at 13:37 UTC, read-only inventory run 33077728906 found scheduler
version `bd7b15df-0830-4adb-9bd7-071ff8fd9f95` (release rc121, source bbaa9b04).
Canonical `2639dbd3dfd56b1d44060b9526b9c3cd515877e3` also contains migration 0114;
production was still on 0113. The diagnostic release deliberately deploys only
the scheduler, with no database, Pages, Gmail or Calendar deployment.

PR #474 had already introduced one retry for every secret-key HTTP 401. This
patch neither expands that policy nor treats it as an established remediation.
Each response is observed BEFORE that retry, with attempt 1 or 2. A successful
second attempt cannot erase evidence of the first rejection. Investigation must
revisit this policy once the actual rejection reason is understood.

## Privacy contract

`supabase_backend_response` includes only an exact allowlisted RPC/task/client,
key kind (never value or fingerprint), status/classification, attempt, strict
response UUIDs/CF ray, timestamp/duration and allowlisted error code/reason enums.
Known message strings map to enums; raw messages, details, response bodies,
request arguments, headers, credentials and customer/provider data never leave
the parser. Error reads stop at 4096 bytes or 500 ms. Success bodies are untouched.
The observer emits at most 16 events per client instance. Only eight scheduler
claim/tick/heartbeat/alert RPC names are eligible; other RPCs cannot expose names.
Gmail backend source uses the same projection. User-token RPCs never emit backend
telemetry. Gmail and Calendar runtime instrumentation remains undeployed by this
scheduler-only release.

## Protected scheduler release and observation

Create an `ops/backend-auth-release-*` branch at exact current canonical, then
add one empty commit with identical tree. Branch creation does no work. The
update runs the crm-production environment job, checks owner, immutable parent/
tree/ref, current canonical and exact-head Static/CRM/Gmail success. It reuses
the normal scheduler config generator, preflight, dry-run and deploy/readback.
The deployment kill switch and live version are checked immediately before
mutation. Source SHA is stored as the Worker version tag and read back through
the Cloudflare API. No secret is created, rotated or retrieved.

The same job opens a temporary Wrangler tail for the exact active version.
Only natural cron envelopes are accepted. Raw tail frames and stderr are never
persisted, printed or uploaded. Balanced JSON framing is capped at 1 MiB;
accepted events are re-sanitized and capped at 250. The session ends after at
most 20 minutes or a natural 401 with neighboring 200 in the same cron/version/
key-kind/client. SIGINT closes the tail, with a five-second termination bound.
Only the safe JSON projection is uploaded, with seven-day retention. Version,
secret names and relevant bindings are checked before and after observation.

An `ops/backend-auth-observe-*` empty-commit branch uses the same guards and
observer without any deploy. It requires the active version tag to match the
approved canonical SHA. A window without 401 is inconclusive, never a fix.

## Evidence and incident packet

Record UTC timestamps, RPCs, exact Worker version/source, status, safe codes and
response IDs. Compare first-attempt 401 against neighboring first-attempt 200s
using the same backend client/configuration, and separately mark any retry.
No key fingerprint is needed. A PGRST JWT rejection identifies the rejection
reason, not necessarily the internal gateway component that created the token.
Provider-side request-ID correlation may be needed for a definitive cause.
Do not rotate keys, change auth headers or add retries based on status alone.
After a proven bounded fix, require exact-head CI, deployed readback and multiple
natural cron windows; successful ticks alone cannot establish remediation.
