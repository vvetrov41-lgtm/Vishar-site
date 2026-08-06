# Retained-staging automatic Calendar drain

This stage enables scheduled Google Calendar outbox processing only for the retained `vishar-crm-staging` environment.

## Schedule and bounds

- Worker: `vishar-calendar-staging`
- Cron: every five minutes (`*/5 * * * *`)
- Maximum claimed per invocation: 10
- Lease: 120 seconds
- `workers.dev`: disabled
- Public custom domain: protected by the existing Cloudflare Access application

The Worker uses the existing backend-only `claim_calendar_outbox` RPC. PostgreSQL `FOR UPDATE SKIP LOCKED` leasing prevents two overlapping invocations from processing the same job. Existing `next_attempt_at`, attempt limits and dead-letter classification remain authoritative for retries.

## Safety boundaries

- Supabase appointments remain authoritative.
- OAuth refresh tokens remain encrypted in Cloudflare KV.
- The database receives no provider token.
- Logs contain aggregate counters and safe machine error codes, not client details or secrets.
- The staging Wrangler file is the only configuration changed to enable the cron.
- No production Worker, route, cron, credential or Supabase project is changed.

## Guarded deployment

PR #182 can deploy only after one successful exact-head validation run. Add both markers to the PR body, replacing the example run ID with the actual successful run:

`<!-- DEPLOY_PR182_CALENDAR_AUTOMATIC_DRAIN_STAGING -->`

`<!-- PR182_EXACT_HEAD_VALIDATION_RUN=123456789 -->`

The deployment workflow fails closed unless the referenced run:

- is the `PR 182 Exact-Head Validation` workflow from `agent/pr182-exact-head-validation`;
- completed successfully;
- has exactly the four required successful jobs;
- uses a harness whose single `TARGET_SHA` equals the current PR #182 head;
- checks out and verifies that target in every job.

The workflow then verifies the exact retained-staging hostname, Worker name, Supabase URL, cron expression, Access gate and deployed Cron Trigger through the Cloudflare API. Remove both markers immediately after the guarded run.

## Hosted E2E

Use one synthetic confirmed appointment and observe the automatic flow without a manual drain:

1. Confirm the appointment creates one pending `calendar_create` job.
2. Wait for a scheduled invocation.
3. Verify the job succeeds once and the appointment becomes `synced` with an event ID.
4. Reschedule once and verify the same event ID is updated.
5. Cancel once and verify the event is removed and the event ID is cleared.

Do not use real client data and do not reset retained staging.
