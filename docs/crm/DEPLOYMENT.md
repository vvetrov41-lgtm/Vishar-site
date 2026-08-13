# Vishar Tattoo CRM — environments, migrations and deployment gates

Last updated: 29 July 2026

**Nothing described here has been executed.** No deployment, no hosted Supabase
project, no production migration, no secret configuration, no DNS change. This
document defines the intended process and the gates that stop it from happening
by accident.

The exact hosted-staging procedure, evidence format and teardown sequence are in
[`STAGING.md`](./STAGING.md).

## 1. Environment separation

Three environments, fully separated. No credential, database, bucket or
notification channel is shared between them.

| | Local | Staging | Production |
|---|---|---|---|
| Postgres | local Supabase (Docker) or a local Postgres cluster with the test shim | dedicated `vishar-crm-staging` Supabase project | dedicated production Supabase project, not created |
| Storage | local `crm-files` | staging `crm-files` | production `crm-files` |
| Worker | `wrangler dev` with mocked providers | `tattooai-preview` on `intake-staging.vishartattoo.com` | top-level `tattooai` (`wrangler deploy --env=""`) |
| Telegram | mocked, no network call | separate staging bot/private chat | owner's real chat |
| Email | interface only, no provider | disconnected | disconnected until separately approved |
| Calendar | interface only | disconnected | disconnected until separately approved |
| CRM app | `npm run dev` | owner-only `vishar-crm-staging` Pages project | `admin.vishartattoo.com` or other approved host, not created |
| Booking app | local static page | owner-only `vishar-booking-staging` Pages project | public site after production approval |
| Data | fabricated fixtures from `supabase/seed.sql` | clearly marked synthetic data only | real client data |

Rules:

- `SUPABASE_URL` is an environment **variable**, not a secret, and is pinned per
  environment. A preview Worker must never point at production.
- `SUPABASE_SECRET_KEY` is an environment **secret** and differs per project.
- `supabase/seed.sql` is local-only. It is never applied to staging or
  production, and it contains only fabricated identities.
- Cloudflare Access protects the staging booking and CRM Pages projects. It is
  not placed directly in front of the cross-origin Worker endpoint.
- The preview Worker uses a temporary Custom Domain under the Cloudflare zone so
  zone WAF/rate limiting can protect it.
- Preview `workers.dev` and any alternate preview URL must be disabled before
  test traffic so they cannot bypass zone controls.
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
0011_conversion_idempotency.sql  deterministic enquiry-conversion retry contract
0012_default_function_acl.sql    closed-by-default function execution for postgres-owned code
```

Rules:

1. **Never edit an applied migration.** Fix forward with a new file.
2. Migration numbering is monotonic; do not reuse a number.
3. Every migration must be idempotent enough to be safe on partial replay where
   practical, but correctness comes from applying them in order exactly once.
4. Once production data exists, prefer a corrective forward migration over any
   rollback. Take a restore point before every production migration.
5. `0009` must be applied before an owner can use the CRM, but the owner
   identity is supplied at run time, never in the file.
6. `supabase/seed.sql` is never applied to a hosted environment.

### Rollback posture

| Situation | Action |
|---|---|
| Failure on a new empty staging project | Stop, retain sanitised evidence, then delete/recreate only after approval |
| Application failure after staging data exists | Keep staging intact, fix forward, rerun CI and the affected E2E cases |
| Failure in production, no data written yet | Restore from the pre-migration restore point |
| Failure in production, data written | Corrective forward migration; do not down-migrate |

There are no `down` migrations. Reversing DDL against live client data loses
data more often than it saves it.

## 3. Deployment gates

Each gate must pass before the next. A gate is not assumed green.

```text
Gate 1  Repository checks
        git diff --check
        npm run validate:site
        npm run test:booking
        npm run test:worker
        node --check workers/tattooai.js
        npm run scan:secrets
        cd admin && npm test && npm run typecheck && npm run build
        ↓
Gate 2  Canonical local/CI database tests
        supabase start
        supabase db reset --local --no-seed
        supabase test db
        supabase db lint --local --schema public,crm_private --level error --fail-on error
        ↓
Gate 3  Owner authorises creation of isolated staging resources
        exact source SHA recorded
        production remains untouched
        ↓
Gate 4  Empty hosted staging database
        create only vishar-crm-staging in eu-west-2
        supabase link --project-ref <STAGING_PROJECT_REF>
        supabase db push --dry-run
        supabase db push
        do not use --include-seed
        verify migrations 0001–0012 and empty CRM tables
        ↓
Gate 5  Hosted database validation before owner bootstrap
        supabase test db --linked
        supabase db lint --linked --schema public,crm_private --level error --fail-on error
        verify tests left no rows or objects
        ↓
Gate 6  Staging identities and private Storage
        create owner Auth user and bootstrap manually
        create synthetic role accounts
        verify RLS, ACL, bucket privacy and signed URLs
        ↓
Gate 7  Protected staging deployment
        reviewed preview-only workers_dev=false change
        deploy tattooai-preview
        attach intake-staging.vishartattoo.com as Custom Domain
        verify workers.dev and other bypass URLs unavailable
        configure exact-origin CORS, WAF and rate limiting
        build/upload owner-only booking and CRM Pages artifacts
        ↓
Gate 8  Hosted E2E matrix
        run the cases in STAGING.md
        collect sanitised PASS/FAIL evidence
        rerun fixes through CI and staging
        ↓
Gate 9  Owner staging exit decision
        destructive teardown or explicit temporary retention
        ↓
Gate 10 Production approval  ← MANUAL, separate from staging
        ↓
Gate 11 Production migration and deployment
        restore point, production db push, protected workflow deployment
        ↓
Gate 12 Post-deploy verification
        see OWNER_SETUP.md
```

A green staging run does not authorise Gates 10–12. Merge, ready-for-review and
production deployment remain separate owner decisions.

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
`--env=""` selects this top-level environment explicitly. It declares a separate
Wrangler preview environment (`tattooai-preview`) and repeats the non-inherited
AI binding there. A non-secret `VISHAR_ENVIRONMENT` binding identifies the two
deployments so preview fails closed when its allow-list is missing.

Current checked-in preview state:

```toml
[env.preview]
workers_dev = true

[env.preview.ai]
binding = "AI"

[env.preview.vars]
VISHAR_ENVIRONMENT = "preview"
```

Before hosted staging traffic, a separate reviewed configuration commit must
change only the preview route setting to:

```toml
[env.preview]
workers_dev = false
```

The top-level production `workers_dev` setting must remain unchanged. Disabling
only in the dashboard is insufficient because a later Wrangler deployment can
re-enable the route from configuration. Explicit Worker Preview URLs must also
be disabled if enabled.

The preview Worker is reached only through the approved Custom Domain:

```text
intake-staging.vishartattoo.com
```

A Custom Domain makes the Worker the origin for that exact hostname. Before the
first test request, confirm the `workers.dev` hostname is unavailable; otherwise
zone WAF and rate-limit controls could be bypassed and staging must stop.

Do not commit either Supabase project URL. Set `SUPABASE_URL` and
`ALLOWED_ORIGINS` as dashboard-managed variables on `tattooai-preview`.
`ALLOWED_ORIGINS` is an exact replacement list: staging contains only the exact
booking staging origin. It does not include the CRM origin, production apex,
production `www` or a wildcard.

The checked-in booking page deliberately leaves the
`vishar-booking-endpoint` meta value empty outside the two production hostnames.
A throwaway staging artifact sets that value to the Custom Domain URL and, when
required by the available rate-limit plan, a unique staging-only path. The
tracked production source is not changed for that substitution.

Preview secrets use:

```bash
wrangler secret put SUPABASE_SECRET_KEY --env preview
wrangler secret put TELEGRAM_BOT_TOKEN --env preview
wrangler secret put TELEGRAM_CHAT_ID --env preview
```

The Worker treats a missing `SUPABASE_URL` or backend key as a configuration
error and refuses durable intake rather than silently falling back to Telegram.

## 5. Cloudflare staging controls

Cloudflare Access is owner-only on both Pages projects. It is not applied to the
Worker because no Access token/cookie forwarding flow is implemented for the
cross-origin booking request.

The Worker endpoint remains temporary and publicly reachable, so all of these
are mandatory:

- staging-only Supabase and Telegram credentials;
- synthetic data only;
- exact `ALLOWED_ORIGINS`;
- existing request and file-size validation;
- zone WAF and rate limiting;
- `workers.dev` and alternate preview URLs disabled;
- full teardown after testing.

Inspect the actual zone plan before creating rate-limit rules. When host matching
is available, scope the rule to the exact staging hostname, method and intake
path. When it is unavailable, use a unique staging-only path and a separate WAF
custom rule on the hostname to block every other path and every method except
`POST` and `OPTIONS`. The path is not authentication.

No Worker Rate Limiting API binding or application-code rate limiter is approved
for this staging phase.

## 6. Running the database tests locally

The canonical runner is the Supabase CLI, which requires Docker:

```bash
supabase start
supabase db reset --local --no-seed
supabase test db
supabase db lint --local --schema public,crm_private --level error --fail-on error
```

`supabase start` may load `supabase/seed.sql` for local UI development. The
explicit reset above reapplies all migrations and skips the fabricated seed
before pgTAP starts. Bootstrap tests therefore begin with zero profiles. To
deliberately restore the local UI fixtures, omit `--no-seed`:

```bash
supabase db reset --local
```

When Docker or the Supabase CLI is unavailable, `scripts/run-crm-db-tests.sh`
runs the same pgTAP files against a throwaway local PostgreSQL 16 cluster, using
`scripts/test-support/supabase-shim.sql` to emulate the parts of Supabase that
migrations depend on. Requirements:

- PostgreSQL 16 server binaries (`initdb`, `pg_ctl`, `psql`);
- the `pgtap` extension available to that server;
- `pgcrypto` and `citext`.

```bash
npm run test:db
```

The shim is a test harness, not a production artifact. It is never applied to a
hosted database. A shim-only pass is not a hosted-Supabase pass.

## 7. What is intentionally not deployed

The repository work that introduced and updated this document deliberately did
not:

- merge any pull request;
- deploy Cloudflare Pages or the Cloudflare Worker;
- create a Supabase organisation, project or database;
- apply any migration to a hosted database;
- configure any production secret;
- change DNS or create a Worker Custom Domain;
- connect Gmail or Google Calendar OAuth;
- send a real email or create a real calendar event;
- send anything to the production Telegram chat;
- write to, read from or alter any production data.

The approved architecture and staging documents state the same limit and do not
extend it.
