# Python Module And CLI Adapter

After installation, prefer the persistent CLI:

```powershell
python .geo-topic-agent-runtime/geo_agent_cli.py <command>
```

First setup uses `--runtime cli`. No temporary `PYTHONPATH` is needed.

Direct Python imports are available only when the host intentionally adds `.geo-topic-agent-runtime/` to its own import path. The launcher is the portable default. All network, paid, and external action gates remain unchanged.


## Runtime Adaptation Review

The first `setup` command only detects the runtime and writes a plan with `plan_hash`. Review that plan first. A separate apply command must include both `--apply-runtime-adaptation` and the exact `--reviewed-runtime-plan-hash <plan_hash>`; otherwise no adaptation is applied.
