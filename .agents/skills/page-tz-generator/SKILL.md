---
name: page-tz-generator
description: Generate a clean standalone copywriter TZ from one approved content-plan page or an explicit quick-run cluster, AI-cited competitor evidence, parse QA, balanced n-grams, median density targets, and citeable content chunks.
---

# Page TZ Generator

Use this skill for the actual page specification, not only a handoff.

## Inputs

For a QFO-derived page require:

- authoritative approved QFO content-plan CSV/JSON;
- exact `page_id`;
- confirmed project semantic cluster;
- parsed AI-cited competitors or explicit competitor URLs/snapshots.

Command:

```powershell
python .geo-topic-agent-runtime/geo_agent_cli.py generate-page-tz --topic "<topic>" --cluster-queries-file cluster.txt --approved-content-plan-file approved_qfo_plan.json --page-id "<page-id>"
```

A direct quick TZ may use an explicit confirmed cluster without QFO. Never scan arbitrary `*qfo*.csv` files and never consume pending title rows.

## Workflow

1. Select competitors from parsed AI citations or explicit evidence.
2. Fetch with approved HTTP or use local/browser snapshots.
3. Preserve raw bytes and run parsing QA; weak/blocked pages cannot silently enter analysis.
4. Build balanced 1/2/3-grams with strong bigram coverage.
5. Recommend n-gram occurrences/density from competitor median density, not arbitrary stuffing.
6. Build clear answer, criteria, comparison, commercial, FAQ, and explicit AI-citation target chunks grounded in the selected page and full cluster.
7. Inspect `PAGE_TZ.md` as a standalone brief for a copywriter with no chat history.

## Outputs

- `reports/PAGE_TZ.md`
- `reports/PAGE_TZ_GENERATION.md`
- `data/processed/<topic>_page_tz.json`
- `data/processed/<topic>_tz_competitors.csv`
- `data/processed/<topic>_tz_content_quality.csv`
- `data/processed/<topic>_tz_ngrams.csv`
- `data/processed/<topic>_tz_chunks.csv`

`PAGE_TZ.md` contains only copywriter instructions: no parser statuses, raw refs, service labels, UI text, internal QA notes, current-chat remarks, or source garbage. Technical evidence stays in `PAGE_TZ_GENERATION.md` and machine artifacts.
