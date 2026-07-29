# Vishar Tattoo CRM — isolated staging validation

Last updated: 29 July 2026

## 1. Purpose and authority

This runbook defines the temporary hosted staging validation for the CRM and
durable booking infrastructure in draft PR #176.

Approved source state:

- PR #174 base SHA: `2c393269e725f678e10f84886a210da11f012dcc`;
- PR #176 implementation SHA: `f383f3c9ab6d39710e80b769ff4c9b1446b622b8`;
- PR #176 remains draft, open and unmerged.

This document does not authorise production work. It does not authorise:

- creating a production Supabase project;
- modifying the current production Worker;
- merging PR #174 or PR #176;
- marking PR #176 ready for review;
- connecting Gmail, Google Calendar or AI providers;
- using real client data;
- sending test data to the production Telegram destination.

Every hosted-resource creation step below is marked as an owner action and must
not be executed until separately authorised.

## 2. Verified repository baseline

The fifth GitHub Actions run against
`f383f3c9ab6d39710e80b769ff4c9b1446b622b8` completed successfully:

| Check | Result |
|---|---|
| Static Validation | Passed |
| Public site and Worker | Passed |
| Private CRM | Passed |
| Clean Supabase start | Passed |
| Canonical reset without development seed | Passed |
| Migrations | `0001` through `0012` applied |
| Canonical pgTAP | 7 files, 478 tests, PASS |
| Database lint | `public` and `crm_private`, no errors |
| Dependency audits | 0 vulnerabilities |
| Secret scan | Passed |
| Deployment | Not performed |

This baseline proves the repository against a clean temporary Supabase stack in
CI. It does not replace hosted staging validation with real Supabase Auth,
PostgREST, Storage APIs, signed URLs and Cloudflare routing.

## 3. Approved staging decisions

| Item | Approved staging value |
|---|---|
| Supabase organisation | Existing organisation intended for the future Vishar CRM |
| Supabase project | `vishar-crm-staging` |
| Supabase region | West Europe (London), `eu-west-2` |
| Cloudflare account | Existing account managing `vishartattoo.com` |
| Booking Pages project | `vishar-booking-staging` |
| CRM Pages project | `vishar-crm-staging` |
| Preview Worker | `tattooai-preview` |
| Preview Worker custom domain | `intake-staging.vishartattoo.com` |
| Currency | `GBP` |
| Retention | Disabled, durations remain `null` |
| Manager activity-log access | Current limited policy |
| Read-only file access | No signed URL minting or file opening |
| Gmail | Disconnected |
| Google Calendar | Disconnected |
| AI integration | Disconnected |
| Telegram | Separate staging bot and private staging chat |
| Data | Synthetic only |
| Staging lifetime | Keep until E2E completion, then destroy after separate confirmation |

Emails, passwords, project refs, keys, access tokens, bot tokens and chat IDs are
runtime secrets. They must not be committed or copied into test evidence.

## 4. Environment topology and trust boundaries

```text
Owner-only booking preview
        |
        | exact HTTPS Origin
        v
intake-staging.vishartattoo.com
        |
        | staging-only Supabase secret
        v
vishar-crm-staging Supabase
        |-- private crm-files bucket
        |-- Postgres/RLS/activity/outbox
        `-- staging Telegram bot/chat

Owner-only CRM preview
        |
        | publishable key + Supabase Auth session
        v
vishar-crm-staging Supabase
```

Rules:

- the preview Worker never receives a production Supabase URL or key;
- the staging booking origin is the only value in preview `ALLOWED_ORIGINS`;
- the CRM origin is not in the Worker allow-list because the CRM does not call
  the public intake endpoint;
- production apex and `www` origins are not in the preview allow-list;
- no credential is reused between staging and production;
- CORS and `Origin` checks are not authentication and can be spoofed by a
  non-browser client; staging remains safe only because it is temporary,
  rate-limited, isolated and contains synthetic data.

## 5. Resource inventory and evidence identifiers

Complete this table during authorised setup. Do not record secrets.

| Field | Value |
|---|---|
| Creation time UTC | |
| Operator | |
| Approved source SHA | `f383f3c9ab6d39710e80b769ff4c9b1446b622b8` |
| Supabase project ref suffix | |
| Supabase region | `eu-west-2` |
| Worker deployment/version | |
| Worker custom domain | `intake-staging.vishartattoo.com` |
| Booking origin | |
| CRM origin | |
| Booking Pages deployment ID | |
| CRM Pages deployment ID | |
| Telegram destination label | |
| Teardown approval | |
| Teardown completed UTC | |

## 6. Secure prerequisites

Before creating anything:

```bash
git rev-parse HEAD
git status --short
git diff --check
```

The first command must return the approved SHA. The checkout must be clean.
Build from that exact source state without merging.

Required tools:

- Supabase CLI version pinned by the repository CI, currently `2.110.0`;
- Node version supported by the lockfiles;
- Wrangler from the repository dependency set;
- access to the selected Supabase organisation and Cloudflare account;
- a password manager for all generated credentials.

Secret-handling rules:

- enter secrets only through dashboard fields or interactive secret prompts;
- do not place secrets on command lines that are retained in shell history;
- never commit `.env`, Supabase credentials, JWTs or Telegram values;
- do not take screenshots that display keys;
- do not store signed URLs in evidence;
- remove temporary environment files and shell variables after testing.

## 7. Create the staging Supabase project

**DO NOT RUN UNTIL AUTHORISED.**

1. Create only `vishar-crm-staging`.
2. Select West Europe (London), `eu-west-2`.
3. Record the project ref, URL and keys in the password manager.
4. Enable email/password authentication.
5. Disable public sign-up. Staff users are created manually by the owner.
6. Do not create tables, functions, policies or buckets manually.
7. Do not create a production project during this phase.
8. Confirm the new project contains no CRM application tables before migrations.

## 8. Apply migrations without seed data

Link only to the staging project:

```bash
supabase link --project-ref <STAGING_PROJECT_REF>
supabase db push --dry-run
supabase db push
```

Hard prohibitions:

- do not use `--include-seed`;
- do not run `supabase db reset --linked`;
- do not execute `supabase/seed.sql` manually;
- do not edit an applied migration.

Verify after the push:

```sql
select version
from supabase_migrations.schema_migrations
order by version;

select count(*) from public.profiles;
select count(*) from public.clients;
select count(*) from public.enquiries;
select count(*) from public.activity_log;

select id, public
from storage.buckets
where id = 'crm-files';

select retention_enabled,
       enquiry_retention_days,
       project_retention_days,
       activity_retention_days
from public.system_settings;
```

Expected:

- exactly migrations `0001` through `0012` are recorded;
- the four CRM tables above are empty;
- no `.test` email or development fixture UUID exists;
- `crm-files` exists with `public = false`;
- retention is disabled and all retention durations are `null`.

## 9. Hosted database test gate

Run before owner bootstrap and before creating test profiles:

```bash
supabase test db --linked
supabase db lint --linked \
  --schema public,crm_private \
  --level error \
  --fail-on error
```

Expected:

- all 7 pgTAP files pass;
- all 478 assertions pass;
- lint reports no errors;
- test transactions leave no profiles, enquiries, manifests or Storage objects.

Any failure is a hard stop. Do not continue by weakening RLS, ACLs or Storage
policies.

## 10. Authentication identities

Create five synthetic Auth users manually. Their emails are entered during setup
and are not written into the repository or public evidence.

| Identity | Expected profile state |
|---|---|
| owner | active `owner` |
| manager | active `booking_manager` |
| reader | active `read_only` |
| disabled | initially active `booking_manager`, then deactivated through owner RPC |
| unauthorised | Auth user with no `profiles` row |

Passwords must be unique and generated by the password manager.

## 11. Owner bootstrap

1. Create the owner Auth user in the Supabase dashboard.
2. Run once in SQL Editor:

```sql
select public.bootstrap_owner_by_email(
  'OWNER-EMAIL-HERE',
  'Vladimir Vishar'
);
```

3. Repeat the exact call and confirm it is idempotent.
4. Confirm exactly one active owner exists.
5. Confirm one `owner.bootstrapped` activity event was written.
6. Confirm application roles cannot call either bootstrap function:

```sql
select
  has_function_privilege('anon',
    'public.bootstrap_owner(uuid,text)', 'execute') as anon_can_run,
  has_function_privilege('authenticated',
    'public.bootstrap_owner(uuid,text)', 'execute') as authenticated_can_run,
  has_function_privilege('service_role',
    'public.bootstrap_owner(uuid,text)', 'execute') as backend_can_run;
```

All values must be `false`.

## 12. Staging-only staff profile provisioning

The current PR does not implement production staff provisioning. For staging
only:

1. Create the manager, reader, disabled and unauthorised Auth users in the
   dashboard.
2. Insert profile rows through SQL Editor only for manager, reader and disabled.
3. Resolve UUIDs from `auth.users`; do not hard-code UUIDs or emails in a file.
4. Leave the unauthorised user without a profile.
5. Sign in as owner and deactivate the disabled profile through the normal owner
   RPC so the audited production path is exercised.
6. Verify effective role access through `crm_private.profile_access`.

The one-time SQL must not be committed, added to a migration or added to the
seed. This is not an approved production provisioning workflow.

## 13. Private Storage validation

Verify:

- `crm-files` is private;
- public object URLs do not work;
- anonymous listing returns no data or is denied;
- JPEG, PNG and WebP within the configured limit are accepted;
- unsupported MIME, extension, magic bytes and oversized files are rejected;
- a forged object path is not visible;
- manager can access only manifest-backed objects allowed by policy;
- manager cannot delete objects;
- read-only cannot read file metadata or mint signed URLs;
- owner deletion is tested only through the Storage API;
- direct SQL deletion from `storage.objects` is never used.

Signed URL test:

1. Mint a short-lived URL as owner and manager.
2. Confirm immediate access.
3. Confirm access fails after expiry.
4. Confirm read-only cannot mint a URL.
5. Do not copy the URL into evidence.

## 14. Preview Worker custom domain and rate limiting

The approved endpoint is:

```text
https://intake-staging.vishartattoo.com
```

Use a Cloudflare Worker Custom Domain under the existing
`vishartattoo.com` zone so zone-level WAF and rate-limiting controls can protect
the endpoint.

### 14.1 workers.dev bypass prevention

The current repository configuration still has:

```toml
[env.preview]
workers_dev = true
```

Before any hosted test traffic, a separate reviewed configuration change must
set preview only to:

```toml
[env.preview]
workers_dev = false
```

The top-level production setting must not change.

After deployment, verify:

- `intake-staging.vishartattoo.com` reaches the preview Worker;
- `tattooai-preview.<account>.workers.dev` is unavailable;
- any explicitly enabled Worker Preview URLs are also disabled.

If any alternate Worker URL remains reachable, staging stops because it would
bypass zone WAF controls.

### 14.2 Access placement

Apply owner-only Cloudflare Access to:

- the booking Pages project;
- the CRM Pages project.

Do not put Access directly in front of the Worker endpoint. The browser booking
page performs a cross-origin request and no Access service-token flow is
implemented.

### 14.3 WAF and rate-limit plan handling

Inspect the actual Cloudflare zone plan before creating rules.

When rate-limit expressions can match host, scope the rule to:

- host `intake-staging.vishartattoo.com`;
- method `POST`;
- the exact intake path;
- client IP as the counting characteristic;
- a conservative per-minute threshold suitable for manual staging tests.

When the available rate-limit expression cannot match host:

1. use a unique staging-only path, for example
   `/__vishar-staging-intake-2026`;
2. add a zone WAF custom rule on the staging hostname that blocks all other
   paths and all methods except `POST` and `OPTIONS`;
3. apply the available rate-limit rule to the unique path;
4. record that the path is routing scope, not authentication.

No Worker Rate Limiting API binding or application-code change is approved for
this staging phase.

## 15. Preview Worker configuration

**DO NOT DEPLOY UNTIL AUTHORISED.**

Required preview variables:

```text
VISHAR_ENVIRONMENT=preview
SUPABASE_URL=https://<STAGING_PROJECT_REF>.supabase.co
ALLOWED_ORIGINS=https://<EXACT_BOOKING_STAGING_HOST>
```

Required preview secrets:

```text
SUPABASE_SECRET_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
```

Set secrets interactively:

```bash
wrangler secret put SUPABASE_SECRET_KEY --env preview
wrangler secret put TELEGRAM_BOT_TOKEN --env preview
wrangler secret put TELEGRAM_CHAT_ID --env preview
```

Before the allow-list is set, preview must fail closed. Confirm the configured
Supabase project ref is staging and the Telegram destination is the staging
chat before the first request.

## 16. Booking preview

1. Build from the approved SHA.
2. Copy the booking artifact into a temporary directory.
3. Set the `vishar-booking-endpoint` meta value in the temporary artifact to the
   exact staging Worker URL and path.
4. Remove any production fallback from the temporary artifact.
5. Do not modify or commit `booking/index.html` for this substitution.
6. Upload the artifact to `vishar-booking-staging` using Direct Upload.
7. Record the exact HTTPS origin.
8. Put that exact origin, and only that origin, into preview
   `ALLOWED_ORIGINS`.
9. Protect the Pages project with owner-only Cloudflare Access.
10. Confirm preview pages are not indexable or publicly browsable without
    Access.

## 17. CRM preview

Use an ephemeral environment file outside the repository:

```text
VITE_SUPABASE_URL=https://<STAGING_PROJECT_REF>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<STAGING_PUBLISHABLE_KEY>
```

Build:

```bash
cd admin
npm ci
npm run test
npm run typecheck
npm run build
```

Then:

- scan `admin/dist` for secret/service-role key patterns;
- upload `admin/dist` to `vishar-crm-staging` using Direct Upload;
- protect the Pages project with owner-only Cloudflare Access;
- verify owner, manager, reader, disabled and no-profile sign-in behaviour.

No database password, secret key or Telegram value may appear in the CRM build.

## 18. Exact origin matrix

| Request Origin | Preview Worker result |
|---|---|
| Exact booking staging origin | Accepted when request is otherwise valid |
| CRM staging origin | Rejected |
| `https://vishartattoo.com` | Rejected |
| `https://www.vishartattoo.com` | Rejected |
| Arbitrary Pages preview origin | Rejected |
| Missing `Origin` | Rejected |
| HTTP origin | Rejected |
| Origin containing path/query/trailing slash in configuration | Invalid configuration, fail closed |

Do not probe or modify the current production Worker during staging. The reverse
check, production rejecting staging origin, remains a production release gate.

## 19. Hosted E2E matrix

Every case uses synthetic data and records the evidence fields in section 21.

| ID | Case | Expected result |
|---|---|---|
| E01 | Valid enquiry with 1 image | One complete enquiry, one ready manifest/object, one notification attempt |
| E02 | Valid enquiry with 2 images | One complete enquiry, two ready manifests/objects |
| E03 | Valid enquiry with 3 images | One complete enquiry, three ready manifests/objects |
| E04 | Exact retry after completion | Same reference, replayed response, no duplicate rows/files/Telegram |
| E05 | Exact retry while incomplete | Existing intake resumes safely and completes once |
| E06 | Same key, changed text field | Stable 4xx conflict, original record unchanged |
| E07 | Same key, changed file | Stable 4xx conflict, original record unchanged |
| E08 | Unsupported file MIME | Rejected before durable completion |
| E09 | MIME/extension/magic mismatch | Rejected |
| E10 | Oversized file | Rejected |
| E11 | Failure on second upload | First confirmed object retained; intake incomplete/failed; no Telegram |
| E12 | Failure on third upload | Earlier confirmed objects retained; no false completion |
| E13 | Ambiguous Storage acknowledgement | Object not deleted; exact retry reconciles safely |
| E14 | Stale incomplete intake | Reconciliation lists it and follows wait/resume/abandon contract |
| E15 | Telegram provider rejection | Durable success remains success; outbox records failure |
| E16 | Telegram network loss | Durable success remains success; retry metadata preserved |
| E17 | Owner CRM access | Operational and finance access allowed by policy |
| E18 | Manager CRM access | Operational access, no finance/profile management/delete |
| E19 | Read-only CRM access | Permitted reads only, no writes/files/finance |
| E20 | Disabled user with old session | New reads and writes denied immediately |
| E21 | Auth user without profile | No-access state; no CRM data |
| E22 | Anonymous PostgREST | CRM tables and RPCs unavailable |
| E23 | Direct authenticated table writes | INSERT/UPDATE/DELETE denied as specified |
| E24 | Backend direct table attempt | Business tables remain closed; narrow RPC surface only |
| E25 | Forged Storage path | No object or metadata visibility |
| E26 | Signed URL expiry | Immediate access, then failure after TTL |
| E27 | Read-only signed URL request | Denied |
| E28 | Origin matrix | Only exact booking staging origin accepted |
| E29 | Disconnected integrations | Gmail, Calendar and AI remain inactive and make no network calls |

## 20. Temporary hybrid fault-injection harness

E11–E13 cannot be produced reliably through the ordinary hosted form. Use a
throwaway local harness that:

- lives outside the repository or in an ignored temporary directory;
- imports the existing `handleEnquiryIntake` implementation;
- connects only to the real staging Supabase and Storage endpoints;
- rejects any production URL or project ref before running;
- injects a controlled response only for the selected Nth provider request;
- uses a real first upload before returning a controlled `503` for the next
  request in partial-failure cases;
- permits a real provider response to complete, then simulates a lost response
  for the ambiguous acknowledgement case;
- performs database and Storage assertions after each run;
- receives secrets only through runtime environment variables;
- is deleted after testing;
- is never committed and introduces no production fault hook.

## 21. Evidence template

```text
Case ID:
Timestamp UTC:
Source SHA:
Operator:
Booking origin:
Worker deployment/version:
Supabase project ref suffix:
HTTP status/result:
Reference number:
Enquiry count:
Manifest states:
Storage object count:
Outbox state:
Role/JWT type:
Expected result:
Actual result:
PASS / FAIL:
Cleanup completed:
Notes:
```

Never record:

- JWTs, passwords or API keys;
- signed URLs;
- full project ref in a public report;
- real emails or client PII;
- Telegram bot token or chat ID.

## 22. Failure handling and rollback

- migration failure on an empty staging project: stop, preserve safe error
  evidence, and recreate the staging project only after approval;
- hosted E2E failure: keep staging intact for diagnosis and retest;
- never edit an applied migration;
- never create a down migration for convenience;
- never use production as a fallback environment;
- do not delete failed evidence rows until safe evidence is collected;
- no staging result authorises merge or production deployment.

## 23. Complete teardown

Teardown is destructive and requires separate confirmation.

1. Confirm all required E2E cases are complete.
2. Export only sanitised evidence.
3. Delete the booking Pages project.
4. Delete the CRM Pages project.
5. Remove the Worker Custom Domain.
6. Delete `tattooai-preview` and its alternate preview URLs.
7. Remove preview Worker secrets and variables.
8. Delete the `vishar-crm-staging` Supabase project entirely.
9. Revoke temporary Supabase and Cloudflare access tokens.
10. Delete the staging Telegram bot and clear/delete the private staging chat.
11. Delete the temporary harness, build artifacts, `.env` files and local
    Supabase link metadata.
12. Remove any residual staging DNS record and generated certificate if it was
    not removed with the Custom Domain.
13. Verify the production Worker, production Pages project and production data
    were unchanged.

Deleting individual test rows is not complete cleanup because `activity_log` is
append-only. Complete cleanup requires deleting the whole staging project.

## 24. Exit criteria

Staging is complete only when:

- every mandatory E2E case has PASS evidence;
- every discovered code fix is rerun through CI and staging;
- there are no unresolved critical or high findings;
- preview `workers.dev` and other bypass URLs are disabled;
- production remained unchanged;
- the owner explicitly chooses teardown or temporary retention of staging.

A successful staging run does not by itself authorise ready-for-review, merge or
production deployment.
