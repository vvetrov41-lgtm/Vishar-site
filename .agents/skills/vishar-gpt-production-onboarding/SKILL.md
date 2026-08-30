---
name: vishar-gpt-production-onboarding
description: Safely prepare, validate, activate, diagnose, or roll back the Vishar CRM Unified GPT production integration. Use for Custom GPT OAuth, production Action schemas, profile-bound Artist context, capability activation, GPT Builder imports, and legacy-to-unified transition.
---

# Vishar GPT production onboarding

Use this skill for any production or staging work involving the Vishar CRM Custom GPT, its OAuth client, GPT Action schemas, Artist context or capability activation.

The target architecture is one **profile-bound** Vishar GPT. Legacy Vladimir/Kristina artist-bound GPT clients are compatibility/rollback only.

## 1. Mandatory fresh-check

Before any write or production mutation, establish from current systems:

1. canonical branch and exact SHA;
2. relevant GPT branch/PR head and mergeability;
3. exact-head required CI;
4. production Supabase project and migration head;
5. `crm_private.gpt_action_clients` mode/configuration state without printing secrets;
6. current Cloudflare GPT Worker version, routes/custom domains, workers.dev/preview exposure, bindings, rate limit and enable flags;
7. Supabase OAuth discovery/current fixed callback behavior;
8. current external Custom GPT configuration when accessible.

Do not use old PR bodies, historical release branches or this skill as live-state evidence.

## 2. Identity invariant

Target flow:

```text
Custom GPT
  -> one confidential OAuth application
  -> auth.uid() CRM profile
  -> current Artist memberships
  -> server-owned active Artist context
  -> GPT client capability ceiling
  -> operation-specific CRM capability
  -> Artist-scoped action
```

For `vishar-unified-gpt`:

- `binding_mode` must be `profile`;
- `artist_id` must be null;
- OAuth client id identifies the application, never an Artist;
- Artist selection is allowed only through `public.gpt_artist_context` via `/v1/context`;
- every later business action revalidates the current context and capability.

Never make OAuth client id or a caller-supplied Artist id authoritative routing data.

## 3. Legacy compatibility

Production may still contain:

- `vladimir-gpt-actions` fixed to Vladimir;
- `kristina-gpt-actions` fixed to Kristina.

Keep them active while unified GPT is being activated and accepted. Do not repoint, disable or delete them in the same mutation that enables the unified client.

A unified rollout failure should first be contained by disabling the unified client/capability, not by changing legacy bindings.

## 4. Repository contract

Read and validate at the exact target ref:

- `specs/unified-gpt-v2/spec.md`
- `specs/unified-gpt-v2/plan.md`
- `docs/crm/gpt-actions-production-runbook.md`
- `docs/gpt-actions/instructions.v2.md`
- `workers/lib/gpt-actions-combined.js`
- `workers/lib/gpt-full-actions.js`
- `docs/gpt-actions/openapi.production.core.yaml`
- `docs/gpt-actions/openapi.production.operations.yaml`
- `scripts/test-gpt-production-config.mjs`
- `scripts/test-gpt-openapi-split.mjs`

The schemas must use the same OAuth edge. `artist_id` is forbidden outside `/v1/context`. No generic SQL/RPC/provider-routing action may exist.

## 5. OAuth and secret custody

The fixed production Worker callback is:

`https://gpt-actions.vishartattoo.com/oauth/callback`

The Custom GPT uses:

- authorization: `https://gpt-actions.vishartattoo.com/oauth/authorize`
- token: `https://gpt-actions.vishartattoo.com/oauth/token`
- privacy: `https://gpt-actions.vishartattoo.com/privacy`

The confidential OAuth client secret must go directly from its creation surface to the Custom GPT editor. Never put it in chat, GitHub, SQL, documentation or logs.

`GPT_OAUTH_BRIDGE_SECRET` remains a Cloudflare secret. Never read or print its value. Verify presence/state only through safe metadata when required.

Do not weaken S256 PKCE or redirect validation to make the GPT editor work.

## 6. Capability activation

The unified client ships dormant. Before activation verify that state directly.

Enable only the intended GPT client ceilings through an authorized audited path. Current logical ceilings include appointment read/manage, enquiry read, CRM management, finance and communications.

A client ceiling never grants more than the signed-in user's current Artist capability. Test both layers.

Never directly update private GPT tables merely to bypass the owner/audit configuration boundary.

## 7. Action imports and model instructions

One Custom GPT imports both exact-SHA schemas:

- Core
- Operations

Apply `docs/gpt-actions/instructions.v2.md` to the GPT. Both Action sets use the same OAuth application.

After import verify:

- operation IDs match repository tests;
- context actions are present in Core;
- no `artist_id` appears outside the context route;
- reads are non-consequential;
- writes/provider sends are consequential;
- payment/message/email confirmation wording remains intact.

## 8. Acceptance order

Read-only first:

1. authenticate as a legitimate CRM profile;
2. get Artist context;
3. if required, select one accessible Artist;
4. prove an inaccessible Artist cannot be selected;
5. read representative clients/enquiries/projects/appointments;
6. switch context only through the selector and prove isolation.

Only then use consequential actions through legitimate real work. Do not create synthetic production customers, payments or messages just for testing.

For any ambiguous transport failure after a consequential call, read authoritative state before retrying. Preserve the same idempotency/request id only for an identical retry.

## 9. Known independent infrastructure incidents

Before final cutover, reassess any current intermittent Supabase authorization/transport incident. A transient backend 401 can resemble a GPT authorization defect. Do not declare unified production acceptance while those two failure classes cannot be reliably distinguished, unless a stronger containment/diagnostic boundary has been proven.

## 10. Historical workflows

`gpt-production-bootstrap.yml` and `gpt-production-activate.yml` were created for historical artist-bound release branches. Treat them as historical evidence, not as the v2 activation path. Do not move old release branches to reuse them.

If GPT Worker code itself needs a new production deploy, create/use a bounded current-lineage release path with current Cloudflare preflight/readback and exact-head CI. Client/OAuth activation is a separate control-plane stage.

## 11. Future extensions

Notification/template editing and Web Research must reuse the same profile-bound OAuth and selected Artist context. Do not create another GPT, OAuth client per Artist, or provider-specific authorization system for those features.

## 12. Required completion evidence

A production GPT task is complete only when applicable evidence includes:

- exact repository SHA;
- exact-head CI;
- production migration head;
- non-secret unified/legacy client readback;
- Cloudflare Worker/routes/bindings/flags readback;
- external GPT schema/auth configuration readback where accessible;
- authenticated context E2E;
- authorization denial E2E;
- rollback state preserved.
