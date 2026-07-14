# GEO Topic Agent - Generic Bootstrap

Canonical package root: `.geo-topic-agent-runtime/`.

Read `.geo-topic-agent-runtime/AGENTS.md`, then its contract, relevant skills, and references. Resolve every package-relative path under that root.

First setup:

```powershell
python .geo-topic-agent-runtime/geo_agent_cli.py setup --runtime generic
```

Guide the user through the strict GEO/AEO project workflow, evidence gates, content planning, page TZ, and monitoring.


## Runtime Adaptation Review

The first `setup` command only detects the runtime and writes a plan with `plan_hash`. Review that plan first. A separate apply command must include both `--apply-runtime-adaptation` and the exact `--reviewed-runtime-plan-hash <plan_hash>`; otherwise no adaptation is applied.
