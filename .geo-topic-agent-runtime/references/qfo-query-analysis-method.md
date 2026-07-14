# QFO Query Analysis Method

QFO means Query Fan-Out. In this runtime it is the evidence-backed expansion of a user's seed query batch into likely follow-up, adjacent, implied, and reformulated searches that AI/search systems may use around a topic.

The QFO analysis exists to answer four practical questions:

1. What did the user explicitly ask us to investigate?
2. Which of those queries returned AI-answer blocks in live XMLRiver SERP data?
3. Which real cited page titles can be proven from provider, exact same-run organic, or approved public HTML evidence, and what user problems/page jobs do they imply?
4. Which content pages should be created as hubs or child pages after agent/subagent logical clustering, without cannibalizing each other?

## Fast And Live Scope Gate

A cluster-only fast request may proceed to local planning with saved project context. A live paid run requires explicit engines, region/city, language, top-N URL depth, exact query inventory, calculated paid request count, and approval bound to that scope. If saved values are absent or ambiguous, ask the user. Do not use provider/account defaults.

## Live Evidence Rule

For production QFO analysis, XMLRiver must be called with `ai=1` for every user-provided seed query and selected engine. By default, `qfo-analyze` uses both `google,yandex`; if a narrower run is needed, the user must explicitly pass `--engines`. Before any live request, read `references/xmlriver-serp-method.md` and set explicit search engine, region, language, requested top URL count (`--depth`, not pagination pages), paid-request scope, and XMLRiver max thread scope (`XMLRIVER_MAX_THREADS=10`). The first live provider run is blocked unless both gates are present:

```powershell
python .geo-topic-agent-runtime/geo_agent_cli.py qfo-analyze --queries "<query batch>" --engines "google,yandex" --depth <top-url-count> --network-approved --paid-approved
```

The runtime saves raw XML and parsed CSV/JSON artifacts. If an AI answer block is absent for a query, the query is still recorded; absence is evidence, not a reason to invent AI rows.

Public HTTP(S) page reads used only to enrich missing citation titles require network approval but are not XMLRiver calls and are not paid-provider requests. Do not add them to `planned_paid_requests` or require `--paid-approved` for them.

## Citation Title Enrichment

Resolve titles in this strict precedence order for every cited URL:

1. explicit XMLRiver/provider title associated with that citation;
2. title from an exact cited-URL match to an organic result in the same run;
3. when network-approved, a public HTTP fetch of that URL and the real decoded HTML `<title>`;
4. `og:title` from the same fetched HTML only when `<title>` is absent or empty.

Stop at the first valid title. An explicit provider title means a provider title field or title element, not arbitrary anchor text. Never derive or synthesize a title from a URL slug, domain, hostname, path, anchor label, source label, breadcrumb, snippet, or guessed page topic. Domain-only and near-URL matches are not exact same-run organic URL matches.

For unresolved URLs eligible for public fetching:

- fetch only after explicit network approval;
- fetch public HTTP(S) pages only;
- deduplicate by cited URL and fetch each unique URL at most once per enrichment run;
- use a bounded queue with at most 10 concurrent requests;
- apply the bounded command timeout to every request and redirect chain;
- record the final URL, HTTP status, and response content type;
- preserve exact raw response bytes before decoding or parsing;
- decode losslessly and record the selected charset/method; never silently replace undecodable bytes;
- if the response is not usable HTML, decoding is not lossless, or neither `<title>` nor `og:title` is present, keep the URL unresolved with its raw reference and error.

Redirects do not authorize a private/non-public target. A fetch failure or unusable response must not fall through to slug, domain, or anchor-derived text.

## Title Enrichment Ledger

Write `data/processed/<topic>_qfo_title_enrichment.csv` as the complete URL-level title-enrichment ledger. It contains exactly one row for every unique cited URL, including URLs already resolved from provider or same-run organic evidence and URLs that were not fetched, failed, or remain unresolved.

Required columns:

- `url`;
- `status`;
- `http_status`;
- `final_url`;
- `content_type`;
- `decoded_with`;
- `title`;
- `title_source`;
- `raw_ref`;
- `error`.

Use auditable `title_source` values such as `provider_title`, `same_run_organic_url_title`, `html_title`, and `og_title`; leave `title_source` empty for unresolved rows. Use visible statuses such as `resolved`, `skipped_no_network_approval`, `fetch_error`, and `unresolved`. Fields that do not apply remain empty, but every required column and every unique cited URL remain present. `raw_ref` points to the provider XML evidence for provider/organic resolution or to the preserved raw page bytes for an HTTP resolution/failure.

## Reuse Existing Evidence

`--reuse-existing-evidence` reuses saved provider/SERP/AI evidence and must always record `planned_paid_requests=0`. When the same command also has `--network-approved`, it may perform approved public HTTP title enrichment for still-unresolved cited URLs. Those public page reads are counted separately from paid requests. Without network approval, create `skipped_no_network_approval` ledger rows instead of fetching or inventing titles.

An approved public title-enrichment fetch during reuse does not weaken the zero-paid-request guarantee:

```powershell
python .geo-topic-agent-runtime/geo_agent_cli.py qfo-analyze --topic "<topic>" --queries-file cluster.txt --approved-content-plan-file approved_qfo_plan.json --reuse-existing-evidence --network-approved
```

## Title Semantics Inventory

Each proven AI-cited page title is already the semantic evidence unit. The runtime must not expand titles into additional search queries with templates, masks, n-grams, or intent permutations.

The title inventory is the source material for agent reasoning. Preserve the full list of titles, source queries, cited URLs, domains, title source, and raw references so the content planner can understand what pages are actually visible in AI answers. Preserve unresolved cited URLs in the enrichment ledger and report; they are not title semantic units and must not be silently dropped from the evidence audit.

## Title Enrichment Audit And Quality

`reports/QFO_QUERY_ANALYSIS.md`, `data/processed/<topic>_qfo_analysis.json`, and the structured command observation must expose title-enrichment stats and evidence references. At minimum record:

- unique cited URL count;
- provider-title and exact same-run organic-title counts;
- unique public fetch candidate, attempted, and successful counts;
- HTML `<title>` and `og:title` resolution counts;
- no-network skips, fetch/decoding errors, and unresolved title URL counts;
- title-enrichment ledger reference and raw page evidence references;
- public title-fetch concurrency/timeout scope;
- `planned_paid_requests` separately from public title-fetch counts.

Any unresolved cited title URL remains visible in the report and structured artifacts and creates a lower-assurance title-enrichment quality gap. It must not be assigned an invented title or reported as fully enriched. This quality gap can coexist with an otherwise approved content plan, but the final assurance claim must stay qualified.

## Clustering And Cannibalization

Clustering is logical and conservative. The deterministic runtime only prepares the full title inventory and exact-title evidence counts. The agent or a clean subagent must read the entire title list and group titles by user problem, buying stage, page job, and cannibalization risk. A hub is proposed when the logical cluster is broad and recurring. A child page is proposed only when the page job is materially distinct enough to deserve its own URL.

Cannibalization guard:

- do not split pages only by word order or synonym;
- keep one hub for broad informational coverage;
- create child pages for separate jobs such as price, comparison, implementation, reviews, or a specific audience;
- mark weak themes as merge candidates until the user approves them.

## ChatGPT QFO Layer

After XMLRiver evidence is processed, the agent asks the user to provide a ChatGPT QFO export. This is optional. If the user skips it, the report must say that the ChatGPT layer is pending/skipped and continue with XMLRiver evidence.

## Content Plan Approval Gate

The deterministic pass ends with a complete title semantics workpack and `quality_fail`; it is not allowed to declare a content plan complete. The agent or a clean subagent must read the full title inventory, reason about page jobs, and prepare a typed CSV/JSON plan.

Every approved page row requires:

- `page_id`;
- `cluster_name`;
- `page_type`: `hub`, `child`, or `standalone`;
- `intent`;
- `target_title`;
- `included_title_ids`;
- `cannibalization_guard`;
- `approval_status=approved`;
- non-empty `approved_by` naming the approving user/operator.

Every title ID must be assigned exactly once or explicitly excluded with `exclusion_reason`. Unknown IDs, duplicate assignments, uncovered IDs, empty approval identity, and pending status block completion.

After approval, validate against the already collected evidence without paying twice:

```powershell
python .geo-topic-agent-runtime/geo_agent_cli.py qfo-analyze --topic "<topic>" --queries-file cluster.txt --approved-content-plan-file approved_qfo_plan.json --reuse-existing-evidence
```

The reuse run records `planned_paid_requests=0`, including when separately counted network-approved public title fetches occur. Only this approved, full-disposition plan can return `success` and become authoritative for page TZ generation. Any unresolved title URLs remain an explicit lower-assurance quality gap in that success result.
