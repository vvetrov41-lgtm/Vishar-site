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
| Founder cap | `max_workspaces_per_founder`, default 3 |
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

Supabase's own project-level protections - CAPTCHA on signup, leaked-password checking, Auth rate
limits - are configured on the Supabase project, not in this repository. They are worth having and
they are not what this design depends on.

---

## 5. Isolation

Nothing here introduces a table that holds tenant data, so isolation is the platform's existing
isolation, not a new one. The new artist holds exactly one `artist_memberships` row, and every
artist-scoped read and write in the CRM resolves through `crm_private.has_artist_capability`.

`supabase/tests/267_self_service_signup.sql` proves it from the newcomer's own session: the
incumbent artist's enquiry, project and client are invisible; the incumbent artist cannot even be
enumerated; `artist_control_plane_context` and `artist_onboarding_state` refuse; `seat_artist_owner`
and `grant_workspace_artist_membership` refuse; `update_artist` refuses; `is_owner()` is false;
`set_self_service_signup` refuses; `bootstrap_owner` is not reachable; direct writes to
`public.artists` are refused by table privilege; `crm_private.self_service_settings` is unreadable.

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
