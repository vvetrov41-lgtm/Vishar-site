---
name: semantic-tz-handoff
description: Prepare a semantic SEO TZ generator handoff from GEO/AEO topic evidence, including source rows, intent clusters, content modules, and generator invocation boundaries.
---

# Semantic TZ Handoff

Use this skill when the task asks to generate, prepare, or pass data into a semantic SEO TZ generator.

## Procedure

1. Read `references/semantic-tz-handoff.md`.
2. Confirm whether project setup found an available semantic TZ or brief generator.
3. Refresh the existing handoff JSON. If it is missing, run the full `geo-topic-workflow` first; this direct skill must not silently expand into a full topic run:
   ```powershell
   python .geo-topic-agent-runtime/geo_agent_cli.py generate-tz --topic "<topic>"
   ```
4. If the user explicitly wants invocation and the generator is available, inspect the generator's own tool contract before running it and pass `--generator-contract-ref`.
5. Report whether the output is only a handoff or a generated TZ.

## Boundaries

- Do not call a handoff a completed TZ.
- Do not run the full topic workflow from this direct skill when the handoff is missing; block with the missing prerequisite instead.
- Do not lower semantic generator quality gates.
- Do not hide missing SERP/AI evidence.
- Do not pass raw secrets or `.env` values.

