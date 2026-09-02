# Public artist signup

This is the answer to "a tattoo artist nobody here has met wants a CRM". It describes the state
after migration `0130`.

The short version: they open the CRM, create an account, confirm their email, type their name, and
have a working CRM with an onboarding checklist. Nobody inside the installation does anything.

Section 8 is the one thing this workstream did not, and could not, decide by itself.

---

## 1. Why this is not just a wider `can_found_workspace()`

Migration 0087 left founding an organization gated: the installation owner, or somebody who already
administers one. Widening that predicate to every authenticated session would have been three
lines, and it would have been wrong. `create_workspace` and `create_artist` are administrative
calls that take identifiers; handing them to a signed-out stranger turns "sign in" into an
unbounded write surface, and `supabase/tests/235_control_plane.sql` pins the refusal that stops it.

So self-service gets its own door instead. `public.bootstrap_artist_account` is one SECURITY
DEFINER function that writes exactly one profile, one solo workspace, one artist and one artist
membership, all for `auth.uid()`.

**It takes no identifier of any kind.** A name, an optional studio name, a timezone, a currency.
There is nothing in its argument list a caller could substitute to reach an organization or an
artist that already exists, which is a stronger property than refusing them.

---

## 2. What one call creates

In one transaction:

| Row | Shape |
| --- | --- |
| `public.profiles` | `booking_manager`, active, the confirmed address from `auth.users` |
| `public.workspaces` | `solo`, named after the studio name or the artist |
| `public.workspace_memberships` | `owner` of that one organization |
| `public.artists` | the artist, with a derived slug and booking reference prefix |
| `public.artist_memberships` | `artist` level, all four capability flags |
| `crm_private.self_service_accounts` | the ledger row that makes a second tenant impossible |
| `public.activity_log` | `signup.tenant_created` |

`booking_manager` rather than `owner` is deliberate and load-bearing. `owner` is the legacy
installation-wide role that still narrows every membership through
`crm_private.capability_from_grant`; a public form may not hand it out. `booking_manager` plus a
full artist membership is exactly the shape a working artist has in production today.

`artist` level rather than `read_only` matters for the same reason in reverse: a `read_only`
profile holds no write capability whatever its membership says, so it would arrive at an empty CRM
it could not use.

---

## 3. The guards, in the order they run

1. **An authenticated browser session.** Not `service_role`, not `anon`. A backend key has no
   `auth.uid()` to act for, and admitting one would make it a way to mint tenants for arbitrary
   accounts.
2. **A confirmed email address.** An unconfirmed address is somebody else's address until proven
   otherwise, and the CRM will send this artist's client-facing mail to it.
3. **A per-account advisory lock.** Two taps on Continue are one tenant.
4. **The ledger.** Answered *before* the switch, deliberately: closing signup must stop new tenants
   without breaking a retry for somebody who already has one.
5. **An existing profile refuses.** That account arrived by invitation and keeps that door.
6. **The switch, then the rolling window.**

---

## 4. Abuse control

| Control | Where |
| --- | --- |
| Signup closed by default | `crm_private.self_service_settings.is_open`, false on install |
| Owner-only switch, audited | `public.set_self_service_signup` |
| Confirmed address required | `bootstrap_artist_account`, from `auth.users.email_confirmed_at` |
| One tenant per account | primary key on `crm_private.self_service_accounts` |
| Rolling hourly cap | `max_signups_per_hour`, default 20 |
| Founder cap | `max_workspaces_per_founder`, default 3, counted whether or not each organization is switched on |
| Audit | `signup.tenant_created`, `signup.availability_changed` |

Every one of these is server-side. The browser hides the signup link when the policy read says the
door is shut, and that is a courtesy: the bootstrap re-reads the same switch and refuses on its own
authority.

The founder cap deserves a note. A self-service account owns its solo workspace, and 0075's
`sync_solo_workspace_owner` gives it `can_manage_workspace` there - which also makes
`can_found_workspace()` true for it. That is the same position an invited artist has held since
0075, so it is not new authority; it is newly reachable by anybody who can create an account. The
cap lives inside `can_found_workspace()` rather than inside `create_workspace`, so the RPC, the
`workspaces` INSERT policy and the interface's `control_plane_access()` all read one predicate and
the button disappears at the same moment the database starts refusing. It applies only to accounts
in the ledger, so no invited administrator and not the installation owner is affected.

As first written it counted only *active* organizations, which made it no cap at all: a founder can
deactivate their own artist and then their own organization through the ordinary lifecycle RPCs,
and 0089 keeps their owner membership row alive under every path, so they could found another and
repeat. Migration 0131 counts the organizations an account administers whether or not they are
switched on.

Supabase's own project-level protections - CAPTCHA on signup, leaked-password checking, Auth rate
limits - are configured on the Supabase project, not in this repository. They are worth having and
they are not what this design depends on.

---

## 5. Isolation

Nothing here introduces a table that holds tenant data, so isolation is the platform's existing
isolation, not a new one. The new artist holds exactly one `artist_memberships` row, and every
artist-scoped read and write in the CRM resolves through `crm_private.has_artist_capability`.

One thing did not come for free, and it is worth stating rather than burying. Migration 0089's
people directory - `public.list_directory_profiles()` - returned every active profile in the
installation to anybody holding an artist-level membership. That was sound while everybody holding
one had arrived by invitation; public signup broke the premise without anything downstream
noticing, and a stranger who confirmed an email address could read the address book. Migration
0131 scopes the directory for ledger accounts to the people they already share an artist or an
organization with, and leaves every invited account's view exactly as it was. The installation
owner is excluded from that test: migration 0015 gives an active owner a membership on every
artist and 0075 turns that into ownership of every solo workspace, so the owner shares both with
every tenant automatically, and a first attempt at this fix still disclosed exactly the person it
was written to protect.

0131's header says that bringing a *new* person into a self-service tenant is the invitation flow's
job. That sentence describes where the capability belongs, not where it is: `begin_staff_invite`
calls `crm_private.require_role('owner')`, so today only the installation owner can invite anybody,
and a self-service founder cannot add a first teammate at all. See section 9. Bringing a new person
into a self-service tenant is the invitation flow's job: it mints an identity, while the directory
picks an existing one.

`supabase/tests/267_self_service_signup.sql` proves it from the newcomer's own session: the
incumbent artist's enquiry, project and client are invisible; the incumbent artist cannot even be
enumerated; `artist_control_plane_context` and `artist_onboarding_state` refuse; `seat_artist_owner`
and `grant_workspace_artist_membership` refuse; `update_artist` refuses; `is_owner()` is false;
`set_self_service_signup` refuses; `bootstrap_owner` is not reachable; direct writes to
`public.artists` are refused by table privilege; `crm_private.self_service_settings` is unreadable.
`supabase/tests/268_self_service_directory_and_cap.sql` adds the directory boundary and the
allowance that deactivation cannot reclaim.

---

## 6. What the artist sees

```
Create your account          Check your email            Set up your CRM
  Email                        We sent a link to           Your name
  Password                     you@example.com             Business or studio name
  Repeat password                                          Time zone (detected)
  [Create account]                                         [Continue]
```

Then the CRM opens on their own onboarding checklist - the same
`public.artist_onboarding_state` screen an invited artist gets, derived from live state rather than
stored progress.

The words *profile*, *workspace*, *membership*, *tenant* and *bootstrap* appear nowhere on any of
these screens.

---

## 7. Integrations

Adding a self-service artist creates no integration, exactly as `create_artist` creates none. From
the checklist they connect providers themselves through the existing per-artist integration
architecture, which is already universal rather than installation-specific.

The honest list of what still needs a step outside the CRM is unchanged and lives in
`docs/crm/NEW_ARTIST_ONBOARDING.md` section 11: Google Calendar and Gmail need an OAuth consent on
Google, Monzo needs SCA approval in the Monzo app, WhatsApp needs Meta Business verification, and
Instagram is frozen behind Meta app review. The checklist marks these `external` rather than
`required`, so nobody goes looking for a button that does not exist, and none of them blocks entry
into the CRM.

---

## 8. What is still outside this workstream

`https://crm.vishartattoo.com` is behind Cloudflare Access. The private CRM deployment gate refuses
to finish unless the origin still answers a signed-out request with a redirect to the Access login,
and `scripts/verify-crm-pages-production.mjs` asserts the same thing before and after every deploy.

That is a deliberate outer boundary and it predates this feature. It also means a stranger cannot
reach the signup screen: they are stopped by Access before any of this runs.

Making public signup publicly reachable is therefore a decision about that boundary, and it is the
installation owner's to make. Two shapes are available:

- **Open the CRM origin.** Remove or narrow the Access policy in front of
  `crm.vishartattoo.com`, and with it the repository gates that assert it. The CRM's own
  authorization is unaffected either way - Access is defence in depth, not the authorization
  boundary - but this removes a layer that currently stands in front of live production work.
- **A separate public signup host.** Put the signup and setup screens on their own hostname that
  is not Access-gated, and leave `crm.vishartattoo.com` exactly as it is. More work, a new
  Cloudflare route and a new Pages target, and it keeps the existing boundary intact.

Until one of those happens, the database boundary is live and proven and the screens exist, but the
door is reachable only from inside Access.

---

## 9. A self-service founder cannot yet add a teammate

Raised in review on the migration that scoped the directory, and correct.

A solo artist working alone - the whole audience for public signup - needs nobody else, so this
blocks no part of the flow that shipped. But the moment they want an assistant, there is no path:

- The scoped directory shows them only people already on their artist or in their organization,
  which on day one is themselves. That is the point of the scoping, not a side effect of it.
- `public.begin_staff_invite` calls `crm_private.require_role('owner')`. Inviting a human mints a
  Supabase Auth identity, and that has always been an installation-owner act.

Note what 0131 did **not** take away. Before it, a founder could *see* every profile but still could
not invite anybody; the only thing the wide directory added was the ability to staff an unrelated
existing person onto their own artist, which is the cross-tenant reach the scoping exists to
prevent. The gap predates the fix.

Closing it means letting a non-owner account create an auth identity, bounded to its own tenant.
That is a new trust boundary with its own rate limit, its own audit trail and its own abuse
surface - a workstream, not a patch. It has not been designed, and this document does not pretend
otherwise.

---

## 10. Production acceptance, 2 September 2026

Run against `vfjexhfdbrjmuxfdvbdx` through the public API with the publishable
key, the way an artist's browser reaches it. Migration head `0132`.

**Before a session exists**

- `self_service_signup_policy()` answers `anon`. It is the only function in the
  ACL inventory that does.
- `clients`, `enquiries`, `projects`, `profiles`, `artists`, `workspaces` all
  answer `42501 permission denied` to `anon`. Not an empty list - denied.

**Signing up**

- `POST /auth/v1/signup` created the account and sent a confirmation mail.
- `POST /auth/v1/token` before confirming answered `email_not_confirmed`. An
  unverified account cannot obtain a session at all, so it can never reach the
  bootstrap - the verified-email guard inside the function is the second line,
  not the first.

**With the door shut**

- `bootstrap_artist_account` → `42501 signing up is not open at the moment`.
- `set_self_service_signup(true)` from that same account → `42501 changing
  signup availability is not permitted`.
- A verified account with no tenant read every table and got `[]` from all of
  them.

**With the door open**

- First call returned `created: true` with a profile, a solo workspace and an
  artist. Second identical call returned `created: false` and the same three
  ids. One tenant, not two.
- The founder's platform role is `booking_manager`. Public signup never mints an
  installation owner.
- The founder is `owner` of their own workspace and of nothing else.

**Isolation, measured on the deployed schema**

| What the founder can see | Rows |
| --- | --- |
| clients | 0 |
| enquiries | 0 |
| projects | 0 |
| sessions | 0 |
| artists | 1 - their own |
| workspaces | 1 - their own |
| profiles | 1 - their own |
| `list_directory_profiles()` | 1 - themselves, not Vladimir, not Kristina |

Vladimir's and Kristina's books were re-counted afterwards: 15 clients, 16
enquiries, 5 projects, 1 and 2 active artist memberships. Unchanged.

### What acceptance found: 0132

The tenant was isolated in the direction the brief asked about and open in the
other. `grant_artist_to_active_owners` seated every active owner on the new
artist the moment it existed, and `sync_solo_workspace_owner` turned that into
ownership of the new solo workspace - so a stranger's clients and payments were
readable by the installation operator, and the operator's profile id came back
to the stranger in the membership row.

`0132_self_service_tenant_privacy.sql` scopes both owner-grant paths to skip
workspaces founded through signup, and repairs what the old rule had granted.
Nothing changes for an artist created by an operator, an invitation or a
migration. `269_self_service_tenant_privacy.sql` holds the line, including the
case that made the first draft insufficient: `ensure_owner_artist_memberships`
runs on every write to an owner profile and would otherwise grant the whole
tenant back on the next rename.

**This is a reversible product decision.** If the studio should retain oversight
of tenants that sign up through it, remove the exclusion - but say so to the
people signing up, because their client records are other businesses' data.

### The acceptance probe

`crm-signup-probe-20260902@vishartattoo.com` is a real production account and
cannot be deleted. `public.activity_log` is append-only and holds a `restrict`
foreign key to `public.artists`, so removing the tenant would mean destroying
its own audit trail. It is deactivated instead: profile, artist and workspace
`is_active = false`, every artist membership inactive, display names set to
`ACCEPTANCE PROBE - do not use`, and the login banned until 2099. Its workspace
membership stays active because `protect_last_workspace_owner` refuses to leave
a workspace ownerless, and that guard is right.

Active counts afterwards - 2 profiles, 2 artists, 3 workspaces - match the
pre-acceptance baseline exactly.

Signup is left **open**.

---

## 11. The teammate gap, closed: migration 0133

Section 9 described a founder who cannot bring in an assistant. `0133` adds a
second door rather than widening the first.

`public.begin_artist_invite(p_idempotency_key, p_email, p_display_name,
p_artist_id, p_grant)` and `public.finalize_artist_invite(p_invite_request_id)`
are siblings of the owner pair. They write the same
`crm_private.staff_invites` rows, use the same finalize shape, and differ in
exactly what the trust boundary requires.

| | Owner invitation | Tenant invitation |
| --- | --- | --- |
| Authorization | `require_role('owner')` | `has_artist_capability(artist, 'manage_team')` |
| Reach | a membership array | one artist, named in the call |
| Role | a parameter | always `booking_manager` |
| Ceiling | the owner holds everything | cannot exceed the caller's own grant |
| Address already in use | says so | indistinguishable from success |
| Volume | none | two per-artist windows, one installation window, one switch |
| Lifetime | none | expires after seven days |

The argument list is the boundary. There is no role and no membership list, so
there is no version of the call that reaches a second artist. Naming an artist
the caller does not manage and naming one that does not exist produce the same
`42501`, so the id space is not a probe.

### Why the answer is deliberately unhelpful

`finalize_staff_invite` tells an owner that an address already has a profile.
For a stranger who has just completed signup, that same message is an account
oracle over every tenant in the installation: type addresses, read which come
back as existing.

So the tenant door records a `suppressed` invitation, sends no mail, and
returns the shape a live invitation returns. The Worker never calls
`/auth/v1/invite` for it, and never falls back to `list_profiles` the way the
owner path does — that recovery is exactly the disclosure being avoided.

The cost is real: an inviter who mistypes a colleague's address gets no signal.
The alternative is worse.

### Bounds

| Control | Default |
| --- | --- |
| `tenant_invites_open` | **false** — applying the migration changes nothing |
| Pending per artist | 3 |
| Per artist per 24 hours | 5 |
| Installation-wide per hour | 10 |
| Inviter's own address | must be confirmed |
| Invitation lifetime | 7 days |

All four numbers move through `public.set_tenant_invites`, owner-only and
audited as `invite.tenant_availability_changed`. Every invitation writes
`invite.tenant_requested`, `invite.tenant_provisioned` or
`invite.tenant_suppressed`, artist-scoped.

### Where the capability is checked

Twice. `begin` checks it, and `finalize` checks it again — because the Worker's
call to Supabase Auth sits between them and is not transactional, and in that
window the caller may have lost `manage_team` or the finance capability their
grant carries. The membership is written in `finalize`, so that is where the
authorization has to hold.

### The Worker

`/v1/artist/invite`, a sibling of `/v1/staff/invite` in the same Worker. It
still performs no authorization of its own: it forwards the caller's JWT to the
two RPCs and uses its secret key for exactly one thing, the Auth call that
mints the identity. If a future reviewer finds this Worker deciding who may
invite, the design has drifted.
