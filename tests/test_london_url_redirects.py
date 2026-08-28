from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
MAPPINGS = [
    ("colour-realism-tattoo-manchester", "colour-realism-tattoo-london"),
    ("black-and-grey-realism-manchester", "black-and-grey-realism-london"),
    ("cover-up-tattoo-manchester", "cover-up-tattoo-london"),
]


def test_london_specialty_routes_are_canonical() -> None:
    sitemap = (REPO / "sitemap.xml").read_text(encoding="utf-8")
    llms = (REPO / "llms.txt").read_text(encoding="utf-8")
    config = (REPO / "geo_agent" / "config" / "geo_agent_config.json").read_text(encoding="utf-8")
    tailwind = (REPO / "tailwind.config.js").read_text(encoding="utf-8")
    for old, new in MAPPINGS:
        assert not (REPO / old).exists()
        page = REPO / new / "index.html"
        assert page.is_file()
        html = page.read_text(encoding="utf-8")
        canonical = f'<link rel="canonical" href="https://vishartattoo.com/{new}/">'
        assert canonical in html
        assert old not in html
        assert f"https://vishartattoo.com/{new}/" in sitemap
        assert f"https://vishartattoo.com/{old}/" not in sitemap
        assert f"https://vishartattoo.com/{new}/" in llms
        assert f"https://vishartattoo.com/{old}/" not in llms
        assert new in config
        assert old not in config
        assert new in tailwind
        assert old not in tailwind


def test_cloudflare_redirects_preserve_old_specialty_urls() -> None:
    redirects_path = REPO / "_redirects"
    assert redirects_path.is_file()
    lines = {
        line.strip()
        for line in redirects_path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
    expected = set()
    for old, new in MAPPINGS:
        expected.update({
            f"/{old} /{new}/ 301",
            f"/{old}/ /{new}/ 301",
            f"/{old}/index.html /{new}/ 301",
        })
    assert expected == lines


def test_public_source_does_not_link_to_old_specialty_routes() -> None:
    suffixes = {".html", ".js", ".txt", ".xml"}
    ignored_top_level = {
        ".agents", ".codex", ".geo-topic-agent-runtime", ".github", ".specify",
        "geo_agent", "node_modules", "scripts", "tests",
    }
    for path in REPO.rglob("*"):
        if not path.is_file() or path.suffix not in suffixes:
            continue
        rel = path.relative_to(REPO)
        if rel.parts and rel.parts[0] in ignored_top_level:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for old, _ in MAPPINGS:
            assert old not in text, f"stale route {old} found in {rel}"
