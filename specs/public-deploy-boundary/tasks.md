# Tasks: Public deploy boundary

- [x] T001 Evidence: production exposure measured; Pages ignore behaviour confirmed in docs.
- [x] T002 `scripts/build-public.mjs` with explicit allowlist, forbidden patterns, `--check`, `--self-test` [FR-001–FR-004]
- [x] T003 `scripts/verify-public-deploy.mjs` [AC-002, AC-003]
- [x] T004 Local Pages emulation (`wrangler pages dev dist`, wrangler 4.141.0): 70/70 public 200, 9/9 redirects, headers, 238/238 private not served; every one of 927 published files 200 [FR-005]
- [x] T005 CI steps, `.gitignore` (`dist/`, `source-assets/`), docs
- [ ] T006 PR CI green (exact head)
- [ ] T007 Owner applies Pages settings; preview passes `verify:deploy` [AC-002]
- [ ] T008 Merge; production passes `verify:deploy` [AC-003]
