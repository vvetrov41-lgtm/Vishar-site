# Vishar CRM — private application

A mobile-first CRM for tattoo enquiries, projects and sessions.

**This is not part of the public website.** It has its own build, its own
dependencies and its own host, and it is excluded from the public site's
`npm run validate:site` checks by name. It is never indexed: `index.html`
carries `noindex, nofollow`.

**Nothing here is deployed.** There is no hosted Supabase project, no
`admin.vishartattoo.com`, and no CRM deployment. See
[`../docs/crm/DEPLOYMENT.md`](../docs/crm/DEPLOYMENT.md).

## Running it locally

```bash
cd admin
npm install
cp .env.example .env.local   # then fill in your own Supabase values
npm run dev
```

`.env.local` needs the two Supabase browser values:

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<sb_publishable_... key>
```

Owner-managed staff invitations additionally require the dedicated Team API:

```
VITE_TEAM_INVITE_URL=https://<team-api-subdomain>.vishartattoo.com/v1/staff/invite
```

The URL is optional while the Team Worker is undeployed. Without it, the Team
page remains available for existing staff and artist access management, while
the invite form fails closed as not configured. A production build accepts
only the exact HTTPS path on a `*.vishartattoo.com` host.

For `npm run dev` against `supabase start`, the standard loopback API URL
`http://127.0.0.1:54321` is also accepted. Loopback HTTP is disabled in a
production build; every staging or production build must use the HTTPS root of
a hosted `*.supabase.co` project.

The publishable key is a public identifier. It grants nothing on its own —
every read and write is decided by row level security and by the role checks
inside the workflow RPCs. A legacy anon key is accepted only as a migration
fallback; do not configure both.

**A Supabase secret key or legacy service-role key must never appear here.**
Either is a privileged backend credential that bypasses RLS and belongs only in
a Cloudflare Worker secret. `src/lib/supabase.ts` refuses to start when it finds
one — including a service-role JWT hidden under the publishable variable name.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on port 5173 |
| `npm run build` | Typecheck, then build to `admin/dist` |
| `npm run typecheck` | TypeScript only |
| `npm test` | Vitest: permissions, role visibility, workflows |

## How access works

Signing in is not the same as having access:

| Situation | What happens |
|---|---|
| Not signed in | Sign-in form |
| Signed in, no CRM profile | "This account has no CRM access" |
| Signed in, profile deactivated | Same refusal — a deactivated account cannot read even its own profile row, because `profiles_select_self` is gated on `is_active` |
| Signed in, active profile | The CRM, with navigation filtered to the role |

Roles are `owner`, `booking_manager` and `read_only`. What each may do is in
[`../docs/crm/SECURITY.md`](../docs/crm/SECURITY.md).

### Hiding a control is not a security boundary

`src/lib/permissions.ts` mirrors the database's grants so the interface does not
offer a control that would only fail, and so a role sees a screen it can
actually use. It is **not** what stops anything:

- finance columns are withheld at the privilege level, so `hourly_rate`,
  `estimate_total`, `deposit_amount` and `price` are not selectable by the
  `authenticated` role at all — the owner reads them through
  `projects_finance` / `sessions_finance`, which return zero rows to anyone
  else;
- every write goes through a `SECURITY DEFINER` RPC that re-checks the caller's
  role and writes the audit trail in the same transaction;
- there are no `INSERT`, `UPDATE` or `DELETE` grants on any CRM table for
  `authenticated`, so a table write is refused before RLS is even consulted.

Editing the capability matrix in a browser gains nothing. `src/test/roles.test.tsx`
renders against a fake client that models the same denials, so a test cannot
pass by asserting the interface hides something the database would have served.

### Staff invitation boundary

The browser sends the current owner's access token and a bounded invitation
request to the single-purpose `workers/team-admin.js` endpoint. The Worker
first calls the owner-only `begin_staff_invite` RPC with that same token. Only
after the database accepts the role and artist memberships does the Worker use
its server-only Supabase secret to send the Auth invitation. The Auth response
is discarded. The Worker then calls `finalize_staff_invite`, again as the
owner, to create an initially inactive profile, create every membership, and
activate the profile in one database transaction.

The database stores no password or invitation token. A failed or interrupted
flow leaves either no profile or a profile transaction that did not commit, so
an Auth account cannot enter the CRM until provisioning is complete. Replaying
the same idempotency key does not create another profile, membership, audit
event, or Auth invitation after provisioning.

## Files

```text
src/
  App.tsx                access gate, then routing
  main.tsx               entry point
  lib/
    api.ts               narrow reads and named RPCs — no query builder for pages
    permissions.ts       role capability matrix (UX only; see above)
    router.tsx           minimal hash router (nine routes do not justify a dependency)
    session.tsx          auth session + active CRM profile
    supabase.ts          client factory; refuses privileged backend keys
    types.ts             domain types — finance columns deliberately absent
    format.ts            dates and money, formatted from the row's own currency
  components/            shell, route guard, loading/empty/error states, signed image
  pages/                 dashboard, enquiries, clients, projects, sessions, users, activity
  test/                  fixtures + 67 tests
```

## Private files

Reference images are in a private bucket and have no public URL. `SignedImage`
mints a signed URL per render, valid for one minute. The URL is never written
into a link, a data attribute or visible text — a test asserts that.

## Deliberately not built

- password reset — handled by Supabase Auth, never by the CRM;
- Gmail and Google Calendar — no provider is connected, and the session screens
  say so rather than showing a placeholder that implies otherwise;
- bulk export — an owner-only, audited operation that has not been specified;
- client merging — never automatic; a wrong merge cannot be undone.
