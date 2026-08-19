---
name: vishar-monzo-artist-onboarding
description: Safely onboard or recover an artist-scoped Monzo Business connection in Vishar CRM. Covers shared OAuth client usage, per-artist encrypted token/account/webhook isolation, reusable payment destinations, request-specific one-off links, dedicated payment redirects, reconciliation and production verification. Never auto-settle payments or reuse one artist's payment URLs for another artist.
---

# Vishar Monzo Artist Onboarding

Use this skill when preparing, connecting, recovering or verifying Monzo for a Vishar CRM artist, especially Kristina.

The target architecture is one shared Monzo runtime with artist-scoped configuration and state. Do not create a second Worker, second token store or separate payment stack merely because another artist is being connected.

This is payment/security-sensitive work. Before substantial investigation or any mutation, read:

- repository root `AGENTS.md`;
- `docs/ai/README.md`;
- `docs/ai/branch-workflow.md`;
- `docs/ai/security-boundaries.md`;
- `.agents/skills/vishar-code-navigation/SKILL.md`.

## 1. Fresh-state rule

Never execute onboarding from an old handoff alone.

Before every stage verify:

1. current PR, branch, exact head SHA and exact base SHA;
2. current production Supabase migration head;
3. retained staging migration head if staging is relevant;
4. current deployed `vishar-monzo-api-production` Worker configuration and routes;
5. current artist rows and artist IDs;
6. current `artist_integrations` Monzo rows;
7. current target-artist connection status;
8. current reusable destination state without printing URLs;
9. current CI for the exact product SHA.

Documentation records intent. Current code, migrations, grants, RLS, Worker configuration and live environment evidence win.

## 2. Non-negotiable boundaries

Preserve all of these:

- browser data never authoritatively chooses `artist_id`, payment amount, provider account key, receiving account or reusable destination;
- Monzo OAuth access/refresh tokens stay encrypted server-side, never in Supabase, browser data, Git or logs;
- webhook bodies are untrusted hints;
- incoming transactions are independently re-fetched from Monzo;
- `Match` does not settle payment;
- `Confirm payment` is a separate human action;
- opening a payment link never settles payment;
- reusable payment URLs belong to one artist and one amount;
- a one-off URL belongs to exactly one payment request;
- no cross-artist payment-URL fallback;
- no weakening of RLS, RPC ACL, Cloudflare Access or rate limits;
- no secret values in tracked source, PR descriptions or logs;
- retained staging is not automatically advanced with production.

## 3. Artist-scoped runtime

The shared production Worker is:

`vishar-monzo-api-production`

Management/OAuth hostname:

`monzo.vishartattoo.com`

Public payment hostname:

`pay.vishartattoo.com`

The payment hostname is a dedicated Custom Domain. Do not restore the failed apex routing design on `vishartattoo.com/pay-by-bank-transfer/*`.

The dedicated host exists because the apex Worker Route competed with the public Pages application and real iPhone navigation reached the Pages 404. The final gateway must fail closed on `pay.vishartattoo.com` except strict GET requests matching:

`/pay-by-bank-transfer/<opaque UUID>`

The Monzo management hostname remains separate and owner-protected.

## 4. Artist registry

Routable Monzo artists are defined centrally in:

`workers/lib/monzo-artist-registry.js`

Current intended aliases are:

- `vladimir`;
- `kristina`.

The registry controls:

- owner-protected route matching;
- artist ID environment binding;
- OAuth client resolution;
- display name;
- OAuth state validation;
- encrypted token-record alias validation;
- setup and disconnect flows;
- readiness checks.

The CRM carries a matching alias list in:

`admin/src/lib/monzo-connector.ts`

`script/test-monzo-artist-registry.mjs` or its current equivalent must prove Worker and CRM aliases do not drift.

A third artist should require only a small bounded code/config addition: registry entry, CRM alias entry, `<ALIAS>_ARTIST_ID`, then that artist's own connection and destinations. Do not claim third-artist onboarding is literally zero-code while aliases remain tracked source.

## 5. Artist IDs and provider account keys

Current historical IDs when this skill was revised on 2026-08-19 were:

- Vladimir: `a1111111-1111-4111-8111-111111111111`;
- Kristina: `a2222222-2222-4222-8222-222222222222`.

Fresh-check before use.

The provider account key is deterministic and server-derived:

`monzo_ebt_<artist UUID with hyphens removed>`

The browser must never provide this key as routing authority.

## 6. OAuth client model

Do not create a separate Monzo Developer OAuth application for Kristina by default.

The correct default is the existing shared confidential OAuth client. Monzo tokens are bound to the OAuth client and the individual Monzo user, so different artists can independently authorize the same confidential client while retaining separate user/token/account state.

Shared:

- OAuth client ID/secret;
- exact callback URI;
- Worker runtime;
- encryption key;
- KV namespaces;
- Cloudflare Access boundary.

Artist-specific:

- alias;
- CRM artist ID;
- Monzo user ID;
- encrypted token envelope;
- selected bank account;
- provider account key;
- webhook key;
- webhook ID and route;
- reusable payment destinations;
- one-off request destinations;
- reconciliation provenance.

The runtime may support optional per-artist OAuth client overrides. If so, both ID and secret must be configured together and a half-configured override must fail closed. Do not mix one client ID with another client secret.

## 7. Token custody

Production uses Workers KV namespaces for separate concerns, including OAuth state, encrypted artist tokens and webhook routes.

Token records must be encrypted with AES-GCM before storage. The token key is artist-scoped, normally based on the CRM artist ID.

A token record must remain bound to at least:

- artist alias;
- artist ID;
- OAuth client ID;
- Monzo user ID;
- provider account key;
- connection state;
- selected account when selected;
- webhook metadata when registered.

Every load/reconnect/sync/disconnect path must re-check those bindings. A Vladimir token may never satisfy a Kristina route and vice versa.

## 8. Historical OAuth incidents that must not regress

### Token response validator

Do not restore overly strict assumptions that previously rejected a valid Monzo token response.

Preserve:

- case-insensitive handling of Bearer token type;
- no invented `expires_in <= 86400` maximum;
- required-field and client/user binding validation;
- no raw token/provider payload in browser responses or logs.

### Monzo SCA race

Monzo can issue an access token before separate in-app Strong Customer Authentication approval is complete.

If `/ping/whoami` or account access is temporarily permission-blocked because approval is pending:

- preserve the encrypted token;
- mark/retain an approval-pending state;
- do not select an account yet;
- do not register a webhook yet;
- instruct the owner to approve access in the Monzo app;
- retry identity/account access afterward.

Do not destroy the token and restart OAuth merely because the first post-exchange identity call returns the known pending-approval condition.

### Workers KV read-after-write

Do not depend on immediately reading a just-written one-time KV confirmation.

Setup confirmation uses a short-lived cryptographically sealed server-issued confirmation bound to the relevant owner/artist/client/user facts. Account selection is re-fetched server-side before use.

### Mobile opaque Origin

The signed mobile recovery flow may receive `Origin: null` on iOS navigation POSTs. The signed confirmation remains the anti-CSRF authority. Concrete foreign origins and cross-site fetch metadata remain rejected. Do not remove the signed confirmation or broaden origin trust.

## 9. Account selection and webhook registration

The browser may submit a proposed account ID, but the Worker must re-list Monzo accounts with that artist's token and accept only a server-observed eligible account.

After selection:

1. verify the token still belongs to the configured artist/client/user;
2. verify the selected account appears in the server-fetched Monzo account list;
3. derive/retain the artist provider key;
4. generate the opaque webhook route key server-side;
5. register the Monzo webhook for the selected account;
6. persist the webhook route and encrypted artist connection state;
7. compensate safely if provider registration succeeds but local persistence fails.

On reconnect, never silently cross over to another artist's account or token record.

## 10. Duration-based deposit policy

Current single-session policy is server-owned:

- up to 60 minutes: GBP 50;
- up to 180 minutes: GBP 100;
- up to 300 minutes: GBP 150;
- over 300 minutes / full day: GBP 250.

`request_session_deposit(...)` derives the amount from the persisted appointment duration. The resulting `payment_requests.amount` is an immutable pricing snapshot.

Important: if the appointment is later rescheduled or its duration changes, do not silently reprice an already-created payment request. Reusable or one-off destination selection must use the immutable request amount.

## 11. Reusable Monzo payment destinations

The generic closed catalogue is:

`public.monzo_payment_destinations`

Key:

- `artist_id`;
- `amount`;
- `currency`.

Migration `0064_monzo_artist_payment_destinations.sql` is designed to rename the earlier `monzo_easy_bank_transfer_tier_urls` table **in place** rather than recreate it. This preserves existing Vladimir rows and URLs.

This distinction is critical:

- Vladimir's already provisioned production GBP 50/100/150/250 URLs stay his;
- Kristina must later receive her own URLs;
- never copy Vladimir's payment URLs into Kristina rows;
- absence of a Kristina row must fail closed, never borrow Vladimir's row.

The catalogue can store additional positive amounts without another schema change. That only means the routing table is future-ready. It does **not** mean grouped deposits are implemented.

No real reusable URL belongs in tracked source.

Provision reusable destinations through the guarded operator statement:

`scripts/monzo/provision-artist-payment-destinations.sql`

Validate its runtime JSON first:

`node scripts/validate-monzo-destination-plan.mjs <plan.json>`

The plan contains amount + URL only. Artist selection comes separately from the protected operator invocation, so the plan itself cannot redirect another artist.

Provisioning must reject:

- inactive/unknown artist;
- artist without the exact enabled Monzo payment integration;
- malformed Monzo URL;
- duplicate amount;
- duplicate URL;
- URL belonging to another artist;
- URL already used as a request-specific one-off.

The operator may update only that artist's `(artist_id, amount, currency)` rows.

## 12. Request-specific one-off Monzo links

The CRM supports a one-off link for a payment request when that artist has no reusable destination for the request's immutable amount.

RPC:

`attach_monzo_one_off_payment_destination(p_payment_request_id uuid, p_payment_url text)`

The browser supplies only:

- payment request ID;
- proposed Monzo URL.

The database derives and verifies:

- artist;
- provider;
- provider account key;
- amount;
- currency;
- request purpose/status;
- session-backed pricing provenance.

Required behavior:

- request is an open GBP Monzo session deposit;
- request carries the server-created payment-policy snapshot;
- amount comes from immutable `payment_requests.amount`;
- exact artist Monzo route remains enabled;
- URL matches clean `https://monzo.com/pay/r/...` shape;
- one-off is rejected if this artist already has a reusable destination for the amount;
- one-off is rejected if the URL is already reusable for any artist;
- one-off is rejected if the URL belongs to another payment request;
- saved row copies artist/amount/currency from the request;
- one-off is never promoted into the reusable catalogue;
- attaching/replacing the URL does not create a ledger entry or mark anything paid.

Do **not** recalculate an old payment request from today's appointment duration when attaching a one-off. The request amount was guarded at creation and remains authoritative.

The Payments CRM may display the one-off input after creating a request. Backend validation remains authoritative; hiding/showing the input is not a security boundary.

## 13. Group deposits are a separate future workstream

Do not infer group-deposit capability from the generic destination catalogue.

This Monzo artist-readiness workstream does **not** implement:

- `session_deposit_groups`;
- `session_deposit_group_members`;
- `request_grouped_session_deposit(...)`;
- `get_session_deposit_group(...)`;
- multi-session allocation/release logic.

The owner has separately discussed one payment covering several sessions and may already have manually created higher-value reusable Monzo links. Those links must not be committed or provisioned merely because the catalogue can technically store their amounts.

Group deposits require a separate explicit product decision and dedicated tests/UI/rollout.

## 14. Public payment redirect

The public customer path is opaque and first-party:

`https://pay.vishartattoo.com/pay-by-bank-transfer/<opaque UUID>`

The Worker accepts strict GET only, applies its own rate limiter, calls only the backend redirect resolver, validates the returned Monzo URL, and redirects.

All unrelated paths on `pay.vishartattoo.com` fail closed.

`resolve_monzo_deposit_redirect(uuid)` remains backend-only and resolves from the immutable request facts.

Resolution order may be:

1. request-specific one-off for the same request/artist/amount;
2. reusable catalogue row for the same artist/amount/currency;
3. same-artist legacy GBP 250 compatibility URL only.

There is never a cross-artist or wrong-amount fallback.

Opening a payment URL records at most navigation metadata. It never proves bank settlement.

## 15. Reconciliation boundary

Monzo does not make the webhook body trusted payment evidence.

The Worker must:

1. resolve opaque webhook route;
2. load the corresponding artist encrypted token record;
3. verify alias/artist/client/provider/account binding;
4. ensure/refresh access token for that same artist;
5. re-check Monzo identity;
6. re-fetch the transaction from Monzo;
7. verify selected account ownership;
8. accept only the intended incoming GBP credit shape;
9. create/replay only a reconciliation candidate.

Human flow:

`verified candidate -> Match -> Confirm payment -> immutable payment transaction`

`Ignore` stays separate.

Never auto-settle based on:

- webhook payload;
- amount equality;
- client guess;
- payment-link opening;
- candidate creation;
- Match.

## 16. Kristina readiness and later onboarding

Before Kristina has a Monzo Business account, code readiness may be prepared but no fake credentials/account/token/webhook should be created.

When her account exists, expected sequence is:

1. fresh-check repo, PR, CI, production Supabase and deployed Worker;
2. confirm `public.artists.slug = 'kristina'` and deployed `KRISTINA_ARTIST_ID` match;
3. confirm registry and CRM alias include `kristina`;
4. confirm shared confidential OAuth client remains valid;
5. pass Cloudflare Access on the protected Monzo management page;
6. start `/oauth/monzo/setup/kristina`;
7. log in with Kristina's Monzo identity;
8. complete in-app SCA approval if requested;
9. select her receiving Monzo account;
10. let the Worker re-fetch and validate it server-side;
11. register her webhook and persist her encrypted connection state;
12. configure/enable her CRM Monzo payment integration;
13. create her own reusable Monzo Business payment links manually in Monzo;
14. validate a runtime destination plan without putting URLs in Git;
15. provision **Kristina's** GBP 50/100/150/250 rows through the protected operator;
16. run read-only verification;
17. prove a Kristina request resolves only to a Kristina destination;
18. prove a missing Kristina destination fails closed instead of using Vladimir's;
19. verify reconciliation remains candidate-only.

No new Monzo Developer Client ID/Secret is required unless provider requirements have changed or the architecture is deliberately changed.

## 17. Read-only verification

Use:

`scripts/monzo/verify-artist-payment-destinations.sql`

Verification output should expose only safe metadata such as:

- artist slug;
- active/enabled booleans;
- whether provider key is artist-derived;
- active policy version and tier count;
- configured amounts;
- short URL fingerprints, not URLs;
- cross-artist URL violation count;
- one-off count;
- absence of group-deposit schema in this workstream;
- provider-ledger count as a settlement sanity check.

For Kristina readiness, expected before her real onboarding:

- artist exists;
- no Monzo integration yet;
- no reusable Kristina destination rows yet;
- Vladimir rows remain untouched.

After onboarding, expected:

- Kristina has her own enabled provider route;
- four canonical reusable amounts exist for her;
- their URL fingerprints differ as required;
- no URL is shared across artists;
- no direct browser/service-role table access exists;
- redirect resolver remains backend-only;
- reconciliation candidate RPC remains backend-only;
- human Match/Ignore/Confirm RPC permissions remain unchanged.

## 18. Disconnect and reconnect

Disconnect must be artist-specific.

A Kristina disconnect may remove only Kristina's:

- encrypted token envelope;
- webhook route;
- provider webhook registration where possible;
- active connection state.

It must not remove or rewrite Vladimir's token/account/webhook/destination state.

Reusable payment configuration is separate from OAuth token custody. Decide explicitly whether reusable rows should stay available for a reconnect; do not casually delete operator-owned routing data.

Reconnect must safely replace the target artist connection without token crossover.

## 19. Production and staging boundaries

Production and retained staging are intentionally allowed to have different migration heads.

Historical snapshot when revised:

- production project: `vfjexhfdbrjmuxfdvbdx`;
- retained staging project: `gwaliusblwrzisrwnsvs`;
- production was through migration `0063_monzo_tier_specific_deposit_links`;
- retained staging was through `0044_monzo_payment_url_validator`.

This snapshot is not authority. Fresh-check every time.

Do not advance retained staging merely to make versions match if the workstream intentionally targets production.

## 20. Production rollout safety

Before applying a new Monzo migration or Worker change:

- confirm the exact product head;
- confirm parallel Gmail/GPT/other workstreams have not advanced the product stack;
- confirm migration number is still available and canonical;
- run exact-head CI;
- use the existing protected production operator boundary;
- require the existing environment approval if the repository workflow requires it;
- apply only the bounded Monzo/database/CRM pieces actually needed;
- never rotate existing secrets unless rotation is the explicit task;
- verify Vladimir's existing connection/destination state survives;
- verify dedicated `pay.vishartattoo.com` routing survives;
- verify Kristina remains unconnected until her real onboarding;
- verify no real payment is settled as a side effect.

Do not merge or mark product PR Ready unless separately instructed.

## 21. Common failure states

`artist_route_unconfigured`
: registry/artist-ID binding missing or invalid. Fix configuration; do not fall back to another artist.

`approval_pending`
: Monzo token exists but in-app SCA is incomplete. Approve in the app, then continue; do not throw the token away.

`monzo_not_connected`
: target artist has no encrypted token connection. Run that artist's setup flow.

`Payment link unavailable`
: request is invalid/closed/expired or the same artist has no valid destination for the immutable amount. Provision the correct artist destination or attach a request-specific one-off. Never borrow another artist URL.

`this amount already has a reusable Monzo destination`
: one-off was attempted where reusable routing already exists. Use the reusable destination instead.

`provider_route_invalid`
: stored artist/client/account/provider bindings no longer match deployed configuration. Fail closed and investigate before reconnecting.

## 22. Secret rules

Never print, paste, commit or place in PR text:

- Monzo Client Secret;
- access token;
- refresh token;
- token-encryption key;
- Supabase secret/service credential;
- real reusable payment URLs;
- real request-specific one-off URLs;
- OAuth authorization codes;
- cookies or Cloudflare Access session material.

Client ID is not a secret, but do not duplicate it unnecessarily in tracked docs when configuration lookup suffices.

## 23. Fast path for Kristina

If the architecture still matches this skill, Kristina later needs operational provisioning rather than new payment architecture:

1. confirm artist ID;
2. pass Cloudflare Access;
3. OAuth with Kristina's Monzo identity using the shared client;
4. complete SCA;
5. select receiving account;
6. register webhook;
7. enable her artist integration;
8. create her own GBP 50/100/150/250 Monzo payment links;
9. provision only those Kristina URLs;
10. verify no cross-artist routing;
11. verify candidate-only reconciliation.

Vladimir's existing URLs remain untouched throughout.

## 24. Final settlement invariant

These actions must never write `public.payment_transactions` by themselves:

- OAuth authorization;
- account selection;
- webhook registration;
- reusable destination provisioning;
- creating a deposit request;
- opening a reusable payment link;
- attaching/opening a one-off payment link;
- receiving a webhook;
- provider transaction refetch;
- candidate creation;
- recovery sync;
- Match;
- Ignore.

Only the explicit human settlement boundary, such as `confirm_monzo_reconciliation_candidate` or a deliberate manual-payment RPC, may write the immutable payment ledger and derive paid status.
