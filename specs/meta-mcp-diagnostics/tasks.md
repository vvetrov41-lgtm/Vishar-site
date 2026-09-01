# Tasks

- [x] Fresh-check canonical repository, open PRs and production migration head.
- [x] Confirm diagnostic source tables and actor RLS/capability boundaries.
- [x] Add read-only Meta diagnostic domain.
- [x] Add Meta-specific feature flag, default off.
- [x] Add tests for capability checks, PII/credential exclusions and bounded reads.
- [x] Wire Meta tests into MCP validation workflow.
- [ ] Validate exact PR head in GitHub Actions.
- [ ] Fresh-check canonical base and PR mergeability.
- [ ] Merge only if exact-head checks are green and no conflicting parallel work appeared.
- [ ] Verify new canonical SHA and post-merge CI/readback.
- [ ] Keep production activation deferred until a separate rollout validates Cloudflare/OAuth/rate-limit boundaries.
