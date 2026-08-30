# GPT Actions production rollout

This runbook covers the current Vishar CRM target architecture: **one profile-bound Vishar GPT for authenticated CRM users**. The existing Vladimir and Kristina artist-bound GPT clients remain compatibility and rollback surfaces until a later, separately accepted retirement stage.

Do not infer live production state from this file. Before every activation, capability change or external GPT update, perform fresh readback of the exact repository head, production Supabase, Cloudflare GPT edge and the external GPT/OAuth configuration.

## Target identity model

```text
Custom GPT OAuth token
  -> OAuth application: vishar-unified-gpt
  -> auth.uid(): signed-in CRM profile
  -> current Artist memberships
  -> server-owned active Artist context
  -> GPT client capability ceiling
  -> operation-specific CRM capability
  -> Artist-scoped CRM action
```

The OAuth client identifies the **application**, not an Artist. In profile-bound mode, `crm_private.gpt_action_clients.artist_id` is null by design. Artist scope is derived from the signed-in profile and current memberships on every request.

The database, not GPT instructions or OpenAPI, is authoritative.

## Fixed production boundaries

- Production Supabase project: `vfjexhfdbrjmuxfdvbdx`.
- Production CRM origin: `https://crm.vishartattoo.com`.
- Production GPT Core host: `https://gpt-actions.vishartattoo.com`.
- Production GPT Operations host: `https://gpt-operations.vishartattoo.com`.
- Fixed Supabase OAuth callback through the Worker: `https://gpt-actions.vishartattoo.com/oauth/callback`.
- Core schema: `docs/gpt-actions/openapi.production.core.yaml`.
- Operations schema: `docs/gpt-actions/openapi.production.operations.yaml`.
- Model instructions: `docs/gpt-actions/instructions.v2.md`.
- Retained staging must never be used as the production OAuth/database target.
- The GPT Worker forwards the signed-in user's OAuth bearer token plus the production publishable key. It carries no Supabase service-role/secret key for GPT business actions.
- `/v1/context` is the only GPT route allowed to accept an `artist_id`, and the database treats it only as a selector subject to current membership checks.
- No generic SQL, table or arbitrary RPC action exists.
- OAuth/integration credentials, RLS controls, team-security administration and provider secrets are never GPT Actions.

## Production clients

The intended steady-state transition is:

```text
vishar-unified-gpt
  binding_mode = profile
  artist_id = null
  one confidential production OAuth client

legacy rollback compatibility:
  vladimir-gpt-actions -> fixed Vladimir Artist
  kristina-gpt-actions -> fixed Kristina Artist
```

The unified client must start dormant: no OAuth client id, inactive, capability ceilings false. Configure it only after the external OAuth/GPT side and current production edge have been freshly verified.

**Never deactivate or repoint the Vladimir/Kristina legacy clients in the same activation step as the unified client.** Their continued operation is the immediate rollback path.

## Artist context

`public.gpt_artist_context(uuid)` is the narrow context contract.

- Context read returns only Artists the current profile may access plus the valid active selection state.
- Context selection accepts one Artist id returned by the authorized context read and rechecks active profile, active Artist and current membership.
- A profile with multiple accessible Artists and no valid selection fails closed rather than defaulting to the first Artist.
- A stale selection becomes unusable immediately when membership/profile/Artist access is revoked. The server does not silently switch to another Artist.
- Legacy artist-bound GPT clients remain fixed to their configured Artist and cannot use context selection to escape that scope.

Every ordinary business action remains free of caller-supplied `artist_id`.

## Action surfaces

One Custom GPT imports both bounded production Action schemas:

1. **Core** at `gpt-actions.vishartattoo.com`.
2. **Operations** at `gpt-operations.vishartattoo.com`.

Both use the same OAuth application identity and the same server-side Artist context. Repository tests enforce the current per-schema operation bounds, unique operation IDs and exact canonical coverage.

Do not combine Actions with a second provider-specific identity model. Future Notification/Template Studio and Web Research actions must reuse this same authenticated profile/context/capability boundary.

## OAuth and fixed Worker callback

Create one confidential production Supabase OAuth client for `vishar-unified-gpt` when rollout preflight is complete.

Configure the Custom GPT with:

- authorization URL: `https://gpt-actions.vishartattoo.com/oauth/authorize`
- token URL: `https://gpt-actions.vishartattoo.com/oauth/token`
- scope: `email`
- token exchange: Basic authorization header
- privacy policy: `https://gpt-actions.vishartattoo.com/privacy`
- Core and Operations schemas from the same exact repository SHA

The callback displayed by the GPT editor is untrusted input to the relay and is validated by the Worker. Supabase itself receives only the fixed Worker callback:

`https://gpt-actions.vishartattoo.com/oauth/callback`

The OAuth client secret is shown only during creation/rotation and must be entered directly into the external GPT editor. Never put it in GitHub, CRM data, logs, documentation or chat.

## S256 PKCE bridge

Supabase OAuth requires Authorization Code with S256 PKCE. The production Worker preserves that boundary for GPT clients that do not supply a PKCE challenge themselves:

1. GPT calls `/oauth/authorize` with Client ID, validated callback and `state`.
2. Worker generates a verifier and S256 challenge, substitutes the fixed Worker callback and forwards the authorization request to Supabase.
3. GPT callback, original state, client ID, verifier and expiry remain only inside authenticated encrypted bridge state.
4. Supabase returns the authorization code to the fixed Worker callback.
5. Worker returns an opaque bridge code to the validated GPT callback.
6. GPT exchanges the bridge code at `/oauth/token` with its confidential client credentials.
7. Worker restores the Supabase code/verifier and performs the upstream token exchange.

`GPT_OAUTH_BRIDGE_SECRET` remains a Cloudflare Worker secret and must not enter tracked config or PostgreSQL.

## Capability model

The Action schema is not permission. The database client ceilings and CRM permissions remain authoritative.

Current GPT client ceilings include:

- `can_read_appointments`
- `can_manage_appointments`
- `can_read_enquiries`
- `can_manage_crm`
- `can_manage_finance`
- `can_manage_communications`

For profile-bound mode, these are application ceilings. The selected Artist's current CRM membership/capability must still permit the requested operation.

Examples:

- Appointment read requires the relevant session/view capability.
- Appointment mutation requires session management capability.
- Finance actions require the GPT finance ceiling and the user's Artist finance capability.
- Communications actions require the GPT communications ceiling plus authoritative conversation/provider routing.

A capability change must use an authorized/audited configuration path. Do not directly edit `crm_private.gpt_action_clients` merely because a release is otherwise green.

## Consequential actions

Every write, provider send or financial mutation remains `x-openai-isConsequential: true` in the production schema. Read-only Actions remain false.

`docs/gpt-actions/instructions.v2.md` is the model behavior contract. In particular:

- manual payment recording requires exact amount intent;
- outbound client messages require explicit exact-content intent/approval;
- email approval requires explicit approval of the draft;
- appointment changes use current record/version state;
- ambiguous transport failure is followed by authoritative state readback before a consequential retry;
- retries never change Artist, amount, target, content or date merely to get a successful response.

These interaction rules never replace database authorization or idempotency.

## Private data and provider isolation

- Specific authorized CRM actions may return the minimum client/project data required for daily work.
- Private Storage paths, checksums, signed URLs and file bytes are not GPT contract fields.
- Gmail, WhatsApp, Calendar and payment credentials remain in their provider-specific server custody.
- Switching Artist context cannot redirect to a caller-selected provider account.
- Future public Web Research must not send private CRM/client content to its external provider.

## Pre-activation fresh-check

Before creating/binding the unified production OAuth client, establish all of the following from live state:

1. Canonical branch HEAD and exact SHA.
2. No conflicting GPT workstream has moved the same files/contract.
3. Required exact-head CI is green.
4. Production Supabase project is the expected project and migration head matches the current release lineage.
5. `vishar-unified-gpt` is still `binding_mode=profile` with `artist_id IS NULL` and is intentionally dormant.
6. Vladimir/Kristina legacy clients are still active and fixed to their Artists.
7. Current GPT Worker version, custom domains, workers.dev/preview exposure, bindings, rate limit and enable flags are read back from Cloudflare.
8. OAuth discovery endpoints and fixed callback behavior are current.
9. The external Custom GPT configuration is known before replacing schemas/authentication.
10. Known infrastructure incidents, especially intermittent backend authorization/transport failures, are assessed so they cannot be mistaken for a v2 authorization defect during cutover.

A remembered handoff or old runbook snapshot is not sufficient evidence.

## Activation sequence

### Stage A: repository readiness

1. Merge the exact-head green Unified GPT v2 repository contract/instructions.
2. No production client or legacy binding changes are part of that merge.

### Stage B: OAuth application

1. Create one confidential production OAuth client for the unified GPT with only the fixed Worker callback.
2. Enter the secret directly into the Custom GPT editor. Do not expose it to the repository or chat.
3. Record only the non-secret OAuth client id through the authorized CRM/Supabase configuration path for `vishar-unified-gpt`.
4. Re-read the database row and verify it remains profile-bound.

### Stage C: capability activation

1. Enable only the intended unified GPT capability ceilings through an audited authorized path.
2. Keep the legacy clients unchanged.
3. Re-read the unified row and capability state.

### Stage D: exact schema/instruction import

1. Import Core and Operations schemas from the same immutable repository SHA.
2. Apply `instructions.v2.md` to the single Custom GPT.
3. Verify both Action sets use the same OAuth application and the production URLs above.

### Stage E: acceptance

Start read-only:

1. Authenticate as a legitimate CRM user.
2. Call `getArtistContext` and verify only accessible Artists appear.
3. If more than one Artist is accessible, select the intended Artist and verify the context readback.
4. Prove a known unauthorized/inaccessible Artist cannot be selected.
5. Read representative clients/enquiries/projects/appointments inside the selected scope.
6. Change Artist only through context selection and prove the previous Artist's records do not leak into the new scope.

Only after read-only acceptance, exercise consequential actions through legitimate real work when available. Do not create fake production clients, payments or messages for testing.

## Rollback and containment

Use the least destructive containment:

1. Disable/deactivate the unified `vishar-unified-gpt` client or its affected capability ceiling through the authorized configuration path.
2. Leave Vladimir/Kristina legacy GPT clients active and unchanged.
3. If all GPT Actions must close, use the existing Worker `GPT_ACTIONS_ENABLED` containment path.
4. If OAuth relay itself must close, use the existing OAuth relay containment path.
5. Revoke/delete the unified OAuth client only for credential compromise or deliberate retirement.

Do not weaken RLS, RPC ACLs, Artist membership checks, PKCE, provider credential custody, rate limits or idempotency as rollback shortcuts.

## Legacy operator workflows

`.github/workflows/gpt-production-bootstrap.yml` and `.github/workflows/gpt-production-activate.yml` are historical operator workflows tied to the original artist-bound rollout branches. They remain useful as evidence for how the current OAuth edge/PKCE bridge was established, but **they are not the Unified GPT v2 activation procedure** and must not be repurposed by moving those old release branches.

Any future Worker code rollout must use a newly verified bounded release path for the current canonical lineage and current Cloudflare state. Unified client/OAuth binding activation is a separate control-plane operation and must not mutate the legacy clients as a side effect.

## Future Notification/Template Studio integration

The initial v2 Action surface intentionally does not edit notification templates/rules. Once the CRM exposes the final bounded server contract, GPT additions must:

- operate under the same selected Artist context;
- use existing server-side capability checks;
- distinguish template definitions, notification rules and already scheduled notification instances;
- preserve sent-message history;
- expose the server-defined effect of editing an already scheduled notification rather than guessing regeneration behavior.

No second OAuth client or Artist-specific GPT is required for that extension.
