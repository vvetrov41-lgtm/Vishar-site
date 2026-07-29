# Vishar Tattoo CRM — repository guide

Last updated: 29 July 2026

This directory documents the CRM and durable booking infrastructure for
`vishartattoo.com`. It is repository work only. Nothing described here is
deployed, and no live infrastructure exists as a result of these files.

| Document | Purpose |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Approved architecture, findings, schema plan, RLS matrix, phased plan. Source of truth for design decisions. |
| [`README.md`](./README.md) | This file: component boundaries, data ownership, repository layout, how the pieces fit together. |
| [`SECURITY.md`](./SECURITY.md) | Authentication, RLS, private file access, secret handling, threat boundaries, logging rules. |
| [`OWNER_SETUP.md`](./OWNER_SETUP.md) | Manual owner actions: Supabase project, owner bootstrap, secrets, decisions that must not be invented. |
| [`DEPLOYMENT.md`](./DEPLOYMENT.md) | Local/staging/production separation, migration order, deployment gates, what is intentionally not deployed. |

This documentation set covers only the CRM and booking data path. Website
performance, Core Web Vitals, SEO and accessibility findings live in
`TECHNICAL_AUDIT.md` and `SEO_TECHNICAL_AUDIT.md` and are deliberately not
repeated here.

## 1. Component boundaries

```text
┌────────────────────────┐
│ Public browser          │  /booking/ — static page on Cloudflare Pages
│ (untrusted)             │  multipart/form-data + browser-generated
└───────────┬────────────┘  idempotency key. Holds no credentials.
            │ HTTPS POST
            ▼
┌────────────────────────┐
│ Cloudflare Worker       │  THE ONLY trusted backend for public intake.
│ (trusted)               │  Holds SUPABASE_SERVICE_ROLE_KEY as a Worker
│ workers/tattooai.js     │  secret. Validates origin, body size, fields,
│ workers/routes/*        │  MIME, extension and magic bytes.
│ workers/lib/*           │
└───┬──────────┬─────────┘
    │          │
    │          └──────────────► Telegram (non-critical notification,
    │                            delivered from the outbox AFTER commit)
    ▼
┌────────────────────────┐
│ Supabase Postgres       │  SYSTEM OF RECORD.
│ (system of record)      │  Atomic intake RPC, RLS on every CRM table,
│ supabase/migrations/*   │  append-only activity_log, integration_outbox.
└───┬──────────┬─────────┘
    │          │
    │          ▼
    │   ┌────────────────────────┐
    │   │ Supabase Storage        │  Private bucket `crm-files`.
    │   │ bucket: crm-files       │  No public reads. Short-lived signed
    │   │ (private)               │  URLs only.
    │   └────────────────────────┘
    ▼
┌────────────────────────┐
│ Private CRM app         │  admin/ — Vite + React + TypeScript SPA.
│ (semi-trusted browser)  │  Supabase Auth session + anon key only.
│ admin/                  │  Every read/write is constrained by RLS.
└────────────────────────┘

Later, and not connected:
  Gmail  ─┐
  Google Calendar ─┼─► provider-neutral interfaces in workers/lib/
  AI gateway      ─┘   No OAuth connection exists.
```

### What each boundary is allowed to do

| Boundary | Allowed | Never |
|---|---|---|
| Public browser | Submit a validated enquiry; receive a reference number | Reach Postgres or Storage directly; see any credential |
| Cloudflare Worker | Call narrow Postgres RPCs with `service_role`; write to the private bucket at server-derived paths | Accept a client-controlled storage path; echo secrets; log PII |
| Supabase Postgres | Own all durable state; enforce RLS; append activity | Trust the caller's claimed role over `auth.uid()` |
| Supabase Storage | Store private client files | Serve public URLs; allow unrestricted bucket listing |
| CRM browser | Authenticated, RLS-constrained reads and narrow RPC writes | Hold `service_role`; run arbitrary SQL |
| Telegram | Receive a notification that an enquiry exists | Be the authoritative record |

## 2. Data ownership

**Supabase Postgres is the source of truth.** Every other component is a cache,
a transport, or a view.

- An enquiry exists when the `enquiries` row is committed. Nothing else — not a
  Telegram message, not an email — makes an enquiry real.
- Files are owned by `enquiry_files` / project file rows. Objects in Storage
  without a matching database row are orphans and are removed by reconciliation.
- Telegram messages are notifications. Losing every Telegram message loses no
  business data.
- Google Calendar events (later) are projections of `sessions`. The `sessions`
  table is authoritative; the calendar is reconciled towards it, never the
  reverse.
- Email records live in `email_messages`. Provider message IDs are stored after
  a successful provider response, not before.

### Durable success semantics

The public form reports success **only** when all four are true:

1. the `enquiries` row exists;
2. every required file is stored in the private bucket;
3. every file manifest row is marked `ready`;
4. intake is finalised (`intake_state = 'complete'`).

A Telegram failure after step 4 does not turn a successful enquiry into a
failure. A Storage failure before step 4 triggers compensating deletion,
records a safe operational failure, keeps the idempotency key usable for a
retry, and keeps the incomplete enquiry out of the normal new-enquiry queue.

## 3. Repository layout

```text
docs/crm/                    this documentation set
supabase/
  config.toml                local development configuration only, no secrets
  seed.sql                   local-only fixtures, clearly fake
  migrations/                ordered, forward-only SQL migrations 0001–0010
  tests/                     pgTAP tests + local runner shim
workers/
  tattooai.js                compatibility entry point and thin router
  lib/http.js                CORS, origin allow-list, body limits, responses
  lib/validation.js          field and file validation (MIME, extension, magic bytes)
  lib/supabase.js            narrow PostgREST/RPC client
  lib/storage.js             private bucket upload/delete/signed URL
  lib/activity.js            contextual audit writes
  lib/telegram.js            best-effort notification provider
  lib/outbox.js              durable job helpers and dedupe keys
  lib/logging.js             redacted structured logging
  lib/email.js               provider-neutral email interface (no provider)
  lib/calendar.js            provider-neutral calendar interface (no provider)
  lib/ai-tools.js            named AI tool definitions (no execution backend)
  lib/reconciliation.js      incomplete-intake recovery
  routes/enquiries.js        durable intake orchestration
admin/                       private mobile-first CRM SPA (separate build)
booking/index.html           public form (multipart + idempotency key)
scripts/test-booking-flow.mjs   Worker contract and failure tests
scripts/test-worker-modules.mjs Worker module unit tests
scripts/run-crm-db-tests.sh     local pgTAP runner (no Docker required)
```

The private CRM application in `admin/` has its own `package.json` and build.
It is deliberately not part of the public static site build or of
`npm run validate:site`'s page checks — `admin/` is excluded there by name,
because it is a private application and not an indexable public page.

## 4. Authentication at a glance

| Actor | Mechanism | Credential in browser |
|---|---|---|
| Public visitor | None | None |
| CRM staff | Supabase Auth (email + password) | Supabase URL + anon key only |
| Cloudflare Worker | `SUPABASE_SERVICE_ROLE_KEY` Worker secret | Never |
| AI gateway (later) | Per-caller token mapped to a CRM profile | Never |

Every authenticated database operation additionally requires a `profiles` row
matching `auth.uid()` with `is_active = true`. Deactivating a profile removes
database access immediately, even while an issued JWT is still unexpired.

Full detail: [`SECURITY.md`](./SECURITY.md).

## 5. Migration order

Migrations are forward-only and must be applied in filename order:

| File | Adds |
|---|---|
| `0001_extensions_types.sql` | extensions, enums, allowed status transitions |
| `0002_profiles_clients.sql` | `profiles`, `clients`, normalisation functions |
| `0003_enquiries_files.sql` | `enquiries`, `enquiry_files`, reference generator |
| `0004_projects_sessions.sql` | `projects`, `sessions`, money and calendar constraints |
| `0005_activity_outbox_notes.sql` | `activity_log`, `internal_notes`, `email_messages`, `follow_ups`, `integration_outbox` |
| `0006_functions_triggers.sql` | secure functions, triggers, atomic intake RPC |
| `0007_rls.sql` | RLS enable/force and every policy |
| `0008_storage.sql` | private `crm-files` bucket and Storage policies |
| `0009_bootstrap_owner.sql` | idempotent owner promotion, no hard-coded identity |
| `0010_retention_settings.sql` | `system_settings`, retention disabled with null durations |

Never edit an applied migration. Correct it with a new, higher-numbered
migration.

Full detail: [`DEPLOYMENT.md`](./DEPLOYMENT.md).

## 6. What requires a manual owner action

The repository cannot complete these, and none of them were performed:

- creating a Supabase organisation, project or region;
- applying any migration to a hosted database;
- creating the owner's Supabase Auth user and running the bootstrap promotion;
- setting any Cloudflare Worker secret;
- deploying the Worker, Pages site or CRM application;
- creating `admin.vishartattoo.com` or any DNS record;
- connecting Gmail or Google Calendar OAuth;
- choosing a data-retention duration;
- confirming the operating currency for money columns (`GBP` is the schema
  default; the explicit owner confirmation is still outstanding).

Full detail: [`OWNER_SETUP.md`](./OWNER_SETUP.md).

## 7. What is intentionally not deployed

Nothing in this repository work deploys, merges, migrates or connects
anything. Specifically not done, by design:

- no Cloudflare Pages or Worker deployment;
- no live Supabase project and no production migration;
- no production secret configuration;
- no DNS change and no `admin.vishartattoo.com`;
- no Gmail or Google Calendar OAuth connection;
- no real email sent and no real calendar event created;
- no test payload sent to the production Telegram chat.

The architecture document states the same limit: it does not authorise a merge
or a deployment.
