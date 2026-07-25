# SERP_COLLECTION

Generated: 2026-07-25T18:20:10+00:00
Topic: Realism tattoo artist in Manchester and Salford
Provider: xmlriver

## Scope

- query x engine pairs: 10
- requested top URLs per query/engine (`--depth`): 20
- planned paid provider requests: 20
- paid requests succeeded: not run
- paid requests failed: not run
- XMLRiver SERP pages per query/engine: 2
- XMLRiver max live threads: 10
- XMLRiver planned/used thread slots: 10
- region: gb
- language: en
- SERP rows collected: 0
- AI answer/citation rows collected: 0

## Request Plan

| Engine | Query | Source |
| --- | --- | --- |
| google | realism tattoo artist Manchester | semantic_cluster_query |
| google | black and grey realism tattoo Manchester | semantic_cluster_query |
| google | colour realism tattoo Manchester | semantic_cluster_query |
| google | tattoo cover up Manchester | semantic_cluster_query |
| google | custom tattoo artist Manchester | semantic_cluster_query |
| google | realism tattoo artist Salford | semantic_cluster_query |
| google | tattoo artist Salford | semantic_cluster_query |
| google | tattoo consultation Manchester | semantic_cluster_query |
| google | portrait tattoo artist Manchester | semantic_cluster_query |
| google | Vladimir Vishar tattoo artist | semantic_cluster_query |

## XMLRiver Region And Language

- Google endpoint: `search/xml`; request must include `query`, numeric `loc` from `geo.csv`, and `lr` language code from `langs.xlsx`.
- Yandex endpoint: `search_yandex/xml`; request must include `query`, numeric Yandex `lr` region id, and `lang` language code.
- Region file: https://xmlriver.com/files/geo.csv
- Language file: https://xmlriver.com/files/langs.xlsx
- Country file: https://xmlriver.com/files/countries.xlsx
- Domain file: https://xmlriver.com/files/domains.xlsx
- Do not rely on XMLRiver account defaults for GEO/language; pass the run scope explicitly.
- `--depth` means requested organic URL count/top-N, not number of pagination pages.
- XMLRiver returns 10 organic URLs per SERP page; top-100 means 10 paid page requests per query x engine.
- Google `page` starts at 1; Yandex `page` starts at 0.
- `groupby` is fixed at 10 for Google/Yandex SERP collection in current XMLRiver docs; do not treat it as a way to fetch top-100 in one paid request.
- Approved live XMLRiver collection uses the maximum 10 standard-account threads for the paid page-request queue.

## Errors / Limits

- Live collection not run: dry run.
