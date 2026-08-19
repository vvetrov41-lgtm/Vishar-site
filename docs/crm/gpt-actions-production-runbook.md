# GPT Actions production rollout

This runbook covers the production GPT edge from OAuth bootstrap through the unified user-centric CRM surface. Production remains separate from retained staging and every production code/migration rollout uses the protected `crm-production` environment. The target architecture is recorded in ADR 0007.

## Fixed boundaries

- Production Supabase project: `vfjexhfdbrjmuxfdvbdx`.
- Production CRM origin: `https://crm.vishartattoo.com`.
- Production GPT action host: `https://gpt-actions.vishartattoo.com`.
- OAuth bootstrap branch: `agent/gpt-production-actions`.
- PKCE compatibility branch: `agent/gpt-production-pkce-bridge`.
- Enquiry-read branch: `agent/gpt-production-enquiry-reads`.
- Full management branch: `agent/gpt-full-crm-management`.
- Retained staging is never targeted by a production rollout.
- The Worker carries no Supabase service-role or secret key. It forwards the signed-in user's OAuth bearer token plus only the production publishable key.
- The OAuth `client_id` identifies the Vishar GPT application. It does not select an artist.
- Artist scope is resolved from `auth.uid()`, the active CRM profile, current memberships and the server-owned active artist context.
- A requested artist key is only a candidate and becomes active only after a fresh membership check. No GPT Action accepts an artist UUID.
- There is no generic SQL, table or arbitrary RPC Action.
- Team/role administration, OAuth/integration credentials, RLS controls and Storage policies are never GPT Actions.

## OAuth and fixed Worker callback

The unified production GPT uses one confidential Supabase OAuth client with `client_secret_basic` across all three Action sets. Configure each Action set with the same credentials and these central OAuth endpoints:

- authorization URL: `https://gpt-actions.vishartattoo.com/oauth/authorize`
- token URL: `https://gpt-actions.vishartattoo.com/oauth/token`
- scope: `email`
- token exchange: Basic authorization header
- production OpenAPI schema: `docs/gpt-actions/openapi.production.yaml`
- privacy policy: `https://gpt-actions.vishartattoo.com/privacy`

The callback displayed by the GPT editor is validated on every authorization request. Allowed downstream callbacks are HTTPS `chat.openai.com` or `chatgpt.com` paths with the exact `/aip/<gpt-id>/oauth/callback` shape.

Supabase receives only the fixed Worker callback:

`https://gpt-actions.vishartattoo.com/oauth/callback`

The fixed Worker callback must be registered on the unified production OAuth client. A later GPT-editor callback change therefore does not require changing the Supabase redirect URI.

The client secret is shown only during OAuth client creation/rotation and must be copied directly into the GPT editor. Never place it in GitHub, CRM data, logs, documentation or chat messages.

## S256 PKCE bridge

Supabase OAuth 2.1 requires Authorization Code with S256 PKCE. Custom GPT authorization traffic observed during rollout did not supply a PKCE challenge, so the production Worker bridges the protocols without disabling PKCE.

1. ChatGPT calls `/oauth/authorize` with Client ID, callback and `state`.
2. The Worker validates the callback, generates a random verifier and S256 challenge, substitutes the fixed Worker callback and sends the request to Supabase.
3. GPT callback, original state, client ID, verifier and short expiry are held only inside AES-GCM authenticated encrypted bridge state.
4. Supabase returns the authorization code to the fixed Worker callback.
5. The Worker returns an opaque encrypted bridge code to the validated GPT callback.
6. ChatGPT exchanges that bridge code at `/oauth/token` using the confidential Client ID/Secret.
7. The Worker restores the Supabase authorization code and PKCE verifier and performs the upstream token exchange.
8. The Supabase code/verifier are never exposed to ChatGPT in plaintext, and the Worker never stores the OAuth client secret.

The bridge secret is a Cloudflare Worker secret named `GPT_OAUTH_BRIDGE_SECRET`. It must not exist in tracked configuration, Supabase or CRM tables.

Historical PKCE production operator: `release/private-crm-rc28-gpt-pkce-bridge`.

## Application identity and artist context

Bind only the new unified application's non-secret OAuth Client ID through:

`configure_gpt_oauth_application('vishar-unified-gpt', <client-id>, true)`

Never store or pass the client secret to this RPC. The secret exists only in Supabase Auth and the GPT Builder authentication settings.

The existing `vladimir-gpt-actions` and `kristina-gpt-actions` rows remain per-artist capability policies. During transition, their current `oauth_client_id` values also preserve the old fixed-artist GPTs. A cross-table trigger prevents the unified client ID from being reused as a legacy client ID.

The context Actions are:

- `listAccessibleArtists`: safe key, display name and current-selection flag only;
- `getActiveArtist`: current context and whether a selection is required;
- `setActiveArtist`: accepts a safe artist key, then revalidates membership in the database.

One accessible artist is selected automatically. Several artists with no saved context produce a selection-required response rather than guessing. Saved context is revalidated on every later action, so membership removal closes access immediately.

Immediately before every activation or expansion, perform a **fresh live Supabase check** of the production project rather than trusting a handoff SHA or prior database snapshot.

## Capability model

Capabilities are database-controlled and are independent of what the OpenAPI schema advertises. A route can exist publicly while the database still denies it for an artist/client.

Existing appointment controls remain:

- `can_read_appointments`
- `can_manage_appointments`

Enquiry summary/detail reads use:

- `can_read_enquiries`

Full management adds three default-off controls:

- `can_manage_crm`
- `can_manage_finance`
- `can_manage_communications`

Only the owner can change these. Existing policies remain configurable through the legacy configuration RPCs; new artists use `configure_gpt_artist_policy(...)`. Capability changes are written to `activity_log`.

`can_manage_crm` covers daily artist operations such as specific-client detail/update, full enquiry detail/update/status/assignment/conversion, projects, internal notes, follow-ups and full appointment/availability operations. It does not grant team/security administration.

`can_manage_finance` additionally requires the signed-in human user to have the existing artist `manage_finance` permission. It covers project estimates/deposits, payment-request reads, requesting the configured session deposit, cancelling a payment request and recording an explicitly confirmed manual payment.

`can_manage_communications` covers artist-scoped email/WhatsApp history and bounded outbound workflows. Existing provider integration state, credential custody, routing and human CRM permissions remain authoritative. Enabling this flag does not manufacture a provider connection or credential.

## PII and private files

Bulk client/enquiry lists remain minimised. A single specific linked client or full enquiry detail may return canonical CRM contact fields needed for operational work, including email, phone, Instagram, preferred contact method and travelling-from information.

Raw duplicate intake snapshots are not part of the GPT contract. Shared cross-artist client updates fail closed and must be performed in the human CRM UI.

Private file Actions return only metadata such as file ID, filename, category, MIME type, size and upload state. They do not expose Storage paths, checksums, signed URLs or file bytes.

## Consequential actions

Every write, provider-send or financial mutation is marked `x-openai-isConsequential: true` in the production OpenAPI schema. Read-only Actions are marked false.

For high-impact operations:

- manual payments require the user to confirm the exact amount;
- WhatsApp sends require an explicit request for the exact message;
- email approval requires explicit approval of the draft content;
- appointment reschedule/cancel continues to require current `calendar_version`;
- idempotent operations use a generated UUID request ID reused only for an identical retry.

The GPT does not bypass human CRM role checks or the canonical RPC business rules.

## Unified rollout after migration 0069

1. Keep the product PR Draft/open/unmerged and require exact-head Static, CRM/booking and Gmail validation green.
2. Fresh-check production migration head and the three live GPT domains. Production must not already contain `0069`.
3. Apply the exact pending migration chain only through a protected production operator. Migration `0069` seeds the unified application disabled and changes no provider connection.
4. Deploy the existing GPT Worker. Verify unauthenticated Actions return 401 and all three privacy routes return 200.
5. In Supabase Auth, create one confidential OAuth client named for the unified Vishar GPT. Register only the fixed Worker callback `https://gpt-actions.vishartattoo.com/oauth/callback`.
6. Bind and enable only the non-secret client ID with `configure_gpt_oauth_application`. Do not disable legacy bindings yet.
7. Configure one private Vishar GPT with the Core, Operations and Communications schemas. Use the same OAuth client ID and secret for all three Action sets.
8. Sign in first as a one-membership user and prove automatic selection. Then sign in as a two-membership user, list both artists, switch both directions and prove cross-artist denials for Gmail and finance.
9. Keep old Vladimir and Kristina GPTs available during observation. If containment is needed, disable the unified application first.
10. Retire legacy GPTs only after a separately approved cleanup. Disable legacy bindings before revoking or deleting their OAuth clients.

## Historical rollout phases

### OAuth bootstrap

`release/private-crm-rc26-gpt-actions` enabled the production Supabase OAuth server and deployed the public OAuth edge with Actions closed. No OAuth client or database binding was created by that workflow.

### Action edge and PKCE

The original Action activation and the later PKCE bridge were deployed only after normal CI, secret scan and protected production approval. Unauthenticated action requests must return 401 once Actions are enabled.

### Enquiry reads

Migration `0053_gpt_enquiry_reads` added separate default-off enquiry reads and the two read-only enquiry Actions. Capability enablement was performed after migration/Worker verification rather than inside the deployment workflow.

## Full management rollout

Full management is a forward-only expansion from production migration `0053`.

1. Confirm the exact `agent/gpt-full-crm-management` head and its ancestry from the deployed enquiry-read head.
2. Require normal `Static Validation` and `CRM and booking validation` green for that exact SHA, including clean Supabase reset, pgTAP, lint, Worker tests, production bundle and secret scan.
3. Fresh-check production: migration latest must be `0053`; both production GPT bindings must still point to the intended Vladimir/Kristina production OAuth clients; retained staging must remain separate.
4. Fast-forward `release/private-crm-rc31-gpt-full-management` to the exact green product SHA. The operator branch must carry no extra commit.
5. Protected workflow re-verifies product SHA/normal CI, performs a migration dry run, applies only canonical pending migrations `0054`, `0055` and `0056`, verifies remote `0056`, then deploys the production GPT Worker.
6. The workflow must not call `configure_gpt_full_management` or directly update `crm_private.gpt_action_clients`. New full-management flags must remain false after code/migration deployment.
7. Verify live `/privacy` = 200, incomplete `/oauth/authorize` = 400 and an Action request without OAuth bearer = 401.
8. Verify production migration latest `0056`, no RLS/Storage policy changes and no staging changes.
9. Only after those checks, enable the desired capabilities for each intended production GPT through the owner-audited `configure_gpt_full_management(...)` RPC.
10. Re-check the two artist bindings, activity log and cross-artist isolation.
11. Import the immutable exact-SHA production OpenAPI schema into each production Custom GPT.
12. After schema replacement, verify the GPT editor still sends the expected Client ID. If the editor emits `oauth_authorize_client_id_invalid`, re-enter the known non-secret Client ID, Save Authentication, then Update the GPT. Do not rotate the Client Secret unless Supabase actually returns `invalid client credentials`.

## Production validation

Do read-only validation first:

1. list enquiries and appointments for each artist;
2. read a specific full enquiry/client/project record;
3. prove a known other-artist record is not visible;
4. list availability/follow-ups/activity where present;
5. finance/communications reads should either succeed inside the correct configured artist integration or fail closed for missing capability/provider configuration.

Do not create synthetic production clients, enquiries, payments or messages just to prove the surface. A write test must correspond to a real intended production change or a separately approved real operation.

## Release operator rule

Protected `crm-production` workflows run from dedicated release operator branches because the environment rejects pull-request merge refs. Every operator workflow must verify that its SHA equals the declared product branch before any production mutation.

No feature PR is merged or marked Ready as part of deployment. The operator branch must not contain an extra rollout-only commit.

## Rollback and containment

Use the least destructive containment first:

1. disable the affected full-management capability through `configure_gpt_full_management(...)` while leaving OAuth/read access intact;
2. if all Actions must close, deploy with `GPT_ACTIONS_ENABLED=false`;
3. if OAuth must also close, set `GPT_OAUTH_RELAY_ENABLED=false`;
4. deactivate the affected GPT binding through the existing owner configuration path;
5. revoke/delete the affected Supabase OAuth client only if its credential is suspected compromised.

Do not weaken RPC ACLs, RLS, Storage policies, artist membership checks, PKCE, Calendar versioning, provider credential custody or rate limits as a rollback shortcut.
