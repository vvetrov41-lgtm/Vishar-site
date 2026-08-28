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

Create an `release/private-crm-rc*-backend-auth-release-*` branch at exact current canonical, then
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

An `release/private-crm-rc*-backend-auth-observe-*` empty-commit branch uses the same guards and
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

The first diagnostic rollout attempt, run 33079058754, was rejected before any
job steps because the protected environment does not allow `ops/*` branches.
Use the existing approved `release/private-crm-rc*` namespace. Full private
release and its observer explicitly reject `*-backend-auth-*` refs, including
manual invocation, so these refs cannot apply migrations or deploy Pages.
Environment protection rules are unchanged.

## First deployment and observer CLI correction

Run 33080578147 deployed and read back scheduler version
`072fbeb1-b7fa-4597-a478-6bbe68d56e1a`, tagged source
`8416af51c8fc52079233f4b8817a24610eaa7d9f`. The observer then exited without
records. The mock 401s in the preceding test step are NOT production evidence.
Pinned Wrangler rejects a sampling rate of 1; omit that flag for full capture.
Wrangler also treats a log path without `.log` as a directory. Use and validate
an actual `.log` symlink to `/dev/null`, never a regular raw log file.

An observe-only source may descend from the deployed source only when git proves
all Worker sources, dependency manifests and scheduler deployment inputs are
identical. The report separates deployed `source_sha` from `observer_source_sha`.
This permits operator-only fixes without unnecessary production redeployment.

## Controlled project restart after gateway evidence

The official Supabase incident update on 2026-08-27 recommends a project restart
after the PostgREST 14.17 rollout, then Support escalation if 401s continue:
https://supabase.statuspage.io/ ("401 errors due to JWT rejections").

`backend-auth-project-restart.yml` is a separate, owner-only, exact-head operation
on `release/private-crm-rc*-backend-auth-restart-*` empty-child refs. These refs
remain excluded from the full production release. The workflow never deploys a
Worker, changes a secret, applies SQL migrations, or pauses/restores the project.
It uses the existing protected management credential to call exactly
`POST /v1/projects/vfjexhfdbrjmuxfdvbdx/restart` once, without an automatic retry.
Rerunning a workflow attempt is deliberately disabled, including after an
ambiguous request outcome. Inspect the sanitized report and current project
state before considering a new separately authorized operation.

This incident-specific operation requires the successful diagnostic release run
33191205274 and its fresh natural PGRST303 evidence from source
`1d88d6158320025a7a7b9aaa18fa6b20cd54f781`. The exact Worker version, import
closure, dependencies, deployment config and migration tree must be unchanged.
The code pins production migration 0114 and the observed 2-Artist/12-rule/
13-integration baseline. A changed baseline fails closed instead of being
silently accepted.

Before requesting restart, aggregate SELECTs require a healthy heartbeat, no
failed/overdue lifecycle jobs, no unresolved integration errors, no running
lifecycle jobs or outbox leases, no imminent lifecycle work, and no other active
database transaction. The request is limited to the interval 60-120 seconds after
a five-minute cron boundary. This reduces disruption but does not eliminate
restart downtime or lock out newly arriving traffic. No customer data is read.

Recovery requires ACTIVE_HEALTHY, the unchanged migration/rule/integration
baseline, the same Worker deployment, and a successful scheduler heartbeat newer
than the restart request. A new natural-cron observer follows. A 20-minute window
without 401 is observation, not proof that the upstream incident is resolved.
Only sanitized aggregate health, timestamps, version identifiers and observer
records are uploaded for seven days.
## Shared Gmail drain observation

The read-only scheduler observer also extracts existing shared Gmail drain log
summaries into `gmail_records`. It retains only exact Worker/version/cron
metadata, bounded counters, and a closed set of diagnostic error codes. Exact
known exception messages may be reduced to the same closed codes; raw messages,
stacks, job identifiers, request data and credentials are discarded.

This does not call the drain, change Worker code, or send email. The existing
natural cron and unchanged runtime snapshot remain authoritative. Missing Gmail
records do not prove that the Gmail Worker ran successfully. Pending mail must
not be manually retried just to obtain diagnostics.

The bounded investigation started after the 2026-08-28 read-only reconciliation
found two due `approved_email` jobs with zero attempts, while API log samples
contained no `claim_email_outbox` calls. Enabled flags and an installed service
binding alone are not evidence of successful outbound delivery.

If the scheduler only reports `gmail_shared_drain_error`, the dedicated
`gmail-shared-drain-observe.yml` workflow can observe both fixed production
Workers for at most eight minutes. It uses an exact canonical, same-tree empty
trigger in `release/private-crm-rc*-backend-auth-gmail-observe-*`, protected
credentials and exact-head CI. It reads current Gmail version/configuration and
source markers, then listens for the existing RPC and cron events. It never
invokes the drain or a Supabase RPC and never deploys a Worker. Only fixed
exception categories, known function names and sanitized backend diagnostics
survive; raw source, logs, exception text, arguments and credentials are not
saved. Both Worker snapshots must remain unchanged at completion.
