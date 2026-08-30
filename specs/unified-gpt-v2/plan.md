# Implementation Plan: Unified GPT v2

## Specification

- Spec: `specs/unified-gpt-v2/spec.md`
- Target repository: `vvetrov41-lgtm/Vishar-site`
- Scope-correction branch: `agent/unified-gpt-full-surface-plan`
- Verified base branch: `agent/platform-telegram-self-service`
- Verified base SHA for this correction: `d83ac621b77d50f56b92ebee81cecef2a05cc9c5`
- Production Supabase project: `vfjexhfdbrjmuxfdvbdx`
- Production migration head freshly observed during this correction: `0118_enquiry_deposit_conversion`

## Why this plan is being corrected

The first Unified GPT v2 increment correctly fixed identity and onboarding guidance, but it incorrectly treated the current two ChatGPT import schemas as the intended product surface. Current production artifacts contain 57 operations split as Core 28 plus Operations 29, while repository tests enforce a maximum of 30 operations per import schema.

Historical work already solved this class of problem differently: PR #364 introduced Core / Operations / Communications, and PR #374 carried the unified user-context design with 25 / 25 / 12 operations. The original platform roadmap also defines a broader capability registry covering Clients, Enquiries, Projects, Sessions, Finance, Communications, Integrations, Booking Sources, Notifications, Automations, Team and Workspace.

Therefore this correction restores the product target: one Unified GPT should approach authorized operator parity with the CRM, while OpenAPI schemas are only bounded transport projections.

## Constitution check

- Server authority: only the dedicated context route may accept an Artist selector; business/provider operations derive scope and routing server-side.
- Authorization before capability: profile/workspace/Artist membership selects reachable scope, then GPT client ceilings and operation-specific CRM capabilities gate the action.
- No second provider authorization model: Gmail, Meta, Google Calendar, Monzo, Telegram and Firecrawl remain behind Vishar-owned boundaries.
- Exact-head evidence: implementation, merge and rollout use immutable SHAs and fresh production readback.
- Secret custody: OAuth, provider and Worker secrets stay outside repository/chat/browser-readable database payloads.
- Deployment is separate evidence: repository contract work does not activate `vishar-unified-gpt`.
- Bounded/reversible rollout: legacy Vladimir/Kristina GPT clients remain active until unified acceptance.
- Transport neutrality: Actions and future MCP/App use the same domain contracts and permission layer.

## Fresh current-state evidence

- Canonical branch at correction start: `agent/platform-telegram-self-service` @ `d83ac621b77d50f56b92ebee81cecef2a05cc9c5`.
- Open parallel PR #542 is an Inbox/frontend workstream and does not own Unified GPT spec files.
- Production migration head: `0118_enquiry_deposit_conversion`.
- Production GPT clients:
  - `vladimir-gpt-actions`: artist-bound, OAuth configured, active;
  - `kristina-gpt-actions`: artist-bound, OAuth configured, active;
  - `vishar-unified-gpt`: profile-bound, `artist_id IS NULL`, OAuth unconfigured, inactive.
- Current import artifacts: Core 28, Operations 29, same OAuth edge.
- Current Operations schema already contains scheduling, finance plus WhatsApp/Gmail operations; this is a capacity/layout artifact, not a semantic final architecture.
- Current Unified Communications spec covers Gmail, WhatsApp and Instagram as one product communication model.
- Current Web Research spec covers transient deep research, Project Web References, saved Research runs/snapshots/compare and later monitoring.

## Target architecture

```text
                         one authenticated CRM human
                                   |
                            one Vishar OAuth app
                                   |
                         profile / workspace membership
                                   |
                         server-owned Artist context
                                   |
                         capability / policy checks
                                   |
          +------------------------+-------------------------+
          |                        |                         |
   Custom GPT Actions       future Vishar MCP/App       CRM browser UI
          |                        |                         |
          +------------ transport-neutral domains ----------+
                                   |
                           authoritative Vishar backend
                                   |
        CRM + Gmail + WhatsApp + Instagram + Calendar + Monzo
        + Telegram + Notifications/Automation + Research/Firecrawl
```

No transport owns authorization. No provider is exposed directly to the GPT as an authority.

## Operator-parity inventory

Before adding more Builder schemas, produce a machine-readable or testable inventory with one row per meaningful CRM/user operation:

- domain;
- semantic operation name;
- CRM UI availability;
- current server/RPC/Worker contract;
- required capability;
- read vs consequential mutation;
- current GPT exposure;
- intended Action domain;
- future MCP exposure;
- status: available / implementation gap / deliberate UI-only;
- reason for UI-only when applicable.

This inventory becomes the canonical surface contract. OpenAPI schemas are generated/maintained projections from that inventory and may be repartitioned without changing product meaning.

## Domain plan

### Domain A: CRM Core

Includes context plus bounded record operations:

- Artist context discovery/selection;
- clients;
- enquiries;
- projects;
- internal notes;
- follow-ups and other core record operations that do not belong to a more specific domain.

Target import size: <=25 operations after repartition.

### Domain B: Scheduling

- appointments/sessions;
- conflicts;
- reschedule/cancel/status;
- availability/time off;
- consultation/session distinctions;
- multi-session scheduling contracts;
- Google Calendar-backed safe sync/status operations.

Calendar provider identity and credentials remain server-owned.

### Domain C: Finance

- estimates;
- deposit requirement/status;
- payment requests;
- grouped/multi-session deposits;
- manual payment recording;
- Monzo reconciliation list/match/ignore/confirm;
- safe payment destination/routing management when currently user-manageable.

Money movement/settlement remains consequential and idempotent. Provider identifiers are minimized.

### Domain D: Communications

Restore Communications as a separate import domain before extending messaging.

- provider-neutral conversation/inbox reads where contracts exist;
- WhatsApp history/conversation/reply;
- Gmail search/thread/draft/approve-send pipeline/history;
- Instagram history/reply after provider production acceptance;
- future channels through the same provider-neutral model.

Messages and email/web content are untrusted data and cannot authorize follow-up actions.

### Domain E: Notifications and Automations

- notification reads/state actions;
- follow-up lifecycle/snooze where separate from Core;
- notification templates;
- template preview;
- allowed template fields/language/channel/purpose;
- notification timing/rules;
- automation rule create/update/enable/disable;
- user-facing history/health/recovery.

This domain is implemented only after Notification/Template Studio's server editing contract is final. Existing consent/suppression gates remain authoritative.

### Domain F: Integrations and Admin

- safe integration status/health;
- initiate connect/reconnect/disconnect where supported;
- safe non-secret integration configuration;
- Gmail, Calendar, WhatsApp, Instagram, Telegram, Monzo integration administration;
- booking sources / hosted-form settings;
- team/Artist/workspace membership and capability administration;
- workspace settings exposed to authorized users.

Interactive provider OAuth/consent is an explicit handoff boundary, not a reason to expose credentials to GPT.

### Domain G: Research

Under `specs/web-research/`:

Phase V:
- `deep_web_search`;
- `read_web_page`;
- bounded `crawl_website`.

First persistent CRM slice:
- Project Web References;
- tattoo-oriented extraction;
- source analysis vs artist decisions;
- reanalysis and last-known-good preservation;
- later multi-reference synthesis.

Persistent generic Research:
- Competitors;
- Studios;
- Pricing;
- SEO;
- Market research;
- saved definitions, sources and snapshots;
- rerun and compare;
- later recurring monitoring.

Firecrawl is a provider adapter only. Private CRM/client data is never sent to it.

## Action capacity and Builder strategy

Repository evidence proves the current 28/29 split is too close to the 30-operation schema ceiling.

Rules:

1. hard maximum per imported schema: 30 operations, enforced by repository tests;
2. design target: <=25 operations per schema where practical;
3. 26+ operations triggers repartition review before unrelated additions;
4. no duplicate `operationId` across imported schemas;
5. exact union tests prove the intended current Action surface;
6. one common OAuth application/context boundary across all domains;
7. domains are semantic, not arbitrary count buckets;
8. never add a generic `executeRpc`, `executeSql`, provider proxy or arbitrary command to bypass limits.

The immediate correction is to restore Communications as a separate schema and then perform a full operation inventory before deciding whether current Core/Operations are further split into Scheduling and Finance immediately or in the next bounded increments.

## Server/Worker layer

- Preserve `/v1/context` as the sole Artist selector.
- Preserve user-token/profile-bound authorization and database capability checks.
- Introduce/restore separate semantic Action hostnames/schemas as needed while keeping one reviewed Worker/router architecture where safe.
- Keep provider routing derived from authoritative CRM records/integration configuration.
- Add generic domain registry/inventory tests before expanding the surface.
- Any missing operation gets a narrow named server contract, not a broad proxy.

## CRM/UI parity process

For each current/future CRM feature:

1. identify the user-visible actions;
2. map read/write capabilities;
3. decide GPT/MCP exposure;
4. if exposed, add a named server contract plus denial tests;
5. if UI-only, document why;
6. update parity inventory and exact-union tests.

This applies especially to the currently missing areas: Instagram GPT communication tools, Notification/Template Studio, automation management, integration administration, team/workspace management, booking sources and Research.

## External integrations

### Gmail

Read/search/thread access and draft/approval/send stay behind the existing artist-scoped Gmail service. The GPT never chooses a mailbox or receives OAuth tokens.

### WhatsApp

Conversation/history/send and future integration administration derive WABA/phone/provider routing server-side. No raw Meta identifiers or credentials become GPT selectors.

### Instagram

Add read/reply and safe connection management only after the actual provider integration is production-accepted. Reuse unified communication models and Artist context.

### Google Calendar

Expose schedule/sync/status operations through the Calendar boundary; provider OAuth state remains server-side.

### Monzo

Expose the authoritative finance/reconciliation workflow, including match/ignore/confirm separation. No generic bank API proxy.

### Telegram

Internal notification/integration management follows existing personal/workspace destination contracts. Client-facing Telegram, if ever added, belongs to Communications and requires an explicit product contract.

### Firecrawl

Only the Vishar Research gateway holds the provider credential and provider-specific API mapping.

## Notification/Template Studio integration

Notification/template editing is now a required Unified GPT domain, not an optional idea.

Before GPT exposure, the CRM feature must establish bounded server contracts for:

- list/get templates;
- preview rendering with allowed variables;
- edit approved fields;
- language/channel/purpose constraints;
- enable/disable;
- timing/rule changes;
- version/history semantics;
- behavior for already scheduled notifications;
- activity/audit.

Once those contracts are stable, GPT tools are added without redesigning identity.

## Research integration

Web Research is broader than three Firecrawl calls. The GPT workstream must consume the existing `specs/web-research/` phases rather than reducing them to a single Action schema.

Research rollout order:

1. transient gateway;
2. GPT Research schema and real public-source acceptance;
3. Project Web References;
4. saved generic Research and comparisons;
5. only then recurring monitoring.

## MCP/App evolution

Historical Phase Q-R established the intended direction: transport-neutral CRM domain contracts, then a remote MCP surface over the same capability layer.

For the current rollout, Custom GPT Actions remain primary because they are already deployed and support the user's current workflow. The domain contracts must nevertheless remain reusable by a future Vishar MCP/App.

Current OpenAI product documentation states that a GPT uses Apps or Actions, not both simultaneously, so provider capabilities required by this Custom GPT remain behind Vishar Actions rather than mixing direct provider Apps into the same GPT. Full-write custom MCP/App availability is a future transport decision and must be rechecked at rollout time.

## Test strategy

### Surface inventory

- parity inventory covers all capability-registry domains;
- every current Action operation appears exactly once;
- every intended missing area is explicit rather than silently absent;
- schema counts and headroom are asserted.

### Authorization

- context ambiguity/revocation;
- capability ceilings;
- cross-Artist denial;
- workspace-scoped admin denial;
- provider isolation;
- no caller-controlled provider route/credentials.

### Consequential actions

- confirmation metadata/classification;
- idempotency where relevant;
- read-before-write/version checks;
- no parameter-changing retry after uncertain transport result.

### Provider content

- Gmail/message/Instagram/Firecrawl content cannot drive privileged tool use;
- no private CRM fields cross the Firecrawl boundary;
- provider failure is explicit.

### Required CI

Each bounded increment requires exact-head repository validation appropriate to the changed layers, at minimum Static Validation and CRM/booking validation for GPT/server contracts, plus focused provider validations where touched.

## Rollout plan

### Stage 1: correct the durable product contract

- merge this spec/plan/tasks correction after exact-head CI;
- do not create Unified OAuth or mutate production during this documentation correction.

### Stage 2: operation/parity inventory and repartition

- fresh-check canonical head and current CRM capability/UI surface;
- build the parity inventory;
- restore Communications import schema;
- repartition current 57 operations so schemas have sustainable headroom;
- keep exact union and same OAuth/context tests;
- deploy only transport changes needed for the new Action domains;
- read back domains/routes and run legacy GPT regression.

### Stage 3: Unified GPT base activation

- fresh-check production DB/Cloudflare/OAuth/Builder and intermittent 401 state;
- create one confidential OAuth client for `vishar-unified-gpt`;
- bind only its non-secret id and enable explicitly accepted capabilities;
- configure one new Custom GPT with the modular exact-SHA Action schemas;
- keep legacy Vladimir/Kristina GPTs active;
- read-only cross-domain acceptance first, then legitimate consequential operations.

### Stage 4: close operator-parity gaps

Bounded increments for:

- Instagram communications;
- Notifications/Templates/Automations;
- Integrations/Admin/Booking Sources/Team/Workspace;
- any missing finance/scheduling/core UI actions.

Each is production-complete only after code, exact-head CI, deployment, readback and actual acceptance.

### Stage 5: Research

Implement `specs/web-research/` in its own staged releases, attaching the Research domain to the same Unified GPT OAuth/context.

### Stage 6: MCP/App transport

When the product/account/runtime path is appropriate, expose the same reviewed domain operations through Vishar remote MCP/App. Do not rewrite permission or provider ownership rules for MCP.

### Stage 7: legacy retirement

Only after Unified GPT covers the intended operator surface and has stable production evidence, retire the artist-bound GPTs in a separate reversible workstream.

## Rollback/reference plan

- Unified client can be disabled while legacy GPTs stay active.
- Each Action domain can be removed/disabled without changing database authority.
- Provider/domain kill switches remain preferred containment where available.
- Do not revoke shared OAuth solely for one domain defect unless credential compromise requires it.
- Research provider disablement preserves saved evidence.
- No destructive backward migration for ordinary GPT rollback.

## Risks

| Risk | Consequence | Mitigation |
| --- | --- | --- |
| Current 28/29 split treated as final | Immediate capacity failure when adding features | Restore modular domains and <=25 target headroom |
| Full-access request interpreted as generic backend access | Severe authorization/security regression | Named semantic tools only, no SQL/RPC/provider proxy |
| Missing CRM feature silently absent from GPT | GPT diverges from operator workflow | Mandatory parity inventory and feature-level parity decision |
| Communications mixed back into Operations | Messaging expansion consumes unrelated domain capacity | Dedicated Communications schema |
| Provider credentials exposed to achieve parity | Credential/privacy incident | Vishar-owned provider boundaries and interactive OAuth handoff |
| Instagram/Research content prompt injection | Cross-tool action manipulation | Treat external content as untrusted data |
| Notification/template edits alter historical sends | Audit inconsistency | Finalize version/scheduled-item semantics before GPT tools |
| Custom GPT editor limits change | Import/deployment failure | Fresh-check vendor control plane; keep transport-neutral contracts |
| MCP treated as second backend | Duplicated permissions and drift | Same domain contracts/capability layer, transport only |
| Supabase intermittent 401 | False GPT authorization diagnosis | Keep as explicit cutover condition and validate transport separately |

## Plan completion gate

Before the next Builder/OAuth mutation:

- full operator-parity scope is merged;
- current 57-operation surface and CRM UI capability inventory are reconciled;
- Communications is restored as a semantic domain;
- every import schema is under the hard editor limit with sustainable headroom;
- missing integration/admin/template/research capabilities are explicit tasks;
- exact current Cloudflare/OAuth/Builder state is freshly read back;
- legacy GPT rollback remains intact.
