# Tasks: Self-Service Artist Signup

## Database

- [x] T1 Settings singleton, closed by default, unreadable from any API role.
- [x] T2 Self-service ledger keyed on `profile_id`, making a second tenant impossible.
- [x] T3 Founder cap inside `can_found_workspace()`, applying only to ledger accounts.
- [x] T4 `self_service_signup_policy()`, one boolean, readable before sign-in.
- [x] T5 `set_self_service_signup()`, installation owner only, audited.
- [x] T6 `bootstrap_artist_account()`: session, verified address, per-account lock, ledger, existing
      profile refusal, switch, rolling window, then the tenant.
- [x] T7 Audit events `signup.tenant_created` and `signup.availability_changed`.

## CRM

- [x] T8 One password rule shared by the invitation and signup screens.
- [x] T9 `?signup=1` accepted as an Auth callback marker, matched exactly.
- [x] T10 `verify_email` and `setup` access states.
- [x] T11 Sign-up, confirm-email and first-run setup screens, in both interface languages.
- [x] T12 Signed-out routing so `/signup` is reachable, and the sign-in link shown only when open.
- [x] T13 Land on the artist's own onboarding checklist after setup.

## Tests

- [x] T14 pgTAP `267_self_service_signup.sql`: default-closed, owner-only switch, unverified refusal,
      full tenant, idempotency, cross-tenant isolation, escalation refusals, invited-account
      refusal, both caps, and 0087's original refusal still holding.
- [x] T15 Vitest `self-service-signup.test.tsx`: marker matching, password rule, link visibility,
      signup without CRM writes, unconfirmed hold, setup, server refusal, no identifiers sent.
- [x] T16 Pin the clock in `payments-client-identity.test.tsx`, which had started expiring against
      the 2026-09-01 appointment fixture.

## Documentation

- [x] T17 `docs/crm/SELF_SERVICE_SIGNUP.md`.
- [x] T18 `docs/crm/NEW_ARTIST_ONBOARDING.md` corrected where it said there is no self-signup.
- [x] T19 Operator-parity classification for the signup journey and the owner switch.

## Rollout

- [x] T20 Exact-head CI green on PR #602 at `e319e237`: Static Validation, Public site and Worker,
      Private CRM, and Supabase migrations and pgTAP (53 subtests in 267).
- [x] T21 Merged as `2193c309`, confirmed as the canonical CRM branch head.
- [x] T22 `deploy-private-production-database` run 25 (dry-run) then run 26 (apply) from
      `release/private-crm-rc602-self-service-signup` at `2193c309`. Production migration head read
      back as `0130 self_service_signup`.
- [x] T23 `deploy-private-production-crm` run 64 at the same SHA: exact Pages commit readback, the
      Pages target and Access recheck, and the signed-out HTTP gate. Independently re-verified:
      `crm.vishartattoo.com` and `vishar-crm-production.pages.dev` both still answer 302 to the
      Cloudflare Access login.
- [x] T24 Production acceptance, below.
- [ ] T25 Owner decision on reachability (Access boundary or a separate public signup host).

## Review findings, after the first production rollout

Two P1 findings from automated review on PR #602, both reproduced against the live production
database before being fixed, and both introduced by this workstream changing a premise other code
rested on. Migration `0131`, pgTAP `268`.

- [x] T26 `public.list_directory_profiles()` returned every active profile - name, email address and
      role - to anybody holding an artist-level membership, which a self-service account now is.
      Reproduced: a synthetic stranger read three rows including Vladimir and Kristina. Scoped for
      ledger accounts to the people they already share an artist or an organization with; every
      invited account's view is unchanged.
- [x] T27 The founder cap counted only active organizations, so a founder could deactivate their own
      artist and organization - both of which they legitimately administer, and 0089 keeps their
      owner membership row alive - and found another, indefinitely. Reproduced with the cap set to 1.
      Now counted whether or not each organization is switched on.

## Production acceptance evidence

Run against the live production database inside a transaction that ended in a deliberate
exception, so it committed nothing. Verified afterwards: no leftover auth user, profiles still 2,
artists 2, workspaces 3, self-service tenants 0, signup still closed, 15 clients / 16 enquiries /
5 projects unchanged, no `signup.%` audit rows.

Alongside 15 real clients, 16 real enquiries and 5 real projects, a synthetic confirmed account:

| Claim | Observed |
| --- | --- |
| One call creates the tenant | `created=true` |
| A repeat creates nothing | `created=false`, same `artist_id` |
| Never an installation owner | `profile_role=booking_manager`, `is_owner()=false` |
| Its own solo organization | `workspace_type=solo`, `workspace_role=owner` |
| Its own book, fully | `artist:truetruetruetrue` |
| Sees no other tenant | clients 0, enquiries 0, projects 0 |
| Cannot enumerate artists | artists 1 (its own), profiles 1 (its own) |
| Cannot seat itself on an existing artist | refused 42501 |
| Cannot grant itself an existing artist | refused 42501 |
| Cannot close signup | refused 42501 |
| Cannot open an existing artist's administration | refused 42501 |

Existing access, read as each production profile:

| Profile | can_found | workspaces | artists | enquiries | clients | projects | payments |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Vladimir (owner) | true | 3 | 2 | 16 | 15 | 5 | 4 |
| Kristina (booking_manager) | true | 1 | 1 | 6 | 5 | 1 | 0 |

Neither is in the self-service ledger, so the founder cap does not apply to either.

Function ACLs read back from production: `anon` may execute `self_service_signup_policy()` and
nothing else new; `authenticated` may execute the bootstrap and the switch; `service_role` may
execute neither; `authenticated` cannot read `crm_private.self_service_settings`.
