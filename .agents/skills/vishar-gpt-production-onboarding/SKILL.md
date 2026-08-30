---
name: vishar-gpt-production-onboarding
description: Safely prepare, validate, activate, diagnose, or roll back the Vishar CRM Unified GPT production integration. Use for Custom GPT OAuth, modular production Action schemas, profile-bound Artist context, capability activation, GPT Builder imports, provider-domain integration, and legacy-to-unified transition.
---

# Vishar GPT production onboarding

Use this skill for any production or staging work involving the Vishar CRM Custom GPT, its OAuth client, GPT Action schemas, Artist context, capability activation, provider-domain surface or Builder rollout.

The target architecture is one **profile-bound** Vishar GPT with modular semantic Action domains and authorized CRM operator parity. Legacy Vladimir/Kristina artist-bound GPT clients are compatibility/rollback only.

## 1. Mandatory fresh-check

Before any write or production mutation, establish from current systems:

1. canonical branch and exact SHA;
2. relevant GPT branch/PR head and mergeability;
3. exact-head required CI;
4. production Supabase project and migration head;
5. `crm_private.gpt_action_clients` mode/configuration state without printing secrets;
6. current Cloudflare GPT Worker version, routes/custom domains, workers.dev/preview exposure, bindings, rate limit and enable flags;
7. Supabase OAuth discovery/current fixed callback behavior;
8. current external Custom GPT configuration when accessible;
9. current operator-parity inventory and intended Action-domain split.

Do not use old PR bodies, historical release branches or this skill as live-state evidence.

## 2. Identity invariant

Target flow:

```text
Custom GPT
  -> one confidential OAuth application
  -> auth.uid() CRM profile
  -> current workspace / Artist memberships
  -> server-owned active Artist context
  -> GPT client capability ceiling
  -> operation-specific CRM capability
  -> bounded Vishar domain operation
```

For `vishar-unified-gpt`:

- `binding_mode` must be `profile`;
- `artist_id` must be null;
- OAuth client id identifies the application, never an Artist;
- Artist selection is allowed only through `public.gpt_artist_context` via `/v1/context`;
- every later business/provider action revalidates current context and capability.

Never make OAuth client id or caller-supplied Artist id authoritative routing data.

## 3. Operator-parity invariant

The intended GPT surface is not defined by the OpenAPI files that happen to exist today.

For each meaningful action available in CRM or a supported Vishar integration, classify it as:

- GPT/MCP exposed through a narrow named domain contract;
- deliberate UI-only because of unavoidable interactive provider/device behavior; or
- an explicit implementation gap.

Accidental missing tool coverage is not steady state.

Never create arbitrary SQL, arbitrary RPC, generic provider proxy or broad `execute` actions to fill parity gaps.

## 4. Legacy compatibility

Production may still contain:

- `vladimir-gpt-actions` fixed to Vladimir;
- `kristina-gpt-actions` fixed to Kristina.

Keep them active while unified GPT is being activated and accepted. Do not repoint, disable or delete them in the same mutation that enables the unified client.

A unified rollout failure should first be contained by disabling the unified client/capability/domain, not by changing legacy bindings.

## 5. Repository contract

Read and validate at the exact target ref:

- `specs/unified-gpt-v2/spec.md`
- `specs/unified-gpt-v2/plan.md`
- `specs/unified-gpt-v2/tasks.md`
- `specs/unified-communications/`
- `specs/web-research/`
- current operator-parity inventory once implemented
- `docs/crm/gpt-actions-production-runbook.md`
- `docs/gpt-actions/instructions.v2.md`
- current GPT Worker/router code
- every production OpenAPI import schema at the target ref
- current GPT production config and Action-surface tests

The schemas use one OAuth application identity. `artist_id` is forbidden outside `/v1/context`. No generic SQL/RPC/provider-routing action may exist.

## 6. Action-domain capacity

Repository tests currently enforce a hard maximum of 30 operations per imported ChatGPT Action schema. The design target is <=25 operations per semantic domain where practical.

A domain at 26+ operations requires repartition review before unrelated features are added.

The historical minimum modular architecture is Core / Operations / Communications. Full operator parity may require clearer domains such as:

- CRM Core;
- Scheduling;
- Finance;
- Communications;
- Automation & Notifications;
- Integrations & Admin;
- Research.

Exact grouping comes from the current parity inventory, not from stale operation counts.

Required invariants:

- all domains use the same Unified GPT OAuth application;
- operation IDs are globally unique;
- exact-union tests prove intended coverage;
- domain movement does not change database authorization/provider ownership;
- context is present where the model needs it without introducing Artist selectors into ordinary actions;
- no schema is considered the canonical product boundary.

Do not begin a new Builder import if current schemas merely fit under 30 but have no sustainable headroom for the accepted scope.

## 7. Provider-domain boundaries

### Gmail

Resolve only the authorized active-Artist mailbox through Vishar. No mailbox selector or Google token from GPT.

### WhatsApp

Resolve conversation and Meta route server-side. No WABA/phone/provider credential selector from GPT.

### Instagram

Expose communication actions only after the provider integration is production-accepted and through the unified Communications authority model.

### Calendar

Scheduling/sync/status use the Vishar Calendar boundary; Google OAuth remains server-side.

### Monzo

Use the authoritative finance/reconciliation contracts, not a generic bank API proxy.

### Telegram

Use reviewed personal/workspace integration/notification contracts. Client-facing Telegram requires its own explicit Communications product contract.

### Firecrawl / Research

Firecrawl is a provider behind Vishar Research. The Research domain includes transient deep research, Project Web References, persistent Research/compare and later monitoring. Private CRM/client data never crosses the provider boundary.

## 8. OAuth and secret custody

The fixed production Worker callback is:

`https://gpt-actions.vishartattoo.com/oauth/callback`

Every Custom GPT Action domain uses:

- authorization: `https://gpt-actions.vishartattoo.com/oauth/authorize`
- token: `https://gpt-actions.vishartattoo.com/oauth/token`
- privacy: `https://gpt-actions.vishartattoo.com/privacy`

The confidential OAuth client secret goes directly from its creation surface to the Custom GPT editor. Never put it in chat, GitHub, SQL, documentation or logs.

`GPT_OAUTH_BRIDGE_SECRET` remains a Cloudflare secret. Never read or print its value. Verify presence/state only through safe metadata when required.

Do not weaken S256 PKCE or redirect validation to make the GPT editor work.

## 9. Capability activation

The unified client ships dormant. Before activation verify that state directly.

Enable only the intended GPT client ceilings through an authorized audited path. As operator parity expands, add explicit reviewed ceilings/mappings rather than assuming current legacy booleans grant future domains.

A client ceiling never grants more than the signed-in user's current Artist/workspace capability. Test both layers.

Never directly update private GPT tables merely to bypass owner/audit configuration boundaries.

## 10. Action imports and model instructions

Before external Builder mutation:

1. build/read the current parity inventory;
2. verify modular schemas have sustainable capacity;
3. verify exact global operation union and no duplicates;
4. verify all domains use the same OAuth application/context;
5. import every required exact-SHA schema into the one Unified GPT;
6. apply `docs/gpt-actions/instructions.v2.md`.

After import verify:

- operation IDs match repository tests;
- Artist context works as specified;
- no `artist_id` appears outside context;
- reads are non-consequential;
- writes/provider sends/settlements/permission changes are consequential;
- payment/message/email/integration/template confirmation wording remains intact.

The current Core + Operations pair is a deployed transport snapshot, not a permanent two-schema requirement.

## 11. Notification / Template / Automation extension

Notification/Template Studio is a required Unified GPT extension once the server contract is stable.

It must distinguish template definitions, notification rules/timing, scheduled instances and sent history. Expose only bounded preview/edit/state operations permitted by CRM authorization. Preserve historical sent evidence and follow server-defined rescheduling/version behavior.

Automation tools expose typed reviewed operations only. No generic rule DSL or arbitrary execution surface.

## 12. Research extension

Implement `specs/web-research/` in its staged order:

1. transient Research gateway;
2. Research Action domain;
3. Project Web References;
4. persistent saved Research and comparison;
5. recurring monitoring only after persistent acceptance.

Research shares the Unified GPT identity but generic Research permission does not grant access to another Artist's project references.

## 13. Acceptance order

Read-only first across representative enabled domains:

1. authenticate as a legitimate CRM profile;
2. get Artist context;
3. if required, select one accessible Artist;
4. prove an inaccessible Artist cannot be selected;
5. read representative Core/Scheduling/Finance/Communications/Admin state;
6. prove provider routing follows selected Artist;
7. switch context only through the selector and prove isolation.

Only then use consequential actions through legitimate real work. Do not create synthetic production customers, payments or messages just for testing.

For ambiguous transport failure after a consequential call, read authoritative state before retrying. Preserve the same idempotency/request id only for an identical retry.

## 14. Future Vishar MCP/App

Custom GPT Actions are the current production transport. Domain contracts remain transport-neutral for a future Vishar remote MCP/App.

MCP/App reuses the same user identity, memberships, Artist context, capabilities and provider boundaries. It is transport, not a second permission system.

## 15. Known independent infrastructure incidents

Before final cutover, reassess any current intermittent Supabase authorization/transport incident. A transient backend 401 can resemble a GPT authorization defect. Do not declare unified production acceptance while those failure classes cannot be reliably distinguished unless stronger containment/diagnostics are proven.

## 16. Historical workflows

`gpt-production-bootstrap.yml` and `gpt-production-activate.yml` were created for historical artist-bound release branches. Treat them as historical evidence, not as the v2 activation path. Do not move old release branches to reuse them.

If GPT Worker code needs a production deploy, use a bounded current-lineage release path with current Cloudflare preflight/readback and exact-head CI. Client/OAuth activation is a separate control-plane stage.

## 17. Required completion evidence

A production GPT task is complete only when applicable evidence includes:

- exact repository SHA;
- exact-head CI;
- production migration head;
- non-secret unified/legacy client readback;
- parity inventory and Action-domain counts;
- Cloudflare Worker/routes/bindings/flags readback;
- external GPT schema/auth configuration readback where accessible;
- authenticated context E2E;
- authorization/provider-isolation denial E2E;
- representative enabled-domain acceptance;
- rollback state preserved.
