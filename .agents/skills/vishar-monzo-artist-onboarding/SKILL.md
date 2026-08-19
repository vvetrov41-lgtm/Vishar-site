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
- `0063_monzo_tier_specific_deposit_links.sql`;
- `0064_monzo_artist_payment_destinations.sql`.

Trace the final effective definition of every function at the ref you are on. Several of these migrations replace the same functions, and `0064` is the current definition of `resolve_monzo_deposit_redirect` and `request_session_deposit`.

The duration policy is server-owned:

- up to 60 minutes -> GBP 50;
- up to 180 minutes -> GBP 100;
- up to 300 minutes -> GBP 150;
- over 300 minutes / full day -> GBP 250.

The browser must never authoritatively choose the deposit amount. `request_session_deposit(...)` resolves the tier from the persisted session duration and creates/replays a request with that immutable amount.

### B. Reusable Monzo payment destinations

`artist_integrations` contains the enabled Monzo Easy Bank Transfer payment integration for an artist. The legacy/configuration `payment_url` is the GBP 250 compatibility destination.

Reusable destinations are held in the closed server-side catalogue:

`public.monzo_payment_destinations`

keyed by:

- `artist_id`;
- `amount`;
- `currency`.

The key is deliberately only that triple. No business meaning such as "tier 4" or "four sessions" is encoded anywhere in the key, so a new supported amount is a new row and never a schema change. The table accepts any positive GBP amount up to 100000.00; the bound is an anti-typo guard, not a policy.

Migration `0064_monzo_artist_payment_destinations.sql` renamed this table from the earlier `monzo_easy_bank_transfer_tier_urls` and dropped its fixed 50/100/150/250 amount constraint. The rename preserved every existing row, so no live destination changed.

This table uses FORCE RLS and intentionally has no direct browser or service-role SELECT grant. There is intentionally no authenticated CRUD RPC for these rows. Production values are operator-owned routing configuration.

Do not commit real reusable Monzo payment URLs into the public repository. Provision them through the bounded protected production operation in section 11.

### C. Monzo Developer API connection

The shared production Worker is:

`vishar-monzo-api-production`

The owner-protected management/OAuth hostname is:

`monzo.vishartattoo.com`

The final production payment redirect hostname is:

`pay.vishartattoo.com`

Do not reintroduce the old apex Pages/Worker route for client payment links. A dedicated `pay.vishartattoo.com` Custom Domain was adopted after the apex Worker Route lost to the public Pages application on real iPhone navigation.

Lineage note: the dedicated payment host was delivered on a branch that is a sibling of, not an ancestor of, the current product head. On a head that still carries `PAYMENT_HOST = 'vishartattoo.com'` in `workers/monzo-api-gateway.js`, that host constant is the older apex design and not a regression introduced by the destination work. Fresh-check the deployed route before drawing any conclusion about production.

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

Routable artists come from one registry, `workers/lib/monzo-artist-registry.js`. Every Monzo surface reads it, so an artist cannot be reachable in one place and invisible in another:

- the owner-protected route pattern in `workers/monzo-api.js`;
- OAuth state, token envelope and disconnect validation;
- the setup flow and its display names;
- the readiness/health report.

`admin/src/lib/monzo-connector.ts` carries the matching CRM alias list, and `scripts/test-monzo-artist-registry.mjs` fails if the two drift.

Current registry aliases:

- `vladimir`;
- `kristina`.

Adding a third artist later is: one registry entry, one `<ALIAS>_ARTIST_ID` Worker binding, one CRM alias entry, and that artist's own connection plus destinations. No new Worker, KV namespace, encryption key or migration.

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

If current code still contains the `kristina` registry entry, her correct artist ID and the same security boundaries, do not create a second Monzo Worker, second set of KV namespaces, second encryption key or second OAuth client.

The expected minimum sequence is:

1. Kristina opens the required Monzo Business account.
2. Confirm her CRM artist ID from `public.artists` where `slug = 'kristina'`, and confirm it matches `KRISTINA_ARTIST_ID` in the deployed Worker configuration.
3. Create the reusable Easy Bank Transfer payment links she needs (section 11).
4. Fresh-check the production Monzo Worker and Supabase state.
5. Confirm the shared production OAuth client and callback are still valid. Do not create a new client.
6. Start the protected setup flow at `/oauth/monzo/setup/kristina`.
7. Complete Monzo OAuth using Kristina's Monzo identity.
8. Approve access in the Monzo app if Monzo requires SCA approval.
9. Select the tattoo-payment receiving account.
10. Let the Worker re-fetch that account and register the webhook.
11. Verify the encrypted artist token record and webhook route are active through safe status evidence, never by reading or printing credentials.
12. Configure her CRM Monzo Easy Bank Transfer payment integration with `configure_monzo_easy_bank_transfer` (section 10).
13. Provision her reusable destinations through the prepared operator path (section 11).
14. Verify deposit requests route to her destinations and not Vladimir's (section 17).
15. Verify reconciliation candidates are artist-scoped and remain candidate-only.
16. Do not create a real payment solely for technical verification unless the owner deliberately chooses a real-money test.

### What the system already derives, and what a human must supply

**A. Already known to Vishar CRM — never ask for these.**

- Kristina's CRM artist identity, from `public.artists.slug = 'kristina'`.
- The alias `kristina`, from the Worker artist registry and the artist slug.
- The provider account key `monzo_ebt_<artist UUID without hyphens>`, derived server-side.
- Every artist-scoped route: setup, status, accounts, account selection, webhook registration, disconnect.
- The production Supabase project, Worker, KV namespaces, token encryption key and Cloudflare Access boundary.

**B. A human must supply these.**

- Nothing at all for the Monzo developer client, unless a deliberate decision is made to give Kristina her own — the shared confidential client is the correct default.
- Kristina's Monzo login and OAuth authorisation.
- Kristina's in-app Monzo SCA approval.
- Which receiving Monzo account to select, when several are eligible.
- Her reusable Monzo Business Payment Links: GBP 50, 100, 150, 250, and optionally grouped totals such as 500, 750, 1000, 1250, 1500, 1750, 2000. The connected Developer API cannot create these.
- A one-off Monzo URL, only when a real request produces an amount she has no reusable link for.
- Cloudflare Access login for the protected management page, and `crm-production` environment approval for a protected production operation.

**C. Generated automatically — never ask a human for these.**

- The OAuth state value.
- Access and refresh tokens, and the AES-GCM encrypted token envelope.
- The opaque webhook key and the Monzo webhook ID.
- Personal CRM payment-link UUIDs.
- Reconciliation candidate records.
- Deposit amounts, grouped totals and destination selection.

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

Only create a second OAuth client if current Monzo provider requirements or a deliberate architecture change require it. Verify that from current provider documentation and current production behavior first. The Monzo Developer API contract confirms the shared design: an access token is tied to a client **and** an individual Monzo user, and one confidential client may be authorised by many users independently.

The runtime is nevertheless already prepared for a per-artist client without a rewrite. `artistMonzoConfig(alias, env)` returns `oauthClientId` and an artist-scoped `oauthEnv`, and every provider call uses that view rather than the raw Worker env. If an artist ever needs its own client, set both of:

- `MONZO_OAUTH_CLIENT_ID_<ALIAS>`;
- `MONZO_OAUTH_CLIENT_SECRET_<ALIAS>`.

These are unset in production today and must stay unset unless a per-artist client is genuinely required. Setting only one half fails closed for that artist and never mixes one artist's client id with the shared secret.

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

`configure_monzo_easy_bank_transfer` refuses to enable Monzo while a different payment destination is enabled for the same artist, and it is artist-scoped, so configuring Kristina cannot alter Vladimir.

## 11. Reusable destinations and how to provision them

The final standard routing uses the immutable payment request amount to choose the Monzo destination. `payment_requests.amount` is server-calculated and immutable after creation, so the browser can never select a cheaper amount and thereby reach a different destination.

For a new artist provision at least the four standard single-session amounts:

- GBP 50;
- GBP 100;
- GBP 150;
- GBP 250.

Optionally also provision grouped totals the artist expects, for example GBP 500, 750, 1000, 1250, 1500, 1750, 2000. Nothing breaks without them: an amount with no destination fails closed rather than routing anywhere else.

### The prepared operator path

1. Collect the artist's reusable Monzo Business Payment Links. The connected Developer API cannot create these; the artist creates them in the Monzo app.

2. Write a plan file **outside the repository**:

```json
[
  { "amount": 50,  "payment_url": "https://monzo.com/pay/r/..." },
  { "amount": 100, "payment_url": "https://monzo.com/pay/r/..." },
  { "amount": 150, "payment_url": "https://monzo.com/pay/r/..." },
  { "amount": 250, "payment_url": "https://monzo.com/pay/r/..." }
]
```

The plan cannot name the artist. The artist is chosen by the operator command, not by the file.

3. Validate it offline, with no database and no network:

```bash
node scripts/validate-monzo-destination-plan.mjs /path/to/plan.json
```

It rejects a non-Monzo host, a query string, a duplicate amount, a duplicate URL, a sub-penny amount and any extra field, and it reports which standard amounts the plan would leave unrouted. It never echoes a URL.

4. Apply it through the protected production database gate:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v artist_slug="kristina" \
  -v destinations="$(cat /path/to/plan.json)" \
  -f scripts/monzo/provision-artist-payment-destinations.sql
```

The statement is idempotent, refuses an artist with no enabled Monzo integration, refuses a URL that already belongs to another artist or to a one-off request destination, and prints only amounts and URL fingerprints.

5. Verify, read-only:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v artist_slug="kristina" \
  -f scripts/monzo/verify-artist-payment-destinations.sql
```

`cross_artist_url_violations` and `provider_ledger_entries` must both be `0` after onboarding.

Never paste a real payment URL into a pull request body, an issue, a commit message or a chat transcript.

## 12. Grouped deposits

One payment may cover several tattoo sessions of one project. This is a normalized relation, not hidden JSON:

- `public.session_deposit_groups` — one row per grouped deposit, bound to the aggregate `payment_requests` row, the artist, the client, the project and the active policy version;
- `public.session_deposit_group_members` — one row per covered appointment with the server-derived amount, duration and tier bound at request time.

Both tables use FORCE RLS with no browser or service-role grant.

The RPC is:

`request_grouped_session_deposit(p_session_ids uuid[], p_idempotency_key uuid, p_delivery_channel text)`

It is finance-authorised and derives every amount itself:

- 2 to 12 distinct appointments;
- one artist, one client and one project;
- every appointment project-backed, of type `tattoo_session`, and not finished;
- every per-session amount from `crm_private.resolve_session_deposit_tier`, so mixed durations produce totals such as GBP 350, 550 or 600 naturally;
- all appointments must share one active policy version;
- the total is the sum, and it is the immutable request amount.

Duplicate financial allocation is prevented in both directions. An appointment that already has its own pending/partially paid/paid deposit cannot be grouped, and an appointment covered by a live group cannot raise its own single-session deposit. A partial unique index enforces one live membership per appointment.

Idempotency is the group's `idempotency_key`: replaying it returns the same group and payment request regardless of appointment order, and reusing it with a different appointment set is rejected.

Cancelling or expiring the grouped payment request releases its members (`released_at`), so those appointments can be grouped again. Membership rows and their calculated amounts are retained as audit evidence. `get_session_deposit_group(p_payment_request_id)` returns finance-scoped coverage evidence: which appointments, what each contributed, the total, net paid, outstanding and the current status. It returns no URL, provider identifier or credential.

Refunds, repricing and reallocation after a covered session is later cancelled are deliberately **not** automated. Answer them with the retained member rows and the existing manual refund RPC.

## 12b. One-off destinations

If CRM calculates a legitimate deposit amount the artist has no reusable destination for, an authorised finance user may attach one Monzo URL to that specific request:

`attach_monzo_one_off_payment_destination(p_payment_request_id uuid, p_payment_url text)`

Bounded by design:

- the request must be an open GBP Monzo deposit whose amount is already server-authoritative — a single-session deposit or a grouped deposit. An arbitrary hand-made request amount is refused;
- the artist must still own that exact enabled Monzo route;
- the URL must match the exact `https://monzo.com/pay/r/...` shape;
- it is refused when the amount already has a reusable destination, so reusable routing is never overridden per request;
- the URL may not already be a reusable destination for any artist, and may not be attached to any other payment request;
- it is never promoted into the reusable catalogue;
- the action is audited as `payment.one_off_destination_attached`;
- it changes no amount and settles nothing.

Resolution order in `crm_private.resolve_monzo_payment_destination` is: request-specific one-off, then the artist catalogue, then the legacy GBP 250 compatibility URL. There is no cross-artist step at any point, and an unresolved amount fails closed.

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
- her intended reusable destinations exist in `public.monzo_payment_destinations` and are all distinct;
- `cross_artist_url_violations` is `0`;
- no direct browser or service-role read of the closed destination, one-off or grouped tables;
- resolver remains service-backend-only;
- candidate RPC remains backend-only;
- human reconciliation RPCs remain permission-scoped;
- no RLS/ACL weakening, and the canonical `expected_function_acl` inventory in `supabase/tests/050_rls_roles.sql` still matches.

Run `scripts/monzo/verify-artist-payment-destinations.sql` for most of this. It prints no URL and is safe to paste.

### Isolation

Prove both directions:

- Vladimir payment request cannot route to Kristina's reusable URL;
- Kristina payment request cannot route to Vladimir's reusable URL;
- an artist with no destination for an amount fails closed rather than borrowing one;
- a one-off destination serves only its own payment request;
- Vladimir webhook route cannot load Kristina's token/account route;
- Kristina webhook route cannot load Vladimir's token/account route;
- neither artist's OAuth state, token envelope or selected account can be replayed under the other alias.

`scripts/test-monzo-artist-isolation.mjs`, `scripts/test-monzo-artist-registry.mjs` and `supabase/tests/215_monzo_artist_payment_destinations.sql` assert all of these; run them at the exact head rather than reasoning about them.

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

## 19b. Expected failure states

These are correct behaviour, not defects. Do not "fix" them by widening a boundary.

| Symptom | Meaning | Correct action |
| --- | --- | --- |
| `artist_route_unconfigured` (404) | the alias is not in the registry, or its `<ALIAS>_ARTIST_ID` binding is missing or malformed | add the registry entry and the binding; never reuse another artist's id |
| `provider_route_invalid` (503) | a stored token, webhook route or OAuth client no longer matches the artist scope | investigate; never relax the comparison |
| `monzo_not_connected` (409) | that artist has no encrypted token envelope | complete the setup flow for that artist |
| `approval_pending` state | Monzo issued a token before in-app SCA approval | approve in the Monzo app, return to the setup page; do not restart OAuth |
| `Payment link unavailable` on a redirect | the request is closed/expired, or the amount has no destination for that artist | provision the destination, or attach a one-off; never add a cross-artist fallback |
| `this amount already has a reusable destination` | a one-off was attempted for a covered amount | use the reusable destination, or correct the catalogue |
| `an appointment already has its own deposit request` | grouping would double-allocate | cancel the single-session request first, or exclude that appointment |
| `the appointment is already covered by a grouped deposit` | the reverse of the above | settle or cancel the group first |
| `reconciliation_disabled` (503) | `MONZO_RECONCILIATION_ENABLED` is not `true` | a deployment decision, not a code change |

### Rollback and disconnect

Disconnecting one artist is artist-specific and cannot affect another. `/oauth/monzo/disconnect/<alias>` requires owner Access plus a single-use confirmation, deletes that artist's encrypted envelope and webhook route, attempts to delete the Monzo webhook and invalidate the access token, and leaves every other artist untouched.

To roll back destination provisioning, rerun the provisioning statement with the corrected plan; it is idempotent. To stop an artist taking new deposits without disconnecting, disable her `artist_integrations` row — deposit requests then fail closed and existing links stop resolving. Neither action touches the immutable ledger, and neither is a way to reverse a confirmed payment.

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
- Migration `0064`: artist-generic and amount-generic destination catalogue, grouped session deposits, request-specific one-off destinations, and the artist registry that removes every per-artist code path.

## 21. Fast-path checklist for Kristina

When Kristina is ready, use this compact sequence only after the full fresh-state preflight:

1. Verify the `kristina` registry entry and the current `KRISTINA_ARTIST_ID` in live Worker code/config, and that it matches `public.artists.slug = 'kristina'`.
2. Verify shared Worker secrets/KV/Access are healthy; do not rotate them and do not create a per-artist OAuth client.
3. Verify the production Supabase migration head and Kristina's current payment integration state.
4. Collect her reusable Business Payment Links without committing them, and validate the plan offline with `node scripts/validate-monzo-destination-plan.mjs`.
5. Open the protected Kristina setup route.
6. Complete Monzo OAuth with Kristina's Monzo identity.
7. Complete Monzo app approval if requested.
8. Select the intended receiving account.
9. Verify `webhook_registered` and artist/account isolation.
10. Configure her Monzo Easy Bank Transfer integration with her GBP 250 compatibility URL.
11. Provision her destinations with `scripts/monzo/provision-artist-payment-destinations.sql` through the protected production database gate.
12. Verify with `scripts/monzo/verify-artist-payment-destinations.sql`; `cross_artist_url_violations` and `provider_ledger_entries` must both be `0`.
13. Verify a server-calculated deposit routes to the correct amount-specific Kristina destination without settling anything.
14. Verify reconciliation remains candidate-only and Match/Confirm remain separate.
15. Leave Vladimir's token, webhook, integration, destinations and payment history unchanged.

If all current infrastructure matches this design, onboarding the second artist should be configuration and approvals only, with no engineering work.

## 22. What must never auto-settle

No amount of provider activity may write the ledger on its own. Every one of these is navigation, metadata or a human-reviewable hint, and each is asserted by a test:

- opening a personal CRM payment link;
- opening a reusable or one-off Monzo destination;
- receiving a Monzo webhook;
- creating or replaying a reconciliation candidate;
- running the bounded recovery sync;
- `Match`;
- requesting a single-session or grouped deposit;
- attaching a one-off destination.

Only `confirm_monzo_reconciliation_candidate`, or an explicit human `record_manual_payment`, writes `public.payment_transactions`, and only the resulting ledger changes a payment request's status. Never combine Match and Confirm, and never settle on an amount match alone.
