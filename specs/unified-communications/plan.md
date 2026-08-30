# Implementation Plan: Unified enquiry communications

## Specification

- Spec: `specs/unified-communications/spec.md`
- Target repository: `vvetrov41-lgtm/Vishar-site`
- Target branch/PR: stage 1 branch `agent/whatsapp-embedded-signup-recovery`, no PR yet
- Exact target SHA: `3b8b66a1945322b3dd95830000ce119ce3fe0bfd`

## Constitution check

- Server authority: browser results are treated as evidence only; backend revalidates actor, artist, route, WABA and phone before any provider/binding mutation.
- Authorization before capability: CRM profile, artist membership/capability, RLS and backend route checks remain layered.
- Ordered database evolution: production is observed through `0117`; stage 1 changes no schema. Later linking/email work must inspect every migration after `0069` and `0059` before adding SQL.
- Exact-head evidence: every stage starts from a freshly verified canonical SHA and uses exact-head CI.
- Durable external delivery: Meta message delivery stays outbox-backed and enquiry persistence remains independent.
- Secret custody: codes and tokens remain transient server-side values; only secret names and safe route metadata are read back.
- Deployment is separate evidence: code, CI, Pages deployment and provider acceptance are distinct gates.
- Bounded reversible rollout: stage 1 edits only the Meta onboarding frontend/CSP/tests and can roll back to the previous Pages deployment.

## Current-state evidence

- Entry points: `admin/src/pages/WhatsAppConnectionsPage.tsx`, `admin/src/lib/meta-whatsapp-embedded-signup.ts`, `admin/functions/api/whatsapp/embedded-signup/provision.js`, `admin/public/_headers`.
- Database objects/migrations: `artist_integrations`; `communication_conversations`; `communication_messages`; `integration_outbox`; migrations `0046`-`0052` and `0068`-`0072`. Production head observed at `0117`.
- Authorization boundary: Supabase Auth profile plus artist membership/capability; provisioning rechecks the exact enabled integration key before provider calls.
- Durable state boundary: conversations/messages and outbox rows are authoritative; encrypted bindings live only in the two production WhatsApp Workers.
- Provider/integration path: `FB.login` -> one-time code + signed-origin session event -> same-origin Pages Function -> Meta code exchange/asset validation -> Vladimir/Kristina deterministic Worker secret name -> WABA subscription.
- Existing tests: `admin/src/test/meta-whatsapp-embedded-signup.test.ts`, `admin/src/test/whatsapp-connections.test.ts`, `scripts/test-whatsapp-production-onboarding.mjs`, Worker and pgTAP WhatsApp suites, private CRM build scan.
- Relevant ADR/docs: `docs/crm/whatsapp-production-runbook.md`, `docs/crm/adr/0007-communications-domain-and-provider-adapters.md`, `docs/ai/security-boundaries.md`.
- Unknown or externally unverifiable state: Meta configuration type/status and exact current app/config pairing; live Worker secret values; real iPhone Safari provider result. Current safe DB metadata shows both routes enabled with empty configuration, but no inbound message has been recorded and the only Vladimir outbound row is an operator-cancelled test.

## Proposed design

### Data model and migrations

- Stage 1: no schema change.
- WA/Instagram enquiry UI stage: reuse `enquiry_id`/`client_id` on `communication_conversations` and current authorized linking RPC; add SQL only if exact migration tracing proves an observable gap.
- Email stage: keep `email_messages` and private Gmail thread context; add a read/reply adapter contract, not a table merge.
- RLS/grants/RPC implications: preserve existing RLS and backend-only claim/route RPCs; any new linking/read RPC needs explicit same-artist checks, fixed `search_path`, deny tests and narrow grants.

### Server/Worker layer

- Stage 1 keeps the provisioning endpoint and its deterministic artist mapping. Improve only safe error taxonomy if backend evidence requires it.
- Extend exact production preflight/readback so Pages CSP requires every reviewed Facebook SDK origin and app IDs remain consistent across frontend/backend.
- Later stages use current provider-neutral conversation APIs and protected Gmail approval/queue endpoints.
- Existing outbox leases, retries, stale-result handling and provider acknowledgement remain unchanged.

### CRM/UI layer

- Add typed Embedded Signup diagnostics: SDK unavailable, login status, missing code, provider cancel step, provider error code, incomplete finish payload and timeout phase.
- Preserve the synchronous tap-to-`FB.login` call and add the reviewed Facebook cross-domain frame origin to CSP.
- Stage 2 replaces the legacy enquiry panel with channel state cards.
- Stage 3 embeds recent WA/Instagram messages plus reply/open actions.
- Stage 4 supplies the same UI interface from the Gmail adapter.
- Stage 5 combines adapter items into one sorted channel-labelled timeline.

### External integrations

- Provider: Meta Cloud API for WhatsApp/Instagram and Gmail for email.
- Credential custody: Meta tokens in encrypted Worker bindings/KV as already designed; Gmail credentials remain in the existing backend service.
- Retry/acknowledgement: reuse communication and Gmail outboxes.
- Failure handling: expose stable safe codes; never display raw provider responses or credentials.

### Observability and audit

- Browser diagnosis is ephemeral and user-visible; it contains no auth code, WABA/phone ID or token.
- Provisioning returns existing safe error codes and safe account labels only.
- Activity remains content-free and participant-free.
- Production acceptance records exact SHA/version, safe binding names, counts/statuses and timestamps only.

## Security review

- Browser-controlled values: `artist_id`, code and session IDs are revalidated server-side; integration key cannot be supplied by the browser.
- Artist/workspace authorization: exact artist capability is required; stage 1 production mutation is Vladimir-only by acceptance scope.
- Privileged RPC/service-role paths: unchanged in stage 1; later communications RPCs must be traced through final effective SQL and grants.
- RLS and grants: unchanged in stage 1; later same-artist enquiry linking requires positive and denial coverage.
- Secrets/tokens: never logged, persisted in Postgres, included in specification evidence or returned to UI.
- Cross-tenant leakage risk: deterministic artist bindings and no fallback; Kristina readback is a required control.
- Denial-path tests: spoofed message origin, malformed IDs, missing capability, wrong artist, incomplete login response, provider CANCEL/ERROR and ambiguous client linking.

## Test strategy

- Unit/contract tests: expand Embedded Signup callback/event ordering and typed error coverage; add CSP/app-ID artifact assertions.
- pgTAP/database tests: not needed for stage 1; required before any later SQL change.
- CRM/typecheck/build tests: `npm test`, `npm run typecheck`, `npm run build`, `scripts/check-private-crm-artifact.mjs`.
- Denial/security tests: exact allowed origins, no credential fields, artist-scoped provisioning, wrong/missing callback evidence.
- Integration/smoke tests: Meta SDK production load, iPhone Safari flow, backend provisioning, safe Cloudflare readback, real inbound and outbound.
- Exact-head CI required: Static Validation, CRM and booking validation, Gmail production validation, Booking host validation and WhatsApp production onboarding validation.

## Rollout plan

1. Commit stage 1 on a bounded branch from canonical `3b8b66a`, open a PR and obtain exact-head CI.
2. Merge only after base/head/CI preflight; create an immutable CRM-only release ref at the new canonical SHA.
3. Deploy only the private CRM Pages artifact through the guarded exact-SHA workflow; no migration or WhatsApp Worker code deploy.
4. Read back the exact Pages commit and CSP/Access boundary.
5. Complete Vladimir's Meta flow on iPhone Safari. The provisioning Function may refresh only Vladimir's two encrypted Worker bindings and WABA subscription.
6. Read back safe DB/Worker state, then perform one approved inbound and one reply acceptance with no synthetic client.
7. Begin stage 2 only after AC-001 through AC-005 pass.

## Rollback/reference plan

Redeploy the previous exact private CRM Pages SHA if the CSP/diagnostic patch regresses the UI. If Vladimir provisioning targets unexpected assets, disable only Vladimir's CRM route and stop outbound drain before investigation; do not change Kristina or reset the database. No down migration exists because stage 1 changes no schema.

## Risks

| Risk | Consequence | Mitigation |
| --- | --- | --- |
| Meta Configuration ID is stale or wrong | No code can be returned even with correct frontend behavior | Verify exact App ID/config in Meta; show stable diagnostic IDs; do not guess a replacement |
| Facebook SDK needs an unlisted CSP frame origin | Hidden cross-domain callback transport fails, especially in Safari | Allow only the exact reviewed HTTPS origin and assert it in the artifact scan |
| iOS loses the user gesture | Blank/blocked popup | Keep `FB.login` synchronous and unit-test that no awaited work precedes it |
| Partial provisioning refreshes one Worker first | Webhook/drain credentials temporarily diverge | Do not declare success; rerun the same Vladimir-scoped idempotent binding overwrite; verify both names |
| Client fallback links the wrong conversation | Cross-enquiry disclosure | Enquiry-first lookup, server-authorized same-artist unique fallback and ambiguous-match denial |
| Email refactor bypasses Gmail approval | Unreviewed mail is sent | Adapter queues through the existing protected Gmail pipeline only |

## Plan completion gate

- Current target revision and production migration head are recorded.
- Every user stage maps to implementation and acceptance evidence.
- Trust, provider and rollout boundaries are explicit.
- Stage 1 has no migration; later schema work remains conditional on exact migration tracing.
- Code completion, production deploy and real provider acceptance remain separate gates.
