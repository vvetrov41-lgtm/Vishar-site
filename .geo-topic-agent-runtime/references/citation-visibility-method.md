# Citation Visibility Method

This module is a minimal rank-tracking service for GEO/AEO visibility. It measures the latest state and preserves full measurement history for trend analysis.

## Measurement Unit

The atomic row is:

`query x search_engine x region`

Do not collapse Google and Yandex. Do not collapse Moscow and United States. A query can pass in one engine/region and fail in another.

## Inputs

- Target domain.
- Confirmed brand variants: brand spellings, domain spellings, product names, and product/service aliases.
- Query list from the user, QFO artifacts, or manual CSV.
- SERP rows from live provider output or manual import.
- AI-answer rows from live provider output or manual import.
- Engines such as `google`, `yandex`.
- Regions such as `RU-Moscow`, `RU`, `US`, `UK`.

## Required Checks

For every query/engine/region row:

1. Organic SERP position: first organic result URL whose domain matches the user site.
2. AI answer presence: whether the provider returned an AI answer for the query.
3. Full AI citation URL inventory: every parsed cited URL/source URL from `citation_url`, `cited_urls`, `citation_urls`, and answer HTML.
4. User URL cited in AI: whether an AI citation URL matches the user domain or `project_url_cited` is true.
5. Brand/product mention: whether the AI answer body contains one of the confirmed brand/product variants. Do not count citation title matches as answer-body brand mentions.
6. Evidence refs: raw/imported source references for auditability.

## Live Collection

Use live collection only when the user explicitly approves network and paid provider usage. The command then calls the existing approved SERP collector and snapshots the results into the visibility run folder.

Without approval, use existing local artifacts or manual CSVs. Do not claim live collection.

## History Contract

The latest report may be overwritten:

- `reports/CITATION_VISIBILITY.md`
- `reports/CITATION_SOURCE_INVENTORY.md`
- `data/processed/<topic>_citation_visibility_latest.csv`
- `data/processed/<topic>_citation_source_inventory_latest.csv`
- `data/processed/<topic>_citation_visibility_latest.json`

History must not be overwritten:

- `data/visibility-runs/<run_id>/`
- `data/history/citation_visibility_rows.csv`
- `data/history/citation_source_inventory_rows.csv`
- `data/history/citation_visibility_runs.jsonl`

These history files are the source of truth for dynamics across repeated measurements.

## Manual SERP CSV Columns

Minimum:

```csv
query,engine,region,position,url,title,snippet,raw_ref
```

`region` is optional only for a single-region run. If multiple regions are being compared, include it.

## Manual AI CSV Columns

Minimum:

```csv
prompt,engine,region,provider,model,answer_text,citation_url,citation_title,brand_mentioned,project_url_cited,raw_ref
```

The tool can infer engine from model/provider for existing runtime artifacts, but explicit `engine` and `region` are safer for comparisons.

## AI Citation And Brand Parsing Rules

Do not trust stale boolean columns such as `brand_mentioned` as the source of truth. Recalculate visibility from the evidence text for every run.

The parser must:

- read AI answer body from `answer_text`, `answer_text_clean`, or `answer`;
- read citation URLs from `citation_url`, `cited_urls`, `citation_urls`, and links embedded in AI answer HTML;
- read citation titles from `citation_title` and `cited_titles`, but do not count title-only matches as answer-body brand mentions;
- repair common UTF-8/Windows mojibake before matching brand variants;
- HTML-unescape and strip tags before matching;
- match confirmed brand/product variants in both normal and compact forms, so spacing, case, punctuation, and mojibake do not hide real mentions;
- skip XMLRiver error payload rows unless they contain separately extractable real citation URLs.
## Citation Source Inventory

Every run must create a URL-level source inventory in addition to the summary report:

- `data/visibility-runs/<run_id>/citation_source_inventory.csv`
- `data/visibility-runs/<run_id>/CITATION_SOURCE_INVENTORY.md`
- `reports/CITATION_SOURCE_INVENTORY.md`
- `data/processed/<topic>_citation_source_inventory_latest.csv`

The source inventory must show one row per cited URL, plus rows for query/engine/region checks with no parsed citation URLs. Required columns: query, engine, region, organic position, cited URL, cited domain, user-site citation flag, answer-body brand/product mention flag, mentioned terms, answer preview, and source refs. This is the primary artifact for debugging lost AI citation sources.

## Report Interpretation

- `AI answer present` means the query produced an AI answer.
- `Site URL cited` means the user domain appears in AI citations.
- `Brand/product mentioned` means the AI answer body contains a confirmed brand/product variant. Citation-title-only matches do not pass this layer.
- Organic visibility is not the same as AI visibility.
- Final monitoring has two independent layers: `url_citation` for cited user URL/domain and `brand_mention` for answer-body brand/product mention. One can pass while the other fails.
