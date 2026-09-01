# Implementation Plan: Universal artist WhatsApp routing

## Specification

- Spec: `specs/whatsapp-universal-artist-routing/spec.md`
- Target repository: `vvetrov41-lgtm/Vishar-site`
- Target branch/PR: `agent/whatsapp-self-service-completion`, no PR yet
- Exact target SHA: canonical base `191bfdb30832b608e85029e0d4d64940e9deefc3`

## Constitution check

- Server authority: artist, integration key and credential binding are resolved from authenticated CRM/database state and verified secret envelopes; browser IDs are requests only.
- Authorization before capability: active profile, artist membership, `can_manage_integrations`, RLS and RPC checks remain layered.
- Ordered database evolution: production is through `0127`; open PR #588 owns `0128`, so this branch uses a non-conflicting later migration and rechecks lineage before merge.
- Exact-head evidence: implementation, CI, merge and rollout each bind to an immutable SHA.
- Durable external delivery: message tables/outbox remain authoritative and are not coupled to onboarding success.
- Secret custody: provider credentials remain only in separately encrypted Worker bindings.
- Deployment is separate evidence: DB, webhook Worker and CRM Pages are independently deployed and read back.
- Bounded rollout: Vladimir credentials, phone registration and drain schedule remain unchanged. Meta app publication and Kristina's explicit interactive consent are required external stages.

## Current-state evidence

- Entry points: `admin/src/pages/WhatsAppConnectionsPage.tsx`, `admin/src/lib/whatsapp-connections-api.ts`, `admin/functions/api/whatsapp/embedded-signup/provision.js`, `workers/lib/whatsapp-webhook.js`.
- Database objects/migrations: `artist_integrations`, `artists`, `artist_memberships`; migrations `0017`, `0025`, `0052`, `0069`-`0070`, `0076`, `0121`, `0127`.
- Authorization boundary: Supabase Auth plus active profile, owner/manager role, same-artist membership and `can_manage_integrations`; direct table update stays closed.
- Durable state boundary: `communication_conversations/messages` and outbox rows remain authoritative; credentials live in drain/webhook Worker secrets.
- Provider/integration path: Embedded Signup code -> same-origin Pages Function -> Meta validation -> deterministic per-artist secret in two Workers -> signed webhook -> exact route -> narrow ingestion RPC.
- Existing tests: `scripts/test-whatsapp-production-onboarding.mjs`, `scripts/test-whatsapp-webhook.mjs`, `scripts/test-whatsapp-routing.mjs`, CRM WhatsApp tests and pgTAP communications suites.
- Relevant ADR/docs: `docs/ai/security-boundaries.md`, `docs/crm/adr/0007-communications-domain-and-provider-adapters.md`, existing WhatsApp production runbooks/specs.
- Production evidence: migrations through `0127`; Vladimir route enabled with empty configuration and `connected_at=2026-08-31 11:11:35.963531+00`; 5 conversations, 8 messages, 6 provider-backed inbound messages. Latest sanitized Cloudflare inventory for exact canonical completed successfully.
- Unknown or externally unverifiable state: Worker secret values are intentionally unreadable; their names and deployed versions can be read back. No real future artist account exists for provider E2E in this workstream.

## Proposed design

### Data model and migrations

- Add a partial unique index for artist-owned WhatsApp `integration_key` values after a fail-before-write drift check.
- Extend the existing identity trigger so production/staging WhatsApp keys equal the owning artist slug plus environment, rather than accepting any slug-prefixed suffix.
- Add `public.complete_artist_whatsapp_connection(uuid,text)` as a bounded authenticated RPC. It checks access, active artist, exact enabled Meta route, exact `<slug>-production` key and empty configuration, locks one row, and generates `connected_at` server-side.
- Revoke from `PUBLIC`, `anon` and `service_role`; grant only to `authenticated`. Keep direct table update closed.
- No Vladimir backfill and no credential/provider IDs in database rows.

### Server/Worker layer

- Replace embedded-signup `APPROVED_ARTISTS` with authenticated route lookup. Derive the binding from the returned production integration key using the same reversible escaping contract as `workers/lib/provider-routing.js`.
- Embed `artistId` and `integrationKey` in every newly written credential envelope and verify the deterministic binding-name match at webhook startup/request time.
- Enumerate `ARTIST_WHATSAPP_*` encrypted bindings at runtime. New envelopes are self-describing.
- Support legacy envelopes generically by decoding the binding's integration key and resolving the existing `WHATSAPP_<SLUG>_ARTIST_ID` server variable. No artist name or UUID remains in the Worker source allowlist.
- Reject partial identity, malformed prefixed bindings and collisions across binding name, artist ID, integration key and Phone Number ID.
- Add Meta subscription and both Worker secret-name readbacks to embedded provisioning, then call the generic completion RPC. The response includes only safe labels and the connected timestamp.

### CRM/UI layer

- Remove the two-artist onboarding map from `whatsapp-connections-api.ts`.
- Offer Embedded Signup for any authorized artist whose exact derived route is enabled and non-conflicting.
- Keep the Vladimir-only manual existing-account form unchanged as an emergency path.
- Render connected state from safe metadata; retain RU/EN and mobile behavior.
- Operator parity remains `ui_only` because Meta login/consent is an interactive provider security boundary.

### External integrations

- Provider: Meta Cloud API and existing Meta app.
- Credential custody: one encrypted envelope per artist in the existing drain and webhook Workers; no token copy to Postgres/browser logs.
- Retry/acknowledgement: provisioning retries overwrite the same artist binding; message delivery retains current outbox semantics.
- Failure handling: stable safe error codes only; no raw provider response or participant identifier reaches activity logs.

### Observability and audit

- Pre/post deployment captures exact Worker/Pages versions, routes, cron state and secret names only.
- Production database acceptance uses aggregate counts/timestamps and safe integration metadata, never message bodies or participant identifiers.
- Existing Worker logs stay content-free and credential-free.

## Security review

- Browser-controlled values: `artist_id`, code and optional Meta session IDs; all are validated and cannot choose integration key/binding.
- Artist/workspace authorization: owner or active same-artist manager with `can_manage_integrations`; workspace-owned WhatsApp is out of scope.
- Privileged RPC/service-role paths: no new service-role browser path. Generic completion is authenticated, capability-checked and metadata-only.
- RLS and grants: table reads remain RLS-scoped; direct update remains denied; the new function has fixed `search_path` and narrow grants.
- Secrets/tokens: separate Cloudflare secrets only; never output or persist their values.
- Cross-tenant leakage risk: exact self-describing envelope, binding-name equality, signature plus WABA/phone match, collision denial and no default artist.
- Denial-path tests: unauthorized artist, disabled/non-empty/wrong key route, malformed/partial envelope, missing legacy identity, duplicate key/artist/phone, bad signature and wrong provider IDs.

## Test strategy

- Unit/contract tests: extend webhook and onboarding scripts for Vladimir legacy, third artist, collision/mismatch/missing-credential and readback ordering.
- pgTAP/database tests: key invariant/uniqueness, positive completion, cross-artist denial, disabled/configured route denial, direct update denial and safe return fields.
- CRM/typecheck/build tests: focused WhatsApp API/page tests plus standard private CRM suite.
- Denial/security tests: prove no provider or Cloudflare mutation precedes authorization/route/Meta checks and no connected update precedes all readbacks.
- Integration/smoke tests: dry-run both Worker bundles; safe production HTTP route probe; aggregate production readback.
- Exact-head CI required: static validation, private CRM, Supabase migrations/pgTAP, CRM booking validation and WhatsApp production onboarding validation for the exact PR SHA.

## Rollout plan

1. Recheck canonical/PR drift, complete bounded branch implementation and local validation.
2. Push a dedicated PR, obtain exact-head CI and rebase/replay if parallel PR #588 changes canonical/migration lineage.
3. Merge after fresh base/CI preflight and confirm post-merge canonical checks.
4. Apply the production migration through the guarded exact-SHA workflow and read back the migration head/RPC/grants.
5. Deploy the webhook Worker first. It accepts both legacy and self-describing envelopes; read back version, route, secret-name set and unchanged cron state.
6. Deploy private CRM Pages from the same merged SHA; read back commit and protected route.
7. Verify Vladimir's safe metadata and aggregate message counts, then perform a non-mutating signed-route unit/service probe. No fake customer/message is created.
8. Publish a provider-specific privacy notice, complete the WhatsApp-only Meta App Review and Access Verification, then verify the Meta app is available to a non-developer artist.
9. Kristina completes the interactive Meta consent screen; read back her exact connected route and separate Worker binding names without reading credential values or creating customer data.

## Rollback/reference plan

The database change is additive and may remain if application rollout is reverted. Redeploy the previous webhook Worker and CRM Pages versions if needed. Newly self-describing envelopes retain the fields older outbound code ignores. Vladimir's legacy envelope and existing route remain valid on the previous Worker. Do not delete secrets or down-migrate production during rollback.

## Risks

| Risk | Consequence | Mitigation |
| --- | --- | --- |
| A malformed new prefixed secret is visible to the webhook Worker | Inbound fails closed for all routes | Validate envelope before connected state; read back secret names; extensive malformed/collision tests |
| Legacy route decoding differs from current binding escaping | Vladimir inbound stops | Round-trip tests against `bindingNameFor`; deploy compatibility Worker before any new onboarding |
| Parallel migration `0128` merges first | Migration collision or stale branch | Reserve later number and fresh-check/replay on new canonical before merge |
| Generic connected RPC is called outside provisioning | Cosmetic connected state could be marked by an authorized manager | Exact capability/route/empty-config checks; no routing or credential authority comes from `connected_at` |
| New artist provisioning partially writes one Worker | Inbound/outbound credentials differ temporarily | Connected state waits for both secret-name readbacks and Meta subscription; retry overwrites same names |

## Plan completion gate

- Current target and production heads are verified.
- Every requirement maps to DB, Pages Function, Worker, CRM and tests.
- Trust and compatibility boundaries are explicit.
- Code, exact-head CI and production rollout remain separate evidence gates.
