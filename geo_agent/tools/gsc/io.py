"""UTF-8 artifact writers for local GSC evidence."""

from __future__ import annotations

import csv
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


METRIC_FIELDS = ["clicks", "impressions", "ctr", "position"]


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames = list(rows[0])
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def write_metadata(path: Path, payload: dict[str, Any]) -> None:
    data = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        **payload,
    }
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def compare_periods(
    first: list[dict[str, Any]],
    second: list[dict[str, Any]],
    dimensions: list[str],
    min_impressions: int,
) -> list[dict[str, Any]]:
    def key(row: dict[str, Any]) -> tuple[Any, ...]:
        return tuple(row.get(dimension, "") for dimension in dimensions)

    first_map = {key(row): row for row in first}
    second_map = {key(row): row for row in second}
    compared: list[dict[str, Any]] = []
    for row_key in first_map.keys() | second_map.keys():
        left = first_map.get(row_key, {})
        right = second_map.get(row_key, {})
        if max(left.get("impressions", 0), right.get("impressions", 0)) < min_impressions:
            continue
        row = {dimension: row_key[i] for i, dimension in enumerate(dimensions)}
        for metric in METRIC_FIELDS:
            p1 = left.get(metric, 0)
            p2 = right.get(metric, 0)
            row[f"{metric}_p1"] = p1
            row[f"{metric}_p2"] = p2
            row[f"{metric}_diff"] = round(p2 - p1, 6)
        compared.append(row)
    return sorted(
        compared,
        key=lambda row: (row["impressions_diff"], row["clicks_diff"]),
        reverse=True,
    )


def new_queries(
    first: list[dict[str, Any]],
    second: list[dict[str, Any]],
    min_impressions: int,
) -> list[dict[str, Any]]:
    existing = {row.get("query", "") for row in first}
    rows = [
        row
        for row in second
        if row.get("query", "") not in existing
        and row.get("impressions", 0) >= min_impressions
    ]
    return sorted(
        rows,
        key=lambda row: (row.get("impressions", 0), row.get("clicks", 0)),
        reverse=True,
    )


def write_snapshot_summary(
    path: Path,
    *,
    property_url: str,
    start_date: str,
    end_date: str,
    datasets: dict[str, list[dict[str, Any]]],
) -> None:
    daily = datasets.get("daily_480d.csv", [])
    pages = datasets.get("pages_90d.csv", [])
    queries = datasets.get("queries_90d.csv", [])
    commercial = datasets.get("priority_queries_480d.csv", [])
    inspections = datasets.get("url_inspection.csv", [])
    total_clicks = sum(row.get("clicks", 0) for row in daily)
    total_impressions = sum(row.get("impressions", 0) for row in daily)
    first_impression_date = next(
        (row.get("date") for row in daily if row.get("impressions", 0) > 0),
        "none in export",
    )
    top_commercial = sorted(
        commercial,
        key=lambda row: (row.get("impressions", 0), row.get("clicks", 0)),
        reverse=True,
    )[:20]
    verdicts = Counter(row.get("verdict", "UNKNOWN") or "UNKNOWN" for row in inspections)

    if total_impressions == 0:
        signal = "No Search Analytics impressions were returned for the selected history."
    elif not commercial:
        signal = "The property has impressions, but the commercial query filter returned no visible query rows."
    else:
        signal = "The property has Search Analytics evidence; use the tables below to separate indexation from ranking weakness."

    lines = [
        "# GSC visibility snapshot",
        "",
        f"Property: `{property_url}`",
        f"Period: `{start_date}` to `{end_date}` (finalised-data buffer applied)",
        "",
        "## Observed totals",
        "",
        f"- Clicks across daily export: {total_clicks:g}",
        f"- Impressions across daily export: {total_impressions:g}",
        f"- First date with an impression: {first_impression_date}",
        f"- Pages with 90-day Search Analytics rows: {len(pages)}",
        f"- Visible query rows in 90 days: {len(queries)}",
        f"- Visible commercial query rows in 480 days: {len(commercial)}",
        f"- Initial signal: {signal}",
        "",
        "## Commercial queries by impressions",
        "",
        "| Query | Clicks | Impressions | CTR | Position |",
        "|---|---:|---:|---:|---:|",
    ]
    if top_commercial:
        for row in top_commercial:
            lines.append(
                f"| {str(row.get('query', '')).replace('|', '\\|')} | "
                f"{row.get('clicks', 0):g} | {row.get('impressions', 0):g} | "
                f"{row.get('ctr', 0):.2%} | {row.get('position', 0):.2f} |"
            )
    else:
        lines.append("| No visible rows | 0 | 0 | 0% | 0 |")

    lines.extend(["", "## URL Inspection", ""])
    if inspections:
        lines.append(
            "Verdicts: " + ", ".join(f"{name}={count}" for name, count in sorted(verdicts.items()))
        )
    else:
        lines.append("Not collected. Re-run with `snapshot --inspect-sitemap`.")

    lines.extend(
        [
            "",
            "## Interpretation boundaries",
            "",
            "- Query-level rows are incomplete because Google anonymises some queries.",
            "- Page-level and daily property totals are the stronger visibility baseline.",
            "- URL Inspection is cached Google index information, not a live test.",
            "- This snapshot identifies evidence; it does not by itself prove a ranking cause.",
            "",
        ]
    )
    path.write_text("\n".join(lines), encoding="utf-8")
