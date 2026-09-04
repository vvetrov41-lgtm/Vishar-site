# Tasks: Universal Google Calendar onboarding

| ID | Task | Requirement | State |
| --- | --- | --- | --- |
| T01 | Fresh-check canonical branch, head SHA, open PRs, migration head (repo + production Supabase) | Constitution IV, VII | done |
| T02 | Write `spec.md` / `plan.md` / `tasks.md` | Constitution IX | done |
| T03 | Migration `0137`: route-key trigger, account uniqueness, presentation defaults | FR6, FR7, FR9 | done |
| T04 | Migration `0137`: generic `set_calendar_connection_metadata` | FR6, FR7, FR9 | done |
| T05 | Migration `0137`: generic `list_calendar_connection_status` | FR8 | done |
| T06 | Migration `0137`: `resolve_calendar_artist_route` | FR1 | done |
| T07 | Migration `0137`: `reset_calendar_expected_account` | FR10 | done |
| T08 | Migration `0137`: presentation backfill for vladimir/kristina | Scenario 2 | done |
| T09 | Generic `calendar-oauth-security.js` | FR2, FR3, FR4, FR5 | done |
| T10 | Generic `calendar-oauth.js` | FR2, FR3, FR4, FR5 | done |
| T11 | Route-derived drain config in `google-calendar.js` | FR5, FR9 | done |
| T12 | Frontend slug-generic Calendar connections | FR8, FR10 | done |
| T13 | Wrangler + validation script cleanup | FR5 | done |
| T14 | Worker tests: denial matrix, state substitution, first bind, mismatch | Scenarios 3-6 | done |
| T15 | pgTAP tests for `0137` | FR1, FR6-FR10 | done |
| T16 | Admin tests | FR8 | done |
| T17 | Exact-head CI green for implementation and rollout heads | AC1 | done |
| T18 | Retained staging migration + pgTAP | AC2 | blocked: staging is at 0044; isolated 0137 is unsafe |
| T19 | Production migration `0137` + migration-history readback | AC2 | done |
| T20 | Production Calendar Worker redeploy | AC3 | done |
| T21 | Production Pages / DB / Worker / Cloudflare readback | AC3, AC4, AC5 | done |
| T22 | Fail-closed Calendar Access policy synchronizer + tests | FR11, AC6 | done |
| T23 | Merge Access sync with exact-head CI | FR11, AC6 | in progress |
| T24 | Production Calendar Access policy sync + independent readback | AC6 | pending |
| T25 | Retained staging ordered catch-up plan / dry-run proof | AC2 | pending |
| T26 | Third-artist acceptance (interactive Google consent) | AC7 | pending |
