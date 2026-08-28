# Shared project instructions for Codex and Claude Code

This repository contains the website for tattoo artist Vladimir Vishar / Vishar Tattoo.

Primary audit priority:
technical quality, frontend stability, performance, technical SEO, security, deployment configuration, analytics/tracking, accessibility, and reliability.

Do not redesign the website unless explicitly asked.
Do not rewrite copy unless it is needed for SEO or technical clarity.
Do not modify production code during audit tasks unless explicitly asked.

When auditing, create or update only:

TECHNICAL_AUDIT.md

Always be specific.
Reference files and lines when possible.
Do not invent Lighthouse, GA4, Search Console, or production results if they were not actually checked.
If a check requires production URL access, clearly mark it as "requires production URL".
If a command cannot be run, explain why.

Before making any production change, produce a patch plan first.

## Engineering and CRM code investigations

The website-audit output rule above does not force normal engineering, CRM, CI, database, Worker, or integration investigations into `TECHNICAL_AUDIT.md`. For those tasks, use the repository-native engineering navigation layer under `docs/ai/` and `.agents/skills/vishar-code-navigation/`.

Vishar-site is branch-heavy and important implementation often lives in stacked draft PRs rather than `main`. Correct revision selection is part of correctness.

For any task involving a PR, feature branch, validation run, recent CRM feature, or integration:

1. resolve current GitHub PR metadata first;
2. record exact head SHA and exact base SHA;
3. identify the stacked parent when relevant;
4. checkout the exact target SHA;
5. verify `git rev-parse HEAD` matches before making implementation claims;
6. prefer full-checkout search with `rg`, `git grep`, `git log`, `git show`, and `git diff` over repeated GitHub file-by-file reads.

Read `docs/ai/README.md` and `docs/ai/branch-workflow.md` before substantial branch-heavy investigation. Use the `vishar-code-navigation` skill for code tracing, RPC investigation, migration history, security review, CI diagnosis, Calendar/outbox analysis, and cross-repository contract work.

### Database and RPC tracing

For a database RPC, do not stop at the first matching migration. Trace:

- every application caller;
- the final effective SQL definition at the target head;
- all later migrations mentioning the symbol or dependent object;
- `GRANT` and `REVOKE` history;
- `SECURITY DEFINER`, fixed `search_path`, role/service/artist checks;
- RLS implications;
- positive and denial tests;
- returned fields crossing trust boundaries.

The Worker Supabase client is intentionally narrow. If a task touches a privileged Worker RPC, verify both the JavaScript allow-list and database callability.

### Security-sensitive tracing

For booking, CRM, outbox, provider, Calendar, OAuth, GPT, Storage, or payment-related work, read `docs/ai/security-boundaries.md` and explicitly verify each applicable trust boundary.

In particular, do not assume browser data may select authoritative artist/provider routing. Prove the provenance of `Origin`, booking source, form version, artist, outbox kind, integration key, provider account, and credential at the exact ref.

Documentation records intent but is not proof. Current code, migrations, policies, grants, tests, and environment/deployment evidence take precedence.

### Cross-repository work

For flows spanning repositories, read `docs/ai/cross-repo-contracts.md`. Resolve and verify each repository independently at its own exact head. Never combine a current Vishar-site revision with a remembered revision from `kisa` or another repository.

### CI evidence

A CI result validates only the SHA it actually checked, unless a purpose-built validation harness explicitly checks out and verifies another target SHA. A green run on `main`, a parent stack head, or an older PR head is not validation of the current target.

Do not weaken production ACL, RLS, origin checks, secret custody, or other security controls merely to make a test harness pass.

### Mutation boundary

Investigation permission is not write permission. Unless explicitly authorized, do not modify existing PR branches, merge PRs, mark drafts Ready, deploy production, mutate staging/Supabase/Cloudflare, or create/rotate secrets.

When implementation is authorized, prefer a separate bounded branch or the explicitly named task branch from the verified target. Parallel engineering tasks should use isolated cloud checkouts, branches, or worktrees and independently verify their own `HEAD`.

## GEO Topic Agent

The installed GEO Topic Agent is available for explicitly requested GEO/AEO
research and planning tasks only. Normal repository development tasks must not
automatically become GEO intake sessions. Its canonical runtime is
`.geo-topic-agent-runtime/`; read and follow
`.geo-topic-agent-runtime/AGENTS.md` as the source of truth for those tasks.
Resolve package-relative paths under `.geo-topic-agent-runtime/`, including
`skills/`, `references/`, `geo-topic-contract.json`, `LICENSE.md`, and adapters.

Run its commands through the dual-runtime launcher so Codex and Claude Code do
not overwrite each other's runtime-local operational state:

```bash
python scripts/geo_agent_launcher.py --runtime codex <command>
python scripts/geo_agent_launcher.py --runtime claude <command>
```

The launcher invokes the same canonical CLI at
`.geo-topic-agent-runtime/geo_agent_cli.py`, selects the requested runtime
adapter, and stores active-runtime/session state under ignored
`.geo-agent-local/<runtime>/`.

Before a launcher-driven GEO session, read
`.geo-agent-local/<runtime>/STATE.md` when it exists. The tracked
`geo_agent/STATE.md` is a legacy baseline for direct CLI compatibility only and
must not override newer runtime-local state. This host-specific routing rule
overrides the canonical runtime's generic STATE lookup whenever the dual-runtime
launcher is used.

The first setup command is:

```bash
python scripts/geo_agent_launcher.py --runtime codex setup --project-dir "."
```

Launcher-driven `setup` executes against an ignored shadow project at
`.geo-agent-local/<runtime>/setup-project/`. Its runtime profile, birth plan,
adaptation report, and generated setup files are local. It must not rewrite the
tracked shared `geo_agent/config/geo_agent_config.json` or tracked reports.

The GEO runtime supplements rather than replaces the project instructions
above. In particular, it must not modify production site files during an audit
unless explicitly requested, and any proposed production change still requires
a patch plan first. Network, paid-provider, and external actions remain subject
to the runtime's approval gates.

Before any GEO/AEO task, also read `geo_agent/PROJECT_PROFILE.md` and the saved
configuration in `geo_agent/config/geo_agent_config.json`. The project profile
defines the approved positioning, location hierarchy, service taxonomy, query
cluster, evidence boundaries, and claims that must not be invented. Do not
replace those facts with generic tattoo-industry assumptions.

## Dual-runtime safety

Shared durable GEO facts remain in `geo_agent/PROJECT_PROFILE.md` and
`geo_agent/config/geo_agent_config.json`. Runtime-local state such as the active
runtime profile, birth/adaptation plan, session state, raw provider responses,
temporary exports, and logs must not be committed and must not be shared between
Codex and Claude Code. See `docs/GEO_AGENT_DUAL_RUNTIME.md`.

Parallel GEO work requires separate Git branches and preferably separate
worktrees or isolated cloud checkouts. Do not run simultaneous paid provider
collections for an identical query scope. Before any live paid run, compare the
approval ledger and dry-run scope for provider, engines, region, language,
device, depth, and normalized query inventory.

## Google Search Console

For explicitly requested Search Console diagnostics, use the project-local
read-only toolkit documented in `geo_agent/tools/gsc/README.md`:

```bash
.venv-gsc/bin/python -m geo_agent.tools.gsc.cli doctor
.venv-gsc/bin/python -m geo_agent.tools.gsc.cli snapshot --inspect-sitemap
```

The target property is `sc-domain:vishartattoo.com`. Keep the Service Account
JSON outside the repository and pass its path through
`GSC_SERVICE_ACCOUNT_PATH`; never print, paste, commit, or copy the key into an
agent prompt. A cloud runtime may instead use a protected
`GSC_SERVICE_ACCOUNT_JSON` environment secret. Generated exports belong in
ignored `geo_agent/data/gsc/`.

Treat GSC evidence as observed historical data. Search Analytics query rows are
affected by anonymisation, and URL Inspection returns cached index information,
not a live test. Do not infer zero organic visibility from an empty query export
without checking page-level totals, date coverage, property access, and URL
Inspection evidence.

## Spec-driven product development

Substantial Vishar CRM product and architecture work should use the repository
spec-driven workflow before implementation. Read
`.agents/skills/vishar-feature-development/SKILL.md` to classify the task and
`docs/ai/spec-driven-development.md` for the artifact model.

Use the full Spec Kit-compatible workflow when work introduces a new capability,
changes architecture or trust boundaries, spans multiple implementation layers,
requires multiple migrations/PRs/rollout stages, or is expected to continue
across multiple agent sessions.

Do not require Spec Kit artifacts for every small fix. Narrow copy changes,
small documentation corrections, isolated test repairs with a proven cause, and
other low-risk bounded changes should continue through the relevant repository
skill without unnecessary ceremony.

For substantial work, durable feature intent belongs under `specs/<feature-id>/`
using `spec.md`, `plan.md`, `tasks.md`, and optional `checklists/`.

The stable engineering principles for this workflow live in
`.specify/memory/constitution.md`.

The Spec Kit layer defines feature intent, planning, task decomposition, and
convergence. It does not override Vishar-specific procedures for:

- exact-head and stacked-PR verification;
- repository/code navigation;
- ordered Supabase migration analysis;
- RLS, grants, authorization, and security review;
- CI evidence;
- staging/production approvals and deployment;
- Cloudflare/Supabase/provider/account/secret mutation.

A completed specification or task list never grants permission to deploy or to
mutate production. Code presence, merge state, and green CI are not production
verification.
