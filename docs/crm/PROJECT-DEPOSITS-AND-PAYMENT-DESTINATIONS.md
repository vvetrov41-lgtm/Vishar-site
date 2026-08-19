# Project deposits and reusable payment destinations

Migrations `0066_monzo_destination_catalogue_management.sql` and
`0067_project_deposit_policy.sql`.

This document describes the deposit architecture after the reusable Monzo
destination catalogue became a CRM-managed surface and deposit pricing moved
above the Monzo layer.

## Layering

```text
project estimate / project facts
  -> artist project deposit policy
  -> suggested deposit
  -> optional authorised project override
  -> authoritative server-side deposit amount
  -> immutable payment request
  -> immutable request-bound destination snapshot
  -> public Vishar payment path
  -> Monzo
```

Each arrow crosses in one direction only. Nothing below an arrow can change
anything above it.

A reusable destination is keyed by **artist + amount + currency** and nothing
else. It carries no hours, session length, session count, project, client,
deposit policy or reason. `£50`, `£250`, `£625` and `£1,135.50` are the same
kind of row; none of them is structurally special.

## Two pricing rules, no duplicates

There is exactly one session pricing rule and exactly one project pricing rule.

| Deposit | Amount comes from | Evidence table |
| --- | --- | --- |
| Single session | `crm_private.resolve_session_deposit_tier` (duration schedule, migration 0057) | `payment_requests.policy_id` / `policy_version` |
| Multiple Sessions | the sum of the same per-session duration tiers | `session_deposit_groups` + `session_deposit_group_members` |
| Project | `crm_private.resolve_project_deposit` (project policy, migration 0067) | `project_deposit_requests` |

Multiple Sessions deliberately keeps using the per-session schedule. Moving it
onto the project policy would have created a second copy of session pricing and
would have changed the amount of grouped deposits already in production, so it
was not done. Its total is still an ordinary `artist + amount + currency`
destination lookup: a `£750` grouped total uses that artist's `£750`
destination if one exists.

Hours and planned session counts influence payment only through the project
estimate, which the project policy may then use. They are never encoded into a
destination.

## Reusable destination catalogue

`public.monzo_payment_destinations` now has a surrogate `id`, archival columns
and a partial unique index on `(artist_id, amount, currency) where archived_at
is null`. Rows are archived, never deleted; a delete trigger enforces this.
`payment_url` is globally unique, so a URL belongs to exactly one entry and
exactly one artist.

Three finance-authorised RPCs manage it, all `authenticated`-only and all
artist-scoped through `crm_private.require_artist_access(..., 'manage_finance')`:

- `public.list_monzo_payment_destinations(uuid)`
- `public.upsert_monzo_payment_destination(uuid, numeric, text)`
- `public.archive_monzo_payment_destination(uuid)`

The browser may supply an amount and a URL here because the operator is
deliberately configuring a catalogue entry. That amount is catalogue
configuration only. It never becomes the amount of a client payment request.

`list_monzo_payment_destinations` returns amounts, timestamps, an issued-request
count and a non-reversible fingerprint. **It never returns a provider URL**, and
no URL is written to the activity log.

## Request-bound destination snapshot

`public.payment_request_payment_destinations` is now the single request-bound
destination abstraction for every Monzo deposit request, rather than a one-off
gap filler. Each row records the artist, the immutable request amount, the
currency, the provider URL in force at issue time, and a `source` of
`reusable`, `one_off` or `legacy_integration`. A `reusable` row also keeps an
audit link to the catalogue entry it was copied from.

`crm_private.bind_payment_request_destination` writes the snapshot immediately
after a deposit request is created. `crm_private.resolve_monzo_payment_destination`
then reads **only** that snapshot: the live catalogue is deliberately not
consulted at open time.

This is what makes catalogue management safe:

| Day | Action | Result |
| --- | --- | --- |
| Monday | `£500` reusable entry is URL A; request X is issued | X snapshots URL A |
| Tuesday | the `£500` entry is replaced with URL B | the old entry is archived; X is untouched |
| Tuesday | request Y is issued for `£500` | Y snapshots URL B |
| Any day | the `£500` entry is archived | X still resolves to A, Y still to B |

Migration 0066 backfills a snapshot for every already-issued open Monzo deposit
request, so requests created before the migration become immutable too. The
backfill copies existing URLs byte-for-byte and provisions nothing.

A one-off may be attached only to a request that has no bound destination and
whose amount has no live reusable entry. It can never override a request that
was already issued with a catalogue-derived destination; the snapshot guard
rejects rewriting a `reusable` or `legacy_integration` row in place.

## Project deposit policy

`public.artist_project_deposit_policies` is versioned and immutable per version:
a change creates a new version and closes the previous one, so a request keeps
the version it was priced with. Modes are `fixed` and `percentage_of_estimate`,
with an optional minimum and a rounding step (percentage results round **up**
so a deposit never under-collects).

`public.projects.deposit_override_amount` holds an explicit authorised override
for future requests only. It is set through
`public.set_project_deposit_override`, which requires `manage_finance` for that
artist.

`public.preview_project_deposit` is a server-calculated, explicitly
non-authoritative preview so the CRM never reimplements the pricing rule in
React. It reports whether an exact reusable destination exists, never its URL.

`public.request_project_deposit(project, idempotency_key, delivery_channel)`
takes **no amount**. It recalculates the authoritative amount, creates the
immutable payment request, writes the `project_deposit_requests` pricing
snapshot and binds the destination.

### Closing the browser-amount gap

`public.create_payment_request` is a general finance RPC that accepts an amount.
Migration 0057 already forced session-backed deposits to match the duration
schedule. Migration 0067 adds the project-level equivalent: a deferred
constraint trigger requires every project-level deposit request to be backed by
either `session_deposit_groups` or `project_deposit_requests`, both of which are
written only by server-side workflows.

The check activates only once the artist has an active project deposit policy,
mirroring how the session tier guard activates only once a duration schedule
exists. Artists without a project policy keep their existing behaviour.

## What still never happens

- Creating, replacing or archiving a reusable destination writes no payment
  transaction and changes no payment status.
- Binding a destination settles nothing.
- Opening a public payment path is navigation only.
- Match creates no settlement transaction; **Confirm** remains the explicit
  settlement and ledger boundary.
- A Monzo webhook stays untrusted until the provider-side transaction refetch.
- The OAuth/account/webhook/reconciliation connection remains a separate,
  separately artist-scoped concern from reusable Easy Bank Transfer
  destinations. An artist without a connected Monzo account simply has no
  catalogue entries; nothing is borrowed from another artist.
- No provider URL appears in source, tests, logs or activity metadata. Tests use
  synthetic `https://monzo.com/pay/r/synthetic-…` URLs only.

## Tests

- `supabase/tests/218_monzo_destination_catalogue_management.sql`
- `supabase/tests/219_project_deposit_policy.sql`
- `supabase/tests/214_monzo_tier_specific_deposit_links.sql` (updated: the
  management RPC surface now exists and is asserted to be authenticated-only)
- `admin/src/test/payment-destination-api.test.ts`
- `admin/src/test/workflows.test.tsx`
