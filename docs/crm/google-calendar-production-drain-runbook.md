# Google Calendar production scheduled-drain activation

This runbook covers only activation of the already-deployed production Calendar
outbox drain. It assumes the production Calendar Worker, owner-only Cloudflare
Access, Google OAuth connection and private CRM connector are already live.

The tracked `wrangler.calendar.production.toml` intentionally remains inert.
The deploy generator starts from that baseline and produces the only deployable
runtime shape for this phase:

- `CALENDAR_DRAIN_ENABLED = "true"`;
- one `[triggers]` table;
- one cron schedule: `*/5 * * * *`;
- the existing exact Custom Domain, production KV namespaces, Access audience,
  Supabase project and isolated Worker rate limiter;
- `workers_dev=false` and `preview_urls=false`.

## Preconditions

Re-read all of these immediately before an activation run:

1. Exact product and release-candidate SHA are known and CI is green on that
   exact SHA.
2. Production has the expected enabled Calendar integration and no unexpected
   pending/leased/failed/dead outbox rows.
3. Retained staging has no new pending/leased rows. Historical failed/dead rows
   are preserved and are not retried, deleted or drained as part of production
   activation.
4. The production Worker still has the four required secret names. Values are
   never read or printed.
5. Cloudflare Access still gates `calendar.vishartattoo.com` and the existing
   WAF/rate-limit boundaries are unchanged.

No synthetic production appointment, availability block or outbox job is
created for this activation.

## Why the five-minute schedule is bounded

Each scheduled invocation runs the appointment drain and availability drain.
Each queue claims a default maximum of 10 jobs, with a code-level hard maximum
of 20. Leasing is backend-only and uses `FOR UPDATE ... SKIP LOCKED`; result
acknowledgement requires the same lease owner and calendar version. Failed jobs
retain the database backoff/dead-letter rules.

Supabase remains authoritative. Google Calendar is a projection.

## Validation-only run

Use the protected workflow from the exact release branch:

```text
Workflow: Deploy private production Calendar connector
Branch:   release/private-crm-rc<N>
approved_sha: <exact release HEAD>
deploy: false
approval_phrase: empty
```

The generated deployment configuration is not uploaded during this run.

## Production activation run

After validation-only is green, use the same exact release head:

```text
approved_sha: <same exact release HEAD>
deploy: true
approval_phrase: ENABLE_PRIVATE_CRM_CALENDAR_DRAIN
```

The legacy phrase `DEPLOY_PRIVATE_CRM_CALENDAR` is explicitly rejected by this
activation head. `CRM_PRODUCTION_CALENDAR_DEPLOY_ENABLED` must also be exactly
`true` for the live run.

The workflow generates the active runtime configuration, proves the exact
drain flag and cron, performs a Wrangler dry-run, then deploys with `--strict`.
It does not deploy Pages, mutate Supabase, create secrets/KV, or touch retained
staging, Telegram, GPT, booking, Team admin, Monzo or payments.

## Post-deploy verification

Immediately after the deploy:

1. Record the workflow run id, job id, exact SHA and Worker deployment/version
   evidence from Wrangler output.
2. Confirm the unauthenticated `/health` request is still stopped by Cloudflare
   Access. HTTP 200 is a failure.
3. Re-read production `integration_outbox` and confirm there are no unexplained
   state changes. With an empty outbox the first cron runs are no-ops.
4. Re-read retained staging and confirm its historical failed/dead rows and
   availability state are unchanged.
5. Set `CRM_PRODUCTION_CALENDAR_DEPLOY_ENABLED` back to `false` as soon as the
   activation run is complete.

The first real appointment created through normal CRM use becomes the production
E2E evidence. Do not create synthetic production data merely to exercise the
scheduled drain.

## Rollback

If the scheduled runtime itself is unsafe, deploy the known inert Calendar
configuration from the previously accepted exact release candidate. That
configuration has `CALENDAR_DRAIN_ENABLED=false` and no cron trigger, so the
strict deployment removes the schedule and disables `scheduled()` without
changing OAuth tokens, Supabase data, Access, WAF, KV namespaces or the Custom
Domain.

Do not use retained staging as a rollback target and do not copy staging ids,
credentials or provider state into production.
