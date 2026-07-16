from __future__ import annotations

import difflib
import html
import re
import urllib.error
import urllib.parse
import urllib.robotparser
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from .core import (
    RAW_REL,
    PROCESSED_REL,
    REPORTS_REL,
    detect_waf,
    ensure_dirs,
    escape_md,
    find_project_root,
    normalize_url,
    observation,
    portable_ref,
    sha12,
    slugify,
    strip_tags,
    update_state,
    utc_now,
    write_json,
    write_text,
)


GENERIC_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)



FORM_BLOCK_RE = re.compile(r"<form\b[^>]*>.*?</form>", re.IGNORECASE | re.DOTALL)
NON_CONTENT_BLOCK_RE = re.compile(r"<(script|style|svg|template|noscript|canvas)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
CAPTCHA_MARKER_PATTERNS = [
    ("captcha", r"\bcaptcha\b"),
    ("recaptcha", r"g-recaptcha|recaptcha"),
    ("hcaptcha", r"hcaptcha|h-captcha"),
    ("turnstile", r"cf-turnstile|turnstile"),
    ("smartcaptcha", r"smartcaptcha"),
    ("captcha_for_form", r"captcha-for-[a-z0-9_-]*form|wpcf7.*captcha|contact-form-7.*captcha"),
    ("sitekey", r"data-sitekey"),
]
PAGE_BLOCK_MARKER_PATTERNS = [
    ("access_denied", r"access denied|request blocked|forbidden"),
    ("site_unavailable", r"site unavailable|unable to access this site"),
    ("cloudflare_challenge", r"just a moment|checking your browser|checking if the site connection is secure|cf-ray|cloudflare ray"),
    ("human_verification", r"verify you are human|are you human|are you a robot|unusual traffic"),
    ("bot_protection", r"bot protection|automated requests|enable cookies"),
]
def llm_agent_matrix() -> list[dict[str, Any]]:
    return [
        {"id": "generic_browser", "provider": "Generic", "role": "ordinary browser baseline", "robots_token": "*", "http_user_agent": GENERIC_BROWSER_UA, "probe_http": False},
        {"id": "openai_searchbot", "provider": "OpenAI", "role": "AI search indexing", "robots_token": "OAI-SearchBot", "http_user_agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot", "probe_http": True},
        {"id": "chatgpt_user", "provider": "OpenAI", "role": "ChatGPT user-triggered fetch", "robots_token": "ChatGPT-User", "http_user_agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", "probe_http": True},
        {"id": "gptbot", "provider": "OpenAI", "role": "model-training crawler", "robots_token": "GPTBot", "http_user_agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.3; +https://openai.com/gptbot", "probe_http": True},
        {"id": "googlebot", "provider": "Google", "role": "Google Search crawl/render", "robots_token": "Googlebot", "http_user_agent": "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "probe_http": True},
        {"id": "google_extended", "provider": "Google", "role": "Gemini/AI product control token", "robots_token": "Google-Extended", "http_user_agent": "", "probe_http": False},
        {"id": "perplexitybot", "provider": "Perplexity", "role": "AI answer crawler", "robots_token": "PerplexityBot", "http_user_agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)", "probe_http": True},
        {"id": "perplexity_user", "provider": "Perplexity", "role": "Perplexity user-triggered fetch", "robots_token": "Perplexity-User", "http_user_agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)", "probe_http": True},
        {"id": "claudebot", "provider": "Anthropic", "role": "Claude crawler", "robots_token": "ClaudeBot", "http_user_agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +https://www.anthropic.com/claudebot", "probe_http": True},
        {"id": "claude_searchbot", "provider": "Anthropic", "role": "Claude search fetch", "robots_token": "Claude-SearchBot", "http_user_agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-SearchBot/1.0; +https://www.anthropic.com/claude-searchbot", "probe_http": True},
        {"id": "bingbot", "provider": "Microsoft", "role": "Bing/Copilot search crawl", "robots_token": "bingbot", "http_user_agent": "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "probe_http": True},
        {"id": "bingpreview", "provider": "Microsoft", "role": "Bing preview fetch", "robots_token": "BingPreview", "http_user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 BingPreview/1.0b", "probe_http": True},
        {"id": "yandexbot", "provider": "Yandex", "role": "Yandex main indexing", "robots_token": "YandexBot", "http_user_agent": "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)", "probe_http": True},
        {"id": "yandex_accessibility", "provider": "Yandex", "role": "Yandex availability/accessibility check", "robots_token": "YandexAccessibilityBot", "http_user_agent": "Mozilla/5.0 (compatible; YandexAccessibilityBot/3.0; +http://yandex.com/bots)", "probe_http": True},
    ]


class CleanContentExtractor(HTMLParser):
    block_tags = {"address", "article", "aside", "blockquote", "button", "caption", "dd", "div", "dt", "figcaption", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "li", "main", "nav", "option", "p", "section", "td", "th", "title"}
    skip_tags = {"script", "style", "svg", "canvas", "template"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in self.skip_tags:
            self.skip_depth += 1
            return
        attrs_dict = {key.lower(): value or "" for key, value in attrs}
        if tag in self.block_tags or tag == "br":
            self.parts.append("\n")
        if tag == "img" and attrs_dict.get("alt") and self.skip_depth == 0:
            self.parts.append(f" [image: {attrs_dict['alt']}] ")
        if tag == "a" and attrs_dict.get("aria-label") and self.skip_depth == 0:
            self.parts.append(f" {attrs_dict['aria-label']} ")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in self.skip_tags and self.skip_depth:
            self.skip_depth -= 1
            return
        if tag in self.block_tags:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self.skip_depth:
            return
        cleaned = re.sub(r"\s+", " ", html.unescape(data)).strip()
        if cleaned:
            self.parts.append(cleaned + " ")

    def text(self) -> str:
        raw = "".join(self.parts)
        lines = []
        for line in raw.splitlines():
            line = re.sub(r"\s+", " ", line).strip()
            if line:
                lines.append(line)
        return "\n".join(dedupe_local(lines))


def llm_accessibility_audit(project_dir: Path, url: str = "", network_approved: bool = False, render: bool = False, timeout: int = 20) -> dict[str, Any]:
    root = find_project_root(project_dir)
    ensure_dirs(root)
    if not url:
        return observation("blocked", "Page URL is required for LLM accessibility audit.", next_valid_actions=["provide_url"])

    page_url = normalize_url(url)
    parsed = urllib.parse.urlparse(page_url)
    if not parsed.netloc:
        return observation("invalid_args", "URL must include a domain or host.", items=[{"url": url}], next_valid_actions=["provide_valid_url"])

    run_id = f"{slugify(parsed.netloc)[:40]}-{sha12(page_url)}"
    raw_dir = root / RAW_REL / "llm-accessibility" / run_id
    raw_dir.mkdir(parents=True, exist_ok=True)
    matrix = llm_agent_matrix()
    robots_url = urllib.parse.urlunparse((parsed.scheme or "https", parsed.netloc, "/robots.txt", "", "", ""))

    if not network_approved:
        robots_response = {"status": "skipped", "summary": "network approval not provided", "url": robots_url}
        robots_rows = [robots_row(agent, None, "skipped", "skipped_no_network_approval") for agent in matrix]
        baseline = {"status": "skipped", "summary": "network approval not provided", "user_agent": "generic_browser"}
        http_rows = [http_skip_row(agent, "skipped_no_network_approval") for agent in matrix if agent.get("probe_http")]
        clean = {"status": "skipped", "summary": "network approval not provided", "text_chars": 0, "blocks": []}
        render_result = {"status": "skipped", "summary": "network approval not provided"}
    else:
        robots_response = fetch_http_capture(robots_url, GENERIC_BROWSER_UA, timeout, max_bytes=512000)
        robots_rows = evaluate_robots_for_agents(robots_response, page_url, matrix)
        baseline = fetch_http_capture(page_url, GENERIC_BROWSER_UA, timeout)
        if baseline.get("body_text"):
            raw_html_path = raw_dir / "baseline.html"
            write_text(raw_html_path, baseline.get("body_text", ""))
            baseline["raw_ref"] = portable_ref(root, raw_html_path)
        if is_baseline_blocked(baseline):
            http_rows = [http_skip_row(agent, "skipped_baseline_blocked") for agent in matrix if agent.get("probe_http")]
        else:
            http_rows = []
            for agent in matrix:
                if not agent.get("probe_http"):
                    continue
                row = fetch_http_capture(page_url, agent.get("http_user_agent", ""), timeout)
                row.update({"id": agent["id"], "provider": agent["provider"], "role": agent["role"], "robots_token": agent.get("robots_token", ""), "http_user_agent": agent.get("http_user_agent", "")})
                row["text_chars_delta_vs_baseline"] = int(row.get("text_chars", 0)) - int(baseline.get("text_chars", 0))
                row.pop("body_text", None)
                http_rows.append(row)
        clean = extract_llm_clean_content(baseline.get("body_text", ""), page_url)
        if clean.get("text"):
            clean_path = raw_dir / "llm_clean_content.txt"
            write_text(clean_path, clean["text"])
            clean["text_ref"] = portable_ref(root, clean_path)
        render_result = render_page_capture(page_url, raw_dir, timeout, root) if render else {"status": "skipped", "summary": "render flag not set"}

    rendered_text = render_result.get("rendered_text", "") if isinstance(render_result, dict) else ""
    if clean.get("status") == "skipped":
        parity = {"status": "skipped", "summary": "clean content extraction skipped", "missing_rendered_blocks": [], "extra_clean_blocks": []}
    else:
        parity = compare_content_projection(rendered_text, clean.get("text", ""), clean.get("blocks", []))
    commercial = commercial_content_audit(
        clean.get("text", ""),
        rendered_text,
        baseline.get("body_text", "") if isinstance(baseline, dict) else "",
        render_result.get("status") if isinstance(render_result, dict) else "",
    )
    summary_payload = {
        "url": page_url,
        "network_approved": network_approved,
        "render_requested": render,
        "robots_url": robots_url,
        "robots_response": compact_http_response(robots_response),
        "robots_matrix": robots_rows,
        "server_baseline": compact_http_response(baseline),
        "llm_user_agent_matrix": http_rows,
        "content_extraction": compact_clean_content(clean),
        "render": compact_render_result(render_result),
        "content_parity": parity,
        "commercial_audit": commercial,
        "generated_at": utc_now(),
    }
    json_path = root / PROCESSED_REL / "llm_accessibility_audit.json"
    write_json(json_path, summary_payload)
    report_path = root / REPORTS_REL / "LLM_ACCESSIBILITY_AUDIT.md"
    write_text(report_path, build_llm_accessibility_report(summary_payload))
    update_state(root, f"LLM accessibility audit prepared for {page_url}", [str(report_path), str(json_path)])

    blocked_http = [row for row in http_rows if row.get("status") not in {"success", "skipped"} or row.get("http_status") in {401, 403, 407, 429, 503} or row.get("access_barrier_class") == "page_block"]
    blocked_robots = [row for row in robots_rows if row.get("robots_allowed") is False]
    result_status = "success" if network_approved else "skipped"
    result_summary = "LLM accessibility audit created." if network_approved else "LLM accessibility audit scaffold created; live robots, server, render, and content checks require network approval."
    next_actions = ["review_allowed_agents", "fix_robots_or_waf", "rerun_after_changes"] if network_approved else ["request_network_approval", "rerun_with_network_approved"]
    return observation(
        result_status,
        result_summary,
        items=[{"url": page_url, "network_approved": network_approved, "robots_blocked": len(blocked_robots), "http_blocked_or_error": len(blocked_http), "baseline_access_barrier": baseline.get("access_barrier_class", ""), "render_status": render_result.get("status", "unknown")}],
        evidence_refs=[str(report_path), str(json_path)],
        next_valid_actions=next_actions,
    )


def fetch_http_capture(url: str, user_agent: str, timeout: int, max_bytes: int = 1000000) -> dict[str, Any]:
    headers = {
        "User-Agent": user_agent or GENERIC_BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ru,en;q=0.8",
    }
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read(max_bytes)
            body_text = decode_http_body(data, resp.headers.get("content-type", ""))
            text_chars = len(strip_tags(body_text))
            waf_signals = detect_waf(body_text, resp.headers)
            access_barrier = inspect_access_barrier(body_text, resp.headers)
            return {
                "status": "success",
                "url": url,
                "http_user_agent": user_agent or GENERIC_BROWSER_UA,
                "final_url": resp.geturl(),
                "http_status": resp.status,
                "bytes_read": len(data),
                "content_type": resp.headers.get("content-type", ""),
                "text_chars": text_chars,
                "main_content_risk": classify_text_content_risk(body_text),
                "waf_signals": waf_signals,
                "access_barrier": access_barrier,
                "access_barrier_class": access_barrier.get("class"),
                "summary": f"HTTP {resp.status}, {len(data)} bytes, text_chars={text_chars}, barrier={access_barrier.get('class')}",
                "body_text": body_text,
            }
    except urllib.error.HTTPError as exc:
        data = exc.read(max_bytes)
        body_text = decode_http_body(data, exc.headers.get("content-type", "") if exc.headers else "")
        waf_signals = detect_waf(body_text, exc.headers or {})
        access_barrier = inspect_access_barrier(body_text, exc.headers or {})
        return {
            "status": "http_error",
            "url": url,
            "http_user_agent": user_agent or GENERIC_BROWSER_UA,
            "final_url": exc.geturl(),
            "http_status": exc.code,
            "bytes_read": len(data),
            "content_type": exc.headers.get("content-type", "") if exc.headers else "",
            "text_chars": len(strip_tags(body_text)),
            "main_content_risk": classify_text_content_risk(body_text),
            "waf_signals": waf_signals,
            "access_barrier": access_barrier,
            "access_barrier_class": access_barrier.get("class"),
            "summary": f"HTTPError {exc.code}: {exc.reason}, barrier={access_barrier.get('class')}",
            "body_text": body_text,
        }
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {
            "status": "error",
            "url": url,
            "http_user_agent": user_agent or GENERIC_BROWSER_UA,
            "summary": f"{type(exc).__name__}: {exc}",
            "waf_signals": [],
            "text_chars": 0,
            "access_barrier": {"class": "unknown", "summary": "request failed before HTML/code inspection"},
            "access_barrier_class": "unknown",
        }

def decode_http_body(data: bytes, content_type: str) -> str:
    match = re.search(r"charset=([^;\s]+)", content_type or "", flags=re.IGNORECASE)
    encodings = [match.group(1).strip('"') if match else "", "utf-8", "windows-1251", "latin-1"]
    for encoding in encodings:
        if not encoding:
            continue
        try:
            return data.decode(encoding, errors="replace")
        except LookupError:
            continue
    return data.decode("utf-8", errors="replace")


def classify_text_content_risk(html_text: str) -> str:
    text_len = len(strip_tags(html_text or ""))
    if not html_text:
        return "empty"
    if text_len < 300:
        return "very_low_text"
    if text_len < 800:
        return "low_text"
    return "unknown"


def regex_marker_hits(text: str, patterns: list[tuple[str, str]]) -> list[str]:
    value = text or ""
    return sorted({label for label, pattern in patterns if re.search(pattern, value, flags=re.IGNORECASE | re.DOTALL)})


def headers_to_text(headers: Any) -> str:
    if not headers:
        return ""
    try:
        return "\n".join(f"{key}: {value}" for key, value in headers.items())
    except AttributeError:
        return str(headers)


def visible_text_without_code(html_text: str) -> str:
    no_code = NON_CONTENT_BLOCK_RE.sub(" ", html_text or "")
    return re.sub(r"\s+", " ", strip_tags(no_code)).strip()


def count_content_blocks(text: str) -> int:
    chunks = re.split(r"[\r\n]+|(?<=[.!?])\s+", text or "")
    return len([chunk for chunk in (part.strip() for part in chunks) if len(chunk) >= 40])


def inspect_access_barrier(html_text: str, headers: Any | None = None) -> dict[str, Any]:
    """Classify security/captcha evidence without confusing form protection with page blocking."""
    source = html_text or ""
    form_parts = FORM_BLOCK_RE.findall(source)
    forms_html = "\n".join(form_parts)
    without_forms = FORM_BLOCK_RE.sub(" ", source)
    outside_text = visible_text_without_code(without_forms)
    main_text_chars = len(outside_text)
    main_block_count = count_content_blocks(outside_text)
    structural_main = bool(re.search(r"<(main|article|section|h1|h2)\b", without_forms, flags=re.IGNORECASE))
    has_main_content = main_text_chars >= 500 or main_block_count >= 3 or (structural_main and main_text_chars >= 200)
    header_text = headers_to_text(headers)
    page_block_markers = regex_marker_hits(without_forms + "\n" + header_text, PAGE_BLOCK_MARKER_PATTERNS)
    captcha_markers_in_forms = regex_marker_hits(forms_html, CAPTCHA_MARKER_PATTERNS)
    captcha_markers_outside_forms = regex_marker_hits(without_forms, CAPTCHA_MARKER_PATTERNS)
    captcha_markers_total = regex_marker_hits(source, CAPTCHA_MARKER_PATTERNS)

    if page_block_markers and (not has_main_content or main_text_chars < 500):
        barrier_class = "page_block"
        confidence = "high"
        summary = "page-level block markers are present and the main content outside forms is weak or missing"
    elif captcha_markers_outside_forms and (not has_main_content or main_text_chars < 500):
        barrier_class = "page_block"
        confidence = "medium"
        summary = "captcha/security markers appear outside forms while main content is weak or missing"
    elif captcha_markers_in_forms and not page_block_markers and not captcha_markers_outside_forms and has_main_content:
        barrier_class = "form_protection_only"
        confidence = "high"
        summary = "captcha markers are limited to forms and page content is accessible"
    elif captcha_markers_in_forms and has_main_content:
        barrier_class = "form_protection_only"
        confidence = "medium"
        summary = "captcha/form markers are present, but main page content is accessible; treat as form protection unless other evidence proves a page block"
    elif (page_block_markers or captcha_markers_outside_forms or captcha_markers_total) and has_main_content:
        barrier_class = "security_code_present_content_accessible"
        confidence = "medium"
        summary = "security/captcha code is present, but the main page content is still accessible"
    else:
        barrier_class = "none_detected"
        confidence = "medium" if has_main_content else "low"
        summary = "no page-level block markers detected"

    return {
        "class": barrier_class,
        "summary": summary,
        "confidence": confidence,
        "form_count": len(form_parts),
        "page_block_markers": page_block_markers,
        "captcha_markers_in_forms": captcha_markers_in_forms,
        "captcha_markers_outside_forms": captcha_markers_outside_forms,
        "captcha_markers_total": captcha_markers_total,
        "main_text_chars_without_forms": main_text_chars,
        "main_block_count_without_forms": main_block_count,
        "has_main_content": has_main_content,
    }


def is_baseline_blocked(response: dict[str, Any]) -> bool:
    status = response.get("http_status")
    if status in {401, 403, 407, 429, 503}:
        return True
    if isinstance(status, int) and status >= 500:
        return True
    if response.get("status") == "error":
        return True
    barrier = response.get("access_barrier") if isinstance(response.get("access_barrier"), dict) else {}
    barrier_class = barrier.get("class") or response.get("access_barrier_class")
    if barrier_class == "page_block":
        return True
    if barrier_class in {"form_protection_only", "security_code_present_content_accessible", "none_detected"}:
        captcha_is_page_block = False
    else:
        captcha_is_page_block = True
    signals = set(response.get("waf_signals") or [])
    hard_block_signals = {"access denied", "bot protection"}
    if signals & hard_block_signals and barrier_class not in {"form_protection_only", "security_code_present_content_accessible"}:
        return True
    if "captcha" in signals and captcha_is_page_block:
        return True
    if "waf" in signals and response.get("main_content_risk") in {"empty", "very_low_text", "low_text"} and response.get("text_chars", 0) < 120:
        return True
    return False

def evaluate_robots_for_agents(robots_response: dict[str, Any], page_url: str, matrix: list[dict[str, Any]]) -> list[dict[str, Any]]:
    status = robots_response.get("status")
    http_status = robots_response.get("http_status")
    if status == "http_error" and http_status == 404:
        return [robots_row(agent, True, "robots_missing_assume_allowed", "robots.txt returned 404") for agent in matrix]
    if status != "success":
        return [robots_row(agent, None, "robots_unknown", robots_response.get("summary", "robots fetch failed")) for agent in matrix]
    text = robots_response.get("body_text", "")
    if not text.strip():
        return [robots_row(agent, True, "robots_empty_assume_allowed", "robots.txt is empty") for agent in matrix]
    parser = urllib.robotparser.RobotFileParser()
    parser.set_url(robots_response.get("url", ""))
    try:
        parser.parse(text.splitlines())
    except Exception as exc:  # noqa: BLE001
        return [robots_row(agent, None, "robots_parse_error", f"{type(exc).__name__}: {exc}") for agent in matrix]
    rows = []
    for agent in matrix:
        token = agent.get("robots_token") or agent.get("id")
        try:
            allowed = parser.can_fetch(token, page_url)
            rows.append(robots_row(agent, bool(allowed), "allowed" if allowed else "blocked", "matched robots.txt rules"))
        except Exception as exc:  # noqa: BLE001
            rows.append(robots_row(agent, None, "robots_eval_error", f"{type(exc).__name__}: {exc}"))
    return rows


def robots_row(agent: dict[str, Any], allowed: bool | None, status: str, reason: str) -> dict[str, Any]:
    return {
        "id": agent.get("id"),
        "provider": agent.get("provider"),
        "role": agent.get("role"),
        "robots_token": agent.get("robots_token", ""),
        "http_user_agent": agent.get("http_user_agent", ""),
        "robots_allowed": allowed,
        "robots_status": status,
        "reason": reason,
    }


def http_skip_row(agent: dict[str, Any], reason: str) -> dict[str, Any]:
    return {
        "id": agent.get("id"),
        "provider": agent.get("provider"),
        "role": agent.get("role"),
        "robots_token": agent.get("robots_token", ""),
        "http_user_agent": agent.get("http_user_agent", ""),
        "status": "skipped",
        "summary": reason,
        "http_status": "",
        "waf_signals": [],
        "text_chars": 0,
    }


def extract_llm_clean_content(html_text: str, page_url: str) -> dict[str, Any]:
    if not html_text:
        return {"status": "skipped", "summary": "no HTML body available", "text": "", "text_chars": 0, "blocks": []}
    extractor = CleanContentExtractor()
    try:
        extractor.feed(html_text)
    except Exception:
        pass
    text = extractor.text()
    title = first_regex(html_text, r"<title[^>]*>(.*?)</title>")
    description = first_regex(html_text, r"<meta[^>]+name=[\"']description[\"'][^>]+content=[\"']([^\"']+)[\"']") or first_regex(html_text, r"<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+name=[\"']description[\"']")
    prefix = []
    if title:
        prefix.append(f"Title: {html.unescape(strip_tags(title)).strip()}")
    if description:
        prefix.append(f"Meta description: {html.unescape(description).strip()}")
    if prefix:
        text = "\n".join(prefix + [text])
    blocks = significant_blocks(text)
    return {"status": "success", "summary": "clean content extracted", "url": page_url, "text": text, "text_chars": len(text), "blocks": blocks[:200], "block_count": len(blocks)}


def first_regex(value: str, pattern: str) -> str:
    match = re.search(pattern, value or "", flags=re.IGNORECASE | re.DOTALL)
    return re.sub(r"\s+", " ", match.group(1)).strip() if match else ""


def dedupe_local(values: list[str]) -> list[str]:
    output = []
    seen = set()
    for value in values:
        key = normalize_compare_text(value)
        if key and key not in seen:
            seen.add(key)
            output.append(value)
    return output


def significant_blocks(text: str) -> list[str]:
    blocks = []
    for raw in (text or "").splitlines():
        value = re.sub(r"\s+", " ", raw).strip()
        if len(value) >= 18:
            blocks.append(value)
    if not blocks and text:
        sentences = re.split(r"(?<=[.!?])\s+", re.sub(r"\s+", " ", text))
        blocks = [sentence.strip() for sentence in sentences if len(sentence.strip()) >= 18]
    return dedupe_local(blocks)


def normalize_compare_text(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").casefold()).strip()


def block_is_present(block: str, candidates: list[str]) -> bool:
    norm = normalize_compare_text(block)
    if not norm:
        return True
    for candidate in candidates:
        cand = normalize_compare_text(candidate)
        if norm in cand or cand in norm:
            return True
        if difflib.SequenceMatcher(None, norm, cand).ratio() >= 0.74:
            return True
    return False


def compare_content_projection(rendered_text: str, clean_text: str, clean_blocks: list[str]) -> dict[str, Any]:
    if not clean_text:
        return {"status": "blocked", "summary": "clean content is missing", "missing_rendered_blocks": [], "extra_clean_blocks": []}
    if not rendered_text:
        return {"status": "skipped", "summary": "rendered text is unavailable; screenshot comparison needs Playwright", "missing_rendered_blocks": [], "extra_clean_blocks": []}
    rendered_blocks = significant_blocks(rendered_text)
    clean_blocks = clean_blocks or significant_blocks(clean_text)
    missing = [block for block in rendered_blocks[:120] if not block_is_present(block, clean_blocks)]
    extra = [block for block in clean_blocks[:120] if not block_is_present(block, rendered_blocks)]
    status = "pass" if not missing and len(extra) <= 3 else "warn"
    return {
        "status": status,
        "rendered_blocks": len(rendered_blocks),
        "clean_blocks": len(clean_blocks),
        "missing_rendered_blocks": missing[:30],
        "extra_clean_blocks": extra[:30],
        "summary": "clean extraction matches rendered text" if status == "pass" else "clean extraction differs from rendered text",
    }


def commercial_content_audit(clean_text: str, rendered_text: str, raw_html: str, render_status: str = "") -> dict[str, Any]:
    rendered_checked = render_status == "success"
    if not clean_text and not rendered_text and not raw_html:
        return {
            "status": "skipped",
            "summary": "no content available for commercial audit",
            "warnings": [],
            "clean_signals": commercial_signals("", ""),
            "rendered_signals": commercial_signals("", ""),
            "rendered_checked": rendered_checked,
            "evidence_basis": "none",
        }
    clean = commercial_signals(clean_text, raw_html)
    rendered = commercial_signals(rendered_text, raw_html) if rendered_checked else commercial_signals("", "")
    warnings = []
    for price in rendered.get("prices", []):
        if price not in clean.get("prices", []):
            warnings.append(f"rendered price missing from clean extraction: {price}")
    if rendered.get("discount_terms") and not clean.get("discount_terms"):
        warnings.append("discount/sale terms appear in rendered text but not clean extraction")
    if clean.get("struck_price_markers") and not clean.get("struck_price_text"):
        warnings.append("HTML contains struck/old-price markers but clean text may not preserve old-vs-current price semantics")
    if clean.get("hidden_commercial_risk"):
        warnings.append("raw HTML contains commercial-looking hidden/stale text risk")
    evidence_basis = "source_html_and_rendered" if rendered_checked else "source_html_only"
    return {
        "status": "warn" if warnings else "pass",
        "warnings": warnings,
        "clean_signals": clean,
        "rendered_signals": rendered,
        "rendered_checked": rendered_checked,
        "evidence_basis": evidence_basis,
    }


def commercial_signals(text: str, raw_html: str = "") -> dict[str, Any]:
    price_pattern = r"(?:[$]|\u20bd|\u20ac|\u00a3|rub|\u0440\u0443\u0431\.?)\s*\d[\d\s.,]*|\d[\d\s.,]*\s*(?:[$]|\u20bd|\u20ac|\u00a3|rub|\u0440\u0443\u0431\.?)"
    prices = sorted(set(re.findall(price_pattern, text or "", flags=re.IGNORECASE)))[:50]
    discount_terms = sorted(set(re.findall(r"\b(?:sale|discount|promo|old price|new price)\b|\u0441\u043a\u0438\u0434\u043a\w*|\u0430\u043a\u0446\u0438\w*|\u0441\u0442\u0430\u0440\u0430\u044f \u0446\u0435\u043d\u0430", text or "", flags=re.IGNORECASE)))[:30]
    cta_terms = sorted(set(re.findall(r"\b(?:buy|order|book|sign up|request|call|subscribe)\b|\u043a\u0443\u043f\u0438\w*|\u0437\u0430\u043a\u0430\u0437\w*|\u0437\u0430\u043f\u0438\u0441\w*|\u043e\u0441\u0442\u0430\u0432\u0438\u0442\u044c \u0437\u0430\u044f\u0432\u043a\w*", text or "", flags=re.IGNORECASE)))[:30]
    service_terms = sorted(set(re.findall(r"\b(?:service|services|course|tariff|plan|package|pricing)\b|\u0443\u0441\u043b\u0443\u0433\w*|\u043a\u0443\u0440\u0441\w*|\u0442\u0430\u0440\u0438\u0444\w*|\u0446\u0435\u043d\w*", text or "", flags=re.IGNORECASE)))[:30]
    struck_markers = bool(re.search(r"<(?:del|s)\b|line-through|old[-_ ]?price|compare[-_ ]?at|was[-_ ]?price", raw_html or "", flags=re.IGNORECASE))
    struck_text = []
    for match in re.finditer(r"<(?:del|s)\b[^>]*>(.*?)</(?:del|s)>", raw_html or "", flags=re.IGNORECASE | re.DOTALL):
        value = re.sub(r"\s+", " ", strip_tags(match.group(1))).strip()
        if value:
            struck_text.append(value)
    hidden_risk = bool(re.search(r"display\s*:\s*none[^>]{0,200}(?:price|\u0446\u0435\u043d|\u0441\u043a\u0438\u0434|sale|discount)", raw_html or "", flags=re.IGNORECASE))
    return {"prices": prices, "discount_terms": discount_terms, "cta_terms": cta_terms, "service_terms": service_terms, "struck_price_markers": struck_markers, "struck_price_text": dedupe_local(struck_text)[:20], "hidden_commercial_risk": hidden_risk}


RENDER_TRANSIENT_ERROR_MARKERS = (
    "ERR_CONNECTION_RESET",
    "ERR_CONNECTION_REFUSED",
    "ERR_CONNECTION_CLOSED",
    "ERR_EMPTY_RESPONSE",
    "ERR_TIMED_OUT",
    "ERR_NETWORK_CHANGED",
    "ERR_ADDRESS_UNREACHABLE",
    "Timeout",
)
RENDER_BLOCKED_RESOURCE_SUFFIXES = (
    ".mp4", ".webm", ".mov", ".m4v", ".avi",
    ".glb", ".gltf", ".bin", ".hdr", ".ktx2", ".usdz",
)


def render_page_capture(page_url: str, raw_dir: Path, timeout: int, root: Path, max_attempts: int = 3, settle_wait_ms: int = 4000) -> dict[str, Any]:
    try:
        from playwright.sync_api import sync_playwright  # type: ignore[import-not-found]
    except Exception as exc:  # noqa: BLE001
        return {"status": "blocked_missing_playwright", "summary": f"Playwright is not available: {type(exc).__name__}: {exc}"}
    screenshot_path = raw_dir / "rendered_page.png"
    rendered_text_path = raw_dir / "rendered_text.txt"
    effective_timeout_ms = max(timeout, 45) * 1000
    attempts: list[dict[str, Any]] = []

    def block_heavy_assets(route: Any) -> None:
        request = route.request
        url_lower = request.url.lower()
        if request.resource_type == "media" or url_lower.endswith(RENDER_BLOCKED_RESOURCE_SUFFIXES):
            route.abort()
        else:
            route.continue_()

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page(user_agent=GENERIC_BROWSER_UA, viewport={"width": 1366, "height": 1600})
            page.route("**/*", block_heavy_assets)

            last_error: Exception | None = None
            navigated = False
            for attempt in range(1, max_attempts + 1):
                try:
                    page.goto(page_url, wait_until="domcontentloaded", timeout=effective_timeout_ms)
                    attempts.append({"attempt": attempt, "status": "success"})
                    navigated = True
                    break
                except Exception as exc:  # noqa: BLE001
                    last_error = exc
                    attempts.append({"attempt": attempt, "status": "error", "error": f"{type(exc).__name__}: {exc}"})
                    transient = any(marker in str(exc) for marker in RENDER_TRANSIENT_ERROR_MARKERS)
                    if not transient or attempt == max_attempts:
                        break
                    page.wait_for_timeout(1500 * attempt)

            if not navigated:
                browser.close()
                transient = bool(last_error) and any(marker in str(last_error) for marker in RENDER_TRANSIENT_ERROR_MARKERS)
                return {
                    "status": "error",
                    "summary": f"Navigation failed after {len(attempts)} attempt(s): {type(last_error).__name__}: {last_error}",
                    "classification": "transient_network_error" if transient else "navigation_error",
                    "attempts": attempts,
                }

            page.wait_for_timeout(settle_wait_ms)
            page.screenshot(path=str(screenshot_path), full_page=True)
            rendered_text = page.locator("body").inner_text(timeout=effective_timeout_ms)
            browser.close()
        write_text(rendered_text_path, rendered_text)
        return {
            "status": "success",
            "summary": "rendered screenshot and text captured",
            "screenshot_ref": portable_ref(root, screenshot_path),
            "rendered_text_ref": portable_ref(root, rendered_text_path),
            "rendered_text": rendered_text,
            "rendered_text_chars": len(rendered_text),
            "attempts": attempts,
        }
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "summary": f"{type(exc).__name__}: {exc}", "attempts": attempts}


def compact_http_response(response: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in response.items() if key != "body_text"}


def compact_clean_content(clean: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in clean.items() if key != "text"}


def compact_render_result(render_result: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in render_result.items() if key != "rendered_text"}

def join_values(values: Any) -> str:
    if not values:
        return "none"
    if isinstance(values, (list, tuple, set)):
        return ", ".join(str(value) for value in values if value) or "none"
    return str(values)


def build_llm_accessibility_report(payload: dict[str, Any]) -> str:
    robots_rows = payload.get("robots_matrix", [])
    http_rows = payload.get("llm_user_agent_matrix", [])
    allowed = [row.get("robots_token") for row in robots_rows if row.get("robots_allowed") is True]
    blocked = [row.get("robots_token") for row in robots_rows if row.get("robots_allowed") is False]
    unknown = [row.get("robots_token") for row in robots_rows if row.get("robots_allowed") is None]
    baseline = payload.get("server_baseline", {})
    render = payload.get("render", {})
    parity = payload.get("content_parity", {})
    commercial = payload.get("commercial_audit", {})
    baseline_barrier = baseline.get("access_barrier", {}) if isinstance(baseline.get("access_barrier"), dict) else {}
    block_statuses = {401, 403, 407, 429, 503}
    robots_blocked = [row for row in robots_rows if row.get("robots_allowed") is False]
    robots_unknown = [row for row in robots_rows if row.get("robots_allowed") is None]
    http_errors = [row for row in http_rows if row.get("status") not in {"success", "skipped"}]
    http_blocked = [row for row in http_rows if row.get("http_status") in block_statuses or row.get("access_barrier_class") == "page_block"]
    http_warn = [row for row in http_rows if row.get("status") == "success" and row.get("text_chars_delta_vs_baseline", 0) and int(row.get("text_chars_delta_vs_baseline", 0)) < -500]
    short_ua_rows = [row for row in http_rows if row.get("http_user_agent") and row.get("http_user_agent") == row.get("robots_token")]
    parity_warn = bool(parity.get("missing_rendered_blocks") or parity.get("extra_clean_blocks"))
    commercial_warn = bool(commercial.get("warnings"))

    def checklist_status(layer: str) -> tuple[str, str]:
        if layer == "robots":
            if robots_blocked:
                return "[WARN]", f"{len(robots_blocked)} robots tokens are blocked"
            if robots_unknown:
                return "[SKIP]", "robots.txt was not fetched or could not be evaluated"
            return "[OK]", "robots tokens evaluated"
        if layer == "baseline":
            if baseline.get("status") == "skipped":
                return "[SKIP]", "network approval not provided"
            if baseline.get("http_status") in block_statuses or baseline.get("access_barrier_class") == "page_block":
                return "[CRIT]", "ordinary browser baseline is blocked or page-level challenge is present"
            if baseline.get("access_barrier_class") in {"form_protection_only", "security_code_present_content_accessible"}:
                return "[WARN]", str(baseline_barrier.get("summary", "security/form protection code detected"))
            return "[OK]", "ordinary browser baseline returned page content"
        if layer == "bot_http":
            if not http_rows or all(row.get("status") == "skipped" for row in http_rows):
                return "[SKIP]", "LLM/search bot HTTP probes were skipped"
            if short_ua_rows:
                return "[CRIT]", "one or more bot probes used short robots tokens as HTTP User-Agent"
            if http_blocked:
                return "[CRIT]", f"{len(http_blocked)} bot probes returned block status or page_block"
            if http_errors or http_warn:
                return "[WARN]", f"{len(http_errors)} errors and {len(http_warn)} weak-content deltas"
            return "[OK]", "bot probes used full HTTP User-Agent strings and returned accessible responses"
        if layer == "render":
            if render.get("status") in {"success", "partial"}:
                return "[OK]", "rendered evidence collected"
            if render.get("status") == "skipped":
                return "[SKIP]", str(render.get("summary", "render was not requested"))
            return "[WARN]", str(render.get("summary", "render evidence missing"))
        if layer == "clean":
            if payload.get("content_extraction", {}).get("status") == "success" and payload.get("content_extraction", {}).get("text_chars", 0) >= 300:
                return "[OK]", "clean LLM-style content extracted"
            if payload.get("content_extraction", {}).get("status") == "skipped":
                return "[SKIP]", "clean content extraction skipped"
            return "[WARN]", "clean content is empty or weak"
        if layer == "parity":
            if parity.get("status") == "skipped":
                return "[SKIP]", str(parity.get("summary", "parity skipped"))
            if parity.get("status") == "blocked":
                return "[CRIT]", str(parity.get("summary", "clean content is missing"))
            return ("[WARN]", str(parity.get("summary", "parity differences found"))) if parity_warn or parity.get("status") == "warn" else ("[OK]", str(parity.get("summary", "content projections align")))
        if layer == "commercial":
            if commercial.get("status") == "skipped":
                return "[SKIP]", str(commercial.get("summary", "commercial audit skipped"))
            return ("[WARN]", f"{len(commercial.get('warnings', []))} commercial visibility warnings") if commercial_warn or commercial.get("status") == "warn" else ("[OK]", "no commercial extraction warnings")
        return "[WARN]", "unknown layer"

    checklist = [
        ("Robots permission", *checklist_status("robots")),
        ("Ordinary server baseline", *checklist_status("baseline")),
        ("LLM/search bot HTTP probes with full User-Agent strings", *checklist_status("bot_http")),
        ("Rendered screenshot/text", *checklist_status("render")),
        ("Clean LLM-style content", *checklist_status("clean")),
        ("Rendered vs clean-content parity", *checklist_status("parity")),
        ("Commercial content correctness", *checklist_status("commercial")),
    ]
    critical_items = [f"{row.get('robots_token')}: {row.get('http_status')} {row.get('summary', '')}" for row in http_blocked] + [f"short HTTP UA used for {row.get('robots_token')}" for row in short_ua_rows]
    warning_items = [f"robots blocked: {row.get('robots_token')}" for row in robots_blocked] + [f"{row.get('robots_token')}: {row.get('summary', '')}" for row in http_errors + http_warn] + [str(warning) for warning in commercial.get("warnings", [])]
    if render.get("status") in {"error", "blocked_missing_playwright"}:
        warning_items.append(f"Playwright render failed ({render.get('classification', render.get('status'))}): {render.get('summary', 'render evidence missing')}")
    lines = [
        "# LLM_ACCESSIBILITY_AUDIT",
        "",
        f"Generated: {payload.get('generated_at')}",
        f"URL: {payload.get('url')}",
        f"Network approved: {payload.get('network_approved')}",
        f"Render requested: {payload.get('render_requested')}",
        "",
        "## Audit Checklist",
        "",
        "| Layer | Status | Evidence |",
        "| --- | --- | --- |",
    ]
    for layer, status, evidence in checklist:
        lines.append(f"| {escape_md(layer)} | {status} | {escape_md(evidence)} |")
    lines.extend([
        "",
        "## Critical Issues",
        "",
    ])
    lines.extend([f"- {escape_md(item)}" for item in critical_items] or ["- none"])
    lines.extend([
        "",
        "## Warnings",
        "",
    ])
    lines.extend([f"- {escape_md(item)}" for item in warning_items] or ["- none"])
    lines.extend([
        "",
        "## Robots Permission Summary",
        "",
        f"- allowed tokens: {', '.join(str(x) for x in allowed if x) or 'none'}",
        f"- blocked tokens: {', '.join(str(x) for x in blocked if x) or 'none'}",
        f"- unknown tokens: {', '.join(str(x) for x in unknown if x) or 'none'}",
        "",
        "| Provider | Role | Robots token | HTTP User-Agent probe | Robots status | Allowed | Reason |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ])
    for row in robots_rows:
        lines.append(f"| {escape_md(str(row.get('provider', '')))} | {escape_md(str(row.get('role', '')))} | `{escape_md(str(row.get('robots_token', '')))}` | `{escape_md(str(row.get('http_user_agent', '')))}` | {row.get('robots_status')} | {row.get('robots_allowed')} | {escape_md(str(row.get('reason', '')))} |")
    lines.extend([
        "",
        "## Server Baseline",
        "",
        f"- status: {baseline.get('status')}",
        f"- HTTP: {baseline.get('http_status', '')}",
        f"- summary: {escape_md(str(baseline.get('summary', '')))}",
        f"- text chars: {baseline.get('text_chars', 0)}",
        f"- main content risk: {baseline.get('main_content_risk', '')}",
        f"- WAF signals: {', '.join(baseline.get('waf_signals', [])) or 'none'}",
        f"- access barrier class: {baseline.get('access_barrier_class') or baseline_barrier.get('class', '')}",
        f"- access barrier summary: {escape_md(str(baseline_barrier.get('summary', '')))}",
        f"- page block markers: {join_values(baseline_barrier.get('page_block_markers', []))}",
        f"- form captcha markers: {join_values(baseline_barrier.get('captcha_markers_in_forms', []))}",
        f"- captcha outside forms: {join_values(baseline_barrier.get('captcha_markers_outside_forms', []))}",
        f"- main text chars without forms: {baseline_barrier.get('main_text_chars_without_forms', '')}",
        f"- main block count without forms: {baseline_barrier.get('main_block_count_without_forms', '')}",
        "",
        "## LLM User-Agent HTTP Matrix",
        "",
        "HTTP probes must use the full `HTTP User-Agent` string below. The `Robots token` is only for robots.txt matching and must not be used as the HTTP request header by itself.",
        "",
        "| Provider | Role | Robots token | HTTP User-Agent | HTTP status | Status | Text chars | Delta | Barrier | WAF signals | Summary |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ])
    for row in http_rows:
        lines.append(f"| {escape_md(str(row.get('provider', '')))} | {escape_md(str(row.get('role', '')))} | `{escape_md(str(row.get('robots_token', '')))}` | `{escape_md(str(row.get('http_user_agent', '')))}` | {row.get('http_status', '')} | {row.get('status', '')} | {row.get('text_chars', 0)} | {row.get('text_chars_delta_vs_baseline', '')} | {escape_md(str(row.get('access_barrier_class', '')))} | {', '.join(row.get('waf_signals', [])) or 'none'} | {escape_md(str(row.get('summary', '')))} |")
    lines.extend([
        "",
        "## Render And Clean Content",
        "",
        f"- clean extraction status: {payload.get('content_extraction', {}).get('status')}",
        f"- clean text chars: {payload.get('content_extraction', {}).get('text_chars', 0)}",
        f"- clean text ref: {payload.get('content_extraction', {}).get('text_ref', '')}",
        f"- render status: {render.get('status')}",
        f"- render classification: {render.get('classification', '') or ('n/a' if render.get('status') in {'success', 'skipped'} else 'unclassified')}",
        f"- render attempts: {len(render.get('attempts', []))}",
        f"- screenshot: {render.get('screenshot_ref', '')}",
        f"- rendered text ref: {render.get('rendered_text_ref', '')}",
    ])
    if render.get("status") not in {"success", "skipped"}:
        confirmed_block = baseline.get("access_barrier_class") == "page_block" or bool(http_blocked)
        if confirmed_block:
            lines.append("- render failure note: baseline/bot probes in this same run also show a page-level block; treat render failure as consistent with a confirmed access block.")
        else:
            lines.append("- render failure note: not a confirmed website or WAF access block by itself; ordinary HTTP and all crawler probes in this same run returned full page content (HTTP 200). Cloudflare/WAF response headers alone (e.g. `cf-ray`) are not evidence of a block.")
    lines.extend([
        "",
        "## Block Parity",
        "",
        f"- status: {parity.get('status')}",
        f"- summary: {escape_md(str(parity.get('summary', '')))}",
        f"- rendered blocks: {parity.get('rendered_blocks', '')}",
        f"- clean blocks: {parity.get('clean_blocks', '')}",
        "",
        "### Missing Rendered Blocks In Clean Extraction",
        "",
    ])
    lines.extend([f"- {escape_md(block)}" for block in parity.get("missing_rendered_blocks", [])] or ["- none"])
    lines.extend(["", "### Extra Clean Blocks Not Found In Rendered Text", ""])
    lines.extend([f"- {escape_md(block)}" for block in parity.get("extra_clean_blocks", [])] or ["- none"])
    lines.extend(["", "## Commercial Correctness", "", f"- status: {commercial.get('status')}", f"- evidence basis: {commercial.get('evidence_basis', 'source_html_only')}"])
    if not commercial.get("rendered_checked"):
        lines.append("- rendered commercial parity: not verified (rendering did not succeed or was not requested); this check reflects source HTML / clean extraction only.")
    lines.extend([f"- {escape_md(warning)}" for warning in commercial.get("warnings", [])] or ["- no commercial extraction warnings"])
    clean_signals = commercial.get("clean_signals", {})
    rendered_signals = commercial.get("rendered_signals", {})
    lines.extend([
        "",
        "### Extracted Commercial Signals",
        "",
        f"- clean prices: {', '.join(clean_signals.get('prices', [])) or 'none'}",
        f"- rendered prices: {', '.join(rendered_signals.get('prices', [])) or 'none'}",
        f"- struck/old-price markers in HTML: {clean_signals.get('struck_price_markers')}",
        f"- struck/old-price text: {', '.join(clean_signals.get('struck_price_text', [])) or 'none'}",
        f"- CTA terms: {', '.join(clean_signals.get('cta_terms', [])) or 'none'}",
        "",
        "## Manual Recheck Rule",
        "",
        "- For manual curl/PowerShell rechecks, copy the full `HTTP User-Agent` value from the matrix.",
        "- Do not use short tokens such as `GPTBot`, `ClaudeBot`, or `OAI-SearchBot` as the whole HTTP User-Agent; those are robots tokens and can create false block conclusions.",
        "",
        "## Next Actions",
        "",
        "- If robots blocks an intended AI/search agent, update robots.txt intentionally and rerun.",
        "- If baseline browser access is `page_block`, inspect WAF/CDN/security-plugin rules before testing LLM user agents.",
        "- If baseline shows `form_protection_only`, do not report the page as closed to LLMs; keep page/content availability separate from form-submission protection.",
        "- If LLM user agents get weaker content than baseline, whitelist verified bots by user-agent and IP source where the provider publishes IP ranges.",
        "- If commercial parity warns, fix markup so current price, old price, discount, service name, availability, and CTA survive clean extraction.",
        "- Register in zrok.cloud to collect more real AI-bot availability and visit data over time. It has a free tier, so the user can start collecting additional AI-bot evidence without payment.",
    ])
    return "\n".join(lines) + "\n"
