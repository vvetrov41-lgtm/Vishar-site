# Tasks

- [x] Fresh-check canonical repository, open PRs and production migration head.
- [x] Confirm existing structured logger privacy boundary and current absence of Sentry SDK instrumentation.
- [x] Add provider-neutral external observability sanitizer.
- [x] Exclude customer/entity identifiers, message content, provider payloads and credentials.
- [x] Add disabled-by-default fail-open reporter with injected transport.
- [x] Add focused privacy and transport-failure tests.
- [x] Add dedicated observability validation workflow and secret scan.
- [ ] Validate exact PR head in GitHub Actions.
- [ ] Fresh-check canonical base, parallel PRs and production migration head before merge.
- [ ] Merge only if exact-head checks are green and the base remains safe.
- [ ] Verify new canonical SHA and post-merge workflows.
- [ ] Keep Sentry transport/DSN production activation deferred to a separate rollout.
