# Tasks — consultation context

- [x] Fresh-check canonical HEAD (`49727707`) and create bounded branch `claude/consultation-context`.
- [x] Pin section permissions from the existing read RPCs; verify every referenced column against the schema.
- [x] Migration `gpt_get_consultation_context` (read-only, SECURITY DEFINER, authenticated-only).
- [x] pgTAP contract test 1843.
- [x] Domain op, parity row, regenerated Unified scheduling OpenAPI.
- [x] MCP guidance with the untrusted-content boundary, tri-state and precedence; `listAppointments` and the server instruction point to the new tool.
- [x] Node tests and local checks (MCP tools/parity, GPT parity/domain ops, worker suite, migration order, secret scan).
- [ ] PR, exact-head CI green, merge.
- [ ] Production DB migration.
- [ ] GPT Actions Worker rollout.
- [ ] MCP activation.
- [ ] Production readback (`tools/list`, `server/discover`).
- [ ] Owner: Refresh tools and host acceptance (Michael, Barry, regression).
- [ ] Later, separate: plugin 1.0.5 skill wording; linkage/backfill workstream.
