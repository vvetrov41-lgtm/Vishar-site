# Feature Specification: Self-Service Artist Signup

## Status

- Feature: `self-service-artist-signup`
- State: Implemented (database and CRM), production reachability pending an owner decision
- Owner/workstream: Vishar CRM platform
- Related: `docs/crm/NEW_ARTIST_ONBOARDING.md`, `docs/crm/SELF_SERVICE_SIGNUP.md`
- Migration: `supabase/migrations/0130_self_service_signup.sql`

## Problem

Vishar CRM is invite-only, and deliberately so. `crm_private.can_found_workspace()` admits the
installation owner or somebody who already administers an organization, and the comment above it
says why: *"There is no self-signup in this CRM - people arrive by invitation - so this never has
to admit a stranger."*

That sentence is now the constraint. A tattoo artist who has never met Vladimir cannot get a CRM,
because every path to one starts with somebody inside the installation creating an identity for
them. The platform is otherwise ready: migration 0087 made founding an organization and adding an
artist ordinary CRM operations, 0088 gave the onboarding checklist, and 0075 keeps a workspace
right from ever becoming an artist right.

What is missing is a door that a stranger may walk through, that opens onto their own empty tenant
and onto nothing else.

## Goals

- A new artist creates an account, confirms their email, answers two questions, and has a working
  CRM.
- The tenant they get - profile, solo organization, artist, workspace ownership, artist seat - is
  created atomically by the server from those two answers.
- Nothing they can do from that account reaches Vladimir's or Kristina's work, or the installation
  itself.
- The invitation flow is unchanged and remains the only way into an *existing* organization.
- Applying the migration changes no behaviour until the installation owner opens the door.

## Non-goals

- Widening `crm_private.can_found_workspace()` to every authenticated session.
- Any installation-level capability for a self-registered account.
- A second CRM, a parallel tenancy model, or a new authorization layer.
- Removing or weakening staff invitations.
- Making an external provider integration (Google, Meta, Monzo) a prerequisite for entering the CRM.

## Behaviour

### Signing up

1. The sign-in screen offers **Create an account** when, and only when,
   `public.self_service_signup_policy()` reports the door open. The read fails closed.
2. The signup form takes an email address and a password (12-128 characters, the same rule the
   invitation flow already uses) and calls Supabase Auth. It creates no CRM record of any kind.
3. Supabase sends a confirmation link pointing at `<origin>/?signup=1`, the second and last Auth
   redirect marker this application accepts.
4. Following the link signs the browser in. The CRM sees a session with no profile.

### First run

5. An unconfirmed address is held on a confirmation screen with a resend control. It is never
   offered setup, because the server would refuse it.
6. A confirmed address with no profile, while signup is open, is offered **Set up your CRM**: their
   name, an optional business or studio name, and a timezone detected from the device.
7. **Continue** calls `public.bootstrap_artist_account`, which creates the whole tenant in one
   transaction, and the browser lands on that artist's onboarding checklist.
8. A confirmed address with no profile while signup is closed sees exactly what it saw before this
   feature existed: this account has no CRM access.

### Failure and repetition

- A second bootstrap call returns the first result and creates nothing. So do a double-tapped
  Continue, a refreshed tab and a retried request.
- Any failure inside the bootstrap rolls the whole thing back. There is no half-created tenant.
- Closing signup stops new tenants immediately and does not strand an account that already has one.

## Constraints

- **Verified email.** `bootstrap_artist_account` refuses an address with no `email_confirmed_at`.
- **One tenant per account.** Enforced by a primary key on the self-service ledger, not by a check
  a race could pass.
- **No identifiers.** The bootstrap takes a name, an optional studio name, a timezone and a
  currency. It accepts no workspace, artist or profile id, so there is no version of the call that
  attaches the caller to something that already exists.
- **Never an installation owner.** The profile is created `booking_manager`.
- **An invited account is refused.** A profile this function did not create belongs to the
  invitation flow, and self-service is not a second way in.
- **Bounded.** A rolling hourly cap limits how fast tenants appear; a founder cap limits how many
  organizations a self-service account may go on to found. Both are owner-adjustable.
- **Fail-closed.** The switch defaults to closed.

## Acceptance criteria

1. Applying migration 0130 changes no behaviour: signup is closed, and the bootstrap refuses.
2. Only the installation owner can open or close signup, and the change is audited.
3. An unconfirmed address creates nothing.
4. One call creates profile, solo workspace, artist, workspace ownership and artist seat.
5. A repeated call creates no duplicate of any of those.
6. A self-registered artist cannot read or mutate another artist's clients, enquiries, projects,
   sessions, conversations, booking forms, payments, integrations or settings; cannot enumerate
   other artists; cannot seat themselves on one; cannot administer another organization.
7. A self-registered artist is not the installation owner and cannot become one.
8. Existing invite-based access is unchanged, and Vladimir's and Kristina's access is not regressed.
9. The rolling cap and the founder cap refuse rather than absorb.
10. `crm_private.can_found_workspace()` still refuses somebody who administers nothing.

## Evidence

- `supabase/migrations/0130_self_service_signup.sql`
- `supabase/tests/267_self_service_signup.sql`
- `admin/src/test/self-service-signup.test.tsx`
- `docs/crm/SELF_SERVICE_SIGNUP.md`

## Open dependency

The private CRM origin is behind Cloudflare Access, and both the deployment gate and
`scripts/verify-crm-pages-production.mjs` assert that it stays that way. A signed-out stranger
therefore cannot reach the signup screen at `https://crm.vishartattoo.com/` today. Making the
signup path publicly reachable is an owner decision about the installation's outer boundary, not
an implementation gap - see `docs/crm/SELF_SERVICE_SIGNUP.md`, "What is still outside this
workstream".
