# Implementation Plan: Self-Service Artist Signup

## Approach

Add one door rather than widen an existing one.

`crm_private.can_found_workspace()` stays a gated administrative predicate. Self-service gets
`public.bootstrap_artist_account`, a single SECURITY DEFINER function that takes no identifier and
writes one complete tenant for `auth.uid()` in one transaction. Everything else in the platform -
RLS, capability derivation, the onboarding checklist, the integration architecture - is reused
unchanged, because it is already artist-scoped and already universal.

## Trust boundaries touched

| Boundary | Change |
| --- | --- |
| Supabase Auth | A second accepted redirect marker, `?signup=1`, matched exactly like `?staff_invite=1` |
| `public.profiles` | A new writer, which creates `booking_manager` and never `owner` |
| `public.workspaces` / `public.artists` | A new writer, which creates only for the caller and only solo |
| `crm_private.can_found_workspace()` | Narrowed for self-service accounts by a founder cap; unchanged for everybody else |
| New `crm_private` tables | Settings and ledger, unreadable from any API role |

No RLS policy is loosened. No table gains a browser grant. No existing function's authorization is
widened.

## Migration

`supabase/migrations/0130_self_service_signup.sql`, additive and fail-closed:

1. `crm_private.self_service_settings` - singleton, `is_open` false by default.
2. `crm_private.self_service_accounts` - the ledger, primary key on `profile_id`.
3. `crm_private.within_self_service_workspace_cap()` and a re-created
   `crm_private.can_found_workspace()` that conjoins it.
4. `public.self_service_signup_policy()` - one boolean, granted to `anon` and `authenticated`.
5. `public.set_self_service_signup(...)` - installation owner only, audited.
6. `public.bootstrap_artist_account(...)` - the tenant, granted to `authenticated`.

Applying it changes no behaviour: the switch is closed and the bootstrap refuses.

## CRM

- `admin/src/lib/password.ts` - the 12-128 rule, read by both password screens.
- `admin/src/lib/signup-api.ts` - the three RPCs; the policy read fails closed.
- `admin/src/lib/supabase.ts` - `authCallbackKind`, matching exactly two markers.
- `admin/src/lib/session.tsx` - two new access states, `verify_email` and `setup`, plus `signUp`,
  `resendVerification` and `completeArtistSetup`.
- `admin/src/pages/SignUpPage.tsx`, `VerifyEmailPage.tsx`, `ArtistSetupPage.tsx`.
- `admin/src/App.tsx` - a signed-out route table so `/signup` is reachable before sign-in.

## Rollout

1. PR against the canonical CRM branch; exact-head CI runs the full pgTAP suite, the PostgreSQL
   lint, the CRM tests, typecheck and build.
2. Merge, confirm canonical head.
3. `deploy-private-production-crm-database` from a `release/private-crm-rc*` branch: local no-seed
   reset, pgTAP, lint, then `supabase db push --dry-run` against production before any apply.
4. Apply, and read the production migration head back.
5. `deploy-private-production-crm` for the Pages build, with its existing Access readback.
6. Production acceptance against the live database, with a clearly marked temporary account,
   cleaned up afterwards.

## Rollback

The migration is additive. The operational rollback is
`public.set_self_service_signup(false)`, which stops new tenants immediately and leaves existing
ones working. Nothing needs to be dropped to make the feature inert.
