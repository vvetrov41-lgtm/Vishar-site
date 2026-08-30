# AI engineering navigation

This directory is a compact navigation layer for Codex, ChatGPT Work, and other repository agents working on Vishar-site.

It is intentionally not a second copy of the CRM documentation. The source of truth is always the checked-out code, migrations, tests, ADRs, and current Git metadata. If anything here conflicts with the implementation at the exact ref being investigated, the implementation wins and this guide should be corrected.

## First rule: prove the ref before reading the implementation

Vishar-site is developed through a long stack of draft feature branches. Important functionality may be absent from `main`, and a branch name alone is not sufficient evidence because heads move.

Before a code investigation, record:

- repository;
- PR number when applicable;
- head branch;
- expected head SHA;
- base branch;
- expected base SHA;
- whether the PR is stacked on another draft PR.

Then verify the checkout with `git rev-parse HEAD` before drawing conclusions.

See [branch-workflow.md](branch-workflow.md).

## Navigation files

- [repository-map.md](repository-map.md): where the major systems live and which paths to search first.
- [security-boundaries.md](security-boundaries.md): mandatory trust boundaries for booking, CRM, integrations, Calendar, and agent-facing work.
- [branch-workflow.md](branch-workflow.md): exact-head and stacked-PR procedure.
- [cross-repo-contracts.md](cross-repo-contracts.md): ownership boundaries between Vishar-site and related repositories such as `kisa`.
- [investigation-playbook.md](investigation-playbook.md): repeatable procedures for RPC, Worker, migration, outbox, Calendar, and security tracing.
- [benchmark.md](benchmark.md): how to measure whether this navigation layer actually improves agent work.
- [spec-driven-development.md](spec-driven-development.md): durable Spec Kit-compatible workflow for substantial Vishar product/architecture changes.

## Task-specific repository skills

Use repository skills only after proving the current target ref.

- `.agents/skills/vishar-feature-development/SKILL.md`: route substantial product work through the appropriate specification workflow.
- `.agents/skills/vishar-code-navigation/SKILL.md`: exact-ref code and production-boundary navigation.
- `.agents/skills/vishar-gpt-production-onboarding/SKILL.md`: Unified GPT v2 OAuth, profile-bound Artist context, production Action imports, capability activation, acceptance and rollback.

## Current reference snapshot

This navigation layer was introduced from the top of the active CRM stack represented by PR #186, `agent/kristina-crm-intake-staging`, at exact head `3085d382f7f6bf39442a5f5e90ae27ae6435cf58` on 2026-08-10.

That SHA is historical context, not a permanent target. Future investigations must resolve their own exact head from GitHub instead of reusing it.

## Preferred tool split

Use GitHub metadata tools for PR discovery, current heads, bases, reviews, and Actions evidence. Once the correct ref is known, prefer a full local or cloud checkout for implementation analysis and use `rg`, `git grep`, `git log`, `git show`, and `git diff` instead of repeatedly fetching individual files through GitHub.

Do not use documentation as proof that a security control still exists. Verify the current caller, database definition, grants, policies, tests, and provider boundary at the exact ref.