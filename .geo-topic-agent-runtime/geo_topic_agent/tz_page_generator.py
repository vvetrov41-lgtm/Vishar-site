from __future__ import annotations

import html
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from statistics import median
from pathlib import Path
from typing import Any

from .core import (
    IMPORT_REL,
    PROCESSED_REL,
    QUALITY_REL,
    RAW_REL,
    REPORTS_REL,
    bounded_text,
    ensure_dirs,
    escape_md,
    find_project_root,
    configured_semantic_cluster_queries,
    full_workflow_prerequisite_gate,
    load_config,
    normalize_domain,
    normalize_ws,
    decode_text_bytes,
    observation,
    portable_ref,
    read_csv,
    read_json,
    read_query_file,
    read_text_lossless,
    sha12,
    slugify,
    split_csv,
    update_state,
    utc_now,
    write_csv,
    write_json,
    write_raw_bytes,
    write_text,
)


STOPWORDS = {
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it', 'of', 'on',
    'or', 'that', 'the', 'this', 'to', 'vs', 'was', 'what', 'when', 'with', 'you', 'your', 'about', 'into',
    'и', 'или', 'для', 'как', 'что', 'это', 'где', 'когда', 'сколько', 'цена', 'стоимость', 'на', 'в', 'во',
    'с', 'со', 'по', 'от', 'из', 'к', 'ко', 'до', 'при', 'про', 'под', 'над', 'без', 'за', 'а', 'но', 'не',
    'есть', 'быть', 'можно', 'нужно', 'его', 'ее', 'их', 'мы', 'вы', 'они', 'он', 'она', 'оно',
}

COPYWRITER_NOISE_PATTERNS = [
    '\\bopens? in (a )?new tab\\b',
    'страница откроется',
    '\\bcommercial child queries\\b',
    '\\btechnical anti[- ]?garbage\\b',
    '\\bagent[_ -]?(review|cluster|notes?|task|to[_ -]?determine)\\b',
    '\\b(pending|blocked|quality|fetch|source|raw)[_ -](status|ref|error|action|rows?)\\b',
    '\\b(qfo_page|qfo_theme|chunk_\\d+|cmp_\\d+)\\b',
    '\\b(none|unknown|not set|null|nan)\\b',
    '\\.\\.\\.',
]

NGRAM_QUOTAS = {1: 40, 2: 70, 3: 40}
NGRAM_OUTPUT_ORDER = [2, 3, 1]
DENSITY_TARGET_WORDS = 1000

def generate_page_tz(
    project_dir: Path,
    topic: str,
    competitor_urls: str = "",
    competitor_content_dir: str = "",
    qfo_queries_file: str = "",
    approved_content_plan_file: str = "",
    page_id: str = "",
    cluster_queries: str = "",
    cluster_queries_file: str = "",
    max_competitors: int = 5,
    network_approved: bool = False,
    timeout: int = 15,
    language: str = "ru",
) -> dict[str, Any]:
    root = find_project_root(project_dir)
    ensure_dirs(root)
    if not topic:
        return observation("invalid_args", "Topic is required for page TZ generation.", next_valid_actions=["provide_topic"])
    workflow_gate = full_workflow_prerequisite_gate(root)
    if workflow_gate.get("status") != "pass":
        return observation("blocked", "Page TZ generation requires completed project context and audit gates.", items=[workflow_gate], next_valid_actions=workflow_gate.get("next_valid_actions", []))

    topic_slug = slugify(topic)
    run_id = f"page_tz_{sha12(topic + utc_now())}"
    raw_dir = root / RAW_REL / "pages" / run_id
    competitors = select_tz_competitors(root, topic, competitor_urls, max_competitors)
    qfo_queries = load_tz_qfo_queries(
        root,
        topic,
        qfo_queries_file,
        cluster_queries,
        cluster_queries_file,
        approved_content_plan_file,
        page_id,
    )
    if not qfo_queries:
        report_path = root / REPORTS_REL / "PAGE_TZ_GENERATION.md"
        write_text(
            report_path,
            "# PAGE_TZ_GENERATION\n\n"
            "Page TZ generation was blocked because no QFO title semantics or confirmed semantic cluster queries were available. "
            "Provide `--cluster-queries`, `--cluster-queries-file`, or `--qfo-queries-file`; this generator must not invent a query set from the bare topic.\n",
        )
        return observation("blocked", "Page TZ generation requires QFO title semantics or confirmed semantic cluster queries for this topic.", evidence_refs=[str(report_path)], next_valid_actions=["provide_cluster_queries", "run_qfo_analysis", "rerun_generate_page_tz"])
    content_dir = Path(competitor_content_dir) if competitor_content_dir else Path()
    local_snapshots = load_local_snapshots(content_dir) if competitor_content_dir else []

    parsed_pages: list[dict[str, Any]] = []
    quality_rows: list[dict[str, Any]] = []
    for idx, competitor in enumerate(competitors, start=1):
        fetched = fetch_competitor_content(competitor, idx, raw_dir, local_snapshots, network_approved, timeout)
        parsed = parse_competitor_content(fetched.get("raw_text", ""), fetched.get("source_ref", ""), competitor)
        quality = content_quality_row(competitor, fetched, parsed)
        parsed_pages.append({**competitor, **fetched, **parsed, "quality_status": quality["quality_status"]})
        quality_rows.append(quality)

    ngram_rows = build_ngram_rows(parsed_pages)
    chunk_rows = build_tz_chunk_rows(topic, qfo_queries, parsed_pages, ngram_rows, language)
    tz_payload = build_tz_payload(topic, qfo_queries, competitors, parsed_pages, quality_rows, ngram_rows, chunk_rows)
    status = page_tz_status(competitors, quality_rows, ngram_rows, chunk_rows)

    competitors_path = root / PROCESSED_REL / f"{topic_slug}_tz_competitors.csv"
    quality_path = root / PROCESSED_REL / f"{topic_slug}_tz_content_quality.csv"
    ngrams_path = root / PROCESSED_REL / f"{topic_slug}_tz_ngrams.csv"
    chunks_path = root / PROCESSED_REL / f"{topic_slug}_tz_chunks.csv"
    json_path = root / PROCESSED_REL / f"{topic_slug}_page_tz.json"
    tz_report_path = root / REPORTS_REL / "PAGE_TZ.md"
    generation_report_path = root / REPORTS_REL / "PAGE_TZ_GENERATION.md"
    quality_gate_path = root / QUALITY_REL / f"{topic_slug}_page_tz_quality.json"

    write_csv(competitors_path, competitors)
    write_csv(quality_path, quality_rows)
    write_csv(ngrams_path, ngram_rows)
    write_csv(chunks_path, chunk_rows)
    write_json(json_path, tz_payload)
    write_json(quality_gate_path, {
        "topic": topic,
        "topic_slug": topic_slug,
        "status": status,
        "competitors": len(competitors),
        "qfo_or_cluster_queries": len(qfo_queries),
        "parsed_pass_or_warn": sum(1 for row in quality_rows if row.get("quality_status") in {"pass", "warn"}),
        "blocked": sum(1 for row in quality_rows if row.get("quality_status") == "blocked"),
        "ngrams": len(ngram_rows),
        "ngram_distribution": ngram_distribution(ngram_rows),
        "chunks": len(chunk_rows),
        "generated_at": utc_now(),
    })
    delivery_path = tz_report_path
    if status == "success":
        write_text(tz_report_path, render_page_tz_markdown(root, tz_payload))
    else:
        delivery_path = root / REPORTS_REL / "PAGE_TZ_BLOCKED.md"
        write_text(
            delivery_path,
            "# PAGE_TZ_BLOCKED\n\n"
            "No copywriter brief was delivered because the evidence quality gate did not pass. "
            "Do not use any existing PAGE_TZ.md as output for this run.\n\n"
            f"- status: {status}\n"
            f"- selected competitors: {len(competitors)}\n"
            f"- usable competitor parses: {sum(1 for row in quality_rows if row.get('quality_status') in {'pass', 'warn'})}\n"
            f"- QFO or confirmed cluster queries: {len(qfo_queries)}\n"
            "- required next action: provide accessible competitor evidence or local snapshots, then rerun.\n"
        )
    write_text(generation_report_path, render_page_tz_generation_report(root, topic, competitors, quality_rows, ngram_rows, chunk_rows, {
        "competitors": competitors_path,
        "quality": quality_path,
        "ngrams": ngrams_path,
        "chunks": chunks_path,
        "json": json_path,
        "page_tz": delivery_path,
        "quality_gate": quality_gate_path,
    }))
    update_state(root, f"Page TZ {'generated' if status == 'success' else 'blocked'} for {topic}", [str(delivery_path), str(generation_report_path), str(json_path)])

    return observation(
        status,
        "Page TZ generated." if status == "success" else "Page TZ was blocked; no copywriter brief was delivered.",
        items=[{
            "topic": topic,
            "competitors": len(competitors),
            "qfo_or_cluster_queries": len(qfo_queries),
            "parsed_pass_or_warn": sum(1 for row in quality_rows if row.get("quality_status") in {"pass", "warn"}),
            "ngrams": len(ngram_rows),
            "chunks": len(chunk_rows),
        }],
        evidence_refs=[str(delivery_path), str(generation_report_path), str(json_path), str(quality_gate_path)],
        next_valid_actions=["review_page_tz", "revise_tz_wording", "collect_blocked_competitors"] if status != "success" else ["review_page_tz", "create_or_update_page"],
    )


def select_tz_competitors(root: Path, topic: str, competitor_urls: str, max_competitors: int) -> list[dict[str, Any]]:
    topic_terms = topic_token_set(topic)
    rows: dict[str, dict[str, Any]] = {}
    for path in (root / PROCESSED_REL).glob("*.csv"):
        name = path.name.lower()
        if not any(token in name for token in ["ai_answers", "qfo_ai_titles", "live_ai_answers"]):
            continue
        for row in read_csv(path):
            url = row.get("citation_url") or row.get("url") or ""
            title = row.get("citation_title") or row.get("base_title") or row.get("title") or ""
            prompt = row.get("prompt") or row.get("source_query") or row.get("query") or ""
            if not url:
                continue
            key = normalized_competitor_key(url)
            score = overlap_score(topic_terms, " ".join([title, prompt, normalize_domain(url)]))
            if score <= 0 and topic_terms:
                continue
            item = rows.setdefault(key, {
                "competitor_id": f"cmp_{len(rows) + 1:03d}",
                "url": url,
                "domain": normalize_domain(url),
                "title": title,
                "source_files": set(),
                "source_prompts": set(),
                "ai_citation_count": 0,
                "topic_overlap": 0,
                "selection_source": "ai_citation_history",
            })
            item["ai_citation_count"] += 1
            item["topic_overlap"] = max(int(item.get("topic_overlap", 0)), score)
            if title and not item.get("title"):
                item["title"] = title
            if prompt:
                item["source_prompts"].add(prompt)
            item["source_files"].add(str(path))

    for url in qfo_split_urls(competitor_urls):
        key = normalized_competitor_key(url)
        item = rows.setdefault(key, {
            "competitor_id": f"cmp_{len(rows) + 1:03d}",
            "url": url,
            "domain": normalize_domain(url),
            "title": "",
            "source_files": set(),
            "source_prompts": set(),
            "ai_citation_count": 0,
            "topic_overlap": overlap_score(topic_terms, url),
            "selection_source": "explicit_user_or_command_url",
        })
        item["selection_source"] = item["selection_source"] if item["selection_source"] == "ai_citation_history" else "explicit_user_or_command_url"

    selected = sorted(rows.values(), key=lambda row: (-int(row.get("topic_overlap", 0)), -int(row.get("ai_citation_count", 0)), row.get("domain", ""), row.get("url", "")))[: max(1, max_competitors)]
    out = []
    for idx, row in enumerate(selected, start=1):
        out.append({
            "competitor_id": f"cmp_{idx:03d}",
            "url": row.get("url", ""),
            "domain": row.get("domain", ""),
            "title": row.get("title", ""),
            "ai_citation_count": row.get("ai_citation_count", 0),
            "topic_overlap": row.get("topic_overlap", 0),
            "selection_source": row.get("selection_source", ""),
            "source_prompts": " | ".join(sorted(row.get("source_prompts", []))[:8]),
            "source_files": " | ".join(sorted(row.get("source_files", []))[:8]),
        })
    return out


def qfo_split_urls(value: str) -> list[str]:
    if not value:
        return []
    parts = re.split(r"[\n;,]+", value)
    return [normalize_ws(part) for part in parts if normalize_ws(part)]


def normalized_competitor_key(url: str) -> str:
    if not re.match(r"^https?://", url, flags=re.IGNORECASE):
        return str(Path(url)).lower()
    parsed = urllib.parse.urlsplit(url)
    return f"{parsed.netloc.lower().removeprefix('www.')}{parsed.path.rstrip('/').lower()}"


def topic_token_set(value: str) -> set[str]:
    return {token for token in tokenize(value) if token not in STOPWORDS and len(token) > 2}


def overlap_score(topic_terms: set[str], value: str) -> int:
    if not topic_terms:
        return 1
    terms = set(tokenize(value))
    return len(topic_terms & terms)


def clean_writer_phrase(value: str) -> str:
    cleaned = normalize_ws(str(value or "").strip().strip("-*• "))
    cleaned = cleaned.strip('"\'`')
    return normalize_ws(cleaned)


def is_writer_facing_phrase(value: str) -> bool:
    cleaned = clean_writer_phrase(value)
    if len(cleaned) < 3:
        return False
    lower = cleaned.casefold()
    if lower.startswith(("{", "[", "<")):
        return False
    if re.match(r"^https?://", lower):
        return False
    if any(re.search(pattern, lower, flags=re.IGNORECASE) for pattern in COPYWRITER_NOISE_PATTERNS):
        return False
    tokens = tokenize(cleaned)
    if not tokens:
        return False
    if len(tokens) <= 2 and all(token in STOPWORDS or token.isdigit() for token in tokens):
        return False
    return True


def filter_writer_facing_phrases(values: list[str], limit: int = 120) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        cleaned = clean_writer_phrase(value)
        if not is_writer_facing_phrase(cleaned):
            continue
        key = cleaned.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(cleaned)
        if len(out) >= limit:
            break
    return out


def load_tz_qfo_queries(
    root: Path,
    topic: str,
    qfo_queries_file: str,
    cluster_queries: str = "",
    cluster_queries_file: str = "",
    approved_content_plan_file: str = "",
    page_id: str = "",
) -> list[str]:
    queries: list[str] = []
    queries.extend(split_csv(cluster_queries))
    queries.extend(read_query_file(cluster_queries_file))
    if not queries:
        queries.extend(configured_semantic_cluster_queries(load_config(root), topic))

    if approved_content_plan_file:
        path = Path(approved_content_plan_file)
        if not path.exists() or not page_id:
            return []
        if path.suffix.lower() == ".csv":
            plan_rows = read_csv(path)
        else:
            payload = read_json(path, {})
            plan_rows = payload.get("content_plan", payload.get("rows", [])) if isinstance(payload, dict) else payload
        if not isinstance(plan_rows, list):
            return []
        selected = [
            row for row in plan_rows
            if isinstance(row, dict)
            and str(row.get("page_id", "")).strip() == page_id
            and str(row.get("approval_status") or row.get("status") or "").strip().lower() == "approved"
        ]
        if len(selected) != 1:
            return []
        row = selected[0]
        for field in ["included_queries", "source_queries", "included_titles", "target_title", "cluster_name"]:
            value = row.get(field) or ""
            for part in re.split(r"\s+\|\s+|[\n;]+", str(value)):
                if normalize_ws(part):
                    queries.append(normalize_ws(part))

    if qfo_queries_file and Path(qfo_queries_file).exists():
        path = Path(qfo_queries_file)
        if path.suffix.lower() == ".csv":
            for row in read_csv(path):
                approval_status = str(row.get("approval_status") or row.get("status") or "").strip().lower()
                if approval_status not in {"approved", "externally_approved"}:
                    continue
                query = row.get("semantic_title") or row.get("query") or row.get("qfo_query") or ""
                if query:
                    queries.append(query)
        else:
            queries.extend(qfo_split_urls(read_text_lossless(path)))

    return filter_writer_facing_phrases(queries, 120)

def topic_overlap_filename(topic: str, filename: str) -> bool:
    return overlap_score(topic_token_set(topic), filename.replace("-", " ")) > 0


def load_local_snapshots(content_dir: Path) -> list[dict[str, str]]:
    if not content_dir.exists():
        return []
    rows = []
    for path in sorted(p for p in content_dir.rglob("*") if p.is_file() and p.suffix.lower() in {".html", ".htm", ".txt", ".md"}):
        try:
            rows.append({"path": str(path), "name": path.name.lower(), "text": read_text_lossless(path)})
        except OSError:
            continue
    return rows


def fetch_competitor_content(
    competitor: dict[str, Any],
    index: int,
    raw_dir: Path,
    local_snapshots: list[dict[str, str]],
    network_approved: bool,
    timeout: int,
) -> dict[str, Any]:
    url = competitor.get("url", "")
    local = match_local_snapshot(competitor, local_snapshots, index)
    if local:
        raw_path = raw_dir / f"{competitor.get('competitor_id', f'cmp_{index:03d}')}_local{Path(local['path']).suffix or '.html'}"
        write_text(raw_path, local["text"])
        return {"fetch_status": "success", "fetch_method": "local_snapshot", "source_ref": str(raw_path), "raw_text": local["text"], "fetch_error": ""}
    if url and not re.match(r"^https?://", url, flags=re.IGNORECASE):
        path = Path(url)
        if path.exists():
            text = read_text_lossless(path)
            raw_path = raw_dir / f"{competitor.get('competitor_id', f'cmp_{index:03d}')}_file{path.suffix or '.html'}"
            write_text(raw_path, text)
            return {"fetch_status": "success", "fetch_method": "local_file", "source_ref": str(raw_path), "raw_text": text, "fetch_error": ""}
    if not network_approved:
        return {"fetch_status": "blocked", "fetch_method": "http", "source_ref": "", "raw_text": "", "fetch_error": "network approval missing"}
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "geo-topic-agent-page-tz/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw_bytes = resp.read()
            raw, _ = decode_text_bytes(raw_bytes, resp.headers.get("content-type", ""), source=url)
        raw_path = raw_dir / f"{competitor.get('competitor_id', f'cmp_{index:03d}')}_{slugify(competitor.get('domain', 'page'))}.html"
        write_raw_bytes(raw_path, raw_bytes)
        return {"fetch_status": "success", "fetch_method": "http", "source_ref": str(raw_path), "raw_text": raw, "fetch_error": ""}
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        return {"fetch_status": "blocked", "fetch_method": "http", "source_ref": "", "raw_text": "", "fetch_error": f"{type(exc).__name__}: {exc}"}


def match_local_snapshot(competitor: dict[str, Any], snapshots: list[dict[str, str]], index: int) -> dict[str, str] | None:
    if not snapshots:
        return None
    domain_slug = slugify(competitor.get("domain", ""))
    comp_id = competitor.get("competitor_id", f"cmp_{index:03d}").lower()
    for row in snapshots:
        name = row["name"]
        if comp_id in name or (domain_slug and domain_slug in slugify(name)):
            return row
    if index <= len(snapshots):
        return snapshots[index - 1]
    return None


def parse_competitor_content(raw: str, source_ref: str, competitor: dict[str, Any]) -> dict[str, Any]:
    if not raw:
        return {"parsed_title": competitor.get("title", ""), "meta_description": "", "headings": "", "main_text": "", "word_count": 0, "heading_count": 0, "commercial_signals": ""}
    title = first_match(raw, r"<title[^>]*>(.*?)</title>") or competitor.get("title", "")
    meta = first_match(raw, r"<meta[^>]+name=[\"']description[\"'][^>]+content=[\"'](.*?)[\"']")
    headings = []
    for level, text in re.findall(r"<h([1-3])[^>]*>(.*?)</h\1>", raw, flags=re.IGNORECASE | re.DOTALL):
        clean = clean_html_text(text)
        if clean:
            headings.append(f"H{level}: {clean}")
    main_text = clean_html_text(strip_boilerplate(raw))
    words = tokenize(main_text)
    signals = commercial_signals(main_text)
    return {
        "parsed_title": clean_html_text(title),
        "meta_description": clean_html_text(meta),
        "headings": " | ".join(headings[:40]),
        "main_text": bounded_text(main_text, 30000),
        "word_count": len(words),
        "heading_count": len(headings),
        "commercial_signals": " | ".join(signals),
    }


def strip_boilerplate(raw: str) -> str:
    text = raw
    for tag in ["script", "style", "noscript", "svg", "header", "footer", "nav", "aside", "form"]:
        text = re.sub(rf"<{tag}\b[^>]*>.*?</{tag}>", " ", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<!--.*?-->", " ", text, flags=re.DOTALL)
    return text


def clean_html_text(value: str) -> str:
    text = re.sub(r"<[^>]+>", " ", value or "")
    text = html.unescape(text)
    return normalize_ws(text)


def first_match(value: str, pattern: str) -> str:
    match = re.search(pattern, value or "", flags=re.IGNORECASE | re.DOTALL)
    return match.group(1) if match else ""


def commercial_signals(text: str) -> list[str]:
    lower = text.lower()
    signals = []
    for label, tokens in {
        "price": ["price", "pricing", "cost", "стоимость", "цена", "$", "₽"],
        "comparison": ["compare", "comparison", "vs", "versus", "сравн"],
        "service": ["service", "solution", "platform", "software", "услуг", "сервис"],
        "proof": ["case study", "reviews", "rating", "отзывы", "кейс"],
        "faq": ["faq", "questions", "вопрос"],
    }.items():
        if any(token in lower for token in tokens):
            signals.append(label)
    return signals


def content_quality_row(competitor: dict[str, Any], fetched: dict[str, Any], parsed: dict[str, Any]) -> dict[str, Any]:
    word_count = int(parsed.get("word_count", 0) or 0)
    heading_count = int(parsed.get("heading_count", 0) or 0)
    if fetched.get("fetch_status") != "success":
        status = "blocked"
    elif word_count >= 500 and heading_count >= 2:
        status = "pass"
    elif word_count >= 180:
        status = "warn"
    else:
        status = "blocked"
    return {
        "competitor_id": competitor.get("competitor_id", ""),
        "url": competitor.get("url", ""),
        "domain": competitor.get("domain", ""),
        "fetch_status": fetched.get("fetch_status", ""),
        "fetch_method": fetched.get("fetch_method", ""),
        "quality_status": status,
        "word_count": word_count,
        "heading_count": heading_count,
        "commercial_signals": parsed.get("commercial_signals", ""),
        "source_ref": fetched.get("source_ref", ""),
        "fetch_error": fetched.get("fetch_error", ""),
        "next_action": "use_content" if status in {"pass", "warn"} else "collect_with_browser_or_provide_snapshot",
    }


def tokenize(value: str) -> list[str]:
    return [token.casefold() for token in re.findall('[A-Za-zА-Яа-яЁё0-9]+', value or "") if len(token) > 1]


def ngram_distribution(ngram_rows: list[dict[str, Any]]) -> dict[str, int]:
    distribution: dict[str, int] = {"1": 0, "2": 0, "3": 0}
    for row in ngram_rows:
        n = str(row.get("n", ""))
        if n in distribution:
            distribution[n] += 1
    return distribution


def density_percent(count: int, token_count: int) -> float:
    if token_count <= 0:
        return 0.0
    return round((count / token_count) * 100, 4)


def build_ngram_rows(parsed_pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    total: Counter[tuple[str, ...]] = Counter()
    docs: dict[tuple[str, ...], set[str]] = defaultdict(set)
    doc_counts: dict[tuple[str, ...], Counter[str]] = defaultdict(Counter)
    doc_token_counts: dict[str, int] = {}

    for page in parsed_pages:
        if page.get("quality_status") not in {"pass", "warn"}:
            continue
        doc_id = page.get("competitor_id") or page.get("domain") or f"doc_{len(doc_token_counts) + 1}"
        tokens = [token for token in tokenize(page.get("main_text", "")) if not token.isdigit()]
        doc_token_counts[doc_id] = len(tokens)
        per_doc: Counter[tuple[str, ...]] = Counter()
        for n in [1, 2, 3]:
            for idx in range(0, max(0, len(tokens) - n + 1)):
                gram = tuple(tokens[idx: idx + n])
                if any(part in STOPWORDS or len(part) <= 2 for part in gram):
                    continue
                per_doc[gram] += 1
        for gram, count in per_doc.items():
            total[gram] += count
            docs[gram].add(doc_id)
            doc_counts[gram][doc_id] = count

    candidates_by_n: dict[int, list[dict[str, Any]]] = defaultdict(list)
    usable_doc_ids = [doc_id for doc_id, token_count in doc_token_counts.items() if token_count > 0]
    for gram, count in total.items():
        n = len(gram)
        density_values = [density_percent(doc_counts[gram].get(doc_id, 0), doc_token_counts.get(doc_id, 0)) for doc_id in usable_doc_ids]
        nonzero_density_values = [value for value in density_values if value > 0]
        median_density = round(float(median(density_values)), 4) if density_values else 0.0
        nonzero_median_density = round(float(median(nonzero_density_values)), 4) if nonzero_density_values else 0.0
        recommended_density = median_density if median_density > 0 else nonzero_median_density
        per_1000 = round(recommended_density * (DENSITY_TARGET_WORDS / 100), 1)
        density_by_doc = []
        for doc_id in usable_doc_ids:
            doc_count = doc_counts[gram].get(doc_id, 0)
            density_by_doc.append(f"{doc_id}:{doc_count}/{doc_token_counts.get(doc_id, 0)}={density_percent(doc_count, doc_token_counts.get(doc_id, 0))}%")
        candidates_by_n[n].append({
            "ngram": " ".join(gram),
            "n": n,
            "count": count,
            "document_count": len(docs[gram]),
            "median_density_pct": median_density,
            "nonzero_median_density_pct": nonzero_median_density,
            "recommended_density_pct": recommended_density,
            "recommended_occurrences_per_1000_words": per_1000,
            "recommended_min_occurrences_per_1000_words": round(per_1000 * 0.75, 1),
            "recommended_max_occurrences_per_1000_words": round(per_1000 * 1.25, 1),
            "competitor_density_pct": " | ".join(density_by_doc),
            "density_basis": "median competitor density across all parsed pass/warn pages; nonzero median is used only when all-page median is 0",
            "recommended_use": "must_cover" if n >= 2 and len(docs[gram]) >= 2 else "use_naturally",
        })

    selected: list[dict[str, Any]] = []
    for n in NGRAM_OUTPUT_ORDER:
        rows = sorted(
            candidates_by_n.get(n, []),
            key=lambda row: (row["document_count"], row["recommended_density_pct"], row["count"], row["ngram"]),
            reverse=True,
        )
        selected.extend(rows[:NGRAM_QUOTAS.get(n, 40)])

    for idx, row in enumerate(selected, start=1):
        row["ngram_id"] = f"ng_{idx:03d}"
    return selected


def build_tz_chunk_rows(topic: str, qfo_queries: list[str], parsed_pages: list[dict[str, Any]], ngram_rows: list[dict[str, Any]], language: str) -> list[dict[str, Any]]:
    qfo_queries = filter_writer_facing_phrases(qfo_queries, 120)
    top_terms = [row["ngram"] for row in ngram_rows if row.get("recommended_use") == "must_cover" and int(row.get("n", 0) or 0) >= 2][:24]
    if not top_terms:
        top_terms = [row["ngram"] for row in ngram_rows if int(row.get("n", 0) or 0) >= 2][:18]
    if not top_terms:
        top_terms = [row["ngram"] for row in ngram_rows[:18]]
    qfo_by_intent = group_queries_by_intent(qfo_queries)
    rows = []
    chunk_specs = [
        ("answer", "direct_answer_chunk", "Write a concise answer that can be extracted and cited by AI systems."),
        ("criteria", "selection_criteria_chunk", "Explain decision criteria and tradeoffs."),
        ("comparison", "comparison_chunk", "Compare options or approaches without copying competitors."),
        ("cost", "commercial_chunk", "Explain price, cost, packages, or ROI signals when relevant to the confirmed cluster."),
        ("faq", "faq_chunk", "Answer recurring follow-up questions in compact Q/A form."),
    ]
    for idx, (intent, chunk_type, purpose) in enumerate(chunk_specs, start=1):
        related = qfo_by_intent.get(intent) or qfo_by_intent.get("overview") or qfo_queries[:8]
        rows.append({
            "chunk_id": f"chunk_{idx:03d}",
            "chunk_type": chunk_type,
            "target_intent": intent,
            "purpose": purpose,
            "qfo_queries": " | ".join(related[:10]),
            "required_terms": " | ".join(top_terms[:12]),
            "competitor_evidence": competitor_heading_samples(parsed_pages),
            "writing_instruction": chunk_instruction(topic, intent, language),
        })
    return rows


def group_queries_by_intent(queries: list[str]) -> dict[str, list[str]]:
    grouped: dict[str, list[str]] = defaultdict(list)
    for query in queries:
        lower = query.lower()
        if any(token in lower for token in ["price", "pricing", "cost", "стоимость", "цена"]):
            grouped["cost"].append(query)
        elif any(token in lower for token in ["compare", "comparison", "vs", "сравн"]):
            grouped["comparison"].append(query)
        elif any(token in lower for token in ["how", "choose", "criteria", "как", "выбрать"]):
            grouped["criteria"].append(query)
        elif any(token in lower for token in ["faq", "question", "вопрос"]):
            grouped["faq"].append(query)
        else:
            grouped["overview"].append(query)
            grouped["answer"].append(query)
    return grouped


def competitor_heading_samples(parsed_pages: list[dict[str, Any]]) -> str:
    samples = []
    for page in parsed_pages:
        if page.get("quality_status") not in {"pass", "warn"}:
            continue
        heading = (page.get("headings") or "").split(" | ")[0]
        if heading:
            samples.append(f"{page.get('domain')}: {heading}")
    return " | ".join(samples[:8])


def chunk_instruction(topic: str, intent: str, language: str) -> str:
    return f"Write this {intent} section for '{topic}' in clear, factual language. Use short paragraphs, explicit entities, decision criteria, and extractable statements. Avoid fluff, copied competitor wording, and unsupported promises."


def build_tz_payload(
    topic: str,
    qfo_queries: list[str],
    competitors: list[dict[str, Any]],
    parsed_pages: list[dict[str, Any]],
    quality_rows: list[dict[str, Any]],
    ngram_rows: list[dict[str, Any]],
    chunk_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    writer_queries = filter_writer_facing_phrases(qfo_queries, 120)
    return {
        "schema_version": "geo-topic-agent.page-tz.v2",
        "audience": "copywriter_or_copywriter_agent_without_chat_context",
        "topic": topic,
        "generated_at": utc_now(),
        "target_page": {
            "h1": topic,
            "recommended_title": f"{topic}: guide, comparison, and decision criteria",
            "url_slug": f"/{slugify(topic)}/",
            "goal": "Write a self-contained page that answers the confirmed cluster, is easy for users to read, and is easy for AI systems to extract and cite.",
        },
        "qfo_queries": writer_queries,
        "competitors": competitors,
        "content_quality": quality_rows,
        "ngram_terms": ngram_rows[:150],
        "ngram_distribution": ngram_distribution(ngram_rows),
        "chunks": chunk_rows,
        "structure": build_structure(topic, writer_queries, ngram_rows, chunk_rows),
        "copywriter_quality_requirements": [
            "Use this brief as a complete standalone task; do not rely on any previous chat context.",
            "Use competitor evidence for coverage and structure only; do not copy competitor wording.",
            "Use n-gram density targets as natural coverage guidance, not as keyword stuffing.",
            "Keep price, service, comparison, criteria, examples, risks, and FAQ facts explicit and easy to extract.",
            "Do not include internal tool notes, parser statuses, raw references, or editor QA comments in the final article.",
        ],
    }


def build_structure(topic: str, qfo_queries: list[str], ngram_rows: list[dict[str, Any]], chunk_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    terms = [row["ngram"] for row in ngram_rows if int(row.get("n", 0) or 0) >= 2][:12]
    if not terms:
        terms = [row["ngram"] for row in ngram_rows[:12]]
    return [
        {"level": "H1", "title": topic, "purpose": "Match the core topic and page promise.", "terms": " | ".join(terms[:5])},
        {"level": "H2", "title": "Short answer", "purpose": "Direct citeable answer chunk.", "chunk_id": "chunk_001"},
        {"level": "H2", "title": "How to choose", "purpose": "Decision criteria and user fit.", "chunk_id": "chunk_002"},
        {"level": "H2", "title": "Comparison and alternatives", "purpose": "Show differences and tradeoffs.", "chunk_id": "chunk_003"},
        {"level": "H2", "title": "Cost and implementation notes", "purpose": "Commercial clarity when relevant to the cluster.", "chunk_id": "chunk_004"},
        {"level": "H2", "title": "FAQ", "purpose": "Cover follow-up QFO title semantics and confirmed cluster questions.", "chunk_id": "chunk_005"},
    ]


def render_page_tz_markdown(root: Path, payload: dict[str, Any]) -> str:
    lines = [
        "# COPYWRITER_PAGE_TZ",
        "",
        "This is a standalone brief for a copywriter or copywriter agent. It must contain only instructions useful for writing the page.",
        "",
        f"Topic: {payload.get('topic')}",
        "",
        "## Page Goal",
        "",
        payload.get("target_page", {}).get("goal", ""),
        "",
        "## Target Page",
        "",
        f"- H1: {payload.get('target_page', {}).get('h1')}",
        f"- Title: {payload.get('target_page', {}).get('recommended_title')}",
        f"- URL: {payload.get('target_page', {}).get('url_slug')}",
        "",
        "## Confirmed Semantics",
        "",
    ]
    lines.extend([f"- {escape_md(query)}" for query in payload.get("qfo_queries", [])[:30]] or ["- none"])
    lines.extend(["", "## Competitor Reference", "", "Use these pages as evidence for coverage and structure. Do not copy wording.", "", "| Domain | Page Title |", "| --- | --- |"])
    for row in payload.get("competitors", []):
        title = row.get("title") or row.get("parsed_title") or ""
        lines.append(f"| {escape_md(row.get('domain', ''))} | {escape_md(title)} |")
    lines.extend(["", "## N-Gram Density Targets", "", "Use these as natural coverage targets. Density is the median competitor occurrence rate; recommended occurrences are normalized to a 1000-word draft.", "", "| N | Term | Docs | Median Density | Recommended / 1000 Words | Use |", "| ---: | --- | ---: | ---: | ---: | --- |"])
    for row in payload.get("ngram_terms", [])[:60]:
        lines.append(
            f"| {row.get('n')} | {escape_md(row.get('ngram', ''))} | {row.get('document_count', 0)} | "
            f"{row.get('recommended_density_pct', 0)}% | {row.get('recommended_occurrences_per_1000_words', 0)} | {row.get('recommended_use', '')} |"
        )
    if not payload.get("ngram_terms"):
        lines.append("| 0 | none | 0 | 0% | 0 | none |")
    lines.extend(["", "## Structure", "", "| Level | Section | Purpose | Chunk |", "| --- | --- | --- | --- |"])
    for row in payload.get("structure", []):
        lines.append(f"| {row.get('level')} | {escape_md(row.get('title', ''))} | {escape_md(row.get('purpose', ''))} | {row.get('chunk_id', '')} |")
    lines.extend(["", "## Required Chunks", ""])
    for row in payload.get("chunks", []):
        lines.extend([
            f"### {row.get('chunk_id')} - {row.get('chunk_type')}",
            "",
            f"- Purpose: {row.get('purpose')}",
            f"- Semantics to cover: {escape_md(row.get('qfo_queries', ''))}",
            f"- Required terms: {escape_md(row.get('required_terms', ''))}",
            f"- Competitor structure clues: {escape_md(row.get('competitor_evidence', ''))}",
            f"- Writing instruction: {escape_md(row.get('writing_instruction', ''))}",
            "",
        ])
    lines.extend([
        "## Copywriter Quality Requirements",
        "",
    ])
    lines.extend([f"- {escape_md(item)}" for item in payload.get("copywriter_quality_requirements", [])])
    return "\n".join(lines) + "\n"
def render_page_tz_generation_report(root: Path, topic: str, competitors: list[dict[str, Any]], quality_rows: list[dict[str, Any]], ngram_rows: list[dict[str, Any]], chunk_rows: list[dict[str, Any]], paths: dict[str, Path]) -> str:
    distribution = ngram_distribution(ngram_rows)
    lines = [
        "# PAGE_TZ_GENERATION",
        "",
        f"Generated: {utc_now()}",
        f"Topic: {topic}",
        "",
        "## Counts",
        "",
        f"- Competitors selected: {len(competitors)}",
        f"- Parse pass/warn: {sum(1 for row in quality_rows if row.get('quality_status') in {'pass', 'warn'})}",
        f"- Parse blocked: {sum(1 for row in quality_rows if row.get('quality_status') == 'blocked')}",
        f"- N-grams total: {len(ngram_rows)}",
        f"- 1-grams: {distribution.get('1', 0)}",
        f"- 2-grams: {distribution.get('2', 0)}",
        f"- 3-grams: {distribution.get('3', 0)}",
        f"- N-gram density fields: median_density_pct, recommended_density_pct, recommended_occurrences_per_1000_words",
        f"- Chunks: {len(chunk_rows)}",
        "",
        "## Output Boundary",
        "",
        "- PAGE_TZ.md is the clean copywriter-facing brief.",
        "- Parser statuses, weak competitor notes, raw refs, and QA comments stay in this generation report or CSV/JSON artifacts, not in the copywriter brief.",
        "",
        "## Artifacts",
        "",
    ]
    for label, path in paths.items():
        lines.append(f"- {label}: {portable_ref(root, path)}")
    lines.extend(["", "## Quality Notes", ""])
    for row in quality_rows:
        if row.get("quality_status") != "pass":
            lines.append(f"- {row.get('competitor_id')} {row.get('domain')}: {row.get('quality_status')} - {row.get('fetch_error') or row.get('next_action')}")
    if all(row.get("quality_status") == "pass" for row in quality_rows):
        lines.append("- all selected competitors parsed with pass quality")
    return "\n".join(lines) + "\n"
def page_tz_status(competitors: list[dict[str, Any]], quality_rows: list[dict[str, Any]], ngram_rows: list[dict[str, Any]], chunk_rows: list[dict[str, Any]]) -> str:
    usable = sum(1 for row in quality_rows if row.get("quality_status") in {"pass", "warn"})
    if competitors and usable >= 1 and ngram_rows and chunk_rows:
        return "success"
    if competitors:
        return "quality_fail"
    return "blocked"
