# GEO Topic Agent Adapters

These files map the same GEO/AEO workflow to different runtimes. They are not separate products and do not change the agent mission.

Canonical runtime order:

1. `AGENTS.md`
2. `geo-topic-contract.json`
3. `skills/`
4. `references/tool-registry.json`
5. `geo_topic_agent/`

Root native entrypoints are included for Codex, Claude Code, Cursor, OpenCode, local CLI, Python module use, and Node or mixed repositories that call the Python CLI as a sidecar.