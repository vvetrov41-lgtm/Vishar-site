# GEO Topic Agent Bootstrap

This is a thin native bootstrap for the installed GEO Topic Agent.

The canonical runtime is `.geo-topic-agent-runtime`. Read and follow `.geo-topic-agent-runtime/AGENTS.md` as the source of truth. Resolve every package-relative path named by that router, including `skills/`, `references/`, `geo-topic-contract.json`, `LICENSE.md`, and adapters, under `.geo-topic-agent-runtime/`, not under the project root.

Run CLI commands through `.geo-topic-agent-runtime/geo_agent_cli.py` so a fresh process does not depend on `PYTHONPATH`. First setup command: `python .geo-topic-agent-runtime/geo_agent_cli.py setup --project-dir "." --runtime codex`.

Do not merge, replace, or reinterpret unrelated project instructions automatically.
