# XMLRiver SERP Method

Use this reference whenever the agent plans or runs XMLRiver SERP collection for GEO/AEO, QFO, citation visibility, or final evidence.

## Required Scope

Every XMLRiver run must have an explicit scope before a live paid request:

- search engine: `google`, `yandex`, or both;
- query inventory;
- region/GEO;
- language;
- requested top URL count (`--depth`) and paid page request count;
- whether AI-answer blocks are requested with `ai=1`;
- network and paid-provider approval.

Do not rely on XMLRiver account defaults for region or language. If the user has not approved a region/language, run dry-run planning or ask for the missing scope.

## Search Engines

The runtime supports these XMLRiver endpoints:

| Engine | XMLRiver endpoint | Region parameter | Language parameter |
| --- | --- | --- | --- |
| Google | `https://xmlriver.com/search/xml` | `loc=<Criteria ID from geo.csv>` | `lr=<language code from langs.xlsx>` |
| Yandex | `https://xmlriver.com/search_yandex/xml` | `lr=<numeric Yandex region id>` | `lang=<language code>` |

For AI answer/source extraction, pass `ai=1`.

## Depth And Paid Request Semantics

`--depth` is the requested organic URL count/top-N for each query x engine pair. It is not a pagination page count.

XMLRiver returns 10 organic URLs per SERP page for Google/Yandex (`groupby=10`). To collect more than top-10, the runtime must request additional paginated SERP pages with `page`. Therefore:

- top-10 = 1 paid XMLRiver SERP page request per query x engine;
- top-20 = 2 paid XMLRiver SERP page requests per query x engine;
- top-100 = 10 paid XMLRiver SERP page requests per query x engine.

Paid request count for XMLRiver SERP collection is:

```text
semantic_cluster_query_count * selected_engine_count * ceil(requested_top_urls / 10)
```

Google uses `page=1` for the first SERP page. Yandex uses `page=0` for the first SERP page. The runtime records `requested_top_urls`, `xmlriver_results_per_page`, `xmlriver_serp_pages_per_query_engine`, and `planned_paid_requests` in the plan and collection summary. Never ask for approval as just "depth: 10"; say "top-10 URLs, 1 XMLRiver page request per query x engine".

When `ai=1` is requested, the runtime sends it only on the first SERP page for each query x engine pair; additional pages collect organic URLs only.

## Threads And Parallel Execution

Official XMLRiver collection-method documentation states that a standard account has 10 data-collection threads: `https://xmlriver.com/api/api-alt/`.

The runtime therefore treats 10 as the default and maximum XMLRiver live thread budget:

- `XMLRIVER_MAX_THREADS = 10`;
- approved live XMLRiver collection always builds a paid page-request queue and runs it with `max_workers=10`;
- if fewer than 10 paid page requests are pending, unused slots stay idle, but the configured executor limit remains 10;
- when multiple credential pairs are configured, each search engine gets its own round-robin across credential slots so queue order cannot pin Google and Yandex to different accounts; the ledger records only the non-secret `credential_slot` number;
- top-100 for one query x engine creates 10 paid page requests and can occupy all 10 XMLRiver thread slots;
- the agent must not describe XMLRiver live collection as sequential when approved live collection is used;
- dry-run and live summaries must record `xmlriver_max_threads`, `xmlriver_thread_slots_planned`, and the paid request count.

The thread count is not a pagination count and does not reduce paid request count. Threads only control parallel execution of paid XMLRiver page requests.

## Region And Language Files

The agent must know where to get official XMLRiver reference files and should point the user or operator to them when a region is unclear:

- Google geolocation file: `https://xmlriver.com/files/geo.csv`
- Country file: `https://xmlriver.com/files/countries.xlsx`
- Language file: `https://xmlriver.com/files/langs.xlsx`
- Domain file: `https://xmlriver.com/files/domains.xlsx`

For Google, choose `loc` from `geo.csv`. For example, Moscow city is `1011969`, Russia country is `2643`, and United States country is `2840` in the XMLRiver geolocation file.

For Yandex, `lr` is a numeric Yandex region id, not a language. Common aliases are built into the runtime:

| Alias | Google `loc` | Yandex `lr` | Language default |
| --- | --- | --- | --- |
| `RU` / `Russia` | `2643` | `225` | `ru` |
| `RU-Moscow` / `Moscow` | `1011969` | `213` | `ru` |
| `US` / `USA` | `2840` | `84` | `en` |
| `UK` / `GB` | `2826` | `102` | `en` |
| `FR` | `2250` | `124` | `fr` |

If an alias is not available, use a numeric region id:

- for Google, pass the `geo.csv` Criteria ID as `--region`;
- for Yandex, pass the numeric Yandex region id as `--region`.

## Runtime Request Contract

The deterministic tool is:

```powershell
python .geo-topic-agent-runtime/geo_agent_cli.py collect-serp --provider xmlriver --topic "<topic/cluster>" --cluster-queries "<query 1>; <query 2>" --engines "google,yandex" --region "RU-Moscow" --language "ru" --include-ai --network-approved --paid-approved
```

The runtime writes:

- `geo_agent/data/processed/<topic>_serp_collection_plan.json`
- `geo_agent/reports/SERP_COLLECTION.md`
- `geo_agent/data/raw/serp/<run_id>/<engine-query>.request.json`
- `geo_agent/data/raw/serp/<run_id>/<engine-query>.xml`
- `geo_agent/data/raw/serp/<run_id>/collection_summary.json`
- `geo_agent/data/processed/<topic>_xmlriver_live_serp_rows.csv`
- `geo_agent/data/processed/<topic>_xmlriver_live_ai_answers.csv`

The `*.request.json` file is an append-safe request ledger written with `status=planned` before the network call and finalized as `success` or `error`. It must include non-secret request params, HTTP/content metadata when available, a raw-response SHA-256, and a bounded error summary. Expected examples:

- Google Moscow Russian first-page run: `{"query": "...", "loc": "1011969", "lr": "ru", "groupby": 10, "page": 1, "ai": 1}`
- Yandex Moscow Russian first-page run: `{"query": "...", "lr": "213", "lang": "ru", "groupby": 10, "page": 0, "ai": 1}`

Secrets (`user`, `key`) must not be written to request metadata or reports.

## AI Answer Source Parsing

When `ai=1` is used, the parser must treat XMLRiver AI evidence as a nested evidence source, not as a single `citation_url` field.

Required parser behavior:

- fail fast on XMLRiver `<error>` payloads before writing organic or AI rows;
- preserve the provider response as raw bytes before decoding and keep `raw_ref` for every parsed row; do not run text normalization or replacement over the raw evidence file;
- decode XML losslessly from the HTTP charset/XML declaration with strict UTF-8/Windows-1251 fallback; never use `errors="ignore"`;
- parse Google AI answer HTML from `<ai><answer>` and Yandex AI answer HTML from `<ai><item><content>`; both may be base64-encoded;
- collect citation URLs from XMLRiver AI source nodes such as `<item>`, `<source>`, and `<doc>`;
- also scan the full AI `answer_text` HTML for visible links, Google `/url?...url=...` redirects, URL query parameters, and metadata URLs that point to cited sources;
- normalize and deduplicate extracted URLs;
- filter Google/service assets such as favicon, image, svg, gstatic, w3.org, or internal search URLs;
- record `citation_source` so the operator can see whether a URL came from XMLRiver source items, answer HTML, or an answer-only row;
- mark AI evidence as `expanded`, `sources_only`, or `presence_only` so a provider's presence flag is not presented as complete citation coverage;
- do not process an XMLRiver error body as an AI answer even if it was written into a CSV by an older run;
- reconcile every paid run as `planned_paid_requests = paid_requests_succeeded + paid_requests_failed`; a failed request may retain raw evidence and an error ledger, but contributes zero organic/AI rows.

A readable export may contain `answer_text_clean`, `cited_urls`, and `cited_titles` instead of `answer_text` and `citation_url`. Downstream tools must support those fields and must not silently drop them.

## Browser/HTML AI Capture Fallback

If the agent uses a browser or manually opened HTML instead of direct XMLRiver raw XML, it must capture the expanded AI answer state before extracting or opening citation URLs.

Mandatory sequence:

1. Open the SERP/AI answer page and locate the AI answer block.
2. Expand all AI answer, citation, source, carousel, and "show more" controls first. This includes controls with `aria-expanded="false"`, collapsed source trays, "Show more", "More sources", "Показать ещё", "Ещё", and similar buttons.
3. Wait for the DOM to stabilize after each expansion.
4. Save expanded HTML, rendered text, and screenshot evidence.
5. Extract citation URLs and answer text only from this expanded snapshot.
6. Only after the expanded snapshot is saved may the agent open individual cited URLs.

Never click/open a cited source before the source block is expanded and saved. Opening a citation early can navigate away from the SERP, lose hidden/collapsed source DOM, and produce a false low citation count. If expansion cannot be completed, record `expanded_ai_capture=false`, list the missing expansion controls, and do not claim full AI citation coverage.\n\nThe capture gate is absolute: expand every AI/source/citation block before extraction. Early citation clicks or captures are invalid evidence. The saved expanded snapshot must preserve the full visible expanded content, all visible citations, every extracted URL, and every visible source title. Extraction from a collapsed, partially expanded, or post-navigation state must be rejected or labeled incomplete rather than merged into complete citation evidence.
## Validation Rules

- Do not collapse Google and Yandex into one SERP row set without preserving `engine`.
- Do not collapse regions; keep region/GEO in plan, collection summary, and downstream visibility rows.
- Do not claim live XMLRiver evidence unless raw XML exists, parsed CSV rows reference raw files, and approval scope includes provider, engines, query count, requested top URL count (`--depth`), XMLRiver SERP pages per query/engine, paid request count, region, language, and budget.
- If the region is ambiguous, use dry-run and instruct the user to choose the correct ID from `https://xmlriver.com/files/geo.csv` or provide a numeric Yandex `lr`.

## Topic Cluster Query Source

For GEO topic work, XMLRiver collection must run per semantic cluster query. The topic is a label; it is not a fallback query. Use `--cluster-queries` or a saved project `semantic_cluster_queries` list, choose engines, region, language, requested top URL count (`--depth`, not pagination pages), paid request count, and `ai=1` scope explicitly, and preserve every query x engine request in the collection plan.
