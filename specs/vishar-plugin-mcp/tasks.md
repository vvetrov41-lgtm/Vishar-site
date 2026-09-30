# Tasks — Vishar CRM Plugin MCP migration

- [x] Fresh-check canonical CRM branch and create bounded migration branch.
- [x] Audit existing MCP Worker, auth boundary and production rollout.
- [x] Audit Unified GPT execution path and parity sources.
- [ ] Add deterministic Unified GPT -> MCP contract compiler.
- [ ] Generate committed Plugin MCP tool manifest from all approved Unified domains.
- [ ] Add drift/security tests for parity, exclusions, authority fields and annotations.
- [ ] Add feature-gated MCP runtime adapter that reuses `handleGptActionsRequest`.
- [ ] Extend MCP domain validation and production config tests.
- [ ] Verify/adjust protected-resource OAuth metadata for the private Plugin.
- [ ] Add reproducible private Plugin package/skill source.
- [ ] Open PR against `agent/platform-telegram-self-service` and run exact-head CI.
- [ ] Review/fix CI and security findings.
- [ ] Merge only after fresh canonical check.
- [ ] Production MCP rollout with fail-closed activation and Cloudflare/Supabase readback.
- [ ] Create/connect private Vishar CRM Plugin.
- [ ] Authenticated production acceptance across representative read/write/provider/money/permission classes.
- [ ] Keep GPT Actions as transition rollback until Plugin parity is proven.