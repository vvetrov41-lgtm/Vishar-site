from __future__ import annotations

import csv
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

from .core import (
    CSV_ARTIFACT_ENCODING,
    DATA_REL,
    PROCESSED_REL,
    RAW_REL,
    REPORTS_REL,
    artifact_encoding_issues,
    bounded_text,
    brand_variants_from_config,
    collect_serp,
    configured_semantic_cluster_queries,
    ai_text_for_matching,
    extract_ai_citation_urls,
    ensure_dirs,
    escape_md,
    find_project_root,
    full_workflow_prerequisite_gate,
    load_config,
    normalize_domain,
    normalize_ws,
    is_xmlriver_error_payload,
    normalize_ai_citation_url,
    normalize_artifact_value,
    observation,
    portable_ref,
    read_csv,
    read_json,
    read_text_lossless,
    repair_text_encoding,
    sha12,
    slugify,
    split_csv,
    text_contains_term,
    update_state,
    utc_now,
    write_csv,
    write_json,
    write_text,
)


HISTORY_REL = DATA_REL / "history"
VISIBILITY_RUNS_REL = DATA_REL / "visibility-runs"


def citation_visibility_audit(
    project_dir: Path,
    topic: str = "",
    domain: str = "",
    brand: str = "",
    brand_variants: str = "",
    products: str = "",
    queries: str = "",
    queries_file: str = "",
    serp_csv: str = "",
    ai_csv: str = "",
    engines: str = "google,yandex",
    regions: str = "RU-Moscow",
    language: str = "ru",
    provider: str = "xmlriver",
    depth: int = 20,
    collect_live: bool = False,
    network_approved: bool = False,
    paid_approved: bool = False,
    env_path: str = "",
    run_label: str = "",
    timeout: int = 60,
) -> dict[str, Any]:
    root = find_project_root(project_dir)
    config = load_config(root)
    prerequisite = citation_visibility_prerequisite_gate(root, config)
    if prerequisite["status"] != "pass":
        ignored_direct_brand_input = bool(normalize_ws(brand) or normalize_ws(brand_variants))
        return observation(
            "blocked",
            "Citation visibility was not measured: confirmed project brand variants and a passed deep-context gate are required.",
            items=[{
                **prerequisite,
                "direct_brand_input_confirms_variants": False,
                "direct_brand_input_ignored": ignored_direct_brand_input,
                "history_written": False,
                "metrics_written": False,
            }],
            next_valid_actions=prerequisite["next_valid_actions"],
        )
    ensure_dirs(root)
    topic_value = topic or first_priority_topic(config) or "citation visibility"
    topic_slug = slugify(topic_value)
    domain_value = domain or config.get("project", {}).get("domain", "")
    project = config.get("project", {})
    brand_value = project.get("brand", "")
    product_values = unique_nonempty([str(value) for value in project.get("products_services", [])])
    engine_values = unique_nonempty(split_csv(engines)) or ["google"]
    region_values = unique_nonempty(split_semicolon(regions)) or [region_from_config(config)]
    query_values = load_visibility_queries(root, topic_value, queries, queries_file)
    if not query_values:
        query_values = configured_semantic_cluster_queries(config, topic_value)
    observed_at = utc_now()
    run_id = build_run_id(topic_value, domain_value, engine_values, region_values, observed_at, run_label)
    run_dir = root / VISIBILITY_RUNS_REL / run_id
    errors: list[str] = []

    live_serp: list[dict[str, Any]] = []
    live_ai: list[dict[str, Any]] = []
    measurement_states: dict[tuple[str, str, str], dict[str, Any]] = {}
    if collect_live:
        if not network_approved or not paid_approved:
            errors.append("live collection skipped: --collect-live requires --network-approved and --paid-approved")
        else:
            for region in region_values:
                result = collect_serp(
                    root,
                    topic=topic_value,
                    provider=provider,
                    engines=",".join(engine_values),
                    region=region,
                    language=language,
                    seed_queries=", ".join(query_values),
                    cluster_queries="\n".join(query_values),
                    depth=depth,
                    max_queries=0,
                    include_ai=True,
                    network_approved=True,
                    paid_approved=paid_approved,
                    dry_run=False,
                    timeout=timeout,
                    env_path=env_path,
                    load_async_ai_overview=False,
                )
                if result.get("status") != "success":
                    blocked_report = root / REPORTS_REL / "CITATION_VISIBILITY_LIVE_COLLECTION_BLOCKED.md"
                    write_text(
                        blocked_report,
                        "# CITATION_VISIBILITY_LIVE_COLLECTION_BLOCKED\n\n"
                        "The requested live SERP/AI collection did not complete. Citation visibility stopped before writing history or measured metrics; any provider rows remain diagnostic evidence only.\n\n"
                        f"- region: {region}\n- provider: {provider}\n- status: {result.get('status')}\n- summary: {result.get('summary')}\n",
                    )
                    return observation(
                        "error",
                        "Citation visibility stopped because its requested live collection did not complete.",
                        items=[{"topic": topic_value, "region": region, "provider": provider, "live_collection_status": result.get("status"), "history_written": False, "metrics_written": False}],
                        evidence_refs=[str(blocked_report), *result.get("evidence_refs", [])],
                        next_valid_actions=["repair_live_collection_scope_or_provider", "rerun_citation_visibility_after_live_collection_succeeds"],
                    )
                measurement_states.update(
                    load_live_measurement_states(root, result, region, query_values, engine_values, provider)
                )
                live_serp.extend(load_processed_serp(root, topic_slug, provider, region, engine_values))
                live_ai.extend(load_processed_ai(root, topic_slug, provider, region, engine_values))

    serp_rows = dedupe_evidence_rows(
        live_serp + load_serp_sources(root, topic_slug, serp_csv, region_values, engine_values),
        "serp",
    )
    ai_rows = dedupe_evidence_rows(
        live_ai + load_ai_sources(root, topic_slug, ai_csv, region_values, engine_values),
        "ai",
    )
    query_values = query_values or infer_queries(serp_rows, ai_rows)
    if not query_values:
        errors.append("semantic cluster queries are missing; visibility tracking measures query x search engine x region and cannot use a bare topic as a query source")

    target_domains = target_domain_set(domain_value, config)
    if not target_domains:
        errors.append("project domain is missing; organic position and URL citation checks use empty target domain set")
    imported_error_states = imported_provider_error_states(
        [*serp_rows, *ai_rows], query_values, engine_values, region_values
    )
    for key, state in imported_error_states.items():
        current = measurement_states.get(key, {})
        measurement_states[key] = {
            "status": "provider_error",
            "refs": unique_nonempty([
                *[str(ref) for ref in current.get("refs", []) if ref],
                *[str(ref) for ref in state.get("refs", []) if ref],
            ]),
            "error": " | ".join(unique_nonempty([
                str(current.get("error", "")),
                str(state.get("error", "")),
            ])),
        }
    brands = unique_nonempty(brand_variants_from_config(config))
    rows = build_visibility_rows(
        query_values,
        engine_values,
        region_values,
        serp_rows,
        ai_rows,
        target_domains,
        brands,
        observed_at,
        run_id,
        measurement_states,
    )
    summary_rows = build_summary_rows(rows)
    run_summary = build_run_summary(
        topic_value,
        domain_value,
        brand_value,
        product_values,
        brands,
        config.get("project", {}).get("brand_variants_status", "missing"),
        engine_values,
        region_values,
        rows,
        summary_rows,
        errors,
        observed_at,
        run_id,
        run_label,
    )

    run_dir.mkdir(parents=True, exist_ok=True)
    serp_snapshot = run_dir / "serp_snapshot.csv"
    ai_snapshot = run_dir / "ai_snapshot.csv"
    rows_path = run_dir / "visibility_rows.csv"
    source_inventory_path = run_dir / "citation_source_inventory.csv"
    summary_path = run_dir / "visibility_summary.json"
    report_run_path = run_dir / "CITATION_VISIBILITY_RUN.md"
    source_inventory_report_path = run_dir / "CITATION_SOURCE_INVENTORY.md"
    latest_rows_path = root / PROCESSED_REL / f"{topic_slug}_citation_visibility_latest.csv"
    latest_source_inventory_path = root / PROCESSED_REL / f"{topic_slug}_citation_source_inventory_latest.csv"
    latest_summary_path = root / PROCESSED_REL / f"{topic_slug}_citation_visibility_latest.json"
    latest_report_path = root / REPORTS_REL / "CITATION_VISIBILITY.md"
    latest_source_inventory_report_path = root / REPORTS_REL / "CITATION_SOURCE_INVENTORY.md"
    history_rows_path = root / HISTORY_REL / "citation_visibility_rows.csv"
    history_source_inventory_path = root / HISTORY_REL / "citation_source_inventory_rows.csv"
    history_runs_path = root / HISTORY_REL / "citation_visibility_runs.jsonl"
    source_inventory_rows = build_citation_source_inventory_rows(rows, target_domains)

    write_csv(serp_snapshot, normalized_snapshot_rows(serp_rows))
    write_csv(ai_snapshot, normalized_snapshot_rows(ai_rows))
    write_csv(rows_path, rows)
    write_csv(source_inventory_path, source_inventory_rows)
    write_json(summary_path, run_summary)
    write_csv(latest_rows_path, rows)
    write_csv(latest_source_inventory_path, source_inventory_rows)
    write_json(latest_summary_path, run_summary)
    append_csv(history_rows_path, rows)
    append_csv(history_source_inventory_path, source_inventory_rows)
    append_jsonl(history_runs_path, run_summary)

    report_text = render_visibility_report(root, run_summary, rows, summary_rows, {
        "run_dir": run_dir,
        "run_rows": rows_path,
        "source_inventory": source_inventory_path,
        "run_summary": summary_path,
        "history_rows": history_rows_path,
        "history_source_inventory": history_source_inventory_path,
        "history_runs": history_runs_path,
        "latest_rows": latest_rows_path,
        "latest_source_inventory": latest_source_inventory_path,
        "serp_snapshot": serp_snapshot,
        "ai_snapshot": ai_snapshot,
    })
    source_inventory_text = render_citation_source_inventory(root, run_summary, rows, source_inventory_rows, {
        "source_inventory": source_inventory_path,
        "latest_source_inventory": latest_source_inventory_path,
        "history_source_inventory": history_source_inventory_path,
        "visibility_rows": rows_path,
        "ai_snapshot": ai_snapshot,
    })
    write_text(report_run_path, report_text)
    write_text(source_inventory_report_path, source_inventory_text)
    write_text(latest_report_path, report_text)
    write_text(latest_source_inventory_report_path, source_inventory_text)
    update_state(root, f"Citation visibility run {run_id} completed for {topic_value}", [str(latest_report_path), str(latest_source_inventory_report_path), str(rows_path), str(source_inventory_path), str(history_rows_path)])

    measured_rows = [row for row in rows if truthy(row.get("metric_eligible"))]
    provider_error_rows = [row for row in rows if row.get("measurement_status") == "provider_error"]
    if not rows:
        status = "blocked"
    elif provider_error_rows and measured_rows:
        status = "partial_success"
    elif provider_error_rows and not measured_rows:
        status = "error"
    elif errors:
        status = "partial_success"
    else:
        status = "success"
    if provider_error_rows and measured_rows:
        summary = (
            f"Citation visibility recorded {len(measured_rows)} measured checks and "
            f"{len(provider_error_rows)} provider-error checks excluded from every rate."
        )
    elif provider_error_rows:
        summary = (
            f"Citation visibility produced no eligible measurements: all {len(provider_error_rows)} checks "
            "failed at the provider and were excluded from every rate."
        )
    elif rows:
        summary = f"Citation visibility recorded {len(measured_rows)} eligible measurements."
    else:
        summary = "Citation visibility report could not be created because no query checks were available."
    if provider_error_rows:
        next_actions = [
            "review_provider_error_details",
            "repair_provider_credentials_or_request_parameters",
            "retry_only_failed_provider_checks",
            "do_not_compare_rates_until_failed_checks_are_remeasured",
        ]
    elif errors:
        next_actions = ["review_visibility_report", "resolve_collection_warnings", "collect_live_with_approval"]
    else:
        next_actions = ["review_visibility_report", "schedule_next_measurement", "compare_with_next_run"]
    return observation(
        status,
        summary,
        items=[{
            "run_id": run_id,
            "topic": topic_value,
            "queries": len(query_values),
            "engines": engine_values,
            "regions": region_values,
            "rows": len(rows),
            "measured_rows": len(measured_rows),
            "provider_error_rows": len(provider_error_rows),
            "ai_answer_queries": run_summary["totals"]["ai_answer_queries"],
            "site_ai_cited_queries": run_summary["totals"]["site_ai_cited_queries"],
            "brand_or_product_mentioned_queries": run_summary["totals"]["brand_or_product_mentioned_queries"],
            "errors": len(errors),
        }],
        evidence_refs=[str(latest_report_path), str(latest_source_inventory_report_path), str(report_run_path), str(source_inventory_report_path), str(rows_path), str(source_inventory_path), str(history_rows_path), str(history_source_inventory_path), str(history_runs_path)],
        next_valid_actions=next_actions,
    )


def citation_visibility_prerequisite_gate(root: Path, config: dict[str, Any]) -> dict[str, Any]:
    workflow_gate = full_workflow_prerequisite_gate(root)
    project = config.get("project", {}) if isinstance(config, dict) else {}
    context = read_json(root / DATA_REL / "project_context.json", {})
    context_gate = context.get("context_quality_gate", {}) if isinstance(context, dict) else {}
    site_context = context.get("site_context", {}) if isinstance(context, dict) else {}
    acquisition = context.get("context_acquisition", {}) if isinstance(context, dict) else {}

    raw_variants = project.get("brand_variants", [])
    if isinstance(raw_variants, str):
        configured_variants = unique_nonempty(split_semicolon(raw_variants))
    elif isinstance(raw_variants, list):
        configured_variants = unique_nonempty([str(value) for value in raw_variants])
    else:
        configured_variants = []
    brand_status = str(project.get("brand_variants_status") or "missing")
    brand_confirmed = brand_status == "confirmed" and bool(configured_variants)

    context_gate_passed = str(context_gate.get("status") or "").lower() == "pass"
    site_status = str(site_context.get("status") or "")
    deep_status = str(acquisition.get("deep_context_collection_status") or "")
    deep_context_passed = (
        context_gate_passed
        and (not site_status or site_status == "success")
        and (not deep_status or deep_status == "success")
    )
    actions: list[str] = []
    if not configured_variants:
        actions.append("collect_or_propose_brand_variants")
    if not brand_confirmed:
        actions.append("confirm_brand_variants_in_project_context")
    if not deep_context_passed:
        actions.append("complete_deep_project_context_and_pass_quality_gate")
    return {
        "status": "pass" if brand_confirmed and deep_context_passed and workflow_gate.get("status") == "pass" else "block",
        "workflow_audit_gate_status": workflow_gate.get("audit_gate", {}).get("status", "missing"),
        "workflow_gate": workflow_gate,
        "brand_variants_status": brand_status,
        "confirmed_brand_variant_count": len(configured_variants) if brand_confirmed else 0,
        "deep_context_gate_status": context_gate.get("status", "missing"),
        "site_context_status": site_status or "missing",
        "deep_context_collection_status": deep_status or "missing",
        "next_valid_actions": unique_nonempty([*actions, *workflow_gate.get("next_valid_actions", [])]),
    }


def first_priority_topic(config: dict[str, Any]) -> str:
    topics = config.get("project", {}).get("priority_topics", [])
    return topics[0] if topics else ""


def region_from_config(config: dict[str, Any]) -> str:
    region = config.get("region", {})
    country = region.get("country", "RU")
    city = region.get("city", "")
    return f"{country}-{city}" if city else country


def build_run_id(topic: str, domain: str, engines: list[str], regions: list[str], observed_at: str, run_label: str) -> str:
    prefix = slugify(run_label) if run_label else "visibility"
    digest = sha12("|".join([topic, domain, ",".join(engines), ",".join(regions), observed_at]))
    return f"{prefix}_{digest}"


def split_semicolon(value: str) -> list[str]:
    if not value:
        return []
    return [normalize_ws(part) for part in re.split(r"[\n;,]+", value) if normalize_ws(part)]


def unique_nonempty(values: list[str]) -> list[str]:
    seen = set()
    out = []
    for value in values:
        cleaned = normalize_ws(str(value))
        key = cleaned.casefold()
        if cleaned and key not in seen:
            seen.add(key)
            out.append(cleaned)
    return out


def load_visibility_queries(root: Path, topic: str, queries: str, queries_file: str) -> list[str]:
    values = split_semicolon(queries)
    path = Path(queries_file) if queries_file else None
    if path and path.exists() and path.is_file():
        if path.suffix.lower() == ".csv":
            for row in read_csv(path):
                value = row.get("query") or row.get("prompt") or row.get("qfo_query") or row.get("keyword") or ""
                if value:
                    values.append(value)
        else:
            values.extend(split_semicolon(read_text_lossless(path)))
    explicit_values = unique_nonempty(values)
    if explicit_values:
        return explicit_values

    topic_slug = slugify(topic)
    for path in (root / PROCESSED_REL).glob("*qfo*.csv"):
        if topic_slug and topic_slug not in path.name and overlap_filename(topic, path.name) <= 0:
            continue
        for row in read_csv(path):
            for field in ["query", "generated_query", "source_query", "included_queries", "sample_queries"]:
                values.extend(split_semicolon(row.get(field, "")))
    return unique_nonempty(values)
def overlap_filename(topic: str, filename: str) -> int:
    terms = {part.casefold() for part in re.findall(r"[A-Za-zА-Яа-яЁё0-9]+", topic or "") if len(part) > 2}
    name_terms = {part.casefold() for part in re.findall(r"[A-Za-zА-Яа-яЁё0-9]+", filename.replace("-", " ")) if len(part) > 2}
    return len(terms & name_terms)


def load_processed_serp(root: Path, topic_slug: str, provider: str, region: str, engines: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    paths = [
        root / PROCESSED_REL / f"{topic_slug}_{slugify(provider)}_live_serp_rows.csv",
        root / PROCESSED_REL / f"{topic_slug}_live_serp_rows.csv",
    ]
    for path in paths:
        for row in read_csv(path):
            rows.append(enrich_evidence_row(row, region, row.get("engine", "") or first_engine(engines), provider, str(path)))
    return rows


def provider_error_detail_from_row(row: dict[str, Any]) -> str:
    explicit_details: list[str] = []
    marked = False
    false_values = {"", "0", "false", "none", "null", "no", "ok", "success", "completed", "200", "20000"}
    error_statuses = {"error", "failed", "failure", "provider_error", "blocked", "invalid", "rejected", "timeout"}

    for key, value in row.items():
        key_name = str(key).strip().casefold().replace("-", "_")
        value_text = normalize_ws(str(value or ""))
        value_lower = value_text.casefold()
        if not value_text:
            continue
        if key_name in {"provider_error", "has_error", "is_error"} and value_lower not in false_values:
            marked = True
            explicit_details.append(f"{key_name}={value_text}")
        elif "error" in key_name and value_lower not in false_values:
            marked = True
            explicit_details.append(f"{key_name}={value_text}")
        elif key_name.endswith("status") or key_name.endswith("_status"):
            if value_lower in error_statuses or any(token in value_lower for token in ["error", "fail", "reject", "invalid", "timeout"]):
                marked = True
                explicit_details.append(f"{key_name}={value_text}")
        elif key_name.endswith("status_code") or key_name in {"http_code", "http_status_code", "response_code"}:
            try:
                code = int(float(value_text))
            except ValueError:
                code = 0
            if code >= 40000 or 400 <= code < 600:
                marked = True
                explicit_details.append(f"{key_name}={value_text}")

    payload_text = " ".join(
        str(row.get(field) or "")
        for field in [
            "answer_text", "answer_text_clean", "answer", "raw_payload", "response",
            "payload", "status_message", "task_status_message", "message",
        ]
    )
    if is_xmlriver_error_payload(payload_text):
        marked = True
        explicit_details.append("XMLRiver error payload marker")
    dataforseo_code = re.search(r"['\"]?status_code['\"]?\s*[:=]\s*(4\d{4})", payload_text, flags=re.IGNORECASE)
    if dataforseo_code:
        marked = True
        explicit_details.append(f"DataForSEO status_code={dataforseo_code.group(1)}")

    if not marked:
        return ""
    details = unique_nonempty(explicit_details)
    if not details:
        details = ["provider returned an explicit error payload"]
    return bounded_text(" | ".join(details), 500)


def should_skip_ai_evidence_row(row: dict[str, Any]) -> bool:
    # Error rows are evidence about measurement failure and must remain in snapshots.
    return False


def load_processed_ai(root: Path, topic_slug: str, provider: str, region: str, engines: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    paths = [
        root / PROCESSED_REL / f"{topic_slug}_{slugify(provider)}_live_ai_answers.csv",
        root / PROCESSED_REL / f"{topic_slug}_live_ai_answers.csv",
    ]
    for path in paths:
        for row in read_csv(path):
            rows.append(enrich_evidence_row(row, region, engine_from_model(row, engines), provider, str(path)))
    return rows


def load_serp_sources(root: Path, topic_slug: str, serp_csv: str, regions: list[str], engines: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    paths = [Path(serp_csv)] if serp_csv else []
    paths.extend([
        root / PROCESSED_REL / f"{topic_slug}_serp_rows.csv",
        root / PROCESSED_REL / f"{topic_slug}_live_serp_rows.csv",
    ])
    seen_paths = set()
    for path in paths:
        if not path or not path.exists() or str(path) in seen_paths:
            continue
        seen_paths.add(str(path))
        for row in read_csv(path):
            rows.append(enrich_evidence_row(row, row.get("region", "") or first_region(regions), row.get("engine", "") or first_engine(engines), row.get("provider", "") or row.get("source_type", "imported"), str(path)))
    return rows


def load_ai_sources(root: Path, topic_slug: str, ai_csv: str, regions: list[str], engines: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    paths = [Path(ai_csv)] if ai_csv else []
    paths.extend([
        root / PROCESSED_REL / f"{topic_slug}_ai_answers.csv",
        root / PROCESSED_REL / f"{topic_slug}_live_ai_answers.csv",
        root / PROCESSED_REL / f"{topic_slug}_qfo_xmlriver_ai_answers.csv",
    ])
    seen_paths = set()
    for path in paths:
        if not path or not path.exists() or str(path) in seen_paths:
            continue
        seen_paths.add(str(path))
        for row in read_csv(path):
            rows.append(enrich_evidence_row(row, row.get("region", "") or first_region(regions), row.get("engine", "") or engine_from_model(row, engines), row.get("provider", "imported"), str(path)))
    return rows


def enrich_evidence_row(row: dict[str, Any], region: str, engine: str, provider: str, source_path: str) -> dict[str, Any]:
    out = dict(row)
    explicit_engine = bool(normalize_ws(str(row.get("engine") or ""))) or bool(
        re.search(r"google|yandex", str(row.get("model") or ""), flags=re.IGNORECASE)
    )
    explicit_region = bool(normalize_ws(str(row.get("region") or "")))
    out["region"] = repair_text_encoding(str(row.get("region") or region))
    out["engine"] = repair_text_encoding(str(row.get("engine") or engine))
    out["_provider_error_scope_engine_explicit"] = explicit_engine
    out["_provider_error_scope_region_explicit"] = explicit_region
    out["provider"] = repair_text_encoding(str(row.get("provider") or provider))
    out["source_path"] = row.get("source_path") or source_path
    if not out.get("answer_text") and out.get("answer_text_clean"):
        out["answer_text"] = out.get("answer_text_clean", "")
    for field in ["query", "prompt", "answer_text", "answer_text_clean", "citation_title", "cited_titles"]:
        if out.get(field):
            out[field] = repair_text_encoding(str(out[field]))
    if out.get("citation_url"):
        out["citation_url"] = normalize_ai_citation_url(str(out.get("citation_url", "")))
    provider_error_detail = provider_error_detail_from_row(out)
    if provider_error_detail:
        out["provider_error"] = True
        out["provider_error_detail"] = provider_error_detail
    return out


def first_region(regions: list[str]) -> str:
    return regions[0] if regions else "RU-Moscow"


def first_engine(engines: list[str]) -> str:
    return engines[0] if engines else "google"


def engine_from_model(row: dict[str, Any], engines: list[str]) -> str:
    model = str(row.get("model") or "").lower()
    provider = str(row.get("provider") or "").lower()
    if "yandex" in model or provider == "yandex":
        return "yandex"
    if "google" in model or provider in {"google", "dataforseo"}:
        return "google"
    return first_engine(engines)


def infer_queries(serp_rows: list[dict[str, Any]], ai_rows: list[dict[str, Any]]) -> list[str]:
    values = [row.get("query", "") for row in serp_rows]
    values.extend(row.get("prompt", "") or row.get("query", "") for row in ai_rows)
    return unique_nonempty([str(value) for value in values if value])


def measurement_key(query: Any, engine: Any, region: Any) -> tuple[str, str, str]:
    return (
        normalize_ws(str(query)).casefold(),
        normalize_ws(str(engine)).casefold(),
        normalize_ws(str(region)).casefold(),
    )


def resolve_result_path(root: Path, value: Any) -> Path:
    path = Path(str(value or ""))
    if path.is_absolute():
        return path
    return root / path


def load_live_measurement_states(
    root: Path,
    result: dict[str, Any],
    region: str,
    queries: list[str],
    engines: list[str],
    provider: str,
) -> dict[tuple[str, str, str], dict[str, Any]]:
    expected = {
        measurement_key(query, engine, region): {
            "status": "provider_error",
            "refs": [],
            "error": "missing provider request ledger",
        }
        for query in queries
        for engine in engines
    }
    summary_paths = [
        resolve_result_path(root, ref)
        for ref in result.get("evidence_refs", [])
        if str(ref).endswith("collection_summary.json")
    ]
    ledger_paths: list[Path] = []
    for summary_path in summary_paths:
        payload = read_json(summary_path, {})
        for ref in payload.get("request_meta_refs", []):
            candidate = resolve_result_path(root, ref)
            if candidate.exists():
                ledger_paths.append(candidate)

    grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for ledger_path in ledger_paths:
        payload = read_json(ledger_path, {})
        key = measurement_key(
            payload.get("query", ""),
            payload.get("engine", ""),
            payload.get("region", region),
        )
        grouped[key].append({**payload, "_ledger_ref": str(ledger_path)})

    for key, ledgers in grouped.items():
        refs = [str(row.get("_ledger_ref", "")) for row in ledgers if row.get("_ledger_ref")]
        failed = [row for row in ledgers if str(row.get("status", "")).lower() != "success"]
        expected[key] = {
            "status": "provider_error" if failed else "measured",
            "refs": refs,
            "error": " | ".join(
                unique_nonempty([
                    str(row.get("error_summary") or row.get("error_type") or "provider request failed")
                    for row in failed
                ])
            ),
        }

    if not ledger_paths:
        fallback_status = "measured" if result.get("status") == "success" else "provider_error"
        for key in expected:
            expected[key] = {
                "status": fallback_status,
                "refs": [str(ref) for ref in result.get("evidence_refs", [])],
                "error": "" if fallback_status == "measured" else f"{provider} collection {result.get('status')}",
            }
    return expected


def imported_provider_error_states(
    rows: list[dict[str, Any]],
    queries: list[str],
    engines: list[str],
    regions: list[str],
) -> dict[tuple[str, str, str], dict[str, Any]]:
    states: dict[tuple[str, str, str], dict[str, Any]] = {}
    for row in rows:
        detail = str(row.get("provider_error_detail") or provider_error_detail_from_row(row))
        if not detail:
            continue
        row_query = normalize_ws(str(row.get("query") or row.get("prompt") or ""))
        scoped_queries = [row_query] if row_query else list(queries)
        row_engine = normalize_ws(str(row.get("engine") or ""))
        scoped_engines = (
            [row_engine]
            if truthy(row.get("_provider_error_scope_engine_explicit")) and row_engine
            else list(engines)
        )
        row_region = normalize_ws(str(row.get("region") or ""))
        scoped_regions = (
            [row_region]
            if truthy(row.get("_provider_error_scope_region_explicit")) and row_region
            else list(regions)
        )
        refs = source_refs([row])
        for query in scoped_queries:
            for engine in scoped_engines:
                for region in scoped_regions:
                    key = measurement_key(query, engine, region)
                    current = states.get(key, {})
                    states[key] = {
                        "status": "provider_error",
                        "refs": unique_nonempty([
                            *[str(ref) for ref in current.get("refs", []) if ref],
                            *refs,
                        ]),
                        "error": " | ".join(unique_nonempty([
                            str(current.get("error", "")),
                            detail,
                        ])),
                    }
    return states


def dedupe_evidence_rows(rows: list[dict[str, Any]], evidence_type: str) -> list[dict[str, Any]]:
    seen: set[tuple[str, ...]] = set()
    out: list[dict[str, Any]] = []
    for row in rows:
        query = row.get("query") or row.get("prompt") or ""
        common = (
            normalize_ws(str(query)).casefold(),
            normalize_ws(str(row.get("engine", ""))).casefold(),
            normalize_ws(str(row.get("region", ""))).casefold(),
        )
        if evidence_type == "serp":
            key = common + (
                str(row.get("position", "")),
                str(row.get("url", "")).strip(),
                normalize_ws(str(row.get("title", ""))).casefold(),
            )
        else:
            key = common + (
                str(row.get("answer_id", "")),
                str(row.get("citation_url", "")).strip(),
                sha12(str(row.get("answer_text") or row.get("answer_text_clean") or "")),
            )
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


def target_domain_set(domain: str, config: dict[str, Any]) -> set[str]:
    values = [domain, config.get("project", {}).get("domain", "")]
    values.extend(config.get("project", {}).get("site_pages", []))
    domains = {normalize_domain(value) for value in values if normalize_domain(value)}
    return {domain.removeprefix("www.") for domain in domains if domain}


def build_visibility_rows(
    queries: list[str],
    engines: list[str],
    regions: list[str],
    serp_rows: list[dict[str, Any]],
    ai_rows: list[dict[str, Any]],
    target_domains: set[str],
    brands: list[str],
    observed_at: str,
    run_id: str,
    measurement_states: dict[tuple[str, str, str], dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    states = measurement_states or {}
    rows = []
    for query in queries:
        for engine in engines:
            for region in regions:
                state = states.get(
                    measurement_key(query, engine, region),
                    {"status": "measured", "refs": [], "error": ""},
                )
                measurement_status = str(state.get("status") or "measured")
                ledger_refs = [str(ref) for ref in state.get("refs", []) if ref]
                if measurement_status == "provider_error":
                    rows.append({
                        "run_id": run_id,
                        "observed_at": observed_at,
                        "query": query,
                        "engine": engine,
                        "region": region,
                        "measurement_status": "provider_error",
                        "metric_eligible": False,
                        "provider_error": True,
                        "provider_error_detail": bounded_text(str(state.get("error", "")), 500),
                        "organic_position": "",
                        "organic_url": "",
                        "organic_title": "",
                        "organic_found": "",
                        "ai_answer_present": "",
                        "ai_citation_count": "",
                        "all_cited_urls": "",
                        "cited_domains": "",
                        "site_url_cited_in_ai": "",
                        "site_cited_urls": "",
                        "brand_or_product_mentioned": "",
                        "mentioned_terms": "",
                        "answer_count": "",
                        "answer_preview": "",
                        "source_refs": " | ".join(unique_nonempty(ledger_refs)[:12]),
                    })
                    continue

                serp_matches = match_serp_rows(serp_rows, query, engine, region)
                ai_matches = match_ai_rows(ai_rows, query, engine, region)
                position, position_url, position_title = site_position(serp_matches, target_domains)
                cited_urls = citation_urls(ai_matches)
                site_cited_urls = [url for url in cited_urls if url_matches_targets(url, target_domains)]
                cited_domains = unique_nonempty([normalize_domain(url).removeprefix("www.") for url in cited_urls if normalize_domain(url)])
                answer_texts = [str(row.get("answer_text") or row.get("answer_text_clean") or "") for row in ai_matches if row.get("answer_text") or row.get("answer_text_clean")]
                mentioned_terms = mentioned_brand_terms(answer_texts, ai_matches, brands)
                ai_present = bool(ai_matches)
                rows.append({
                    "run_id": run_id,
                    "observed_at": observed_at,
                    "query": query,
                    "engine": engine,
                    "region": region,
                    "measurement_status": "measured",
                    "metric_eligible": True,
                    "provider_error": False,
                    "provider_error_detail": "",
                    "organic_position": position if position is not None else "",
                    "organic_url": position_url,
                    "organic_title": position_title,
                    "organic_found": bool(position_url),
                    "ai_answer_present": ai_present,
                    "ai_citation_count": len(cited_urls),
                    "all_cited_urls": " | ".join(cited_urls),
                    "cited_domains": " | ".join(cited_domains),
                    "site_url_cited_in_ai": bool(site_cited_urls) or any(truthy(row.get("project_url_cited")) for row in ai_matches),
                    "site_cited_urls": " | ".join(site_cited_urls),
                    "brand_or_product_mentioned": bool(mentioned_terms),
                    "mentioned_terms": " | ".join(mentioned_terms),
                    "answer_count": len({row.get("answer_id") or sha12(str(row)) for row in ai_matches}),
                    "answer_preview": bounded_text(ai_text_for_matching(*answer_texts), 500),
                    "source_refs": " | ".join(
                        unique_nonempty([*source_refs([*serp_matches, *ai_matches]), *ledger_refs])[:12]
                    ),
                })
    return rows

def match_serp_rows(rows: list[dict[str, Any]], query: str, engine: str, region: str) -> list[dict[str, Any]]:
    return [
        row for row in rows
        if same_query(row.get("query", ""), query)
        and same_value(row.get("engine", ""), engine)
        and same_region(row.get("region", ""), region)
    ]


def match_ai_rows(rows: list[dict[str, Any]], query: str, engine: str, region: str) -> list[dict[str, Any]]:
    return [
        row for row in rows
        if same_query(row.get("prompt", "") or row.get("query", ""), query)
        and same_value(row.get("engine", "") or engine_from_model(row, [engine]), engine)
        and same_region(row.get("region", ""), region)
    ]


def same_query(left: Any, right: str) -> bool:
    return normalize_ws(str(left)).casefold() == normalize_ws(str(right)).casefold()


def same_value(left: Any, right: str) -> bool:
    return normalize_ws(str(left)).casefold() == normalize_ws(str(right)).casefold()


def same_region(left: Any, right: str) -> bool:
    left_value = normalize_ws(str(left)).casefold()
    right_value = normalize_ws(str(right)).casefold()
    return not left_value or left_value == right_value


def site_position(rows: list[dict[str, Any]], target_domains: set[str]) -> tuple[int | None, str, str]:
    best: tuple[int, str, str] | None = None
    for row in rows:
        url = str(row.get("url", ""))
        if not url_matches_targets(url, target_domains):
            continue
        position = safe_int(row.get("position"))
        if position is None:
            continue
        candidate = (position, url, str(row.get("title", "")))
        if best is None or position < best[0]:
            best = candidate
    return best if best else (None, "", "")


def url_matches_targets(url: str, target_domains: set[str]) -> bool:
    if not target_domains:
        return False
    domain = normalize_domain(url).removeprefix("www.")
    return any(domain == target or domain.endswith("." + target) for target in target_domains)


def citation_urls(rows: list[dict[str, Any]]) -> list[str]:
    urls = []
    for row in rows:
        for value in split_csv(str(row.get("citation_url") or "")):
            url = normalize_ai_citation_url(value)
            if url:
                urls.append(url)
        for value in split_csv(str(row.get("cited_urls") or row.get("citation_urls") or "")):
            url = normalize_ai_citation_url(value)
            if url:
                urls.append(url)
        urls.extend(extract_ai_citation_urls(str(row.get("answer_text") or row.get("answer_text_clean") or "")))
    return unique_nonempty(urls)


def mentioned_brand_terms(answer_texts: list[str], rows: list[dict[str, Any]], brands: list[str]) -> list[str]:
    fields = list(answer_texts)
    for row in rows:
        fields.extend([
            str(row.get("answer_text") or ""),
            str(row.get("answer_text_clean") or ""),
            str(row.get("answer") or ""),
        ])
    haystack = ai_text_for_matching(*fields)
    mentioned = [term for term in brands if term and text_contains_term(haystack, term)]
    return unique_nonempty(mentioned)


def truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "y", "да"}


def safe_int(value: Any) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def source_refs(rows: list[dict[str, Any]]) -> list[str]:
    refs = []
    for row in rows:
        for field in ["raw_ref", "source_path"]:
            value = normalize_ws(str(row.get(field, "")))
            if value:
                refs.append(value)
    return unique_nonempty(refs)


def split_pipe(value: Any) -> list[str]:
    return unique_nonempty([normalize_ws(part) for part in str(value or "").split("|") if normalize_ws(part)])


def build_citation_source_inventory_rows(rows: list[dict[str, Any]], target_domains: set[str]) -> list[dict[str, Any]]:
    inventory_rows: list[dict[str, Any]] = []
    for row in rows:
        urls = split_pipe(row.get("all_cited_urls", ""))
        if not urls:
            urls = [""]
        for url in urls:
            domain = normalize_domain(url).removeprefix("www.") if url else ""
            inventory_rows.append({
                "run_id": row.get("run_id", ""),
                "observed_at": row.get("observed_at", ""),
                "query": row.get("query", ""),
                "engine": row.get("engine", ""),
                "region": row.get("region", ""),
                "measurement_status": row.get("measurement_status", ""),
                "metric_eligible": row.get("metric_eligible", ""),
                "provider_error_detail": row.get("provider_error_detail", ""),
                "organic_position": row.get("organic_position", ""),
                "organic_url": row.get("organic_url", ""),
                "ai_answer_present": row.get("ai_answer_present", ""),
                "answer_count": row.get("answer_count", ""),
                "ai_citation_count_for_query": row.get("ai_citation_count", ""),
                "cited_url": url,
                "cited_domain": domain,
                "is_user_site_citation": bool(url and url_matches_targets(url, target_domains)),
                "site_url_cited_in_ai": row.get("site_url_cited_in_ai", ""),
                "brand_or_product_mentioned": row.get("brand_or_product_mentioned", ""),
                "mentioned_terms": row.get("mentioned_terms", ""),
                "answer_preview": row.get("answer_preview", ""),
                "source_refs": row.get("source_refs", ""),
            })
    return inventory_rows


def build_summary_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[(row["engine"], row["region"])].append(row)
    summary = []
    for (engine, region), group in sorted(grouped.items()):
        measured = [row for row in group if truthy(row.get("metric_eligible"))]
        positions = [safe_int(row.get("organic_position")) for row in measured if safe_int(row.get("organic_position")) is not None]
        denominator = len(measured)
        summary.append({
            "engine": engine,
            "region": region,
            "query_count": len(group),
            "measured_checks": denominator,
            "provider_error_checks": len(group) - denominator,
            "organic_found": sum(1 for row in measured if truthy(row.get("organic_found"))),
            "avg_organic_position": round(sum(positions) / len(positions), 2) if positions else "",
            "ai_answer_queries": sum(1 for row in measured if truthy(row.get("ai_answer_present"))),
            "site_ai_cited_queries": sum(1 for row in measured if truthy(row.get("site_url_cited_in_ai"))),
            "brand_or_product_mentioned_queries": sum(1 for row in measured if truthy(row.get("brand_or_product_mentioned"))),
            "ai_answer_rate": ratio(sum(1 for row in measured if truthy(row.get("ai_answer_present"))), denominator),
            "site_ai_citation_rate": ratio(sum(1 for row in measured if truthy(row.get("site_url_cited_in_ai"))), denominator),
            "brand_mention_rate": ratio(sum(1 for row in measured if truthy(row.get("brand_or_product_mentioned"))), denominator),
        })
    return summary

def ratio(part: int, total: int) -> float:
    return round(part / total, 4) if total else 0.0


def build_run_summary(
    topic: str,
    domain: str,
    brand: str,
    products: list[str],
    brand_variants: list[str],
    brand_variants_status: str,
    engines: list[str],
    regions: list[str],
    rows: list[dict[str, Any]],
    summary_rows: list[dict[str, Any]],
    errors: list[str],
    observed_at: str,
    run_id: str,
    run_label: str,
) -> dict[str, Any]:
    measured = [row for row in rows if truthy(row.get("metric_eligible"))]
    provider_errors = [row for row in rows if row.get("measurement_status") == "provider_error"]
    denominator = len(measured)
    return {
        "schema_version": "geo-topic-agent.citation-visibility.v1",
        "run_id": run_id,
        "run_label": run_label,
        "observed_at": observed_at,
        "topic": topic,
        "domain": domain,
        "brand": brand,
        "products": products,
        "brand_variants": brand_variants,
        "brand_variants_status": brand_variants_status,
        "visibility_layers": ["url_citation", "brand_mention"],
        "engines": engines,
        "regions": regions,
        "totals": {
            "rows": len(rows),
            "query_engine_region_checks": len(rows),
            "measured_checks": denominator,
            "provider_error_checks": len(provider_errors),
            "metric_denominator": denominator,
            "organic_found_queries": sum(1 for row in measured if truthy(row.get("organic_found"))),
            "ai_answer_queries": sum(1 for row in measured if truthy(row.get("ai_answer_present"))),
            "site_ai_cited_queries": sum(1 for row in measured if truthy(row.get("site_url_cited_in_ai"))),
            "brand_or_product_mentioned_queries": sum(1 for row in measured if truthy(row.get("brand_or_product_mentioned"))),
            "ai_answer_rate": ratio(sum(1 for row in measured if truthy(row.get("ai_answer_present"))), denominator),
            "site_ai_citation_rate": ratio(sum(1 for row in measured if truthy(row.get("site_url_cited_in_ai"))), denominator),
            "brand_mention_rate": ratio(sum(1 for row in measured if truthy(row.get("brand_or_product_mentioned"))), denominator),
        },
        "by_engine_region": summary_rows,
        "errors": errors,
    }


def normalized_snapshot_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not rows:
        return []
    keys = sorted({key for row in rows for key in row if isinstance(key, str)})
    return [{key: row.get(key, "") for key in keys} for row in rows]


def append_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        return
    normalized_rows = [
        {str(key): normalize_artifact_value(value) for key, value in row.items()}
        for row in rows
    ]
    fields: list[str] = []
    for row in normalized_rows:
        for key in row:
            if key not in fields:
                fields.append(key)
    serialized_rows = "\n".join(
        "\t".join(str(row.get(field, "")) for field in fields)
        for row in normalized_rows
    )
    issues = artifact_encoding_issues(path, serialized_rows)
    if issues:
        raise ValueError(
            f"Refusing to append {path}: possible encoding damage ({', '.join(issues)})."
        )
    exists = path.exists() and path.stat().st_size > 0
    if exists:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            existing_fields = next(csv.reader(handle), [])
        if existing_fields != fields:
            raise ValueError(
                f"Refusing to append {path}: history schema changed from {existing_fields} to {fields}."
            )
    encoding = "utf-8" if exists else CSV_ARTIFACT_ENCODING
    with path.open("a", encoding=encoding, newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        if not exists:
            writer.writeheader()
        writer.writerows(normalized_rows)

def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    issues = artifact_encoding_issues(path, serialized)
    if issues:
        raise ValueError(
            f"Refusing to append {path}: possible encoding damage ({', '.join(issues)})."
        )
    with path.open("a", encoding="utf-8") as handle:
        handle.write(serialized + "\n")

def render_visibility_report(root: Path, summary: dict[str, Any], rows: list[dict[str, Any]], summary_rows: list[dict[str, Any]], paths: dict[str, Path]) -> str:
    totals = summary.get("totals", {})
    lines = [
        "# CITATION_VISIBILITY",
        "",
        f"Observed: {summary.get('observed_at')}",
        f"Run ID: {summary.get('run_id')}",
        f"Topic: {summary.get('topic')}",
        f"Domain: {summary.get('domain') or 'not provided'}",
        f"Brand: {summary.get('brand') or 'not provided'}",
        f"Products: {', '.join(summary.get('products', [])) or 'none'}",
        f"Brand variants tracked: {', '.join(summary.get('brand_variants', [])) or 'none'}",
        f"Brand variants status: {summary.get('brand_variants_status') or 'missing'}",
        f"Visibility layers: {', '.join(summary.get('visibility_layers', [])) or 'url_citation, brand_mention'}",
        f"Search engines: {', '.join(summary.get('engines', []))}",
        f"Regions: {', '.join(summary.get('regions', []))}",
        "",
        "## Visibility Summary",
        "",
        f"- planned checks: {totals.get('query_engine_region_checks', 0)}",
        f"- measured checks (metric denominator): {totals.get('measured_checks', 0)}",
        f"- provider-error checks excluded from rates: {totals.get('provider_error_checks', 0)}",
        f"- organic found: {totals.get('organic_found_queries', 0)}",
        f"- AI answers present: {totals.get('ai_answer_queries', 0)}",
        f"- user site cited in AI: {totals.get('site_ai_cited_queries', 0)}",
        f"- brand/product mentioned in AI body: {totals.get('brand_or_product_mentioned_queries', 0)}",
        f"- AI answer rate: {totals.get('ai_answer_rate', 0)}",
        f"- site AI citation rate: {totals.get('site_ai_citation_rate', 0)}",
        f"- brand mention rate: {totals.get('brand_mention_rate', 0)}",
        "",
        "## By Search Engine And Region",
        "",
        "| Engine | Region | Planned | Measured | Provider Errors | Organic Found | Avg Position | AI Answers | Site Cited | Brand/Product Mentioned |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for row in summary_rows:
        lines.append(
            f"| {escape_md(row.get('engine', ''))} | {escape_md(row.get('region', ''))} | {row.get('query_count', 0)} | "
            f"{row.get('measured_checks', 0)} | {row.get('provider_error_checks', 0)} | {row.get('organic_found', 0)} | "
            f"{row.get('avg_organic_position', '')} | {row.get('ai_answer_queries', 0)} | "
            f"{row.get('site_ai_cited_queries', 0)} | {row.get('brand_or_product_mentioned_queries', 0)} |"
        )
    lines.extend([
        "",
        "## Query-Level Rows",
        "",
        "| Query | Engine | Region | Measurement | Organic Position | AI Answer | AI Cited URLs | Site URL Cited | Brand/Product Mentioned | Site Cited URLs |",
        "| --- | --- | --- | --- | ---: | --- | ---: | --- | --- | --- |",
    ])
    for row in rows:
        lines.append(
            f"| {escape_md(row.get('query', ''))} | {escape_md(row.get('engine', ''))} | {escape_md(row.get('region', ''))} | "
            f"{escape_md(row.get('measurement_status', ''))} | {row.get('organic_position') or ''} | {yesno_or_na(row.get('ai_answer_present'), row.get('metric_eligible'))} | "
            f"{row.get('ai_citation_count') if truthy(row.get('metric_eligible')) else 'n/a'} | {yesno_or_na(row.get('site_url_cited_in_ai'), row.get('metric_eligible'))} | "
            f"{yesno_or_na(row.get('brand_or_product_mentioned'), row.get('metric_eligible'))} | {escape_md(row.get('site_cited_urls', ''))} |"
        )
    lines.extend(["", "## Full Log And Dynamics", ""])
    for label, path in paths.items():
        lines.append(f"- {label}: {portable_ref(root, path)}")
    if summary.get("errors"):
        lines.extend(["", "## Warnings", ""])
        lines.extend([f"- {escape_md(error)}" for error in summary.get("errors", [])])
    lines.extend([
        "",
        "## Interpretation",
        "",
        "- Organic position and AI visibility are separate metrics.",
        "- A query can have an AI answer without citing the user's site.",
        "- URL citation and brand mention are separate layers: one can pass while the other fails.",
        "- Brand/product mention means the AI answer body contains one of the confirmed brand/product variants; do not infer it from URL citation alone.",
        "- The append-only history files are the source for dynamics across repeated measurements.",
    ])
    return "\n".join(lines) + "\n"


def render_citation_source_inventory(root: Path, summary: dict[str, Any], rows: list[dict[str, Any]], inventory_rows: list[dict[str, Any]], paths: dict[str, Path]) -> str:
    cited_rows = [row for row in inventory_rows if row.get("cited_url")]
    cited_domains = unique_nonempty([str(row.get("cited_domain", "")) for row in cited_rows])
    user_site_rows = [row for row in cited_rows if truthy(row.get("is_user_site_citation"))]
    brand_rows = [row for row in rows if truthy(row.get("brand_or_product_mentioned"))]
    no_citation_rows = [row for row in rows if truthy(row.get("metric_eligible")) and truthy(row.get("ai_answer_present")) and safe_int(row.get("ai_citation_count")) in {None, 0}]
    lines = [
        "# CITATION_SOURCE_INVENTORY",
        "",
        f"Observed: {summary.get('observed_at')}",
        f"Run ID: {summary.get('run_id')}",
        f"Topic: {summary.get('topic')}",
        f"Domain: {summary.get('domain') or 'not provided'}",
        f"Brand variants tracked: {', '.join(summary.get('brand_variants', [])) or 'none'}",
        "",
        "## URL Citation And Brand Mention Totals",
        "",
        f"- query x engine x region checks: {len(rows)}",
        f"- AI citation URL rows: {len(cited_rows)}",
        f"- unique cited domains: {len(cited_domains)}",
        f"- user-domain citation URL rows: {len(user_site_rows)}",
        f"- checks with answer-body brand/product mention: {len(brand_rows)}",
        f"- checks with AI answer but zero parsed citation URLs: {len(no_citation_rows)}",
        "",
        "## Query Checks",
        "",
        "| Query | Engine | Region | Organic Position | AI | AI Cited URLs | User URL Cited | Brand Mention | Mentioned Terms |",
        "| --- | --- | --- | ---: | --- | ---: | --- | --- | --- |",
    ]
    for row in rows:
        lines.append(
            f"| {escape_md(row.get('query', ''))} | {escape_md(row.get('engine', ''))} | {escape_md(row.get('region', ''))} | "
            f"{row.get('organic_position') or ''} | {yesno(row.get('ai_answer_present'))} | {row.get('ai_citation_count') or 0} | "
            f"{yesno(row.get('site_url_cited_in_ai'))} | {yesno(row.get('brand_or_product_mentioned'))} | {escape_md(row.get('mentioned_terms', ''))} |"
        )
    lines.extend([
        "",
        "## URL-Level Citation Rows",
        "",
        "| Query | Engine | Region | Cited URL | Domain | User Site | Brand Mention | Source Refs |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ])
    for row in inventory_rows:
        lines.append(
            f"| {escape_md(row.get('query', ''))} | {escape_md(row.get('engine', ''))} | {escape_md(row.get('region', ''))} | "
            f"{escape_md(row.get('cited_url', ''))} | {escape_md(row.get('cited_domain', ''))} | {yesno(row.get('is_user_site_citation'))} | "
            f"{yesno(row.get('brand_or_product_mentioned'))} | {escape_md(row.get('source_refs', ''))} |"
        )
    lines.extend(["", "## Files", ""])
    for label, path in paths.items():
        lines.append(f"- {label}: {portable_ref(root, path)}")
    lines.extend([
        "",
        "## Reading Rule",
        "",
        "- `User Site` is URL/domain citation.",
        "- `Brand Mention` is answer-body brand/product mention.",
        "- These are independent layers; do not treat one as proof of the other.",
    ])
    return "\n".join(lines) + "\n"


def yesno(value: Any) -> str:
    return "yes" if truthy(value) else "no"


def yesno_or_na(value: Any, metric_eligible: Any) -> str:
    return yesno(value) if truthy(metric_eligible) else "n/a"
