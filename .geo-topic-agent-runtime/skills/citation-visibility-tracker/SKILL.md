---
name: citation-visibility-tracker
description: Measure a site's organic SERP positions and AI-answer citation visibility across user queries, search engines, and regions. Use when the user asks to check, track, audit, monitor, or report whether their site URL, brand, or product is visible in AI answers and normal SERP results.
---

# Citation Visibility Tracker

Use this skill for measurement/reporting, not for content planning or TZ generation.

## Workflow

Use explicit `--queries`/`--queries-file` when the user provides a measurement batch. If omitted, use the semantic cluster saved in project context. Never measure a bare topic name as the query list.

1. Read `references/citation-visibility-method.md`.
1. Read `references/artifact-encoding-contract.md` before producing reports, source inventories, or imported-data summaries.
2. If live XMLRiver collection is needed, read `references/xmlriver-serp-method.md` and set explicit engines, regions, language, paid scope, and XMLRiver max thread scope (`XMLRIVER_MAX_THREADS=10`).
2. Read `references/tool-registry.json` and use the `citation_visibility_tracker` tool.
3. Collect inputs:
   - target domain;
   - confirmed brand variants, brand spellings, domain spellings, product names, and product aliases;
   - query list;
   - search engines;
   - regions;
   - existing SERP and AI-answer CSVs, or approval for live provider collection.
4. Run a local/imported-data measurement:

   ```powershell
   python .geo-topic-agent-runtime/geo_agent_cli.py citation-visibility --topic "<topic>" --domain "<domain>" --brand "<brand>" --brand-variants "<brand; spelling; domain; product alias>" --queries "<q1>; <q2>" --engines "google,yandex" --regions "RU-Moscow"
   ```

5. For live collection, run only after explicit approval and budget/scope confirmation:

   ```powershell
   python .geo-topic-agent-runtime/geo_agent_cli.py citation-visibility --topic "<topic>" --domain "<domain>" --brand "<brand>" --brand-variants "<confirmed variants>" --queries "<q1>; <q2>" --engines "google,yandex" --regions "RU-Moscow;US" --collect-live --network-approved --paid-approved
   ```

6. Inspect both the summary report and the URL-level citation source inventory before answering.
7. If `CITATION_SOURCE_INVENTORY.md` or `citation_source_inventory.csv` is missing, treat the run as incomplete because URL-level citation debugging is required.

## Outputs

- `reports/CITATION_VISIBILITY.md`
- `reports/CITATION_SOURCE_INVENTORY.md`
- `data/visibility-runs/<run_id>/CITATION_VISIBILITY_RUN.md`
- `data/visibility-runs/<run_id>/CITATION_SOURCE_INVENTORY.md`
- `data/visibility-runs/<run_id>/visibility_rows.csv`
- `data/visibility-runs/<run_id>/citation_source_inventory.csv`
- `data/visibility-runs/<run_id>/visibility_summary.json`
- `data/history/citation_visibility_rows.csv`
- `data/history/citation_source_inventory_rows.csv`
- `data/history/citation_visibility_runs.jsonl`

## Rules

- Do not overwrite measurement history. Latest reports may update, but run folders and history files must append.
- Do not merge different search engines or regions into one metric. Report `query x engine x region` rows.
- Do not treat an AI answer as site visibility unless the target URL/domain is actually cited or `project_url_cited` is true. If evidence comes from browser/manual AI capture, require expanded AI/source/citation blocks to be saved before any cited URL is opened; otherwise mark citation coverage as partial.
- Brand/product mention must be recalculated from the normalized AI answer body against confirmed brand variants; repair mojibake and HTML before matching, and do not infer it from the query, cited URL, stale `brand_mentioned` booleans, or citation title.
- If live collection is missing approval, use imported artifacts or return a visible skipped/blocked result. Do not pretend a provider call happened.
- The final answer must show organic position coverage, AI-answer presence, full cited URL count/list availability, two separate AI visibility layers (`url_citation` and `brand_mention`), citation source inventory path, and history artifact paths.

## Encoding Guard

- Do not publish or hand off an HTML/report artifact that contains `????`, replacement characters, or mojibake in Russian labels. Regenerate from source data with UTF-8 writers.
- Generated HTML reports must include `<meta charset="utf-8">`; prefer `write_html_report`/`build_html_document` over hand-written shell output.
- CSV monitoring artifacts are UTF-8 with BOM and must be read back before final reporting when Russian queries, brands, or labels are present.
