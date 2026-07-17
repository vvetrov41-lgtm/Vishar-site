"""Command line entry point for read-only Search Console diagnostics."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from .api import (
    build_service,
    fetch_search_analytics,
    inspect_urls,
    list_sites,
)
from .config import (
    PROJECT_ROOT,
    ConfigurationError,
    credential_permissions_warning,
    load_credentials_info,
    load_settings,
    masked_email,
    validate_property,
)
from .io import (
    compare_periods,
    new_queries,
    write_csv,
    write_metadata,
    write_snapshot_summary,
)

COMMERCIAL_QUERY_REGEX = (
    r"(manchester|salford|greater.?manchester|tattoo.?artist|realism|realistic|"
    r"portrait|cover.?up|sleeve|black.?and.?grey|black.?grey|colour.?realism|"
    r"color.?realism|custom.?tattoo|tattoo.?consultation|tattoo.?(cost|price))"
)
DIMENSIONS = {
    "query",
    "page",
    "country",
    "device",
    "date",
    "searchAppearance",
    "hour",
}


def final_date() -> date:
    return date.today() - timedelta(days=3)


def parse_dimensions(value: str) -> list[str]:
    values = [item.strip() for item in value.split(",") if item.strip()]
    invalid = sorted(set(values).difference(DIMENSIONS))
    if invalid:
        raise argparse.ArgumentTypeError(
            "Unsupported dimensions: " + ", ".join(invalid)
        )
    return values


def parse_period(value: str) -> tuple[str, str]:
    parts = value.split(":", 1)
    if len(parts) != 2:
        raise argparse.ArgumentTypeError("Use YYYY-MM-DD:YYYY-MM-DD")
    try:
        start, end = (date.fromisoformat(part) for part in parts)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc
    if start > end:
        raise argparse.ArgumentTypeError("Period start must not be after end")
    return start.isoformat(), end.isoformat()


def require_service(version: str = "v1") -> tuple[Any, Any]:
    settings = load_settings()
    validate_property(settings.property_url)
    return settings, build_service(settings.credentials_path, version=version)


def command_doctor(args: argparse.Namespace) -> int:
    settings = load_settings()
    print(f"property: {settings.property_url}")
    try:
        validate_property(settings.property_url)
        print("property guard: OK")
    except ConfigurationError as exc:
        print(f"property guard: FAIL ({exc})")
        return 2

    modules = {
        "google.auth": "google-auth",
        "googleapiclient.discovery": "google-api-python-client",
        "google_auth_httplib2": "google-auth-httplib2",
    }
    missing = []
    for module, package in modules.items():
        try:
            available = importlib.util.find_spec(module) is not None
        except (ImportError, ModuleNotFoundError):
            available = False
        if not available:
            missing.append(package)
    print("python dependencies: " + ("OK" if not missing else "MISSING " + ", ".join(missing)))

    credentials_ready = True
    try:
        info = load_credentials_info(settings.credentials_path)
        print(f"credential path: OK ({settings.credentials_path})")
        print(f"service account: {masked_email(info['client_email'])}")
        warning = credential_permissions_warning(settings.credentials_path)
        if warning:
            print(f"credential permissions: WARN ({warning})")
        else:
            print("credential permissions: OK")
    except ConfigurationError as exc:
        credentials_ready = False
        print(f"credentials: MISSING ({exc})")

    if missing or not credentials_ready:
        return 2
    if not args.live:
        print("live API check: SKIPPED (add --live after credentials are configured)")
        return 0

    service = build_service(settings.credentials_path)
    sites = list_sites(service)
    match = next(
        (site for site in sites if site.get("siteUrl") == settings.property_url),
        None,
    )
    if not match:
        available = ", ".join(site.get("siteUrl", "") for site in sites) or "none"
        print(f"live property access: FAIL (available: {available})")
        return 3
    print(f"live property access: OK ({match.get('permissionLevel', 'unknown')})")
    return 0


def analytics_rows(args: argparse.Namespace, service: Any, property_url: str) -> list[dict[str, Any]]:
    filters = []
    if args.query_regex:
        filters.append(
            {
                "dimension": "query",
                "operator": "includingRegex",
                "expression": args.query_regex,
            }
        )
    return fetch_search_analytics(
        service,
        property_url,
        start_date=args.start_date,
        end_date=args.end_date,
        dimensions=args.dimensions,
        search_type=args.search_type,
        data_state=args.data_state,
        aggregation_type=args.aggregation_type,
        filters=filters,
    )


def command_analytics(args: argparse.Namespace) -> int:
    settings, service = require_service()
    rows = analytics_rows(args, service, settings.property_url)
    output = Path(args.output) if args.output else settings.output_dir / (
        f"analytics_{'-'.join(args.dimensions) or 'overview'}_{args.start_date}_{args.end_date}.csv"
    )
    write_csv(output, rows)
    write_metadata(
        output.with_suffix(".metadata.json"),
        {
            "property": settings.property_url,
            "start_date": args.start_date,
            "end_date": args.end_date,
            "dimensions": args.dimensions,
            "search_type": args.search_type,
            "data_state": args.data_state,
            "aggregation_type": args.aggregation_type,
            "query_regex": args.query_regex,
            "row_count": len(rows),
        },
    )
    print(f"saved {len(rows)} rows: {output}")
    return 0


def command_compare(args: argparse.Namespace) -> int:
    settings, service = require_service()
    shared = {
        "service": service,
        "property_url": settings.property_url,
        "dimensions": args.dimensions,
        "search_type": args.search_type,
    }
    first = fetch_search_analytics(
        **shared, start_date=args.period1[0], end_date=args.period1[1]
    )
    second = fetch_search_analytics(
        **shared, start_date=args.period2[0], end_date=args.period2[1]
    )
    rows = compare_periods(first, second, args.dimensions, args.min_impressions)
    output = Path(args.output) if args.output else settings.output_dir / (
        f"compare_{'-'.join(args.dimensions)}_{args.period1[0]}_{args.period2[1]}.csv"
    )
    write_csv(output, rows)
    print(f"saved {len(rows)} rows: {output}")
    return 0


def command_new_queries(args: argparse.Namespace) -> int:
    settings, service = require_service()
    shared = {
        "service": service,
        "property_url": settings.property_url,
        "dimensions": ["query"],
        "search_type": args.search_type,
    }
    first = fetch_search_analytics(
        **shared, start_date=args.period1[0], end_date=args.period1[1]
    )
    second = fetch_search_analytics(
        **shared, start_date=args.period2[0], end_date=args.period2[1]
    )
    rows = new_queries(first, second, args.min_impressions)
    output = Path(args.output) if args.output else settings.output_dir / (
        f"new_queries_{args.period2[0]}_{args.period2[1]}.csv"
    )
    write_csv(output, rows)
    print(f"saved {len(rows)} rows: {output}")
    return 0


def sitemap_urls(path: Path) -> list[str]:
    root = ET.parse(path).getroot()
    return [
        node.text.strip()
        for node in root.findall("{http://www.sitemaps.org/schemas/sitemap/0.9}url/{http://www.sitemaps.org/schemas/sitemap/0.9}loc")
        if node.text and node.text.strip()
    ]


def command_inspect(args: argparse.Namespace) -> int:
    settings, service = require_service()
    urls: list[str] = []
    if args.sitemap:
        urls.extend(sitemap_urls(Path(args.sitemap)))
    urls.extend(args.urls)
    if args.urls_file:
        urls.extend(
            line.strip()
            for line in Path(args.urls_file).read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        )
    rows = inspect_urls(
        service,
        settings.property_url,
        urls,
        delay_seconds=args.delay,
    )
    output = Path(args.output) if args.output else settings.output_dir / "url_inspection.csv"
    write_csv(output, rows)
    print(f"saved {len(rows)} rows: {output}")
    return 0


def command_snapshot(args: argparse.Namespace) -> int:
    settings, service = require_service()
    end = final_date()
    start_90 = end - timedelta(days=89)
    start_480 = end - timedelta(days=479)
    run_dir = settings.output_dir / f"snapshot_{end.isoformat()}"
    jobs = [
        ("daily_480d.csv", start_480, ["date"], None),
        ("pages_90d.csv", start_90, ["page"], None),
        ("queries_90d.csv", start_90, ["query"], None),
        ("query_page_90d.csv", start_90, ["query", "page"], None),
        ("priority_queries_480d.csv", start_480, ["query"], COMMERCIAL_QUERY_REGEX),
    ]
    counts: dict[str, int] = {}
    datasets: dict[str, list[dict[str, Any]]] = {}
    for filename, start, dimensions, query_regex in jobs:
        filters = None
        if query_regex:
            filters = [{"dimension": "query", "operator": "includingRegex", "expression": query_regex}]
        rows = fetch_search_analytics(
            service,
            settings.property_url,
            start_date=start.isoformat(),
            end_date=end.isoformat(),
            dimensions=dimensions,
            filters=filters,
        )
        write_csv(run_dir / filename, rows)
        counts[filename] = len(rows)
        datasets[filename] = rows

    if args.inspect_sitemap:
        urls = sitemap_urls(PROJECT_ROOT / "sitemap.xml")
        inspections = inspect_urls(service, settings.property_url, urls, delay_seconds=args.delay)
        write_csv(run_dir / "url_inspection.csv", inspections)
        counts["url_inspection.csv"] = len(inspections)
        datasets["url_inspection.csv"] = inspections

    write_snapshot_summary(
        run_dir / "GSC_SNAPSHOT_SUMMARY.md",
        property_url=settings.property_url,
        start_date=start_480.isoformat(),
        end_date=end.isoformat(),
        datasets=datasets,
    )

    write_metadata(
        run_dir / "snapshot.metadata.json",
        {
            "property": settings.property_url,
            "start_480d": start_480.isoformat(),
            "start_90d": start_90.isoformat(),
            "end_date": end.isoformat(),
            "commercial_query_regex": COMMERCIAL_QUERY_REGEX,
            "url_inspection_included": args.inspect_sitemap,
            "files": counts,
            "limitations": [
                "Search Analytics query rows are affected by anonymisation.",
                "URL Inspection is cached Google index data, not a live test.",
                "The final three days are excluded to reduce preliminary-data noise.",
            ],
        },
    )
    print(json.dumps({"saved_to": str(run_dir), "rows": counts}, indent=2))
    return 0


def add_analytics_options(parser: argparse.ArgumentParser) -> None:
    end = final_date()
    parser.add_argument("--start-date", default=(end - timedelta(days=89)).isoformat())
    parser.add_argument("--end-date", default=end.isoformat())
    parser.add_argument("--dimensions", type=parse_dimensions, default=parse_dimensions("query,page"))
    parser.add_argument("--search-type", choices=["web", "image", "video", "news", "discover", "googleNews"], default="web")
    parser.add_argument("--data-state", choices=["final", "all"], default="final")
    parser.add_argument("--aggregation-type", choices=["auto", "byPage", "byProperty"], default="auto")
    parser.add_argument("--query-regex")
    parser.add_argument("--output")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read-only GSC toolkit for vishartattoo.com")
    commands = parser.add_subparsers(dest="command", required=True)

    doctor = commands.add_parser("doctor", help="Validate local setup; no network unless --live")
    doctor.add_argument("--live", action="store_true")
    doctor.set_defaults(func=command_doctor)

    analytics = commands.add_parser("analytics", help="Export Search Analytics rows")
    add_analytics_options(analytics)
    analytics.set_defaults(func=command_analytics)

    compare = commands.add_parser("compare", help="Compare two periods")
    compare.add_argument("--period1", type=parse_period, required=True)
    compare.add_argument("--period2", type=parse_period, required=True)
    compare.add_argument("--dimensions", type=parse_dimensions, default=parse_dimensions("query"))
    compare.add_argument("--search-type", default="web")
    compare.add_argument("--min-impressions", type=int, default=5)
    compare.add_argument("--output")
    compare.set_defaults(func=command_compare)

    new = commands.add_parser("new-queries", help="Find query rows present only in period 2")
    new.add_argument("--period1", type=parse_period, required=True)
    new.add_argument("--period2", type=parse_period, required=True)
    new.add_argument("--search-type", default="web")
    new.add_argument("--min-impressions", type=int, default=5)
    new.add_argument("--output")
    new.set_defaults(func=command_new_queries)

    inspect = commands.add_parser("inspect", help="Inspect index status for project URLs")
    inspect.add_argument("urls", nargs="*")
    inspect.add_argument("--urls-file")
    inspect.add_argument("--sitemap")
    inspect.add_argument("--delay", type=float, default=1.0)
    inspect.add_argument("--output")
    inspect.set_defaults(func=command_inspect)

    snapshot = commands.add_parser("snapshot", help="Collect the standard visibility diagnosis dataset")
    snapshot.add_argument("--inspect-sitemap", action="store_true")
    snapshot.add_argument("--delay", type=float, default=1.0)
    snapshot.set_defaults(func=command_snapshot)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        return args.func(args)
    except ConfigurationError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("cancelled", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
