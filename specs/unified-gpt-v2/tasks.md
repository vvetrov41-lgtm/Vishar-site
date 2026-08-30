# Tasks: Unified GPT v2

## Rules

- Every implementation task traces to the full operator-parity product target, not only the currently imported OpenAPI operations.
- Production activation is separate from repository completion.
- Legacy Vladimir/Kristina GPT clients remain rollback compatibility until a later retirement decision.
- Custom GPT Actions are the current transport; future Vishar MCP/App must reuse the same server domain contracts and capability model.
- Provider credentials, provider routing and secret configuration stay server-side.
- Every CRM user-facing capability must eventually be classified as GPT-exposed, deliberate UI-only or an explicit implementation gap.
- Imported Action schemas must stay <=30 operations and should target <=25 for headroom.

## Phase 0: Scope-correction preflight

- [x] T001 Fresh-check canonical branch before correction: `agent/platform-telegram-self-service` @ `d83ac621b77d50f56b92ebee81cecef2a05cc9c5`.
- [x] T002 Fresh-check open PRs; unrelated Inbox PR #542 remains isolated from GPT spec files.
- [x] T003 Fresh-check production migration head: `0118_enquiry_deposit_conversion`.
- [x] T004 Fresh-check production GPT client state: two active legacy artist-bound clients; dormant profile-bound `vishar-unified-gpt` with no OAuth binding.
- [x] T005 Reconcile historical GPT architecture: PR #364 used Core/Operations/Communications; PR #374 unified user-context target carried 25/25/12 operations.
- [x] T006 Reconcile current import capacity: current Core 28 + Operations 29 with repository-enforced <=30 per schema.
- [x] T007 Reconcile broader platform scope from capability registry, Unified Communications and Web Research specs.

## Phase 1: Correct durable product contract

- [x] T010 Correct `spec.md`: Unified GPT target is full authorized CRM operator parity, not only current 57 operations. [FR-007, FR-021]
- [x] T011 Correct `plan.md`: modular semantic Action domains plus future transport-neutral MCP/App path. [FR-008..FR-010, FR-023]
- [x] T012 Correct this task list so Communications, integration management, Notification/Template Studio and Research are required workstreams rather than invisible/deferred scope.
- [ ] T013 Run Spec Kit consistency analysis against `spec.md`, `plan.md`, `tasks.md`, `specs/unified-communications/` and `specs/web-research/`.
- [ ] T014 Add/adjust durable architecture documentation if any current roadmap file still implies that two Action schemas are the final product architecture.

## Phase 2: Build canonical operator-parity inventory

- [ ] T020 Enumerate the current capability registry and final authorization mappings for Clients, Enquiries, Projects, Sessions, Finance, Communications, Integrations, Booking Sources, Notifications, Automations, Team and Workspace. [AC-009]
- [ ] T021 Enumerate every current private CRM user-facing read/mutation and map it to capability, server/RPC contract and UI surface. [FR-021]
- [ ] T022 Enumerate current provider/integration user actions for Gmail, WhatsApp, Instagram, Google Calendar, Monzo and Telegram. [AC-010]
- [ ] T023 Enumerate current 57 GPT operations and classify them by semantic product domain rather than current file location.
- [ ] T024 Produce repository-owned parity inventory with fields: domain, operation, UI availability, server contract, capability, consequence class, GPT status, intended Action domain, MCP status, gap/UI-only reason.
- [ ] T025 Add tests that fail when an operation disappears from the inventory or two import schemas expose the same operation id.
- [ ] T026 Add a feature-development rule/check so new substantial CRM user-facing capabilities require an explicit GPT/MCP parity decision. [FR-022]

## Phase 3: Repartition existing Custom GPT surface

- [ ] T030 Restore a dedicated Communications import schema and production action domain; move existing WhatsApp/Gmail communication operations out of unrelated Operations without changing their server semantics.
- [ ] T031 Recalculate Core after the Communications extraction and identify whether Core needs immediate split to preserve <=25 target headroom.
- [ ] T032 Recalculate remaining Operations and repartition Scheduling and Finance when required for sustainable headroom.
- [ ] T033 Preserve `/v1/context` as the only schema/action location allowed to accept `artist_id`.
- [ ] T034 Ensure all domains share the same profile-bound OAuth application and server-owned Artist context.
- [ ] T035 Replace two-schema-specific tests with domain-inventory tests asserting each schema <=30, target headroom, unique ids and exact intended union.
- [ ] T036 Keep read/mutation `x-openai-isConsequential` classifications and high-impact descriptions intact through moves.
- [ ] T037 Keep temporary backward-compatible provider routes only where required for safe Builder migration, with an explicit removal task after acceptance.

## Phase 4: Close current CRM operator-parity gaps

### Core / Scheduling / Finance

- [ ] T040 Compare current CRM UI against GPT Core/Scheduling/Finance contracts and add narrow missing named server operations where authorized users currently have no GPT equivalent.
- [ ] T041 Include current deposit requirement semantics, grouped/multi-session deposit workflows and Monzo reconciliation parity.
- [ ] T042 Include Calendar sync/status and other user-facing scheduling/provider actions that are safe through the existing Calendar boundary.

### Communications

- [ ] T043 Preserve current WhatsApp read/link/send operations in Communications.
- [ ] T044 Preserve current Gmail history/thread/draft/approval-send operations in Communications.
- [ ] T045 Add Instagram read/reply operations only after the actual Instagram provider integration is production-accepted; reuse unified communication ownership and Artist context.
- [ ] T046 Add provider-neutral conversation/inbox operations where the common Communications backend provides a stable contract.
- [ ] T047 Treat message/email/Instagram content as untrusted data in tool-chaining tests.

### Integrations and Admin

- [ ] T048 Inventory safe integration management available in CRM: status, diagnostics, connect/reconnect/disconnect initiation, enable/disable and non-secret settings.
- [ ] T049 Add bounded GPT operations for integration management where server contracts exist; provider OAuth/consent remains an explicit human handoff.
- [ ] T050 Add bounded Team/Artist/Workspace membership/capability administration where current authorization permits it.
- [ ] T051 Add Booking Source/hosted-form administration where user-facing CRM contracts permit it.
- [ ] T052 Prove no GPT operation can read/write provider secret values, raw encrypted bindings or arbitrary configuration blobs.

## Phase 5: Notification / Template / Automation parity

- [ ] T060 Complete Notification/Template Studio server contract first: list/get, preview, edit approved fields, language/channel/purpose, enable/disable, rule timing/scheduling, version/history and already-scheduled-item semantics.
- [ ] T061 Map Notification Center and follow-up lifecycle user actions into the parity inventory.
- [ ] T062 Add GPT Notification/Template operations through the same profile/Artist/capability path.
- [ ] T063 Add automation rule management operations available to authorized CRM users: list/read/create/update/enable/disable and bounded user-facing history/health/recovery.
- [ ] T064 Prove template/automation changes cannot bypass consent/suppression rules or rewrite historical sent-message evidence.
- [ ] T065 Keep all template/rule mutations consequential and auditable.

## Phase 6: Unified base production activation

This stage may proceed after the sustainable modular surface needed for the initial operator workflow is ready. It does not require every future Research feature to be complete, but must not use the obsolete 28/29 two-domain layout as the permanent Builder target.

- [ ] T070 Fresh-check canonical exact SHA, exact-head CI, production migration head, Cloudflare GPT Worker/routes/bindings/flags, OAuth discovery and actual Custom GPT configuration.
- [ ] T071 Confirm `vishar-unified-gpt` remains `binding_mode=profile`, `artist_id IS NULL`, dormant before activation, and both legacy clients remain active.
- [ ] T072 Reassess intermittent Supabase 401 evidence and containment before final cutover.
- [ ] T073 Create/configure one confidential production OAuth client for the unified application through an authorized control plane. Keep secret out of repository/chat.
- [ ] T074 Bind only the non-secret OAuth client id and enable explicitly intended capability ceilings through an auditable path. Keep legacy clients unchanged.
- [ ] T075 Configure one Custom GPT with exact-SHA modular Action schemas and v2 instructions, using the same OAuth application identity across domains.
- [ ] T076 Production read-only acceptance across representative enabled domains: context, CRM core, scheduling, finance, communications/integration status.
- [ ] T077 Prove unauthorized Artist selection and cross-Artist provider access fail closed.
- [ ] T078 Consequential acceptance only through legitimate intended real operations, preserving confirmation/idempotency. No synthetic production customers/payments/messages.
- [ ] T079 Record DB/Cloudflare/GPT/OAuth non-secret readback and rollback reference.

## Phase 7: Web Research and Project Web References

Implement according to `specs/web-research/`, not as a single Firecrawl shortcut.

### Phase V: transient Research gateway

- [ ] T080 Fresh-check current Firecrawl API/account/credential contract and current Cloudflare runtime before implementation.
- [ ] T081 Implement Vishar server-side Research adapter, URL/SSRF/redirect/DNS guards, kill switches, usage limits, normalized output and provider-secret custody.
- [ ] T082 Expose a dedicated Research Action domain with `deep_web_search`, `read_web_page` and bounded `crawl_website`, sharing Unified GPT OAuth/profile context.
- [ ] T083 Staging and production acceptance on real public sources including unsafe URL, provider failure and prompt-injection denial.

### Project Web References

- [ ] T084 Implement project-scoped public URL references with pending/ready/failed state and parent-project authorization.
- [ ] T085 Implement stable tattoo-reference extraction, source-analysis vs artist-decision separation, reanalysis and last-known-good preservation.
- [ ] T086 Expose bounded GPT operations to add/read/reanalyse/remove Project Web References and manage artist decisions where authorized.
- [ ] T087 Add multi-reference synthesis only after single-reference production acceptance.

### Persistent Research

- [ ] T088 Implement saved Research runs/sources/snapshots for Competitors, Studios, Pricing, SEO and Market research.
- [ ] T089 Add repeat/compare operations and GPT exposure.
- [ ] T090 Add recurring monitoring only after persistent Research acceptance, with bounded schedule, idempotency, kill switches and last-known-good behavior.

## Phase 8: Transport-neutral MCP/App surface

- [ ] T100 Reconcile historical Phase Q-R transport-neutral MCP domain contracts against the now-stable operator-parity inventory.
- [ ] T101 Expose the same semantic operations through a remote Vishar MCP/App when current ChatGPT/workspace capabilities make the write surface appropriate.
- [ ] T102 Keep user identity, memberships, Artist context and capabilities authoritative in the existing backend; MCP is transport only.
- [ ] T103 Reuse provider boundaries for Gmail, Monzo, Calendar, WhatsApp, Instagram, Telegram and Research rather than creating MCP-specific provider access.
- [ ] T104 Validate ChatGPT/other-client tool discovery and write confirmations without weakening Action transport security.

## Phase 9: Legacy retirement

- [ ] T110 Do not retire Vladimir/Kristina GPTs until Unified GPT is production-accepted across the intended daily operator workflows and rollback is no longer needed.
- [ ] T111 Retire legacy clients/OAuth in a separate bounded workstream with exact-head checks and production readback.
- [ ] T112 Remove temporary backward-compatibility Action routes only after Builder configuration no longer references them.

## Continuous validation

- [ ] V001 Every bounded PR: fresh base/open-PR check before write and before merge.
- [ ] V002 Exact-head Static Validation and CRM/booking validation where GPT/server contracts change.
- [ ] V003 Focused Gmail/WhatsApp/Instagram/Calendar/payment/Research validations whenever those domains change.
- [ ] V004 Full Supabase replay/pgTAP for authorization/database changes.
- [ ] V005 Secret scan and Worker compile/dry-run for every provider/action edge change.
- [ ] V006 Production completion requires deploy -> readback -> actual acceptance, not code/CI alone.

## Explicit deliberate UI-only candidates

These are not automatically excluded; the parity inventory must confirm them individually:

- provider OAuth/login/consent screens requiring the human in provider UI;
- device-local binary/file selection or upload without a reviewed safe upload contract;
- provider account recovery/security challenges;
- any action that would require exposing a secret or arbitrary provider/API capability.

Everything else that an authorized user can do in Vishar CRM is presumed to be a GPT/MCP parity target until the inventory proves a deliberate exception.
