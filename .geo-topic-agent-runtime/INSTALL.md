# Install

Extract the runtime archive into a temporary staging directory outside the user project. Do not unzip over an existing project.

The installer verifies every signed `FILES.sha256` runtime file, then copies only those canonical files to `<target-project>/.geo-topic-agent-runtime/`. Existing project files are outside this allowlist: `.git/`, `.env`, IDE folders, source code, and documents are ignored, never copied, never overwritten, and never an integrity error. Native IDE files are installed only after explicit request and are never allowed to overwrite a collision.

## Install From Staging

Windows PowerShell:

```powershell
Set-Location "<extracted-runtime-staging>"
$env:PYTHONUTF8="1"
$env:PYTHONIOENCODING="utf-8"
python geo_agent_cli.py install --project-dir "<target-project>" --runtime <codex|claude|cursor|opencode|antigravity|generic|cli|node> --install-native-adapter
Set-Location "<target-project>"
python .geo-topic-agent-runtime/geo_agent_cli.py setup --project-dir "." --runtime <runtime>
```

macOS/Linux:

```bash
cd "<extracted-runtime-staging>"
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python3 geo_agent_cli.py install --project-dir "<target-project>" --runtime <runtime> --install-native-adapter
cd "<target-project>"
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python3 .geo-topic-agent-runtime/geo_agent_cli.py setup --project-dir "." --runtime <runtime>
```

No temporary or persistent `PYTHONPATH` is required. After installation, always invoke the runtime through `.geo-topic-agent-runtime/geo_agent_cli.py` from the project root.

If installation reports `collision_requires_user_merge`, review the package-owned candidate and explicitly merge only the needed instructions. Never replace existing project instructions automatically.

## Canonical Path Resolution

After installation:

- package root: `.geo-topic-agent-runtime/`;
- persistent CLI: `.geo-topic-agent-runtime/geo_agent_cli.py`;
- canonical router: `.geo-topic-agent-runtime/AGENTS.md`;
- contracts/skills/references: resolve under `.geo-topic-agent-runtime/`;
- root `AGENTS.md`, `CLAUDE.md`, `.cursor/`, `.antigravity/`, `AGENT.md`, or `opencode.json`: native bootstrap files only.

## Strict Long Run

1. environment adaptation;
2. deep site/product/brand context;
3. explicit user confirmation of every brand/domain/product variant;
4. site audit and target-page LLM audit, or explicit decisions to decline/block each;
5. topic label plus exact user semantic cluster;
6. QFO evidence and user-approved content plan;
7. page TZ;
8. monitoring with ordinary SERP position, AI-answer presence, URL citation, brand mention, and product/solution mention kept separate.

Context collection does not run audits and does not request topic/cluster data. Unknown mandatory context facts remain lower-assurance unless the user explicitly confirms they are not applicable.

## Fast Cluster Run

Fast mode accepts the cluster as the only new planning input when environment, complete context, confirmed brand variants, and both audit decisions exist.

Before live paid execution, saved or newly supplied scope must explicitly include engines, region/city, language, and top-N URL depth. Show the exact query inventory, AI scope, calculated paid requests, ten-worker plan, and budget. Obtain approval bound to that exact scope. Never rely on XMLRiver/provider defaults.

## XMLRiver Boundary

- Google endpoint: `https://xmlriver.com/search/xml`.
- Yandex endpoint: `https://xmlriver.com/search_yandex/xml`.
- Depth means top-N organic URLs, not pagination pages.
- Top 100 means ten paid SERP pages per query/engine when pages contain ten URLs.
- Maximum paid-request concurrency is ten workers.
- Engine, region, language, depth, query inventory, AI scope, request count, and budget are approval-bound.
- Raw bytes, request ledger, hashes, and provider errors are retained.
- Provider error payloads produce zero processed SERP/AI rows.

Credentials remain only in the target project's local `.env`. The public template contains only `XMLRIVER_USER=` and `XMLRIVER_KEY=`.

## Dashboard Boundary

The runtime ships dashboard knowledge and a co-design contract only. It contains no dashboard UI, HTML/CSS/JS, frontend, screenshot, mock data, fixed layout, client data, or test project. If requested, the agent agrees user-specific metrics, dimensions, history, errors, requirements, and stack before construction in the user's project.

## Post-Birth Boundary

Adaptation may move only package-owned inactive adapter copies inside `.geo-topic-agent-runtime/`. It never alters user-owned files. Keep the active bootstrap, canonical runtime, project artifacts, state, and memory.


## Runtime Adaptation Review

The first `setup` command only detects the runtime and writes a plan with `plan_hash`. Review that plan first. A separate apply command must include both `--apply-runtime-adaptation` and the exact `--reviewed-runtime-plan-hash <plan_hash>`; otherwise no adaptation is applied.
