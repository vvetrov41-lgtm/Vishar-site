# Shared Vishar engineering checklist

Source: https://github.com/vvetrov41-lgtm/Vishar-Engineering/blob/6a6e5a030c47f0691827bfd2a5865be497125a2c/README.md (v0.1.0, pinned).

- Establish repository, exact revision, local rules, expected and observed behavior. Reproduce defects before changing implementation. Prefer a failing regression test before fixing behavior.
- Classify small/medium/substantial work using existing feature-development skill. For substantial work retain existing Spec Kit artifacts and governance.
- Trace CRM booking, client, project, calendar, payment records and downstream messages when changing appointments or money. Check server authority, ownership, effective migrations, RLS, grants, deduplication and concurrency. Use synthetic fixtures, never send real client messages or alter balances as an incidental test.
- Security reviews default to static/read-only scope. Never weaken auth, disclose secrets, or exploit production. Record confirmed evidence separately from hypotheses.
- Prefer supported APIs/MCP; new tool commands require a documented gap, bounded structured contracts, server-side authorization, safe errors, pagination and separate approvals for writes.
- Review minimal patches independently where practical; run relevant exact-head tests and report skipped checks. Separate code written, CI green, merged and deployed/verified. Existing release approvals remain mandatory; record actual deployment identifier and smoke results where authorized.
- Record durable lessons as regression tests or concise decisions. No secrets, raw client records or unreviewed upstream code.

This checklist is original local guidance. It adds no dependencies or deployment permissions.
