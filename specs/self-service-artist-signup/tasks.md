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

- [ ] T20 Exact-head CI green on the PR.
- [ ] T21 Merge and confirm canonical head.
- [ ] T22 Production database dry-run, then apply, then read the migration head back.
- [ ] T23 Production CRM Pages deploy with its Access readback.
- [ ] T24 Production acceptance with a temporary marked account, then clean it up.
- [ ] T25 Owner decision on reachability (Access boundary or a separate public signup host).
