# Implementation Plan: Account UX, Role Semantics and Self-Service Deletion

## Layers

| Layer | Change |
| --- | --- |
| Database | `0135_account_lifecycle.sql`: `crm_private.user_facing_role`, `public.account_overview`, `public.set_my_display_name`, `public.delete_my_account` |
| Browser API | `admin/src/lib/account-api.ts`, wired into `CrmApi` |
| Session | `admin/src/lib/session.tsx` loads `account_overview` after the profile, failing open to the authorization role |
| Chrome | `admin/src/components/AppShell.tsx` - controlled popover, role label, name as a `Link` |
| Screen | `admin/src/pages/AccountPage.tsx`, routed at `#/account` behind no capability |
| Copy | `admin/src/lib/i18n.tsx` (`userRole.*`, `account.*`) and `admin/src/lib/api-errors.ts` |

## Ordering

The migration is additive and forward-only: three new functions and one new
private helper, no table, no column, no policy, no grant on an existing object.
It may be applied before or after the CRM build ships. A CRM build that reaches
a database without it degrades to the authorization role and hides the Danger
zone's controls behind a failed read, which is the same fail-closed path as any
other unavailable RPC.

## Verification

1. `npm test`, `npm run typecheck`, `npm run build` in `admin/`.
2. `supabase db reset --local --no-seed`, `supabase test db`,
   `supabase db lint --schema public,crm_private --level error` in CI.
3. Exact-head CI on the branch.
4. Production database gate (`deploy-private-production-database.yml`) from a
   `release/private-crm-rc*` branch, dry-run first.
5. Production CRM gate (`deploy-private-production-crm.yml`) from the same SHA.
6. Production readback: the RPCs exist and are granted to `authenticated`
   only; the observed self-registered account resolves to `artist`.

## Risks

| Risk | Handling |
| --- | --- |
| A deletion half-completes | One transaction, one advisory lock, and a refusal rather than a partial teardown when another member is present |
| `account_overview` unavailable | Session falls back to the authorization role; the label is the only thing that changes |
| Someone reads the new label as an authorization change | The function is `crm_private`, ungranted, and nothing consults it to decide access; the doc and the migration header both say so |
