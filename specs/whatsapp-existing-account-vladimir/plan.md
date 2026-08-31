# Implementation plan

## Baseline

Development branch starts from canonical `agent/platform-telegram-self-service` at `714912908619a238086b60cb738a50d278f65099`. Production Supabase is on migration `0120`. Fresh Cloudflare inventory confirms both production WhatsApp Workers exist, Vladimir's secret binding name is present, the drain is disabled, and it has no cron.

A parallel Calendar-only workstream may exist and must not be mixed into this branch.

## Design

Reuse the existing authenticated Pages Function at `admin/functions/api/whatsapp/existing-account/provision.js` and the existing same-origin CRM form. Add one bounded migration because `artist_integrations` deliberately grants authenticated operators `SELECT` only, so direct `PATCH` cannot mark the verified route connected.

### Server boundary

- Hard-code Vladimir's artist, integration key, WABA, Phone Number ID, Worker binding, App ID, and production origins.
- Authenticate the CRM session against production Supabase and verify integration-management capability for Vladimir.
- Validate the prepared CRM route before handling provider mutation.
- Validate the Meta System User token with `debug_token` using the server-held Meta app secret.
- Verify the token App ID and required WhatsApp scopes.
- Read the exact WABA and its phone collection, proving the fixed phone belongs to the fixed WABA.
- Only then overwrite Vladimir's exact encrypted Worker secret in drain and webhook Workers.
- Subscribe the fixed WABA to the fixed app.
- Read back Meta target identity, subscription, and Cloudflare secret-name presence.
- Call the fixed `complete_vladimir_whatsapp_connection()` RPC only after every provider readback. The RPC accepts no artist, route, timestamp, token, or provider input; it checks `manage_integrations`, locks the exact enabled Vladimir route, updates only `connected_at`, and returns the safe row for readback.

### Client boundary

- Keep the token in transient password-input state only.
- Clear it in `finally` after every attempt.
- Allow direct existing-account provisioning only for Vladimir.
- Require the backend success payload to contain `connected: true` and a `connected_at` timestamp.
- Continue to omit integration configuration and credentials from CRM list reads.

### Observability and secrecy

- Return only bounded error identifiers and safe Graph numeric diagnostics.
- Never log request bodies, access tokens, app secrets, or credential envelopes.
- Cloudflare readback checks only secret names, never values.
- Supabase stores only safe route metadata and `connected_at`.

## Validation

Regression coverage must prove invalid token, wrong app, missing permission, wrong WABA, wrong phone, wrong artist, Kristina exclusion, no pre-validation Cloudflare mutation, no connected state before all readbacks, and no token leakage in responses/logs/Supabase mutation bodies.

Run repository WhatsApp onboarding validation, CRM tests, typecheck, build, Worker bundle assertions, redirect-mode validation, and secret scans on the exact branch head.

## Rollout

1. Re-check canonical SHA and parallel PRs before merge.
2. Merge only after required exact-head CI is green.
3. Verify post-merge canonical exact-head CI.
4. Deploy private CRM production from the immutable canonical SHA using the existing guarded release workflow.
5. Read back the actual CRM Pages production deployment and WhatsApp Worker topology. Drain remains disabled and without cron.
6. Confirm production Supabase still has Vladimir `connected_at = null` before credential provisioning.
7. Ask the user only for the unavoidable Meta UI action: assign the minimal System User assets, generate a System User token, and paste it directly into the new CRM form.
8. After submission, verify production Supabase `connected_at` and fresh Cloudflare secret-name presence. The server's successful connected state already proves Meta WABA, Phone Number ID, subscription, and Cloudflare readbacks occurred in order.
9. Do not start Kristina direct provisioning until Vladimir acceptance is complete.
