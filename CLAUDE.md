# Claude Code bootstrap

Read `AGENTS.md` first; it is the shared repository and GEO Topic Agent instruction source for both Codex and Claude Code.

Claude Code-specific GEO command entry point:

```bash
python scripts/geo_agent_launcher.py --runtime claude <command>
```

For explicitly requested GEO/AEO work, also read `.geo-topic-agent-runtime/AGENTS.md`, `geo_agent/PROJECT_PROFILE.md`, and `geo_agent/config/geo_agent_config.json`. Do not start GEO intake for ordinary repository development tasks.

Do not remove, hide, rewrite, disable, or bypass `LICENSE.md`, `references/attribution-and-license.md`, or the required attribution controls described by the canonical runtime.
