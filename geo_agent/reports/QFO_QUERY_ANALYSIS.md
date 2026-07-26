# QFO_QUERY_ANALYSIS

Generated: 2026-07-26T05:03:04+00:00
Topic: Realism tattoo artist in Manchester and Salford
Status: blocked

## What QFO Means

QFO means Query Fan-Out: follow-up, adjacent, implied, and reformulated searches that can appear around the user's seed queries. In this runtime the semantic source for QFO planning is the AI-cited page title inventory, not mechanically generated title variants.

## Scope And Counts

- Seed queries supplied: 10
- XMLRiver query x engine pairs: 10
- Requested top URLs per pair (`--depth`): 20
- XMLRiver SERP pages per pair: 2
- XMLRiver planned paid page requests: 0
- XMLRiver max live threads: 10
- XMLRiver planned thread slots: 0
- XMLRiver active paid thread slots this run: 0
- Organic SERP rows parsed: 0
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
- title_semantics: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_title_semantics.csv
- theme_clusters: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_theme_clusters.csv
- content_plan: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_content_plan.csv
- theme_selection_template: geo_agent/data/import/realism-tattoo-artist-in-manchester-and-salford_qfo_theme_selection_template.csv
- paid_approval_template: geo_agent/data/import/realism-tattoo-artist-in-manchester-and-salford_qfo_xmlriver_approval_template.json
- approval_ledger: geo_agent/data/quality-gates/external_approval_ledger.json
- evidence_manifest: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_evidence_manifest.json
- summary_json: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_analysis.json

## Errors And Limits

- QFO evidence manifest is not complete.
- QFO evidence manifest records provider-error payloads; partial/error evidence cannot be reused.
- QFO evidence manifest records unresolved paid-request reconciliation errors.
- Paid-request reconciliation: xmlriver_paid_0001: request metadata status is not success: error
- Paid-request reconciliation: xmlriver_paid_0004: request metadata status is not success: error
- Paid-request reconciliation: xmlriver_paid_0009: request metadata status is not success: error
- Paid-request reconciliation: xmlriver_paid_0010: request metadata status is not success: error
- Paid-request reconciliation: xmlriver_paid_0011: request metadata status is not success: error
- Paid-request reconciliation: xmlriver_paid_0012: request metadata status is not success: error
- Paid-request reconciliation: xmlriver_paid_0019: request metadata status is not success: error
- Paid-request reconciliation: xmlriver_paid_0020: request metadata status is not success: error
- Paid-request reconciliation is incomplete; approved reuse is rejected.
- Paid-request reconciliation succeeded count does not match the exact page_plan.
- Paid-request reconciliation contains failed requests.
- Paid-request reconciliation detected provider errors.

## Next Valid Actions

- Read the full AI title inventory and `data/processed/<topic>_qfo_title_semantics.csv`.
- Cluster titles manually as the agent or send the full title inventory to a clean subagent; group only by user problem and page job.
- Build the hub + child content plan from the approved logical QFO clusters, not from exact-title rows alone.
- If available, provide ChatGPT QFO through `--chatgpt-qfo-file` as auxiliary context, not as a replacement for AI-cited titles.
