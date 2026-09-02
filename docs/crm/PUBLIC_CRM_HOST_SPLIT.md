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

## 3. What only the owner can do

The Cloudflare API token this repository holds can read and write Pages,
Workers, Worker routes and DNS. It **cannot touch Access**: the read-only
inventory records `403` on `/zones/{zone}/access/apps`.

So the two Access changes below are dashboard actions in Cloudflare Zero
Trust, or they need a token with `Access: Apps and Policies — Edit` added to
`CRM_PRODUCTION_CLOUDFLARE_API_TOKEN`.

Everything else in this runbook is automatable from the repository once those
exist.

---

## 4. The order, and why it is this order

The rule the whole sequence protects: **`crm.vishartattoo.com` keeps its Access
protection until `app.vishartattoo.com` is deployed and verified.** At no point
is the operator environment reachable without Access, and at no point is the
CRM unreachable to its current users.

### Step 1 — Access application for the new host (owner)

In Zero Trust → Access → Applications, create a self-hosted application for
`app.vishartattoo.com` with the same policy that guards `crm.vishartattoo.com`
today.

Do this **before** the host resolves. An Access application can be created for
a hostname that does not exist yet, and creating it first means the operator
CRM is never briefly public. This is the one place the owner's ordering and
this runbook differ, and the difference is deliberate.

### Step 2 — Pages project and DNS (repository)

A second Pages project is required rather than a second custom domain on the
existing one: the two hosts must serve *different builds*, and one Pages
project serves one build to all its domains.

- Project `vishar-crm-internal`, Direct Upload, production branch `production`.
- Custom domain `app.vishartattoo.com`, which creates the proxied CNAME to
  `vishar-crm-internal.pages.dev`.
- Repository variables `CRM_INTERNAL_PAGES_PROJECT` and `CRM_INTERNAL_ORIGIN`.

### Step 3 — Deploy the operator build there (repository)

Same source, `VITE_CRM_SURFACE=internal`, same Supabase project and connector
origins as the current CRM production build. The deploy asserts, before it
finishes, that `app.vishartattoo.com` answers a signed-out request with a
redirect to the Access login — the same readback the current CRM deploy makes.

### Step 4 — Verify the operator environment (owner + repository)

Sign in at `app.vishartattoo.com` through Access and confirm the things only
the operator has: Users, staff invitations, organizations, and each artist's
integrations. Nothing here should be a surprise; it is the same application at
a different address.

Do not continue until this is true.

### Step 5 — Turn `crm.vishartattoo.com` public (repository, then owner)

1. Repository: switch the CRM production workflow to `VITE_CRM_SURFACE=public`,
   invert its artifact assertion, and replace its Access readback with a
   public-reachability check. Deploy.
2. Owner: remove the Access application from `crm.vishartattoo.com` **and**
   from `vishar-crm-production.pages.dev`. Both are gated today.

In that order: the public build is serving before the door opens, so the
operator surface is never briefly exposed on a public host.

### Step 6 — Prove the boundary from outside (repository)

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
