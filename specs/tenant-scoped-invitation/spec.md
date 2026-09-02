# Feature Specification: Tenant-Scoped Teammate Invitation

## Status

- Feature: `tenant-scoped-invitation`
- State: Specified, not implemented
- Owner/workstream: Vishar CRM platform
- Raised by: review finding on PR #606; approved as a workstream by the installation owner
- Related: `docs/crm/SELF_SERVICE_SIGNUP.md` §9, `docs/crm/NEW_ARTIST_ONBOARDING.md`

## Problem

A self-service artist cannot add a first teammate.

Two things close the door, and both are correct on their own:

- `public.list_directory_profiles()` is scoped for self-service accounts to the
  people they already share an artist or an organization with (migration
  `0131`). On day one that is themselves. Widening it back is the disclosure
  that migration exists to prevent.
- `public.begin_staff_invite` and `public.finalize_staff_invite` call
  `crm_private.require_role('owner')`. Inviting a human mints a Supabase Auth
  identity, and that has always been an installation-owner act.

So the directory can only pick somebody who already exists, and nothing lets a
non-owner bring somebody into existence. A solo artist — the whole audience for
public signup — is unaffected. An artist who wants an assistant is stuck.

## Goals

- An artist who holds `manage_team` on their own artist can invite one person to
  it, by email, without the installation owner.
- The invitation reaches exactly that artist and nothing else.
- The installation's email reputation is not a resource a stranger can spend
  freely.
- The existing owner-driven invitation is unchanged.

## Non-goals

- Inviting into an *existing* organization the caller does not administer. That
  is `grant_workspace_artist_membership` plus the owner invite, and it stays.
- Any path to `crm_role = 'owner'`. The existing
  `staff_invites_role_not_owner` constraint already refuses it and stays.
- Letting a self-service account create more artists or organizations. The
  founder cap from `0131` is untouched.
- Widening `list_directory_profiles()` back.

## What already fits

The existing machinery is shaped for this, which is why the change is narrow.

`workers/team-admin.js` holds the Supabase secret key but performs **no
authorization of its own**. It forwards the caller's own JWT to
`begin_staff_invite` and `finalize_staff_invite` and lets the database decide;
the secret key is used for exactly one thing, the `/auth/v1/invite` call that
mints the identity and sends the mail. The only reason the flow is owner-only
is the `require_role('owner')` inside those two RPCs.

`crm_private.staff_invites` already carries idempotency
(`unique (requested_by, idempotency_key)`), one pending invite per address, the
intended memberships, and an audit trail. `finalize_staff_invite` already
creates the profile inactive, writes every membership, and only then flips it
active — the atomic database boundary around the non-transactional Auth call.

## Design

### The two new RPCs

`public.begin_artist_invite(p_idempotency_key, p_email, p_display_name, p_artist_id, p_grant)`
and `public.finalize_artist_invite(p_invite_request_id)`, siblings of the
existing pair, writing the same `crm_private.staff_invites` rows.

Authorization is `crm_private.has_artist_capability(p_artist_id, 'manage_team')`
instead of `require_role('owner')`.

Four things are forced rather than accepted:

1. **The role is always `booking_manager`.** Not a parameter. `read_only` would
   produce a teammate who cannot do the work they were invited for, and `owner`
   is the installation role a public form may never hand out.
2. **Exactly one artist**, the one named, which the caller must hold
   `manage_team` on. Not an array — the owner invite takes a membership list
   because an owner legitimately staffs across the installation; a tenant
   invite has one tenant.
3. **The grant cannot exceed the caller's own on that artist.** The same rule
   `grant_workspace_artist_membership` already enforces: you cannot hand out
   finance or integration management you do not hold. Reusing that predicate
   rather than restating it is the point.
4. **Never an existing profile.** `finalize_staff_invite` already refuses an
   address that already has a CRM profile. See the disclosure note below.

### Not disclosing who already exists

`finalize_staff_invite` refuses an already-provisioned address with *"the
invited Auth user already has a CRM profile"*. For an owner that is a useful
message. For a stranger it is an account oracle across every tenant in the
installation: type addresses, read which ones come back as existing.

So the tenant-scoped path returns one indistinguishable answer for *"invited"*
and *"that address already belongs to someone"* — the same shape the signup
form uses for the same reason. The invitee simply does not receive mail in the
second case, and the caller is told the invitation was sent.

This costs the inviter a real diagnostic. It is worth it: the alternative hands
anybody who completes signup a membership-enumeration tool over the whole
installation.

### Bounding the email

Minting identities and sending mail is the new abuse surface, and the one the
existing owner-only rule was implicitly protecting.

| Control | Shape |
| --- | --- |
| Per-artist window | At most N pending invitations per artist, and at most M per rolling 24 hours. Defaults small — 3 and 5. |
| Installation window | A rolling hourly cap across all tenant-scoped invitations, like `max_signups_per_hour`. |
| Switch | `crm_private.self_service_settings` gains `tenant_invites_open`, default **false**, flipped by the same owner-only `set_self_service_signup` sibling. |
| Verified inviter | The caller's own address must be confirmed. A tenant that has not proven its own address does not get to send mail from the installation. |
| Audit | `invite.tenant_requested` and `invite.tenant_provisioned`, artist-scoped. |

Fail-closed on arrival, exactly as `0130` was: applying the migration changes
nothing until the owner opens it.

### What the Worker changes

Ideally nothing. The Worker's `/v1/staff/invite` path forwards the bearer and
names the RPC; a second path `/v1/artist/invite` naming the new RPC pair is the
smallest possible change, and it keeps the two authorization stories separate
in the code rather than behind a flag inside one handler.

The Worker must keep performing no authorization of its own. If a future
reviewer finds the Worker deciding who may invite, the design has drifted.

### What the artist sees

On their own artist page, under **Access to this artist**, next to the existing
"add someone who already uses the CRM" picker: *"Invite someone new"* — an
email address, an optional name, and the same capability editor the grant
already uses. The words *profile*, *auth*, *identity* and *tenant* appear
nowhere.

## Acceptance criteria

1. Applying the migration changes no behaviour: the switch is closed and the
   new RPCs refuse.
2. Only the installation owner opens or closes it, audited.
3. An artist holding `manage_team` on their own artist can invite one person to
   it; that person can sign in, set a password, and see exactly that artist.
4. The same call naming an artist the caller does not hold `manage_team` on is
   refused.
5. The grant cannot exceed what the caller holds on that artist.
6. The invited profile is `booking_manager`, never `owner`.
7. An address that already has a CRM profile produces the same response as a
   successful invitation, and no membership anywhere.
8. Both windows and the installation cap refuse rather than absorb.
9. A caller whose own email is unconfirmed is refused.
10. Repeating a call with the same idempotency key creates no second identity,
    profile or membership.
11. The owner-driven invitation flow is byte-for-byte unchanged, and
    `supabase/tests/192_team_access_management.sql` still passes untouched.
12. A self-service tenant still cannot enumerate the installation: the scoped
    directory from `0131` is unchanged by this feature.

## Open questions for the owner

- **Should an invited teammate count against anything?** A tenant with an
  assistant is two profiles for one artist. Nothing in the platform charges for
  that today, so the spec assumes no limit beyond the abuse windows.
- **Mail identity.** Invitations will arrive from the installation's Supabase
  Auth sender. If tenant-scoped invitations should be visibly from the artist
  rather than from Vishar, that is a separate mail-sender workstream.

## Risks

- **Email reputation.** The mitigations are the windows and the switch; the
  residual risk is that a determined abuser with a verified address can still
  send a small number of invitations. Accepted, and the reason the switch
  exists.
- **A second authorization story.** Two invite paths mean two places to get
  authorization right. Mitigated by both going through the same
  `staff_invites` table, the same finalize shape, and the capability predicate
  already used by `grant_workspace_artist_membership`.
