# Implementation Plan: WhatsApp-linked Google Contact sync

## Specification

- Spec: `specs/whatsapp-google-contact-sync/spec.md`
- Target repository: `vvetrov41-lgtm/Vishar-site`
- Target branch/PR: `agent/whatsapp-google-contact-sync`, PR to `agent/platform-telegram-self-service`
- Exact target SHA: base `de181914ed5ad46c8303709748881f314bff6284`; feature head is reverified before each write stage.

## Constitution check

- Server authority -> WhatsApp webhook/browser values never select artist, client, Google account, or credentials. Trigger starts only after authoritative conversation linkage and the worker re-resolves database state.
- Authorization before capability -> the existing per-artist Google route/account pin remains authoritative; new service RPCs are backend-only.
- Ordered database evolution -> add the outbox enum value in a separate migration before any migration uses it; never alter production-applied migrations.
- Exact-head evidence -> implementation and completion claims use the exact feature head and exact-head GitHub Actions.
- Durable external delivery -> reuse `integration_outbox` leasing/retry semantics; Google failure cannot roll back communication state.
- Secret custody -> reuse encrypted Calendar OAuth token KV; no token enters Postgres/browser/logs.
- Deployment separate evidence -> code/CI do not prove People API availability, Google consent, Cloudflare deployment, or production behavior.
- Bounded/reversible rollout -> capability is disabled until the Google OAuth callback records Contacts permission; disconnect disables it.
- Specification traceability -> tests and rollout tasks map back to FR/SR/AC identifiers.

## Current-state evidence

- Entry points:
  - Production trigger `communication_conversations_auto_link_whatsapp` runs `crm_private.auto_link_whatsapp_conversation_client()` before insert/update and sets `client_id` + `link_state='linked'` only after a unique authoritative WhatsApp client match.
  - Existing after-link trigger `communication_conversations_enqueue_client_ai` proves a non-blocking post-link side-effect pattern.
  - Google OAuth is served by `workers/calendar-public-oauth.js` / `workers/calendar-oauth.js`; scheduled Google projection runs through the same Worker.
- Database objects/migrations:
  - `public.integration_outbox` already provides dedupe key, client/artist ownership, claim lease, retry count, backoff and terminal states.
  - `public.outbox_kind` currently ends with `meta_conversion`; no Contacts kind exists.
  - `public.resolve_outbox_route` maps Calendar kinds to the artist's enabled `calendar/google` integration.
  - Production migration head observed 2026-09-17: `20260915211500_crm_ai_multi_enquiry_operator_ack`.
  - Retained staging migration head observed 2026-09-17: `0044_monzo_payment_url_validator`, materially behind production.
- Authorization boundary:
  - Conversation/client workspace links are guarded server-side.
  - Google OAuth start requires Supabase actor session + manage-integrations capability; callback re-resolves capability and pins the Google account.
  - `resolve_outbox_route` is backend-only.
- Durable state boundary:
  - WhatsApp communication and client linkage commit independently from provider projections.
- Provider/integration path:
  - OAuth tokens live encrypted in `CALENDAR_OAUTH_TOKENS` KV under per-artist keys.
  - Current requested scopes are `openid email calendar.events calendar.calendars.readonly`; Contacts write scope is not yet requested.
  - Production Google Worker is `vishar-calendar-production` at `calendar.vishartattoo.com`. Repository production config is inert by default; fail-closed release workflow generates the enabled cron config.
- Existing tests:
  - Calendar worker/OAuth/rate-limit/production-config tests are part of `npm run test:worker`.
  - CRM admin tests/typecheck/build and Supabase pgTAP run in `CRM and booking validation`.
- Relevant ADR/docs:
  - `docs/ai/security-boundaries.md`, Calendar boundary.
  - `docs/ai/branch-workflow.md`.
  - `docs/gpt-actions/operator-parity.mjs`.
- Unknown or externally unverifiable state:
  - No Cloudflare connector is available in this ChatGPT environment. Actual Worker bindings/triggers must therefore be read back through the protected GitHub production workflow before/after deployment.
  - Whether Google People API is enabled in the current Google Cloud project is not yet proven. Provider acceptance will determine this without exposing credentials.
  - Device-level Google Contacts sync on the artist's iPhone cannot be server-controlled.

## Proposed design

Use the existing per-artist Google OAuth account as the credential authority, while adding an explicit Contacts-sync capability flag and a dedicated Contacts outbox kind. Do not create a second Google login or token store.

A post-link database trigger performs only a durable enqueue. The Google Worker later claims the job, re-reads current trusted client/conversation state, resolves the artist's existing Google integration, verifies Contacts permission in the encrypted token record, checks Google Contacts for an exact canonical E.164 match, and creates a contact only when none exists.

### Data model and migrations

- New/changed objects:
  - Add `google_contact_create` to `public.outbox_kind` in its own migration.
  - Add backend-only helper/trigger functions to enqueue a create job when a WhatsApp conversation becomes linked.
  - Add backend-only reconciliation function so granting Contacts permission can enqueue existing linked WhatsApp clients without fake traffic.
  - Add backend-only `claim_google_contact_outbox` and `record_google_contact_outbox_result` RPCs.
  - Extend `resolve_outbox_route` so `google_contact_create` resolves to the owning artist's existing Google Calendar integration.
  - Extend Calendar integration configuration with a boolean `google_contacts_sync` capability flag while preserving `oauth_scope='calendar.events'` compatibility expected by the existing Calendar route validator.
- Migration ordering/compatibility:
  - Migration A adds enum value only.
  - Migration B creates functions/index/trigger and replaces only the final effective `resolve_outbox_route` definition.
  - Both are additive; old Workers ignore the new kind.
- RLS/grants/RPC implications:
  - Claim/ack/capability RPCs are `SECURITY DEFINER`, service-backend-only, revoked from public/anon/authenticated and executable only by service role.
  - No generic table or arbitrary RPC proxy is added.
- Backfill or rollout needs:
  - No unconditional backfill during migration.
  - Successful OAuth consent for Contacts enables the capability and performs a bounded reconciliation of currently linked WhatsApp clients for that artist.

### Server/Worker layer

- Routes/handlers:
  - Existing Google OAuth start/callback/disconnect routes remain the only provider-consent surface.
  - Scheduled Worker adds a third drain beside appointment and availability drains.
- Validation:
  - Job must resolve to an active artist, non-archived client, valid E.164 `phone_normalized`, bounded non-empty name, and an existing linked WhatsApp conversation for the same artist/client.
  - Provider route must be Google, existing integration must be enabled, account pin must match encrypted token, and `google_contacts_sync` must be true.
  - Encrypted token scope must include `https://www.googleapis.com/auth/contacts`.
- Trusted routing/ownership resolution:
  - Outbox stores IDs only. Claim RPC returns the minimal current contact projection after authoritative joins.
- Idempotency/concurrency:
  - Stable dedupe key per artist/client prevents duplicate CRM jobs.
  - `FOR UPDATE ... SKIP LOCKED` leasing prevents concurrent processing.
  - People API `searchContacts` is warmed before exact E.164 comparison; exact canonical phone match is success-equivalent and never mutated.
  - Mutations for one Google account remain sequential.
  - Ambiguous/transient provider failures retry only through the outbox; every retry performs duplicate detection before create.

### CRM/UI layer

- User interactions:
  - Rename/copy the Calendar connection explanation so it truthfully states that the same Google authorization is also used to add linked WhatsApp clients to Google Contacts.
  - Reconnect action is used to grant the new Contacts permission.
- Authorization assumptions that MUST be enforced server-side:
  - UI copy does not enable capability; only successful OAuth callback + backend metadata update can do so.
- Loading/error states:
  - Existing connection status remains; Contacts permission/configuration errors use safe machine error codes and reconnect-required semantics where appropriate.

### External integrations

- Provider: Google People API v1.
- Credential custody: existing encrypted per-artist Google refresh-token envelope in Cloudflare KV.
- Retry/acknowledgement:
  - Search uses `people:searchContacts` with `readMask=phoneNumbers`; creation uses `people:createContact`.
  - Same-user People API mutations are sequential, as required by Google.
- Failure handling:
  - 429/5xx/timeouts -> retryable.
  - expired/revoked OAuth, missing Contacts scope, account mismatch, provider-route mismatch, invalid job -> terminal/reconnect as appropriate.
  - pre-existing exact phone -> success with `existing` result, no write.

### Observability and audit

- Durable activity/audit evidence:
  - Record safe result code and attempt count against outbox/client IDs through existing activity logging.
  - No names, phone numbers, emails, message bodies or provider tokens in logs.
- Logs/metrics:
  - Scheduled drain logs aggregate claimed/created/existing/failed/unrecorded counts only.

## Security review

- Browser-controlled values: not authoritative; OAuth start requires CRM session and the DB resolves artist.
- Artist/workspace authorization: claim RPC verifies owning artist/client/link; provider route resolves from outbox artist.
- Privileged RPC/service-role paths: new RPCs are narrowly scoped to one outbox kind and one capability flag.
- RLS and grants: no browser writes to outbox/provider routing are introduced.
- Secrets/tokens: remain encrypted KV/Worker-only.
- Cross-tenant leakage risk: route/account/client relation is revalidated before every provider write.
- Denial-path tests: cross-artist job, unlinked conversation, archived client, missing scope, disabled capability, account mismatch, invalid phone and stale lease.

## Test strategy

- Unit/contract tests:
  - New `scripts/test-google-contacts-worker.mjs` covers scope validation, exact-phone existing skip, create payload minimization, transient/fatal errors, token/account routing and drain acknowledgement.
  - Extend Calendar OAuth tests for Contacts scope and capability enable/disable calls.
  - Extend Calendar production config tests so the Google worker's new drain remains within the existing secret/KV boundary.
- pgTAP/database tests:
  - New focused test file for enqueue conditions, dedupe, cross-artist denial, claim leasing, acknowledgement retry/dead behavior and reconciliation.
- CRM/typecheck/build tests:
  - Update Calendar connection copy/tests; run admin test/typecheck/build.
- denial/security tests:
  - Ensure unmatched WhatsApp never enqueues; browser/authenticated role cannot call backend claim/ack/capability RPCs.
- integration/smoke tests:
  - Provider calls mocked in CI.
  - Production acceptance uses legitimate linked client data or a non-fabricated controlled path.
- exact-head CI required:
  - Static Validation.
  - CRM and booking validation.
  - Other release-required workflows named by the production release gate for the exact canonical/release SHA.

## Rollout plan

1. Implement on bounded feature branch and open PR to current canonical CRM branch.
2. Run exact-head CI. Because retained staging is schema-stale, do not apply only the tail migrations there; rely on fresh local Supabase reset/pgTAP and Worker contract tests until a production-compatible staging path is available.
3. Merge only after current canonical base is rechecked and exact-head validation is green.
4. Use the existing fail-closed private production release/migration path for the additive DB migrations and Google Worker deployment; perform dry-run/readback before mutation.
5. Reconnect the artist's Google account once to grant Contacts scope if the existing refresh token lacks it. This provider consent is the only expected human action.
6. Verify capability flag, outbox reconciliation, Worker drain, safe provider result and actual Google contact creation using legitimate client data; then verify device/WhatsApp display separately if Google Contacts sync is enabled on the phone.

## Rollback/reference plan

- Before OAuth reconnect/capability enable, the new trigger produces no Contacts jobs.
- Disable `google_contacts_sync` for the artist to stop new provider writes without disabling CRM/WhatsApp.
- Disable the scheduled Google drain/roll back Worker to the previous exact deployment if provider behavior is unsafe; already durable CRM state remains intact.
- Additive enum values are not removed in rollback. New kind can remain inert.
- No automatic Google-contact deletion occurs during rollback.

## Risks

| Risk | Consequence | Mitigation |
| --- | --- | --- |
| Google search cache lags a just-created contact after an ambiguous network result | duplicate contact on retry | warm search, exact canonical E.164 check on every attempt, sequential mutations, bounded retry/backoff; treat only verified no-match as create |
| Existing Google OAuth consent lacks Contacts scope | jobs cannot write | capability stays disabled until successful reconnect with scope |
| People API not enabled in Google Cloud project | provider returns configuration/permission failure | fail closed; verify during release before enabling reconciliation |
| Retained staging schema is far behind production | tail migration could be unsafe in staging | do not mutate stale staging; require local full migration/pgTAP plus production release dry-run and readback |
| Device does not sync the authorised Google Contacts account | contact exists in Google but WhatsApp still shows number | server acceptance separates provider creation from device-level sync; final device setting is explicit |
| Contacts permission is broader than Calendar permission | unexpected consent surprise | truthful CRM copy and explicit Google consent; no hidden scope escalation |

## Plan completion gate

- Current target/base SHA recorded and will be rechecked before implementation writes.
- Every material requirement maps to database, Worker, UI, tests or rollout.
- Trust boundaries and service-only RPCs are explicit.
- Enum migration ordering and stale-staging constraint are explicit.
- Code/CI, provider consent, deployment and device acceptance are separate evidence stages.
