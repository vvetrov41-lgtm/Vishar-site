---
name: vishar-monzo-artist-onboarding
description: Safely onboard, recover and extend an artist-scoped Monzo Business connection in Vishar CRM. Covers shared OAuth client usage, per-artist encrypted token/account/webhook isolation, reusable payment destinations, Multiple Sessions deposits, request-specific one-off links, dedicated payment redirects, reconciliation and production verification. Never auto-settle payments or reuse one artist's payment URLs for another artist.
---

# Vishar Monzo Artist Onboarding

Use this skill when preparing, connecting, recovering or verifying Monzo for a Vishar CRM artist, especially Kristina, or when extending the shared payment system to another artist.

The target architecture is one shared Monzo runtime with artist-scoped configuration and state. Do not create a second Worker, token store or payment stack merely because another artist is being connected.

This is payment/security-sensitive work. Before substantial investigation or mutation read:

- repository root `AGENTS.md`;
- `docs/ai/README.md`;
- `docs/ai/branch-workflow.md`;
- `docs/ai/security-boundaries.md`;
- `.agents/skills/vishar-code-navigation/SKILL.md`.

## 1. Fresh-state rule

Never execute onboarding from an old handoff alone. Before every stage verify:

1. current PR, branch, exact head and base SHAs;
2. current production Supabase migration head;
3. retained staging migration head if relevant;
4. current deployed `vishar-monzo-api-production` Worker configuration and routes;
5. current artists and artist IDs;
6. current `artist_integrations` Monzo rows;
7. target artist connection status;
8. reusable destination state without printing URLs;
9. exact-head CI.

Current code, migrations, grants, RLS, Worker configuration and live evidence override historical documentation.

## 2. Non-negotiable boundaries

Preserve all of these:

- browser data never authoritatively chooses `artist_id`, payment amount, provider account key, receiving account or reusable destination;
- Monzo OAuth access/refresh tokens stay encrypted server-side, never in Supabase, browser data, Git or logs;
- webhook bodies are untrusted hints;
- incoming transactions are independently re-fetched from Monzo;
- `Match` does not settle payment;
- `Confirm payment` is a separate human action;
- opening a payment link never settles payment;
- reusable URLs belong to one artist and exact amount;
- a one-off URL belongs to exactly one payment request;
- no cross-artist payment-URL fallback;
- no weakening of RLS, RPC ACL, Cloudflare Access or rate limits;
- no real payment URLs, credentials or tokens in tracked source or PR text;
- retained staging is not automatically advanced with production.

## 3. Runtime and public routing

Shared production Worker:

`vishar-monzo-api-production`

Owner-protected management/OAuth hostname:

`monzo.vishartattoo.com`

Public customer payment hostname:

`pay.vishartattoo.com`

Do not restore the failed apex Worker Route on `vishartattoo.com/pay-by-bank-transfer/*`. Real iPhone navigation proved that the public Pages application could win that route. The dedicated payment Custom Domain must fail closed except strict GET requests matching:

`/pay-by-bank-transfer/<opaque UUID>`

## 4. Artist registry

Routable Monzo artists are defined centrally in:

`workers/lib/monzo-artist-registry.js`

The CRM carries the matching alias list in:

`admin/src/lib/monzo-connector.ts`

Current intended aliases are `vladimir` and `kristina`.

The registry controls route matching, artist-ID bindings, OAuth client resolution, display name, OAuth state validation, token-record alias validation, setup/disconnect and readiness checks.

Adding another artist is a small bounded code/config change, not literally configuration-only while aliases remain tracked source. Expect at least:

- one registry entry;
- one CRM alias entry;
- one `<ALIAS>_ARTIST_ID` Worker binding;
- that artist's own OAuth/account/webhook state;
- that artist's own reusable payment destinations.

Do not create a second Worker or KV namespace set for an ordinary additional artist.

## 5. Artist IDs and provider account keys

Historical IDs when revised on 2026-08-19:

- Vladimir: `a1111111-1111-4111-8111-111111111111`;
- Kristina: `a2222222-2222-4222-8222-222222222222`.

Fresh-check before use.

Provider account key is deterministic and server-derived:

`monzo_ebt_<artist UUID with hyphens removed>`

The browser never supplies it as routing authority.

## 6. OAuth client model

Do not create a separate Monzo Developer OAuth application for Kristina by default.

The correct default is one shared confidential OAuth client. Monzo tokens remain bound to the OAuth client and the individual Monzo user, so different artists authorize the same confidential client while retaining separate user/token/account state.

Shared:

- OAuth client ID/secret;
- callback URI;
- Worker runtime;
- encryption key;
- KV namespaces;
- Cloudflare Access boundary.

Artist-specific:

- alias and CRM artist ID;
- Monzo user ID;
- encrypted token envelope;
- selected bank account;
- provider account key;
- webhook key/ID/route;
- reusable destinations;
- one-off request destinations;
- reconciliation provenance.

Optional per-artist client overrides may exist, but ID and secret must be configured together. A half-configured override must fail closed.

## 7. Token custody and OAuth incident fixes

Tokens are AES-GCM encrypted before Workers KV storage and bound to the artist route and identity facts. A Vladimir token may never satisfy a Kristina route and vice versa.

Do not regress these historical fixes:

- Bearer token type validation is case-insensitive;
- do not invent an `expires_in <= 86400` maximum;
- when Monzo issues a token before in-app SCA approval completes, preserve the token and retry after approval rather than restarting OAuth;
- setup confirmation must not depend on immediate KV read-after-write consistency;
- signed iOS recovery may legitimately carry `Origin: null`; the signed confirmation remains anti-CSRF authority while concrete foreign origins remain rejected.

## 8. Account selection and webhooks

The browser may propose an account ID, but the Worker re-lists eligible Monzo accounts with that artist's token and accepts only a server-observed account.

Webhook flow remains:

1. resolve opaque artist-bound route;
2. load that artist's encrypted token;
3. validate client/user/account/provider binding;
4. re-fetch the transaction from Monzo;
5. verify selected account ownership;
6. accept only intended incoming GBP credit shape;
7. create/replay a reconciliation candidate only.

A webhook never proves settlement.

## 9. Single-session deposit policy

Current server-owned session policy:

- up to 60 minutes: GBP 50;
- up to 180 minutes: GBP 100;
- up to 300 minutes: GBP 150;
- over 300 minutes/full day: GBP 250.

`request_session_deposit(...)` derives the amount from persisted appointment duration. `payment_requests.amount` is then immutable. A later reschedule or duration edit must not silently reprice that old request.

## 10. Reusable Monzo destinations

Closed catalogue:

`public.monzo_payment_destinations`

Key:

- `artist_id`;
- `amount`;
- `currency`.

Migration `0064_monzo_artist_payment_destinations.sql` renames the earlier tier table in place. This preserves Vladimir's already provisioned production GBP 50/100/150/250 rows and URLs.

Critical isolation:

- Vladimir's existing URLs stay his;
- Kristina later receives her own URLs;
- never copy Vladimir URLs into Kristina rows;
- missing Kristina amount fails closed rather than borrowing Vladimir's;
- real URLs never belong in Git.

The catalogue is amount-generic. Standard single-session values and high-value Multiple Sessions values are ordinary rows. For example, GBP 500, 750, 1000, 1250, 1500, 1750 and 2000 require no schema change. Mixed totals such as GBP 350, 550 or 600 are also valid exact amounts if a reusable destination exists.

Provision through:

`scripts/monzo/provision-artist-payment-destinations.sql`

Validate runtime input first with:

`node scripts/validate-monzo-destination-plan.mjs <plan.json>`

The plan contains amount + URL only; artist selection is a separate protected operator input.

## 11. Multiple Sessions deposits

Migration `0065_monzo_multiple_session_deposits.sql` adds normalized group coverage.

Tables:

- `public.session_deposit_groups`;
- `public.session_deposit_group_members`.

Both use FORCE RLS with no direct browser/service-role table grant.

Authenticated finance RPC:

`request_grouped_session_deposit(p_session_ids uuid[], p_idempotency_key uuid, p_delivery_channel text)`

Required behavior:

- 2-12 distinct appointments;
- exactly one artist, one client and one project;
- project-backed `tattoo_session` appointments only;
- no completed/cancelled/no-show appointment;
- each component amount comes from `crm_private.resolve_session_deposit_tier`;
- all components share one active policy version/currency;
- total is the exact sum of server-derived component amounts;
- browser never submits authoritative artist/project/amount;
- deterministic session locking prevents overlapping concurrent group races;
- a session with a pending/partially-paid/paid individual deposit cannot enter a group;
- a session in a live group cannot receive an individual deposit;
- one live group per session is also enforced by a partial unique index;
- replaying the same idempotency key with the same normalized session set returns the same group/request;
- reusing that key with another set is rejected.

A group request is one ordinary immutable `payment_requests` row whose `session_id` is null and whose project/artist/client are fixed. Coverage is answered from normalized member rows, not hidden JSON.

`get_session_deposit_group(p_payment_request_id)` returns finance-scoped evidence: covered sessions, their frozen component amounts/durations, total, net paid, outstanding and request status. It returns no payment URL, account ID or provider transaction identifier.

Cancelling/expiring an unpaid group releases its live member allocations by setting `released_at`, while retaining historical rows. Paid groups do not silently release coverage.

## 12. Multiple Sessions destination selection

Group amount determines destination exactly the same way as a single-session immutable request.

Examples:

- two GBP 250 components -> total GBP 500 -> this artist's reusable GBP 500 row if present;
- three GBP 250 components -> GBP 750 -> this artist's reusable GBP 750 row if present;
- GBP 250 + GBP 250 + GBP 50 -> GBP 550 -> this artist's reusable GBP 550 row if present, otherwise fail closed until a one-off is attached.

There is no meaning encoded as "three sessions" inside the payment destination. Routing remains exact `(artist_id, amount, currency)`.

Vladimir's high-value reusable links remain Vladimir's. Kristina must create/provision her own high-value links if she wants those totals to resolve reusable instead of one-off.

## 13. Request-specific one-off Monzo links

RPC:

`attach_monzo_one_off_payment_destination(p_payment_request_id uuid, p_payment_url text)`

Browser supplies only payment request ID + proposed clean Monzo URL. Database derives artist, provider route, immutable amount and currency.

Permitted request provenance:

- a normal server-priced single-session deposit with policy snapshot; or
- a normalized Multiple Sessions deposit whose group row proves artist/client/project/total/currency.

Arbitrary project-level payment requests are not accepted as a shortcut.

A one-off:

- applies only to an open GBP Monzo deposit;
- is rejected when that same artist already has a reusable destination for the exact amount;
- cannot reuse any catalogue URL;
- cannot be shared by another payment request;
- never enters the reusable catalogue;
- never changes request amount;
- never creates a payment ledger row or paid status.

Do not reprice an old single-session request from today's appointment duration when attaching one-off. The immutable request amount remains authoritative.

## 14. Public redirect

Customer path:

`https://pay.vishartattoo.com/pay-by-bank-transfer/<opaque UUID>`

Backend resolver uses immutable request facts. Destination order:

1. request-specific one-off for same request/artist/amount;
2. reusable catalogue row for same artist/amount/currency;
3. same-artist legacy GBP 250 compatibility destination only.

There is no cross-artist or wrong-amount fallback. Opening the link never proves payment.

## 15. Reconciliation boundary

Human flow remains:

`verified candidate -> Match -> Confirm payment -> immutable payment transaction`

`Ignore` stays separate.

Never auto-settle from webhook data, amount equality, client guess, link opening, candidate creation, recovery sync, group creation or Match.

Only explicit Confirm, or a deliberate manual-payment RPC, may write settlement into the immutable ledger.

## 16. Kristina onboarding

Before Kristina has a real Monzo Business account, do not create fake token/account/webhook/payment URLs.

When her account exists:

1. fresh-check repo, CI, production DB and Worker;
2. confirm `kristina` artist ID and deployed binding;
3. confirm registry/CRM alias;
4. use the existing shared confidential OAuth client;
5. pass Cloudflare Access and start `/oauth/monzo/setup/kristina`;
6. complete Kristina Monzo login and in-app SCA;
7. select her receiving account and let Worker re-fetch it;
8. register her artist-bound webhook;
9. configure/enable her CRM Monzo integration;
10. create her own standard reusable links GBP 50/100/150/250;
11. create any high-value reusable links she wants for Multiple Sessions, such as GBP 500/750/1000/etc.;
12. provision only Kristina URLs through the protected operator;
13. verify no URL is shared with Vladimir;
14. verify both single and Multiple Sessions requests resolve only Kristina destinations;
15. verify a missing exact amount fails closed or uses only a request-specific one-off;
16. verify reconciliation remains candidate-only until human Confirm.

No new Monzo Developer Client ID/Secret is required by default.

## 17. Read-only verification

Use the repository verification script and current SQL schema inspection. Safe output may include:

- artist slug;
- integration enabled state;
- artist-derived provider-key boolean;
- active policy version/tier count;
- configured amounts;
- short URL fingerprints, never URLs;
- cross-artist URL violation count;
- one-off count;
- Multiple Sessions group counts/amounts/status without URL values;
- provider-ledger count as settlement sanity check.

Expected before Kristina onboarding: artist exists, no Monzo integration, no Kristina destinations, Vladimir rows untouched.

After onboarding: Kristina has her own enabled route and own destinations, no shared URL, resolver is backend-only and reconciliation boundaries are unchanged.

## 18. Disconnect/reconnect

Disconnect affects only target artist encrypted token, webhook route/provider registration and connection state. It must never remove another artist's token/account/webhook/destination state.

Reusable destination configuration is separate operator-owned routing data. Do not delete it casually during OAuth reconnect.

## 19. Production/staging boundaries

Historical snapshot at this revision:

- production project `vfjexhfdbrjmuxfdvbdx` was through migration `0063_monzo_tier_specific_deposit_links`;
- retained staging `gwaliusblwrzisrwnsvs` was through `0044_monzo_payment_url_validator`.

Fresh-check every time. Do not advance retained staging merely to make versions match.

Before production rollout:

- confirm exact product head and current parallel PRs;
- confirm migration numbers are still canonical;
- run exact-head CI including clean reset, pgTAP and PostgreSQL lint;
- use existing protected production operator/environment approval;
- apply only bounded Monzo/database/CRM pieces needed;
- preserve Vladimir connection and all his existing destinations;
- preserve `pay.vishartattoo.com` dedicated routing;
- keep Kristina unconnected until her real onboarding;
- perform no real-money verification unless deliberately approved;
- do not merge or mark Ready unless separately instructed.

## 20. Common failure states

`artist_route_unconfigured`: missing/invalid artist registry binding. Fix it; never fall back to another artist.

`approval_pending`: token exists but Monzo in-app SCA is incomplete. Preserve token, approve in app, then continue.

`monzo_not_connected`: target artist has no encrypted connection. Run only that artist's setup flow.

`Payment link unavailable`: request is closed/expired or same artist has no exact destination. Provision correct reusable row or attach one-off. Never borrow another artist URL.

`this amount already has a reusable Monzo destination`: use reusable destination rather than one-off.

`an appointment already has its own deposit request`: cancel the unpaid individual request or remove that appointment from group.

`the appointment is already covered by a grouped deposit`: settle/cancel that group or choose another appointment.

## 21. Secret rules

Never print, paste, commit or put in PR text:

- Monzo Client Secret;
- access/refresh token;
- token-encryption key;
- Supabase secret/service credential;
- real reusable payment URLs;
- real one-off URLs;
- OAuth authorization codes;
- cookies or Cloudflare Access session material.

## 22. Final settlement invariant

These actions do not settle payment:

- OAuth authorization;
- account selection;
- webhook registration;
- reusable destination provisioning;
- single-session deposit request;
- Multiple Sessions deposit request;
- opening reusable or one-off link;
- attaching one-off link;
- webhook receipt/refetch;
- reconciliation candidate creation;
- recovery sync;
- Match;
- Ignore.

Only an explicit human settlement boundary, such as `confirm_monzo_reconciliation_candidate` or deliberate manual-payment RPC, may write `public.payment_transactions` and derive paid status.
