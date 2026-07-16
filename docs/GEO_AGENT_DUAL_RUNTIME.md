# GEO Topic Agent dual-runtime operation

This repository uses one canonical GEO Topic Agent package at `.geo-topic-agent-runtime/`. Codex and Claude Code must both invoke that same package; do not copy or fork the runtime.

## Shared project data

The shared project source of truth stays under `geo_agent/` and includes the approved project profile, config, business facts, service taxonomy, location hierarchy, evidence boundaries, approval ledgers, completed milestones, reports, and durable data that are intentionally part of the project history.

The confirmed Vishar facts remain shared: Vladimir Vishar / Vishar Tattoo, Manchester and Salford positioning, service taxonomy, approved semantic query cluster, XMLRiver settings and budgets, safety restrictions, and the distinction from No Regrets Studios.

## Runtime-local operational state

Use the launcher so active-runtime details and transient state are written below `.geo-agent-local/<runtime>/` instead of overwriting another runtime's operational files.

Runtime-local files are:

- `.geo-agent-local/<runtime>/runtime/runtime-profile.json`
- `.geo-agent-local/<runtime>/runtime/birth-plan.json`
- `.geo-agent-local/<runtime>/STATE.md`
- `.geo-agent-local/<runtime>/setup-project/geo_agent/reports/ADAPTATION_REPORT.md`
- the remaining generated setup files below `.geo-agent-local/<runtime>/setup-project/`

The tracked `geo_agent/STATE.md` remains only for legacy direct-CLI compatibility. Launcher-driven Codex sessions must read `.geo-agent-local/codex/STATE.md`; launcher-driven Claude Code sessions must read `.geo-agent-local/claude/STATE.md`.

`.geo-agent-local/` is ignored and must remain untracked. Raw provider responses, temporary SERP exports, session logs, credentials, and generated local execution artifacts must also remain untracked.

## Commands

Codex:

```bash
python scripts/geo_agent_launcher.py --runtime codex <command> ...
```

Claude Code:

```bash
python scripts/geo_agent_launcher.py --runtime claude <command> ...
```

Examples:

```bash
python scripts/geo_agent_launcher.py --runtime codex setup --project-dir .
python scripts/geo_agent_launcher.py --runtime claude provider-audit --project-dir .
```

The launcher sets `GEO_AGENT_RUNTIME` and `GEO_AGENT_RUNTIME_LOCAL_ROOT`, invokes `.geo-topic-agent-runtime/geo_agent_cli.py`, forwards exit codes, and does not print secrets.

For `setup`, the launcher:

1. confirms that forwarded `--runtime` agrees with the launcher runtime;
2. rejects conflicting `--runtime value` and `--runtime=value` forms;
3. copies only the shared project profile/config and repository markers into an ignored shadow project;
4. runs setup against `.geo-agent-local/<runtime>/setup-project/`;
5. leaves tracked `geo_agent/config/geo_agent_config.json` and tracked reports unchanged.

Directly invoking setup with `GEO_AGENT_RUNTIME_LOCAL_ROOT` but without the launcher is not the supported dual-runtime workflow.

## Initial setup

Do not rerun first-time intake for this Vishar project. For normal topic work, read `AGENTS.md`, `.geo-topic-agent-runtime/AGENTS.md`, `geo_agent/PROJECT_PROFILE.md`, `geo_agent/config/geo_agent_config.json`, and the matching runtime-local STATE file before GEO/AEO work. Run setup only when adapting a new checkout or verifying runtime detection.

## Parallel work rules

Parallel Codex/Claude work requires separate Git branches and preferably separate Git worktrees or isolated cloud checkouts. Do not edit the same production website file concurrently. Review and merge sequentially.

Only one live paid collection should run for an identical query scope. Before any paid collection, compare the approval ledger and dry-run plan for the same provider, engine set, region, language, device, depth, and normalized query inventory. The runtime already requires explicit approval flags and hash-bound approval records before paid XMLRiver/QFO work; this repository does not add a cross-container distributed lock, so operators must avoid duplicate live runs across separate cloud containers.

## Credentials

Configure provider credentials only in local environment variables or untracked `.env` files. Never commit XMLRiver, DataForSEO, Firecrawl, or other secrets. The CLI reports only masked key presence.

## Verification

To verify runtime selection without network or paid calls:

```bash
python scripts/geo_agent_launcher.py --runtime codex setup --project-dir .
python scripts/geo_agent_launcher.py --runtime claude setup --project-dir .
cat .geo-agent-local/codex/runtime/runtime-profile.json
cat .geo-agent-local/claude/runtime/runtime-profile.json
cat .geo-agent-local/codex/STATE.md
cat .geo-agent-local/claude/STATE.md
```

Both profiles use the same canonical runtime and copied shared project facts, while setup output and operational STATE remain isolated under separate ignored runtime-local roots. The tracked shared project config must remain byte-for-byte unchanged after either setup command.
