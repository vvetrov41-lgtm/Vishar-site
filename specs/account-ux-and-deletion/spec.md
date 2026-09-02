# Feature Specification: Account UX, Role Semantics and Self-Service Deletion

## Status

- Feature: `account-ux-and-deletion`
- State: Deployed to production and accepted
- Owner/workstream: Vishar CRM platform
- Related: `docs/crm/ACCOUNT_LIFECYCLE.md`, `docs/crm/SELF_SERVICE_SIGNUP.md`
- Migration: `supabase/migrations/0135_account_lifecycle.sql`
- Tests: `supabase/tests/272_account_lifecycle.sql`,
  `admin/src/test/user-facing-role.test.tsx`,
  `admin/src/test/account-popover.test.tsx`,
  `admin/src/test/account-page.test.tsx`

## Problem

Testing a real self-registered artist account in production surfaced four
things, and one of them is a schema fact rather than a missing feature.

1. The account popover called the founder **Booking manager**. They own their
   solo organization and hold the `artist` seat on their own artist.
2. The popover did not close when tapped away from, because it was a native
   `<details>`, which has no notion of "outside".
3. There was no account page. The person's own name was inert text.
4. There was no way to delete the account, and the obvious implementation is
   impossible: `public.activity_log` is append-only under a trigger that
   survives BYPASSRLS, and it holds `ON DELETE SET NULL` references to
   `profiles` and an `ON DELETE RESTRICT` reference to `artists`. A SET NULL is
   an UPDATE, so it is refused; the profile, the artist and (through the
   CASCADE from `auth.users`) the Auth row are all undeletable once the account
   has produced any audit at all.

## Goals

- The interface names what the person actually is, from server state.
- The popover behaves like a menu: outside click, Escape, and a real link.
- One account page holding user-level settings and nothing organizational.
- Self-service deletion that ends the account for good without touching audit.

## Non-goals

- Changing any authorization role, policy, grant or predicate. `profiles.role`
  stays exactly what it is; only what the interface prints changes.
- Changing an email address. Supabase Auth owns that flow and needs
  confirmation on both addresses; a half-version here would be worse than none.
- Organization settings on the account page. Studio name, time zone and
  currency belong to the organization.

## Decisions

### D1. User-facing role is derived, server-side, from membership rows

`crm_private.user_facing_role(profile_id)` reads
`crm_private.profile_access` and `public.artist_memberships` - the rows
authorization itself reads - and returns `operator | artist | booking_manager |
read_only | none`. The operator branch is answered first, because migration
`0015`'s owner-sync seats the installation owner on every artist and reading
the seat first would describe them as somebody's tattoo artist.

Rejected: renaming the global `booking_manager` role. That column is the
authorization role, it narrows every membership through
`crm_private.capability_from_grant`, and `0130` assigns it deliberately.

### D2. Deletion erases and retires; it does not DROP

`public.delete_my_account(text)` soft-deletes the Auth identity the way GoTrue
marks one (`deleted_at`, plus a permanent ban and the removal of every
credential, session and identity), releases the address, tombstones the
profile, deletes artist seats, and for a founder deactivates and anonymises the
artist and the solo organization and deletes every provider connection.

Rejected: dropping the audit log's foreign keys, deleting audit rows, or
relaxing the append-only trigger. Each would make deletion possible by making
the log weaker, which is the one property it exists to have.

Accepted consequences, stated rather than hidden:
- an `artists` row and a `workspaces` row survive, switched off and anonymous,
  because the log references them;
- the founder's `workspace_memberships` row survives, because `0089`'s
  `protect_last_workspace_owner` refuses to let an organization lose its last
  active owner; it denies everything anyway through
  `crm_private.profile_access.is_active`.

### D3. The confirmation is the account's own email address

Checked server-side. A fixed word would be readable from the source; an address
is evidence the caller is looking at the account they are deleting.

### D4. The installation owner cannot delete themselves

Refused by name, for the same reason `0006` refuses them deactivating
themselves: an installation with no owner has no way back.

## Acceptance

- A self-service founder sees **Artist** / **Мастер**.
- Booking-only staff still see **Booking manager** / **Менеджер записей**.
- The installation operator is never described as an artist.
- The popover closes on outside pointer and Escape, stays open for its own
  controls, and its name link opens `#/account`.
- Deletion refuses a backend key, a wrong confirmation, the installation owner,
  and a founder whose tenant still has somebody in it.
- After a founder deletes: no seat, no connection, no live booking form, an
  inactive anonymised artist and organization, a tombstoned profile, a
  soft-deleted banned Auth row, an unchanged log with one row added, and the
  released address able to found a fresh tenant.
