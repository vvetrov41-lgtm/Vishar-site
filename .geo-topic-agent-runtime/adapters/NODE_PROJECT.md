# Node Or Mixed Project Adapter

The installed Python runtime is a sidecar under `.geo-topic-agent-runtime/`. Do not add it to `PYTHONPATH`.

Call:

```powershell
python .geo-topic-agent-runtime/geo_agent_cli.py <command> --project-dir "."
```

First setup uses `--runtime node`. Node wrapper scripts may invoke this launcher but must preserve exact network/paid approval, UTF-8, append-only history, and external-write boundaries. No npm dependency or dashboard frontend is bundled.


## Runtime Adaptation Review

The first `setup` command only detects the runtime and writes a plan with `plan_hash`. Review that plan first. A separate apply command must include both `--apply-runtime-adaptation` and the exact `--reviewed-runtime-plan-hash <plan_hash>`; otherwise no adaptation is applied.
