# CRM Architecture and Supabase Foundation Plan

Audit date: 28 July 2026

Source implementation: `agent/london-booking-transition-draft` at `2c39326`

Scope: repository and PR inspection only. No production code, deployment, Supabase project, Gmail account, Google Calendar, or production data was changed.

## 1. Executive summary

The existing London booking transition is a sound starting point for the public booking experience, but it is not yet a durable booking system. The static `/booking/` page posts a JSON body to the existing Cloudflare Worker. Images are converted to base64 in the browser, the Worker validates a limited set of fields, and the submission and files are forwarded to Telegram. Nothing is persisted, requests have no idempotency key, CORS does not reject disallowed origins, and anti-spam is limited to a honeypot and a client-supplied elapsed-time value.

The final architecture should keep the existing form and Cloudflare Worker, use Supabase Postgres as the system of record, and use one private Supabase Storage bucket for all client files. Telegram becomes a best-effort notification after the database commit. The CRM should be a separate mobile-first application deployed at `admin.vishartattoo.com`, authenticated with Supabase Auth and protected by database RLS; Cloudflare Access may be added as defence in depth, not as the authorisation system.

Implementation must be incremental. First add an atomic Postgres intake RPC, schema, RLS, storage policies, and database tests. Then change only the `tattoo-enquiry` path to multipart intake and durable persistence while preserving the existing AI, lead, and book-waitlist routes. The CRM follows only after the foundation and intake path pass failure-mode tests. Gmail, Calendar, and AI tools are later provider/API layers and are not prerequisites for saving an enquiry.

### Decisions made

- **System of record:** Supabase Postgres; Telegram is notification only.
- **File store:** one private Supabase Storage bucket named `crm-files`; do not add R2 in v1 because it would add policy, cleanup, credentials, and operational complexity without an identified requirement that Supabase Storage cannot meet.
- **Upload transport:** browser-to-Worker `multipart/form-data`. The Worker streams/parses up to three 4 MB files, validates them, creates the database record, then uploads to Supabase Storage. This removes base64's roughly 33% size overhead and duplicate browser memory use without exposing storage credentials or adding a multi-step UX. Direct signed uploads can be reconsidered only if Worker request limits or measured mobile reliability require it.
- **Trusted persistence boundary:** a narrowly scoped Supabase Postgres RPC called by the Worker with `service_role`; the browser receives neither `service_role` nor direct arbitrary-write access.
- **Idempotency:** a browser-generated UUID persisted in `sessionStorage` until a successful response, backed by a unique `enquiries.idempotency_key`. The intake RPC locks/claims the key and returns the existing enquiry for exact retries.
- **Client matching:** deterministic normalised email and E.164-like phone fields. Match by verified normalised email first, then normalised phone; never match on name. If email and phone resolve to different clients, do not merge automatically—create a reviewable conflict and attach the enquiry according to a documented deterministic rule.
- **Human-readable reference:** generated in Postgres from a sequence as `ENQ-YYYY-NNNN`; uniqueness comes from a unique constraint, not from application-side counting.
- **Activity log:** append-only. Database triggers cover sensitive state changes; service functions add contextual events. Clients cannot update or delete log rows.
- **Money:** `numeric(12,2)` plus a configurable three-letter currency (default must be an explicit owner decision at bootstrap); never floating point.
- **Retention:** configuration is stored but no retention duration is invented. Automatic deletion remains disabled until the owner records a policy.

## 2. Findings and current constraints

### Critical issue A — no durable storage

- **Severity:** Critical
- **Area:** Reliability / Data integrity
- **Files:** `workers/tattooai.js:18-164`
- **Evidence:** the booking handler builds a Telegram message, sends it, then uploads each reference to Telegram. There is no database or object-storage call. The comment explicitly states that nothing is stored.
- **Impact:** Telegram is the only copy; there is no client/enquiry card, status workflow, assignment, audit history, recovery path, or authoritative record.
- **Fix:** implement the Supabase schema and atomic intake RPC before changing success semantics. Return success once the enquiry record exists; Telegram/email failures must not turn a committed enquiry into a failed submission.
- **Effort:** Large

### Critical issue B — duplicate submissions are possible

- **Severity:** Critical
- **Area:** Data integrity
- **Files:** `booking/index.html:135-204`, `workers/tattooai.js:18-164`
- **Evidence:** the form creates no request identifier and the Worker has no uniqueness check. Disabling the button prevents only a second click in the same page execution; network retries or refreshed submissions can duplicate an enquiry.
- **Impact:** duplicate clients, enquiries, notifications, and later calendar/payment actions.
- **Fix:** UUID idempotency key plus a database unique constraint and atomic claim/return-existing RPC. A retry response must return the same `enquiry_id` and `reference_number`.
- **Effort:** Medium

### Critical issue C — origin allow-list is not enforcement

- **Severity:** High
- **Area:** Security
- **Files:** `workers/tattooai.js:370-389` (helper locations may move as the file changes)
- **Evidence:** a disallowed request is still processed; it merely receives `Access-Control-Allow-Origin: https://vishartattoo.com`. CORS is a browser response-reading control, not request authentication or CSRF/abuse protection.
- **Impact:** arbitrary scripts and non-browser clients can invoke the public endpoint and consume Telegram/Workers AI resources.
- **Fix:** reject booking requests whose `Origin` is absent or outside the exact production/approved-preview allow-list, with a separately controlled test mode. Add rate limiting at Cloudflare (WAF/rate-limit rule or Durable Object/KV design) and server-side bot verification if abuse warrants Turnstile.
- **Effort:** Medium

### Critical issue D — file validation trusts metadata and base64 size

- **Severity:** High
- **Area:** Security / Reliability / Performance
- **Files:** `booking/index.html:107,166-204`, `workers/tattooai.js:85-100,141-159`
- **Evidence:** validation trusts browser-provided MIME, checks base64 string length rather than decoded byte length, and does not inspect magic bytes. The extension is derived by a helper but content and declared type are not proven consistent.
- **Impact:** excessive request/memory overhead, mislabeled content, and unsafe or corrupt objects entering storage.
- **Fix:** multipart upload; enforce 1–3 files, decoded bytes ≤4 MB each, allow-listed extension, allow-listed declared MIME, matching magic bytes, random server-side filename, and a path derived only from server-created UUIDs. Optionally perform asynchronous malware scanning before files become viewable.
- **Effort:** Medium

### Critical issue E — no transaction boundary or compensating cleanup

- **Severity:** High
- **Area:** Reliability
- **Files:** `workers/tattooai.js:102-164`
- **Evidence:** current ordering is Telegram text followed by independent file uploads; partial failure is reported only as a warning and there is no retry queue or durable state.
- **Impact:** the future database and Storage operations could diverge unless states and cleanup are explicit.
- **Fix:** create the enquiry and expected file manifests atomically in Postgres; upload each object; mark each manifest uploaded. Compensate only when the database has definitively rejected the mark; retain an object after a 5xx or lost response because the mark may already have committed. Mark the enquiry `intake_failed`/record an operational failure without exposing it to the normal new queue, and return a retryable error. A future scheduled object sweep must clean proven orphans; it is not implemented in this PR. Telegram and email are outbox jobs after persistence.
- **Effort:** Large

### High issue F — anti-spam and rate limiting are insufficient

- **Severity:** High
- **Area:** Security / Cost control
- **Files:** `booking/index.html:110,135`, `workers/tattooai.js:20-29`
- **Evidence:** the honeypot and `startedAt` are client-controlled. No IP/request rate control or Turnstile token is present.
- **Impact:** spam, storage exhaustion, Telegram flooding, and Worker cost/resource abuse.
- **Fix:** retain the honeypot as a low-cost signal, add Cloudflare rate limiting keyed by a privacy-preserving IP hash, body-size rejection before parsing, and optionally Turnstile with server verification. Never log raw IP long-term.
- **Effort:** Medium

### High issue G — privacy notice describes forwarding, not the planned CRM

- **Severity:** High
- **Area:** Privacy / Compliance
- **Files:** `privacy/index.html:105-132`
- **Evidence:** the notice says Cloudflare forwards data to the artist and names Telegram, but does not describe durable Supabase database/storage processing, staff access, email/calendar providers, configurable retention, or the full operational purposes of the CRM.
- **Impact:** once persistence is enabled, the public explanation would no longer match processing reality.
- **Fix:** update immediately before enabling persistence. Name provider categories and actual providers, data/file types, purposes, access/correction/deletion route, and that submission is not a confirmed booking. Do not publish a retention period until the owner decides it.
- **Effort:** Small

### High issue H — Worker responsibilities are coupled

- **Severity:** High
- **Area:** Maintainability / Reliability
- **Files:** `workers/tattooai.js`
- **Evidence:** booking, generic leads, book waitlist, Telegram transport, Workers AI prompts, validation, and response handling are in one fetch handler.
- **Impact:** CRM changes can regress existing AI/lead routes; unit testing and provider substitution are difficult.
- **Fix:** keep a thin router and extract `cors`, `rate-limit`, `validation`, `supabase`, `storage`, `activity`, `telegram`, `outbox`, and `errors` modules. Preserve public response contracts with contract tests.
- **Effort:** Medium

### High issue I — deployment is manual but has no environment separation or migration gate

- **Severity:** High
- **Area:** DevOps
- **Files:** `.github/workflows/deploy-tattooai.yml:1-32`, `wrangler.toml:1-7`, `docs/tattooai-deploy.md:1-32`
- **Evidence:** deployment is manual, which is appropriate for this draft, but the single Wrangler environment has no staging/production split, database migration check, booking-flow tests, or explicit secret presence check beyond runtime failures.
- **Impact:** schema/code drift and accidental connection to the wrong Supabase project.
- **Fix:** add a separate `preview` environment while preserving the existing
  top-level `tattooai` Worker as production, pin project URLs per deployment as
  non-secret variables, keep all keys as Worker secrets, run
  unit/static/database tests before a manual deploy, require an environment
  approval, and publish only on a separate owner-approved action.
- **Effort:** Medium

### Medium constraints

- `scripts/test-booking-flow.mjs` covers preferred-contact validation, full success, and partial Telegram image failure, but not malformed JSON, CORS rejection, body limits, MIME signatures, persistence, idempotency, database/storage failures, or secret leakage.
- The Worker requires Telegram configuration before accepting a booking. In the target design Telegram must be optional after durable save.
- The public form does not capture UTM values, landing page, or referrer. These should be hidden request fields derived at submit time and length-limited server-side.
- There is no CRM app, Supabase directory, migration tooling, auth bootstrap, RLS test harness, email/calendar outbox, or AI-facing API in the branch.
- `admin.vishartattoo.com` DNS, Supabase project/region, custom SMTP, Gmail OAuth, Calendar OAuth, and owner identity are external decisions/actions and were not checked.
- Production Worker bindings, Cloudflare WAF rules, Telegram delivery, Supabase connectivity, Gmail, Calendar, and browser/mobile behaviour require credentials or production access; this audit makes no claim that they work.

## 3. Target component structure

```text
Public browser (/booking/)
  -> HTTPS multipart POST + idempotency key
Cloudflare Worker (public intake route)
  -> validation / anti-spam / rate limiting
  -> narrow Postgres intake RPC (backend secret only in Worker)
  -> private Supabase Storage upload
  -> durable outbox jobs
      -> Telegram notifier
      -> confirmation-email provider

CRM browser (admin.vishartattoo.com)
  -> Supabase Auth session (publishable key is public, never a backend secret)
  -> PostgREST/RPC guarded by RLS and active-profile checks
  -> Worker API for signed file URLs, privileged workflows, Gmail/Calendar

Scheduled/queue Worker
  -> retries outbox jobs with bounded exponential backoff
  -> reconciles incomplete uploads
  -> syncs confirmed sessions only with Google Calendar

AI client (ChatGPT/Claude)
  -> OAuth/API-token authenticated tool gateway
  -> named, schema-validated tools only
  -> role/scope checks + field minimisation + activity log
  -> no SQL endpoint and no database/service credentials
```

### Proposed repository layout

```text
booking/index.html                 existing public UI; minimal transport/UTM/idempotency changes
workers/tattooai.js                compatibility router entry point
workers/lib/http.js                CORS, origin, body-size and structured responses
workers/lib/rate-limit.js          rate-limit adapter and anti-spam checks
workers/lib/validation.js          request and file validation
workers/lib/supabase.js            narrow REST/RPC client
workers/lib/storage.js             private upload/delete/signed-URL operations
workers/lib/activity.js            contextual audit writes
workers/lib/telegram.js            best-effort/outbox notification provider
workers/lib/email.js               provider interface; Gmail implementation later
workers/lib/calendar.js            provider interface; Google implementation later
workers/lib/logging.js             redacted structured operational logs
workers/routes/enquiries.js        intake orchestration
workers/routes/crm.js              privileged CRM workflow endpoints
workers/routes/ai-tools.js         allow-listed AI tool gateway
admin/                             mobile-first CRM application
supabase/config.toml               local development only, no secrets
supabase/migrations/               ordered SQL migrations
supabase/tests/                    pgTAP schema, RLS and workflow tests
tests/worker/                      Worker unit/contract/failure tests
docs/                              deployment and owner-run OAuth/bootstrap instructions
```

The precise admin framework should be chosen in the CRM phase after checking hosting constraints. A small TypeScript SPA is sufficient; avoid coupling the public static site build to the private application.

## 4. Database design and migration set

Use `uuid` primary keys (`gen_random_uuid()`), `timestamptz`, `citext` or explicit normalisation functions, `created_at/updated_at` triggers, foreign keys with restrictive deletion, and check constraints. All application tables live in `public`; internal helper functions must use a private schema, fixed `search_path`, and explicit grants.

### `0001_extensions_types.sql`

- Enable `pgcrypto` and `citext` if supported.
- Enums: `crm_role`, `enquiry_status`, `enquiry_file_category`, `project_status`, `deposit_status`, `session_status`, `payment_status`, `calendar_provider`, `outbox_kind`, `outbox_status`.
- Required enquiry statuses: `new`, `reviewing`, `waiting_for_client`, `accepted`, `declined`, `quote_sent`, `deposit_requested`, `deposit_paid`, `converted`, `closed`.
- Add central allowed-transition data/function rather than permitting arbitrary enum changes. Examples: `new -> reviewing|accepted|declined|closed`; `accepted -> quote_sent|deposit_requested|converted|closed`; closed/declined reopening is owner-only.

### `0002_profiles_clients.sql`

- `profiles`: requested fields; `id` references `auth.users(id)`; unique case-insensitive email; `is_active default true`.
- `clients`: requested fields plus server-maintained `email_normalized` and `phone_normalized`. Use partial unique indexes on non-null normalised values only after a deliberate duplicate-resolution policy is confirmed. Until then, use non-unique lookup indexes and make conflict handling explicit in the intake RPC.
- Functions `normalize_email(text)` and `normalize_phone(text)` must be deterministic and tested. Email normalisation should lowercase/trim only; do not rewrite provider-specific dots or plus aliases. Phone normalisation should preserve a leading country code and reject ambiguous values rather than guessing a country.

### `0003_enquiries_files.sql`

- `enquiries`: all requested fields plus `idempotency_key uuid not null unique`, `referrer text`, `intake_state`, and optional `intake_error_code` (never raw private payload).
- `reference_number text not null unique`; generated by a locked database function using a global sequence and UTC year.
- Indexes: `(status, created_at desc)`, `(assigned_to, status, last_action_at)`, `(client_id, created_at desc)`, UTM/source reporting indexes only when query evidence requires them.
- `enquiry_files`: requested fields; unique `(enquiry_id, storage_path)`; positive file size; allow-listed MIME constraint; storage path ownership checked by a trigger/helper. Add `upload_state` and optional checksum to reconcile cross-service uploads.

### `0004_projects_sessions.sql`

- `projects`: requested fields; unique `enquiry_id` so conversion cannot create two projects; money checks `>= 0`; `estimated_sessions > 0`; hours `> 0`; explicit `currency` decision/config.
- `sessions`: requested fields; `end_at > start_at`; non-negative price/hours; unique partial index on `(calendar_provider, calendar_event_id)` when event ID is non-null.
- Calendar eligibility function: only the explicitly defined confirmed session status may enqueue create/update. Draft/proposed sessions never create events. Cancellation enqueues cancellation only when an event ID exists.

### `0005_activity_outbox_notes.sql`

- `activity_log`: requested foreign keys, `metadata jsonb default '{}'`, append-only policies, indexes by each entity and `created_at desc`. Avoid raw message/file content in metadata.
- Add `internal_notes` rather than overloading activity summaries; notes have author, entity link, body, timestamps, and no hard delete for managers.
- Add `email_messages` for confirmation records and human-reviewed drafts (`draft|approved|queued|sent|failed|cancelled`), provider IDs, recipient relation, subject/body, creator/approver, and timestamps. AI output can only create `draft`.
- Add `integration_outbox` with unique dedupe key, kind, entity IDs, redacted payload, status, attempts, `next_attempt_at`, last safe error code, and lease fields. This supports Telegram, allowed automatic email, and Calendar retries without Make.
- Add `follow_ups` for due/complete/cancelled actions powering the dashboard and AI tool.

### `0006_functions_triggers.sql`

- `is_active_user()`, `current_crm_role()`, and role predicates reading `profiles` by `auth.uid()`.
- `set_updated_at()` and touch `last_action_at` functions.
- Append-only audit triggers for enquiry status/assignment, contact changes, projects, sessions, deposit changes, user deactivation, and file metadata changes.
- Security-definer functions must set `search_path`, revoke public execute, validate role and input, and expose only narrow operations: intake, status transition, assignment, conversion, session scheduling, draft creation, and user deactivation.
- `create_enquiry_intake(...)` performs client lookup/create, enquiry insert, expected file manifests, creation activity, and outbox inserts in one database transaction. It returns only IDs/reference and whether the request was replayed.

### `0007_rls.sql`

- Enable and force RLS on every CRM table.
- Authenticated access always requires a matching active `profiles` row. Deactivation therefore invalidates database access even if an old JWT remains unexpired.
- Do not grant table-level delete for business records to booking managers/read-only. Prefer archive/cancel functions.
- Restrict finance columns using owner-only views/RPCs or separate finance tables; table RLS alone cannot hide individual columns from a manager who may select the row.

### `0008_storage.sql`

- Insert private bucket `crm-files` with allowed MIME types and size limit; never mark public.
- Policies on `storage.objects` require active role, bucket match, and a path that maps to an entity the user may read/write.
- Managers may read/upload operational files but not bulk-list the bucket; read-only may view through short-lived signed URLs only if explicitly allowed. Only owner/backend may delete objects.
- Service backend writes canonical paths:
  - `clients/{client_id}/enquiries/{enquiry_id}/references/{file_id}.{ext}`
  - `clients/{client_id}/projects/{project_id}/designs/{file_id}.{ext}`
  - `clients/{client_id}/projects/{project_id}/sessions/{file_id}.{ext}`
  - `clients/{client_id}/projects/{project_id}/healed/{file_id}.{ext}`

### `0009_bootstrap_owner.sql`

- Do **not** commit an owner email or password.
- Provide an idempotent owner promotion function or documented SQL invoked once after the owner signs up, checking an explicit UUID/email parameter and then revoking bootstrap execution.
- Add a test-only seed under local Supabase configuration; production bootstrap is a manual owner action and is recorded in `activity_log`.

### `0010_retention_settings.sql`

- `system_settings` owner-only table with a retention-policy JSON schema/version, `enabled=false`, and null durations initially.
- Store the owner decision date/actor. No scheduled deletion runs while disabled.
- Later retention jobs must support legal/operational holds, dry-run reporting, audit events, and separate database/object cleanup.

## 5. RLS and capability matrix

`S` = select/view, `I/U` = controlled insert/update, `A` = archive or workflow RPC, `—` = denied. Every cell also requires `profiles.is_active = true`.

| Resource/capability | Owner | Booking manager | Read-only | Public browser | Trusted Worker |
|---|---|---|---|---|---|
| Profiles | S/I/U, roles, deactivate | own profile S | own profile S | — | bootstrap/admin route only |
| Clients | S/I/U/A, restore | S/I/U contacts, no hard delete | S | — | intake RPC only |
| Enquiries | S/I/U/A/export | S/I/U via transitions/assignment | S | — | intake RPC only |
| Enquiry files | S/upload/delete/sign | S/upload/sign; delete via controlled action | view only if policy permits | — | upload/cleanup |
| Projects | S/I/U/A, finance | S/I/U operational data; finance via limited functions | S excluding restricted finance | — | narrow workflows |
| Sessions | S/I/U/A, finance | S/I/U operational data | S excluding restricted finance | — | Calendar workflow |
| Internal notes | S/I/U | S/I/U own/allowed | S only if owner permits | — | narrow workflows |
| Email drafts | S/I/U/approve/send | S/create/update drafts; no unreviewed personal send | S metadata if permitted | — | confirmation/outbox only |
| Follow-ups | S/I/U | S/I/U | S | — | scheduled jobs |
| Activity log | S/export; no mutation | limited S; no mutation | denied or owner-approved limited S | — | append only |
| Settings/secrets | S/U settings; secrets never returned | — | — | — | runtime secrets only |
| Bulk export | controlled + audited | — | — | — | owner-authorised job |
| AI tool reads | scoped/field-minimised | scoped/field-minimised | scoped read | — | gateway executes caller role |
| AI tool writes | allowed named tools | allowed named tools | — | — | gateway validates + audits |

RLS is necessary but not sufficient for column-level finance/PII minimisation. Withhold finance-column grants on the base tables, expose owner-filtered `security_barrier` views with explicit `SELECT`-only ACLs, and use narrow audited RPCs for writes. Never rely on hidden buttons.

## 6. Intake, idempotency, and failure flow

1. Browser creates a UUID and stores it in `sessionStorage`; it collects UTM parameters, `location.href` as `landing_page`, and `document.referrer` without visible fields.
2. Browser posts multipart form data to the Worker. The Worker rejects unknown origins, excessive `Content-Length`, invalid fields, more than three files, files over 4 MB, MIME/extension/signature mismatch, and anti-spam failures.
3. Worker creates a random request correlation ID, emits allow-listed redacted log fields, and calls `create_enquiry_intake` with metadata and expected file descriptors. The database transaction finds/creates the client, creates the enquiry and pending file rows, and writes `enquiry.created`. A repeated key with identical canonical content returns the same record; reusing a key with different content is rejected.
4. Only after the main record exists does the Worker upload objects to canonical private paths and mark file rows ready.
5. If an object upload or manifest mark fails, the Worker records a safe failure. It deletes an object only after a definitive 4xx manifest rejection; a 5xx or lost acknowledgement is retained because Postgres may already have committed `ready`. The same idempotency key can safely retry/upsert rather than create another enquiry. The browser sees a retryable non-success response; the record is not displayed as a complete `new` enquiry until files are ready.
6. Once all required files are ready, the Worker finalises intake and responds with `reference_number`. At this point the CRM shows the enquiry.
7. Finalisation enqueues Telegram only after persistence and ready file
   manifests. The current Worker attempts Telegram once and records the outcome
   in the outbox; its failure never changes the successful form response.
8. Reconciliation helpers can identify and mark abandoned pending intakes.
   No scheduler, automatic outbox retry drain, orphan-object sweep, or
   confirmation-email provider is connected yet.

Structured logs contain event name, request/correlation ID, enquiry UUID/reference, stage, duration, HTTP/provider status class, and safe error code. They must not contain idea text, names, emails, phone numbers, Instagram handles, image names/content, signed URLs, tokens, or provider response bodies that may echo PII.

## 7. Email, Calendar, and AI boundaries

### Email

- Provider-neutral interface: `createDraft`, `approveDraft`,
  `queueApproved`, fixed-copy `sendTransactional`, and `getStatus`.
- Automatically send only the owner-approved transactional templates in the specification. Store template/version and consent/legal basis as applicable.
- Estimate, extra-photo request, dates, quote, decline, and cover-up discussion are drafts requiring an authenticated human approval action.
- Gmail OAuth tokens are encrypted server-side secrets, never database/browser-readable. OAuth connection requires owner action and cannot be claimed complete during repository work.

### Calendar

- `sessions` is authoritative. An outbox dedupe key such as `calendar:create:{session_id}:{version}` prevents duplicates.
- Create an event only on transition to the defined confirmed status. Updates and cancellations use the stored provider/event ID and optimistic versioning.
- Provider results and safe error codes are activity events. OAuth connection and final calendar selection require owner action.

### AI tool gateway

- Expose only the named tools in the specification with JSON schemas, row limits, pagination, role checks, field projection, and per-tool rate limits.
- Authenticate the human/integration identity; propagate a caller identity into audit events. A gateway-held service credential may execute only narrow RPCs after its own authorisation; it is never disclosed.
- Before a gateway is connected, write tools require dedicated on-behalf-of
  audit semantics. The current staff RPCs do not yet attribute an action to
  both the AI and its authenticated human caller.
- `create_email_draft` can only create a draft. No arbitrary SQL, generic table endpoint, service key, bulk PII export, or unrestricted file URL tool is allowed.

## 8. Secrets and deployment strategy

### Required secrets (never commit)

- Worker: `SUPABASE_URL` (may be non-secret config), `SUPABASE_SECRET_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`; a future application-level IP limiter or Turnstile integration would add separately reviewed secrets.
- CRM browser: Supabase URL and publishable key only; these are identifiers, not authority, and remain constrained by RLS.
- Later Worker integrations: Gmail OAuth client secret + encrypted refresh token, Calendar OAuth client secret + encrypted refresh token, email signing/provider values if a separate transactional provider is selected, AI gateway token/OAuth signing keys.
- CI/deploy: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; Supabase access token/project/database credentials only in protected environment jobs if migrations are automated.

### Environments and order

1. Local Supabase and mocked Worker providers.
2. Separate staging Supabase project + preview Worker + non-production Telegram chat/test email/calendar.
3. Apply forward-only migrations to staging; run pgTAP, Worker contracts, RLS role tests, smoke tests, and secret scan.
4. Create a database backup/restore point and migration rollback/runbook. Prefer corrective forward migrations once production data exists.
5. Manual production migration action with owner approval.
6. Manual Worker/CRM deploy with environment approval; architecture and foundation work must not trigger a production action.
7. Post-deploy synthetic intake using clearly marked test data, then verify database row, private file, notification, email event, CRM access, and cleanup.

This architecture document does not authorise a merge or deployment. Production migration, OAuth and deployment remain separate owner-approved actions.

## 9. Phased implementation checklist and patch plan

### Phase 1 — Audit and design

- [x] Inspect the source booking implementation and establish the base commit.
- [x] Inspect `/booking/`, Worker, booking tests, deployment workflow/configuration, and privacy notice.
- [x] Record component design, schema/migrations, RLS matrix, storage/error/idempotency/deployment strategies, secrets, and external blockers.
- [ ] Owner decisions before production: Supabase organisation/project/region, owner auth identity, currency, retention policy, staff activity-log visibility, read-only file access, transactional email sender/provider, confirmed session status, and staging domains.

### Phase 2 — Supabase foundation

- Add migrations `0001`–`0010`, local config, private bucket policies, bootstrap instructions, and test-only fixtures.
- Add pgTAP tests for constraints, normalisation, duplicate/conflict handling, idempotency, transitions, disabled users, every RLS role, finance column isolation, Storage path ownership, append-only activity, and calendar dedupe.
- Commit separately from Worker/form changes.

### Phase 3 — Worker durable intake

- Refactor without changing existing AI/lead/waitlist behaviour.
- Add multipart form transport, hidden attribution, persistent idempotency key, strict origin/body/file checks, intake RPC, private Storage upload, compensation/reconciliation, redacted logs, outbox, and Telegram best-effort delivery.
- Preserve 1–3 images at 4 MB each. Add tests for 1/2/3 files, oversized file, false MIME, Supabase failure, Storage partial failure, Telegram failure, retry/replay, conflicting client identifiers, and malformed requests.
- Update privacy notice in the same release that enables persistence, not before the system actually changes.

### Phase 4 — CRM MVP

- Build the separate mobile-first authenticated app with dashboard, enquiry/client/project/session views, follow-ups, signed-file viewing, allowed actions, and owner-only users/activity areas.
- Use workflow RPCs for status, assignment, conversion, session, deposit, notes, and deactivation. Add browser integration tests for owner, manager, read-only, and disabled accounts.
- Screenshot perceptible UI changes at mobile and desktop widths.

### Phase 5 — email and Calendar

- Implement outbox workers and confirmation template first; implement human-reviewed Gmail drafts next.
- Implement Calendar create/update/cancel only for confirmed sessions with dedupe and activity events.
- Stop at documented connection steps if owner OAuth approval is needed; do not simulate success.

### Phase 6 — AI gateway

- Implement the named minimal tools over narrow RPCs, with OAuth/token authentication, scopes, output minimisation, pagination, rate limits, write audit, and draft-only email generation.
- Contract-test role denials and ensure no credential/arbitrary SQL path appears in responses or bundles.

### Phase 7 — validation and controlled release

- Run existing site validation and booking tests after every phase.
- Add mobile browser/a11y checks, retry and duplicate tests, database/Storage/provider fault injection, role/RLS suite, bundle secret scan, Calendar lifecycle tests, and activity completeness checks.
- Production deployment, OAuth, real email/calendar, DNS, and employee account provisioning are owner/external actions. Stop and provide exact runbooks at those gates.

## 10. Commands run and evidence limits

- `find .. -name AGENTS.md -print`, `cat AGENTS.md`, and `cat .agents/skills/website-technical-audit/SKILL.md` — reviewed applicable audit-only instructions.
- `git status --short --branch`, `git branch -avv`, `git log --oneline --decorate`, and `git show --stat f82db15` — established local history and the reverted booking transition context.
- `git fetch https://github.com/vvetrov41-lgtm/Vishar-site.git agent/london-booking-transition-draft` — inspected the current source branch head without merging or deploying it.
- `rg --files`, targeted `rg -n`, and `nl -ba ... | sed -n ...` — inspected booking UI, Worker, tests, privacy notice, Wrangler config, deployment workflow, and deployment notes.
- `npm run test:booking` — booking flow tests passed before this report change.
- `npm run validate:site` — static validation passed before this report change.
- `node --check workers/tattooai.js` — Worker syntax passed before this report change.

No Lighthouse/Pagespeed, live mobile browser, production Worker binding, Cloudflare rate-limit/WAF, Supabase, Telegram, Gmail, Calendar, RLS, Storage, or OAuth test was performed. Those checks require later implementation, credentials, a browser environment, or explicit owner action; no production result is inferred.

## 11. Files reviewed

- `booking/index.html`
- `workers/tattooai.js`
- `scripts/test-booking-flow.mjs`
- `scripts/validate-site.mjs`
- `privacy/index.html`
- `wrangler.toml`
- `.github/workflows/deploy-tattooai.yml`
- `.github/workflows/static-validation.yml`
- `docs/tattooai-deploy.md`
- `package.json`
- `_headers`
- `AGENTS.md`
