# QFO_QUERY_ANALYSIS

Generated: 2026-07-25T18:33:20+00:00
Topic: Realism tattoo artist in Manchester and Salford
Status: quality_fail

## What QFO Means

QFO means Query Fan-Out: follow-up, adjacent, implied, and reformulated searches that can appear around the user's seed queries. In this runtime the semantic source for QFO planning is the AI-cited page title inventory, not mechanically generated title variants.

## Scope And Counts

- Seed queries supplied: 10
- XMLRiver query x engine pairs: 10
- Requested top URLs per pair (`--depth`): 20
- XMLRiver SERP pages per pair: 2
- XMLRiver planned paid page requests: 20
- XMLRiver max live threads: 10
- XMLRiver planned thread slots: 10
- XMLRiver active paid thread slots this run: 10
- Organic SERP rows parsed: 82
- AI answer/source rows parsed: 0
- AI-cited titles extracted: 0
- Title semantic units: 0
- Template/mask query generation from titles: disabled
- Optional ChatGPT QFO rows: 0
- Exact-title evidence rows for agent clustering: 0
- Content plan candidate rows: 0

## Evidence Basis

- No AI-cited titles are available yet. The runtime did not create title clusters or a content plan from seed queries alone.
- Run approved XMLRiver `ai=1` collection or import AI citation title evidence before QFO content planning.

## Full AI-Cited Title Inventory

| # | Source Query | Domain | Title | URL | Source |
| ---: | --- | --- | --- | --- | --- |
| 0 | none | none | none | none | none |

## Exact-Title Evidence Rows For Agent Clustering

| Row | Title | AI Title Observations | Source Queries | Citation Domains | Status | Guard |
| --- | --- | ---: | --- | --- | --- | --- |
| none | none | 0 | none | none | none | none |

## Content Plan Candidate Rows

These rows are not a finished content plan. They are a workpack for agent/subagent logical clustering from the full title inventory.

| Page | Type | Agent Task | Candidate Title | Included AI Titles | Status |
| --- | --- | --- | --- | --- | --- |
| none | none | none | none | none | none |

## Artifacts

- seed_queries: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_seed_queries.csv
- chatgpt_queries: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_chatgpt_queries.csv
- xmlriver_serp_rows: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_xmlriver_serp_rows.csv
- xmlriver_ai_answers: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_xmlriver_ai_answers.csv
- citation_title_enrichment_ledger: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_title_enrichment.csv
- citation_title_raw_pages: geo_agent/data/raw/serp/qfo_xmlriver_7e9e53f718a3/citation-title-pages
- ai_titles: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_ai_titles.csv
- title_semantics: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_title_semantics.csv
- theme_clusters: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_theme_clusters.csv
- content_plan: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_content_plan.csv
- theme_selection_template: geo_agent/data/import/realism-tattoo-artist-in-manchester-and-salford_qfo_theme_selection_template.csv
- paid_approval_template: geo_agent/data/import/realism-tattoo-artist-in-manchester-and-salford_qfo_xmlriver_approval_template.json
- approval_ledger: geo_agent/data/quality-gates/external_approval_ledger.json
- evidence_manifest: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_evidence_manifest.json
- raw_summary: geo_agent/data/raw/serp/qfo_xmlriver_7e9e53f718a3/qfo_collection_summary.json
- summary_json: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_analysis.json

## Errors And Limits

- google / custom tattoo artist Manchester / page=1: RuntimeError: XMLRiver error 500: Выполните перезапрос. Ответ от поисковой системы не получен.
- google / custom tattoo artist Manchester / page=2: RuntimeError: XMLRiver error 500: Выполните перезапрос. Ответ от поисковой системы не получен.
- google / colour realism tattoo Manchester / page=1: RuntimeError: XMLRiver error 500: Выполните перезапрос. Ответ от поисковой системы не получен.
- google / black and grey realism tattoo Manchester / page=2: RuntimeError: XMLRiver error 500: Выполните перезапрос. Ответ от поисковой системы не получен.
- google / colour realism tattoo Manchester / page=2: RuntimeError: XMLRiver error 500: Выполните перезапрос. Ответ от поисковой системы не получен.
- google / tattoo cover up Manchester / page=2: RuntimeError: XMLRiver error 500: Выполните перезапрос. Ответ от поисковой системы не получен.
- google / realism tattoo artist Manchester / page=2: RuntimeError: XMLRiver error 500: Выполните перезапрос. Ответ от поисковой системы не получен.
- google / realism tattoo artist Manchester / page=1: RuntimeError: XMLRiver error 500: Выполните перезапрос. Ответ от поисковой системы не получен.
- google / realism tattoo artist Salford / page=2: RuntimeError: XMLRiver error 500: Выполните перезапрос. Ответ от поисковой системы не получен.
- google / portrait tattoo artist Manchester / page=1: RuntimeError: XMLRiver error 500: Выполните перезапрос. Ответ от поисковой системы не получен.
- google / tattoo artist Salford / page=1: RuntimeError: XMLRiver error 500: Выполните перезапрос. Ответ от поисковой системы не получен.
- No AI-cited titles were extracted. The XMLRiver run completed or partially completed, but content planning is lower-assurance until a query returns AI sources.

## Next Valid Actions

- Read the full AI title inventory and `data/processed/<topic>_qfo_title_semantics.csv`.
- Cluster titles manually as the agent or send the full title inventory to a clean subagent; group only by user problem and page job.
- Build the hub + child content plan from the approved logical QFO clusters, not from exact-title rows alone.
- If available, provide ChatGPT QFO through `--chatgpt-qfo-file` as auxiliary context, not as a replacement for AI-cited titles.
