---
name: qfo-query-analysis
description: Collect every user query through approved XMLRiver Google/Yandex SERP+AI, enrich missing citation titles from exact same-run or approved public HTML evidence, prepare a full title inventory for logical agent clustering, require user approval, and persist a cannibalization-safe authoritative content plan.
---

# QFO Query Analysis

QFO is Query Fan-Out: follow-up and adjacent information needs around the user's confirmed query cluster. This skill does not mechanically generate queries. It observes which titles AI answers cite and lets the agent reason over the complete title evidence.

## Inputs

- topic/cluster label;
- every user-supplied semantic query;
- explicit Google/Yandex, region, language, top-N URL depth, AI scope, paid request count, and ten-thread plan;
- network and paid approval for the first live XMLRiver run;
- network approval, but no paid-provider approval, for optional public HTTP title enrichment, including during `--reuse-existing-evidence`;
- optional user-provided ChatGPT QFO;
- later, an agent-clustered and user-approved content-plan CSV/JSON.

Unknown regions block before network. A numeric dual-engine region must use `google=<loc>;yandex=<lr>`. `--depth` is URL count, not pagination count.

In fast cluster mode, the cluster alone is sufficient only for local planning. Before live paid execution, read an explicit saved scope or ask for engines, region/city, language, and top-N URL depth. Present the exact query inventory and calculated paid request scope, then obtain approval bound to those values. Never silently apply Moscow, Russian, Google/Yandex, depth 10, or provider defaults.
Use `references/xmlriver-serp-method.md`; Google location IDs come from https://xmlriver.com/files/geo.csv and language values from https://xmlriver.com/files/langs.xlsx.

## Evidence Run

1. Inventory every supplied query.
2. Collect every query x selected engine with `ai=1`; preserve raw bytes, hashes, request ledgers, account slot, region/language parameters, and success/error state.
3. Exclude XMLRiver error bodies from all processed rows.
4. Parse Google `<answer>`, Yandex `<content>`, source nodes, answer HTML links, and expanded citation blocks. For browser/manual fallback, expand all AI/source/citation blocks before opening any cited URL. Early citation clicks or captures are invalid. Save the full visible expanded content, citations, URLs, and titles before extraction.
5. Resolve each cited URL title in this strict order: explicit XMLRiver/provider title; title from an exact cited-URL match in organic rows from the same run; then, only with network approval, a public HTTP fetch of the real HTML `<title>`, falling back to `og:title` when `<title>` is absent or empty.
6. Never derive a title from a URL slug, domain, path, hostname, or anchor/source label. A generic link label is not a provider title.
7. Deduplicate public fetch candidates by URL, fetch each unique URL at most once with no more than 10 concurrent requests and a bounded timeout, preserve raw response bytes before parsing, and use a recorded lossless decode. If the bytes cannot be decoded without replacement, leave the title unresolved and retain the raw reference and error.
8. Write the complete `data/processed/<topic>_qfo_title_enrichment.csv` ledger with one row per unique cited URL and the required fields `url`, `status`, `http_status`, `final_url`, `content_type`, `decoded_with`, `title`, `title_source`, `raw_ref`, and `error`. Include rows resolved without HTTP and rows skipped, failed, or unresolved.
9. Save the complete title inventory and title semantics inventory. Do not create n-gram/mask/template query variants.
10. Ask for ChatGPT QFO as optional auxiliary evidence.

Public page title fetches are public evidence reads, not paid XMLRiver requests. A `--reuse-existing-evidence --network-approved` run may fetch unresolved public titles while recording `planned_paid_requests=0`. Without network approval, skip public fetches and keep the unresolved rows visible. The evidence run remains `quality_fail`; title extraction is not an approved content plan.

## Logical Plan And Approval

The agent or one clean subagent must read every title row and cluster by user problem/page job. It must:

- produce hub/child/standalone pages;
- assign every title ID to exactly one page or explicitly exclude it with a reason;
- prevent the same title from appearing on multiple pages;
- define intent, target title, included queries/titles, internal-link role, and cannibalization guard;
- show the plan to the user and record `approval_status=approved` plus `approved_by`.

Validate locally:

```powershell
python .geo-topic-agent-runtime/geo_agent_cli.py qfo-analyze --topic "<topic>" --queries-file cluster.txt --approved-content-plan-file approved_qfo_plan.json --reuse-existing-evidence
```

Add `--network-approved` only when unresolved public titles should be fetched during reuse. The reuse run makes zero paid XMLRiver requests even when approved public title fetches occur. Only a full, non-overlapping title disposition with user approval can return `success`. Unresolved cited URLs remain a visible lower-assurance quality gap and must never receive an invented title. The resulting `<topic>_qfo_content_plan.csv` is authoritative. Generic `CONTENT_PLAN.md` output cannot override it.

## Outputs

- `reports/QFO_QUERY_ANALYSIS.md`
- `reports/QFO_CHATGPT_REQUEST.md`
- `data/processed/<topic>_qfo_seed_queries.csv`
- `data/processed/<topic>_qfo_xmlriver_serp_rows.csv`
- `data/processed/<topic>_qfo_xmlriver_ai_answers.csv`
- `data/processed/<topic>_qfo_title_enrichment.csv`
- `data/processed/<topic>_qfo_ai_titles.csv`
- `data/processed/<topic>_qfo_title_semantics.csv`
- `data/processed/<topic>_qfo_content_plan.csv`
- `data/processed/<topic>_qfo_analysis.json`

`QFO_QUERY_ANALYSIS.md`, the structured observation, and `<topic>_qfo_analysis.json` must include title-enrichment counts by `title_source`/`status`, unique fetch counts, skipped/error/unresolved counts, the ledger reference, and raw-page evidence references. Never claim guaranteed citation. Never claim content-plan completion while logical clustering or user approval is pending, and never hide unresolved title URLs.
