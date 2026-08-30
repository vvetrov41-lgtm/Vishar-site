# Feature Specification: Unified GPT v2

## Status

- Feature: `unified-gpt-v2`
- State: In implementation
- Owner/workstream: Vishar CRM
- Related historical work: PR #364 three-domain GPT split, PR #374 unified user context, PR #377 unified production onboarding skill, PR #389 profile-bound authorization, PR #390 golden-path validation
- Related product specs: `specs/unified-communications/`, `specs/web-research/`

## Problem

Vishar CRM already has a profile-bound authorization foundation that can serve several Artists through one authenticated CRM profile, but the current Unified GPT v2 specification accidentally narrowed the target product to the 57 operations that happen to exist in the current two import schemas.

That is not the intended product boundary.

The intended Unified GPT is a conversational operator surface for Vishar CRM. Subject to the same server-side membership, capability, confirmation, consent and provider rules as the CRM UI, it should eventually be able to perform every bounded action an authorized human can perform in the CRM and every supported external integration action that Vishar exposes safely. The Action/OpenAPI layer is a transport adapter, not the definition of product scope.

Historical GPT work already used three logical Action domains, Core, Operations and Communications, specifically to stay below Builder limits while exposing a broader surface. The current two-schema split, 28 Core plus 29 Operations, is nearly full and cannot safely absorb Instagram, Notification/Template Studio, integration management, Web Research or later CRM capabilities.

## Product principle: operator parity

For every meaningful user action available in Vishar CRM or through a supported Vishar integration, the implementation MUST do one of the following:

1. expose a bounded GPT/MCP domain operation governed by the same authoritative permission model; or
2. document a deliberate UI-only boundary because the action requires unavoidable interactive OAuth/consent, binary/device interaction, provider UI, or cannot yet be represented safely.

Missing tool coverage by accident is a product gap, not an acceptable steady state.

Operator parity does NOT mean arbitrary database/provider access. The GPT receives semantic Vishar operations only.

## Goals

- Provide one Vishar CRM GPT for authenticated CRM users.
- Make the OAuth client identify the Vishar application, never an Artist.
- Resolve accessible Artists from the signed-in CRM profile and current memberships.
- Let the user select an active Artist only through the server-validated Artist context contract.
- Reuse the existing CRM capability model for every read or mutation.
- Preserve the existing Vladimir and Kristina artist-bound GPTs as rollback compatibility until unified production acceptance is complete.
- Restore a modular Action-domain architecture instead of treating the current Core/Operations split as the final product surface.
- Provide full authorized CRM operator coverage over clients, enquiries, projects, sessions, finance, communications, notifications, automations, integrations, booking sources, team/workspace administration and other user-facing CRM domains as their bounded server contracts exist.
- Provide full supported integration coverage through Vishar-owned boundaries for Gmail, WhatsApp, Instagram, Google Calendar, Monzo, Telegram and future integrations, without exposing provider credentials.
- Add Notification/Template Studio operations after its server-side editing contract is finalized, including template/rule read, preview, edit, enable/disable and scheduling semantics.
- Integrate Web Research through the same identity boundary, including transient deep research, Project Web References, persistent Research runs/snapshots/comparison and later bounded monitoring.
- Keep ordinary ChatGPT web search for simple current-information lookups and use Vishar Research for deep/repeatable public-web work.
- Keep the server domain contracts transport-neutral enough to be exposed later through a Vishar remote MCP/App without creating another permission system.
- Provide durable GPT instructions and production onboarding guidance that match the implemented profile-bound model.

## Non-goals

- Replacing CRM authorization with GPT instructions or OpenAPI descriptions.
- Giving the GPT arbitrary SQL, table access, arbitrary RPC access, service credentials or provider credentials.
- Letting a GPT business action choose an Artist outside the dedicated context selector.
- Calling Gmail, Meta, Google, Monzo, Firecrawl or another provider directly from the GPT with provider credentials when Vishar has a server-owned integration boundary.
- Disabling legacy artist-bound GPTs before unified production acceptance.
- Pretending an interactive provider OAuth/consent step can be completed autonomously when the provider requires the human in its UI.
- Treating the current 57-operation Action surface as complete CRM coverage.
- Forcing Firecrawl-specific concepts into the general CRM authorization model.
- Solving the independent intermittent Supabase backend 401 incident inside this feature.

## Actors and scope

- User/actor: an authenticated, active CRM profile.
- Artist scope: current `artist_memberships` and capability resolution are authoritative.
- Workspace scope: current workspace membership/capability contracts are authoritative for workspace-owned operations.
- GPT application: one profile-bound `vishar-unified-gpt` OAuth application.
- Legacy compatibility: existing artist-bound Vladimir and Kristina GPT clients remain active until separately retired.
- Provider integrations: all provider account identity, tokens, routing, secrets and durable ownership stay server-side and Artist/workspace-scoped.
- Environments affected: CI, staging/validation and production activation. Production activation is a separate stage from repository implementation.

## Target capability domains

The product scope follows Vishar capabilities, not current OpenAPI files.

### 1. Context and CRM Core

- list/select accessible Artist context;
- clients: search, read, create/update where permitted;
- enquiries: create, read, update, assign, status transitions, convert to project;
- projects: read/update/status, relevant project metadata and reference relations;
- internal notes and follow-ups;
- other bounded client/project record operations exposed by the CRM UI.

### 2. Scheduling and Calendar

- appointments/sessions: list, read, schedule, reschedule, cancel, status;
- conflict checks;
- availability/time off;
- consultation/session distinctions and multi-session workflows where supported;
- Google Calendar-backed status/sync operations through the Vishar Calendar boundary;
- safe connection/status diagnosis without exposing Google credentials.

### 3. Finance and Payments

- project estimates and finance visibility;
- deposit requirement/status and grouped or multi-session deposit behavior;
- payment requests and cancellations;
- legitimate manual payment recording;
- Monzo reconciliation: candidates, match, ignore, confirm/settle according to the authoritative finance workflow;
- payment destinations/routes and safe status where user-manageable;
- no raw provider account/transaction identity unless an existing reviewed product contract explicitly requires it.

### 4. Communications

- provider-neutral conversation/inbox reads where available;
- WhatsApp conversation creation/linking, message history and outbound queueing;
- Gmail history search, thread read, draft creation, approval/send pipeline and delivery history;
- Instagram conversation/history/reply once the provider integration is approved and its production contract is active;
- channel-labelled unified communication context rather than provider-specific identity supplied by the model;
- future client-facing Telegram or other channels only through the same communication authority model.

### 5. Notifications, Follow-ups, Templates and Automations

- notification reads, acknowledgement/state actions exposed to a user;
- follow-up creation/update/completion/cancellation/snooze where supported;
- Notification/Template Studio: list/read templates, preview rendered output, edit approved fields, manage language/channel/purpose, enable/disable, rule timing and scheduling behavior;
- automation rules: list/read/create/update/enable/disable where the UI permits and the typed server contract exists;
- automation history/health/recovery operations that are user-facing and safe;
- consent/suppression rules remain server-authoritative and cannot be bypassed by GPT wording.

### 6. Integrations, Booking Sources, Team and Workspace

- list integration status and safe diagnostics;
- initiate supported connect/reconnect/disconnect flows, subject to unavoidable provider UI/OAuth handoff;
- enable/disable/configure safe non-secret integration metadata where a reviewed server contract exists;
- Gmail, Calendar, WhatsApp, Instagram, Telegram, Monzo and future integration management through Vishar, never raw credentials;
- booking source/hosted-form settings exposed to authorized users;
- Artist/workspace membership, team and capability administration where the current user is authorized;
- workspace settings and other user-facing administration through bounded operations;
- no secret values, raw encrypted bindings or arbitrary provider configuration blobs.

### 7. Web Research and Project References

Firecrawl is an implementation provider behind Vishar Research, not a standalone GPT identity.

The intended product surface includes:

- transient `deep_web_search`;
- `read_web_page` with bounded structured extraction;
- bounded `crawl_website`;
- Project Web References attached to tattoo projects with stable tattoo-oriented extraction, artist notes/decisions and reanalysis;
- later multi-reference project synthesis after single-reference acceptance;
- persistent generic Research runs/sources/snapshots for Competitors, Studios, Pricing, SEO and Market research;
- repeat and compare over time;
- later bounded recurring monitoring with kill switches and last-known-good preservation.

Private CRM/client data MUST NOT be sent to Firecrawl.

## Action-domain architecture

The Custom GPT Action transport MUST be modular and expandable.

- A single OAuth application identity is shared by all Vishar Action domains.
- Every domain uses the same server-owned profile/workspace/Artist context and capability layer.
- The current repository-enforced hard ceiling is 30 operations per imported OpenAPI schema.
- New/reshaped schemas SHOULD target no more than 25 operations so every domain retains capacity for normal product evolution.
- A domain reaching 26+ operations MUST trigger a repartition review before adding unrelated capability.
- No schema may be treated as the canonical product boundary. A transport-neutral operation inventory is canonical and import schemas are projections of it.
- The historical three-domain design, Core / Operations / Communications, is the minimum correction from the current two-domain regression. Full operator parity may require additional domain schemas such as Finance, Automation/Admin and Research.
- Domain splitting MUST be semantic. Do not replace many narrow authorized operations with one arbitrary `execute`, arbitrary RPC or generic SQL endpoint merely to evade editor limits.
- All imported domains must have exact-union tests: unique operation IDs, no accidental omissions, no duplicated mutations and consistent OAuth/context rules.

A likely scalable target is:

```text
Vishar GPT
  -> CRM Core
  -> Scheduling
  -> Finance
  -> Communications
  -> Automation & Notifications
  -> Integrations & Admin
  -> Research
```

Exact grouping is an implementation-time inventory decision; the invariants above are mandatory.

## Transport evolution

Custom GPT Actions are the production transport for the current rollout. Vishar domain operations MUST remain transport-neutral so the same authority model can later be exposed through a remote Vishar MCP/App.

MCP/App is a transport evolution, not a second backend and not a second permission system. A future MCP caller must use the authenticated CRM human identity, current memberships/context and the same capability checks. The Action surface remains a compatibility adapter until a later migration is explicitly accepted.

## User scenarios

### Scenario 1: User with one accessible Artist

Given an authenticated CRM user has access to exactly one active Artist, when the unified GPT needs artist-scoped CRM data, then the server resolves that Artist without requiring the GPT to supply an Artist identity to ordinary business actions.

### Scenario 2: User with multiple accessible Artists

Given an authenticated CRM user has access to multiple active Artists and no current selection, when the GPT requests context, then it receives only the accessible Artist choices and must select one through the dedicated context action before artist-scoped work continues.

### Scenario 3: Full CRM workflow

Given a valid active Artist context and sufficient capabilities, when the user asks the GPT to perform a workflow they could perform in CRM, such as review an enquiry, update a project, schedule sessions, request a deposit and add a follow-up, then the GPT may compose several bounded tools while preserving each operation's server authorization, confirmation and idempotency contract.

### Scenario 4: Cross-channel communications

Given the artist has supported Gmail, WhatsApp and/or Instagram integrations, when the user asks to review or reply to a client, then the GPT can read the authorized channel history and use the channel's reviewed outbound pipeline without receiving mailbox, WABA, account or token selectors from the model.

### Scenario 5: Integration management

Given the user can manage integrations in CRM, when the user asks the GPT to inspect or change a connection, then the GPT may use safe Vishar integration-management operations. If the provider requires interactive OAuth/consent, the GPT initiates the flow and tells the user exactly what unavoidable UI action remains rather than requesting credentials in chat.

### Scenario 6: Notifications/templates/automations

Given Notification/Template Studio and automation editing contracts are available, when the user asks the GPT to change reminder text or timing, then it previews the resulting configuration and performs only the bounded authorized mutation. Existing sent messages/history remain immutable according to their product contract.

### Scenario 7: Research and project references

Given the user asks for deep public-web work or attaches a public tattoo reference URL, when ordinary web search is insufficient, then the GPT uses Vishar Research. Provider output is untrusted data and cannot itself trigger CRM mutations or change Artist context.

### Scenario 8: High-impact action

Given the GPT is about to send a client message, approve an email, record/settle money, cancel work, alter permissions or perform another consequential mutation, when exact user intent is not established, then the GPT must not execute it. Interaction confirmation supplements, but never replaces, database authorization.

### Scenario 9: Legacy rollback

Given unified production activation fails or must be contained, when the unified client is disabled, then the existing artist-bound GPTs remain available without migration rollback or cross-Artist rebinding.

## Functional requirements

- FR-001: Production architecture MUST support one profile-bound Vishar GPT application for all authorized CRM profiles.
- FR-002: The OAuth client MUST identify the application and MUST NOT itself be authoritative Artist identity in profile-bound mode.
- FR-003: The unified GPT MUST expose a read context action that returns only Artists accessible to the current authenticated profile plus the current valid selection state.
- FR-004: The unified GPT MUST expose a context selection action that revalidates current membership server-side.
- FR-005: Outside the dedicated Artist context route, GPT business actions MUST NOT accept caller-supplied `artist_id`.
- FR-006: Every business action MUST continue to resolve scope through server-side identity/context helpers and capability checks.
- FR-007: The target Action surface MUST be defined by a transport-neutral operation inventory, not by the current two OpenAPI files.
- FR-008: Every import schema MUST remain at or below the repository-enforced 30-operation ceiling and SHOULD target <=25 operations for headroom.
- FR-009: The import split MUST preserve an exact unique union of the intended Custom GPT surface with no duplicate operation IDs.
- FR-010: Communications MUST be a distinct semantic domain again before adding new messaging channels or large unrelated capabilities.
- FR-011: Read-only operations MUST remain non-consequential and mutations/provider sends MUST remain consequential in the OpenAPI contract.
- FR-012: GPT instructions MUST require context resolution before ambiguous artist-scoped work and MUST forbid guessing inaccessible Artist identifiers.
- FR-013: GPT instructions MUST require explicit user intent for high-impact actions such as outbound client messages, email approval/send, payment settlement, cancellation and permission changes.
- FR-014: Production onboarding documentation MUST describe the profile-bound unified client as the target architecture and legacy artist-bound clients as rollback compatibility only.
- FR-015: Activating the unified GPT MUST NOT disable or mutate the two legacy artist-bound clients in the same step.
- FR-016: Production activation MUST begin from a dormant unified client and enable only capabilities intentionally accepted for the initial surface.
- FR-017: A provider or CRM transport failure MUST be surfaced as a failure and MUST NOT cause the GPT to retry a consequential mutation with altered parameters or switch Artist context automatically.
- FR-018: Gmail, WhatsApp, Instagram, Calendar, Monzo, Telegram and future provider operations MUST route through Vishar-owned integration boundaries and current Artist/workspace ownership.
- FR-019: Notification/Template Studio actions MUST be added once their bounded server editing contracts are final and MUST reuse this same identity/capability model.
- FR-020: Web Research, Project Web References, persistent Research and later monitoring MUST reuse the same authenticated identity model and MUST NOT create a Firecrawl-specific authorization path.
- FR-021: The implementation MUST maintain an explicit operator-parity matrix mapping CRM/UI capabilities to GPT exposure, deliberate UI-only boundary or not-yet-implemented gap.
- FR-022: New CRM user-facing capabilities SHOULD include the corresponding GPT/MCP domain-contract decision in their feature acceptance, so parity does not drift again.
- FR-023: Domain operations MUST remain reusable by a future remote Vishar MCP/App without moving authorization into the transport layer.

## Security and trust requirements

- SR-001: Supabase Auth identity, active profile state, current memberships and server-side capability checks remain authoritative for every action.
- SR-002: `/v1/context` is the only reviewed GPT route allowed to accept `artist_id`, and that value is a selector subject to server revalidation, not authority.
- SR-003: GPT business operations MUST use the caller's authorized identity boundary and MUST NOT use a broad service credential to bypass user capability checks.
- SR-004: The caller MUST NOT supply OAuth client id, integration key, provider route, capability name, SQL, arbitrary RPC name, service credential or raw provider credential through a GPT Action request.
- SR-005: OAuth/client/provider secrets and Worker bridge secrets remain server/editor-side and MUST NOT be committed, logged, stored in browser-readable CRM records or pasted into documentation/chat.
- SR-006: Artist selection MUST fail closed on ambiguity, revocation, inactive Artist or inactive profile.
- SR-007: A capability advertised by a tool MUST still fail closed when the database client ceiling or current CRM membership/capability denies it.
- SR-008: Legacy fixed-Artist clients MUST remain unable to select or operate on another Artist.
- SR-009: External provider routing remains server-owned after GPT context resolution.
- SR-010: Provider OAuth/login/consent requirements MUST never be bypassed by asking the user to expose credentials to the GPT.
- SR-011: Untrusted Gmail/message/web/research content MUST be treated as data and MUST NOT become authority to invoke a second tool, change context or broaden permissions.

## Failure and recovery behavior

- Missing/expired OAuth token: require reconnect rather than anonymous fallback.
- No valid Artist selection where multiple Artists are accessible: return explicit selection-required state.
- Revoked Artist access: refuse immediately; do not auto-select another Artist.
- Capability denied: return bounded authorization error without exposing internal policy detail.
- Concurrent record change: refresh/re-read before retrying mutation.
- Supabase/provider transient failure: report transient failure. Consequential retries preserve identical intent and idempotency identity where supported.
- Provider interactive step required: return the exact safe handoff step; do not request provider secrets in chat.
- Unified rollout problem: disable/leave dormant the unified client while preserving legacy artist-bound GPTs.
- One Action domain unavailable: fail that domain explicitly rather than routing to an unrelated generic execution surface.

## Data and retention expectations

The feature reuses the profile-bound GPT client, per-profile Artist context and action receipts. Additional product modules retain their own authoritative storage and retention rules. GPT transport does not become a second datastore.

Selected Artist context remains private server-side state. OAuth/provider secrets are never stored in GPT-readable CRM records. Bounded action receipts remain durable evidence for idempotent GPT mutations where applicable.

Research persistence follows `specs/web-research/`; communication persistence follows `specs/unified-communications/`; notification/template/automation persistence remains authoritative in their CRM contracts.

## Acceptance criteria

- AC-001: Repository contract tests prove `artist_id` appears only in the dedicated context route across GPT business schemas.
- AC-002: A profile with two accessible Artists cannot perform artist-scoped GPT work until one valid Artist is selected.
- AC-003: Revoking the selected Artist membership invalidates subsequent GPT access without fallback.
- AC-004: Legacy Vladimir/Kristina GPT clients remain functional while the unified client is dormant/validated.
- AC-005: Production onboarding/runbook consistently describe one profile-bound unified GPT as target.
- AC-006: GPT v2 instructions contain context-selection, read-before-write, high-impact confirmation and safe failure behavior.
- AC-007: Current two-schema `28 + 29` state is explicitly treated as a capacity problem, not as the final architecture.
- AC-008: Before new large capability additions, the action surface is repartitioned into semantic domains with <=30 operations each and target headroom <=25 where practical.
- AC-009: A parity inventory covers every current CRM capability domain: Clients, Enquiries, Projects, Sessions, Finance, Communications, Integrations, Booking Sources, Notifications, Automations, Team and Workspace.
- AC-010: The parity inventory separately covers Gmail, WhatsApp, Instagram, Calendar, Monzo and Telegram integration actions and classifies each as available, intentionally UI-only or implementation gap.
- AC-011: Web Research coverage includes transient deep research, Project Web References, persistent saved Research/compare and later monitoring, not only three Firecrawl calls.
- AC-012: Exact-head required CI is green on each implementation increment.
- AC-013: Before production activation, fresh readback proves the unified production client is profile-bound and intentionally dormant while legacy clients remain active.
- AC-014: Production acceptance proves one real authenticated user can resolve context and perform representative read/write operations across each enabled domain without cross-Artist leakage.
- AC-015: Provider acceptance proves communications/integration actions route only through the selected Artist's authorized provider state.
- AC-016: Final cutover does not proceed while infrastructure failures make authorization/transport defects materially indistinguishable unless containment is proven.

## Dependencies and constraints

- Existing profile-bound authorization foundation from migration `0084` and later production lineage.
- Existing CRM capability registry and Artist/workspace membership model.
- Existing production GPT Worker and OAuth relay/PKCE bridge.
- Current Custom GPT Action editor constraints; repository tests enforce a 30-operation maximum per imported schema.
- The current OpenAI product allows a GPT to use Apps or Actions, not both simultaneously; current rollout therefore keeps supported providers behind Vishar Actions rather than mixing direct GPT Apps with Vishar Actions.
- Future full-write custom MCP/App availability may depend on ChatGPT plan/workspace capabilities and is not a blocker for the Actions rollout.
- External provider OAuth/consent steps may still require the human where providers require interactive UI.
- The independent Supabase intermittent 401 incident must be considered before final production cutover.

## Open questions

- Exact semantic repartition and operation counts must be produced from a fresh current operation/parity inventory before the next Builder import. The grouping must preserve the domain/capacity invariants above.
- Which integration-management mutations can be safely exposed depends on current server contracts; missing safe contracts become bounded implementation tasks, not generic provider endpoints.
- Binary file upload/device-local operations may remain UI-only unless a safe GPT upload contract is explicitly designed.

## Requirement changes

- 2026-08-30: Scope correction. Unified GPT v2 target is full authorized Vishar CRM operator parity, not only the current 57 Core/Operations operations. Historical Core/Operations/Communications modularity is restored as a minimum architecture requirement; future Finance, Automation/Admin and Research domains may be separate schemas.
- 2026-08-30: Notification/Template Studio is a required future Unified GPT domain once its server editing contract is finalized.
- 2026-08-30: Firecrawl scope clarified to include transient Web Research, Project Web References, persistent Research/compare and later monitoring under one Vishar Research capability.
- 2026-08-30: Remote Vishar MCP/App remains the long-term reusable transport over the same domain contracts, while Custom GPT Actions remain the current production adapter.
