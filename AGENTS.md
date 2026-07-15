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

The first setup command is:

```bash
python scripts/geo_agent_launcher.py --runtime codex setup --project-dir "."
```

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
