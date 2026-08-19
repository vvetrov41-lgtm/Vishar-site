---
name: vishar-monzo-artist-onboarding
description: Reuse and safely extend the existing Vishar CRM Monzo Business integration for another artist, especially Kristina. Covers Easy Bank Transfer deposit destinations, artist-scoped Monzo OAuth, account selection, encrypted token custody, webhook registration, reconciliation candidates, payment redirects, production rollout and recovery. Use when connecting a new artist Monzo account or diagnosing that onboarding. Never use it to auto-confirm or auto-settle payments.
---

# Vishar Monzo Artist Onboarding

Use this skill when connecting another artist's Monzo Business account to Vishar CRM, or when recovering an existing Monzo artist connection.

The intended next reuse is Kristina. The architecture was deliberately built so that a second artist should normally reuse the existing production Worker, OAuth client, KV namespaces, security boundaries and reconciliation pipeline rather than creating a parallel Monzo stack.

This is a security-sensitive payment workflow. Read the repository root `AGENTS.md`, `docs/ai/branch-workflow.md`, `docs/ai/security-boundaries.md`, and `.agents/skills/vishar-code-navigation/SKILL.md` before implementation or production work.

## 1. Never replay this document blindly

This repository is branch-heavy and production can advance while old draft PRs remain open.

Before every stage:

1. resolve current GitHub PR/branch state;
2. record exact product and release SHAs;
3. inspect the current production Supabase migration head;
4. inspect the current deployed Monzo Worker/runtime and its routes;
5. inspect current artist/payment integration rows;
6. inspect current protected Monzo connection status for the target artist;
7. verify retained staging separately if staging is in scope;
8. only then decide whether any code, DB, Worker or UI change is actually required.

Historical PR numbers and SHAs later in this skill are recovery landmarks only. Current code, current migrations, current grants, current Worker bindings and live environment evidence always win.

## 2. Current production architecture

The production design has four separate responsibilities.

### A. CRM deposit policy and payment requests

Supabase is authoritative for:

- artists and artist-scoped permissions;
- duration-based deposit policy;
- payment requests;
- opaque personal payment-link IDs;
- immutable payment ledger;
- human reconciliation state.

Relevant migrations in the current lineage include:

- `0042_monzo_easy_bank_transfer_deposits.sql`;
- `0057_monzo_duration_tiered_deposits.sql`;
- `0058_monzo_reconciliation_crm_review.sql`;
- `0060_monzo_reconciliation_route_recovery.sql`;
- `0063_monzo_tier_specific_deposit_links.sql`.

The duration policy is server-owned:

- up to 60 minutes -> GBP 50;
- up to 180 minutes -> GBP 100;
- up to 300 minutes -> GBP 150;
- over 300 minutes / full day -> GBP 250.

The browser must never authoritatively choose the deposit amount. `request_session_deposit(...)` resolves the tier from the persisted session duration and creates/replays a request with that immutable amount.

### B. Reusable Monzo payment destinations

`artist_integrations` contains the enabled Monzo Easy Bank Transfer payment integration for an artist. The legacy/configuration `payment_url` is the GBP 250 compatibility destination.

The four standard reusable destinations are held in the closed server-side table:

`public.monzo_easy_bank_transfer_tier_urls`

keyed by:

- `artist_id`;
- `amount`;
- `currency`.

Current standard allowed amounts are 50, 100, 150 and 250 GBP.

This table uses FORCE RLS and intentionally has no direct browser or service-role SELECT grant. There is intentionally no authenticated CRUD RPC for these rows. Production values are operator-owned routing configuration.

Do not commit real reusable Monzo payment URLs into the public repository. Provision them through a bounded protected production operation.

### C. Monzo Developer API connection

The shared production Worker is:

`vishar-monzo-api-production`

The owner-protected management/OAuth hostname is:

`monzo.vishartattoo.com`

The final production payment redirect hostname is:

`pay.vishartattoo.com`

Do not reintroduce the old apex Pages/Worker route for client payment links. A dedicated `pay.vishartattoo.com` Custom Domain was adopted after the apex Worker Route lost to the public Pages application on real iPhone navigation.

The production Worker uses three separate Workers KV namespaces:

- `MONZO_OAUTH_STATE`;
- `MONZO_OAUTH_TOKENS`;
- `MONZO_WEBHOOK_ROUTES`.

Token records are encrypted with AES-GCM before storage and keyed by artist ID (`artist:<artist-id>`). Access/refresh tokens are never stored in Supabase, browser state, CRM records or Git.

The Worker also uses one confidential server-side Monzo OAuth client. Artist isolation is not achieved by creating one OAuth client per artist. It is achieved by binding state/token/webhook records to the server-controlled artist route, artist ID, provider account key and OAuth client ID.

### D. Reconciliation

A Monzo webhook is never payment proof.

The public webhook path receives only an opaque route key. The Worker:

1. resolves the route from `MONZO_WEBHOOK_ROUTES`;
2. loads the encrypted token record for that artist;
3. verifies artist/provider/account binding;
4. re-verifies the OAuth identity;
5. re-fetches the transaction from Monzo;
6. proves it belongs to the selected account;
7. accepts only an incoming GBP transfer credit;
8. calls only the narrow backend reconciliation candidate RPC.

Candidate creation does not settle a payment.

Human flow remains:

`incoming transfer -> verified candidate -> Match -> Confirm payment -> immutable payment ledger`

`Match` is not settlement. `Confirm payment` is a separate human action.

## 3. Artist routing that already exists

Current Worker code supports exactly these aliases:

- `vladimir`;
- `kristina`.

Tracked production configuration already defines separate artist IDs through:

- `VLADIMIR_ARTIST_ID`;
- `KRISTINA_ARTIST_ID`.

Current repository snapshot used when this skill was written:

- Vladimir: `a1111111-1111-4111-8111-111111111111`;
- Kristina: `a2222222-2222-4222-8222-222222222222`.

Always fresh-check these values before future use.

The provider account key is deterministic and server-derived:

`monzo_ebt_<artist UUID with hyphens removed>`

For example, do not let the browser submit an artist ID or provider account key as authoritative routing input.

## 4. Current snapshot when this skill was created

Snapshot date: 2026-08-19. This section is historical context, not authority.

Production Supabase project ref was:

`vfjexhfdbrjmuxfdvbdx`

Retained staging project ref was:

`gwaliusblwrzisrwnsvs`

Production migration head was:

`0063_monzo_tier_specific_deposit_links`

Retained staging remained at:

`0044_monzo_payment_url_validator`

Vladimir had an enabled `monzo_easy_bank_transfer` payment integration. Kristina had no payment integration row yet.

The Worker already contained a `kristina` route and a tracked `KRISTINA_ARTIST_ID`, so Kristina onboarding was expected to be primarily an operational connection/configuration task, not a second Worker implementation.

Before acting in the future, re-query all of the above.

## 5. Expected minimal Kristina onboarding

If current code still contains the `kristina` alias, her correct artist ID and the same security boundaries, do not create a second Monzo Worker, second set of KV namespaces or second encryption key.

The expected minimum sequence is:

1. Kristina opens the required Monzo Business account.
2. Create the standard reusable Easy Bank Transfer payment links she needs.
3. Fresh-check the production Monzo Worker and Supabase state.
4. Confirm the shared production OAuth client and callback are still valid.
5. Start the protected setup flow for alias `kristina`.
6. Complete Monzo OAuth using Kristina's Monzo identity.
7. Approve access in the Monzo app if Monzo requires SCA approval.
8. Select the tattoo-payment receiving account.
9. Let the Worker re-fetch that account and register the webhook.
10. Verify the encrypted artist token record and webhook route are active through safe status evidence, never by reading or printing credentials.
11. Configure Kristina's CRM Monzo Easy Bank Transfer payment integration.
12. Provision Kristina's four standard tier destinations (50/100/150/250 GBP) in the closed tier table.
13. Verify deposit requests route to her destinations and not Vladimir's.
14. Verify reconciliation candidates are artist-scoped and remain candidate-only.
15. Do not create a real payment solely for technical verification unless the owner deliberately chooses a real-money test.

## 6. Manual OAuth/setup flow

The protected setup endpoint is:

`/oauth/monzo/setup/<alias>`

For Kristina the path is:

`/oauth/monzo/setup/kristina`

under the current Monzo management origin.

The user-facing flow implemented by `workers/lib/monzo-setup-flow.js` is:

### Step 1: owner access

The management route is behind Cloudflare Access and the Worker independently re-verifies the allowed owner identity.

Do not remove this boundary just to simplify onboarding.

### Step 2: Continue to Monzo

The Worker creates a high-entropy OAuth state bound to:

- artist alias;
- verified owner email;
- OAuth client ID;
- creation time.

State is stored temporarily in `MONZO_OAUTH_STATE` and consumed once on callback.

### Step 3: Monzo authentication

The browser is redirected to Monzo authorization with the server-configured:

- client ID;
- exact callback URI;
- random state.

Do not put the client secret in the browser or URL.

### Step 4: OAuth callback

The Worker:

- re-verifies the owner Access identity;
- consumes the single-use state;
- exchanges the authorization code server-side;
- validates returned token fields and exact OAuth client binding;
- validates Monzo user identity;
- stores access/refresh tokens only inside an AES-GCM encrypted artist token envelope in Workers KV.

### Step 5: Monzo app approval/SCA

Monzo can issue the token before separate in-app approval is complete.

If `/ping/whoami` or account access is still permission-blocked, the connection enters `approval_pending`. Do not throw away the token or restart OAuth immediately.

The correct manual instruction is:

1. open the Monzo app;
2. approve the requested access using the app's required authentication;
3. return to the setup page;
4. continue account selection.

### Step 6: account selection

The browser may submit a proposed `account_id`, but it is untrusted.

Before accepting it, the Worker re-lists allowed Monzo accounts using the authenticated token and selects only an account returned by Monzo. Closed/ineligible accounts must not become the receiving route.

### Step 7: setup confirmation

Do not restore the old immediate Workers KV write/read setup-confirmation design.

Workers KV is eventually consistent. The final design uses a short-lived AES-GCM sealed setup confirmation token bound to:

- owner email;
- artist alias;
- OAuth client ID;
- Monzo user ID;
- issue time.

The selected account remains separately re-fetched from Monzo.

### Step 8: webhook registration

The Worker generates/uses an opaque webhook key, stores a route record in `MONZO_WEBHOOK_ROUTES`, registers the Monzo webhook for the selected account, then stores the resulting webhook metadata only inside the encrypted artist token record.

If persistence fails after provider webhook creation, compensate by deleting the newly created webhook.

On success, the connection state becomes:

`webhook_registered`

## 7. Shared OAuth client vs separate artist state

Do not create a new Monzo OAuth application for Kristina by default.

The existing design intentionally uses one confidential production OAuth client while keeping per-artist connection records separate.

Separate per artist:

- artist alias;
- artist ID;
- deterministic provider account key;
- Monzo user binding;
- selected account ID;
- encrypted token record;
- webhook key;
- webhook ID;
- webhook route.

Shared infrastructure:

- Worker runtime;
- OAuth client ID/secret;
- callback URI;
- token encryption key;
- KV namespaces;
- Cloudflare Access boundary;
- reconciliation code.

Only create a second OAuth client if current Monzo provider requirements or a deliberate architecture change require it. Verify that from current provider documentation and current production behavior first.

## 8. Secrets and values that must never enter Git or chat output

Never commit or print:

- `MONZO_OAUTH_CLIENT_SECRET`;
- access tokens;
- refresh tokens;
- `MONZO_TOKEN_ENCRYPTION_KEY`;
- `SUPABASE_SECRET_KEY`;
- webhook opaque secret route keys;
- any newly obtained authorization code.

The tracked Wrangler file may contain non-secret routing identifiers and artist IDs, but secrets must remain encrypted Worker secrets / protected deployment inputs.

Do not rotate the shared token encryption key merely because another artist is being added. Rotating it without a migration would make existing encrypted artist token records unreadable.

## 9. Production Worker configuration to verify

The live production runtime should be checked against the current equivalent of:

`wrangler.monzo-api.production.toml`

Expected boundaries include:

- `workers_dev = false`;
- preview URLs disabled;
- owner-protected Monzo management Custom Domain;
- dedicated payment Custom Domain;
- three Monzo KV bindings;
- independent webhook and payment redirect rate limiters;
- production Supabase URL only;
- owner Access team domain/audience/email allow-list;
- exact OAuth callback URI;
- exact CRM return URL;
- exact webhook base URL;
- distinct Vladimir/Kristina artist IDs;
- reconciliation explicitly enabled only if the current candidate-only pipeline is verified.

Required secret names should be present without exposing values:

- `MONZO_OAUTH_CLIENT_ID`;
- `MONZO_OAUTH_CLIENT_SECRET`;
- `MONZO_TOKEN_ENCRYPTION_KEY`;
- `SUPABASE_SECRET_KEY`.

If these already exist, adding Kristina must not rotate them.

## 10. Deposit integration configuration

The existing finance-authorized RPC is:

`configure_monzo_easy_bank_transfer(artist_id, payment_url, is_enabled)`

It configures the artist-scoped Monzo Easy Bank Transfer destination and ensures the duration-tiered deposit policy exists.

For a new artist, use the normal CRM/RPC path when possible rather than direct table writes.

The compatibility `payment_url` should be the artist's standard GBP 250 reusable Monzo link unless the current implementation has deliberately changed.

After configuration, verify:

- integration type `payments`;
- provider `monzo_easy_bank_transfer`;
- deterministic integration key for the target artist;
- integration enabled only for the target artist;
- duration policy active;
- four canonical tiers present;
- no Vladimir artist ID or payment URL leaked into Kristina's integration.

## 11. Tier-specific reusable links

The final standard routing uses the immutable payment request amount to choose the Monzo destination.

For Kristina, provision exactly the standard rows required by current schema, normally:

- GBP 50;
- GBP 100;
- GBP 150;
- GBP 250.

Use a bounded idempotent production data operation, for example conceptually:

```sql
insert into public.monzo_easy_bank_transfer_tier_urls (
  artist_id, amount, currency, payment_url
) values (...)
on conflict (artist_id, amount, currency)
do update set
  payment_url = excluded.payment_url,
  updated_at = now();
```

Do not copy a real payment URL into a tracked migration or public PR body.

After provisioning, verify exactly four rows for the artist and prove all four URLs are distinct.

The resolver must still select by authoritative immutable `payment_requests.amount`, never browser input.

## 12. Group deposits and extra reusable links

As of this skill snapshot, the production tier table is intentionally constrained to the four standard per-session amounts 50/100/150/250 GBP.

The later product discussion considered aggregate deposits for several sessions, for example one payment covering 2-8 full-day sessions. That is a separate future feature.

Do not force 500/750/1000/etc. group links into the existing four-tier table without a new reviewed model. Group payment routing needs its own authoritative aggregate request semantics so one incoming payment can be safely allocated to the selected sessions.

Likewise, a one-off Monzo URL fallback for an uncommon aggregate amount should be scoped to one CRM payment request, not silently promoted into the global reusable-link catalogue.

## 13. Personal CRM link behavior

The client should receive an opaque Vishar CRM payment URL, not the reusable Monzo URL directly when the normal CRM flow is used.

The backend resolver:

- looks up an unrevoked personal link;
- accepts only pending or partially-paid payment requests;
- validates provider/account route;
- resolves the destination from the immutable request amount;
- validates the final `https://monzo.com/pay/r/...` shape;
- increments only link-open metadata;
- redirects to Monzo.

Opening the link must never:

- create a payment transaction;
- set a request to paid;
- mark a session paid;
- confirm a reconciliation candidate.

## 14. Reconciliation and payment confirmation

`register_monzo_reconciliation_candidate` is backend-only.

A verified incoming transfer can create or replay a candidate, but candidate creation still does not create a ledger transaction.

In CRM:

1. review the candidate;
2. Match it to an eligible request;
3. review the match;
4. Confirm payment separately;
5. only confirmation writes the immutable provider-origin payment ledger entry;
6. ledger-derived status then changes the payment request.

Never combine Match and Confirm into one automatic action as part of artist onboarding.

## 15. Bounded recovery sync

The setup page contains `Sync recent transfers` for recovery when a webhook was missed or reconciliation was temporarily broken.

Current bounded design historically used:

- a fixed recent window (72 hours);
- at most 100 listed transactions;
- at most 10 incoming hints individually re-fetched/account-verified;
- the same idempotent candidate RPC;
- no automatic settlement.

The action is protected by a short-lived encrypted sync confirmation bound to owner, artist, OAuth client/user, selected account and registered webhook.

Mobile Safari can submit an opaque `Origin: null`; current code treats that as an unavailable Origin signal only when the signed confirmation remains valid, while concrete foreign Origin and `Sec-Fetch-Site: cross-site` remain rejected.

Use recovery sync only when needed. It is not a polling service and there is no scheduled cron.

## 16. Known historical failures and their correct fixes

These are important because repeating the old implementation can recreate solved incidents.

### Token exchange response assumptions

Do not require exact case for OAuth `Bearer` token type. Do not invent a provider-specific maximum `expires_in` without evidence.

### SCA approval race

A token can exist before Monzo app approval gives it account permissions. Preserve the encrypted token and show `approval_pending`; do not immediately log it out.

### Immediate Workers KV setup confirmation

Do not use Workers KV for an immediate write-then-read confirmation token. It is eventually consistent. Use the sealed AES-GCM setup confirmation design.

### Reconciliation depended on payment-link configuration

A past incident rejected real incoming transfers with `payment provider/account route is not enabled` because reconciliation ownership was incorrectly coupled to an optional payment-link integration row.

Current reconciliation ownership should derive from the deterministic server-controlled artist/provider key for the active artist. Deposit request creation still requires the enabled payment integration, but inbound provider identity verification must not trust an optional browser-managed destination.

### Public payment route lost to Pages

Do not restore the old apex Worker Route for `/pay-by-bank-transfer/*`. The dedicated `pay.vishartattoo.com` Custom Domain was the reliable recovery.

## 17. Exact verification after Kristina onboarding

Perform all safe read-only checks autonomously.

Verify at minimum:

### Repository/runtime

- current Monzo product/release exact heads;
- exact live Worker name and routes;
- normal exact-head CI if code changed;
- no accidental Gmail/Calendar/Telegram/WhatsApp changes.

### Worker boundary

- owner management routes remain Access-protected;
- `status/kristina` reports the expected connection state through safe fields only;
- account label may be shown, account ID must not be exposed to CRM/browser diagnostics unnecessarily;
- webhook is registered;
- unknown opaque webhook fails safely;
- no secret values are printed.

### Supabase

- Kristina has exactly one expected enabled payment integration;
- provider account key corresponds to Kristina, not Vladimir;
- duration policy is active;
- four canonical deposit tiers exist;
- exactly four standard tier destinations are configured if that remains current schema;
- no direct browser read of the closed tier table;
- resolver remains service-backend-only;
- candidate RPC remains backend-only;
- human reconciliation RPCs remain permission-scoped;
- no RLS/ACL weakening.

### Isolation

Prove both directions:

- Vladimir payment request cannot route to Kristina's reusable URL;
- Kristina payment request cannot route to Vladimir's reusable URL;
- Vladimir webhook route cannot load Kristina's token/account route;
- Kristina webhook route cannot load Vladimir's token/account route.

### Financial state

Onboarding alone must create zero payment ledger transactions and mark zero requests paid.

Do not send a repeat real payment simply to prove setup.

## 18. Manual actions that may genuinely require the user

Stop only when physical user interaction is required.

Typical manual gates are:

1. Cloudflare Access login if the protected management page requires it.
2. Monzo login/authorization for Kristina's Monzo identity.
3. In-app Monzo SCA approval.
4. Choosing the intended receiving account when multiple valid accounts are shown.
5. Manually creating/copying reusable Monzo Business payment links, because the connected Developer API does not create those Business Payment Links.
6. Approving the protected `crm-production` GitHub environment if a real production deployment/migration is necessary.

When a manual action is required, give the exact URL/path, exact button, exact expected result, and any value to enter as a separate copyable block.

After the user reports completion, continue automatically without asking permission again.

## 19. What not to do for a second artist

Do not:

- create a second production Monzo Worker unless architecture has deliberately changed;
- create a second set of KV namespaces solely because the artist is different;
- rotate the shared token encryption key;
- store Monzo access/refresh tokens in Supabase;
- store Monzo credentials in CRM frontend state;
- let the browser choose artist ID, provider account key or authoritative account ID;
- trust webhook payload fields as payment evidence;
- expose raw Monzo account IDs, webhook IDs/keys or tokens to GPT/CRM UI;
- auto-confirm payment when a webhook arrives;
- auto-confirm payment when a candidate matches an amount;
- use synthetic production financial data;
- mutate retained staging unless staging is actually in scope;
- copy Vladimir's payment integration row or token envelope to Kristina;
- commit real reusable payment URLs to public Git history.

## 20. Historical landmarks for recovery

Use these PRs to understand why the current boundaries exist. Always fresh-check current state instead of assuming their SHAs are still deployable.

- PR #202: initial Monzo Easy Bank Transfer deposits, personal links and candidate-only DB foundation.
- PR #203: server-only Monzo OAuth/token/webhook foundation.
- PR #273: owner-only account selection and live webhook registration flow.
- PR #289: public webhook rate limiting.
- PR #304: production-ready Monzo runtime on the tiered-deposit product stack.
- PR #310: safe token-exchange response validation.
- PR #315: preserve token across Monzo SCA approval race.
- PR #317 / #318: sealed setup confirmation replacing immediate KV consistency dependence and its production rollout.
- PR #319 / #320: candidate-only production reconciliation activation.
- PR #329: reconciliation route recovery and bounded recent-transfer sync.
- PR #337 / #338 / #339 / #340: mobile-safe signed recovery sync, including opaque iOS Origin handling.
- PR #353 / #354: dedicated `pay.vishartattoo.com` payment Custom Domain.
- PR #358 / #359: four server-side tier-specific reusable Monzo destinations.

## 21. Fast-path checklist for Kristina

When Kristina is ready, use this compact sequence only after the full fresh-state preflight:

1. Verify `kristina` alias and current `KRISTINA_ARTIST_ID` in live Worker code/config.
2. Verify shared Worker secrets/KV/Access are healthy; do not rotate them.
3. Verify production Supabase migration head and Kristina's current payment integration state.
4. Collect her standard reusable GBP 50/100/150/250 Business Payment Links without committing them.
5. Open the protected Kristina setup route.
6. Complete Monzo OAuth with Kristina's Monzo identity.
7. Complete Monzo app approval if requested.
8. Select the intended receiving account.
9. Verify `webhook_registered` and artist/account isolation.
10. Configure her Monzo Easy Bank Transfer integration with her GBP 250 compatibility URL.
11. Provision her four tier URLs through a protected production operation.
12. Verify a server-calculated deposit routes to the correct amount-specific Kristina destination without settling anything.
13. Verify reconciliation remains candidate-only and Match/Confirm remain separate.
14. Leave Vladimir's token, webhook, integration, tier URLs and payment history unchanged.

If all current infrastructure matches this design, onboarding the second artist should require much less engineering than the original Vladimir rollout.