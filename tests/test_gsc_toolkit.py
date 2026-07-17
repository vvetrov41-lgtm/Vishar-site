from __future__ import annotations

import unittest
from unittest.mock import patch
from pathlib import Path

from geo_agent.tools.gsc.api import normalize_rows, validate_inspection_urls
from geo_agent.tools.gsc.cli import parse_dimensions, parse_period, sitemap_urls
from geo_agent.tools.gsc.config import (
    ConfigurationError,
    load_credentials_info,
    validate_property,
)
from geo_agent.tools.gsc.io import compare_periods, new_queries


class GscToolkitTests(unittest.TestCase):
    def test_property_guard_accepts_only_project_property(self) -> None:
        validate_property("sc-domain:vishartattoo.com")
        validate_property("https://vishartattoo.com/")
        with self.assertRaises(ConfigurationError):
            validate_property("sc-domain:example.com")

    def test_credentials_can_come_from_protected_environment_secret(self) -> None:
        payload = (
            '{"type":"service_account","project_id":"p","private_key":"secret",'
            '"client_email":"reader@example.iam.gserviceaccount.com",'
            '"token_uri":"https://oauth2.googleapis.com/token"}'
        )
        with patch.dict("os.environ", {"GSC_SERVICE_ACCOUNT_JSON": payload}, clear=False):
            info = load_credentials_info(Path("/does/not/exist"))
        self.assertEqual(info["project_id"], "p")

    def test_inspection_url_guard(self) -> None:
        self.assertEqual(
            validate_inspection_urls(["https://vishartattoo.com/about/"]),
            ["https://vishartattoo.com/about/"],
        )
        with self.assertRaises(ConfigurationError):
            validate_inspection_urls(["https://example.com/"])

    def test_normalize_rows(self) -> None:
        rows = normalize_rows(
            [{"keys": ["query", "page"], "clicks": 2, "impressions": 10, "ctr": 0.2, "position": 4.123}],
            ["query", "page"],
        )
        self.assertEqual(rows[0]["position"], 4.12)
        self.assertEqual(rows[0]["query"], "query")

    def test_period_and_dimensions_validation(self) -> None:
        self.assertEqual(parse_period("2026-01-01:2026-01-28"), ("2026-01-01", "2026-01-28"))
        self.assertEqual(parse_dimensions("query,page"), ["query", "page"])
        with self.assertRaises(Exception):
            parse_period("2026-02-01:2026-01-01")

    def test_compare_periods(self) -> None:
        first = [{"query": "a", "clicks": 1, "impressions": 10, "ctr": 0.1, "position": 9}]
        second = [{"query": "a", "clicks": 3, "impressions": 20, "ctr": 0.15, "position": 7}]
        rows = compare_periods(first, second, ["query"], 0)
        self.assertEqual(rows[0]["clicks_diff"], 2)
        self.assertEqual(rows[0]["position_diff"], -2)

    def test_new_queries(self) -> None:
        first = [{"query": "known", "impressions": 10}]
        second = [
            {"query": "known", "impressions": 20},
            {"query": "new", "impressions": 8, "clicks": 1},
            {"query": "noise", "impressions": 1, "clicks": 0},
        ]
        self.assertEqual(new_queries(first, second, 5)[0]["query"], "new")

    def test_tracked_sitemap_parses(self) -> None:
        root = Path(__file__).resolve().parents[1]
        urls = sitemap_urls(root / "sitemap.xml")
        self.assertIn("https://vishartattoo.com/", urls)
        self.assertGreater(len(urls), 1)


if __name__ == "__main__":
    unittest.main()
