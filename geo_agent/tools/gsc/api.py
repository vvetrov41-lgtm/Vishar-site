"""Thin read-only wrappers around Google Search Console API operations."""

from __future__ import annotations

import copy
import time
from collections.abc import Iterable
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .config import READONLY_SCOPE, ConfigurationError, load_credentials_info

PAGE_SIZE = 25_000


def build_service(credentials_path: Path, version: str = "v1") -> Any:
    """Build an authenticated Search Console service without printing secrets."""
    credentials_info = load_credentials_info(credentials_path)
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
    except ImportError as exc:
        raise ConfigurationError(
            "Google API libraries are missing. Run: "
            "python scripts/setup_gsc.py"
        ) from exc

    credentials = service_account.Credentials.from_service_account_info(
        credentials_info, scopes=[READONLY_SCOPE]
    )
    return build(
        "searchconsole",
        version,
        credentials=credentials,
        cache_discovery=False,
    )


def list_sites(service: Any) -> list[dict[str, Any]]:
    response = service.sites().list().execute()
    return response.get("siteEntry", [])


def fetch_search_analytics(
    service: Any,
    property_url: str,
    *,
    start_date: str,
    end_date: str,
    dimensions: list[str],
    search_type: str = "web",
    data_state: str = "final",
    aggregation_type: str = "auto",
    filters: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    body: dict[str, Any] = {
        "startDate": start_date,
        "endDate": end_date,
        "dimensions": dimensions,
        "type": search_type,
        "dataState": data_state,
        "aggregationType": aggregation_type,
    }
    if filters:
        body["dimensionFilterGroups"] = [
            {"groupType": "and", "filters": filters}
        ]

    rows: list[dict[str, Any]] = []
    start_row = 0
    while True:
        page_body = copy.deepcopy(body)
        page_body["startRow"] = start_row
        page_body["rowLimit"] = PAGE_SIZE
        response = (
            service.searchanalytics()
            .query(siteUrl=property_url, body=page_body)
            .execute()
        )
        batch = response.get("rows", [])
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        start_row += PAGE_SIZE
    return normalize_rows(rows, dimensions)


def normalize_rows(
    rows: Iterable[dict[str, Any]], dimensions: list[str]
) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for source in rows:
        keys = source.get("keys", [])
        row = {
            dimension: keys[index] if index < len(keys) else ""
            for index, dimension in enumerate(dimensions)
        }
        row.update(
            {
                "clicks": source.get("clicks", 0),
                "impressions": source.get("impressions", 0),
                "ctr": round(source.get("ctr", 0), 6),
                "position": round(source.get("position", 0), 2),
            }
        )
        normalized.append(row)
    return normalized


def validate_inspection_urls(urls: Iterable[str]) -> list[str]:
    allowed_hosts = {"vishartattoo.com", "www.vishartattoo.com"}
    clean: list[str] = []
    for value in urls:
        value = value.strip()
        if not value:
            continue
        parsed = urlparse(value)
        if parsed.scheme != "https" or parsed.hostname not in allowed_hosts:
            raise ConfigurationError(
                f"Refusing URL Inspection outside vishartattoo.com: {value}"
            )
        clean.append(value)
    if not clean:
        raise ConfigurationError("No valid URLs supplied for inspection.")
    return list(dict.fromkeys(clean))


def inspect_urls(
    service: Any,
    property_url: str,
    urls: Iterable[str],
    *,
    delay_seconds: float = 1.0,
    max_retries: int = 3,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    clean_urls = validate_inspection_urls(urls)
    for index, url in enumerate(clean_urls):
        results.append(
            inspect_url(
                service,
                property_url,
                url,
                max_retries=max_retries,
            )
        )
        if index + 1 < len(clean_urls):
            time.sleep(max(0, delay_seconds))
    return results


def inspect_url(
    service: Any,
    property_url: str,
    url: str,
    *,
    max_retries: int,
) -> dict[str, Any]:
    for attempt in range(max_retries):
        try:
            response = (
                service.urlInspection()
                .index()
                .inspect(body={"inspectionUrl": url, "siteUrl": property_url})
                .execute()
            )
            result = response.get("inspectionResult", {}).get(
                "indexStatusResult", {}
            )
            return {
                "url": url,
                "verdict": result.get("verdict", ""),
                "coverage_state": result.get("coverageState", ""),
                "indexing_state": result.get("indexingState", ""),
                "last_crawl_time": result.get("lastCrawlTime", ""),
                "google_canonical": result.get("googleCanonical", ""),
                "user_canonical": result.get("userCanonical", ""),
                "robots_txt_state": result.get("robotsTxtState", ""),
                "crawled_as": result.get("crawledAs", ""),
                "page_fetch_state": result.get("pageFetchState", ""),
                "referring_urls": "; ".join(result.get("referringUrls", []))
                if isinstance(result.get("referringUrls", []), list)
                else str(result.get("referringUrls", "")),
                "error": "",
            }
        except Exception as exc:  # API exception classes are optional dependencies.
            message = str(exc)
            retryable = "429" in message or "quota" in message.lower()
            if retryable and attempt + 1 < max_retries:
                time.sleep(2 ** (attempt + 1))
                continue
            return {
                "url": url,
                "verdict": "ERROR",
                "coverage_state": "",
                "indexing_state": "",
                "last_crawl_time": "",
                "google_canonical": "",
                "user_canonical": "",
                "robots_txt_state": "",
                "crawled_as": "",
                "page_fetch_state": "",
                "referring_urls": "",
                "error": message,
            }
    raise AssertionError("unreachable")
