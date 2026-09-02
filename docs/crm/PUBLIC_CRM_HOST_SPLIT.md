# Splitting the CRM into a public host and an operator host

The target, decided by the installation owner:

| Host | Who reaches it | Protection |
| --- | --- | --- |
| `crm.vishartattoo.com` | Any artist. Signup, email verification, first-run setup, then their own CRM. | Supabase Auth, RLS and tenant isolation. No Cloudflare Access. |
| `app.vishartattoo.com` | Vladimir, Kristina, and whoever else operates the installation. | Cloudflare Access, exactly as `crm` is protected today. |

One codebase. Two builds of it, distinguished by `VITE_CRM_SURFACE`.

---

## 1. Where the boundary actually is

Three layers, and only one of them is load-bearing.

**The database.** Every installation-level operation is refused server-side to
anybody who is not the installation owner: `public.begin_staff_invite` and
`public.set_profile_active` through `crm_private.require_role('owner')`,
`public.set_self_service_signup` through `public.is_owner()`. A self-registered
artist is a `booking_manager`, so all three refuse them whichever host served
the bundle. `supabase/tests/267_self_service_signup.sql` pins it, and the same
thing was verified against production.

**The surface.** `admin/src/lib/surface.tsx` decides whether this build offers
the installation's own administration at all. It reads `VITE_CRM_SURFACE` and
answers `public` for anything it does not recognise, an unset variable
included. That direction is chosen on purpose: an internal build mislabelled
public loses the Users screen until somebody sets the variable, while a public
build mislabelled internal would offer installation administration on the open
web.

**Cloudflare Access.** Defence in depth in front of the operator host. It is
not what protects tenant data — RLS is — but it is what keeps the operator
environment off the public internet.

Only the first is an authorization boundary. The other two exist so that a
mistake in one of them is not also a disclosure.

---

## 2. What is already done

- `VITE_CRM_SURFACE` and the gating it drives (PR #608).
- Both existing CRM deploy workflows pinned to `internal`, and the production
  one asserts `VITE_CRM_SURFACE:"internal"` is present in the built bundle. So
  the CRM that is deployed today keeps its Users screen, and a future deploy
  cannot silently take it away.
- Public signup itself: migrations `0130` and `0131` are the production
  migration head, and the flow was verified end to end against the live
  database. The signup switch is still **closed**.

---

## 3. Permissions

`CRM_PRODUCTION_CLOUDFLARE_API_TOKEN` originally had no Access permission —
the read-only inventory recorded `403` on `/zones/{zone}/access/apps` — which
made the two Access changes below dashboard actions.

`Access: Apps and Policies — Edit` has since been added to it, so the whole
sequence is automatable from `crm-host-split-operator.yml`. The `inspect-access`
stage is the read-only way to confirm the token still has what it needs before
any mutating stage runs.

---

## 4. The order, and why it is this order

The rule the whole sequence protects: **`crm.vishartattoo.com` keeps its Access
protection until `app.vishartattoo.com` is deployed and verified.** At no point
is the operator environment reachable without Access, and at no point is the
CRM unreachable to its current users.

### Step 1 — Access application for the new host

`crm-host-split-operator.yml`, stage `protect-internal`. It reads the Access
application currently on `crm.vishartattoo.com`, creates a self-hosted
application for `app.vishartattoo.com` in the same scope, and replicates every
policy — decision, precedence, include, exclude, require — then reads the
result back and refuses unless at least one allow policy landed. Idempotent: an
application that already exists is reported and left alone.

This runs **before** the host resolves. An Access application can be created
for a hostname that does not exist yet, and creating it first means the
operator CRM is never briefly public. This is the one place the owner's
ordering and this runbook differ, and the difference is deliberate — the
`create-internal-pages` stage refuses to attach a custom domain until this
application exists.

### Step 2 — Pages project and DNS

`crm-host-split-operator.yml`, stage `create-internal-pages`.

A second Pages project is required rather than a second custom domain on the
existing one: the two hosts must serve *different builds*, and one Pages
project serves one build to all its domains.

- Project `vishar-crm-internal`, Direct Upload, production branch `production`.
- Custom domain `app.vishartattoo.com`, which creates the proxied CNAME to
  `vishar-crm-internal.pages.dev`.
- Repository variables `CRM_INTERNAL_PAGES_PROJECT` and `CRM_INTERNAL_ORIGIN`.

### Step 3 — Deploy the operator build there

`crm-host-split-operator.yml`, stage `deploy-internal`. Re-runnable: this is
also how ordinary operator-CRM deploys reach `app.vishartattoo.com` from now
on.

Same source, `VITE_CRM_SURFACE=internal`, same Supabase project and connector
origins as the current CRM production build. The deploy asserts, before it
finishes, that `app.vishartattoo.com` answers a signed-out request with a
redirect to the Access login — the same readback the current CRM deploy makes.

### Step 4 — Verify the operator environment

`crm-host-split-operator.yml`, stage `verify-internal`, plus a human signing in
through Access.

Sign in at `app.vishartattoo.com` through Access and confirm the things only
the operator has: Users, staff invitations, organizations, and each artist's
integrations. Nothing here should be a surprise; it is the same application at
a different address.

Do not continue until this is true.

### Step 5 — Turn `crm.vishartattoo.com` public

`crm-host-split-operator.yml`, stage `open-public`.

1. Repository: switch the CRM production workflow to `VITE_CRM_SURFACE=public`,
   invert its artifact assertion, and replace its Access readback with a
   public-reachability check. Deploy.
2. The same stage then removes the Access application from
   `crm.vishartattoo.com` — and from that host only.

`vishar-crm-production.pages.dev` and its `*.` wildcard keep their Access
applications deliberately. The pages.dev names are an implementation detail
nobody is asked to visit, the wildcard is what guards preview deployments of
the same build, and leaving them gated costs the public CRM nothing while
keeping a protected route to it for diagnosis. `verify-public` asserts both
halves, and so does the CRM production preflight.

In that order: the public build is serving before the door opens, so the
operator surface is never briefly exposed on a public host.

### Step 6 — Prove the boundary from outside

`crm-host-split-operator.yml`, stage `verify-public`, then the acceptance
below.

With no Access session and no CRM account:

- `crm.vishartattoo.com` returns the sign-in screen, and the signup link once
  the switch is open.
- `/#/users` on that host renders "Not part of this CRM" rather than the
  installation's people.
- `app.vishartattoo.com` still returns the Access redirect.

Then, as a freshly signed-up artist: `begin_staff_invite`,
`set_self_service_signup` and `bootstrap_owner` all refuse, and the tenant sees
only its own records. That last part is already proven against production; the
point of repeating it here is to prove it through the *public host*.

---

## 5. Opening signup

`public.set_self_service_signup(true)` is the last switch, and it is separate
from every step above on purpose: the host split can be completed and verified
while signup is still closed, and opening it is then one auditable act by the
installation owner that can be reversed in one more.

`public.set_self_service_signup(false)` stops new tenants immediately and
leaves existing ones working.

---

## 6. What this does not change

- Tenant isolation. RLS and the artist-membership model are untouched.
- Vladimir's and Kristina's access. They keep the same profiles, memberships and
  data; only the address of the operator environment changes.
- The invitation flow. It stays the way somebody joins an existing workspace.
- The gap in `SELF_SERVICE_SIGNUP.md` section 9: a self-service founder still
  cannot invite their first teammate. That is a separate workstream.

---

## 7. Production acceptance, 2 September 2026

Both hosts are live and were read back from the outside, not inferred from a
green workflow.

| Hostname | Answers | Why |
| --- | --- | --- |
| `crm.vishartattoo.com` | `200` | the public CRM, no Access in front of it |
| `app.vishartattoo.com` | `302` to the Access login | the operator environment |
| `vishar-crm-internal.pages.dev` | `302` to the Access login | the operator project's own name |
| `*.vishar-crm-internal.pages.dev` | `302` to the Access login | its preview deployments |
| `vishar-crm-production.pages.dev` | `302` to the Access login | unchanged |

The bundle `crm.vishartattoo.com` serves carries no `VITE_CRM_SURFACE`, so
`readSurface` returns `public` - the restricted surface is the default, which is
the direction a mistake should fail in.

### The `.pages.dev` hole

The first `deploy-internal` put the operator build on
`vishar-crm-internal.pages.dev` answering `200` with no Access. `protect-internal`
had created an application for the custom domain only, and a Pages project serves
its own subdomain from the first deployment whether or not anybody attached it.

Nobody could have done anything with it - an anonymous visitor reached the
Supabase login screen and every installation-level RPC is refused server-side -
but the stated boundary was that the operator environment is not reachable
without Access, and for about twenty minutes it was.

Two things were wrong and both are fixed in `scripts/crm-host-split.mjs`:

1. The stage protected one hostname. It now protects the custom domain, the
   project subdomain and its wildcard, and `create-internal-pages` and
   `deploy-internal` refuse unless all three are already protected.
2. It cloned the source application's scope onto every name. A zone-scoped token
   cannot create an application for a `.pages.dev` name - Cloudflare answers
   `app and token domain mismatch` - so the scope is now chosen per hostname:
   zone for the custom domain, account for the rest.

`protect-internal` also stopped depending on `crm.vishartattoo.com` for its
policy source, because `open-public` deletes that application by design. It is
the repair tool for a name that lost its protection, so it has to work after the
split, not only before it.
