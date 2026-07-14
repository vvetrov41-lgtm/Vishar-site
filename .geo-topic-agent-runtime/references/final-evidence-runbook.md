# Final Evidence Runbook

This GEO/AEO workflow can be completed with offline, manual-import, or approval-gated evidence. A full live-proven 100% claim needs the external evidence listed in `final-evidence-contract.json`.

## Rules

- Do not read or print secret values. Detect only whether approved credential names exist.
- Do not run network, paid provider, URL fetch, or independent reviewer work without explicit approval for scope and budget.
- Record approval scope before the run in `geo_agent/data/quality-gates/external_approval_ledger.json`: provider, topic, engines, query count, requested top URL count (`--depth`, not pagination pages), paid request count, region, language, URL list, timeout, maximum cost/request count, approved_by, approval_ref, and approved_at.
- Preserve raw provider/page evidence and bounded structured observations.
- Run `completion-audit` after live collection or URL enrichment.
- If the user explicitly descopes an external evidence item, record it in `geo_agent/data/quality-gates/final_evidence_decisions.json` with `id`, `decision: descoped`, `approved_by`, `reason`, and `date`.
- A descope decision is a visible limitation. It does not count as `external_pass` and does not prove live execution.


## Runtime Templates

`setup` copies four machine-readable preparation templates to `geo_agent/data/import/final_evidence/`:

- `final_evidence_decisions_template.json`
- `independent_review_summary_template.json`
- `provider_collection_summary_template.json`
- `url_enrichment_summary_template.json`

Copy a template into the required `geo_agent/data/quality-gates/` or `geo_agent/data/raw/...` location only after the corresponding approved run or reviewer process is complete. A template file in `data/import/final_evidence/` is never evidence by itself.

## Decision Record Format

```json
{
  "schema_version": 1,
  "decisions": [
    {
      "id": "xmlriver_live_run",
      "decision": "descoped",
      "approved_by": "<user-or-reviewer>",
      "reason": "<why this evidence is out of scope>",
      "date": "YYYY-MM-DD",
      "scope": "<optional release/scope note>"
    }
  ]
}
```

Run `final-evidence-audit` after adding or changing this file. `ready_with_descopes` means release limitations are explicit; it is not the same as `external_pass`.

## Evidence Linkage

The final audit is intentionally strict about stale files:

- provider live rows must have `raw_ref` values that resolve to existing files inside the same approved `data/raw/serp/<run_id>` directory as a valid `collection_summary.json`;
- provider `collection_summary.json` must match the current `topic_slug`, set `network_approved` to `true`, contain `serp_rows > 0`, and have no `errors`;
- URL enrichment rows with `status=success` must have `raw_ref` values that resolve to existing files under `geo_agent/data/raw/pages`;
- unreferenced raw files, Markdown reports alone, or stale CSV rows are not enough for `external_pass`.

Equivalent CLI path:

```bash
python .geo-topic-agent-runtime/geo_agent_cli.py record-descope --project-dir <target> --evidence-id xmlriver_live_run --approved-by "<user-or-reviewer>" --reason "<why descoped>" --date YYYY-MM-DD
python .geo-topic-agent-runtime/geo_agent_cli.py final-evidence-audit --project-dir <target> --topic "<topic>"
```


## Readiness Packet

Before requesting live provider/network/independent reviewer approval, generate a bounded approval packet:

```bash
python .geo-topic-agent-runtime/geo_agent_cli.py final-evidence-readiness --project-dir <target> --topic "<topic>" --max-queries <n> --depth <d> --max-urls <n>
```

This writes `FINAL_EVIDENCE_READINESS.md` plus machine JSON. It does not run network, paid providers, URL fetches, or independent reviewers; it only lists the approval scope, credential presence by key name, exact commands to run after approval, required artifacts, and the descope command if the user explicitly accepts a limitation.

## Live XMLRiver

Before approving or running live XMLRiver, read `references/xmlriver-serp-method.md`. Approval scope must include selected search engines, explicit region/language, the region source, and XMLRiver max thread scope. `--depth` is top-N organic URLs per query/engine, not pagination pages; XMLRiver paid page requests are `queries * engines * ceil(depth / 10)`, and approved live collection uses `XMLRIVER_MAX_THREADS=10` for the paid page-request queue. For Google use `https://xmlriver.com/files/geo.csv` to select `loc`; for Yandex use a numeric Yandex `lr` region id plus `lang`.

Required before claim: approved XMLRiver request, topic-bound `collection_summary.json` with `network_approved=true` and `errors=[]`, raw XML referenced by live CSV `raw_ref`, normalized SERP rows, optional AI rows when returned, and completion audit without a live-provider warning for that approved scope.

Safe order:

```bash
python .geo-topic-agent-runtime/geo_agent_cli.py provider-audit --project-dir <target>
python .geo-topic-agent-runtime/geo_agent_cli.py collect-serp --project-dir <target> --topic "<topic>" --provider xmlriver --dry-run --max-queries <n> --depth <d>
python .geo-topic-agent-runtime/geo_agent_cli.py collect-serp --project-dir <target> --topic "<topic>" --provider xmlriver --network-approved --paid-approved --max-queries <n> --depth <d>
python .geo-topic-agent-runtime/geo_agent_cli.py completion-audit --project-dir <target> --topic "<topic>"
```

## Live DataForSEO

Required before claim: approved DataForSEO Google Organic Live request, topic-bound `collection_summary.json` with `network_approved=true` and `errors=[]`, raw JSON referenced by live CSV `raw_ref`, normalized SERP rows, normalized AI rows when present, and completion audit without a live-provider warning for that approved scope.

Safe order:

```bash
python .geo-topic-agent-runtime/geo_agent_cli.py provider-audit --project-dir <target>
python .geo-topic-agent-runtime/geo_agent_cli.py collect-serp --project-dir <target> --topic "<topic>" --provider dataforseo --engines google --include-ai --dry-run --max-queries <n> --depth <d>
python .geo-topic-agent-runtime/geo_agent_cli.py collect-serp --project-dir <target> --topic "<topic>" --provider dataforseo --engines google --include-ai --network-approved --paid-approved --max-queries <n> --depth <d>
python .geo-topic-agent-runtime/geo_agent_cli.py completion-audit --project-dir <target> --topic "<topic>"
```

Use `--load-async-ai-overview` only after explicit extra approval because it can add provider cost.

## Live URL Enrichment

Required before claim: approved URL list, approval ledger row, `*_url_enrichment_summary.json` with `network_approved=true` and `enriched_rows>0`, raw page evidence referenced by `url_enrichment.csv` `raw_ref`, page signal CSV, and `URL_ENRICHMENT.md`.

```bash
python .geo-topic-agent-runtime/geo_agent_cli.py enrich-urls --project-dir <target> --topic "<topic>" --urls "<url1>,<url2>" --network-approved --max-urls <n>
python .geo-topic-agent-runtime/geo_agent_cli.py completion-audit --project-dir <target> --topic "<topic>"
```

## Independent GEO Workflow Review


Prepare reviewer context without running reviewers:

```bash
python .geo-topic-agent-runtime/geo_agent_cli.py independent-audit-pack --project-dir <target> --topic "<topic>"
```

This writes `INDEPENDENT_AUDIT_PACK.md`, machine JSON, and prompt files for six scenario reviewers plus clean auditors. It is preparation only and must not be counted as independent GEO workflow review.


Required before claim: explicit approval to run independent reviewers, six scenario traces, four clean auditor reports, and a repaired or documented disposition for every real finding.

The deterministic audit does not accept Markdown reports alone. After reviewers finish, write a structured summary to:

```text
geo_agent/data/quality-gates/independent-review-summary.json
```

Minimum structure:

```json
{
  "schema_version": 1,
  "independent_execution": true,
  "self_review_only": false,
  "reviews": [
    {
      "id": "first-run-onboarding",
      "kind": "scenario",
      "reviewer_id": "<reviewer-or-agent-id>",
      "independent": true,
      "status": "pass|warn|fail",
      "inspected_files": ["<path>"],
      "work_trace": ["<step attempted>"],
      "confusion_points": [],
      "findings": []
    }
  ],
  "findings": [
    {
      "id": "<finding-id>",
      "status": "fixed|rejected_with_reason|known_limitation|not_applicable",
      "reason": "<required for rejected/known limitation>",
      "evidence_refs": ["<required for fixed>"]
    }
  ],
  "all_findings_dispositioned": true
}
```

Required review ids are the six scenario packs from `independent-audit-pack` and these four auditors: `consistency-routing-auditor`, `geo-workflow-design-auditor`, `evidence-quality-auditor`, and `claim-boundary-auditor`.

Until this is done, use the self-review reports only as non-independent evidence.
