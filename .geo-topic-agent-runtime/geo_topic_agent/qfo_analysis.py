from __future__ import annotations

import hashlib
import html
import ipaddress
import json
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from .core import (
    CONFIG_REL,
    DATA_REL,
    IMPORT_REL,
    PROCESSED_REL,
    RAW_REL,
    REPORTS_REL,
    XMLRIVER_ENDPOINTS,
    XMLRIVER_MAX_THREADS,
    collect_xmlriver_plan_parallel,
    decode_text_bytes,
    ensure_dirs,
    escape_md,
    external_approval_ledger_path,
    find_project_root,
    full_workflow_prerequisite_gate,
    load_env_values,
    is_xmlriver_error_payload,
    load_external_approval_records,
    normalize_ai_citation_url,
    normalize_artifact_value,
    normalize_domain,
    normalize_ws,
    observation,
    portable_ref,
    read_csv,
    read_json,
    read_text_lossless,
    repair_text_encoding,
    resolve_xmlriver_region,
    sha12,
    slugify,
    split_csv,
    update_state,
    utc_now,
    write_csv,
    write_json,
    write_raw_bytes,
    write_text,
    xmlriver_accounts,
    validate_serp_top_url_depth,
    xmlriver_paid_request_count,
    xmlriver_paid_request_plan,
    xmlriver_serp_page_count,
    xmlriver_thread_scope,
    XMLRIVER_SERP_URLS_PER_PAGE,
)


QFO_CITATION_TITLE_MAX_WORKERS = 10
QFO_CITATION_TITLE_MAX_BYTES = 5_000_000
QFO_CITATION_TITLE_TIMEOUT_SECONDS = 30
QFO_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
QFO_DERIVED_TITLE_SOURCES = {"organic_url_match", "html_title", "og:title"}


QFO_EVIDENCE_MANIFEST_VERSION = 1
QFO_PAID_APPROVAL_EVIDENCE_ID = "qfo_xmlriver_live_run"
QFO_CONTENT_PLAN_APPROVAL_EVIDENCE_ID = "qfo_content_plan_approval"
QFO_AI_EVIDENCE_FIELDS = (
    "answer_id",
    "prompt",
    "provider",
    "model",
    "target_geo",
    "user_search_geo",
    "language",
    "answer_text",
    "citation_url",
    "date",
    "raw_ref",
    "citation_source",
    "ai_content_status",
)


def qfo_canonical_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): qfo_canonical_value(value[key]) for key in sorted(value, key=lambda item: str(item))}
    if isinstance(value, (list, tuple)):
        return [qfo_canonical_value(item) for item in value]
    if isinstance(value, str):
        return repair_text_encoding(value).strip()
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return repair_text_encoding(str(value)).strip()


def qfo_sha256_json(value: Any) -> str:
    encoded = json.dumps(
        qfo_canonical_value(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def qfo_file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def qfo_project_path(root: Path, value: str | Path) -> Path:
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = root / candidate
    resolved = candidate.resolve(strict=False)
    project_root = root.resolve(strict=False)
    try:
        resolved.relative_to(project_root)
    except ValueError as exc:
        raise ValueError(f"Artifact path escapes project root: {value}") from exc
    return resolved


def load_qfo_saved_scope(root: Path) -> dict[str, Any]:
    context_path = root / DATA_REL / "project_context.json"
    config_path = root / CONFIG_REL
    context = read_json(context_path, {}) if context_path.exists() else {}
    config = read_json(config_path, {}) if config_path.exists() else {}
    errors: list[str] = []
    if not isinstance(context, dict) or not context.get("updated_at"):
        return {
            "authoritative": False,
            "engines": [],
            "region": "",
            "language": "",
            "depth": None,
            "source_refs": [str(path) for path in (context_path, config_path) if path.exists()],
            "errors": ["Saved project context is missing or has no updated_at authority marker."],
        }

    engines = [
        str(engine).strip().lower()
        for engine in context.get("search_engines", [])
        if str(engine).strip().lower() in XMLRIVER_ENDPOINTS
    ]
    region_value = context.get("xmlriver_region") or context.get("region_alias") or ""
    region_data = context.get("region", {})
    if not region_value and isinstance(region_data, str):
        region_value = region_data
    elif not region_value and isinstance(region_data, dict):
        region_value = region_data.get("xmlriver_region") or region_data.get("alias") or ""
        if not region_value:
            country = normalize_ws(str(region_data.get("country", "")))
            city = normalize_ws(str(region_data.get("city", "")))
            region_value = f"{country}-{city}" if country and city else country
    language_value = normalize_ws(str(context.get("language") or (region_data.get("language") if isinstance(region_data, dict) else "") or ""))

    search_config = config.get("search_engines", {}) if isinstance(config, dict) else {}
    depth_values: set[int] = set()
    for engine in engines:
        engine_config = search_config.get(engine, {}) if isinstance(search_config, dict) else {}
        try:
            value = int(engine_config.get("depth"))
        except (TypeError, ValueError):
            continue
        if value > 0:
            depth_values.add(value)
    saved_depth = next(iter(depth_values)) if len(depth_values) == 1 else None
    if not engines:
        errors.append("Saved project context has no enabled XMLRiver Google/Yandex engines.")
    if not region_value:
        errors.append("Saved project context has no unambiguous XMLRiver region.")
    if not language_value:
        errors.append("Saved project context has no language.")
    if saved_depth is None:
        errors.append("Saved project context has no single authoritative URL depth for all enabled engines.")
    return {
        "authoritative": not errors,
        "engines": engines,
        "region": repair_text_encoding(str(region_value)),
        "language": repair_text_encoding(language_value),
        "depth": saved_depth,
        "source_refs": [str(path) for path in (context_path, config_path) if path.exists()],
        "errors": errors,
    }


def resolve_qfo_scope(
    root: Path,
    engines: str,
    region: str,
    language: str,
    depth: int | None,
) -> tuple[dict[str, Any], list[str]]:
    saved = load_qfo_saved_scope(root)
    explicit_engines = [engine for engine in split_csv(engines) if engine]
    engine_values = [engine.lower() for engine in explicit_engines]
    region_value = normalize_ws(region)
    language_value = normalize_ws(language)
    depth_value = depth
    errors: list[str] = []
    if not engine_values:
        errors.append("QFO scope is unresolved: pass --engines explicitly; saved/default scope is never consumed by QFO.")
    if not region_value:
        errors.append("QFO scope is unresolved: pass --region explicitly; saved/default scope is never consumed by QFO.")
    if not language_value:
        errors.append("QFO scope is unresolved: pass --language explicitly; saved/default scope is never consumed by QFO.")
    if depth_value is None:
        errors.append("QFO scope is unresolved: pass --depth explicitly as a top-N URL count; saved/default depth is never consumed by QFO.")
    return {
        "engines": engine_values,
        "region": region_value,
        "language": language_value,
        "depth": depth_value,
        "sources": {
            "engines": "cli" if explicit_engines else "unresolved",
            "region": "cli" if region else "unresolved",
            "language": "cli" if language else "unresolved",
            "depth": "cli" if depth is not None else "unresolved",
        },
        "saved_scope_suggestion_only": saved,
        "saved_scope_consumed": False,
    }, errors


def build_qfo_paid_scope_binding(
    seed_rows: list[dict[str, Any]],
    plan_rows: list[dict[str, Any]],
    engines: list[str],
    region: str,
    language: str,
    depth: int,
) -> dict[str, Any]:
    provider_region_params = {
        engine: resolve_xmlriver_region(engine, region, language)
        for engine in engines
    }
    page_plan = []
    for row in xmlriver_paid_request_plan(plan_rows, depth):
        engine = str(row.get("engine", ""))
        page_plan.append({
            "paid_request_id": row.get("paid_request_id", ""),
            "query_engine_pair_id": row.get("query_engine_pair_id", ""),
            "query": normalize_ws(str(row.get("query", ""))),
            "engine": engine,
            "provider_params": provider_region_params.get(engine, {}),
            "requested_top_urls": depth,
            "page_param": row.get("page_param"),
            "include_ai": int(row.get("serp_page_index") or 0) == 1,
        })
    normalized_queries = [normalize_ws(str(row.get("query", ""))) for row in seed_rows]
    return {
        "provider": "xmlriver",
        "normalized_queries": normalized_queries,
        "normalized_queries_sha256": qfo_sha256_json(normalized_queries),
        "engines": engines,
        "provider_region_params": provider_region_params,
        "region": region,
        "language": language,
        "requested_top_urls": depth,
        "depth_semantics": "top-N organic URL count, not pagination page count",
        "serp_pages_per_query_engine": xmlriver_serp_page_count(depth),
        "page_plan": page_plan,
        "planned_paid_requests": len(page_plan),
        "include_ai": True,
        "xmlriver_max_threads": XMLRIVER_MAX_THREADS,
    }


def write_qfo_xmlriver_approval_template(
    path: Path,
    topic_slug: str,
    binding: dict[str, Any],
    reviewed_plan_hash: str,
) -> None:
    write_json(path, {
        "approvals": [{
            "evidence_id": QFO_PAID_APPROVAL_EVIDENCE_ID,
            "status": "pending_user_approval",
            "approved_by": "",
            "approval_ref": "",
            "approved_at": "",
            "topic_slug": topic_slug,
            "scope": {
                "provider": "xmlriver",
                "reviewed_plan_hash": reviewed_plan_hash,
                "qfo_plan_binding": binding,
            },
            "budget": {
                "paid_approved": False,
                "limit_type": "exact_request_count",
                "maximum_request_count": binding.get("planned_paid_requests", 0),
            },
        }],
    })


def validate_qfo_xmlriver_approval(
    root: Path,
    topic_slug: str,
    binding: dict[str, Any],
    computed_plan_hash: str,
    approval_ref: str,
    reviewed_plan_hash: str,
) -> tuple[Path, list[str], dict[str, Any]]:
    ledger_path, records = load_external_approval_records(root)
    errors: list[str] = []
    if not approval_ref:
        errors.append("Live QFO requires --approval-ref pointing to an external approval-ledger record.")
    if not reviewed_plan_hash:
        errors.append("Live QFO requires --reviewed-plan-hash from the reviewed dry-run plan.")
    elif reviewed_plan_hash != computed_plan_hash:
        errors.append("--reviewed-plan-hash does not match the exact normalized queries/scope/page plan for this invocation.")
    matching = [
        record for record in records
        if record.get("evidence_id") == QFO_PAID_APPROVAL_EVIDENCE_ID
        and record.get("status") == "approved"
        and record.get("topic_slug") in {topic_slug, "*"}
        and record.get("approval_ref") == approval_ref
    ]
    accepted: dict[str, Any] = {}
    if approval_ref and not matching:
        errors.append(f"No approved {QFO_PAID_APPROVAL_EVIDENCE_ID} ledger record matches approval_ref={approval_ref!r}.")
    if len(matching) > 1:
        errors.append(
            f"Approval ref {approval_ref!r} is ambiguous: expected exactly one external paid-run approval record, found {len(matching)}."
        )
    for record in matching:
        record_errors: list[str] = []
        for field in ("approval_ref", "approved_at"):
            if not normalize_ws(str(record.get(field, ""))):
                record_errors.append(f"approval {field} is missing")
        approver_error = qfo_external_approver_error(record.get("approved_by"))
        if approver_error:
            record_errors.append(f"approval {approver_error}")
        scope = record.get("scope", {})
        budget = record.get("budget", {})
        if not isinstance(scope, dict):
            record_errors.append("approval scope must be an object")
            scope = {}
        if not isinstance(budget, dict):
            record_errors.append("approval budget must be an object")
            budget = {}
        if scope.get("reviewed_plan_hash") != computed_plan_hash:
            record_errors.append("approval scope.reviewed_plan_hash does not match this invocation")
        if qfo_canonical_value(scope.get("qfo_plan_binding", {})) != qfo_canonical_value(binding):
            record_errors.append("approval scope.qfo_plan_binding is not an exact match")
        if budget.get("paid_approved") is not True:
            record_errors.append("approval budget.paid_approved must be true")
        try:
            approved_count = int(budget.get("maximum_request_count"))
        except (TypeError, ValueError):
            approved_count = -1
        if approved_count != int(binding.get("planned_paid_requests", 0)):
            record_errors.append("approval budget.maximum_request_count must equal the exact paid page-request count")
        if not record_errors:
            accepted = record
            break
        errors.extend(record_errors)
    return ledger_path, errors, accepted


def qfo_ai_row_has_provider_error(row: dict[str, Any]) -> bool:
    for field in ("answer_text", "error", "message", "provider_message", "raw_response"):
        value = repair_text_encoding(str(row.get(field, "")))
        if value and is_xmlriver_error_payload(value):
            return True
    return False


def qfo_processed_projection(kind: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if kind == "ai":
        return [
            {field: normalize_artifact_value(row.get(field, "")) for field in QFO_AI_EVIDENCE_FIELDS}
            for row in rows
        ]
    return [qfo_canonical_value(row) for row in rows]



def reconcile_qfo_paid_requests(
    root: Path,
    raw_dir: Path,
    binding: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    """Reconcile every approved page-plan request with one successful ledger and raw response."""
    errors: list[str] = []
    page_plan = binding.get("page_plan", [])
    if not isinstance(page_plan, list):
        page_plan = []
        errors.append("QFO scope_binding.page_plan must be a list.")

    expected_by_id: dict[str, dict[str, Any]] = {}
    for index, raw_expected in enumerate(page_plan, start=1):
        if not isinstance(raw_expected, dict):
            errors.append(f"QFO page_plan row {index} is not an object.")
            continue
        paid_request_id = normalize_ws(str(raw_expected.get("paid_request_id", "")))
        if not paid_request_id:
            errors.append(f"QFO page_plan row {index} is missing paid_request_id.")
            continue
        if paid_request_id in expected_by_id:
            errors.append(f"QFO page_plan has duplicate paid_request_id={paid_request_id!r}.")
            continue
        expected_by_id[paid_request_id] = raw_expected

    try:
        recorded_planned = int(binding.get("planned_paid_requests", -1))
    except (TypeError, ValueError):
        recorded_planned = -1
    if recorded_planned != len(page_plan):
        errors.append(
            "QFO scope_binding planned_paid_requests does not equal the exact page_plan row count."
        )

    metadata_by_id: dict[str, list[tuple[Path, dict[str, Any]]]] = defaultdict(list)
    metadata_paths = sorted(raw_dir.glob("*.request.json")) if raw_dir.exists() else []
    for meta_path in metadata_paths:
        payload = read_json(meta_path, {})
        if not isinstance(payload, dict):
            errors.append(f"QFO request metadata ledger is not a JSON object: {meta_path}")
            continue
        paid_request_id = normalize_ws(str(payload.get("paid_request_id", "")))
        if not paid_request_id:
            errors.append(f"QFO request metadata ledger is missing paid_request_id: {meta_path}")
            continue
        metadata_by_id[paid_request_id].append((meta_path, payload))

    for paid_request_id in sorted(set(metadata_by_id) - set(expected_by_id)):
        errors.append(
            f"Stale QFO request metadata ledger is not present in the exact page_plan: {paid_request_id}."
        )
    for paid_request_id, records in sorted(metadata_by_id.items()):
        if len(records) > 1:
            errors.append(
                f"Duplicate QFO request metadata ledgers for paid_request_id={paid_request_id!r}: {len(records)}."
            )

    request_rows: list[dict[str, Any]] = []
    succeeded = 0
    provider_error_count = 0
    for paid_request_id, expected in expected_by_id.items():
        records = metadata_by_id.get(paid_request_id, [])
        row_errors: list[str] = []
        meta_path: Path | None = None
        metadata: dict[str, Any] = {}
        if len(records) != 1:
            row_errors.append(
                f"expected exactly one request metadata ledger, found {len(records)}"
            )
        else:
            meta_path, metadata = records[0]

        expected_query = normalize_ws(str(expected.get("query", "")))
        expected_engine = normalize_ws(str(expected.get("engine", ""))).casefold()
        expected_page = expected.get("page_param")
        expected_depth = expected.get("requested_top_urls")
        expected_include_ai = bool(expected.get("include_ai"))
        expected_pair_id = str(expected.get("query_engine_pair_id", ""))

        if metadata:
            actual_checks = (
                ("paid_request_id", normalize_ws(str(metadata.get("paid_request_id", ""))), paid_request_id),
                ("query", normalize_ws(str(metadata.get("query", ""))), expected_query),
                ("engine", normalize_ws(str(metadata.get("engine", ""))).casefold(), expected_engine),
                ("page_param", str(metadata.get("page_param", "")), str(expected_page)),
                ("requested_top_urls", str(metadata.get("requested_top_urls", "")), str(expected_depth)),
                ("region", normalize_ws(str(metadata.get("region", ""))), normalize_ws(str(binding.get("region", "")))),
                ("language", normalize_ws(str(metadata.get("language", ""))), normalize_ws(str(binding.get("language", "")))),
                ("query_engine_pair_id", str(metadata.get("query_engine_pair_id", "")), expected_pair_id),
            )
            for field, actual, expected_value in actual_checks:
                if actual != expected_value:
                    row_errors.append(
                        f"{field} mismatch: expected {expected_value!r}, found {actual!r}"
                    )
            if bool(metadata.get("include_ai")) != expected_include_ai:
                row_errors.append(
                    f"include_ai mismatch: expected {expected_include_ai!r}, found {bool(metadata.get('include_ai'))!r}"
                )
            params = metadata.get("params", {})
            if not isinstance(params, dict):
                row_errors.append("params must be an object")
                params = {}
            expected_provider_params = expected.get("provider_params", {})
            if not isinstance(expected_provider_params, dict):
                row_errors.append("page_plan provider_params must be an object")
                expected_provider_params = {}
            for name, expected_value in expected_provider_params.items():
                if qfo_canonical_value(params.get(name)) != qfo_canonical_value(expected_value):
                    row_errors.append(
                        f"provider param {name!r} mismatch: expected {expected_value!r}, found {params.get(name)!r}"
                    )
            if normalize_ws(str(params.get("query", ""))) != expected_query:
                row_errors.append("provider params.query does not match the exact page_plan query")
            if str(params.get("page", "")) != str(expected_page):
                row_errors.append("provider params.page does not match the exact page_plan page")
            if expected_include_ai:
                if str(params.get("ai", "")) != "1":
                    row_errors.append("provider params.ai must be 1 for the first page request")
            elif "ai" in params:
                row_errors.append("provider params.ai must be absent after the first page request")
            metadata_status = normalize_ws(str(metadata.get("status", ""))).casefold()
            if metadata_status != "success":
                row_errors.append(f"request metadata status is not success: {metadata_status or 'missing'}")
                if metadata_status == "error" or metadata.get("error_type") or metadata.get("error_summary"):
                    provider_error_count += 1
            if not normalize_ws(str(metadata.get("completed_at", ""))):
                row_errors.append("request metadata completed_at is missing")

        raw_path: Path | None = None
        raw_hash = ""
        if meta_path is not None:
            raw_path = meta_path.with_name(
                meta_path.name[: -len(".request.json")] + ".xml"
            )
            same_id_raw_paths = sorted(raw_dir.glob(f"{paid_request_id}_*.xml"))
            if len(same_id_raw_paths) != 1:
                row_errors.append(
                    f"expected exactly one raw response file, found {len(same_id_raw_paths)}"
                )
            elif same_id_raw_paths[0].resolve(strict=False) != raw_path.resolve(strict=False):
                row_errors.append("raw response filename does not match its request metadata ledger")
            if not raw_path.exists() or not raw_path.is_file():
                row_errors.append("matching raw response file is missing")
            else:
                raw_bytes = raw_path.read_bytes()
                raw_hash = hashlib.sha256(raw_bytes).hexdigest()
                if not raw_bytes:
                    row_errors.append("matching raw response file is empty")
                if metadata.get("raw_sha256") != raw_hash:
                    row_errors.append("request metadata raw_sha256 does not match the raw response file")
                try:
                    recorded_raw_bytes = int(metadata.get("raw_bytes", -1))
                except (TypeError, ValueError):
                    recorded_raw_bytes = -1
                if recorded_raw_bytes != len(raw_bytes):
                    row_errors.append("request metadata raw_bytes does not match the raw response file")
                try:
                    raw_text, _ = decode_text_bytes(
                        raw_bytes,
                        str(metadata.get("content_type", "application/xml")),
                        source=str(raw_path),
                    )
                except (UnicodeError, ValueError):
                    raw_text = raw_bytes.decode("utf-8", errors="replace")
                if is_xmlriver_error_payload(raw_text):
                    row_errors.append("raw response contains an XMLRiver/provider error payload")
                    provider_error_count += 1

        request_status = "success" if not row_errors else "failed"
        if request_status == "success":
            succeeded += 1
        request_rows.append({
            "paid_request_id": paid_request_id,
            "query_engine_pair_id": expected.get("query_engine_pair_id", ""),
            "query": expected_query,
            "engine": expected_engine,
            "page_param": expected_page,
            "requested_top_urls": expected_depth,
            "include_ai": expected_include_ai,
            "request_meta_ref": portable_ref(root, meta_path) if meta_path else "",
            "request_meta_sha256": qfo_file_sha256(meta_path) if meta_path and meta_path.exists() else "",
            "raw_response_ref": portable_ref(root, raw_path) if raw_path and raw_path.exists() else "",
            "raw_response_sha256": raw_hash,
            "status": request_status,
            "errors": row_errors,
        })
        errors.extend(
            f"{paid_request_id}: {message}" for message in row_errors
        )

    planned = len(page_plan)
    failed = planned - succeeded
    complete = (
        planned > 0
        and len(expected_by_id) == planned
        and succeeded == planned
        and failed == 0
        and provider_error_count == 0
        and not errors
    )
    reconciliation = {
        "status": "complete" if complete else "incomplete",
        "planned_paid_requests": planned,
        "paid_requests_succeeded": succeeded,
        "paid_requests_failed": failed,
        "provider_error_count": provider_error_count,
        "request_metadata_ledgers_found": len(metadata_paths),
        "request_rows": request_rows,
    }
    reconciliation["reconciliation_sha256"] = qfo_sha256_json(reconciliation)
    return reconciliation, errors


def build_qfo_evidence_manifest(
    root: Path,
    manifest_path: Path,
    run_id: str,
    raw_dir: Path,
    binding: dict[str, Any],
    reviewed_plan_hash: str,
    serp_path: Path,
    ai_path: Path,
    serp_rows: list[dict[str, Any]],
    ai_rows: list[dict[str, Any]],
    provider_errors_excluded: list[str],
) -> dict[str, Any]:
    request_reconciliation, reconciliation_errors = reconcile_qfo_paid_requests(
        root,
        raw_dir,
        binding,
    )
    raw_artifacts = []
    for path in sorted(item for item in raw_dir.rglob("*") if item.is_file()):
        raw_artifacts.append({
            "path": portable_ref(root, path),
            "sha256": qfo_file_sha256(path),
            "bytes": path.stat().st_size,
        })
    serialized_serp_rows = read_csv(serp_path)
    serialized_ai_rows = read_csv(ai_path)
    manifest = {
        "manifest_version": QFO_EVIDENCE_MANIFEST_VERSION,
        "manifest_type": "qfo_xmlriver_same_run_evidence",
        "status": (
            "complete"
            if request_reconciliation.get("status") == "complete"
            and not provider_errors_excluded
            and not reconciliation_errors
            else "incomplete"
        ),
        "run_id": run_id,
        "raw_dir": portable_ref(root, raw_dir),
        "reviewed_plan_hash": reviewed_plan_hash,
        "scope_binding": binding,
        "processed_artifacts": {
            "serp": {
                "path": portable_ref(root, serp_path),
                "sha256": qfo_file_sha256(serp_path),
                "semantic_sha256": qfo_sha256_json(qfo_processed_projection("serp", serialized_serp_rows)),
                "rows": len(serialized_serp_rows),
            },
            "ai": {
                "path": portable_ref(root, ai_path),
                "sha256": qfo_file_sha256(ai_path),
                "semantic_sha256": qfo_sha256_json(qfo_processed_projection("ai", serialized_ai_rows)),
                "rows": len(serialized_ai_rows),
            },
        },
        "raw_artifacts": raw_artifacts,
        "request_reconciliation": request_reconciliation,
        "reconciliation_errors": reconciliation_errors,
        "provider_error_payloads_excluded": len(provider_errors_excluded),
        "provider_error_exclusion_notes": provider_errors_excluded,
        "generated_at": utc_now(),
    }
    write_json(manifest_path, manifest)
    return manifest


def validate_qfo_evidence_manifest(
    root: Path,
    manifest_path: Path,
    binding: dict[str, Any],
    reviewed_plan_hash: str,
    serp_path: Path,
    ai_path: Path,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str], dict[str, Any]]:
    errors: list[str] = []
    if not manifest_path.exists() or not manifest_path.is_file():
        return [], [], [f"Same-run QFO evidence manifest not found: {manifest_path}"], {}
    manifest = read_json(manifest_path, {})
    if not isinstance(manifest, dict):
        return [], [], ["QFO evidence manifest must be a JSON object."], {}
    if manifest.get("manifest_version") != QFO_EVIDENCE_MANIFEST_VERSION:
        errors.append("QFO evidence manifest version is unsupported.")
    if manifest.get("manifest_type") != "qfo_xmlriver_same_run_evidence":
        errors.append("QFO evidence manifest type is invalid.")
    if manifest.get("status") != "complete":
        errors.append("QFO evidence manifest is not complete.")
    if manifest.get("reviewed_plan_hash") != reviewed_plan_hash:
        errors.append("QFO evidence manifest reviewed_plan_hash does not match the current exact scope.")
    if qfo_canonical_value(manifest.get("scope_binding", {})) != qfo_canonical_value(binding):
        errors.append("QFO evidence manifest scope binding does not match queries, engines, region, language, depth, page plan, and AI flag.")
    try:
        excluded_provider_errors = int(manifest.get("provider_error_payloads_excluded", 0))
    except (TypeError, ValueError):
        excluded_provider_errors = -1
    if excluded_provider_errors != 0:
        errors.append("QFO evidence manifest records provider-error payloads; partial/error evidence cannot be reused.")
    recorded_reconciliation_errors = manifest.get("reconciliation_errors", [])
    if not isinstance(recorded_reconciliation_errors, list) or recorded_reconciliation_errors:
        errors.append("QFO evidence manifest records unresolved paid-request reconciliation errors.")

    serp_rows = read_csv(serp_path) if serp_path.exists() else []
    ai_rows = read_csv(ai_path) if ai_path.exists() else []
    contaminated = [index for index, row in enumerate(ai_rows, start=1) if qfo_ai_row_has_provider_error(row)]
    if contaminated:
        errors.append(
            "Reused AI evidence contains XMLRiver/provider error payload rows; quarantined row indexes: "
            + ", ".join(str(index) for index in contaminated[:20])
        )
        ai_rows = [row for index, row in enumerate(ai_rows, start=1) if index not in set(contaminated)]

    processed = manifest.get("processed_artifacts", {})
    for kind, path, rows in (("serp", serp_path, serp_rows), ("ai", ai_path, ai_rows)):
        record = processed.get(kind, {}) if isinstance(processed, dict) else {}
        if not isinstance(record, dict):
            errors.append(f"Manifest processed_artifacts.{kind} is missing.")
            continue
        try:
            recorded_path = qfo_project_path(root, str(record.get("path", "")))
        except ValueError as exc:
            errors.append(str(exc))
            continue
        if recorded_path != path.resolve(strict=False):
            errors.append(f"Manifest processed_artifacts.{kind}.path does not match the canonical QFO artifact.")
        if not path.exists():
            errors.append(f"Processed {kind} artifact is missing: {path}")
            continue
        if record.get("sha256") != qfo_file_sha256(path):
            errors.append(f"Processed {kind} artifact SHA-256 mismatch.")
        semantic_hash = qfo_sha256_json(qfo_processed_projection(kind, rows))
        if record.get("semantic_sha256") != semantic_hash:
            errors.append(f"Processed {kind} semantic hash mismatch.")
        try:
            recorded_rows = int(record.get("rows", -1))
        except (TypeError, ValueError):
            recorded_rows = -1
        if recorded_rows != len(rows):
            errors.append(f"Processed {kind} row-count mismatch.")

    run_id = normalize_ws(str(manifest.get("run_id", "")))
    try:
        raw_dir = qfo_project_path(root, str(manifest.get("raw_dir", "")))
    except ValueError as exc:
        errors.append(str(exc))
        raw_dir = root
    raw_dir_is_bound = bool(run_id and raw_dir.name == run_id)
    if not raw_dir_is_bound:
        errors.append("Manifest raw_dir is not bound to its run_id.")
    if raw_dir_is_bound:
        actual_reconciliation, reconciliation_errors = reconcile_qfo_paid_requests(
            root,
            raw_dir,
            binding,
        )
        errors.extend(
            f"Paid-request reconciliation: {message}" for message in reconciliation_errors
        )
        recorded_reconciliation = manifest.get("request_reconciliation", {})
        if qfo_canonical_value(recorded_reconciliation) != qfo_canonical_value(actual_reconciliation):
            errors.append("Manifest request_reconciliation does not match the current request ledgers and raw responses.")
        if actual_reconciliation.get("status") != "complete":
            errors.append("Paid-request reconciliation is incomplete; approved reuse is rejected.")
        if int(actual_reconciliation.get("planned_paid_requests", -1)) != len(binding.get("page_plan", [])):
            errors.append("Paid-request reconciliation planned count does not match the exact page_plan.")
        if int(actual_reconciliation.get("paid_requests_succeeded", -1)) != len(binding.get("page_plan", [])):
            errors.append("Paid-request reconciliation succeeded count does not match the exact page_plan.")
        if int(actual_reconciliation.get("paid_requests_failed", -1)) != 0:
            errors.append("Paid-request reconciliation contains failed requests.")
        if int(actual_reconciliation.get("provider_error_count", -1)) != 0:
            errors.append("Paid-request reconciliation detected provider errors.")
    raw_records = manifest.get("raw_artifacts", [])
    raw_hashes: dict[Path, str] = {}
    if not isinstance(raw_records, list) or not raw_records:
        errors.append("Manifest raw_artifacts inventory is empty.")
    else:
        for record in raw_records:
            if not isinstance(record, dict):
                errors.append("Manifest raw artifact record is not an object.")
                continue
            try:
                raw_path = qfo_project_path(root, str(record.get("path", "")))
                raw_path.relative_to(raw_dir)
            except (ValueError, TypeError):
                errors.append(f"Raw artifact is outside the manifest run directory: {record.get('path', '')}")
                continue
            if not raw_path.exists() or not raw_path.is_file():
                errors.append(f"Raw artifact is missing: {raw_path}")
                continue
            actual_hash = qfo_file_sha256(raw_path)
            if record.get("sha256") != actual_hash:
                errors.append(f"Raw artifact SHA-256 mismatch: {raw_path}")
            if raw_path in raw_hashes:
                errors.append(f"Raw artifact is duplicated in the manifest inventory: {raw_path}")
            raw_hashes[raw_path] = actual_hash
    if raw_dir_is_bound and raw_dir.exists():
        actual_raw_paths = {
            path.resolve(strict=False)
            for path in raw_dir.rglob("*")
            if path.is_file()
        }
        recorded_raw_paths = set(raw_hashes)
        for unlisted_path in sorted(actual_raw_paths - recorded_raw_paths):
            errors.append(f"Unlisted late/stale raw artifact exists in the same run: {unlisted_path}")
        for stale_path in sorted(recorded_raw_paths - actual_raw_paths):
            errors.append(f"Manifest raw artifact no longer exists in the same run: {stale_path}")
    for row in [*serp_rows, *ai_rows]:
        raw_ref = normalize_ws(str(row.get("raw_ref", "")))
        if not raw_ref:
            errors.append("Processed evidence row is missing raw_ref.")
            continue
        try:
            row_raw_path = qfo_project_path(root, raw_ref)
            row_raw_path.relative_to(raw_dir)
        except (ValueError, TypeError):
            errors.append(f"Processed evidence raw_ref is outside the same run: {raw_ref}")
            continue
        if row_raw_path not in raw_hashes:
            errors.append(f"Processed evidence raw_ref is not in the manifest raw inventory: {raw_ref}")
    return serp_rows, ai_rows, errors, manifest


class _QFOPageTitleParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.in_title = False
        self.title_seen = False
        self.title_parts: list[str] = []
        self.og_title = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.casefold()
        if tag == "title":
            if not self.title_seen:
                self.title_seen = True
                self.in_title = True
            return
        if tag != "meta" or self.og_title:
            return
        values = {str(key).casefold(): str(value or "") for key, value in attrs}
        property_name = values.get("property") or values.get("name") or ""
        if property_name.casefold() == "og:title":
            self.og_title = normalize_ws(html.unescape(values.get("content", "")))

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() == "title" and self.in_title:
            self.in_title = False

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)


def qfo_split_input_text(value: str) -> list[str]:
    if not value:
        return []
    value = repair_text_encoding(value)
    normalized = value.replace(";", "\n")
    if "\n" not in normalized and "," in normalized:
        normalized = normalized.replace(",", "\n")
    rows = []
    for line in normalized.splitlines():
        cleaned = normalize_ws(line.strip().strip("-*").strip())
        if cleaned:
            rows.append(cleaned)
    return rows


def load_qfo_seed_queries(queries: str = "", queries_file: str = "") -> list[dict[str, Any]]:
    values: list[tuple[str, str]] = []
    if queries_file:
        path = Path(queries_file)
        if path.exists():
            suffix = path.suffix.lower()
            if suffix == ".csv":
                for row in read_csv(path):
                    query = row.get("query") or row.get("seed_query") or row.get("keyword") or next((v for v in row.values() if v), "")
                    if query:
                        values.append((normalize_ws(repair_text_encoding(str(query))), str(path)))
            elif suffix == ".json":
                payload = read_json(path, [])
                items = payload.get("queries", []) if isinstance(payload, dict) else payload
                if isinstance(items, list):
                    for item in items:
                        query = item.get("query", "") if isinstance(item, dict) else str(item)
                        if query:
                            values.append((normalize_ws(repair_text_encoding(query)), str(path)))
            else:
                for query in qfo_split_input_text(read_text_lossless(path)):
                    values.append((query, str(path)))
    for query in qfo_split_input_text(queries):
        values.append((query, "inline"))

    rows = []
    for idx, (query, source_ref) in enumerate(values, start=1):
        rows.append({
            "query_id": f"qfo_seed_{idx:04d}",
            "source_order": idx,
            "query": query,
            "source_ref": source_ref,
            "status": "pending_live_xmlriver",
        })
    return rows


def load_qfo_chatgpt_queries(chatgpt_qfo_file: str = "") -> list[dict[str, Any]]:
    if not chatgpt_qfo_file:
        return []
    path = Path(chatgpt_qfo_file)
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    suffix = path.suffix.lower()
    if suffix == ".csv":
        for idx, row in enumerate(read_csv(path), start=1):
            query = row.get("query") or row.get("qfo_query") or row.get("prompt") or row.get("keyword") or next((v for v in row.values() if v), "")
            if query:
                rows.append({"chatgpt_qfo_id": f"chatgpt_qfo_{idx:04d}", "query": normalize_ws(str(query)), "source_ref": str(path)})
    elif suffix == ".json":
        payload = read_json(path, [])
        items = payload.get("queries", []) if isinstance(payload, dict) else payload
        if isinstance(items, list):
            for idx, item in enumerate(items, start=1):
                query = item.get("query", "") if isinstance(item, dict) else str(item)
                if query:
                    rows.append({"chatgpt_qfo_id": f"chatgpt_qfo_{idx:04d}", "query": normalize_ws(query), "source_ref": str(path)})
    else:
        for idx, query in enumerate(qfo_split_input_text(read_text_lossless(path)), start=1):
            rows.append({"chatgpt_qfo_id": f"chatgpt_qfo_{idx:04d}", "query": query, "source_ref": str(path)})
    return rows


def qfo_url_key(value: str) -> str:
    value = normalize_ws(value)
    if not value:
        return ""
    parsed = urllib.parse.urlsplit(value)
    if not parsed.scheme or not parsed.netloc:
        return value
    return urllib.parse.urlunsplit((
        parsed.scheme.casefold(),
        parsed.netloc.casefold(),
        parsed.path or "/",
        parsed.query,
        "",
    ))


def qfo_extract_page_title(page_html: str) -> tuple[str, str]:
    """Return a real HTML title, falling back to og:title without URL inference."""
    if not page_html:
        return "", ""
    parser = _QFOPageTitleParser()
    try:
        parser.feed(page_html)
        parser.close()
    except (ValueError, AssertionError):
        return "", ""
    title = normalize_ws(html.unescape("".join(parser.title_parts)))
    if title:
        return title[:500], "html_title"
    if parser.og_title:
        return parser.og_title[:500], "og:title"
    return "", ""


def _qfo_public_http_url(url: str) -> tuple[bool, str]:
    parsed = urllib.parse.urlsplit(normalize_ws(url))
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.hostname:
        return False, "citation URL is not an absolute HTTP(S) URL"
    hostname = parsed.hostname.casefold().strip(".")
    if hostname == "localhost" or hostname.endswith((".localhost", ".local")):
        return False, "citation URL is not public"
    try:
        port = parsed.port or (443 if parsed.scheme.casefold() == "https" else 80)
    except ValueError as exc:
        return False, f"citation URL has an invalid port: {exc}"

    try:
        literal_address = ipaddress.ip_address(hostname)
    except ValueError:
        literal_address = None
    if literal_address is not None:
        if not literal_address.is_global:
            return False, f"citation URL resolves to non-public address {literal_address}"
        return True, ""

    try:
        address_info = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        return False, f"citation hostname DNS resolution failed: {exc}"
    if not address_info:
        return False, "citation hostname DNS resolution returned no addresses"
    resolved_addresses: set[str] = set()
    for item in address_info:
        address_text = str(item[4][0]).split("%", 1)[0]
        try:
            address = ipaddress.ip_address(address_text)
        except ValueError:
            return False, f"citation hostname resolved to invalid address {address_text}"
        resolved_addresses.add(str(address))
        if not address.is_global:
            return False, f"citation hostname resolves to non-public address {address}"
    if not resolved_addresses:
        return False, "citation hostname DNS resolution returned no usable addresses"
    return True, ""


class _QFOUnsafeRedirectError(urllib.error.URLError):
    pass


class _QFOPublicRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        request: urllib.request.Request,
        response: Any,
        code: int,
        message: str,
        headers: Any,
        new_url: str,
    ) -> urllib.request.Request | None:
        redirect_url = urllib.parse.urljoin(request.full_url, new_url)
        is_public, public_error = _qfo_public_http_url(redirect_url)
        if not is_public:
            raise _QFOUnsafeRedirectError(
                f"unsafe redirect blocked before request: {redirect_url} ({public_error})"
            )
        return super().redirect_request(
            request,
            response,
            code,
            message,
            headers,
            redirect_url,
        )


def qfo_fetch_citation_title(
    url: str,
    root: Path,
    raw_dir: Path,
    network_approved: bool = False,
    timeout: int = 20,
) -> dict[str, Any]:
    """Fetch one cited page, save successful raw bytes, and extract its real title."""
    result: dict[str, Any] = {
        "url": normalize_ws(url),
        "status": "",
        "http_status": "",
        "final_url": "",
        "content_type": "",
        "decoded_with": "",
        "title": "",
        "title_source": "",
        "raw_ref": "",
        "error": "",
    }
    if not network_approved:
        result.update({
            "status": "skipped_no_network_approval",
            "error": "HTTP title enrichment requires network approval",
        })
        return result

    is_public, public_error = _qfo_public_http_url(result["url"])
    if not is_public:
        result.update({"status": "invalid_public_http_url", "error": public_error})
        return result

    bounded_timeout = min(max(int(timeout or 1), 1), QFO_CITATION_TITLE_TIMEOUT_SECONDS)
    request = urllib.request.Request(
        result["url"],
        headers={
            "User-Agent": QFO_BROWSER_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.8",
        },
    )
    opener = urllib.request.build_opener(_QFOPublicRedirectHandler())
    try:
        with opener.open(request, timeout=bounded_timeout) as response:
            result["http_status"] = int(getattr(response, "status", response.getcode()))
            result["final_url"] = normalize_ws(response.geturl())
            result["content_type"] = normalize_ws(response.headers.get("content-type", ""))
            payload = response.read(QFO_CITATION_TITLE_MAX_BYTES + 1)
    except _QFOUnsafeRedirectError as exc:
        result.update({"status": "unsafe_redirect", "error": str(exc.reason)})
        return result
    except urllib.error.HTTPError as exc:
        result.update({
            "status": "http_error",
            "http_status": exc.code,
            "final_url": normalize_ws(exc.geturl() or result["url"]),
            "content_type": normalize_ws(exc.headers.get("content-type", "") if exc.headers else ""),
            "error": f"HTTPError: {exc.reason}",
        })
        return result
    except urllib.error.URLError as exc:
        result.update({"status": "network_error", "error": f"URLError: {exc.reason}"})
        return result
    except (TimeoutError, OSError, ValueError) as exc:
        result.update({"status": "network_error", "error": f"{type(exc).__name__}: {exc}"})
        return result

    final_is_public, final_public_error = _qfo_public_http_url(result["final_url"])
    if not final_is_public:
        result.update({"status": "invalid_final_url", "error": final_public_error})
        return result
    if len(payload) > QFO_CITATION_TITLE_MAX_BYTES:
        result.update({
            "status": "response_too_large",
            "error": f"response exceeds {QFO_CITATION_TITLE_MAX_BYTES} bytes",
        })
        return result

    raw_path = raw_dir / "citation-title-pages" / f"{sha12(result['url'])}.response"
    write_raw_bytes(raw_path, payload)
    result["raw_ref"] = portable_ref(root, raw_path)

    content_hint = result["content_type"].casefold()
    payload_hint = payload.lstrip()[:64].lower()
    if "html" not in content_hint and not payload_hint.startswith(
        (b"<!doctype html", b"<html", b"<head", b"<meta")
    ):
        result.update({"status": "non_html_content", "error": "successful response is not HTML"})
        return result
    try:
        page_html, decoded_with = decode_text_bytes(
            payload,
            result["content_type"],
            source=result["final_url"] or result["url"],
        )
    except UnicodeError as exc:
        result.update({"status": "decode_error", "error": f"UnicodeError: {exc}"})
        return result
    result["decoded_with"] = decoded_with
    title, title_source = qfo_extract_page_title(page_html)
    if not title:
        result.update({"status": "title_missing", "error": "HTML contains no non-empty title or og:title"})
        return result
    result.update({"status": "fetched", "title": title, "title_source": title_source})
    return result


def enrich_qfo_citation_titles(
    ai_rows: list[dict[str, Any]],
    serp_rows: list[dict[str, Any]],
    root: Path,
    raw_dir: Path,
    network_approved: bool,
    timeout: int = 20,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    """Apply title precedence and ledger every unique non-empty cited URL."""
    enriched_rows: list[dict[str, Any]] = []
    decorative_or_invalid_citation_rows_dropped = 0
    for source_row in ai_rows:
        row = dict(source_row)
        imported_url = normalize_ws(str(row.get("citation_url", "")))
        if imported_url:
            try:
                normalized_url = normalize_ai_citation_url(imported_url)
            except (TypeError, ValueError, UnicodeError):
                normalized_url = ""
            if not normalized_url:
                decorative_or_invalid_citation_rows_dropped += 1
                continue
            row["citation_url"] = normalized_url
        else:
            row["citation_url"] = ""
        enriched_rows.append(row)

    provider_by_url: dict[str, dict[str, str]] = {}
    existing_http_by_url: dict[str, dict[str, str]] = {}
    url_by_key: dict[str, str] = {}

    for row in enriched_rows:
        url = normalize_ws(str(row.get("citation_url", "")))
        key = qfo_url_key(url)
        title = normalize_ws(str(row.get("citation_title", "")))
        source = normalize_ws(str(row.get("citation_title_source", "")))
        raw_ref = normalize_ws(str(row.get("citation_title_raw_ref") or row.get("raw_ref") or ""))
        if key and url:
            url_by_key.setdefault(key, url)
        if not key or not title:
            continue
        if source in {"html_title", "og:title"}:
            existing_http_by_url.setdefault(
                key,
                {"title": title, "title_source": source, "raw_ref": raw_ref},
            )
        elif source not in QFO_DERIVED_TITLE_SOURCES:
            provider_by_url.setdefault(
                key,
                {
                    "title": title,
                    "title_source": source or "provider_citation_title",
                    "raw_ref": raw_ref,
                },
            )

    organic_by_url: dict[str, dict[str, str]] = {}
    for row in serp_rows:
        key = qfo_url_key(str(row.get("url", "")))
        title = normalize_ws(str(row.get("title", "")))
        if key and title and key not in organic_by_url:
            organic_by_url[key] = {
                "title": title,
                "title_source": "organic_url_match",
                "raw_ref": normalize_ws(str(row.get("raw_ref", ""))),
            }

    all_keys = list(url_by_key)
    missing_keys = [key for key in all_keys if key not in provider_by_url]
    for row in enriched_rows:
        key = qfo_url_key(str(row.get("citation_url", "")))
        if not key:
            row.setdefault("citation_title_source", "")
            row.setdefault("citation_title_raw_ref", "")
            continue
        provider_title = provider_by_url.get(key)
        if provider_title:
            row["citation_title"] = provider_title["title"]
            row["citation_title_source"] = provider_title["title_source"]
            row["citation_title_raw_ref"] = provider_title["raw_ref"]

    ledger_by_key: dict[str, dict[str, Any]] = {}
    resolutions: dict[str, dict[str, Any]] = {}
    fetch_keys: list[str] = []
    for key in all_keys:
        url = url_by_key[key]
        if key in provider_by_url:
            evidence = provider_by_url[key]
            ledger_by_key[key] = {
                "url": url,
                "status": "resolved_provider_title",
                "http_status": "",
                "final_url": "",
                "content_type": "",
                "decoded_with": "",
                "title": evidence["title"],
                "title_source": evidence["title_source"],
                "raw_ref": evidence["raw_ref"],
                "error": "",
            }
        elif key in organic_by_url:
            evidence = organic_by_url[key]
            ledger_by_key[key] = {
                "url": url,
                "status": "resolved_organic_url_match",
                "http_status": "",
                "final_url": "",
                "content_type": "",
                "decoded_with": "",
                "title": evidence["title"],
                "title_source": evidence["title_source"],
                "raw_ref": evidence["raw_ref"],
                "error": "",
            }
            resolutions[key] = ledger_by_key[key]
        elif key in existing_http_by_url:
            evidence = existing_http_by_url[key]
            ledger_by_key[key] = {
                "url": url,
                "status": "reused_existing_http_title",
                "http_status": "",
                "final_url": "",
                "content_type": "",
                "decoded_with": "",
                "title": evidence["title"],
                "title_source": evidence["title_source"],
                "raw_ref": evidence["raw_ref"],
                "error": "",
            }
            resolutions[key] = ledger_by_key[key]
        elif network_approved:
            fetch_keys.append(key)
        else:
            ledger_by_key[key] = {
                "url": url,
                "status": "skipped_no_network_approval",
                "http_status": "",
                "final_url": "",
                "content_type": "",
                "decoded_with": "",
                "title": "",
                "title_source": "",
                "raw_ref": "",
                "error": "HTTP title enrichment requires --network-approved",
            }

    if fetch_keys:
        worker_count = min(QFO_CITATION_TITLE_MAX_WORKERS, len(fetch_keys))
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = {
                executor.submit(
                    qfo_fetch_citation_title,
                    url_by_key[key],
                    root,
                    raw_dir,
                    network_approved=True,
                    timeout=timeout,
                ): key
                for key in fetch_keys
            }
            for future in as_completed(futures):
                key = futures[future]
                try:
                    fetched = future.result()
                except Exception as exc:  # noqa: BLE001
                    fetched = {
                        "url": url_by_key[key],
                        "status": "fetch_error",
                        "http_status": "",
                        "final_url": "",
                        "content_type": "",
                        "decoded_with": "",
                        "title": "",
                        "title_source": "",
                        "raw_ref": "",
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                ledger_by_key[key] = fetched
                if fetched.get("title"):
                    resolutions[key] = fetched

    for row in enriched_rows:
        key = qfo_url_key(str(row.get("citation_url", "")))
        if not key or key in provider_by_url:
            continue
        resolution = resolutions.get(key, {})
        row["citation_title"] = normalize_ws(str(resolution.get("title", "")))
        row["citation_title_source"] = normalize_ws(str(resolution.get("title_source", "")))
        row["citation_title_raw_ref"] = normalize_ws(str(resolution.get("raw_ref", "")))

    ledger_rows = [ledger_by_key[key] for key in all_keys]
    succeeded = sum(1 for key in fetch_keys if ledger_by_key.get(key, {}).get("title"))
    summary = {
        "network_approved": bool(network_approved),
        "decorative_or_invalid_citation_rows_dropped": decorative_or_invalid_citation_rows_dropped,
        "unique_citation_urls": len(all_keys),
        "provider_title_urls": sum(
            1 for row in ledger_rows if row.get("status") == "resolved_provider_title"
        ),
        "missing_citation_urls": len(missing_keys),
        "organic_url_matches": sum(
            1 for row in ledger_rows if row.get("status") == "resolved_organic_url_match"
        ),
        "existing_http_titles_reused": sum(
            1 for row in ledger_rows if row.get("status") == "reused_existing_http_title"
        ),
        "attempted": len(fetch_keys),
        "succeeded": succeeded,
        "failed": len(fetch_keys) - succeeded,
        "remaining": sum(
            1 for key in missing_keys if not ledger_by_key.get(key, {}).get("title")
        ),
        "max_workers": QFO_CITATION_TITLE_MAX_WORKERS,
        "workers_used": min(QFO_CITATION_TITLE_MAX_WORKERS, len(fetch_keys)),
        "timeout_seconds": min(max(int(timeout or 1), 1), QFO_CITATION_TITLE_TIMEOUT_SECONDS),
    }
    return enriched_rows, ledger_rows, summary

def qfo_base_title(title: str) -> str:
    """Return the entire normalized cited title without mechanical suffix stripping."""
    cleaned = normalize_ws(html.unescape(str(title or "")))
    return cleaned[:500]


def extract_qfo_ai_titles(ai_rows: list[dict[str, Any]], serp_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    organic_titles: dict[str, dict[str, str]] = {}
    for row in serp_rows:
        key = qfo_url_key(str(row.get("url", "")))
        title = normalize_ws(str(row.get("title", "")))
        if key and title and key not in organic_titles:
            organic_titles[key] = {
                "title": title,
                "raw_ref": normalize_ws(str(row.get("raw_ref", ""))),
            }
    rows = []
    for idx, row in enumerate(ai_rows, start=1):
        url = str(row.get("citation_url", ""))
        title = normalize_ws(str(row.get("citation_title", "")))
        title_source = normalize_ws(str(row.get("citation_title_source", "")))
        title_raw_ref = normalize_ws(str(row.get("citation_title_raw_ref", "")))
        if title and not title_source:
            title_source = "provider_citation_title"
            title_raw_ref = title_raw_ref or normalize_ws(str(row.get("raw_ref", "")))
        if not title and url:
            organic = organic_titles.get(qfo_url_key(url), {})
            title = normalize_ws(str(organic.get("title", "")))
            if title:
                title_source = "organic_url_match"
                title_raw_ref = normalize_ws(str(organic.get("raw_ref", "")))
        # A URL slug is never evidence of a page title.
        if not title:
            continue
        rows.append({
            "title_id": f"qfo_title_{idx:04d}",
            "source_query": row.get("prompt", ""),
            "provider": row.get("provider", "xmlriver"),
            "model": row.get("model", ""),
            "citation_url": url,
            "citation_domain": normalize_domain(url),
            "citation_title": title,
            "base_title": qfo_base_title(title),
            "title_source": title_source or "unknown",
            "title_raw_ref": title_raw_ref,
            "answer_id": row.get("answer_id", ""),
            "answer_text_present": bool(row.get("answer_text")),
            "raw_ref": row.get("raw_ref", ""),
        })
    return rows


def qfo_exact_title_key(value: str) -> str:
    normalized_full_title = qfo_base_title(value).casefold()
    return "title:" + sha12(normalized_full_title)


def qfo_title_semantic_units(ai_titles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Treat each AI-cited page title as the semantic unit. No query/template expansion."""
    rows: list[dict[str, Any]] = []
    for idx, title_row in enumerate(ai_titles, start=1):
        semantic_title = qfo_base_title(str(title_row.get("base_title") or title_row.get("citation_title") or ""))
        if not semantic_title:
            continue
        rows.append({
            "semantic_unit_id": f"qfo_title_semantic_{idx:04d}",
            "source_type": "ai_cited_title",
            "source_query": title_row.get("source_query", ""),
            "source_title_id": title_row.get("title_id", ""),
            "source_title": title_row.get("citation_title", ""),
            "semantic_title": semantic_title,
            "citation_url": title_row.get("citation_url", ""),
            "citation_domain": title_row.get("citation_domain", ""),
            "title_source": title_row.get("title_source", ""),
            "answer_id": title_row.get("answer_id", ""),
            "raw_ref": title_row.get("raw_ref", ""),
            "theme_key": qfo_exact_title_key(semantic_title),
            "cluster_basis": "exact_ai_cited_title_pending_agent_logic",
            "agent_cluster_status": "pending_logical_clustering",
        })
    return rows

def qfo_parse_selected_themes(selected_themes: str) -> set[str]:
    return {item.casefold() for item in qfo_split_input_text(selected_themes) if item.strip()}


def qfo_cluster_queries(
    title_semantic_rows: list[dict[str, Any]],
    ai_titles: list[dict[str, Any]],
    seed_rows: list[dict[str, Any]],
    chatgpt_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Prepare an agent workpack from AI-cited titles without mechanical query expansion.

    The function only deduplicates exact titles for evidence counting. Real semantic
    clustering is intentionally left to the agent or a clean subagent that reads the
    full title list and reasons about user problems, page jobs, and cannibalization.
    """
    if not title_semantic_rows:
        return [], []

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in title_semantic_rows:
        grouped[row.get("theme_key") or qfo_exact_title_key(row.get("semantic_title", ""))].append(row)

    theme_rows: list[dict[str, Any]] = []
    for idx, (theme_key, rows) in enumerate(sorted(grouped.items(), key=lambda item: (qfo_base_title(item[1][0].get("semantic_title", "")).casefold(), item[0])), start=1):
        semantic_titles = []
        source_queries = []
        citation_urls = []
        citation_domains = []
        raw_refs = []
        for row in rows:
            for value, target in [
                (row.get("semantic_title", ""), semantic_titles),
                (row.get("source_query", ""), source_queries),
                (row.get("citation_url", ""), citation_urls),
                (row.get("citation_domain", ""), citation_domains),
                (row.get("raw_ref", ""), raw_refs),
            ]:
                value = normalize_ws(str(value or ""))
                if value and value not in target:
                    target.append(value)
        label = semantic_titles[0] if semantic_titles else theme_key.replace("title:", "")
        theme_rows.append({
            "theme_id": f"qfo_theme_{idx:03d}",
            "theme_key": theme_key,
            "theme_label": qfo_base_title(label),
            "cluster_mode": "agent_or_clean_subagent_logical_clustering_required",
            "system_requested_count": len(rows),
            "chatgpt_qfo_count": 0,
            "title_semantic_count": len(rows),
            "source_seed_query_count": len(source_queries),
            "ai_title_count": len(rows),
            "ai_citation_count": len(citation_urls),
            "citation_domain_count": len(citation_domains),
            "dominant_intents": "agent_to_determine_from_full_title_list",
            "evidence_title_list": " | ".join(semantic_titles),
            "source_seed_queries": " | ".join(source_queries),
            "citation_domains": " | ".join(citation_domains),
            "raw_refs": " | ".join(raw_refs[:12]),
            "recommended_structure": "pending_agent_logical_cluster",
            "recommended_action": "Agent or clean subagent must read the full AI title list and group titles by user problem/page job before creating hub or child pages.",
            "cannibalization_guard": "Do not create a page from an exact title row alone. Merge titles that solve the same user task; split only when the page job is materially different.",
            "content_plan_status": "pending_agent_review",
        })
    return theme_rows, title_semantic_rows


def qfo_build_content_plan(
    theme_rows: list[dict[str, Any]],
    title_semantic_rows: list[dict[str, Any]],
    selected_themes: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    selected = qfo_parse_selected_themes(selected_themes)
    selection_active = bool(selected)
    selected_rows: list[dict[str, Any]] = []
    for row in theme_rows:
        keys = {
            str(row.get("theme_id", "")).casefold(),
            str(row.get("theme_key", "")).casefold(),
            str(row.get("theme_label", "")).casefold(),
        }
        is_selected = not selection_active or bool(keys & selected)
        selection_row = dict(row)
        selection_row["selected"] = "yes" if is_selected and selection_active else ""
        selected_rows.append(selection_row)

    rows_by_theme: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in title_semantic_rows:
        rows_by_theme[row.get("theme_key", "")].append(row)

    plan_rows: list[dict[str, Any]] = []
    page_index = 0
    for theme in selected_rows:
        if selection_active and theme.get("selected") != "yes":
            continue
        title_rows = rows_by_theme.get(theme.get("theme_key", ""), [])
        source_queries = []
        semantic_titles = []
        citation_urls = []
        for row in title_rows:
            for value, target in [
                (row.get("source_query", ""), source_queries),
                (row.get("semantic_title", ""), semantic_titles),
                (row.get("citation_url", ""), citation_urls),
            ]:
                value = normalize_ws(str(value or ""))
                if value and value not in target:
                    target.append(value)
        page_index += 1
        candidate_slug = slugify(theme.get("theme_label", theme.get("theme_key", "qfo-title")))
        plan_rows.append({
            "page_id": f"qfo_page_{page_index:03d}",
            "theme_id": theme.get("theme_id", ""),
            "page_type": "agent_cluster_candidate",
            "intent": "agent_to_define_from_full_title_list",
            "target_title": theme.get("theme_label", ""),
            "suggested_url": f"/{candidate_slug}/",
            "included_queries": " | ".join(source_queries[:20]),
            "included_titles": " | ".join(semantic_titles),
            "citation_urls": " | ".join(citation_urls[:20]),
            "system_requested_count": theme.get("system_requested_count", 0),
            "chatgpt_qfo_count": theme.get("chatgpt_qfo_count", 0),
            "evidence_counts": f"title_semantics={theme.get('title_semantic_count', 0)}; ai_citations={theme.get('ai_citation_count', 0)}; source_queries={theme.get('source_seed_query_count', 0)}",
            "content_plan_basis": "AI-cited page titles are the semantic units; no template or mask expansion was used.",
            "internal_linking": "Define only after the agent groups titles into hub/child page jobs.",
            "cannibalization_guard": theme.get("cannibalization_guard", ""),
            "status": "selected_pending_agent_logical_plan" if selection_active else "pending_agent_logical_plan",
        })
    return plan_rows, selected_rows


def qfo_split_ids(value: Any) -> list[str]:
    raw_values = value if isinstance(value, list) else re.split(r"[\n,;|]+", str(value or ""))
    return [normalize_ws(str(item)) for item in raw_values if normalize_ws(str(item))]


def qfo_external_approver_error(value: Any) -> str:
    approver = normalize_ws(str(value or ""))
    if not approver:
        return "approved_by is missing"
    normalized = approver.casefold().replace("-", "_").replace(" ", "_")
    non_human_identities = {
        "agent",
        "ai",
        "assistant",
        "automation",
        "bot",
        "chatgpt",
        "claude",
        "cli",
        "codex",
        "geo_topic_agent",
        "model",
        "qfo_agent",
        "runtime",
        "system",
    }
    if normalized in non_human_identities or any(
        normalized.startswith(f"{identity}{separator}")
        for identity in non_human_identities
        for separator in (":", "_")
    ):
        return "approved_by must identify an external human user or reviewer; agent, model, CLI, runtime, and automation self-approval is forbidden"
    return ""


def load_approved_qfo_content_plan(
    root: Path,
    topic_slug: str,
    approved_content_plan_file: str,
    title_semantic_rows: list[dict[str, Any]],
    approval_ref: str = "",
) -> tuple[list[dict[str, Any]], list[str], dict[str, Any]]:
    if not approved_content_plan_file:
        return [], [], {
            "status": "pending_agent_and_user_approval",
            "source": "",
            "approval_ref": "",
        }
    path = Path(approved_content_plan_file)
    if not path.exists() or not path.is_file():
        return [], [f"Approved QFO content plan file not found: {path}"], {
            "status": "invalid",
            "source": str(path),
            "approval_ref": approval_ref,
        }

    errors: list[str] = []
    excluded_ids: list[str] = []
    excluded_reasons: dict[str, str] = {}
    if path.suffix.lower() == ".csv":
        source_rows: Any = read_csv(path)
    else:
        payload = read_json(path, {})
        source_rows = payload.get("content_plan", payload.get("rows", [])) if isinstance(payload, dict) else payload
        if isinstance(payload, dict):
            excluded_ids = qfo_split_ids(payload.get("excluded_title_ids", []))
            reason_map = payload.get("excluded_title_reasons", {})
            if isinstance(reason_map, dict):
                excluded_reasons.update({normalize_ws(str(key)): normalize_ws(str(value)) for key, value in reason_map.items()})
            excluded_entries = payload.get("excluded_titles", [])
            if isinstance(excluded_entries, list):
                for entry in excluded_entries:
                    if not isinstance(entry, dict):
                        errors.append("Each excluded_titles entry must be an object with title_id and reason.")
                        continue
                    title_id = normalize_ws(str(entry.get("title_id") or entry.get("semantic_unit_id") or ""))
                    reason = normalize_ws(str(entry.get("reason") or entry.get("exclusion_reason") or ""))
                    if title_id:
                        excluded_ids.append(title_id)
                        excluded_reasons[title_id] = reason
    if not isinstance(source_rows, list):
        return [], ["Approved QFO content plan must contain a row list."], {
            "status": "invalid",
            "source": str(path),
            "approval_ref": approval_ref,
        }

    valid_ids = {
        str(row.get("semantic_unit_id"))
        for row in title_semantic_rows
        if row.get("semantic_unit_id")
    }
    title_inventory_projection = [
        {
            "semantic_unit_id": row.get("semantic_unit_id", ""),
            "source_title": row.get("source_title", ""),
            "semantic_title": row.get("semantic_title", ""),
            "source_query": row.get("source_query", ""),
            "citation_url": row.get("citation_url", ""),
        }
        for row in title_semantic_rows
    ]
    title_inventory_sha256 = qfo_sha256_json(title_inventory_projection)
    normalized_source_rows = [qfo_canonical_value(row) for row in source_rows]
    content_plan_sha256 = qfo_sha256_json({
        "content_plan": normalized_source_rows,
        "excluded_title_ids": sorted(set(excluded_ids)),
        "excluded_title_reasons": {key: excluded_reasons.get(key, "") for key in sorted(set(excluded_ids))},
    })

    approved_rows: list[dict[str, Any]] = []
    assigned: dict[str, str] = {}
    excluded = set(excluded_ids)
    for title_id in sorted(excluded):
        if title_id not in valid_ids:
            errors.append(f"Excluded content-plan title id is unknown: {title_id}.")
        if not excluded_reasons.get(title_id):
            errors.append(f"Excluded content-plan title id {title_id} requires a non-empty exclusion reason.")

    for index, raw_row in enumerate(source_rows, start=1):
        if not isinstance(raw_row, dict):
            errors.append(f"Approved content plan row {index} is not an object.")
            continue
        row = {str(key): normalize_artifact_value(value) for key, value in raw_row.items()}
        disposition = str(row.get("disposition") or "page").strip().lower()
        title_ids = qfo_split_ids(row.get("included_title_ids") or row.get("title_ids"))
        if disposition == "excluded":
            reason = normalize_ws(str(row.get("exclusion_reason", "")))
            if not reason:
                errors.append(f"Excluded content-plan row {index} requires exclusion_reason.")
            for title_id in title_ids:
                excluded.add(title_id)
                excluded_reasons[title_id] = reason
                if title_id not in valid_ids:
                    errors.append(f"Excluded content-plan row {index} references unknown title id {title_id}.")
            continue

        required = [
            "page_id",
            "cluster_name",
            "page_type",
            "intent",
            "target_title",
            "cannibalization_guard",
        ]
        missing = [field for field in required if not str(row.get(field, "")).strip()]
        if missing:
            errors.append(f"Approved content-plan row {index} is missing: {', '.join(missing)}.")
        if str(row.get("page_type", "")).strip().lower() not in {"hub", "child", "standalone"}:
            errors.append(f"Approved content-plan row {index} has invalid page_type.")
        if not title_ids:
            errors.append(f"Approved content-plan row {index} requires included_title_ids.")
        for title_id in title_ids:
            if title_id not in valid_ids:
                errors.append(f"Approved content-plan row {index} references unknown title id {title_id}.")
            if title_id in assigned:
                errors.append(
                    f"Title id {title_id} is assigned to both {assigned[title_id]} and {row.get('page_id', index)}."
                )
            assigned[title_id] = str(row.get("page_id") or index)
        row.pop("approved_by", None)
        row.pop("approval_status", None)
        row["included_title_ids"] = " | ".join(title_ids)
        row["status"] = "externally_approved"
        row["content_plan_basis"] = "agent logical clustering over full AI-cited title inventory"
        row["source_ref"] = str(path)
        approved_rows.append(row)

    overlap = sorted(set(assigned) & excluded)
    if overlap:
        errors.append(f"Title ids cannot be both assigned and excluded: {', '.join(overlap)}.")
    uncovered = sorted(valid_ids - set(assigned) - excluded)
    if uncovered:
        errors.append(
            f"Approved content plan does not disposition {len(uncovered)} AI title rows: "
            + ", ".join(uncovered[:20])
        )
    if not approved_rows:
        errors.append("Approved QFO content plan contains no page rows.")

    ledger_path, records = load_external_approval_records(root)
    if not approval_ref:
        errors.append("Content plan requires --content-plan-approval-ref; approval fields inside the plan file are not trusted.")
    matching = [
        record for record in records
        if record.get("evidence_id") == QFO_CONTENT_PLAN_APPROVAL_EVIDENCE_ID
        and record.get("status") == "approved"
        and record.get("topic_slug") in {topic_slug, "*"}
        and record.get("approval_ref") == approval_ref
    ]
    if approval_ref and not matching:
        errors.append(
            f"No approved {QFO_CONTENT_PLAN_APPROVAL_EVIDENCE_ID} ledger record matches approval_ref={approval_ref!r}."
        )
    if len(matching) > 1:
        errors.append(
            f"Approval ref {approval_ref!r} is ambiguous: expected exactly one external content-plan approval record, found {len(matching)}."
        )
    external_approval: dict[str, Any] = {}
    for record in matching:
        record_errors: list[str] = []
        for field in ("approval_ref", "approved_at"):
            if not normalize_ws(str(record.get(field, ""))):
                record_errors.append(f"content-plan approval {field} is missing")
        approver_error = qfo_external_approver_error(record.get("approved_by"))
        if approver_error:
            record_errors.append(f"content-plan approval {approver_error}")
        scope = record.get("scope", {})
        if not isinstance(scope, dict):
            scope = {}
            record_errors.append("content-plan approval scope must be an object")
        if scope.get("content_plan_sha256") != content_plan_sha256:
            record_errors.append("content-plan approval hash does not match the exact plan file")
        if scope.get("title_inventory_sha256") != title_inventory_sha256:
            record_errors.append("content-plan approval title-inventory hash does not match this QFO run")
        if not record_errors:
            external_approval = record
            break
        errors.extend(record_errors)

    return approved_rows, errors, {
        "status": "approved" if not errors and external_approval else "invalid",
        "source": str(path),
        "approval_ledger": str(ledger_path),
        "approval_ref": approval_ref,
        "content_plan_sha256": content_plan_sha256,
        "title_inventory_sha256": title_inventory_sha256,
        "approved_by": external_approval.get("approved_by", ""),
        "approved_at": external_approval.get("approved_at", ""),
        "approved_page_rows": len(approved_rows),
        "assigned_title_ids": len(assigned),
        "excluded_title_ids": len(excluded),
        "excluded_title_reasons": len([title_id for title_id in excluded if excluded_reasons.get(title_id)]),
        "uncovered_title_ids": len(uncovered),
    }


def qfo_summary_payload(
    status: str,
    topic: str,
    seed_rows: list[dict[str, Any]],
    chatgpt_rows: list[dict[str, Any]],
    plan_rows: list[dict[str, Any]],
    serp_rows: list[dict[str, Any]],
    ai_rows: list[dict[str, Any]],
    ai_titles: list[dict[str, Any]],
    title_semantic_rows: list[dict[str, Any]],
    theme_rows: list[dict[str, Any]],
    content_plan: list[dict[str, Any]],
    selected_rows: list[dict[str, Any]],
    paths: dict[str, str],
    errors: list[str],
    network_approved: bool,
    paid_approved: bool,
    engines: list[str],
    region: str,
    language: str,
    depth: int,
    extra: dict[str, Any] | None = None,
    paid_request_override: int | None = None,
) -> dict[str, Any]:
    paid_request_count = xmlriver_paid_request_count(len(plan_rows), depth) if paid_request_override is None else max(0, int(paid_request_override))
    payload = {
        "status": status,
        "topic": topic,
        "network_approved": network_approved,
        "paid_approved": paid_approved,
        "engines": engines,
        "region": region,
        "language": language,
        "depth": depth,
        "requested_top_urls": depth,
        "depth_semantics": "--depth is the requested organic URL count/top-N, not a pagination page count",
        "xmlriver_results_per_page": XMLRIVER_SERP_URLS_PER_PAGE,
        "xmlriver_serp_pages_per_query_engine": xmlriver_serp_page_count(depth),
        "planned_query_engine_pairs": len(plan_rows),
        "planned_requests": paid_request_count,
        "planned_paid_requests": paid_request_count,
        **xmlriver_thread_scope(paid_request_count),
        "seed_query_count": len(seed_rows),
        "chatgpt_qfo_count": len(chatgpt_rows),
        "serp_rows_count": len(serp_rows),
        "ai_answer_rows_count": len(ai_rows),
        "ai_titles_count": len(ai_titles),
        "title_semantic_unit_count": len(title_semantic_rows),
        "template_query_generation_from_titles": "disabled",
        "theme_clusters_count": len(theme_rows),
        "content_plan_rows_count": len(content_plan),
        "seed_query_values": [row.get("query", "") for row in seed_rows],
        "seed_query_rows": seed_rows,
        "chatgpt_qfo_rows": chatgpt_rows,
        "ai_title_rows": ai_titles,
        "title_semantic_rows": title_semantic_rows,
        "clusters": theme_rows,
        "content_plan": content_plan,
        "selected_theme_rows": selected_rows,
        "paths": paths,
        "errors": errors,
        "generated_at": utc_now(),
    }
    if extra:
        payload.update(extra)
    return payload

def build_qfo_chatgpt_request_report(topic: str, seed_rows: list[dict[str, Any]], chatgpt_rows: list[dict[str, Any]]) -> str:
    status = "provided" if chatgpt_rows else "optional_pending"
    sample_queries = [row.get("query", "") for row in seed_rows[:10]]
    lines = [
        "# QFO_CHATGPT_REQUEST",
        "",
        f"Generated: {utc_now()}",
        f"Topic: {topic}",
        f"Status: {status}",
        "",
        "## What To Provide",
        "",
        "Paste or save the QFO/query fan-out suggestions you collected from ChatGPT. This layer is optional; the XMLRiver AI-title semantic inventory continues without it.",
        "",
        "Suggested file formats:",
        "",
        "- TXT: one query per line",
        "- CSV: a `query` or `qfo_query` column",
        "- JSON: a list of strings or `{\"queries\": [...]}`",
        "",
        "## Prompt Template",
        "",
        "```text",
        "For the topic below, produce QFO/query fan-out suggestions. Include adjacent commercial, comparison, how-to, price, review, and problem/solution searches. Return one query per line.",
        f"Topic: {topic}",
        "Seed queries:",
    ]
    lines.extend(sample_queries or ["<paste seed queries here>"])
    lines.extend(["```", "", "If the user skips this step, keep the content plan based on XMLRiver evidence and mark ChatGPT QFO as pending/skipped."])
    return "\n".join(lines) + "\n"



def build_qfo_query_analysis_report(
    topic: str,
    seed_rows: list[dict[str, Any]],
    plan_rows: list[dict[str, Any]],
    serp_rows: list[dict[str, Any]],
    ai_rows: list[dict[str, Any]],
    ai_titles: list[dict[str, Any]],
    title_semantic_rows: list[dict[str, Any]],
    theme_rows: list[dict[str, Any]],
    content_plan: list[dict[str, Any]],
    chatgpt_rows: list[dict[str, Any]],
    errors: list[str],
    status: str,
    paths: dict[str, str],
    paid_request_override: int | None = None,
) -> str:
    planned_paid_requests = sum(int(row.get("planned_paid_requests", 1)) for row in plan_rows)
    if paid_request_override is not None:
        planned_paid_requests = max(0, int(paid_request_override))
    lines = [
        "# QFO_QUERY_ANALYSIS",
        "",
        f"Generated: {utc_now()}",
        f"Topic: {topic}",
        f"Status: {status}",
        "",
        "## What QFO Means",
        "",
        "QFO means Query Fan-Out: follow-up, adjacent, implied, and reformulated searches that can appear around the user's seed queries. In this runtime the semantic source for QFO planning is the AI-cited page title inventory, not mechanically generated title variants.",
        "",
        "## Scope And Counts",
        "",
        f"- Seed queries supplied: {len(seed_rows)}",
        f"- XMLRiver query x engine pairs: {len(plan_rows)}",
        f"- Requested top URLs per pair (`--depth`): {plan_rows[0].get('requested_top_urls', 'not set') if plan_rows else 'not set'}",
        f"- XMLRiver SERP pages per pair: {plan_rows[0].get('xmlriver_serp_pages_per_query_engine', 'not set') if plan_rows else 'not set'}",
        f"- XMLRiver planned paid page requests: {planned_paid_requests}",
        f"- XMLRiver max live threads: {XMLRIVER_MAX_THREADS}",
        f"- XMLRiver planned thread slots: {xmlriver_thread_scope(planned_paid_requests).get('xmlriver_thread_slots_planned')}",
        f"- XMLRiver active paid thread slots this run: {xmlriver_thread_scope(planned_paid_requests).get('xmlriver_thread_slots_planned') if planned_paid_requests else 0}",
        f"- Organic SERP rows parsed: {len(serp_rows)}",
        f"- AI answer/source rows parsed: {len(ai_rows)}",
        f"- AI-cited titles extracted: {len(ai_titles)}",
        f"- Title semantic units: {len(title_semantic_rows)}",
        "- Template/mask query generation from titles: disabled",
        f"- Optional ChatGPT QFO rows: {len(chatgpt_rows)}",
        f"- Exact-title evidence rows for agent clustering: {len(theme_rows)}",
        f"- Content plan candidate rows: {len(content_plan)}",
        "",
        "## Evidence Basis",
        "",
    ]
    if not ai_titles:
        lines.extend([
            "- No AI-cited titles are available yet. The runtime did not create title clusters or a content plan from seed queries alone.",
            "- Run approved XMLRiver `ai=1` collection or import AI citation title evidence before QFO content planning.",
            "",
        ])
    else:
        lines.extend([
            "- Each AI-cited page title is treated as a semantic unit.",
            "- The runtime only deduplicates exact repeated titles for evidence counting.",
            "- The agent or a clean subagent must read the full title list below before grouping titles into topics and building the final hub + child plan.",
            "- Do not use expanded query variants, n-gram masks, or template permutations as demand evidence.",
            "",
        ])
    lines.extend([
        "## Full AI-Cited Title Inventory",
        "",
        "| # | Source Query | Domain | Title | URL | Source |",
        "| ---: | --- | --- | --- | --- | --- |",
    ])
    for idx, row in enumerate(ai_titles, start=1):
        lines.append(f"| {idx} | {escape_md(row.get('source_query', ''))} | {escape_md(row.get('citation_domain', ''))} | {escape_md(row.get('base_title', ''))} | {escape_md(row.get('citation_url', ''))} | {escape_md(row.get('title_source', ''))} |")
    if not ai_titles:
        lines.append("| 0 | none | none | none | none | none |")
    lines.extend([
        "",
        "## Exact-Title Evidence Rows For Agent Clustering",
        "",
        "| Row | Title | AI Title Observations | Source Queries | Citation Domains | Status | Guard |",
        "| --- | --- | ---: | --- | --- | --- | --- |",
    ])
    for row in theme_rows:
        lines.append(
            f"| {escape_md(row.get('theme_id', ''))} | {escape_md(row.get('theme_label', ''))} | {row.get('title_semantic_count', 0)} | "
            f"{escape_md(row.get('source_seed_queries', ''))} | {escape_md(row.get('citation_domains', ''))} | {escape_md(row.get('content_plan_status', ''))} | {escape_md(row.get('cannibalization_guard', ''))} |"
        )
    if not theme_rows:
        lines.append("| none | none | 0 | none | none | none | none |")
    lines.extend([
        "",
        "## Content Plan Candidate Rows",
        "",
        "These rows are not a finished content plan. They are a workpack for agent/subagent logical clustering from the full title inventory.",
        "",
        "| Page | Type | Agent Task | Candidate Title | Included AI Titles | Status |",
        "| --- | --- | --- | --- | --- | --- |",
    ])
    for row in content_plan:
        lines.append(f"| {row.get('page_id', '')} | {row.get('page_type', '')} | {row.get('intent', '')} | {escape_md(row.get('target_title', ''))} | {escape_md(row.get('included_titles', ''))} | {row.get('status', '')} |")
    if not content_plan:
        lines.append("| none | none | none | none | none | none |")
    lines.extend(["", "## Artifacts", ""])
    for label, ref in paths.items():
        lines.append(f"- {label}: {ref}")
    lines.extend(["", "## Errors And Limits", ""])
    lines.extend([f"- {escape_md(error)}" for error in errors] or ["- none"])
    lines.extend([
        "",
        "## Next Valid Actions",
        "",
        "- Read the full AI title inventory and `data/processed/<topic>_qfo_title_semantics.csv`.",
        "- Cluster titles manually as the agent or send the full title inventory to a clean subagent; group only by user problem and page job.",
        "- Build the hub + child content plan from the approved logical QFO clusters, not from exact-title rows alone.",
        "- If available, provide ChatGPT QFO through `--chatgpt-qfo-file` as auxiliary context, not as a replacement for AI-cited titles.",
    ])
    return "\n".join(lines) + "\n"

def qfo_query_analysis(
    project_dir: Path,
    queries: str = "",
    queries_file: str = "",
    topic: str = "",
    engines: str = "",
    region: str = "",
    language: str = "",
    depth: int | None = None,
    network_approved: bool = False,
    paid_approved: bool = False,
    dry_run: bool = False,
    approval_ref: str = "",
    reviewed_plan_hash: str = "",
    timeout: int = 60,
    env_path: str = "",
    chatgpt_qfo_file: str = "",
    selected_themes: str = "",
    approved_content_plan_file: str = "",
    content_plan_approval_ref: str = "",
    reuse_existing_evidence: bool = False,
    evidence_manifest: str = "",
    quick_cluster_mode: bool = False,
) -> dict[str, Any]:
    topic = repair_text_encoding(topic)
    queries = repair_text_encoding(queries)
    engines = repair_text_encoding(engines)
    region = repair_text_encoding(region)
    language = repair_text_encoding(language)
    selected_themes = repair_text_encoding(selected_themes)
    approved_content_plan_file = repair_text_encoding(approved_content_plan_file)
    approval_ref = repair_text_encoding(approval_ref)
    reviewed_plan_hash = repair_text_encoding(reviewed_plan_hash).lower()
    content_plan_approval_ref = repair_text_encoding(content_plan_approval_ref)
    evidence_manifest = repair_text_encoding(evidence_manifest)

    root = find_project_root(project_dir)
    ensure_dirs(root)
    workflow_gate = full_workflow_prerequisite_gate(root)
    if workflow_gate.get("status") != "pass" and not quick_cluster_mode:
        return observation("blocked", "QFO analysis requires the full project workflow gate or explicit --quick-cluster-mode for isolated user-supplied query-cluster research.", items=[workflow_gate], next_valid_actions=[*workflow_gate.get("next_valid_actions", []), "rerun_qfo_with_quick_cluster_mode"])
    seed_rows = load_qfo_seed_queries(queries, queries_file)
    topic_value = topic or (seed_rows[0]["query"] if seed_rows else "qfo-query-analysis")
    topic_slug = slugify(topic_value)
    chatgpt_rows = load_qfo_chatgpt_queries(chatgpt_qfo_file)

    scope, scope_errors = resolve_qfo_scope(root, engines, region, language, depth)
    engine_values = list(scope.get("engines", []))
    region_value = str(scope.get("region", ""))
    language_value = str(scope.get("language", ""))
    depth_value = scope.get("depth")
    depth_errors: list[str] = []
    requested_top_urls = 0
    if depth_value is not None:
        requested_top_urls, depth_errors = validate_serp_top_url_depth(depth_value, "xmlriver")
    depth_int = requested_top_urls

    unsupported_engines = [engine for engine in engine_values if engine not in XMLRIVER_ENDPOINTS]
    region_errors: list[str] = []
    if region_value and language_value and engine_values and not unsupported_engines:
        normalized_region = region_value.strip()
        if re.fullmatch(r"\d+", normalized_region) and len(engine_values) > 1:
            region_errors.append(
                "A bare numeric XMLRiver region is ambiguous for Google + Yandex. "
                "Use a documented alias or google=<loc>;yandex=<lr>."
            )
        else:
            for engine_name in engine_values:
                try:
                    resolve_xmlriver_region(engine_name, region_value, language_value)
                except ValueError as exc:
                    region_errors.append(str(exc))

    processed = root / PROCESSED_REL
    seed_path = processed / f"{topic_slug}_qfo_seed_queries.csv"
    chatgpt_path = processed / f"{topic_slug}_qfo_chatgpt_queries.csv"
    serp_path = processed / f"{topic_slug}_qfo_xmlriver_serp_rows.csv"
    ai_path = processed / f"{topic_slug}_qfo_xmlriver_ai_answers.csv"
    title_ledger_path = processed / f"{topic_slug}_qfo_title_enrichment.csv"
    titles_path = processed / f"{topic_slug}_qfo_ai_titles.csv"
    title_semantics_path = processed / f"{topic_slug}_qfo_title_semantics.csv"
    themes_path = processed / f"{topic_slug}_qfo_theme_clusters.csv"
    plan_path = processed / f"{topic_slug}_qfo_content_plan.csv"
    summary_path = processed / f"{topic_slug}_qfo_analysis.json"
    canonical_manifest_path = processed / f"{topic_slug}_qfo_evidence_manifest.json"
    manifest_path = Path(evidence_manifest) if evidence_manifest else canonical_manifest_path
    if not manifest_path.is_absolute():
        manifest_path = root / manifest_path
    approval_template_path = root / IMPORT_REL / f"{topic_slug}_qfo_xmlriver_approval_template.json"
    selection_path = root / IMPORT_REL / f"{topic_slug}_qfo_theme_selection_template.csv"
    report_path = root / REPORTS_REL / "QFO_QUERY_ANALYSIS.md"
    chatgpt_request_path = root / REPORTS_REL / "QFO_CHATGPT_REQUEST.md"
    approval_path = external_approval_ledger_path(root)

    write_csv(seed_path, seed_rows)
    write_csv(chatgpt_path, chatgpt_rows)
    pages_per_pair = xmlriver_serp_page_count(depth_int) if depth_int else 0
    plan_rows = [
        {
            "request_id": f"qfo_request_{idx:04d}",
            "query_id": seed["query_id"],
            "query": seed["query"],
            "engine": engine,
            "include_ai": True,
            "provider": "xmlriver",
            "requested_top_urls": depth_int,
            "depth_semantics": "--depth is the requested organic URL count/top-N, not a pagination page count",
            "xmlriver_results_per_page": XMLRIVER_SERP_URLS_PER_PAGE,
            "xmlriver_serp_pages_per_query_engine": pages_per_pair,
            "planned_paid_requests": pages_per_pair,
            "xmlriver_max_threads": XMLRIVER_MAX_THREADS,
        }
        for idx, (seed, engine) in enumerate(
            ((seed, engine) for seed in seed_rows for engine in engine_values),
            start=1,
        )
    ] if depth_int else []

    errors: list[str] = []
    errors.extend(scope_errors)
    errors.extend(depth_errors)
    errors.extend(region_errors)
    if unsupported_engines:
        errors.append(f"Unsupported XMLRiver engines: {', '.join(unsupported_engines)}")
    if not seed_rows:
        errors.append("No seed queries were provided. Use --queries or --queries-file.")

    binding: dict[str, Any] = {}
    computed_plan_hash = ""
    if seed_rows and plan_rows and not scope_errors and not depth_errors and not region_errors and not unsupported_engines:
        binding = build_qfo_paid_scope_binding(
            seed_rows,
            plan_rows,
            engine_values,
            region_value,
            language_value,
            depth_int,
        )
        computed_plan_hash = qfo_sha256_json(binding)
        write_qfo_xmlriver_approval_template(
            approval_template_path,
            topic_slug,
            binding,
            computed_plan_hash,
        )

    base_paths = {
        "seed_queries": portable_ref(root, seed_path),
        "chatgpt_queries": portable_ref(root, chatgpt_path),
        "title_semantics": portable_ref(root, title_semantics_path),
        "theme_clusters": portable_ref(root, themes_path),
        "content_plan": portable_ref(root, plan_path),
        "theme_selection_template": portable_ref(root, selection_path),
        "paid_approval_template": portable_ref(root, approval_template_path),
        "approval_ledger": portable_ref(root, approval_path),
        "evidence_manifest": portable_ref(root, manifest_path),
        "summary_json": portable_ref(root, summary_path),
    }

    def emit_preflight(
        status: str,
        summary: str,
        next_actions: list[str],
        paid_request_override: int,
    ) -> dict[str, Any]:
        empty_serp: list[dict[str, Any]] = []
        empty_ai: list[dict[str, Any]] = []
        empty_titles: list[dict[str, Any]] = []
        empty_semantics: list[dict[str, Any]] = []
        empty_themes: list[dict[str, Any]] = []
        empty_plan: list[dict[str, Any]] = []
        empty_selected: list[dict[str, Any]] = []
        write_csv(titles_path, empty_titles)
        write_csv(title_semantics_path, empty_semantics)
        write_csv(themes_path, empty_themes)
        write_csv(plan_path, empty_plan)
        write_csv(selection_path, empty_selected)
        write_text(chatgpt_request_path, build_qfo_chatgpt_request_report(topic_value, seed_rows, chatgpt_rows))
        write_text(
            report_path,
            build_qfo_query_analysis_report(
                topic_value,
                seed_rows,
                plan_rows,
                empty_serp,
                empty_ai,
                empty_titles,
                empty_semantics,
                empty_themes,
                empty_plan,
                chatgpt_rows,
                errors,
                status,
                base_paths,
                paid_request_override=paid_request_override,
            ),
        )
        summary_payload = qfo_summary_payload(
            status,
            topic_value,
            seed_rows,
            chatgpt_rows,
            plan_rows,
            empty_serp,
            empty_ai,
            empty_titles,
            empty_semantics,
            empty_themes,
            empty_plan,
            empty_selected,
            base_paths,
            errors,
            network_approved,
            paid_approved,
            engine_values,
            region_value,
            language_value,
            depth_int,
            extra={
                "scope_resolution": scope,
                "reviewed_plan_hash": computed_plan_hash,
                "approval_ref": approval_ref,
                "reuse_existing_evidence": reuse_existing_evidence,
                "evidence_manifest": portable_ref(root, manifest_path),
                "active_paid_thread_slots": 0,
            },
            paid_request_override=paid_request_override,
        )
        write_json(summary_path, summary_payload)
        update_state(root, f"qfo_query_analysis_{status}", [str(report_path), str(chatgpt_request_path), str(summary_path)])
        evidence_refs = [str(report_path), str(chatgpt_request_path), str(summary_path), str(selection_path)]
        if approval_template_path.exists():
            evidence_refs.append(str(approval_template_path))
        return observation(
            "success" if status == "dry_run" and not errors else status,
            summary,
            items=[{
                "reviewed_plan_hash": computed_plan_hash,
                "planned_query_engine_pairs": len(plan_rows),
                "planned_requests": paid_request_override,
                "planned_paid_requests": paid_request_override,
                "active_paid_thread_slots": 0,
                "requested_top_urls": depth_int,
                "errors": len(errors),
            }],
            evidence_refs=evidence_refs,
            next_valid_actions=next_actions,
        )

    if not seed_rows:
        return emit_preflight(
            "invalid_args",
            "QFO analysis requires the user query cluster.",
            ["provide_queries"],
            0,
        )

    paid_approval_errors: list[str] = []
    accepted_paid_approval: dict[str, Any] = {}
    if not reuse_existing_evidence and not dry_run and binding:
        if not network_approved:
            paid_approval_errors.append("Live XMLRiver collection not run: --network-approved is missing.")
        if not paid_approved:
            paid_approval_errors.append("Live XMLRiver collection not run: --paid-approved is missing.")
        approval_path, ledger_errors, accepted_paid_approval = validate_qfo_xmlriver_approval(
            root,
            topic_slug,
            binding,
            computed_plan_hash,
            approval_ref,
            reviewed_plan_hash,
        )
        paid_approval_errors.extend(ledger_errors)
        errors.extend(paid_approval_errors)

    preflight_blocked = bool(scope_errors or depth_errors or region_errors or unsupported_engines or paid_approval_errors)
    if dry_run:
        if errors:
            return emit_preflight(
                "blocked",
                "QFO dry-run found unresolved scope or invalid input; no paid requests were made.",
                ["provide_explicit_scope", "save_authoritative_project_scope", "rerun_dry_run"],
                0,
            )
        return emit_preflight(
            "dry_run",
            "QFO paid plan resolved. Review the exact hash and add an external approval-ledger record before live execution.",
            ["review_paid_plan", "complete_external_approval_ledger", "rerun_with_exact_approval_ref_and_hash"],
            int(binding.get("planned_paid_requests", 0)),
        )
    if preflight_blocked:
        return emit_preflight(
            "blocked",
            "QFO XMLRiver live analysis is blocked until scope and exact external approval match.",
            ["provide_explicit_scope", "run_qfo_dry_run", "complete_external_approval_ledger", "rerun_with_exact_approval_ref_and_hash"],
            0 if reuse_existing_evidence else int(binding.get("planned_paid_requests", 0)) if binding else 0,
        )

    env = load_env_values(root, env_path) if not reuse_existing_evidence else {}
    accounts = xmlriver_accounts(env) if not reuse_existing_evidence else []
    if not reuse_existing_evidence and not accounts:
        errors.append("XMLRiver credentials not found in env. Required: XMLRIVER_USER and XMLRIVER_KEY or compatible aliases.")
        return emit_preflight(
            "blocked",
            "XMLRiver credentials are required for the exact approved QFO run.",
            ["add_xmlriver_credentials", "rerun_same_approved_plan"],
            int(binding.get("planned_paid_requests", 0)),
        )

    run_id = f"qfo_xmlriver_{sha12(topic_value + utc_now())}"
    raw_dir = root / RAW_REL / "serp" / run_id
    request_stats = {
        "paid_requests_succeeded": 0,
        "paid_requests_failed": 0,
        "request_meta_refs": [],
    }
    provider_collection_errors: list[str] = []
    manifest_payload: dict[str, Any] = {}
    manifest_validation_errors: list[str] = []
    serp_rows: list[dict[str, Any]] = []
    ai_rows: list[dict[str, Any]] = []

    if reuse_existing_evidence:
        thread_info = {**xmlriver_thread_scope(0), "xmlriver_thread_slots_used": 0}
        serp_rows, ai_rows, manifest_validation_errors, manifest_payload = validate_qfo_evidence_manifest(
            root,
            manifest_path,
            binding,
            computed_plan_hash,
            serp_path,
            ai_path,
        )
        if manifest_validation_errors:
            errors.extend(manifest_validation_errors)
            return emit_preflight(
                "blocked",
                "Existing QFO evidence was rejected because its same-run manifest or hashes did not validate.",
                ["restore_immutable_same_run_evidence", "run_new_exact_approved_xmlriver_collection"],
                0,
            )
    else:
        try:
            collected = collect_xmlriver_plan_parallel(
                plan_rows,
                depth_int,
                region_value,
                language_value,
                True,
                accounts,
                raw_dir,
                timeout,
            )
            serp_rows.extend(collected.get("serp_rows", []))
            ai_rows.extend(collected.get("ai_rows", []))
            provider_collection_errors.extend(collected.get("errors", []))
            errors.extend(provider_collection_errors)
            thread_info = xmlriver_thread_scope(int(binding.get("planned_paid_requests", 0)))
            thread_info["xmlriver_thread_slots_used"] = collected.get(
                "xmlriver_thread_slots_planned",
                thread_info.get("xmlriver_thread_slots_planned"),
            )
            request_stats = {
                "paid_requests_succeeded": collected.get("paid_requests_succeeded", 0),
                "paid_requests_failed": collected.get("paid_requests_failed", 0),
                "request_meta_refs": collected.get("request_meta_refs", []),
            }
        except Exception as exc:  # noqa: BLE001
            provider_error = f"xmlriver_parallel_collection: {type(exc).__name__}: {exc}"
            provider_collection_errors.append(provider_error)
            errors.append(provider_error)
            thread_info = xmlriver_thread_scope(int(binding.get("planned_paid_requests", 0)))
            thread_info["xmlriver_thread_slots_used"] = 0
            request_stats["paid_requests_failed"] = int(binding.get("planned_paid_requests", 0))

    contaminated_live_rows = [index for index, row in enumerate(ai_rows, start=1) if qfo_ai_row_has_provider_error(row)]
    if contaminated_live_rows:
        provider_error = (
            "XMLRiver/provider error payload rows were quarantined before QFO processing: "
            + ", ".join(str(index) for index in contaminated_live_rows[:20])
        )
        provider_collection_errors.append(provider_error)
        errors.append(provider_error)
        contaminated_set = set(contaminated_live_rows)
        ai_rows = [row for index, row in enumerate(ai_rows, start=1) if index not in contaminated_set]

    ai_rows, title_ledger_rows, title_enrichment = enrich_qfo_citation_titles(
        ai_rows,
        serp_rows,
        root,
        raw_dir,
        network_approved=network_approved,
        timeout=timeout,
    )
    write_csv(title_ledger_path, title_ledger_rows)
    if title_enrichment["remaining"]:
        errors.append(
            "Citation title quality gap: "
            f"{title_enrichment['remaining']} citation URL(s) remain without a real title; "
            "no URL slug fallback was used."
        )

    ai_titles = extract_qfo_ai_titles(ai_rows, serp_rows)
    title_semantic_rows = qfo_title_semantic_units(ai_titles)
    theme_rows, title_semantic_rows = qfo_cluster_queries(
        title_semantic_rows,
        ai_titles,
        seed_rows,
        chatgpt_rows,
    )
    content_plan, selected_rows = qfo_build_content_plan(
        theme_rows,
        title_semantic_rows,
        selected_themes,
    )
    approved_plan, content_plan_errors, content_plan_approval = load_approved_qfo_content_plan(
        root,
        topic_slug,
        approved_content_plan_file,
        title_semantic_rows,
        content_plan_approval_ref,
    )
    if approved_content_plan_file:
        errors.extend(content_plan_errors)
        if not content_plan_errors:
            content_plan = approved_plan
    elif ai_titles:
        errors.append(
            "QFO title evidence is ready, but the content plan is not externally approved. "
            "The agent must logically cluster the full title inventory, obtain user approval in the external ledger, "
            "and rerun with --approved-content-plan-file and --content-plan-approval-ref."
        )

    if not reuse_existing_evidence:
        write_csv(serp_path, serp_rows)
        write_csv(ai_path, ai_rows)
    write_csv(titles_path, ai_titles)
    write_csv(title_semantics_path, title_semantic_rows)
    write_csv(themes_path, theme_rows)
    write_csv(plan_path, content_plan)
    write_csv(selection_path, selected_rows)
    write_text(chatgpt_request_path, build_qfo_chatgpt_request_report(topic_value, seed_rows, chatgpt_rows))

    if not ai_titles:
        errors.append(
            "No AI-cited titles were extracted. The XMLRiver run completed or partially completed, "
            "but content planning is lower-assurance until a query returns AI sources."
        )
    content_plan_is_approved = (
        content_plan_approval.get("status") == "approved"
        and bool(content_plan)
        and not content_plan_errors
    )
    if ai_titles and content_plan_is_approved and not errors:
        status = "success"
    elif serp_rows or ai_rows:
        status = "quality_fail"
    else:
        status = "error"

    paid_requests_this_run = 0 if reuse_existing_evidence else int(binding.get("planned_paid_requests", 0))
    if reuse_existing_evidence:
        thread_info = {**xmlriver_thread_scope(0), "xmlriver_thread_slots_used": 0}
    collection_summary = {
        "run_id": run_id,
        "provider": "xmlriver",
        "workflow": "qfo_query_analysis",
        "topic": topic_value,
        "topic_slug": topic_slug,
        "status": status,
        "network_approved": bool(network_approved),
        "paid_approved": bool(paid_approved),
        "paid_approval_ref": approval_ref,
        "paid_approval_bound": bool(accepted_paid_approval) if not reuse_existing_evidence else False,
        "reviewed_plan_hash": computed_plan_hash,
        "scope_binding": binding,
        "scope_resolution": scope,
        "evidence_mode": "verified_same_run_manifest_reuse" if reuse_existing_evidence else "live_xmlriver",
        "evidence_manifest": portable_ref(root, manifest_path),
        "region": region_value,
        "language": language_value,
        "engines": engine_values,
        "depth": depth_int,
        "requested_top_urls": depth_int,
        "depth_semantics": "--depth is the requested organic URL count/top-N, not a pagination page count",
        "xmlriver_results_per_page": XMLRIVER_SERP_URLS_PER_PAGE,
        "xmlriver_serp_pages_per_query_engine": pages_per_pair,
        "planned_query_engine_pairs": len(plan_rows),
        "planned_requests": paid_requests_this_run,
        "planned_paid_requests": paid_requests_this_run,
        "active_paid_thread_slots": 0 if reuse_existing_evidence else thread_info.get("xmlriver_thread_slots_planned", 0),
        "historical_query_engine_pairs_reused": len(plan_rows) if reuse_existing_evidence else 0,
        **request_stats,
        **thread_info,
        "seed_queries": len(seed_rows),
        "serp_rows": len(serp_rows),
        "ai_answer_rows": len(ai_rows),
        "provider_error_payloads_excluded": len(provider_collection_errors),
        "provider_error_exclusion_notes": provider_collection_errors,
        "manifest_validation_errors": manifest_validation_errors,
        "citation_title_enrichment": title_enrichment,
        "citation_title_enrichment_attempted": title_enrichment["attempted"],
        "citation_title_enrichment_succeeded": title_enrichment["succeeded"],
        "citation_title_enrichment_failed": title_enrichment["failed"],
        "citation_title_enrichment_remaining": title_enrichment["remaining"],
        "decorative_or_invalid_citation_rows_dropped": title_enrichment["decorative_or_invalid_citation_rows_dropped"],
        "ai_titles": len(ai_titles),
        "title_semantic_units": len(title_semantic_rows),
        "theme_clusters": len(theme_rows),
        "content_plan_rows": len(content_plan),
        "content_plan_approval": content_plan_approval,
        "errors": errors,
        "generated_at": utc_now(),
    }
    if not reuse_existing_evidence:
        collection_summary["evidence_manifest"] = portable_ref(root, canonical_manifest_path)
        collection_summary["evidence_manifest_status"] = "complete" if (serp_rows or ai_rows) else "invalid"
    write_json(raw_dir / "qfo_collection_summary.json", collection_summary)

    if not reuse_existing_evidence:
        manifest_payload = build_qfo_evidence_manifest(
            root,
            canonical_manifest_path,
            run_id,
            raw_dir,
            binding,
            computed_plan_hash,
            serp_path,
            ai_path,
            serp_rows,
            ai_rows,
            provider_collection_errors,
        )
        manifest_path = canonical_manifest_path
        collection_summary["evidence_manifest_status"] = manifest_payload.get("status")

    paths = {
        "seed_queries": portable_ref(root, seed_path),
        "chatgpt_queries": portable_ref(root, chatgpt_path),
        "xmlriver_serp_rows": portable_ref(root, serp_path),
        "xmlriver_ai_answers": portable_ref(root, ai_path),
        "citation_title_enrichment_ledger": portable_ref(root, title_ledger_path),
        "citation_title_raw_pages": portable_ref(root, raw_dir / "citation-title-pages"),
        "ai_titles": portable_ref(root, titles_path),
        "title_semantics": portable_ref(root, title_semantics_path),
        "theme_clusters": portable_ref(root, themes_path),
        "content_plan": portable_ref(root, plan_path),
        "theme_selection_template": portable_ref(root, selection_path),
        "paid_approval_template": portable_ref(root, approval_template_path),
        "approval_ledger": portable_ref(root, approval_path),
        "evidence_manifest": portable_ref(root, manifest_path),
        "raw_summary": portable_ref(root, raw_dir / "qfo_collection_summary.json"),
        "summary_json": portable_ref(root, summary_path),
    }
    write_text(
        report_path,
        build_qfo_query_analysis_report(
            topic_value,
            seed_rows,
            plan_rows,
            serp_rows,
            ai_rows,
            ai_titles,
            title_semantic_rows,
            theme_rows,
            content_plan,
            chatgpt_rows,
            errors,
            status,
            paths,
            paid_request_override=paid_requests_this_run,
        ),
    )
    write_json(
        summary_path,
        qfo_summary_payload(
            status,
            topic_value,
            seed_rows,
            chatgpt_rows,
            plan_rows,
            serp_rows,
            ai_rows,
            ai_titles,
            title_semantic_rows,
            theme_rows,
            content_plan,
            selected_rows,
            paths,
            errors,
            network_approved,
            paid_approved,
            engine_values,
            region_value,
            language_value,
            depth_int,
            extra={
                "run_id": run_id,
                "provider": "xmlriver",
                "workflow": "qfo_query_analysis",
                "scope_resolution": scope,
                "scope_binding": binding,
                "reviewed_plan_hash": computed_plan_hash,
                "approval_ref": approval_ref,
                "planned_requests": paid_requests_this_run,
                "planned_paid_requests": paid_requests_this_run,
                "active_paid_thread_slots": 0 if reuse_existing_evidence else thread_info.get("xmlriver_thread_slots_planned", 0),
                **thread_info,
                "collection_summary": collection_summary,
                "evidence_manifest_payload": manifest_payload,
                "citation_title_enrichment": title_enrichment,
                "content_plan_approval": content_plan_approval,
            },
            paid_request_override=paid_requests_this_run,
        ),
    )
    update_state(root, "qfo_query_analysis", [str(report_path), str(chatgpt_request_path), str(summary_path), str(plan_path)])
    return observation(
        status,
        "QFO XMLRiver analysis completed." if status == "success" else "QFO XMLRiver analysis completed with explicit gaps.",
        items=[{
            "run_id": run_id,
            "evidence_mode": collection_summary.get("evidence_mode"),
            "reviewed_plan_hash": computed_plan_hash,
            "planned_query_engine_pairs": len(plan_rows),
            "planned_requests": paid_requests_this_run,
            "planned_paid_requests": paid_requests_this_run,
            "active_paid_thread_slots": 0 if reuse_existing_evidence else thread_info.get("xmlriver_thread_slots_planned", 0),
            "paid_requests_succeeded": request_stats.get("paid_requests_succeeded"),
            "paid_requests_failed": request_stats.get("paid_requests_failed"),
            "requested_top_urls": depth_int,
            "serp_rows": len(serp_rows),
            "ai_answer_rows": len(ai_rows),
            "provider_error_payloads_excluded": len(provider_collection_errors),
            "citation_title_enrichment_attempted": title_enrichment["attempted"],
            "citation_title_enrichment_succeeded": title_enrichment["succeeded"],
            "citation_title_enrichment_failed": title_enrichment["failed"],
            "citation_title_enrichment_remaining": title_enrichment["remaining"],
            "decorative_or_invalid_citation_rows_dropped": title_enrichment["decorative_or_invalid_citation_rows_dropped"],
            "ai_titles": len(ai_titles),
            "title_semantic_units": len(title_semantic_rows),
            "theme_clusters": len(theme_rows),
            "content_plan_rows": len(content_plan),
            "content_plan_approval": content_plan_approval.get("status"),
            "errors": len(errors),
        }],
        evidence_refs=[
            str(report_path),
            str(chatgpt_request_path),
            str(summary_path),
            str(plan_path),
            str(title_ledger_path),
            str(manifest_path),
            str(raw_dir / "qfo_collection_summary.json"),
        ],
        next_valid_actions=(
            ["use_approved_content_plan_for_page_tz", "review_content_plan_coverage"]
            if status == "success"
            else [
                "agent_logical_cluster_titles",
                "optionally_use_clean_subagent",
                "record_external_content_plan_approval",
                "rerun_with_approved_content_plan_file_and_approval_ref",
                "provide_chatgpt_qfo_optional",
            ]
        ),
    )
