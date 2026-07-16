from __future__ import annotations

import sys
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
RUNTIME = REPO / ".geo-topic-agent-runtime"
sys.path.insert(0, str(RUNTIME))

from geo_topic_agent.llm_accessibility import inspect_access_barrier  # noqa: E402


def test_site_unavailable_interstitial_is_a_page_block() -> None:
    html = """
    <html>
      <head><title>Site Unavailable</title></head>
      <body>
        <h1>Site Unavailable</h1>
        <p>Unable to access this site.</p>
      </body>
    </html>
    """

    result = inspect_access_barrier(html)

    assert result["class"] == "page_block"
    assert result["confidence"] == "high"
    assert "site_unavailable" in result["page_block_markers"]
