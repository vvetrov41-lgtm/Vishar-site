# Tasks: Account UX, Role Semantics and Self-Service Deletion

| # | Task | State |
| --- | --- | --- |
| T1 | Fresh-check: canonical branch, exact head, open PRs, exact-head CI, production migration head, current role/membership model | done |
| T2 | `crm_private.user_facing_role` and `public.account_overview` | done |
| T3 | `public.set_my_display_name` | done |
| T4 | `public.delete_my_account`, erase-and-retire semantics | done |
| T5 | pgTAP `272_account_lifecycle.sql` | done |
| T6 | `account-api.ts` and session wiring | done |
| T7 | Controlled account popover with outside-click, Escape and a real name link | done |
| T8 | `AccountPage` and the `#/account` route | done |
| T9 | EN/RU copy and API failure sentences | done |
| T10 | Component tests: role display, popover behaviour, account page and Danger zone | done |
| T11 | `docs/crm/ACCOUNT_LIFECYCLE.md` | done |
| T12 | Branch CI green at exact head | done — 5/5 green on `51f7727` |
| T13 | Merge to canonical | done — PR #631, canonical `8b6a87d` |
| T14 | Production database deploy through the gated release lane | done — dry-run then apply, from `release/private-crm-rc-account-lifecycle-20260902` |
| T15 | Production CRM deploy at the same SHA | done — run 70 at `8b6a87d` |
| T16 | Production readback and acceptance | done — see `docs/crm/ACCOUNT_LIFECYCLE.md` |
