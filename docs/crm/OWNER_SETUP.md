# Vishar Tattoo CRM — owner setup runbook

Last updated: 29 July 2026

Everything in this document is a **manual owner action**. None of it has been
performed. The repository contains code, migrations, tests and runbooks only.

Read [`SECURITY.md`](./SECURITY.md) before running any step that handles a key.

## 0. Decisions required before anything is created

These cannot be inferred from the repository and must not be invented by an
agent. Record each answer, with a date, before proceeding.

| # | Decision | Why it blocks | Status |
|---|---|---|---|
| 1 | Supabase organisation, project name and **region** | Region affects UK GDPR posture and latency; irreversible without a migration | ❌ outstanding |
| 2 | Owner's Supabase Auth email address | Bootstrap needs a real identity; the schema deliberately hard-codes none | ❌ outstanding |
| 3 | Operating **currency** | Money columns default to `GBP` but currency is stored explicitly per row | ⚠️ default `GBP`, owner confirmation outstanding |
| 4 | **Retention policy** duration(s) | `system_settings` ships with retention disabled and null durations; no duration has been invented | ❌ outstanding |
| 5 | Whether `booking_manager` may read `activity_log`, and how much | Default is a limited read of their own entity scope | ⚠️ default set, owner confirmation outstanding |
| 6 | Whether `read_only` may open signed file URLs | Default is no | ⚠️ default set, owner confirmation outstanding |
| 7 | Transactional email sender address and provider | Needed before any email leaves the outbox | ❌ outstanding |
| 8 | Which session status counts as "confirmed" for Calendar | Schema uses `confirmed`; confirm this matches the working process | ⚠️ default `confirmed`, owner confirmation outstanding |
| 9 | Staging and production hostnames, including whether `admin.vishartattoo.com` is the CRM host | DNS is an owner action | ❌ outstanding |
| 10 | Backup retention / PITR tier on the Supabase project | Paid setting | ❌ outstanding |
| 11 | GitHub `production` environment reviewer and least-privilege Cloudflare deploy token owner | The workflow names an environment but repository code cannot create its approval rules | ❌ outstanding |

## 1. Create the Supabase projects

Create **two separate projects**: staging and production. Do not share one
project between environments.

1. Create the staging project. Note its project ref, URL, publishable key and
   secret key.
2. Create the production project separately.
3. Enable point-in-time recovery or scheduled backups per decision 10.
4. In **Auth → Providers**, enable email/password. Disable sign-ups if the
   provider supports it; staff accounts are provisioned by the owner, not
   self-service.
5. Do **not** create any table by hand. The schema comes from migrations only.

Never paste a secret key (or a legacy service-role key) into a chat, an issue,
a commit, a log, or an agent prompt. It is a full-database credential that
bypasses RLS.

## 2. Apply migrations

Order matters and is strictly by filename. See [`DEPLOYMENT.md`](./DEPLOYMENT.md)
for the gate sequence (staging first, tests, then production with approval).

```bash
# from the repository root, with the Supabase CLI installed and logged in
supabase link --project-ref <STAGING_PROJECT_REF>
supabase db push          # applies supabase/migrations/*.sql in order
supabase test db --linked # runs supabase/tests/*.sql against staging (pgTAP)
supabase db lint --linked --schema public,crm_private --level error --fail-on error
```

Migrations are forward-only. Never edit an applied migration; add a new,
higher-numbered one.

## 3. Create the owner account and bootstrap the owner role

The schema contains **no owner email, no owner UUID and no password**. The
first owner is promoted by an explicit, idempotent call that you supply the
identity to.

### 3a. Create the auth user

In the Supabase dashboard: **Authentication → Users → Add user**. Use the email
from decision 2 and a password from your password manager. Confirm the email.

### 3b. Promote to owner

Run **once**, in the Supabase SQL editor, substituting the real email:

```sql
-- Promotes an existing auth user to the CRM owner role.
-- Idempotent: running it again with the same email is a no-op that still
-- returns the profile id. Writes an `owner.bootstrapped` activity event the
-- first time it changes anything.
SELECT public.bootstrap_owner_by_email('OWNER-EMAIL-HERE', 'Vladimir Vishar');
```

If you prefer to pass the UUID instead of the email:

```sql
SELECT public.bootstrap_owner('00000000-0000-0000-0000-000000000000'::uuid, 'Vladimir Vishar');
```

Both functions:

- fail loudly if no matching `auth.users` row exists — they never create one;
- are idempotent;
- record an `owner.bootstrapped` row in `activity_log` on first promotion.

### 3c. Verify the bootstrap is locked down

Migration `0009` revokes the bootstrap entry points from every application
role, including the Worker backend. They are intended only for an explicit
manual SQL Editor operation by the database owner. Verify the deployed ACL:

```sql
SELECT
  has_function_privilege('anon', 'public.bootstrap_owner(uuid,text)', 'EXECUTE') AS anon_can_run,
  has_function_privilege('authenticated', 'public.bootstrap_owner(uuid,text)', 'EXECUTE') AS authenticated_can_run,
  has_function_privilege('service_role', 'public.bootstrap_owner(uuid,text)', 'EXECUTE') AS backend_can_run;
```

All three values must be `false`. Do not grant either bootstrap function to an
API role. The exact first-owner call remains idempotent when repeated from the
SQL Editor; subsequent staff and role changes use the controlled owner RPCs.

### 3d. Add staff

The current CRM **Users** screen manages profiles that already exist; it does
not create an Auth account or provision a new profile. For this draft, adding a
person is a two-step owner operation: create the Auth user in the Supabase
dashboard, then provision the matching `profiles` row through an audited
staging procedure before production. That narrow provisioning RPC/UI is not
implemented in this PR, so direct ad-hoc profile inserts must not be presented
as a finished production workflow. Staff are never given the owner role
"temporarily".

## 4. Verify the private bucket

Migration `0008` creates the `crm-files` bucket as private. After applying it,
confirm in **Storage → Buckets** that:

- `crm-files` exists;
- **Public** is **off**;
- there is no other bucket holding client files;
- policies are present on `storage.objects` for the bucket.

A quick negative check — this must fail or return the object as inaccessible:

```bash
curl -I "https://<PROJECT_REF>.supabase.co/storage/v1/object/public/crm-files/anything"
```

## 5. Configure Cloudflare Worker secrets

Set per environment. Never commit these, and never place them in
`wrangler.toml`.

```bash
# staging / preview environment
wrangler secret put SUPABASE_SECRET_KEY       --env preview
wrangler secret put TELEGRAM_BOT_TOKEN        --env preview
wrangler secret put TELEGRAM_CHAT_ID          --env preview

# existing production Worker (`tattooai`, no Wrangler environment suffix)
wrangler secret put SUPABASE_SECRET_KEY
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
```

Use the project's current `sb_secret_...` key. The Worker sends it only as the
Supabase `apikey` header, rejects it if placed under the legacy variable name,
and refuses to start when both key formats are configured. A legacy
service-role JWT is supported only as a temporary migration fallback through
`SUPABASE_SERVICE_ROLE_KEY`.

`SUPABASE_URL` is environment-specific but not secret. Set it as a dashboard
variable on `tattooai-preview` for staging and on the existing top-level
`tattooai` Worker for production. The production workflow uses `--keep-vars`
so a deploy cannot erase that dashboard-managed value. Confirm each Worker
shows a different project ref before sending test traffic; a preview Worker
must never point at the production database.

Set `ALLOWED_ORIGINS` as a dashboard variable too: a comma-separated list of
exact HTTPS site origins, with no paths. It replaces the defaults rather than
extending them, so the staging value must contain only the staging booking
origin(s) and the production value must contain only
`https://vishartattoo.com,https://www.vishartattoo.com`. If it is absent, the
top-level production Worker falls back to those two origins; the preview
Worker is identified by its checked-in `VISHAR_ENVIRONMENT=preview` binding
and fails closed when its list is absent. If a configured list is invalid,
intake also fails closed.

The checked-in `/booking/` page does not send from an arbitrary preview host:
its `vishar-booking-endpoint` meta value is empty and the production fallback
activates only on the two production hostnames. When building the staging
artifact, set that meta value to the `tattooai-preview` URL and verify the
resulting artifact before publishing it. Keep this as a staging artifact
substitution; do not commit a preview endpoint into the production page.

Use a **separate, non-production Telegram chat** for staging. Do not send test
enquiries to the production chat.

Before enabling `.github/workflows/deploy-tattooai.yml`, create the GitHub
`production` environment, require the reviewer chosen in decision 11, restrict
deployments to `main`, and put a least-privilege `CLOUDFLARE_API_TOKEN` plus
`CLOUDFLARE_ACCOUNT_ID` in that environment. The YAML names the environment;
it cannot create or verify those protection settings.

## 6. Configure Cloudflare rate limiting

Not repository code. In the Cloudflare dashboard, add a rate-limit or WAF rule
on the Worker route covering the intake path. Suggested starting shape, to be
tuned against real traffic:

- key: client IP;
- threshold: a small number of intake POSTs per minute per IP;
- action: managed challenge, then block on repeat.

## 7. Build and host the CRM application

The CRM is a separate build in `admin/`. It needs exactly two public values:

```bash
# admin/.env.local — never committed
VITE_SUPABASE_URL=https://<PROJECT_REF>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<sb_publishable_... key>
```

The publishable key is a public identifier, not authority — RLS decides
everything. A secret/service-role key must never appear in this file or in any
build output.

```bash
cd admin
npm install
npm run build      # emits admin/dist
```

Host `admin/dist` separately from the public site. If `admin.vishartattoo.com`
is used, creating that DNS record and its hosting target is an owner action.
Cloudflare Access in front of the CRM is recommended as defence in depth — it
is not the authorisation system, RLS is.

## 8. Gmail and Google Calendar

**Not connected. Do not mark this complete from repository work.**

When the owner is ready:

1. Create a Google Cloud project and OAuth client.
2. Grant only the minimum scopes: draft/send for Gmail, single-calendar
   read/write for Calendar.
3. Complete the consent flow as the owner account.
4. Store the client secret and refresh token in an encrypted server-side secret
   store reachable only by the Worker. They must not be placed in any Supabase
   table readable by any CRM role, and must never be sent to a browser.
5. Only then enable the corresponding outbox kinds.

Until step 5, `workers/lib/email.js` and `workers/lib/calendar.js` are
interfaces with no provider bound. The CRM shows a Calendar status placeholder
and never claims a connection.

## 9. Privacy and transfer deployment gate

**Do not publish the durable booking form until this gate is complete.**

1. Record the selected Supabase region and confirm the Cloudflare, Supabase and
   Telegram processing/support locations that apply to the production accounts.
2. Review and accept the providers' current data-processing terms.
3. Document any restricted transfer, the applicable UK adequacy regulation or
   safeguard, and any transfer risk assessment required for the actual route.
4. Update `/privacy/` with the arrangement actually in force. Do not leave
   future-tense placeholder wording in a live notice.
5. Record the owner approval and the notice version deployed with the form.

This is an owner/legal deployment decision, not something repository code can
complete or infer.

## 10. Retention

`system_settings` ships with:

- `retention_enabled = false`;
- every retention duration `null`;
- no scheduled deletion job.

Nothing deletes client data automatically. When the owner records a policy
(decision 4), the retention job must support a dry run, audit events, legal and
operational holds, and separate database and Storage cleanup passes. Do not
enable retention before those exist.

## 11. Post-deployment verification

Only after an owner-approved deployment, and using clearly marked test data:

1. Submit a test enquiry from the staging booking page.
2. Confirm the `enquiries` row exists with a `ENQ-YYYY-NNNN` reference.
3. Confirm `enquiry_files` rows are `ready` and objects exist at canonical
   paths.
4. Confirm the staging Telegram chat received the notification.
5. Confirm the CRM shows the enquiry, and that a signed file URL opens and then
   expires.
6. Re-submit with the same idempotency key and confirm the same reference is
   returned and no second row is created.
7. Sign in as a `read_only` account and confirm finance fields are absent.
8. Deactivate a test profile and confirm its session can no longer read data.
9. Delete the test data.

## 11. Outstanding owner actions — summary

- [ ] Decisions 1–11 above recorded.
- [ ] Staging and production Supabase projects created.
- [ ] Migrations applied to staging, `supabase test db` green.
- [ ] Owner auth user created and promoted; bootstrap revoked.
- [ ] `crm-files` bucket confirmed private.
- [ ] Worker secrets set per environment; staging Telegram chat separate.
- [ ] Cloudflare rate limiting configured.
- [ ] CRM built and hosted; DNS created if applicable.
- [ ] Migrations applied to production under approval.
- [ ] Gmail / Calendar OAuth — deliberately deferred.
- [ ] Retention policy — deliberately deferred.
