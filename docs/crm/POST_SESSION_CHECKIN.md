# Post-session check-in readiness

Status: technically ready, product configuration not approved.

This document records the existing activation boundary for a client email sent
after an appointment. It does not choose a delay, write client-facing copy, or
enable production configuration. Repository and production state must be
fresh-checked before an activation workstream uses it.

## Product decisions still required

Activation must not begin until one authoritative decision names all of:

1. the positive offset from `session_end`;
2. the exact email subject and body for every activated locale;
3. the appointment types that receive the message.

The `+60 minute` offset and copy in
`supabase/tests/246_client_lifecycle_session_end.sql` are synthetic test
fixtures. They are explicitly not approved production configuration. The
catalogue description for `post_session_checkin` identifies the service
purpose, but it is not client-facing copy and does not supply a delay or an
appointment-type scope.

## Existing runtime contract

No new scheduler, Worker, queue, credential path, or provider integration is
needed. The current chain is:

```text
existing shared Cloudflare cron
  -> service_run_automation_tick
  -> session-scoped lifecycle job
  -> system-approved email_messages row
  -> integration_outbox kind approved_email
  -> existing Gmail Worker Service Binding
  -> Gmail provider
```

The effective lifecycle scheduler is defined by the ordered result of
migrations `0093` and `0096`. Migration `0100` adds appointment-action helpers
used by selected pre-session templates but does not replace the scheduler.
Always trace the current effective definitions and grants rather than reading
only the first migration that names an RPC.

The runtime and rollback-only pgTAP already prove:

- `session_end` schedules from authoritative `sessions.end_at`;
- a post-session rule uses a zero or positive offset;
- a due job remains pending until the appointment is `completed`;
- `cancelled` and `no_show` do not send, and a no-show withdraws a pending job;
- one rule and one session have one live job;
- repeated ticks do not duplicate the CRM email or Gmail outbox item;
- delivery preserves system-approved `automation_job_id` provenance;
- the send re-reads suppression, destination, template, appointment and Gmail
  availability under the existing lifecycle boundary.

The main evidence is `supabase/tests/246_client_lifecycle_session_end.sql`,
with broader authorization, suppression, reschedule and idempotency coverage in
tests `240` and `241`.

## Activation workstream

After the product decision exists:

1. fresh-check the canonical platform head, open PRs, production migration
   head, migration ledger, lifecycle configuration and provider runtime;
2. claim the next free migration number at that time, never a number remembered
   from this document;
3. follow the configuration-as-data pattern in migration `0097`;
4. insert approved `post_session_checkin` service email templates and
   `session_end` rules only for the approved appointment types and locales;
5. prove the draft/disabled control-plane defaults separately before the
   activation migration writes reviewed active/enabled configuration;
6. add migration post-conditions that reject a missing active template,
   unexpected rule count, wrong anchor, non-positive delay, non-service
   purpose, non-email channel, or unapproved appointment type;
7. run full migration replay, pgTAP, database lint, CRM tests, production build,
   Worker tests and secret scan on the exact head;
8. use the existing private exact-SHA production release path;
9. read back Supabase, Pages, the shared scheduler, Service Binding, flags,
   routes, Custom Domain, preview exposure and secret names after deployment.

The activation must leave this provider path unchanged:

```text
approved_email -> GMAIL_SERVICE -> vishar-gmail-production
```

It must also preserve the existing five-minute shared cron and enabled
Telegram/Gmail/automation flags. Secret values never belong in source, logs,
PR text or acceptance reports.

## Production acceptance

Use no fake production client, enquiry, payment or appointment merely to force
an email. Prefer, in order:

1. an existing service-level acceptance mechanism;
2. a legitimate completed appointment for which the newly approved message is
   expected product behaviour;
3. an existing controlled operator/test recipient mechanism.

Before the first provider delivery, safe readback must prove:

- the intended rule and active template counts;
- `session_end` plus the approved positive offset;
- the exact approved appointment-type scope;
- one `automation_jobs` row per rule/session and the calculated `scheduled_at`;
- no job for cancelled/no-show delivery;
- suppression and destination re-checks;
- system-approved email provenance and one `approved_email` outbox item;
- repeated heartbeat idempotency;
- unchanged Gmail and Telegram shared-scheduler runtime.

If no safe provider E2E is available, the first organic expected delivery is
the only remaining acceptance criterion. Record its job-to-email-to-outbox
provenance without exposing client data.

## Rollback

The operational rollback is configuration-only: disable the post-session
rules and retire their active templates through the existing control plane or
a narrowly reviewed forward migration. Do not delete lifecycle history, reuse
an old migration number, introduce a second send path, or weaken completed-only
and suppression gates. Confirm through readback that no enabled
`post_session_checkin` rule remains and that unrelated lifecycle rules are
unchanged.
