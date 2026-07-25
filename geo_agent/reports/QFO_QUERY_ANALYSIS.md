# QFO_QUERY_ANALYSIS

Generated: 2026-07-25T18:52:58+00:00
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
- Organic SERP rows parsed: 103
- AI answer/source rows parsed: 20
- AI-cited titles extracted: 19
- Title semantic units: 19
- Template/mask query generation from titles: disabled
- Optional ChatGPT QFO rows: 0
- Exact-title evidence rows for agent clustering: 18
- Content plan candidate rows: 18

## Evidence Basis

- Each AI-cited page title is treated as a semantic unit.
- The runtime only deduplicates exact repeated titles for evidence counting.
- The agent or a clean subagent must read the full title list below before grouping titles into topics and building the final hub + child plan.
- Do not use expanded query variants, n-gram masks, or template permutations as demand evidence.

## Full AI-Cited Title Inventory

| # | Source Query | Domain | Title | URL | Source |
| ---: | --- | --- | --- | --- | --- |
| 1 | tattoo cover up Manchester | reddit.com | Tattoo coverup : r/manchester - Reddit. Opens in new tab. | https://www.reddit.com/r/manchester/comments/1k16vtp/tattoo_coverup/ | provider_citation_title |
| 2 | tattoo cover up Manchester | lastsuppertattoos.co.uk | Cover-Ups - Last Supper Tattoo Studio. Opens in new tab. | https://lastsuppertattoos.co.uk/cover-ups/ | provider_citation_title |
| 3 | tattoo cover up Manchester | instagram.com | Cover-up Tattoo - Instagram. Opens in new tab. | https://www.instagram.com/p/DTIlaXTCntE/ | provider_citation_title |
| 4 | tattoo cover up Manchester | instagram.com | Vladimir Vishar \| Realism Tattoo (@vladimir_vishar) - Instagram. Opens in new tab. | https://www.instagram.com/vladimir_vishar/ | provider_citation_title |
| 5 | tattoo cover up Manchester | tattoodo.com | Cover Up Artists • Tattoodo. Opens in new tab. | https://www.tattoodo.com/tattoo-artists/manchester/artists/cover-up-32 | provider_citation_title |
| 6 | tattoo cover up Manchester | noregrets.tattoo | Manchester Tattoo Studio \| Realism, Fine Line &, More \| No Regrets UK. Opens in new tab. | https://noregrets.tattoo/uk/manchester-tattoo-2/ | provider_citation_title |
| 7 | tattoo cover up Manchester | keepthefaithtattoo.co.uk | Sharron Caudill - Keep The Faith Tattoo. Opens in new tab. | https://keepthefaithtattoo.co.uk/sharron/ | provider_citation_title |
| 8 | tattoo cover up Manchester | northofwinter.co.uk | North of Winter Tattoo Studio \| Manchester. Opens in new tab. | https://www.northofwinter.co.uk/ | provider_citation_title |
| 9 | tattoo cover up Manchester | lbltattoo.co.uk | Tattoo cover up specialists \| London Blue Lady tattoo. Opens in a new tab. | https://www.lbltattoo.co.uk/tattoo-cover-up | provider_citation_title |
| 10 | tattoo cover up Manchester | policies.google.com | Privacy Policy – Privacy & Terms – Google | https://policies.google.com/privacy?hl=en-RU | html_title |
| 11 | tattoo cover up Manchester | noregrets.tattoo | Home - No Regrets | https://noregrets.tattoo | html_title |
| 12 | tattoo cover up Manchester | keepthefaithtattoo.co.uk | Keep The Faith Tattoo – Quality tattooing in the heart of Liverpool | https://keepthefaithtattoo.co.uk | html_title |
| 13 | tattoo cover up Manchester | tattoodo.com | Book tattoo artists in Ashburn • Tattoodo | https://www.tattoodo.com | html_title |
| 14 | tattoo cover up Manchester | reddit.com | Reddit - Please wait for verification | https://www.reddit.com | html_title |
| 15 | tattoo cover up Manchester | instagram.com | Instagram | https://www.instagram.com | html_title |
| 16 | tattoo cover up Manchester | lastsuppertattoos.co.uk | Last Supper Tattoo Studio \| Award-Winning Tattooists ... | https://lastsuppertattoos.co.uk | organic_url_match |
| 17 | tattoo cover up Manchester | northofwinter.co.uk | North of Winter Tattoo Studio \| Manchester. Opens in new tab. | https://www.northofwinter.co.uk | provider_citation_title |
| 18 | tattoo cover up Manchester | lbltattoo.co.uk | Specialising in Tattoo Cover Ups & Piercing | https://www.lbltattoo.co.uk | html_title |
| 19 | tattoo cover up Manchester | google.com | Google | https://www.google.com | html_title |

## Exact-Title Evidence Rows For Agent Clustering

| Row | Title | AI Title Observations | Source Queries | Citation Domains | Status | Guard |
| --- | --- | ---: | --- | --- | --- | --- |
| qfo_theme_001 | Book tattoo artists in Ashburn • Tattoodo | 1 | tattoo cover up Manchester | tattoodo.com | pending_agent_review | Do not create a page from an exact title row alone. Merge titles that solve the same user task; split only when the page job is materially different. |
| qfo_theme_002 | Cover Up Artists • Tattoodo. Opens in new tab. | 1 | tattoo cover up Manchester | tattoodo.com | pending_agent_review | Do not create a page from an exact title row alone. Merge titles that solve the same user task; split only when the page job is materially different. |
| qfo_theme_003 | Cover-up Tattoo - Instagram. Opens in new tab. | 1 | tattoo cover up Manchester | instagram.com | pending_agent_review | Do not create a page from an exact title row alone. Merge titles that solve the same user task; split only when the page job is materially different. |
| qfo_theme_004 | Cover-Ups - Last Supper Tattoo Studio. Opens in new tab. | 1 | tattoo cover up Manchester | lastsuppertattoos.co.uk | pending_agent_review | Do not create a page from an exact title row alone. Merge titles that solve the same user task; split only when the page job is materially different. |
| qfo_theme_005 | Google | 1 | tattoo cover up Manchester | google.com | pending_agent_review | Do not create a page from an exact title row alone. Merge titles that solve the same user task; split only when the page job is materially different. |
| qfo_theme_006 | Home - No Regrets | 1 | tattoo cover up Manchester | noregrets.tattoo | pending_agent_review | Do not create a page from an exact title row alone. Merge titles that solve the same user task; split only when the page job is materially different. |
| qfo_theme_007 | Instagram | 1 | tattoo cover up Manchester | instagram.com | pending_agent_review | Do not create a page from an exact title row alone. Merge titles that solve the same user task; split only when the page job is materially different. |
| qfo_theme_008 | Keep The Faith Tattoo – Quality tattooing in the heart of Liverpool | 1 | tattoo cover up Manchester | keepthefaithtattoo.co.uk | pending_agent_review | Do not create a page from an exact title row alone. Merge titles that solve the same user task; split only when the page job is materially different. |
| qfo_theme_009 | Last Supper Tattoo Studio \| Award-Winning Tattooists ... | 1 | tattoo cover up Manchester | lastsuppertattoos.co.uk | pending_agent_review | Do not create a page from an exact title row alone. Merge titles that solve the same user task; split only when the page job is materially different. |
| qfo_theme_010 | Manchester Tattoo Studio \| Realism, Fine Line &, More \| No Regrets UK. Opens in new tab. | 1 | tattoo cover up Manchester | noregrets.tattoo | pending_agent_review | Do not create a page from an exact title row alone. Merge titles that solve the same user task; split only when the page job is materially different. |
| qfo_theme_011 | North of Winter Tattoo Studio \| Manchester. Opens in new tab. | 2 | tattoo cover up Manchester | northofwinter.co.uk | pending_agent_review | Do not create a page from an exact title row alone. Merge titles that solve the same user task; split only when the page job is materially different. |
| qfo_theme_012 | Privacy Policy – Privacy & Terms – Google | 1 | tattoo cover up Manchester | policies.google.com | pending_agent_review | Do not create a page from an exact title row alone. Merge titles that solve the same user task; split only when the page job is materially different. |
| qfo_theme_013 | Reddit - Please wait for verification | 1 | tattoo cover up Manchester | reddit.com | pending_agent_review | Do not create a page from an exact title row alone. Merge titles that solve the same user task; split only when the page job is materially different. |
| qfo_theme_014 | Sharron Caudill - Keep The Faith Tattoo. Opens in new tab. | 1 | tattoo cover up Manchester | keepthefaithtattoo.co.uk | pending_agent_review | Do not create a page from an exact title row alone. Merge titles that solve the same user task; split only when the page job is materially different. |
| qfo_theme_015 | Specialising in Tattoo Cover Ups & Piercing | 1 | tattoo cover up Manchester | lbltattoo.co.uk | pending_agent_review | Do not create a page from an exact title row alone. Merge titles that solve the same user task; split only when the page job is materially different. |
| qfo_theme_016 | Tattoo cover up specialists \| London Blue Lady tattoo. Opens in a new tab. | 1 | tattoo cover up Manchester | lbltattoo.co.uk | pending_agent_review | Do not create a page from an exact title row alone. Merge titles that solve the same user task; split only when the page job is materially different. |
| qfo_theme_017 | Tattoo coverup : r/manchester - Reddit. Opens in new tab. | 1 | tattoo cover up Manchester | reddit.com | pending_agent_review | Do not create a page from an exact title row alone. Merge titles that solve the same user task; split only when the page job is materially different. |
| qfo_theme_018 | Vladimir Vishar \| Realism Tattoo (@vladimir_vishar) - Instagram. Opens in new tab. | 1 | tattoo cover up Manchester | instagram.com | pending_agent_review | Do not create a page from an exact title row alone. Merge titles that solve the same user task; split only when the page job is materially different. |

## Content Plan Candidate Rows

These rows are not a finished content plan. They are a workpack for agent/subagent logical clustering from the full title inventory.

| Page | Type | Agent Task | Candidate Title | Included AI Titles | Status |
| --- | --- | --- | --- | --- | --- |
| qfo_page_001 | agent_cluster_candidate | agent_to_define_from_full_title_list | Book tattoo artists in Ashburn • Tattoodo | Book tattoo artists in Ashburn • Tattoodo | pending_agent_logical_plan |
| qfo_page_002 | agent_cluster_candidate | agent_to_define_from_full_title_list | Cover Up Artists • Tattoodo. Opens in new tab. | Cover Up Artists • Tattoodo. Opens in new tab. | pending_agent_logical_plan |
| qfo_page_003 | agent_cluster_candidate | agent_to_define_from_full_title_list | Cover-up Tattoo - Instagram. Opens in new tab. | Cover-up Tattoo - Instagram. Opens in new tab. | pending_agent_logical_plan |
| qfo_page_004 | agent_cluster_candidate | agent_to_define_from_full_title_list | Cover-Ups - Last Supper Tattoo Studio. Opens in new tab. | Cover-Ups - Last Supper Tattoo Studio. Opens in new tab. | pending_agent_logical_plan |
| qfo_page_005 | agent_cluster_candidate | agent_to_define_from_full_title_list | Google | Google | pending_agent_logical_plan |
| qfo_page_006 | agent_cluster_candidate | agent_to_define_from_full_title_list | Home - No Regrets | Home - No Regrets | pending_agent_logical_plan |
| qfo_page_007 | agent_cluster_candidate | agent_to_define_from_full_title_list | Instagram | Instagram | pending_agent_logical_plan |
| qfo_page_008 | agent_cluster_candidate | agent_to_define_from_full_title_list | Keep The Faith Tattoo – Quality tattooing in the heart of Liverpool | Keep The Faith Tattoo – Quality tattooing in the heart of Liverpool | pending_agent_logical_plan |
| qfo_page_009 | agent_cluster_candidate | agent_to_define_from_full_title_list | Last Supper Tattoo Studio \| Award-Winning Tattooists ... | Last Supper Tattoo Studio \| Award-Winning Tattooists ... | pending_agent_logical_plan |
| qfo_page_010 | agent_cluster_candidate | agent_to_define_from_full_title_list | Manchester Tattoo Studio \| Realism, Fine Line &, More \| No Regrets UK. Opens in new tab. | Manchester Tattoo Studio \| Realism, Fine Line &, More \| No Regrets UK. Opens in new tab. | pending_agent_logical_plan |
| qfo_page_011 | agent_cluster_candidate | agent_to_define_from_full_title_list | North of Winter Tattoo Studio \| Manchester. Opens in new tab. | North of Winter Tattoo Studio \| Manchester. Opens in new tab. | pending_agent_logical_plan |
| qfo_page_012 | agent_cluster_candidate | agent_to_define_from_full_title_list | Privacy Policy – Privacy & Terms – Google | Privacy Policy – Privacy & Terms – Google | pending_agent_logical_plan |
| qfo_page_013 | agent_cluster_candidate | agent_to_define_from_full_title_list | Reddit - Please wait for verification | Reddit - Please wait for verification | pending_agent_logical_plan |
| qfo_page_014 | agent_cluster_candidate | agent_to_define_from_full_title_list | Sharron Caudill - Keep The Faith Tattoo. Opens in new tab. | Sharron Caudill - Keep The Faith Tattoo. Opens in new tab. | pending_agent_logical_plan |
| qfo_page_015 | agent_cluster_candidate | agent_to_define_from_full_title_list | Specialising in Tattoo Cover Ups & Piercing | Specialising in Tattoo Cover Ups & Piercing | pending_agent_logical_plan |
| qfo_page_016 | agent_cluster_candidate | agent_to_define_from_full_title_list | Tattoo cover up specialists \| London Blue Lady tattoo. Opens in a new tab. | Tattoo cover up specialists \| London Blue Lady tattoo. Opens in a new tab. | pending_agent_logical_plan |
| qfo_page_017 | agent_cluster_candidate | agent_to_define_from_full_title_list | Tattoo coverup : r/manchester - Reddit. Opens in new tab. | Tattoo coverup : r/manchester - Reddit. Opens in new tab. | pending_agent_logical_plan |
| qfo_page_018 | agent_cluster_candidate | agent_to_define_from_full_title_list | Vladimir Vishar \| Realism Tattoo (@vladimir_vishar) - Instagram. Opens in new tab. | Vladimir Vishar \| Realism Tattoo (@vladimir_vishar) - Instagram. Opens in new tab. | pending_agent_logical_plan |

## Artifacts

- seed_queries: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_seed_queries.csv
- chatgpt_queries: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_chatgpt_queries.csv
- xmlriver_serp_rows: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_xmlriver_serp_rows.csv
- xmlriver_ai_answers: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_xmlriver_ai_answers.csv
- citation_title_enrichment_ledger: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_title_enrichment.csv
- citation_title_raw_pages: geo_agent/data/raw/serp/qfo_xmlriver_9ba96e37e60d/citation-title-pages
- ai_titles: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_ai_titles.csv
- title_semantics: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_title_semantics.csv
- theme_clusters: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_theme_clusters.csv
- content_plan: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_content_plan.csv
- theme_selection_template: geo_agent/data/import/realism-tattoo-artist-in-manchester-and-salford_qfo_theme_selection_template.csv
- paid_approval_template: geo_agent/data/import/realism-tattoo-artist-in-manchester-and-salford_qfo_xmlriver_approval_template.json
- approval_ledger: geo_agent/data/quality-gates/external_approval_ledger.json
- evidence_manifest: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_evidence_manifest.json
- raw_summary: geo_agent/data/raw/serp/qfo_xmlriver_9ba96e37e60d/qfo_collection_summary.json
- summary_json: geo_agent/data/processed/realism-tattoo-artist-in-manchester-and-salford_qfo_analysis.json

## Errors And Limits

- google / custom tattoo artist Manchester / page=2: RuntimeError: XMLRiver error 500: Выполните перезапрос. Ответ от поисковой системы не получен.
- google / custom tattoo artist Manchester / page=1: RuntimeError: XMLRiver error 500: Выполните перезапрос. Ответ от поисковой системы не получен.
- google / realism tattoo artist Manchester / page=1: RuntimeError: XMLRiver error 500: Выполните перезапрос. Ответ от поисковой системы не получен.
- google / realism tattoo artist Salford / page=1: RuntimeError: XMLRiver error 500: Выполните перезапрос. Ответ от поисковой системы не получен.
- google / realism tattoo artist Salford / page=2: RuntimeError: XMLRiver error 500: Выполните перезапрос. Ответ от поисковой системы не получен.
- google / Vladimir Vishar tattoo artist / page=1: RuntimeError: XMLRiver error 500: Выполните перезапрос. Ответ от поисковой системы не получен.
- google / Vladimir Vishar tattoo artist / page=2: RuntimeError: XMLRiver error 500: Выполните перезапрос. Ответ от поисковой системы не получен.
- google / black and grey realism tattoo Manchester / page=2: RuntimeError: XMLRiver error 500: Выполните перезапрос. Ответ от поисковой системы не получен.
- Citation title quality gap: 1 citation URL(s) remain without a real title; no URL slug fallback was used.
- QFO title evidence is ready, but the content plan is not externally approved. The agent must logically cluster the full title inventory, obtain user approval in the external ledger, and rerun with --approved-content-plan-file and --content-plan-approval-ref.

## Next Valid Actions

- Read the full AI title inventory and `data/processed/<topic>_qfo_title_semantics.csv`.
- Cluster titles manually as the agent or send the full title inventory to a clean subagent; group only by user problem and page job.
- Build the hub + child content plan from the approved logical QFO clusters, not from exact-title rows alone.
- If available, provide ChatGPT QFO through `--chatgpt-qfo-file` as auxiliary context, not as a replacement for AI-cited titles.
