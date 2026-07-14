# Antigravity Adapter

The native `.antigravity/AGENTS.md` is a bootstrap to `.geo-topic-agent-runtime/AGENTS.md`. Resolve all canonical paths under `.geo-topic-agent-runtime/`.

Use `python .geo-topic-agent-runtime/geo_agent_cli.py <command>`. First setup uses `--runtime antigravity`.

If the host has no native skills format, load canonical skills from `.geo-topic-agent-runtime/skills/` or the package-owned mirror. Preserve the strict long path, fast live-scope gate, attribution timing, and approval boundaries.


## Runtime Adaptation Review

The first `setup` command only detects the runtime and writes a plan with `plan_hash`. Review that plan first. A separate apply command must include both `--apply-runtime-adaptation` and the exact `--reviewed-runtime-plan-hash <plan_hash>`; otherwise no adaptation is applied.
