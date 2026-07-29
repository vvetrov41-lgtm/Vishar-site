# Vishar Tattoo CRM — environments, migrations and deployment gates

Last updated: 29 July 2026

**Nothing described here has been executed.** No deployment, no hosted Supabase
project, no production migration, no secret configuration, no DNS change. This
document defines the intended process and the gates that stop it from happening
by accident.

## 1. Environment separation

Three environments, fully separated. No credential, database, bucket or
notification channel is shared between them.

| | Local | Staging | Production |
|---|---|---|---|
| Postgres | local Supabase (Docker) or a local Postgres cluster with the test shim | dedicated staging Supabase project | dedicated production Supabase project |
| Storage | local `crm-files` | staging `crm-files` | production `crm-files` |
| Worker | `wrangler dev` with mocked providers | `wrangler deploy --env preview` | top-level `tattooai` (`wrangler deploy --env=""`) |
| Telegram | mocked, no network call | separate non-production chat | owner's real chat |
| Email | interface only, no provider | test sender, if configured | owner's sender |
| Calendar | interface only | not connected | not connected |
| CRM app | `npm run dev` | preview host | `admin.vishartattoo.com` (not created) |
| Data | fabricated fixtures from `supabase/seed.sql` | clearly marked test data | real client data |

Rules:

- `SUPABASE_URL` is an environment **variable**, not a secret, and is pinned per
  environment. This is what stops a preview Worker from writing to the
  production database.
- `SUPABASE_SECRET_KEY` is an environment **secret** and differs per
  project.
- `supabase/seed.sql` is local-only. It is never applied to staging or
  production, and it contains only obviously fabricated identities.
- A production deployment never runs from a developer machine without the
  approval gate below.

## 2. Migration order and rules

Forward-only, applied strictly in filename order:

```text
0001_extensions_types.sql        extensions, enums, transition table
0002_profiles_clients.sql        profiles, clients, normalisation functions
0003_enquiries_files.sql         enquiries, enquiry_files, reference sequence
0004_projects_sessions.sql       projects, sessions, money + calendar constraints
0005_activity_outbox_notes.sql   activity_log, internal_notes, email_messages,
                                 follow_ups, integration_outbox
0006_functions_triggers.sql      secure functions, triggers, intake RPC
0007_rls.sql                     RLS enable/force + all policies
0008_storage.sql                 private crm-files bucket + Storage policies
0009_bootstrap_owner.sql         idempotent owner promotion (no identity baked in)
0010_retention_settings.sql      system_settings, retention disabled, null durations
```

Rules:

1. **Never edit an applied migration.** Fix forward with a new file.
2. Migration numbering is monotonic; do not reuse a number.
3. Every migration must be idempotent enough to be safe on partial replay where
   practical (`IF NOT EXISTS`, `CREATE OR REPLACE`), but correctness comes from
   applying them in order exactly once.
4. Once production data exists, prefer a corrective forward migration over any
   rollback. Take a restore point before every production migration.
5. `0009` must be applied before an owner can use the CRM, but the owner
   identity is supplied at run time, never in the file.

### Rollback posture

| Situation | Action |
|---|---|
| Failure in staging | Reset staging, fix the migration, re-apply from scratch |
| Failure in production, no data written yet | Restore from the pre-migration restore point |
| Failure in production, data written | Corrective forward migration; do not down-migrate |

There are no `down` migrations. Reversing DDL against live client data loses
data more often than it saves it.

## 3. Deployment gates

Each gate must pass before the next. A gate is not "assumed green".

```text
Gate 1  Repository checks
        git diff --check
        npm run validate:site
        npm run test:booking
        npm run test:worker
        node --check workers/tattooai.js
        secret scan (npm run scan:secrets)
        cd admin && npm test && npm run build
        ↓
Gate 2  Database tests
        supabase test db            (Docker-based, canonical)
        or scripts/run-crm-db-tests.sh   (local cluster + shim, no Docker)
        ↓
Gate 3  Staging migration
        supabase db push  against the STAGING project
        supabase test db --linked  against the STAGING project
        supabase db lint --linked --schema public,crm_private --level error --fail-on error
        ↓
Gate 4  Staging deployment
        wrangler deploy --env preview
        CRM preview build
        booking preview artifact with `vishar-booking-endpoint` set to the
        preview Worker URL (never commit that URL into the production source)
        synthetic intake with marked test data → verify row, file, notification,
        idempotent replay, RLS role behaviour, then delete the test data
        ↓
Gate 5  Owner approval  ← MANUAL. Not automatable. Not an agent action.
        ↓
Gate 6  Production migration
        restore point taken
        supabase db push  against the PRODUCTION project
        ↓
Gate 7  Production deployment
        wrangler deploy --env="" --strict --keep-vars   (manual workflow dispatch)
        CRM production build and host
        ↓
Gate 8  Post-deploy verification
        see OWNER_SETUP.md §11
```

Gates 5 to 8 are owner actions. An agent may prepare them and may not perform
them.

Before placing Cloudflare credentials in GitHub, create a `production`
environment with a required human reviewer and restrict its deployment branch
to `main`. The workflow's `environment: production` declaration selects that
environment but does not create its protection rules. Store the least-privilege
Cloudflare token and account ID as environment secrets so only the final deploy
step receives them; repository-wide secrets are not an equivalent approval
gate.

## 4. Worker environment configuration

`wrangler.toml` preserves the existing top-level `tattooai` Worker as
production because that is the endpoint already used by the site. The empty
`--env=""` selects this top-level environment explicitly. It also
declares a separate Wrangler `preview` environment (`tattooai-preview`) and
repeats the non-inherited AI binding there. A non-secret
`VISHAR_ENVIRONMENT` binding identifies the two deployments so preview fails
closed when its required allow-list is missing. Runtime URLs and allow-lists
remain external owner configuration:

```toml
[env.preview]
workers_dev = true

[env.preview.ai]
binding = "AI"

[env.preview.vars]
VISHAR_ENVIRONMENT = "preview"
```

Do not commit either project URL until the owner has selected the real project
refs. Set `SUPABASE_URL` and `ALLOWED_ORIGINS` as dashboard-managed variables
on `tattooai-preview` and on the existing top-level production Worker
`tattooai`. `ALLOWED_ORIGINS` is an exact, comma-separated replacement list,
not an additive wildcard: staging must contain only staging origins and
production only production origins. The production workflow deploys that
top-level Worker with `--keep-vars`.

The checked-in booking page deliberately leaves the
`vishar-booking-endpoint` meta value empty outside the two production
hostnames. A staging site therefore fails closed until its deployment artifact
sets that meta value to the `tattooai-preview` URL. Add the staging site's
exact origin (scheme and host, with no path) to the preview Worker's
`ALLOWED_ORIGINS`; verify both values before the synthetic intake. Do not
replace the production fallback endpoint while preparing a preview artifact.

Preview secrets (`SUPABASE_SECRET_KEY`, `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID`) use `wrangler secret put --env preview`.
Production secrets use `wrangler secret put` with no environment suffix,
because the live endpoint is the existing `tattooai` Worker rather than a new
`tattooai-production` Worker. Secrets never appear in this file. See
`OWNER_SETUP.md` §5.

The Worker treats a missing `SUPABASE_URL` or backend key as a configuration
error and refuses the durable intake route rather than silently falling back
to notification-only behaviour. `SUPABASE_SECRET_KEY` is preferred; a legacy
JWT may temporarily use `SUPABASE_SERVICE_ROLE_KEY`, but the two are mutually
exclusive. Losing the database must not silently become "Telegram only" again.

## 5. Running the database tests locally

The canonical runner is the Supabase CLI, which requires Docker:

```bash
supabase start
supabase test db
```

When Docker or the Supabase CLI is unavailable, `scripts/run-crm-db-tests.sh`
runs the same pgTAP files against a throwaway local PostgreSQL 16 cluster,
using `supabase/tests/_shim/` to emulate the parts of a Supabase database that
migrations depend on (`auth` schema, `storage` schema, `anon` / `authenticated`
/ `service_role` roles, `auth.uid()`). Requirements:

- PostgreSQL 16 server binaries (`initdb`, `pg_ctl`, `psql`);
- the `pgtap` extension available to that server;
- `pgcrypto` and `citext`.

```bash
npm run test:db
```

The shim is a **test harness**, not a production artifact. It is never applied
to a hosted database. Where the shim differs from real Supabase, the difference
is recorded in `supabase/tests/_shim/README.md` so a shim-only pass is never
mistaken for a hosted-Supabase pass.

## 6. What is intentionally not deployed

For the avoidance of doubt, the repository work that introduced this document
deliberately did **not**:

- merge any pull request;
- deploy Cloudflare Pages or the Cloudflare Worker;
- create a Supabase organisation, project or database;
- apply any migration to any hosted database;
- configure any production secret;
- change DNS or create `admin.vishartattoo.com`;
- connect Gmail or Google Calendar OAuth;
- send a real email or create a real calendar event;
- send anything to the production Telegram chat;
- write to, read from, or alter any production data.

The approved architecture document states the same limit, and this document
does not extend it.
