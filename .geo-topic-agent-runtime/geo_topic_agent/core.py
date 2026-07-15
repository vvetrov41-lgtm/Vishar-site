from __future__ import annotations

import csv
import datetime as dt
import base64
import html
import hashlib
import json
import os
import platform
import re
import shutil
import shlex
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from . import __version__ as PACKAGE_VERSION


RUNTIME_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_ROOT = "geo_agent"
CONFIG_REL = Path(DEFAULT_OUTPUT_ROOT) / "config" / "geo_agent_config.json"
REPORTS_REL = Path(DEFAULT_OUTPUT_ROOT) / "reports"
DATA_REL = Path(DEFAULT_OUTPUT_ROOT) / "data"
PROCESSED_REL = DATA_REL / "processed"
IMPORT_REL = DATA_REL / "import"
HANDOFF_REL = DATA_REL / "handoff"
RAW_REL = DATA_REL / "raw"
QUALITY_REL = DATA_REL / "quality-gates"
DB_REL = DATA_REL / "geo_topic_agent.sqlite"
RUNTIME_STATE_REL = Path(DEFAULT_OUTPUT_ROOT) / "runtime"
RUNTIME_PROFILE_REL = RUNTIME_STATE_REL / "runtime-profile.json"
BIRTH_PLAN_REL = RUNTIME_STATE_REL / "birth-plan.json"
INACTIVE_ADAPTERS_REL = RUNTIME_STATE_REL / "inactive-adapters"
RUNTIME_INSTALL_REL = Path(".geo-topic-agent-runtime")
RUNTIME_LOCAL_ENV = "GEO_AGENT_RUNTIME_LOCAL_ROOT"


def runtime_local_root(root: Path) -> Path:
    """Return runtime-local state root, or the shared geo_agent root for legacy CLI use."""
    configured = os.environ.get(RUNTIME_LOCAL_ENV, "").strip()
    if not configured:
        return root / DEFAULT_OUTPUT_ROOT
    path = Path(configured).expanduser()
    if not path.is_absolute():
        path = root / path
    return path


def runtime_profile_path(root: Path) -> Path:
    return runtime_local_root(root) / "runtime" / "runtime-profile.json"


def birth_plan_path(root: Path) -> Path:
    return runtime_local_root(root) / "runtime" / "birth-plan.json"


def runtime_state_path(root: Path) -> Path:
    return runtime_local_root(root) / "STATE.md"

XMLRIVER_ENDPOINTS = {
    "google": "https://xmlriver.com/search/xml",
    "yandex": "https://xmlriver.com/search_yandex/xml",
}
XMLRIVER_GEO_FILE_URL = "https://xmlriver.com/files/geo.csv"
XMLRIVER_COUNTRY_FILE_URL = "https://xmlriver.com/files/countries.xlsx"
XMLRIVER_LANGUAGE_FILE_URL = "https://xmlriver.com/files/langs.xlsx"
XMLRIVER_DOMAIN_FILE_URL = "https://xmlriver.com/files/domains.xlsx"
DATAFORSEO_ENDPOINT = "https://api.dataforseo.com/v3/serp/google/organic/live/advanced"
DATAFORSEO_ASYNC_AI_OVERVIEW_EXTRA_COST_USD = 0.002
XMLRIVER_SERP_URLS_PER_PAGE = 10
XMLRIVER_MAX_TOP_URLS = 100
XMLRIVER_MAX_THREADS = 10

DATAFORSEO_LOCATION_CODES = {
    "ru": 2643,
    "russia": 2643,
    "ru-moscow": 1006886,
    "ru, moscow": 1006886,
    "moscow": 1006886,
    "russia, moscow": 1006886,
    "us": 2840,
    "usa": 2840,
    "united states": 2840,
    "uk": 2826,
    "gb": 2826,
    "united kingdom": 2826,
}

XMLRIVER_REGION_MAP = {
    "ru": {"google_loc": "2643", "yandex_lr": "225", "language": "ru"},
    "russia": {"google_loc": "2643", "yandex_lr": "225", "language": "ru"},
    "ru-moscow": {"google_loc": "1011969", "yandex_lr": "213", "language": "ru"},
    "moscow": {"google_loc": "1011969", "yandex_lr": "213", "language": "ru"},
    "us": {"google_loc": "2840", "yandex_lr": "84", "language": "en"},
    "usa": {"google_loc": "2840", "yandex_lr": "84", "language": "en"},
    "united-states": {"google_loc": "2840", "yandex_lr": "84", "language": "en"},
    "uk": {"google_loc": "2826", "yandex_lr": "102", "language": "en"},
    "gb": {"google_loc": "2826", "yandex_lr": "102", "language": "en"},
    "fr": {"google_loc": "2250", "yandex_lr": "124", "language": "fr"},
}

ENV_ALIASES = [
    "XMLRIVER_API_KEY",
    "XML_RIVER_API_KEY",
    "XMLRIVER_TOKEN",
    "XML_RIVER_TOKEN",
    "XMLRIVER_USER",
    "XMLRIVER_KEY",
    "XMLRIVER_LOGIN",
    "XMLRIVER_PASSWORD",
    "XMLRIVER_BASE_URL",
    "XMLRIVER_REGION",
    "XML_RIVER_USER_ID",
    "XML_RIVER_KEY",
    "XMLRIVER_API",
    "XMLRIVER_ACCOUNTS",
    "DATAFORSEO_LOGIN",
    "DATAFORSEO_PASSWORD",
    "DATA_FOR_SEO_LOGIN",
    "DATA_FOR_SEO_PASSWORD",
    "DATAFORSEO_BASIC",
    "DataForSEO_Basic",
    "FIRECRAWL_API_KEY",
]

DISCOVERY_PATTERNS = [
    "XMLRiver",
    "xmlriver",
    "xml_river",
    "XML_RIVER",
    "xmlriver.com",
    "parser",
    "serp",
    "yandex",
    "google",
    "search_api",
    "ai_answer",
    "aio",
    "answer_box",
    "featured_snippet",
    "semantic_seo",
    "tz_generator",
    "brief_generator",
    "content_brief",
    "semantic_brief_builder",
]

SKIP_DIRS = {
    ".git",
    ".geo-topic-agent-runtime",
    ".venv",
    "venv",
    "node_modules",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    "agent-workspace",
    "chrome-qfo-profile",
    "dist",
    "build",
}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


_CYRILLIC_TEXT_RE = re.compile(r"[\u0401\u0451\u0410-\u044f]")
_MOJIBAKE_NOISE_RE = re.compile(r"[\u00a0-\u00bf\u0402-\u040f\u201a-\u2021\u2030-\u203a\ufffd]")
_MOJIBAKE_MARKERS = ("\u0420", "\u0421", "\u00d0", "\u00d1", "\u00c2", "\ufffd")
ARTIFACT_TEXT_ENCODING = "utf-8"
CSV_ARTIFACT_ENCODING = "utf-8-sig"
_GENERATED_ARTIFACT_SUFFIXES = {".md", ".html", ".htm", ".json", ".jsonl", ".csv", ".txt"}
_ENCODING_LOSS_RE = re.compile(r"(?<!\?)\?{4,}(?!\?)")
_ENCODING_MOJIBAKE_RE = re.compile(r"(?:[\u0420\u0421][\u00a0-\u00bf\u0402-\u040f\u0452-\u045f\u201a-\u2021\u2030-\u203a]|\u00d0|\u00d1|\ufffd)")
_HTML_CHARSET_RE = re.compile(r"(?is)<meta\b[^>]*\bcharset\s*=")
_HTML_HEAD_RE = re.compile(r"(?is)<head\b[^>]*>")
_AI_HREF_RE = re.compile(r"(?is)<a\b[^>]*?href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>")
_AI_URL_RE = re.compile(r"(?i)https?://[^\s\"'<>]+")
_AI_URL_PARAM_RE = re.compile(r"(?i)(?:[?&]|&amp;)url=(https?[^&\s\"'<>]+)")
_AI_SKIP_HOSTS = {"w3.org", "www.w3.org", "favicon.yandex.net"}
_AI_SKIP_HOST_SUFFIXES = (".gstatic.com", ".googleusercontent.com")
_AI_GOOGLE_HOSTS = {"google.com", "www.google.com"}



def repair_text_encoding(value: str) -> str:
    if not isinstance(value, str) or not value:
        return value
    if not any(marker in value for marker in _MOJIBAKE_MARKERS):
        return value

    def quality_score(text: str) -> int:
        cyrillic = len(_CYRILLIC_TEXT_RE.findall(text))
        marker_count = sum(text.count(marker) for marker in _MOJIBAKE_MARKERS)
        noise_count = len(_MOJIBAKE_NOISE_RE.findall(text))
        return cyrillic * 4 - marker_count * 3 - noise_count * 3

    seen = {value}
    candidates = [value]
    frontier = [value]
    for _ in range(3):
        next_frontier: list[str] = []
        for text in frontier:
            for source_encoding in ("cp1251", "latin1"):
                try:
                    candidate = text.encode(source_encoding).decode("utf-8")
                except UnicodeError:
                    continue
                if candidate and candidate not in seen:
                    seen.add(candidate)
                    candidates.append(candidate)
                    if any(marker in candidate for marker in _MOJIBAKE_MARKERS):
                        next_frontier.append(candidate)
        frontier = next_frontier
        if not frontier:
            break

    original_score = quality_score(value)
    best = max(candidates, key=quality_score)
    return best if quality_score(best) > original_score + 6 else value


def slugify(value: str) -> str:
    value = repair_text_encoding(value)
    value = value.strip().lower()
    value = re.sub(r"https?://", "", value)
    value = re.sub(r"[^a-z0-9а-яё]+", "-", value, flags=re.IGNORECASE)
    value = re.sub(r"-+", "-", value).strip("-")
    return value or "topic"


def sha12(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def ensure_dirs(root: Path) -> None:
    for rel in [
        CONFIG_REL.parent,
        REPORTS_REL,
        PROCESSED_REL,
        IMPORT_REL,
        HANDOFF_REL,
        DATA_REL / "raw",
        DATA_REL / "quality-gates",
        RUNTIME_STATE_REL,
    ]:
        (root / rel).mkdir(parents=True, exist_ok=True)


def raw_or_import_artifact(path: Path) -> bool:
    parts = {part.lower() for part in path.parts}
    return "raw" in parts or "import" in parts


def generated_artifact_path(path: Path) -> bool:
    return path.suffix.lower() in _GENERATED_ARTIFACT_SUFFIXES and not raw_or_import_artifact(path)


def ensure_html_utf8_document(text: str) -> str:
    if _HTML_CHARSET_RE.search(text):
        return text
    if _HTML_HEAD_RE.search(text):
        return _HTML_HEAD_RE.sub(lambda match: f'{match.group(0)}\n<meta charset="utf-8">', text, count=1)
    if re.search(r"(?is)<html\b", text):
        return re.sub(r"(?is)<html\b([^>]*)>", lambda match: f'<html{match.group(1)}>\n<head>\n<meta charset="utf-8">\n</head>', text, count=1)
    return "<!doctype html>\n<html lang=\"ru\">\n<head>\n<meta charset=\"utf-8\">\n</head>\n<body>\n" + text + "\n</body>\n</html>\n"

def artifact_encoding_issues(path: Path, text: str) -> list[str]:
    if not generated_artifact_path(path):
        return []
    issues: list[str] = []
    if _ENCODING_LOSS_RE.search(text):
        issues.append("question_mark_loss")
    if _ENCODING_MOJIBAKE_RE.search(text):
        issues.append("mojibake")
    if path.suffix.lower() in {".html", ".htm"} and not _HTML_CHARSET_RE.search(text):
        issues.append("missing_html_charset")
    return issues


def prepare_artifact_text(path: Path, text: str) -> str:
    prepared = repair_text_encoding(str(text))
    if path.suffix.lower() in {".html", ".htm"} and generated_artifact_path(path):
        prepared = ensure_html_utf8_document(prepared)
    issues = artifact_encoding_issues(path, prepared)
    if issues:
        raise ValueError(
            f"Refusing to write {path}: possible encoding damage ({', '.join(issues)}). "
            "Use UTF-8 artifact writers and regenerate from source text; do not replace Cyrillic with question marks."
        )
    return prepared


def normalize_artifact_value(value: Any) -> Any:
    if isinstance(value, str):
        return repair_text_encoding(value)
    if value is None:
        return ""
    return value


def build_html_document(title: str, body_html: str, css: str = "", lang: str = "ru") -> str:
    safe_title = html.escape(repair_text_encoding(title or "GEO/AEO report"))
    safe_lang = html.escape(lang or "ru")
    style = f"\n<style>\n{css}\n</style>" if css else ""
    return (
        "<!doctype html>\n"
        f"<html lang=\"{safe_lang}\">\n"
        "<head>\n"
        "<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        f"<title>{safe_title}</title>"
        f"{style}\n"
        "</head>\n"
        "<body>\n"
        f"{repair_text_encoding(body_html or '')}\n"
        "</body>\n"
        "</html>\n"
    )


def write_html_report(path: Path, title: str, body_html: str, css: str = "", lang: str = "ru") -> None:
    write_text(path, build_html_document(title, body_html, css=css, lang=lang))


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(prepare_artifact_text(path, text), encoding=ARTIFACT_TEXT_ENCODING, newline="\n")


def write_raw_bytes(path: Path, payload: bytes) -> None:
    """Preserve provider evidence exactly as received, without text normalization."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def decode_text_bytes(payload: bytes, content_type: str = "", source: str = "text") -> tuple[str, str]:
    """Decode user/provider text losslessly; never discard undecodable bytes."""
    if not payload:
        return "", "empty"
    declared: list[str] = []
    content_match = re.search(r"(?i)charset\s*=\s*[\"']?([a-z0-9._-]+)", content_type or "")
    if content_match:
        declared.append(content_match.group(1))
    meta_match = re.search(br"(?is)<meta\b[^>]*?charset\s*=\s*[\"']?\s*([a-z0-9._-]+)", payload[:16384])
    if meta_match:
        declared.append(meta_match.group(1).decode("ascii"))
    if payload.startswith((b"\xff\xfe", b"\xfe\xff")):
        declared.insert(0, "utf-16")
    if payload.startswith(b"\xef\xbb\xbf"):
        declared.insert(0, "utf-8-sig")
    candidates = [*declared, "utf-8-sig", "utf-8", "cp1251"]
    seen: set[str] = set()
    failures: list[str] = []
    for encoding in candidates:
        key = encoding.casefold()
        if key in seen:
            continue
        seen.add(key)
        try:
            return repair_text_encoding(payload.decode(encoding)), encoding
        except (LookupError, UnicodeDecodeError) as exc:
            failures.append(f"{encoding}:{type(exc).__name__}")
    raise UnicodeError(f"Unable to decode {source} without data loss ({', '.join(failures)}).")


def read_text_lossless(path: Path) -> str:
    text, _ = decode_text_bytes(path.read_bytes(), source=str(path))
    return text


def decode_xmlriver_response_bytes(payload: bytes, content_type: str = "") -> tuple[str, str]:
    if not payload:
        raise ValueError("XMLRiver returned an empty response body.")
    declared: list[str] = []
    content_match = re.search(r"(?i)charset\s*=\s*[\"']?([a-z0-9._-]+)", content_type or "")
    if content_match:
        declared.append(content_match.group(1))
    xml_match = re.search(br"(?i)<\?xml[^>]*encoding=[\"']([^\"']+)[\"']", payload[:512])
    if xml_match:
        try:
            declared.append(xml_match.group(1).decode("ascii"))
        except UnicodeDecodeError:
            pass
    candidates = [*declared, "utf-8-sig", "utf-8", "cp1251"]
    seen: set[str] = set()
    failures: list[str] = []
    for encoding in candidates:
        key = encoding.casefold()
        if key in seen:
            continue
        seen.add(key)
        try:
            return payload.decode(encoding), encoding
        except (LookupError, UnicodeDecodeError) as exc:
            failures.append(f"{encoding}:{type(exc).__name__}")
    raise UnicodeError(f"Unable to decode XMLRiver response without data loss ({', '.join(failures)}).")


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    write_text(path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")

def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def copy_template(name: str, dest: Path) -> None:
    src = RUNTIME_ROOT / "templates" / name
    if src.exists() and not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)


def mask_secret(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "****"
    return f"{value[:2]}****{value[-4:]}"


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in read_text_lossless(path).splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def merge_env_values(target: dict[str, str], source: dict[str, str]) -> None:
    for key, value in source.items():
        if value or key not in target:
            target[key] = value


def find_project_root(start: Path) -> Path:
    current = start.resolve()
    local_markers = ["geo_agent", ".git", "pyproject.toml", "requirements.txt", "package.json", "AGENTS.md", "CLAUDE.md"]
    if any((current / marker).exists() for marker in local_markers):
        return current
    parent_markers = ["geo_agent", "pyproject.toml", "requirements.txt", "package.json"]
    for candidate in current.parents:
        if (candidate / ".git").exists():
            break
        if any((candidate / marker).exists() for marker in parent_markers):
            return candidate
    return current

def safe_iter_files(root: Path, max_files: int = 6000) -> list[Path]:
    files: list[Path] = []
    for current, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".cache")]
        for name in names:
            if len(files) >= max_files:
                return files
            path = Path(current) / name
            if path.is_file():
                files.append(path)
    return files


def discover_assets(project_root: Path, scan_neighbors: bool = False) -> dict[str, Any]:
    roots = [project_root]
    if scan_neighbors:
        parent = project_root.parent
        try:
            roots.extend([p for p in parent.iterdir() if p.is_dir() and p != project_root][:8])
        except OSError:
            pass

    matches: list[dict[str, str]] = []
    generator_candidates: list[str] = []
    xmlriver_candidates: list[str] = []
    ai_answer_candidates: list[str] = []
    serp_candidates: list[str] = []

    lower_patterns = [p.lower() for p in DISCOVERY_PATTERNS]
    for root in roots:
        for path in safe_iter_files(root):
            rel = str(path)
            name_lower = path.name.lower()
            rel_lower = rel.lower()
            hit = next((p for p in lower_patterns if p in name_lower or p in rel_lower), None)
            if not hit:
                continue
            item = {"pattern": hit, "path": str(path)}
            matches.append(item)
            if "semantic_brief_builder" in rel_lower or "tz_generator" in rel_lower or "brief_generator" in rel_lower:
                generator_candidates.append(str(path))
            if "xmlriver" in rel_lower or "xml_river" in rel_lower:
                xmlriver_candidates.append(str(path))
            if "ai_answer" in rel_lower or "aio" in rel_lower:
                ai_answer_candidates.append(str(path))
            if "serp" in rel_lower or "search" in rel_lower or "yandex" in rel_lower or "google" in rel_lower:
                serp_candidates.append(str(path))

    def unique(values: list[str]) -> list[str]:
        out: list[str] = []
        seen: set[str] = set()
        for value in values:
            if value not in seen:
                seen.add(value)
                out.append(value)
        return out[:50]

    return {
        "matches_count": len(matches),
        "matches_preview": matches[:80],
        "semantic_tz_generators": unique(generator_candidates),
        "xmlriver_clients": unique(xmlriver_candidates),
        "ai_answer_modules": unique(ai_answer_candidates),
        "serp_modules": unique(serp_candidates),
        "scan_neighbors": scan_neighbors,
    }

RUNTIME_ALIASES = {"codex", "claude", "cursor", "opencode", "antigravity", "generic", "cli", "node"}
RUNTIME_NATIVE_MARKERS = {
    "codex": ["AGENTS.md"],
    "claude": ["CLAUDE.md"],
    "cursor": [".cursor/rules/geo-topic-agent.mdc"],
    "opencode": ["opencode.json"],
    "antigravity": [".antigravity/AGENTS.md"],
    "generic": ["AGENT.md"],
    "cli": [],
    "node": ["package.json"],
}
ACTIVE_ADAPTER_FILES = {
    "codex": "adapters/CODEX.md",
    "claude": "adapters/CLAUDE.md",
    "cursor": ".cursor/rules/geo-topic-agent.mdc",
    "opencode": "adapters/OPENCODE.md",
    "antigravity": "adapters/ANTIGRAVITY.md",
    "generic": "adapters/GENERIC_AGENT.md",
    "cli": "adapters/PYTHON_MODULE.md",
    "node": "adapters/NODE_PROJECT.md",
}
OPTIONAL_NATIVE_ENTRYPOINTS = ["AGENTS.md", "CLAUDE.md", "opencode.json", ".cursor/rules/geo-topic-agent.mdc", ".antigravity/AGENTS.md", "AGENT.md"]
OPTIONAL_NATIVE_MIRRORS = [".agents", ".claude"]
NATIVE_INSTALL_FILES = {
    "codex": "AGENTS.md",
    "claude": "CLAUDE.md",
    "cursor": ".cursor/rules/geo-topic-agent.mdc",
    "opencode": "opencode.json",
    "antigravity": ".antigravity/AGENTS.md",
    "generic": "AGENT.md",
}
NATIVE_SKILL_MIRRORS = {
    "codex": (Path(".agents/skills"), Path(".agents/skills")),
    "claude": (Path(".claude/skills"), Path(".claude/skills")),
}
OPTIONAL_ADAPTER_DOCS = [
    "adapters/CODEX.md",
    "adapters/CLAUDE.md",
    "adapters/OPENCODE.md",
    "adapters/ANTIGRAVITY.md",
    "adapters/GENERIC_AGENT.md",
    "adapters/PYTHON_MODULE.md",
    "adapters/NODE_PROJECT.md",
    "adapters/README.md",
    "adapters/target-conformance.json",
]


def normalize_runtime(value: str) -> str:
    value = (value or "auto").strip().lower().replace("_", "-")
    aliases = {
        "claude-code": "claude",
        "cursor-agent": "cursor",
        "python": "cli",
        "local": "cli",
        "open-code": "opencode",
        "anti-gravity": "antigravity",
        "ag": "antigravity",
        "generic-agent": "generic",
        "agent": "generic",
        "agents": "generic",
    }
    value = aliases.get(value, value)
    return value if value in RUNTIME_ALIASES or value == "auto" else "auto"


def detect_runtime_environment(root: Path, requested_runtime: str = "auto") -> dict[str, Any]:
    requested = normalize_runtime(requested_runtime)
    env_runtime = normalize_runtime(os.environ.get("GEO_AGENT_RUNTIME", ""))
    markers = {name: [rel for rel in rels if (root / rel).exists()] for name, rels in RUNTIME_NATIVE_MARKERS.items()}
    present = [name for name, rels in markers.items() if rels]
    non_node_present = [name for name in present if name != "node"]
    if requested != "auto":
        active, confidence, source = requested, "explicit", "setup_argument"
    elif env_runtime != "auto":
        active, confidence, source = env_runtime, "explicit", "GEO_AGENT_RUNTIME"
    elif len(non_node_present) == 1:
        active, confidence, source = non_node_present[0], "marker", "native_marker"
    elif not present:
        active, confidence, source = "cli", "fallback", "no_native_marker"
    else:
        active, confidence, source = "ambiguous", "ambiguous", "multiple_native_markers"
    return {
        "active_runtime": active,
        "confidence": confidence,
        "source": source,
        "requested_runtime": requested_runtime or "auto",
        "markers": markers,
        "present_runtimes": present,
        "generated_at": utc_now(),
    }


def build_runtime_adaptation_plan(root: Path, profile: dict[str, Any]) -> dict[str, Any]:
    active = profile.get("active_runtime", "ambiguous")
    managed_root = root / RUNTIME_INSTALL_REL
    keep: set[str] = {"AGENTS.md"}
    native_entrypoint = NATIVE_INSTALL_FILES.get(active, "")
    if native_entrypoint:
        keep.add(native_entrypoint)
    if active == "codex":
        keep.add(".agents")
    if active == "claude":
        keep.add(".claude")
    active_adapter = ACTIVE_ADAPTER_FILES.get(active, "")
    actions = []
    if managed_root.exists():
        for rel in OPTIONAL_NATIVE_ENTRYPOINTS:
            if rel not in keep and (managed_root / rel).exists():
                actions.append({"action": "move_to_inactive_adapters", "path": rel, "reason": f"inactive for {active}"})
        for rel in OPTIONAL_NATIVE_MIRRORS:
            if rel not in keep and (managed_root / rel).exists():
                actions.append({"action": "move_to_inactive_adapters", "path": rel, "reason": f"inactive native skill mirror for {active}"})
        for rel in OPTIONAL_ADAPTER_DOCS:
            if rel != active_adapter and (managed_root / rel).exists():
                actions.append({"action": "move_to_inactive_adapters", "path": rel, "reason": f"inactive adapter for {active}"})
    # Canonical adapters remain inside the managed package so its manifest stays truthful.
    # Native bootstraps are installed only for the detected active runtime.
    actions = []
    plan = {
        "active_runtime": active,
        "apply_allowed": active in RUNTIME_ALIASES and managed_root.exists(),
        "managed_runtime_root": str(managed_root),
        "cleanup_mode": "retain_canonical_adapters_install_active_native_bootstrap_only",
        "actions": actions,
        "kept_entrypoints": sorted(keep),
        "active_adapter": active_adapter,
        "generated_at": utc_now(),
    }
    plan["plan_hash"] = hashlib.sha256(
        json.dumps({key: value for key, value in plan.items() if key not in {"generated_at", "plan_hash"}}, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return plan


def apply_runtime_adaptation(root: Path, plan: dict[str, Any], reviewed_plan_hash: str = "") -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    expected_hash = str(plan.get("plan_hash", ""))
    if not reviewed_plan_hash or reviewed_plan_hash != expected_hash:
        return [{"action": "skip", "reason": "runtime adaptation requires an explicit reviewed --reviewed-runtime-plan-hash matching the emitted plan", "expected_plan_hash": expected_hash}]
    if not plan.get("apply_allowed"):
        return [{"action": "skip", "reason": "installed runtime is missing, ambiguous, or unsupported"}]
    managed_root = Path(str(plan.get("managed_runtime_root", ""))).resolve()
    expected_root = (root / RUNTIME_INSTALL_REL).resolve()
    if managed_root != expected_root or not managed_root.exists():
        return [{"action": "skip", "reason": "managed runtime root is not the installed package directory"}]
    backup_root = managed_root / ".inactive-adapters"
    for row in plan.get("actions", []):
        rel = row.get("path", "")
        src = (managed_root / rel).resolve()
        if not src.exists():
            actions.append({**row, "status": "missing"})
            continue
        if not src.is_relative_to(managed_root):
            actions.append({**row, "status": "blocked", "reason": "path outside installed runtime"})
            continue
        dest = (backup_root / rel).resolve()
        if not dest.is_relative_to(backup_root.resolve()):
            actions.append({**row, "status": "blocked", "reason": "backup path outside installed runtime"})
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            actions.append({**row, "status": "kept_existing_backup"})
            continue
        shutil.move(str(src), str(dest))
        actions.append({**row, "status": "moved", "destination": str(dest)})
    return actions


def verify_runtime_inventory(source_root: Path) -> dict[str, Any]:
    inventory_path = source_root / "FILES.sha256"
    if not inventory_path.exists():
        return {"status": "fail", "errors": ["FILES.sha256 is missing"], "files": 0}
    expected: dict[str, str] = {}
    errors: list[str] = []
    for line in read_text_lossless(inventory_path).splitlines():
        if not line.strip():
            continue
        parts = line.split("  ", 1)
        if len(parts) != 2 or not re.fullmatch(r"[0-9a-fA-F]{64}", parts[0]):
            errors.append(f"invalid checksum line: {line[:120]}")
            continue
        rel = parts[1].replace("\\", "/")
        if Path(rel).is_absolute() or rel.startswith("/") or re.match(r"^[A-Za-z]:", rel) or ".." in Path(rel).parts:
            errors.append(f"unsafe inventory path: {rel}")
            continue
        if rel in expected:
            errors.append(f"duplicate inventory path: {rel}")
            continue
        expected[rel] = parts[0].lower()
    discovered_paths = {
        path.relative_to(source_root).as_posix(): path
        for path in source_root.rglob("*")
        if path.is_file() and path.name != "FILES.sha256"
    }
    missing = sorted(set(expected) - set(discovered_paths))
    if missing:
        errors.append("missing files: " + ", ".join(missing[:20]))
    for rel, expected_digest in expected.items():
        file_path = discovered_paths.get(rel)
        if file_path is None:
            continue
        if file_path.is_symlink():
            errors.append(f"symlink is not allowed: {rel}")
            continue
        digest = hashlib.sha256(file_path.read_bytes()).hexdigest()
        if expected_digest != digest:
            errors.append(f"checksum mismatch: {rel}")
    # Project-owned files can share the staging folder. They are outside the signed allowlist
    # and are never copied into the installed runtime.
    ignored_project_files = sorted(set(discovered_paths) - set(expected))
    return {
        "status": "pass" if not errors else "fail",
        "errors": errors,
        "files": len(expected),
        "verified_files": sorted(expected),
        "ignored_project_files_count": len(ignored_project_files),
        "ignored_project_files_preview": ignored_project_files[:20],
    }


def copy_verified_runtime_files(source_root: Path, destination: Path, verified_files: list[str]) -> list[str]:
    """Copy only checksum-verified package assets; never copy project-owned extras."""
    source_root = source_root.resolve()
    destination = destination.resolve()
    copied: list[str] = []
    for rel in verified_files:
        source = (source_root / rel).resolve()
        target = (destination / rel).resolve()
        if not source.is_relative_to(source_root) or not target.is_relative_to(destination):
            raise ValueError(f"unsafe verified runtime path: {rel}")
        if not source.is_file() or source.is_symlink():
            raise ValueError(f"verified runtime file is unavailable: {rel}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        copied.append(rel)
    return copied


def native_bootstrap_text(runtime: str) -> str:
    canonical_router = (RUNTIME_INSTALL_REL / "AGENTS.md").as_posix()
    launcher = (RUNTIME_INSTALL_REL / "geo_agent_cli.py").as_posix()
    setup_command = f'python {launcher} setup --project-dir "." --runtime {runtime}'
    shared = (
        "This is a thin native bootstrap for the installed GEO Topic Agent.\n\n"
        f"The canonical runtime is `{RUNTIME_INSTALL_REL.as_posix()}`. Read and follow "
        f"`{canonical_router}` as the source of truth. Resolve every package-relative path named "
        "by that router, including `skills/`, `references/`, `geo-topic-contract.json`, `LICENSE.md`, "
        f"and adapters, under `{RUNTIME_INSTALL_REL.as_posix()}/`, not under the project root.\n\n"
        f"Run CLI commands through `{launcher}` so a fresh process does not depend on `PYTHONPATH`. "
        f"First setup command: `{setup_command}`.\n\n"
        "Do not merge, replace, or reinterpret unrelated project instructions automatically."
    )
    if runtime == "cursor":
        return "---\ndescription: Bootstrap for the installed GEO Topic Agent.\nglobs: []\nalwaysApply: true\n---\n\n# GEO Topic Agent Bootstrap\n\n" + shared + "\n"
    if runtime == "claude":
        return f"@{RUNTIME_INSTALL_REL.as_posix()}/AGENTS.md\n\n# GEO Topic Agent Bootstrap\n\n{shared}\n"
    return f"# GEO Topic Agent Bootstrap\n\n{shared}\n"


def native_bootstrap_bytes(runtime: str) -> bytes:
    if runtime == "opencode":
        payload = {
            "$schema": "https://opencode.ai/config.json",
            "instructions": [
                (RUNTIME_INSTALL_REL / "AGENTS.md").as_posix(),
                (RUNTIME_INSTALL_REL / "adapters/OPENCODE.md").as_posix(),
            ],
        }
        return (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    return native_bootstrap_text(runtime).encode("utf-8")


def install_native_skill_mirror(destination: Path, target_root: Path, runtime: str) -> dict[str, Any]:
    mapping = NATIVE_SKILL_MIRRORS.get(runtime)
    if not mapping:
        return {"runtime": runtime, "status": "not_applicable", "files": []}
    source_rel, target_rel = mapping
    source_root = destination / source_rel
    target_skills_root = target_root / target_rel
    candidate_root = destination / "native-candidate" / target_rel
    rows: list[dict[str, Any]] = []
    if not source_root.is_dir():
        return {"runtime": runtime, "status": "missing_source", "source": str(source_root), "files": []}
    for source in sorted(path for path in source_root.rglob("*") if path.is_file()):
        relative = source.relative_to(source_root)
        target = target_skills_root / relative
        if target.exists():
            if target.is_file() and hashlib.sha256(target.read_bytes()).digest() == hashlib.sha256(source.read_bytes()).digest():
                rows.append({"path": relative.as_posix(), "status": "already_identical", "target": str(target)})
            else:
                candidate = candidate_root / relative
                candidate.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, candidate)
                rows.append({"path": relative.as_posix(), "status": "collision_requires_user_merge", "target": str(target), "candidate": str(candidate)})
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        rows.append({"path": relative.as_posix(), "status": "installed", "target": str(target)})
    statuses = {row["status"] for row in rows}
    status = "collision_requires_user_merge" if "collision_requires_user_merge" in statuses else "installed"
    return {
        "runtime": runtime,
        "status": status,
        "source": str(source_root),
        "target": str(target_skills_root),
        "files": rows,
    }


def install_runtime(
    project_dir: Path,
    runtime: str = "auto",
    install_native_adapter: bool = False,
) -> dict[str, Any]:
    target_root = Path(project_dir).resolve()
    target_root.mkdir(parents=True, exist_ok=True)
    source_root = RUNTIME_ROOT.resolve()
    destination = (target_root / RUNTIME_INSTALL_REL).resolve()
    if destination == source_root or target_root == source_root:
        return observation(
            "blocked",
            "Install target must be a separate user project, not the extracted runtime source.",
            next_valid_actions=["choose_target_project_directory"],
        )
    if destination.exists():
        return observation(
            "blocked",
            "Installed runtime directory already exists; this installer never overwrites an existing installation.",
            items=[{"installed_runtime": str(destination)}],
            next_valid_actions=["review_existing_installation", "use_versioned_upgrade_process"],
        )

    verification = verify_runtime_inventory(source_root)
    if verification.get("status") != "pass":
        return observation(
            "blocked",
            "Runtime checksum inventory verification failed; no files were installed.",
            items=[verification],
            evidence_refs=[str(source_root / "FILES.sha256")],
            next_valid_actions=["reextract_official_runtime_archive", "verify_archive_checksum"],
        )

    copied_runtime_files = copy_verified_runtime_files(
        source_root,
        destination,
        verification["verified_files"],
    )
    active_runtime = normalize_runtime(runtime)
    if active_runtime == "auto":
        active_runtime = detect_runtime_environment(target_root, "auto").get("active_runtime", "cli")
    native_rel = NATIVE_INSTALL_FILES.get(active_runtime, "")
    native_status = "not_applicable"
    native_target = target_root / native_rel if native_rel else Path()
    native_candidate = destination / "native-candidate" / native_rel if native_rel else Path()
    native_skills = {"runtime": active_runtime, "status": "not_requested", "files": []}

    if native_rel:
        bootstrap = native_bootstrap_bytes(active_runtime)
        if not install_native_adapter:
            native_candidate.parent.mkdir(parents=True, exist_ok=True)
            native_candidate.write_bytes(bootstrap)
            native_status = "pending_explicit_install_or_merge"
        elif native_target.exists():
            if native_target.is_file() and native_target.read_bytes() == bootstrap:
                native_status = "already_identical"
            else:
                native_candidate.parent.mkdir(parents=True, exist_ok=True)
                native_candidate.write_bytes(bootstrap)
                native_status = "collision_requires_user_merge"
        else:
            native_target.parent.mkdir(parents=True, exist_ok=True)
            native_target.write_bytes(bootstrap)
            native_status = "installed"
        if install_native_adapter:
            native_skills = install_native_skill_mirror(destination, target_root, active_runtime)

    install_record = {
        "schema_version": "geo-topic-agent.installation.v1",
        "package_version": PACKAGE_VERSION,
        "installed_at": utc_now(),
        "installed_runtime": str(destination),
        "project_root": str(target_root),
        "active_runtime": active_runtime,
        "inventory_verification": verification,
        "copied_runtime_files": len(copied_runtime_files),
        "native_adapter": {
            "path": native_rel,
            "status": native_status,
            "target": str(native_target) if native_rel else "",
            "candidate": str(native_candidate) if native_rel and native_candidate.exists() else "",
        },
        "native_skills": native_skills,
        "next_command": (
            f'python {RUNTIME_INSTALL_REL.as_posix()}/geo_agent_cli.py setup --project-dir "." '
            f'--runtime {active_runtime}'
        ),
    }
    write_json(destination / "INSTALLATION.json", install_record)
    native_skills_ok = native_skills.get("status") in {"not_requested", "not_applicable", "installed"}
    status = "success" if native_status in {"not_applicable", "installed", "already_identical"} and native_skills_ok else "partial_success"
    return observation(
        status,
        "Runtime installed without overwriting project files.",
        items=[install_record],
        evidence_refs=[str(destination / "INSTALLATION.json")],
        next_valid_actions=(
            ["run_environment_setup"]
            if status == "success"
            else ["review_native_adapter_candidate", "approve_merge_or_install_native_adapter", "then_run_environment_setup"]
        ),
    )

def default_config() -> dict[str, Any]:
    return {
        "agent": {"name": "geo-topic-agent", "mode": "interactive", "storage": "csv_json", "language": "ru"},
        "project": {"domain": "", "brand": "", "brand_variants": [], "brand_variants_status": "missing", "brand_variants_source": "not_provided", "target_goal": "both", "priority_topics": [], "semantic_cluster_queries": [], "competitors": [], "site_pages": [], "products_services": [], "documents": [], "context_notes": "", "site_discovery_approved": False, "context_not_applicable_decisions": [], "audit_decisions": {}},
        "region": {
            "country": "",
            "city": "",
            "language": "",
            "scope_status": "unresolved",
            "scope_provenance": "not_provided",
            "google": {"gl": "ru", "hl": "ru"},
            "yandex": {"lr": 213},
            "device": {"default": "desktop", "collect_mobile": False},
        },
        "search_engines": {
            "google": {"enabled": True, "provider": "xmlriver", "depth": 20},
            "yandex": {"enabled": True, "provider": "xmlriver", "depth": 20},
            "bing": {"enabled": False, "provider": "manual_or_existing", "depth": 20},
            "brave": {"enabled": False, "provider": "manual_or_existing", "depth": 20},
        },
        "xmlriver": {
            "enabled": True,
            "use_existing_client": True,
            "env_key_aliases": ["XMLRIVER_USER", "XMLRIVER_KEY"],
        },
        "ai_answers": {
            "enabled": False,
            "provider": "existing_or_manual",
            "collect_raw": True,
            "extract_citations": True,
            "repeat_runs": 3,
            "manual_import_template": str(IMPORT_REL / "ai_answers_template.csv"),
        },
        "outputs": {
            "reports_dir": str(REPORTS_REL),
            "data_dir": str(DATA_REL),
            "handoff_dir": str(HANDOFF_REL),
        },
        "budgets": {
            "max_serp_queries_without_explicit_approval": 50,
            "max_repair_iterations": 3,
            "max_runtime_minutes": 60,
        },
    }


def load_config(root: Path) -> dict[str, Any]:
    cfg = default_config()
    existing = read_json(root / CONFIG_REL, {})
    if isinstance(existing, dict):
        deep_update(cfg, existing)
    return cfg


def deep_update(base: dict[str, Any], incoming: dict[str, Any]) -> None:
    for key, value in incoming.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            deep_update(base[key], value)
        else:
            base[key] = value


def save_config(root: Path, config: dict[str, Any]) -> None:
    write_json(root / CONFIG_REL, config)


def setup_environment(
    project_dir: Path,
    scan_neighbors: bool = False,
    runtime: str = "auto",
    apply_runtime_adaptation_flag: bool = False,
    reviewed_runtime_plan_hash: str = "",
) -> dict[str, Any]:
    root = find_project_root(project_dir)
    ensure_dirs(root)

    env_paths = [root / ".env", root / ".env.local", root / ".env.example"]
    env_data: dict[str, str] = {}
    found_envs = []
    for env_path in env_paths:
        if env_path.exists():
            found_envs.append(str(env_path))
            merge_env_values(env_data, parse_env_file(env_path))
    env_present = {key: mask_secret(os.environ.get(key) or env_data.get(key, "")) for key in ENV_ALIASES}
    env_present = {key: value for key, value in env_present.items() if value}

    if not any((root / p).exists() for p in [".env", ".env.local", ".env.example"]):
        copy_template_env(root)

    discovery = discover_assets(root, scan_neighbors=scan_neighbors)
    runtime_profile = detect_runtime_environment(root, runtime)
    runtime_plan = build_runtime_adaptation_plan(root, runtime_profile)
    applied_runtime_actions = (
        apply_runtime_adaptation(root, runtime_plan, reviewed_plan_hash=reviewed_runtime_plan_hash)
        if apply_runtime_adaptation_flag
        else []
    )
    runtime_adaptation_applied = bool(
        apply_runtime_adaptation_flag
        and applied_runtime_actions
        and all(row.get("status") not in {"skip", "blocked"} for row in applied_runtime_actions)
    )
    profile_path = runtime_profile_path(root)
    plan_path = birth_plan_path(root)
    runtime_profile["runtime_local_root"] = portable_ref(root, runtime_local_root(root))
    write_json(profile_path, runtime_profile)
    write_json(plan_path, {
        **runtime_plan,
        "apply_requested": apply_runtime_adaptation_flag,
        "reviewed_plan_hash": reviewed_runtime_plan_hash,
        "applied": runtime_adaptation_applied,
        "applied_actions": applied_runtime_actions,
    })
    config = load_config(root)
    config["runtime"] = {"profile": runtime_profile, "birth_plan": runtime_plan, "applied_actions": applied_runtime_actions}
    config["discovery"] = {
        "updated_at": utc_now(),
        "project_root": str(root),
        "env_files": found_envs,
        "env_keys_present_masked": env_present,
        **discovery,
    }
    save_config(root, config)
    copy_import_templates(root)

    report = build_adaptation_report(root, config)
    report_path = root / REPORTS_REL / "ADAPTATION_REPORT.md"
    write_text(report_path, report)

    return observation(
        "success",
        "Environment adaptation completed.",
        items=[
            {"project_root": str(root)},
            {"report": str(report_path)},
            {"xmlriver_clients": len(discovery["xmlriver_clients"])},
            {"semantic_tz_generators": len(discovery["semantic_tz_generators"])},
            {"env_keys_present": sorted(env_present.keys())},
            {"active_runtime": runtime_profile.get("active_runtime"), "runtime_confidence": runtime_profile.get("confidence")},
            {"runtime_adaptation_applied": runtime_adaptation_applied, "runtime_plan_hash": runtime_plan.get("plan_hash", ""), "runtime_actions": len(applied_runtime_actions)},
        ],
        evidence_refs=[str(report_path), str(root / CONFIG_REL), str(profile_path), str(plan_path)],
        next_valid_actions=["answer_project_context_intake", "offer_deep_project_context_collection", "collect_project_context", "then_offer_site_and_target_page_audit"],
    )


def copy_template_env(root: Path) -> None:
    src = RUNTIME_ROOT / "env.example"
    dest = root / ".env.example"
    if src.exists() and not dest.exists():
        shutil.copyfile(src, dest)


def copy_import_templates(root: Path) -> None:
    copy_template("manual_serp_template.csv", root / IMPORT_REL / "manual_serp_template.csv")
    copy_template("ai_answers_template.csv", root / IMPORT_REL / "ai_answers_template.csv")
    copy_template("project_context_template.json", root / IMPORT_REL / "project_context_template.json")
    copy_template("geo_agent_config.yaml", root / CONFIG_REL.parent / "geo_agent_config.example.yaml")
    final_evidence_dir = root / IMPORT_REL / "final_evidence"
    copy_template("final_evidence_decisions_template.json", final_evidence_dir / "final_evidence_decisions_template.json")
    copy_template("independent_review_summary_template.json", final_evidence_dir / "independent_review_summary_template.json")
    copy_template("provider_collection_summary_template.json", final_evidence_dir / "provider_collection_summary_template.json")
    copy_template("url_enrichment_summary_template.json", final_evidence_dir / "url_enrichment_summary_template.json")


def build_adaptation_report(root: Path, config: dict[str, Any]) -> str:
    discovery = config.get("discovery", {})
    env_keys = discovery.get("env_keys_present_masked", {})
    missing_actions = []
    if not discovery.get("xmlriver_clients"):
        missing_actions.append("Add XMLRiver credentials or point the agent to an existing XMLRiver client.")
    if not discovery.get("semantic_tz_generators"):
        missing_actions.append("Provide path to semantic_brief_builder.py or another TZ generator if automatic handoff invocation is needed.")
    if not discovery.get("ai_answer_modules"):
        missing_actions.append("Enable an AI-answer collector or use data/import/ai_answers_template.csv for manual import.")
    if not missing_actions:
        missing_actions.append("Review discovered assets and run init-project.")

    return f"""# ADAPTATION_REPORT

Generated: {utc_now()}

## Environment

- OS: {platform.platform()}
- Python: {sys.version.split()[0]}
- Working directory: {portable_ref(root, Path.cwd())}
- Project root: {portable_ref(root, root)}
- Agent runtime: geo-topic-agent {PACKAGE_VERSION}

## Runtime / IDE

- active runtime: {config.get("runtime", {}).get("profile", {}).get("active_runtime", "unknown")}
- detection confidence: {config.get("runtime", {}).get("profile", {}).get("confidence", "unknown")}
- detection source: {config.get("runtime", {}).get("profile", {}).get("source", "unknown")}
- runtime profile: {portable_ref(root, runtime_profile_path(root))}
- birth plan: {portable_ref(root, birth_plan_path(root))}
- runtime-local state root: {portable_ref(root, runtime_local_root(root))}
- inactive adapter actions applied: {len(config.get("runtime", {}).get("applied_actions", []))}

## Found Configs

- env files: {', '.join(discovery.get('env_files', [])) or 'none'}
- masked env keys: {json.dumps(env_keys, ensure_ascii=False)}
- project marker files: {detect_package_files(root)}

## XMLRiver

- found client: {'yes' if discovery.get('xmlriver_clients') else 'no'}
- paths: {format_list(discovery.get('xmlriver_clients', []))}
- test request: not run; live provider calls require explicit approval

## AI Answers

- found module: {'yes' if discovery.get('ai_answer_modules') else 'no'}
- paths: {format_list(discovery.get('ai_answer_modules', []))}
- manual import template: {portable_ref(root, root / IMPORT_REL / 'ai_answers_template.csv')}

## Semantic SEO TZ Generator

- found: {'yes' if discovery.get('semantic_tz_generators') else 'no'}
- paths: {format_list(discovery.get('semantic_tz_generators', []))}
- input format: data/handoff/semantic_tz_handoff_<topic>.json

## Created By Agent

- config: {root / CONFIG_REL}
- reports: {root / REPORTS_REL}
- data: {root / DATA_REL}
- import templates: {root / IMPORT_REL}
- final evidence templates: {root / IMPORT_REL / 'final_evidence'}
- handoff dir: {root / HANDOFF_REL}

## First-Run Intake

Ask the user one question at a time. Start with site/domain. After the site/domain is known and setup is complete, the next step is the Deep Context Offer Gate: offer to collect product/business context independently from the homepage, user-provided landing pages, header/navigation, footer, pricing/payment/subscription/trial/demo/free-access/delivery/contact/about/legal/case/review/FAQ pages. Ask explicit approval for public site discovery/network, or ask for documents/local HTML snapshots. Do not jump directly to topic/SERP/QFO/TZ work before deep context is collected or explicitly declined.

## User Action Needed

{chr(10).join(f'- {item}' for item in missing_actions)}
"""


def detect_package_files(root: Path) -> str:
    files = [".env", ".env.local", ".env.example", "pyproject.toml", "requirements.txt", "package.json", "README.md"]
    found = [name for name in files if (root / name).exists()]
    return ", ".join(found) if found else "none"


def format_list(values: list[str]) -> str:
    if not values:
        return "none"
    return "\n" + "\n".join(f"  - {value}" for value in values[:20])


def cli_command_prefix(root: Path) -> str:
    installed_launcher = root / RUNTIME_INSTALL_REL / "geo_agent_cli.py"
    if installed_launcher.is_file():
        return f"python {RUNTIME_INSTALL_REL.as_posix()}/geo_agent_cli.py"
    if (root / "geo_agent_cli.py").is_file():
        return "python geo_agent_cli.py"
    return "python -m geo_topic_agent.cli"


def init_project_context(
    project_dir: Path,
    domain: str = "",
    brand: str = "",
    brand_variants: str = "",
    topic: str = "",
    region: str = "",
    language: str = "",
    engines: str = "",
    goal: str = "",
    competitors: str = "",
    pages: str = "",
    products_services: str = "",
    documents: str = "",
    allow_site_discovery: bool = False,
    context_notes: str = "",
    cluster_queries: str = "",
    cluster_queries_file: str = "",
    accept_topic_cluster: bool = False,
) -> dict[str, Any]:
    root = find_project_root(project_dir)
    ensure_dirs(root)
    # Context intake must never create a topic/cluster record before the context and audit gates.
    deferred_topic_cluster_input = bool(normalize_ws(topic) or normalize_ws(cluster_queries) or normalize_ws(cluster_queries_file)) and not accept_topic_cluster
    if not accept_topic_cluster:
        topic = ""
        cluster_queries = ""
        cluster_queries_file = ""
    config = load_config(root)
    previous_topics = config["project"].get("priority_topics", [])
    previous_topic = previous_topics[0] if isinstance(previous_topics, list) and previous_topics else ""
    config["project"]["domain"] = domain or config["project"].get("domain", "")
    config["project"]["brand"] = brand or config["project"].get("brand", "")
    config["project"]["target_goal"] = goal or config["project"].get("target_goal", "both")
    config["region"]["language"] = language or config["region"].get("language", "ru")
    if region:
        parts = region.split("-", 1)
        config["region"]["country"] = parts[0]
        if len(parts) > 1:
            config["region"]["city"] = parts[1]
    if engines:
        enabled_engines = split_csv(engines)
        for engine_name in config["search_engines"]:
            config["search_engines"][engine_name]["enabled"] = engine_name in enabled_engines
    if competitors:
        config["project"]["competitors"] = split_csv(competitors)
    if pages:
        config["project"]["site_pages"] = split_csv(pages)
    if products_services:
        config["project"]["products_services"] = split_csv(products_services)
    if brand_variants or not config["project"].get("brand_variants"):
        apply_brand_variants(config, brand_variants)
    if documents:
        config["project"]["documents"] = split_csv(documents)
    if allow_site_discovery:
        config["project"]["site_discovery_approved"] = True
    if context_notes:
        config["project"]["context_notes"] = repair_text_encoding(context_notes)
    if topic:
        config["project"]["priority_topics"] = [topic]
    topic_value = topic or (config["project"].get("priority_topics", [""]) or [""])[0]
    cluster_query_values = explicit_semantic_cluster_queries(cluster_queries, cluster_queries_file)
    project = config["project"]
    existing_meta = semantic_cluster_meta(project, previous_topic or topic_value)
    existing_topic = existing_meta.get("semantic_cluster_topic") or previous_topic
    if accept_topic_cluster and cluster_query_values:
        project["semantic_cluster_queries"] = cluster_query_values
        project["semantic_cluster_topic"] = topic_value
        project["semantic_cluster_status"] = "confirmed"
        project["semantic_cluster_source"] = "user_supplied"
        project["semantic_cluster_confirmed_at"] = utc_now()
    elif accept_topic_cluster and topic_value and existing_topic and semantic_cluster_topic_key(existing_topic) != semantic_cluster_topic_key(topic_value):
        project["semantic_cluster_queries"] = []
        project["semantic_cluster_topic"] = topic_value
        project["semantic_cluster_status"] = "missing"
        project["semantic_cluster_source"] = "not_provided"
        project.pop("semantic_cluster_confirmed_at", None)
    elif configured_semantic_cluster_queries(config, topic_value):
        project.setdefault("semantic_cluster_topic", topic_value)
        project.setdefault("semantic_cluster_status", "confirmed")
        project.setdefault("semantic_cluster_source", "legacy_config")
    elif accept_topic_cluster:
        project["semantic_cluster_queries"] = []
        project["semantic_cluster_topic"] = topic_value
        project["semantic_cluster_status"] = "missing"
        project["semantic_cluster_source"] = "not_provided"
        project.pop("semantic_cluster_confirmed_at", None)
    save_config(root, config)

    existing_context = read_json(root / DATA_REL / "project_context.json", {})
    existing_site_context = existing_context.get("site_context", {}) if isinstance(existing_context.get("site_context"), dict) else {}
    not_applicable_evaluation = evaluate_context_not_applicable_decisions(config, existing_context)
    existing_site_context = apply_context_not_applicable_decisions(existing_site_context, not_applicable_evaluation)
    existing_site_context_status = existing_site_context.get("status", "not_collected") if existing_site_context else "not_collected"
    existing_site_gate = existing_site_context.get("quality_gate", {}) if isinstance(existing_site_context.get("quality_gate"), dict) else {}
    existing_open_questions = [
        str(question)
        for question in existing_site_context.get("open_questions", [])
        if question and not str(question).startswith("No major product-context questions")
    ]
    brand_variants_confirmed = config["project"].get("brand_variants_status") == "confirmed"
    site_evidence_complete = (
        existing_site_context_status == "success"
        and existing_site_gate.get("status", "pass") == "pass"
        and not existing_open_questions
    )
    context_quality_gate = {
        "status": "pass" if site_evidence_complete and brand_variants_confirmed else "fail",
        "site_context_status": existing_site_context_status,
        "brand_variants_status": config["project"].get("brand_variants_status", "missing"),
        "brand_variants_confirmed": brand_variants_confirmed,
        "brand_variants_waivable": False,
        "material_open_questions": existing_open_questions,
        "missing_context_fields": existing_site_gate.get("missing_context_fields", existing_site_gate.get("blocking_check_ids", [])),
        "accepted_not_applicable_fields": not_applicable_evaluation.get("accepted_fields", []),
        "accepted_not_applicable_decisions": not_applicable_evaluation.get("accepted_decisions", []),
        "rejected_not_applicable_decisions": not_applicable_evaluation.get("rejected_decisions", []),
    }
    deep_context_missing = bool(config["project"].get("domain")) and context_quality_gate["status"] != "pass"
    deep_context_scope = [
        "homepage",
        "user-provided core landing pages",
        "main product/service/course pages",
        "header and navigation links",
        "footer links",
        "pricing, tariffs, payment, subscription, checkout",
        "trial, demo, free-access, delivery or shipping pages when relevant",
        "contacts, about/company/team/author, legal, terms, refund, requisites",
        "cases, reviews, FAQ and trust pages",
    ]
    domain_for_command = config["project"].get("domain", "")
    pages_for_command = config["project"].get("site_pages", [])
    recommended_deep_context_command = f'{cli_command_prefix(root)} collect-context --domain "{domain_for_command}" --allow-site-discovery --network-approved --max-pages 30' if domain_for_command else ""
    if recommended_deep_context_command and pages_for_command:
        recommended_deep_context_command += ' --pages "' + '; '.join(str(page) for page in pages_for_command) + '"'

    semantic_queries = configured_semantic_cluster_queries(config, topic_value)
    cluster_meta = semantic_cluster_meta(config["project"], topic_value)
    context = {
        "domain": config["project"].get("domain", ""),
        "brand": config["project"].get("brand", ""),
        "brand_variants": brand_variants_from_config(config),
        "brand_variants_status": config["project"].get("brand_variants_status", "missing"),
        "brand_variants_source": config["project"].get("brand_variants_source", "not_provided"),
        "brand_variants_confirmation_required": config["project"].get("brand_variants_status") != "confirmed",
        "target_goal": config["project"].get("target_goal", "both"),
        "topic": topic_value,
        "topic_cluster_intake_deferred": deferred_topic_cluster_input,
        "semantic_cluster_queries": semantic_queries,
        "cluster_query_count": len(semantic_queries),
        "semantic_cluster_topic": cluster_meta.get("semantic_cluster_topic") or topic_value,
        "semantic_cluster_status": cluster_meta.get("semantic_cluster_status"),
        "semantic_cluster_source": cluster_meta.get("semantic_cluster_source"),
        "semantic_cluster_confirmed": cluster_meta.get("semantic_cluster_confirmed"),
        "semantic_cluster_confirmation_required": not bool(semantic_queries),
        "region": config["region"],
        "language": config.get("region", {}).get("language", "ru"),
        "search_engines": [k for k, v in config["search_engines"].items() if v.get("enabled")],
        "competitors": config["project"].get("competitors", []),
        "site_pages": config["project"].get("site_pages", []),
        "products_services": config["project"].get("products_services", []),
        "documents": config["project"].get("documents", []),
        "site_discovery_approved": config["project"].get("site_discovery_approved", False),
        "context_notes": config["project"].get("context_notes", ""),
        "context_not_applicable_decisions": existing_context.get("context_not_applicable_decisions", []),
        "audit_decisions": existing_context.get("audit_decisions", {}),
        "context_quality_gate": context_quality_gate,
        "context_acquisition": {
            **(existing_context.get("context_acquisition", {}) if isinstance(existing_context.get("context_acquisition"), dict) else {}),
            "documents_provided": bool(config["project"].get("documents", [])),
            "site_discovery_approved": config["project"].get("site_discovery_approved", False),
            "network_required_for_site_discovery": True,
            "accessibility_audit_separate": True,
            "deep_context_collection_status": "success" if context_quality_gate["status"] == "pass" else ("quality_fail" if existing_site_context_status in {"success", "quality_fail"} else existing_site_context_status),
            "deep_context_completed_at": (existing_context.get("context_acquisition", {}).get("deep_context_completed_at") or utc_now()) if context_quality_gate["status"] == "pass" else "",
            "post_context_next_step": "offer_site_and_target_page_audit" if context_quality_gate["status"] == "pass" else ("confirm_brand_variants" if not brand_variants_confirmed else "resolve_context_quality_gaps"),
            "deep_context_offer_required": bool(deep_context_missing and not site_evidence_complete and not config["project"].get("site_discovery_approved") and not config["project"].get("documents", [])),
            "deep_context_run_recommended": bool(deep_context_missing),
            "recommended_deep_context_max_pages": 30,
            "recommended_deep_context_scope": deep_context_scope,
            "recommended_deep_context_command": recommended_deep_context_command,
        },
        "assumptions": build_context_assumptions(config, topic_value),
        "updated_at": utc_now(),
    }
    if existing_site_context:
        context["site_context"] = existing_site_context
    if deep_context_missing:
        if config["project"].get("site_discovery_approved") or config["project"].get("documents", []):
            context["assumptions"].append("Deep product/business site context has not been collected yet. Run collect-context with the approved documents/site discovery before SERP, QFO, TZ, placement, visibility, or monitoring work.")
        else:
            context["assumptions"].append("Deep product/business site context has not been collected yet. Ask the user to approve public site discovery or provide documents/local HTML snapshots before SERP, QFO, TZ, placement, visibility, or monitoring work.")
    write_json(root / DATA_REL / "project_context.json", context)
    report_path = root / REPORTS_REL / "PROJECT_CONTEXT.md"
    write_text(report_path, build_project_context_report(context))
    update_state(root, f"Project context updated for {domain or 'unknown domain'} / {topic_value or 'no topic'}", [str(report_path)])

    if context.get("brand_variants_confirmation_required") and site_evidence_complete:
        next_actions = [
            "confirm_brand_variants",
            "then_offer_site_and_target_page_audit",
            "then_collect_topic_and_semantic_cluster",
        ]
    elif deep_context_missing:
        deep_action = "run_deep_project_context_collection" if config["project"].get("site_discovery_approved") or config["project"].get("documents", []) else "ask_user_to_approve_deep_project_context_collection"
        next_actions = [deep_action, "collect_project_context", "then_offer_site_and_target_page_audit", "after_audit_request_topic_and_semantic_cluster"]
        if context.get("brand_variants_confirmation_required"):
            next_actions = ["confirm_brand_variants", *next_actions]
    else:
        next_actions = [
            "offer_site_and_target_page_audit",
            "run_site_audit_if_user_approves",
            "run_target_page_llm_access_audit_if_user_approves_or_record_explicit_decline",
            "then_collect_topic_and_semantic_cluster",
        ]

    return observation(
        "success",
        "Project context saved.",
        items=[context],
        evidence_refs=[str(report_path), str(root / DATA_REL / "project_context.json")],
        next_valid_actions=next_actions,
    )


def split_csv(value: str) -> list[str]:
    value = repair_text_encoding(value or "")
    normalized = value.replace("\r\n", "\n").replace("\r", "\n").replace(";", "\n")
    if "\n" in normalized:
        return [x.strip() for x in normalized.split("\n") if x.strip()]
    return [x.strip() for x in normalized.split(",") if x.strip()]


def dedupe_queries(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        cleaned = normalize_ws(repair_text_encoding(str(value or "")))
        key = cleaned.casefold()
        if cleaned and key not in seen:
            seen.add(key)
            out.append(cleaned)
    return out



def dedupe_terms(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        cleaned = normalize_ws(repair_text_encoding(str(value or "")))
        key = cleaned.casefold()
        if cleaned and key not in seen:
            seen.add(key)
            out.append(cleaned)
    return out


def split_camel_case(value: str) -> str:
    chars: list[str] = []
    for index, char in enumerate(value or ""):
        if index and char.isupper() and value[index - 1].islower():
            chars.append(" ")
        chars.append(char)
    return normalize_ws("".join(chars))


def propose_brand_variants(brand: str = "", domain: str = "", products_services: list[str] | None = None) -> list[str]:
    values: list[str] = []
    brand_clean = normalize_ws(repair_text_encoding(brand or ""))
    domain_clean = normalize_domain(domain or "")
    if brand_clean:
        values.append(brand_clean)
        compact = re.sub(r"[\s\-_]+", "", brand_clean)
        if compact and compact.casefold() != brand_clean.casefold():
            values.append(compact)
        spaced = split_camel_case(brand_clean)
        if spaced and spaced.casefold() != brand_clean.casefold():
            values.append(spaced)
    if domain_clean:
        values.append(domain_clean)
        stem = domain_clean.split(".", 1)[0]
        if stem and stem != domain_clean:
            values.append(stem)
    for product in products_services or []:
        cleaned = normalize_ws(repair_text_encoding(product or ""))
        if cleaned:
            values.append(cleaned)
    return dedupe_terms(values)


def apply_brand_variants(config: dict[str, Any], explicit_variants: str = "") -> None:
    project = config.get("project", {})
    explicit = dedupe_terms(split_csv(explicit_variants))
    proposed = propose_brand_variants(project.get("brand", ""), project.get("domain", ""), project.get("products_services", []))
    if explicit:
        proposed_or_user_values = dedupe_terms([project.get("brand", ""), *explicit])
        previous_confirmed = dedupe_terms(project.get("brand_variants", [])) if project.get("brand_variants_status") == "confirmed" else []
        project["brand_variants"] = proposed_or_user_values
        if previous_confirmed and previous_confirmed == proposed_or_user_values:
            project["brand_variants_status"] = "confirmed"
            project["brand_variants_source"] = "confirmed_unchanged"
        else:
            project["brand_variants_status"] = "needs_user_confirmation"
            project["brand_variants_source"] = "user_supplied_pending_confirmation"
            project.pop("brand_variants_confirmed_at", None)
            project.pop("brand_variants_confirmation", None)
    elif project.get("brand_variants") and project.get("brand_variants_status") == "confirmed":
        project["brand_variants"] = dedupe_terms(project.get("brand_variants", []))
    else:
        project["brand_variants"] = proposed
        project["brand_variants_status"] = "needs_user_confirmation" if proposed else "missing"
        project["brand_variants_source"] = "agent_proposed" if proposed else "not_provided"
        project.pop("brand_variants_confirmed_at", None)



def confirm_brand_variants(
    project_dir: Path,
    brand_variants: str = "",
    confirmation_ref: str = "",
    confirmed_by: str = "",
) -> dict[str, Any]:
    root = find_project_root(project_dir)
    ensure_dirs(root)
    config = load_config(root)
    project = config.get("project", {})
    proposed = dedupe_terms(split_csv(brand_variants)) if brand_variants else dedupe_terms(project.get("brand_variants", []))
    values = dedupe_terms([project.get("brand", ""), *proposed])
    confirmation_ref = repair_text_encoding(confirmation_ref)
    confirmed_by = repair_text_encoding(confirmed_by)
    if not values:
        return observation("blocked", "Brand variant confirmation requires at least one brand spelling.", next_valid_actions=["provide_brand_variants"])
    if len(confirmation_ref) < 6 or len(confirmed_by) < 2:
        return observation("blocked", "Brand variant confirmation requires --confirmation-ref and --confirmed-by so the evidence is auditable.", next_valid_actions=["record_explicit_brand_confirmation"])
    variant_hash = hashlib.sha256(json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    project["brand_variants"] = values
    project["brand_variants_status"] = "confirmed"
    project["brand_variants_source"] = "explicit_user_confirmation"
    project["brand_variants_confirmed_at"] = utc_now()
    project["brand_variants_confirmation"] = {
        "variants_sha256": variant_hash,
        "confirmation_ref": confirmation_ref,
        "confirmed_by": confirmed_by,
        "confirmed_at": project["brand_variants_confirmed_at"],
    }
    save_config(root, config)
    # Recompute the persisted context gate after confirmation without accepting topic input.
    init_project_context(root)
    context_path = root / DATA_REL / "project_context.json"
    context = read_json(context_path, {})
    if isinstance(context, dict):
        context["brand_variants"] = values
        context["brand_variants_status"] = "confirmed"
        context["brand_variants_confirmation_required"] = False
        context["brand_variants_confirmation"] = project["brand_variants_confirmation"]
        context["updated_at"] = utc_now()
        write_json(context_path, context)
    report_path = root / REPORTS_REL / "BRAND_VARIANTS_CONFIRMATION.md"
    write_text(report_path, "# BRAND_VARIANTS_CONFIRMATION\n\n- status: confirmed\n- variants_sha256: `" + variant_hash + "`\n- confirmation_ref: " + confirmation_ref + "\n- confirmed_by: " + confirmed_by + "\n\n## Confirmed Variants\n" + markdown_list(values))
    update_state(root, "Brand variants explicitly confirmed", [str(report_path), str(context_path)])
    return observation("success", "Brand variants confirmed with a hash-bound user record.", items=[project["brand_variants_confirmation"]], evidence_refs=[str(report_path), str(context_path)], next_valid_actions=["collect_or_review_deep_project_context"])

def brand_variants_from_config(config: dict[str, Any], brand: str = "", products: list[str] | None = None) -> list[str]:
    project = config.get("project", {}) if isinstance(config, dict) else {}
    values: list[str] = []
    values.append(brand or project.get("brand", ""))
    raw_variants = project.get("brand_variants", [])
    if isinstance(raw_variants, str):
        values.extend(split_csv(raw_variants))
    elif isinstance(raw_variants, list):
        values.extend(str(value) for value in raw_variants)
    values.extend(project.get("products_services", []))
    values.extend(products or [])
    return dedupe_terms(values)

def raw_semantic_cluster_values(source: dict[str, Any]) -> list[str]:
    values = source.get("semantic_cluster_queries", []) if isinstance(source, dict) else []
    if isinstance(values, str):
        return dedupe_queries(split_csv(values))
    if isinstance(values, list):
        return dedupe_queries([str(value) for value in values])
    return []


def semantic_cluster_topic_key(topic: str) -> str:
    return slugify(repair_text_encoding(topic or ""))


def semantic_cluster_meta(source: dict[str, Any], topic: str = "") -> dict[str, Any]:
    values = raw_semantic_cluster_values(source)
    stored_topic = str(source.get("semantic_cluster_topic") or "") if isinstance(source, dict) else ""
    if not stored_topic and isinstance(source, dict):
        priority = source.get("priority_topics", [])
        if isinstance(priority, list) and priority:
            stored_topic = str(priority[0] or "")
        elif isinstance(priority, str):
            stored_topic = priority
    status = str(source.get("semantic_cluster_status") or ("confirmed" if values else "missing")) if isinstance(source, dict) else "missing"
    source_label = str(source.get("semantic_cluster_source") or ("legacy_config" if values else "not_provided")) if isinstance(source, dict) else "not_provided"
    topic_match = True
    if topic and stored_topic:
        topic_match = semantic_cluster_topic_key(topic) == semantic_cluster_topic_key(stored_topic)
    confirmed_statuses = {"confirmed", "user_supplied", "approved", "approved_agent_draft", "legacy_config"}
    confirmed = bool(values) and topic_match and status in confirmed_statuses
    return {
        "semantic_cluster_topic": stored_topic,
        "semantic_cluster_status": status,
        "semantic_cluster_source": source_label,
        "semantic_cluster_topic_match": topic_match,
        "semantic_cluster_confirmed": confirmed,
        "semantic_cluster_query_count": len(values) if confirmed else 0,
    }


def configured_semantic_cluster_queries(config: dict[str, Any], topic: str = "") -> list[str]:
    project = config.get("project", {}) if isinstance(config, dict) else {}
    meta = semantic_cluster_meta(project, topic)
    if not meta.get("semantic_cluster_confirmed"):
        return []
    return raw_semantic_cluster_values(project)


def project_context_semantic_cluster_queries(root: Path, topic: str = "") -> list[str]:
    context = read_json(root / DATA_REL / "project_context.json", {})
    meta = semantic_cluster_meta(context, topic)
    if not meta.get("semantic_cluster_confirmed"):
        return []
    return raw_semantic_cluster_values(context)


def explicit_semantic_cluster_queries(cluster_queries: str = "", cluster_queries_file: str = "", seed_queries: str = "") -> list[str]:
    values: list[str] = []
    values.extend(split_csv(cluster_queries))
    values.extend(read_query_file(cluster_queries_file))
    if not values and seed_queries:
        values.extend(split_csv(seed_queries))
    return dedupe_queries(values)


def resolve_semantic_cluster_queries(
    root: Path,
    topic: str = "",
    cluster_queries: str = "",
    cluster_queries_file: str = "",
    seed_queries: str = "",
    config: dict[str, Any] | None = None,
) -> list[str]:
    values = explicit_semantic_cluster_queries(cluster_queries, cluster_queries_file, seed_queries)
    if not values and config:
        values.extend(configured_semantic_cluster_queries(config, topic))
    if not values:
        values.extend(project_context_semantic_cluster_queries(root, topic))
    return dedupe_queries(values)

def semantic_cluster_rows(topic: str, queries: list[str]) -> list[dict[str, Any]]:
    return [
        {"source_order": idx, "topic": topic, "query": query, "source": "semantic_cluster_query"}
        for idx, query in enumerate(dedupe_queries(queries), start=1)
    ]


def build_context_assumptions(config: dict[str, Any], topic: str) -> list[str]:
    assumptions = []
    if not config["project"].get("domain"):
        assumptions.append("Domain was not provided.")
    if not config["project"].get("brand"):
        assumptions.append("Brand was not provided.")
    if config["project"].get("brand_variants_status") != "confirmed":
        assumptions.append("Brand variants are not confirmed. Ask the user to confirm or edit all brand spellings, aliases, transliterations, domain spellings, and product-name aliases before citation visibility or monitoring work.")
    if not topic:
        assumptions.append("Topic was not provided.")
    if topic and not configured_semantic_cluster_queries(config, topic):
        assumptions.append("Semantic cluster queries were not provided or confirmed for this topic. Ask the user for the query cluster; if the user asks the agent to draft one, present it as a pending draft and wait for approval before SERP, AI citation, QFO, TZ, placement, visibility, or monitoring work.")
    if not config["project"].get("documents") and not config["project"].get("site_discovery_approved"):
        assumptions.append("No project documents were provided and public site discovery was not approved yet.")
    if not assumptions:
        assumptions.append("No major missing project context fields detected.")
    return assumptions


def build_project_context_report(context: dict[str, Any]) -> str:
    site_context = context.get("site_context", {}) if isinstance(context.get("site_context"), dict) else {}
    return f"""# PROJECT_CONTEXT

Generated: {utc_now()}

## Project

- Domain: {context.get('domain') or 'not provided'}
- Brand: {context.get('brand') or 'not provided'}
- Brand variants status: {context.get('brand_variants_status') or 'missing'}
- Brand variants confirmation required: {context.get('brand_variants_confirmation_required', True)}
- Topic: {context.get('topic') or 'not provided'}
- Goal: {context.get('target_goal')}
- Language: {context.get('language')}
- Region: {context.get('region', {}).get('country')}-{context.get('region', {}).get('city')}
- Search engines: {', '.join(context.get('search_engines', [])) or 'none'}

## Brand Variants For AI-Answer Mention Tracking

The agent must ask the user to confirm or edit all brand spellings before citation visibility and monitoring. Suggested variants are only a draft until confirmed.

{markdown_list(context.get('brand_variants', []))}
## Semantic Cluster Queries

- Status: {context.get('semantic_cluster_status') or 'missing'}
- Source: {context.get('semantic_cluster_source') or 'not_provided'}
- Topic binding: {context.get('semantic_cluster_topic') or context.get('topic') or 'not provided'}
- Confirmation required: {context.get('semantic_cluster_confirmation_required', True)}

Only confirmed user-supplied or user-approved semantic cluster queries may be used as SERP/AI collection seeds; QFO planning must use AI-cited title semantics plus optional user-supplied ChatGPT QFO context. A bare topic is not a query cluster. Agent-drafted semantics are only a pending user approval proposal until the user approves or edits them.

{markdown_list(context.get('semantic_cluster_queries', []))}
## Context Boundary

This report is product and business context. It does not perform robots.txt checks, sitemap checks, user-agent probing, WAF/anti-bot diagnosis, or server accessibility audit. Run `audit-access` or `llm-access-audit` only as a separate explicit step.

## Products / Services

{markdown_list(context.get('products_services', []))}

## Competitors

{markdown_list(context.get('competitors', []))}

## Site Pages

{markdown_list(context.get('site_pages', []))}

## Documents / Data Sources

{markdown_list(context.get('documents', []))}

## Site Context Brief

{format_context_brief(site_context)}

## Context Pages Reviewed

{format_context_pages(site_context.get('pages', []))}

## Open Context Questions

{markdown_list(site_context.get('open_questions', []))}

## Context Acquisition

- site discovery approved: {context.get('site_discovery_approved', False)}
- notes: {context.get('context_notes') or 'none'}
- accessibility audit separate: {context.get('context_acquisition', {}).get('accessibility_audit_separate', True)}
- deep context collection status: {context.get('context_acquisition', {}).get('deep_context_collection_status', 'not_collected')}
- deep context offer required: {context.get('context_acquisition', {}).get('deep_context_offer_required', False)}
- recommended deep context max pages: {context.get('context_acquisition', {}).get('recommended_deep_context_max_pages', 30)}
- recommended deep context command: {context.get('context_acquisition', {}).get('recommended_deep_context_command') or 'not available'}

## Assumptions

{markdown_list(context.get('assumptions', []))}
"""


CONTEXT_COMMERCIAL_KEYWORDS = {
    "pricing": ["price", "pricing", "plans", "tariff", "cost", "\u0446\u0435\u043d\u0430", "\u0441\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c", "\u0442\u0430\u0440\u0438\u0444", "\u0442\u0430\u0440\u0438\u0444\u044b", "\u043f\u0440\u0430\u0439\u0441"],
    "contacts": ["contact", "contacts", "phone", "email", "address", "\u043a\u043e\u043d\u0442\u0430\u043a\u0442", "\u043a\u043e\u043d\u0442\u0430\u043a\u0442\u044b", "\u0442\u0435\u043b\u0435\u0444\u043e\u043d", "\u0430\u0434\u0440\u0435\u0441"],
    "about": ["about", "company", "team", "mission", "\u043e \u043a\u043e\u043c\u043f\u0430\u043d\u0438\u0438", "\u043e \u043d\u0430\u0441", "\u043a\u043e\u043c\u0430\u043d\u0434\u0430"],
    "trial_demo": ["trial", "demo", "free", "\u0442\u0440\u0438\u0430\u043b", "\u0434\u0435\u043c\u043e", "\u0431\u0435\u0441\u043f\u043b\u0430\u0442\u043d\u043e", "\u043f\u0440\u043e\u0431\u043d\u044b\u0439"],
    "delivery": ["delivery", "shipping", "\u0434\u043e\u0441\u0442\u0430\u0432\u043a\u0430", "\u043e\u0442\u0433\u0440\u0443\u0437\u043a\u0430", "\u0441\u0434\u044d\u043a"],
    "payment": ["payment", "pay", "billing", "\u043e\u043f\u043b\u0430\u0442\u0430", "\u0441\u0447\u0435\u0442", "\u043a\u0430\u0440\u0442\u0430", "\u0440\u0430\u0441\u0441\u0440\u043e\u0447\u043a\u0430"],
    "product": ["product", "service", "solution", "course", "tool", "\u043f\u0440\u043e\u0434\u0443\u043a\u0442", "\u0443\u0441\u043b\u0443\u0433\u0430", "\u0441\u0435\u0440\u0432\u0438\u0441", "\u043a\u0443\u0440\u0441", "\u0438\u043d\u0441\u0442\u0440\u0443\u043c\u0435\u043d\u0442"],
    "trust": ["case", "review", "testimonial", "license", "certificate", "\u043e\u0442\u0437\u044b\u0432", "\u043a\u0435\u0439\u0441", "\u0441\u043c\u0438", "\u043b\u0438\u0446\u0435\u043d\u0437\u0438\u044f", "\u0441\u0435\u0440\u0442\u0438\u0444\u0438\u043a\u0430\u0442"],
    "limitations": ["limit", "restriction", "terms", "policy", "refund", "\u043b\u0438\u043c\u0438\u0442", "\u043e\u0433\u0440\u0430\u043d\u0438\u0447\u0435\u043d\u0438\u0435", "\u0443\u0441\u043b\u043e\u0432\u0438\u044f", "\u0432\u043e\u0437\u0432\u0440\u0430\u0442"],
}

CONTEXT_CTA_KEYWORDS = ["buy", "start", "try", "demo", "register", "sign up", "book", "contact", "order", "\u043a\u0443\u043f\u0438\u0442\u044c", "\u043d\u0430\u0447\u0430\u0442\u044c", "\u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043e\u0432\u0430\u0442\u044c\u0441\u044f", "\u043e\u0441\u0442\u0430\u0432\u0438\u0442\u044c", "\u0437\u0430\u043a\u0430\u0437\u0430\u0442\u044c", "\u043e\u043f\u043b\u0430\u0442\u0438\u0442\u044c", "\u043f\u043e\u043b\u0443\u0447\u0438\u0442\u044c \u0434\u0435\u043c\u043e", "\u0437\u0430\u043f\u0438\u0441\u0430\u0442\u044c\u0441\u044f"]

CONTEXT_NOT_APPLICABLE_SCHEMA_VERSION = "geo-topic-agent.context-not-applicable.v1"
CONTEXT_NOT_APPLICABLE_ALLOWED_FIELDS = frozenset({
    "pricing_payment_evidence", "limitations_evidence", "conversion_actions",
})
CONTEXT_NOT_APPLICABLE_NON_WAIVABLE_FIELDS = frozenset({
    "homepage", "multiple_important_pages", "brand_surface", "value_proposition",
    "product_mechanics", "brand_variants",
})
_CONTEXT_QUESTION_FIELD_PREFIXES = {
    "pricing/payment model": "pricing_payment_evidence",
    "limitations, terms, geography": "limitations_evidence",
    "at least one concrete conversion action": "conversion_actions",
}
_DECISION_PLACEHOLDERS = frozenset({
    "", "-", "n/a", "na", "none", "null", "unknown", "tbd", "todo", "pending",
    "not applicable", "not_applicable", "user", "admin", "agent", "system", "cli_operator",
})


def _is_decision_placeholder(value: Any) -> bool:
    if not isinstance(value, str):
        return True
    text = value.strip()
    lowered = text.casefold()
    return (
        lowered in _DECISION_PLACEHOLDERS
        or (text.startswith("<") and text.endswith(">"))
        or "placeholder" in lowered
        or "<user" in lowered
        or "<reviewer" in lowered
        or "<why" in lowered
    )


def _parse_approved_at(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or _is_decision_placeholder(value):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None and parsed.utcoffset() is not None else None


def _durable_decision_rows(config: dict[str, Any], project_context: dict[str, Any], key: str) -> list[tuple[str, int, Any]]:
    rows: list[tuple[str, int, Any]] = []
    sources = [
        (f"{CONFIG_REL.as_posix()}#project.{key}", config.get("project", {}).get(key, [])),
        (f"{(DATA_REL / 'project_context.json').as_posix()}#{key}", project_context.get(key, [])),
    ]
    for source, raw in sources:
        if raw in (None, [], {}):
            continue
        if not isinstance(raw, list):
            rows.append((source, 0, raw))
        else:
            rows.extend((source, index, item) for index, item in enumerate(raw))
    return rows


def evaluate_context_not_applicable_decisions(config: dict[str, Any], project_context: dict[str, Any]) -> dict[str, Any]:
    valid_candidates: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for source, index, raw in _durable_decision_rows(config, project_context, "context_not_applicable_decisions"):
        reasons: list[str] = []
        if not isinstance(raw, dict):
            reasons.append("record_must_be_object")
            raw = {}
        field = repair_text_encoding(str(raw.get("field", "")).strip())
        decision = repair_text_encoding(str(raw.get("decision", "")).strip()).casefold()
        reason = repair_text_encoding(str(raw.get("reason", "")).strip())
        approved_by = repair_text_encoding(str(raw.get("approved_by", "")).strip())
        approval_ref = repair_text_encoding(str(raw.get("approval_ref", "")).strip())
        approved_at = repair_text_encoding(str(raw.get("approved_at", "")).strip())
        parsed_at = _parse_approved_at(approved_at)
        if field not in CONTEXT_NOT_APPLICABLE_ALLOWED_FIELDS:
            reasons.append("field_not_allowed_or_non_waivable")
        if decision != "not_applicable":
            reasons.append("decision_must_equal_not_applicable")
        if len(reason) < 20 or _is_decision_placeholder(reason):
            reasons.append("reason_missing_too_short_or_placeholder")
        if len(approved_by) < 2 or _is_decision_placeholder(approved_by):
            reasons.append("approved_by_missing_or_placeholder")
        if len(approval_ref) < 6 or _is_decision_placeholder(approval_ref):
            reasons.append("approval_ref_missing_or_placeholder")
        if parsed_at is None:
            reasons.append("approved_at_must_be_timezone_aware_iso8601")
        normalized = {
            "schema_version": CONTEXT_NOT_APPLICABLE_SCHEMA_VERSION,
            "field": field, "decision": decision, "reason": reason,
            "approved_by": approved_by, "approval_ref": approval_ref, "approved_at": approved_at,
            "source": source, "source_index": index,
        }
        if reasons:
            rejected.append({**normalized, "rejection_reasons": reasons})
        else:
            normalized["_approved_at_sort"] = parsed_at.timestamp()
            valid_candidates.append(normalized)
    selected: dict[str, dict[str, Any]] = {}
    for row in sorted(valid_candidates, key=lambda item: (item["_approved_at_sort"], item["source"], item["source_index"])):
        previous = selected.get(row["field"])
        if previous:
            rejected.append({
                **{key: value for key, value in previous.items() if not key.startswith("_")},
                "rejection_reasons": ["superseded_by_later_valid_decision"],
            })
        selected[row["field"]] = row
    accepted = [
        {key: value for key, value in selected[field].items() if not key.startswith("_")}
        for field in sorted(selected)
    ]
    return {
        "schema_version": CONTEXT_NOT_APPLICABLE_SCHEMA_VERSION,
        "allowed_fields": sorted(CONTEXT_NOT_APPLICABLE_ALLOWED_FIELDS),
        "non_waivable_fields": sorted(CONTEXT_NOT_APPLICABLE_NON_WAIVABLE_FIELDS),
        "accepted_fields": [row["field"] for row in accepted],
        "accepted_decisions": accepted,
        "rejected_decisions": rejected,
    }


def apply_context_not_applicable_decisions(site_context: dict[str, Any], evaluation: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(site_context, dict) or not site_context:
        return site_context
    resolved = json.loads(json.dumps(site_context, ensure_ascii=False))
    gate = resolved.get("quality_gate", {}) if isinstance(resolved.get("quality_gate"), dict) else {}
    checks = gate.get("checks", []) if isinstance(gate.get("checks"), list) else []
    accepted_by_field = {
        row["field"]: row for row in evaluation.get("accepted_decisions", [])
        if isinstance(row, dict) and row.get("field")
    }
    applied_fields: list[str] = []
    normalized_checks: list[dict[str, Any]] = []
    for raw_check in checks:
        if not isinstance(raw_check, dict):
            continue
        check = dict(raw_check)
        evidence_passed = check.get("evidence_passed")
        if not isinstance(evidence_passed, bool):
            evidence_passed = bool(check.get("passed")) and check.get("resolution") != "explicit_not_applicable"
        check["evidence_passed"] = evidence_passed
        check["passed"] = evidence_passed
        check["resolution"] = "evidence" if evidence_passed else "missing"
        check.pop("not_applicable_decision", None)
        field = str(check.get("id", ""))
        if not evidence_passed and field in accepted_by_field:
            check["passed"] = True
            check["resolution"] = "explicit_not_applicable"
            check["not_applicable_decision"] = accepted_by_field[field]
            applied_fields.append(field)
        normalized_checks.append(check)
    blocking_checks = [check for check in normalized_checks if check.get("critical") and not check.get("passed")]
    collection_status = resolved.get("collection_status")
    if not collection_status:
        collection_status = "success" if resolved.get("status") in {"success", "quality_fail"} and resolved.get("pages") else resolved.get("status")
    open_questions: list[str] = []
    for question in resolved.get("open_questions", []):
        question_text = str(question)
        lowered = question_text.casefold()
        field = next((value for prefix, value in _CONTEXT_QUESTION_FIELD_PREFIXES.items() if lowered.startswith(prefix)), "")
        if field and field in applied_fields:
            continue
        if question_text and not question_text.startswith("No major product-context questions"):
            open_questions.append(question_text)
    errors = [str(error) for error in resolved.get("errors", []) if not str(error).startswith("context quality gate failed:")]
    errors.extend(f"context quality gate failed: {check.get('id')} - {check.get('detail', '')}" for check in blocking_checks)
    passed = collection_status == "success" and not blocking_checks
    resolved["collection_status"] = collection_status
    resolved["status"] = "success" if passed else ("quality_fail" if collection_status == "success" else collection_status)
    if passed and applied_fields:
        resolved["summary"] = "Site context quality gate passed with explicit user-approved not-applicable decisions for: " + ", ".join(sorted(applied_fields)) + "."
    elif collection_status == "success" and blocking_checks:
        resolved["summary"] = "Site pages were collected, but mandatory context fields remain unresolved. Provide evidence or valid explicit not-applicable decisions."
    resolved["quality_gate"] = {
        **gate,
        "status": "pass" if passed else "fail",
        "checks": normalized_checks,
        "blocking_check_ids": [str(check.get("id", "")) for check in blocking_checks],
        "missing_context_fields": [str(check.get("id", "")) for check in blocking_checks],
        "not_applicable_schema_version": evaluation.get("schema_version"),
        "not_applicable_allowed_fields": evaluation.get("allowed_fields", []),
        "not_applicable_non_waivable_fields": evaluation.get("non_waivable_fields", []),
        "accepted_not_applicable_fields": evaluation.get("accepted_fields", []),
        "accepted_not_applicable_decisions": evaluation.get("accepted_decisions", []),
        "rejected_not_applicable_decisions": evaluation.get("rejected_decisions", []),
        "applied_not_applicable_fields": sorted(set(applied_fields)),
    }
    resolved["open_questions"] = open_questions or ["No major product-context questions detected from collected pages."]
    resolved["errors"] = errors
    return resolved


def _validate_audit_decision(raw: Any, source: str, audit_id: str) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    reasons: list[str] = []
    if not isinstance(raw, dict):
        reasons.append("record_must_be_object")
        raw = {}
    decision = repair_text_encoding(str(raw.get("decision", "")).strip()).casefold()
    reason = repair_text_encoding(str(raw.get("reason", "")).strip())
    decided_by = repair_text_encoding(str(raw.get("decided_by", "")).strip())
    decision_ref = repair_text_encoding(str(raw.get("decision_ref", "")).strip())
    decided_at = repair_text_encoding(str(raw.get("decided_at", "")).strip())
    if decision not in {"declined", "blocked"}:
        reasons.append("decision_must_be_declined_or_blocked")
    if len(reason) < 12 or _is_decision_placeholder(reason):
        reasons.append("reason_missing_too_short_or_placeholder")
    if len(decided_by) < 2 or _is_decision_placeholder(decided_by):
        reasons.append("decided_by_missing_or_placeholder")
    if len(decision_ref) < 6 or _is_decision_placeholder(decision_ref):
        reasons.append("decision_ref_missing_or_placeholder")
    parsed_at = _parse_approved_at(decided_at)
    if parsed_at is None:
        reasons.append("decided_at_must_be_timezone_aware_iso8601")
    normalized = {
        "audit_id": audit_id, "decision": decision, "reason": reason,
        "decided_by": decided_by, "decision_ref": decision_ref, "decided_at": decided_at,
        "source": source,
    }
    if reasons:
        return None, {**normalized, "rejection_reasons": reasons}
    normalized["_decided_at_sort"] = parsed_at.timestamp()
    return normalized, None


def evaluate_pre_topic_audit_gate(root: Path, config: dict[str, Any], project_context: dict[str, Any]) -> dict[str, Any]:
    audit_ids = {
        "site_accessibility": root / PROCESSED_REL / "accessibility_audit.json",
        "target_page_llm_accessibility": root / PROCESSED_REL / "llm_accessibility_audit.json",
    }
    accepted: dict[str, dict[str, Any]] = {}
    rejected: list[dict[str, Any]] = []
    for source, raw_decisions in [
        (f"{CONFIG_REL.as_posix()}#project.audit_decisions", config.get("project", {}).get("audit_decisions", {})),
        (f"{(DATA_REL / 'project_context.json').as_posix()}#audit_decisions", project_context.get("audit_decisions", {})),
    ]:
        if raw_decisions in (None, {}):
            continue
        if not isinstance(raw_decisions, dict):
            rejected.append({"source": source, "rejection_reasons": ["audit_decisions_must_be_object"]})
            continue
        for audit_id, raw in raw_decisions.items():
            if audit_id not in audit_ids:
                rejected.append({"source": source, "audit_id": str(audit_id), "rejection_reasons": ["unknown_audit_id"]})
                continue
            valid, invalid = _validate_audit_decision(raw, source, audit_id)
            if invalid:
                rejected.append(invalid)
            elif valid:
                previous = accepted.get(audit_id)
                if not previous or previous["_decided_at_sort"] <= valid["_decided_at_sort"]:
                    accepted[audit_id] = valid
    decisions: dict[str, Any] = {}
    for audit_id, artifact_path in audit_ids.items():
        payload = read_json(artifact_path, {})
        artifact_completed = bool(payload) and payload.get("network_approved") is True
        explicit = accepted.get(audit_id)
        if artifact_completed:
            decisions[audit_id] = {"status": "completed", "evidence_ref": portable_ref(root, artifact_path)}
        elif explicit:
            decisions[audit_id] = {key: value for key, value in explicit.items() if not key.startswith("_")}
            decisions[audit_id]["status"] = explicit["decision"]
        else:
            decisions[audit_id] = {"status": "pending", "evidence_ref": portable_ref(root, artifact_path) if artifact_path.exists() else ""}
    pending = [audit_id for audit_id, decision in decisions.items() if decision.get("status") == "pending"]
    return {"status": "pass" if not pending else "fail", "decisions": decisions, "pending_audit_ids": pending, "rejected_decisions": rejected}


def full_workflow_prerequisite_gate(root: Path) -> dict[str, Any]:
    """Read-only gate for actions that belong only to the full project workflow."""
    config = load_config(root)
    project_context = read_json(root / DATA_REL / "project_context.json", {})
    not_applicable = evaluate_context_not_applicable_decisions(config, project_context)
    site_context = project_context.get("site_context", {}) if isinstance(project_context, dict) else {}
    if not isinstance(site_context, dict):
        site_context = {}
    site_context = apply_context_not_applicable_decisions(site_context, not_applicable)
    quality_gate = site_context.get("quality_gate", {}) if isinstance(site_context.get("quality_gate"), dict) else {}
    material_questions = [
        str(question) for question in site_context.get("open_questions", [])
        if question and not str(question).startswith("No major product-context questions")
    ]
    brand_status = str(config.get("project", {}).get("brand_variants_status") or "missing")
    context_ready = (
        site_context.get("status") == "success"
        and quality_gate.get("status") == "pass"
        and not material_questions
        and brand_status == "confirmed"
    )
    audit_gate = evaluate_pre_topic_audit_gate(root, config, project_context)
    actions: list[str] = []
    if not context_ready:
        actions.extend(["complete_deep_project_context", "confirm_brand_variants"])
    if audit_gate.get("status") != "pass":
        actions.extend([
            "complete_or_record_site_accessibility_audit_decision",
            "complete_or_record_target_page_llm_accessibility_audit_decision",
        ])
    return {
        "status": "pass" if context_ready and audit_gate.get("status") == "pass" else "fail",
        "context_ready": context_ready,
        "brand_variants_status": brand_status,
        "site_context_status": site_context.get("status", "not_collected"),
        "material_open_questions": material_questions,
        "audit_gate": audit_gate,
        "next_valid_actions": unique_nonempty(actions),
    }


def record_audit_decision(
    project_dir: Path,
    audit_id: str,
    decision: str,
    reason: str,
    decided_by: str,
    decision_ref: str,
    decided_at: str = "",
) -> dict[str, Any]:
    root = find_project_root(project_dir)
    ensure_dirs(root)
    allowed = {"site_accessibility", "target_page_llm_accessibility"}
    if audit_id not in allowed:
        return observation("invalid_args", "Unknown audit_id.", items=[{"allowed_audit_ids": sorted(allowed)}], next_valid_actions=["use_site_accessibility_or_target_page_llm_accessibility"])
    raw = {
        "decision": decision,
        "reason": reason,
        "decided_by": decided_by,
        "decision_ref": decision_ref,
        "decided_at": decided_at or utc_now(),
    }
    valid, invalid = _validate_audit_decision(raw, "cli:record-audit-decision", audit_id)
    if invalid:
        return observation("invalid_args", "Audit decision record is invalid.", items=[invalid], next_valid_actions=["provide_complete_decision_record"])
    assert valid is not None
    config = load_config(root)
    decisions = config.setdefault("project", {}).setdefault("audit_decisions", {})
    decisions[audit_id] = {key: value for key, value in valid.items() if not key.startswith("_") and key != "source"}
    save_config(root, config)
    context_path = root / DATA_REL / "project_context.json"
    context = read_json(context_path, {})
    if not isinstance(context, dict):
        context = {}
    context.setdefault("audit_decisions", {})[audit_id] = decisions[audit_id]
    gate = evaluate_pre_topic_audit_gate(root, config, context)
    context["audit_decision_gate"] = gate
    context["updated_at"] = utc_now()
    write_json(context_path, context)
    report_path = root / REPORTS_REL / "AUDIT_DECISIONS.md"
    lines = ["# AUDIT_DECISIONS", "", "## Current Gate", "", f"- status: {gate.get('status')}", "", "## Decisions", ""]
    for key, value in sorted(gate.get("decisions", {}).items()):
        lines.append(f"- {key}: {value.get('status')} ({value.get('decision_ref') or value.get('evidence_ref') or ''})")
    write_text(report_path, "\n".join(lines) + "\n")
    update_state(root, f"Audit decision recorded: {audit_id}={decision}", [str(report_path), str(context_path)])
    return observation("success", "Audit decision recorded through the public CLI contract.", items=[gate], evidence_refs=[str(report_path), str(context_path)], next_valid_actions=["run_topic_after_both_audit_decisions_pass"] if gate.get("status") == "pass" else ["record_remaining_audit_decision"])

def collect_project_context(
    project_dir: Path,
    domain: str = "",
    brand: str = "",
    brand_variants: str = "",
    topic: str = "",
    region: str = "",
    language: str = "",
    engines: str = "",
    goal: str = "",
    competitors: str = "",
    pages: str = "",
    products_services: str = "",
    documents: str = "",
    allow_site_discovery: bool = False,
    context_notes: str = "",
    cluster_queries: str = "",
    cluster_queries_file: str = "",
    network_approved: bool = False,
    site_html_dir: str = "",
    max_pages: int = 30,
    timeout: int = 12,
) -> dict[str, Any]:
    root = find_project_root(project_dir)
    ensure_dirs(root)
    init_project_context(
        root,
        domain=domain,
        brand=brand,
        brand_variants=brand_variants,
        topic=topic,
        region=region,
        language=language,
        engines=engines,
        goal=goal,
        competitors=competitors,
        pages=pages,
        products_services=products_services,
        documents=documents,
        allow_site_discovery=allow_site_discovery or bool(site_html_dir) or network_approved,
        context_notes=context_notes,
        cluster_queries=cluster_queries,
        cluster_queries_file=cluster_queries_file,
    )
    config = load_config(root)
    domain = repair_text_encoding(domain or config["project"].get("domain", ""))
    topic = repair_text_encoding(topic or (config["project"].get("priority_topics", [""]) or [""])[0])
    language = repair_text_encoding(language or config.get("region", {}).get("language", "ru"))
    explicit_pages = split_csv(pages) or config["project"].get("site_pages", [])
    max_pages = max(1, min(30, int(max_pages or 30)))

    site_context: dict[str, Any]
    errors: list[str] = []
    if not domain and not site_html_dir:
        site_context = empty_site_context("blocked_missing_domain", "Domain or local HTML snapshot directory is required for site context collection.")
    elif site_html_dir:
        site_context = collect_context_from_html_dir(Path(site_html_dir), domain, explicit_pages, topic, language, max_pages)
    elif network_approved:
        site_context = collect_context_from_site(domain, explicit_pages, topic, language, max_pages, timeout)
    else:
        site_context = empty_site_context("blocked_no_network_approval", "Public site context collection requires --network-approved or --site-html-dir. No accessibility audit was run.")
        site_context["planned_pages"] = context_page_plan(domain, explicit_pages)
        errors.append("network approval missing for public site context collection")

    context_path = root / DATA_REL / "project_context.json"
    context = read_json(context_path, {})
    not_applicable_evaluation = evaluate_context_not_applicable_decisions(config, context)
    site_context = apply_context_not_applicable_decisions(site_context, not_applicable_evaluation)
    context["site_context"] = site_context
    site_status = site_context.get("status")
    brand_status = config.get("project", {}).get("brand_variants_status", "missing")
    brand_confirmed = brand_status == "confirmed"
    open_questions = [
        str(question)
        for question in site_context.get("open_questions", [])
        if question and not str(question).startswith("No major product-context questions")
    ]
    if site_status == "success" and brand_confirmed and not open_questions:
        status = "success"
    elif site_status in {"success", "quality_fail"}:
        status = "quality_fail"
    else:
        status = "blocked"
    site_gate = site_context.get("quality_gate", {}) if isinstance(site_context.get("quality_gate"), dict) else {}
    context["context_quality_gate"] = {
        "status": "pass" if status == "success" else "fail",
        "site_context_status": site_status,
        "brand_variants_status": brand_status,
        "brand_variants_confirmed": brand_confirmed,
        "brand_variants_waivable": False,
        "material_open_questions": open_questions,
        "missing_context_fields": site_gate.get("missing_context_fields", site_gate.get("blocking_check_ids", [])),
        "accepted_not_applicable_fields": not_applicable_evaluation.get("accepted_fields", []),
        "accepted_not_applicable_decisions": not_applicable_evaluation.get("accepted_decisions", []),
        "rejected_not_applicable_decisions": not_applicable_evaluation.get("rejected_decisions", []),
    }
    if not brand_confirmed:
        context["brand_variants_confirmation_required"] = True
    if not brand_confirmed:
        post_context_next_step = "confirm_brand_variants"
    elif status == "success":
        post_context_next_step = "offer_site_and_target_page_audit"
    else:
        post_context_next_step = "resolve_context_quality_gaps"
    context["context_acquisition"] = {
        **(context.get("context_acquisition", {}) if isinstance(context.get("context_acquisition"), dict) else {}),
        "site_discovery_approved": bool(allow_site_discovery or site_html_dir or network_approved),
        "network_approved": bool(network_approved),
        "site_html_dir": site_html_dir,
        "accessibility_audit_separate": True,
        "audit_access_was_not_run": True,
        "deep_context_collection_status": status,
        "deep_context_completed_at": utc_now() if status == "success" else "",
        "post_context_next_step": post_context_next_step,
    }
    context["assumptions"] = build_context_assumptions(config, topic)
    if status != "success":
        context["assumptions"].append(site_context.get("summary", "Site context was not fully collected."))
    if not brand_confirmed:
        context["assumptions"].append("Deep context remains lower-assurance until the user confirms all proposed brand variants.")
    write_json(context_path, context)

    rows = site_context.get("pages", []) if isinstance(site_context.get("pages"), list) else []
    pages_csv = root / PROCESSED_REL / "project_context_pages.csv"
    write_csv(pages_csv, rows)
    discovery_path = root / PROCESSED_REL / "project_context_site_discovery.json"
    write_json(discovery_path, site_context)
    report_path = root / REPORTS_REL / "PROJECT_CONTEXT.md"
    write_text(report_path, build_project_context_report(context))
    update_state(root, f"Project context collected for {domain or 'local snapshots'}", [str(report_path), str(discovery_path), str(pages_csv)])

    if not brand_confirmed:
        next_actions = [
            "confirm_brand_variants",
            "review_project_context",
            "resolve_material_context_questions",
            "retry_collect_project_context",
        ]
    elif status == "success":
        next_actions = [
            "review_project_context",
            "offer_site_and_target_page_audit",
            "run_site_audit_if_user_approves",
            "run_target_page_llm_access_audit_if_user_approves_or_record_explicit_decline",
            "then_collect_topic_and_semantic_cluster",
        ]
    else:
        next_actions = [
            "review_project_context",
            "provide_missing_pages_or_documents",
            "resolve_material_context_questions",
            "approve_public_site_discovery_or_local_snapshots",
            "retry_collect_project_context",
        ]

    return observation(
        status,
        "Project product context collected." if status == "success" else (
            "Project pages were collected, but the context quality gate failed."
            if status == "quality_fail"
            else "Project context scaffold saved; site context collection is blocked."
        ),
        items=[{"domain": domain, "pages_reviewed": len(rows), "status": status, "site_context_status": site_context.get("status"), "brand_variants_status": brand_status, "material_open_questions": open_questions, "missing_context_fields": site_gate.get("missing_context_fields", []), "accepted_not_applicable_fields": not_applicable_evaluation.get("accepted_fields", []), "rejected_not_applicable_decisions": not_applicable_evaluation.get("rejected_decisions", []), "accessibility_audit_run": False, "major_deliverable": status == "success", "attribution_notice_required": status == "success"}],
        evidence_refs=[str(report_path), str(context_path), str(discovery_path), str(pages_csv)],
        next_valid_actions=next_actions,
    )

def empty_site_context(status: str, summary: str) -> dict[str, Any]:
    return {
        "status": status,
        "summary": summary,
        "pages": [],
        "brief": {},
        "open_questions": [
            "What are the exact product/service names and packages?",
            "What is the primary conversion action?",
            "Which pages should be treated as money pages?",
        ],
        "generated_at": utc_now(),
    }


def context_page_plan(domain: str, explicit_pages: list[str]) -> list[str]:
    if not domain:
        return explicit_pages
    base = normalize_url(domain)
    planned = [base]
    for page in explicit_pages:
        planned.append(context_url_join(base, page))
    return dedupe(planned)


def collect_context_from_html_dir(site_html_dir: Path, domain: str, explicit_pages: list[str], topic: str, language: str, max_pages: int) -> dict[str, Any]:
    base = normalize_url(domain or "https://local-site.example")
    if not site_html_dir.exists():
        return empty_site_context("blocked_missing_html_dir", f"HTML snapshot directory not found: {site_html_dir}")
    html_files = [path for path in sorted(site_html_dir.rglob("*")) if path.is_file() and path.suffix.lower() in {".html", ".htm"}]
    pages = []
    for idx, file_path in enumerate(html_files[:max_pages], start=1):
        url = html_file_to_context_url(base, file_path, site_html_dir)
        source = "local_homepage" if file_path.stem.lower() in {"index", "home", "homepage"} else "local_snapshot"
        html_text = read_text_lossless(file_path)
        pages.append(extract_context_page(url, html_text, source, topic, language))
    if not pages:
        return empty_site_context("blocked_empty_html_dir", f"No .html files found in {site_html_dir}")
    return finalize_site_context("success", "Local HTML site context collected. No accessibility audit was run.", pages, [], topic, language)


def collect_context_from_site(domain: str, explicit_pages: list[str], topic: str, language: str, max_pages: int, timeout: int) -> dict[str, Any]:
    base = normalize_url(domain)
    fetched: list[dict[str, Any]] = []
    errors: list[str] = []
    homepage = fetch_site_context_html(base, timeout)
    if homepage.get("status") != "success":
        return empty_site_context("blocked_homepage_fetch_failed", homepage.get("summary", "Homepage fetch failed."))
    homepage_html = homepage.get("html", "")
    fetched.append(extract_context_page(base, homepage_html, "homepage", topic, language))
    links = discover_context_links(base, homepage_html, explicit_pages)
    for link in links:
        if len(fetched) >= max_pages:
            break
        url = link.get("url", "")
        if not url or any(row.get("url") == url for row in fetched):
            continue
        page = fetch_site_context_html(url, timeout)
        if page.get("status") != "success":
            errors.append(f"{url}: {page.get('summary')}")
            continue
        fetched.append(extract_context_page(url, page.get("html", ""), link.get("source", "discovered"), topic, language))
    return finalize_site_context("success", "Public site context collected with generic browser fetches. No robots, sitemap, user-agent, WAF, or accessibility audit was run.", fetched, errors, topic, language)


def fetch_site_context_html(url: str, timeout: int) -> dict[str, Any]:
    try:
        req = urllib.request.Request(normalize_url(url), headers={"User-Agent": "Mozilla/5.0 (compatible; GEO-ContextCollector/1.0; product-context)", "Accept": "text/html,application/xhtml+xml"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body, decoded_with = decode_text_bytes(resp.read(800000), resp.headers.get("content-type", ""), source=url)
            return {"status": "success", "summary": f"HTTP {resp.status}", "url": url, "html": body, "content_type": resp.headers.get("content-type", "")}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {"status": "error", "summary": f"{type(exc).__name__}: {exc}", "url": url, "html": ""}


def discover_context_links(base: str, homepage_html: str, explicit_pages: list[str]) -> list[dict[str, str]]:
    links: list[dict[str, str]] = []
    for page in explicit_pages:
        links.append({"url": context_url_join(base, page), "anchor": page, "source": "user_provided_page"})
    for section_name, section_html in extract_named_sections(homepage_html):
        for link in extract_links(section_html, base):
            link["source"] = section_name
            links.append(link)
    for link in extract_links(homepage_html, base):
        if is_commercial_context_link(link):
            link["source"] = link.get("source") or "commercial_link"
            links.append(link)
    out = []
    seen = set()
    base_host = urllib.parse.urlparse(base).netloc.lower().removeprefix("www.")
    for link in links:
        url = link.get("url", "")
        host = urllib.parse.urlparse(url).netloc.lower().removeprefix("www.")
        if not url or host != base_host or url in seen:
            continue
        seen.add(url)
        out.append(link)
    return out


def extract_named_sections(html_text: str) -> list[tuple[str, str]]:
    sections: list[tuple[str, str]] = []
    for tag, name in [("header", "header"), ("nav", "header_nav"), ("footer", "footer")]:
        for match in re.finditer(rf"<{tag}\b[^>]*>(.*?)</{tag}>", html_text or "", flags=re.IGNORECASE | re.DOTALL):
            sections.append((name, match.group(1)))
    return sections


def extract_links(html_text: str, base: str) -> list[dict[str, str]]:
    links = []
    for match in re.finditer(r"<a\b[^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", html_text or "", flags=re.IGNORECASE | re.DOTALL):
        href = html.unescape(match.group(1)).strip()
        if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
            continue
        anchor = normalize_ws(strip_tags(match.group(2)))
        links.append({"url": context_url_join(base, href), "anchor": anchor, "source": "link"})
    return links


def context_url_join(base: str, href: str) -> str:
    href = (href or "").strip()
    if href.startswith(("http://", "https://")):
        return href.split("#", 1)[0].rstrip("/")
    return urllib.parse.urljoin(base.rstrip("/") + "/", href).split("#", 1)[0].rstrip("/")


def html_file_to_context_url(base: str, file_path: Path, root: Path) -> str:
    rel = file_path.relative_to(root).with_suffix("").as_posix()
    if rel.lower() in {"index", "home", "homepage"}:
        return base.rstrip("/")
    return context_url_join(base, rel)


def is_commercial_context_link(link: dict[str, str]) -> bool:
    haystack = f"{link.get('anchor', '')} {link.get('url', '')}".lower()
    keywords = [word for words in CONTEXT_COMMERCIAL_KEYWORDS.values() for word in words]
    return any(word.lower() in haystack for word in keywords)


def extract_context_page(url: str, html_text: str, source: str, topic: str, language: str) -> dict[str, Any]:
    head_html = first_regex(html_text, r"<head[^>]*>(.*?)</head>")
    body_html = first_regex(html_text, r"<body[^>]*>(.*?)</body>") or html_text
    title = normalize_ws(strip_tags(first_regex(head_html or html_text, r"<title[^>]*>(.*?)</title>")))
    description = normalize_ws(first_regex(head_html or html_text, r"<meta[^>]+name=[\"']description[\"'][^>]+content=[\"']([^\"']+)[\"']") or first_regex(head_html or html_text, r"<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+name=[\"']description[\"']"))
    text = normalize_ws(strip_tags(body_html))
    headings = extract_headings(body_html)
    ctas = extract_ctas(body_html)
    page_type = classify_context_page(url, title, headings, text)
    signals = extract_context_signals(text)
    return {
        "url": url,
        "source": source,
        "page_type": page_type,
        "title": bounded_text(title, 180),
        "meta_description": bounded_text(description, 260),
        "h1": bounded_text(headings[0], 180) if headings else "",
        "headings": " | ".join(headings[:10]),
        "cta_texts": " | ".join(ctas[:8]),
        "text_chars": len(text),
        "value_snippets": " || ".join(signals.get("value", [])[:4]),
        "product_snippets": " || ".join(signals.get("product", [])[:4]),
        "pricing_payment_snippets": " || ".join((signals.get("pricing", []) + signals.get("payment", []))[:4]),
        "trial_delivery_snippets": " || ".join((signals.get("trial_demo", []) + signals.get("delivery", []))[:4]),
        "limitations_snippets": " || ".join(signals.get("limitations", [])[:4]),
        "trust_snippets": " || ".join(signals.get("trust", [])[:4]),
        "topic_mentions": count_topic_mentions(text, topic),
        "language": language,
        "status": "collected",
    }


def extract_headings(html_text: str) -> list[str]:
    headings = []
    for match in re.finditer(r"<h[1-3]\b[^>]*>(.*?)</h[1-3]>", html_text or "", flags=re.IGNORECASE | re.DOTALL):
        item = normalize_ws(strip_tags(match.group(1)))
        if item:
            headings.append(item)
    return dedupe(headings)[:20]


def extract_ctas(html_text: str) -> list[str]:
    candidates = []
    for pattern in [r"<a\b[^>]*>(.*?)</a>", r"<button\b[^>]*>(.*?)</button>"]:
        for match in re.finditer(pattern, html_text or "", flags=re.IGNORECASE | re.DOTALL):
            item = normalize_ws(strip_tags(match.group(1)))
            if item and any(keyword in item.lower() for keyword in CONTEXT_CTA_KEYWORDS):
                candidates.append(item)
    return dedupe(candidates)[:12]


def classify_context_page(url: str, title: str, headings: list[str], text: str) -> str:
    haystack = f"{url} {title} {' '.join(headings[:5])} {text[:1200]}".lower()
    if urllib.parse.urlparse(url).path in {"", "/"}:
        return "homepage"
    for category in ["pricing", "payment", "contacts", "about", "trial_demo", "delivery", "product", "trust", "limitations"]:
        if any(word.lower() in haystack for word in CONTEXT_COMMERCIAL_KEYWORDS[category]):
            return f"commercial_{category}" if category not in {"product", "trust", "limitations"} else category
    return "landing_or_content"


def extract_context_signals(text: str) -> dict[str, list[str]]:
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", text or "") if len(s.strip()) > 20]
    signals = {"value": [], "product": [], "pricing": [], "payment": [], "trial_demo": [], "delivery": [], "limitations": [], "trust": []}
    value_words = ["help", "solve", "without", "faster", "easy", "benefit", "\u043f\u043e\u043c\u043e\u0433\u0430\u0435\u0442", "\u0440\u0435\u0448\u0430\u0435\u0442", "\u0431\u0435\u0437", "\u0431\u044b\u0441\u0442\u0440\u0435\u0435", "\u0432\u044b\u0433\u043e\u0434\u0430", "\u043f\u043e\u043b\u044c\u0437\u0430", "\u0443\u0434\u043e\u0431\u043d\u043e"]
    for sentence in sentences[:300]:
        lower = sentence.lower()
        if any(word in lower for word in value_words):
            signals["value"].append(bounded_text(sentence, 240))
        for category, words in CONTEXT_COMMERCIAL_KEYWORDS.items():
            target = "product" if category == "product" else category
            if target in signals and any(word.lower() in lower for word in words):
                signals[target].append(bounded_text(sentence, 240))
    return {key: dedupe(value)[:8] for key, value in signals.items()}


def count_topic_mentions(text: str, topic: str) -> int:
    terms = [term.lower() for term in extract_title_terms(topic) if len(term) > 3]
    lower = (text or "").lower()
    return sum(lower.count(term) for term in terms)


def finalize_site_context(status: str, summary: str, pages: list[dict[str, Any]], errors: list[str], topic: str, language: str) -> dict[str, Any]:
    brief = build_site_context_brief(pages)
    open_questions = []
    if not brief.get("brand_surface"):
        open_questions.append("Brand naming evidence is not clear from collected pages.")
    if not brief.get("value_proposition_snippets"):
        open_questions.append("Value proposition/UTP is not clear from collected pages.")
    if not brief.get("product_snippets"):
        open_questions.append("Product/service mechanics are weakly visible; provide product docs or exact offer details.")
    if not brief.get("pricing_payment_snippets"):
        open_questions.append("Pricing/payment model is not clear from collected pages.")
    if not brief.get("limitations_snippets"):
        open_questions.append("Limitations, terms, geography, refund or delivery restrictions are not clear from collected pages.")
    if not brief.get("conversion_actions"):
        open_questions.append("At least one concrete conversion action is not clear from collected pages.")

    checks = [
        {
            "id": "homepage",
            "passed": any(page.get("page_type") == "homepage" for page in pages),
            "critical": True,
            "detail": "Homepage must be reviewed.",
        },
        {
            "id": "multiple_important_pages",
            "passed": len(pages) >= 2,
            "critical": True,
            "detail": "Homepage-only context is insufficient; review core landing/commercial pages.",
        },
        {
            "id": "brand_surface",
            "passed": bool(brief.get("brand_surface")),
            "critical": True,
            "detail": "Brand naming evidence is required.",
        },
        {
            "id": "value_proposition",
            "passed": bool(brief.get("value_proposition_snippets")),
            "critical": True,
            "detail": "Value proposition/UTP evidence is required.",
        },
        {
            "id": "product_mechanics",
            "passed": bool(brief.get("product_snippets")),
            "critical": True,
            "detail": "Product/service mechanics evidence is required.",
        },
        {
            "id": "pricing_payment_evidence",
            "passed": bool(brief.get("pricing_payment_snippets")),
            "critical": True,
            "detail": "Pricing/payment model must be evidenced or explicitly resolved by the user.",
        },
        {
            "id": "limitations_evidence",
            "passed": bool(brief.get("limitations_snippets")),
            "critical": True,
            "detail": "Limitations, terms, geography, refund or delivery constraints must be evidenced or explicitly resolved by the user.",
        },
        {
            "id": "conversion_actions",
            "passed": bool(brief.get("conversion_actions")),
            "critical": True,
            "detail": "At least one concrete conversion action must be evidenced.",
        },
    ]
    for check in checks:
        check["evidence_passed"] = bool(check["passed"])
        check["resolution"] = "evidence" if check["passed"] else "missing"
    blocking_checks = [check for check in checks if check["critical"] and not check["passed"]]
    effective_status = status
    if status == "success" and blocking_checks:
        effective_status = "quality_fail"
        errors = [
            *errors,
            *[f"context quality gate failed: {check['id']} - {check['detail']}" for check in blocking_checks],
        ]
        summary = (
            "Site pages were fetched, but the product context is not complete enough for downstream audit/topic work. "
            "Collect missing landing/commercial pages or documents."
        )
    return {
        "status": effective_status,
        "collection_status": status,
        "collection_summary": summary,
        "summary": summary,
        "topic": topic,
        "language": language,
        "pages": pages,
        "page_type_counts": count_values([page.get("page_type", "unknown") for page in pages]),
        "brief": brief,
        "quality_gate": {
            "status": "pass" if not blocking_checks and status == "success" else "fail",
            "checks": checks,
            "blocking_check_ids": [check["id"] for check in blocking_checks],
            "pages_reviewed": len(pages),
        },
        "open_questions": open_questions or ["No major product-context questions detected from collected pages."],
        "errors": errors,
        "accessibility_audit_run": False,
        "generated_at": utc_now(),
    }

def build_site_context_brief(pages: list[dict[str, Any]]) -> dict[str, Any]:
    def collect(field: str, limit: int = 8) -> list[str]:
        items: list[str] = []
        for page in pages:
            for part in str(page.get(field, "")).split("||"):
                part = part.strip()
                if part:
                    items.append(f"{page.get('page_type')}: {part}")
        return dedupe(items)[:limit]
    return {
        "brand_surface": dedupe([page.get("title", "") for page in pages if page.get("page_type") == "homepage"] + [page.get("h1", "") for page in pages if page.get("h1")])[:6],
        "value_proposition_snippets": collect("value_snippets"),
        "product_snippets": collect("product_snippets"),
        "pricing_payment_snippets": collect("pricing_payment_snippets"),
        "trial_delivery_snippets": collect("trial_delivery_snippets"),
        "limitations_snippets": collect("limitations_snippets"),
        "trust_snippets": collect("trust_snippets"),
        "conversion_actions": dedupe([cta for page in pages for cta in str(page.get("cta_texts", "")).split(" | ") if cta])[:10],
        "important_pages": [{"url": page.get("url"), "page_type": page.get("page_type"), "source": page.get("source")} for page in pages[:20]],
    }


def count_values(values: list[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    return counts


def format_context_brief(site_context: dict[str, Any]) -> str:
    if not site_context:
        return "- site context not collected yet"
    brief = site_context.get("brief", {}) if isinstance(site_context.get("brief"), dict) else {}
    lines = [
        f"- status: {site_context.get('status', 'not_collected')}",
        f"- summary: {site_context.get('summary', '')}",
        f"- accessibility audit run: {site_context.get('accessibility_audit_run', False)}",
        "",
        "### Brand Surface",
        markdown_list(brief.get("brand_surface", [])),
        "",
        "### Value Proposition / UTP Evidence",
        markdown_list(brief.get("value_proposition_snippets", [])),
        "",
        "### Product / Service Mechanics Evidence",
        markdown_list(brief.get("product_snippets", [])),
        "",
        "### Pricing / Payment Evidence",
        markdown_list(brief.get("pricing_payment_snippets", [])),
        "",
        "### Trial / Delivery Evidence",
        markdown_list(brief.get("trial_delivery_snippets", [])),
        "",
        "### Limitations / Terms Evidence",
        markdown_list(brief.get("limitations_snippets", [])),
        "",
        "### Trust / Proof Evidence",
        markdown_list(brief.get("trust_snippets", [])),
        "",
        "### Conversion Actions",
        markdown_list(brief.get("conversion_actions", [])),
    ]
    return "\n".join(lines)


def format_context_pages(pages: list[dict[str, Any]]) -> str:
    if not pages:
        return "- none"
    lines = ["| Page type | Source | URL | H1/title |", "|---|---|---|---|"]
    for page in pages[:30]:
        title = page.get("h1") or page.get("title") or ""
        lines.append(f"| {escape_md(str(page.get('page_type', '')))} | {escape_md(str(page.get('source', '')))} | {escape_md(str(page.get('url', '')))} | {escape_md(bounded_text(str(title), 90))} |")
    return "\n".join(lines)


def markdown_list(values: list[str]) -> str:
    if not values:
        return "- none"
    return "\n".join(f"- {value}" for value in values)


SITE_AUDIT_GENERIC_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)


def site_audit_user_agent_matrix() -> list[dict[str, str]]:
    return [
        {"id": "googlebot", "provider": "Google", "role": "Google Search crawl/render", "robots_token": "Googlebot", "http_user_agent": "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"},
        {"id": "bingbot", "provider": "Microsoft", "role": "Bing/Copilot search crawl", "robots_token": "bingbot", "http_user_agent": "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"},
        {"id": "yandexbot", "provider": "Yandex", "role": "Yandex main indexing", "robots_token": "YandexBot", "http_user_agent": "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)"},
        {"id": "openai_searchbot", "provider": "OpenAI", "role": "AI search indexing", "robots_token": "OAI-SearchBot", "http_user_agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot"},
        {"id": "chatgpt_user", "provider": "OpenAI", "role": "ChatGPT user-triggered fetch", "robots_token": "ChatGPT-User", "http_user_agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot"},
        {"id": "gptbot", "provider": "OpenAI", "role": "model-training crawler", "robots_token": "GPTBot", "http_user_agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.3; +https://openai.com/gptbot"},
        {"id": "claudebot", "provider": "Anthropic", "role": "Claude crawler", "robots_token": "ClaudeBot", "http_user_agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +https://www.anthropic.com/claudebot"},
        {"id": "claude_searchbot", "provider": "Anthropic", "role": "Claude search fetch", "robots_token": "Claude-SearchBot", "http_user_agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-SearchBot/1.0; +https://www.anthropic.com/claude-searchbot"},
        {"id": "perplexitybot", "provider": "Perplexity", "role": "AI answer crawler", "robots_token": "PerplexityBot", "http_user_agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)"},
        {"id": "perplexity_user", "provider": "Perplexity", "role": "Perplexity user-triggered fetch", "robots_token": "Perplexity-User", "http_user_agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)"},
    ]


def audit_accessibility(project_dir: Path, domain: str = "", network_approved: bool = False, timeout: int = 12) -> dict[str, Any]:
    root = find_project_root(project_dir)
    ensure_dirs(root)
    config = load_config(root)
    domain = domain or config["project"].get("domain", "")
    user_agents = site_audit_user_agent_matrix()
    results: list[dict[str, Any]] = []
    robots = {"status": "skipped", "summary": "network approval not provided"}
    sitemap = {"status": "skipped", "summary": "network approval not provided"}

    if network_approved and domain:
        base = normalize_url(domain)
        robots = fetch_url(f"{base}/robots.txt", SITE_AUDIT_GENERIC_BROWSER_UA, timeout)
        sitemap = fetch_url(f"{base}/sitemap.xml", SITE_AUDIT_GENERIC_BROWSER_UA, timeout)
        for agent in user_agents:
            row = fetch_url(base, agent["http_user_agent"], timeout)
            row.update({
                "id": agent["id"],
                "provider": agent["provider"],
                "role": agent["role"],
                "robots_token": agent["robots_token"],
                "user_agent": agent["robots_token"],
                "http_user_agent": agent["http_user_agent"],
            })
            results.append(row)
    else:
        for agent in user_agents:
            results.append({
                "id": agent["id"],
                "provider": agent["provider"],
                "role": agent["role"],
                "robots_token": agent["robots_token"],
                "user_agent": agent["robots_token"],
                "http_user_agent": agent["http_user_agent"],
                "status": "skipped",
                "summary": "network approval not provided",
                "waf_signals": [],
            })

    report_path = root / REPORTS_REL / "ACCESSIBILITY_AUDIT.md"
    write_text(report_path, build_accessibility_report(domain, network_approved, robots, sitemap, results))
    write_json(root / PROCESSED_REL / "accessibility_audit.json", {
        "domain": domain,
        "network_approved": network_approved,
        "robots": robots,
        "sitemap": sitemap,
        "user_agent_matrix": results,
        "generated_at": utc_now(),
    })
    update_state(root, f"Accessibility audit prepared for {domain or 'unknown domain'}", [str(report_path)])

    status = "success" if domain else "blocked"
    return observation(
        status,
        "Accessibility audit created." if domain else "Domain is required for accessibility audit.",
        items=[{"domain": domain, "network_approved": network_approved, "user_agent_rows": len(results)}],
        evidence_refs=[str(report_path), str(root / PROCESSED_REL / "accessibility_audit.json")],
        next_valid_actions=(
            [
                "request_target_page_url_if_missing",
                "run_target_page_llm_access_audit_or_record_explicit_decline",
                "then_collect_topic_and_semantic_cluster",
            ]
            if domain
            else ["init_project_context"]
        ),
    )


def normalize_url(domain_or_url: str) -> str:
    value = domain_or_url.strip().rstrip("/")
    if not value.startswith(("http://", "https://")):
        value = "https://" + value
    return value


def fetch_url(url: str, user_agent: str, timeout: int) -> dict[str, Any]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": user_agent})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read(200000)
            text = decode_text_bytes(data, resp.headers.get("content-type", ""), source=url)[0]
            waf_signals = detect_waf(text, resp.headers)
            return {
                "status": "success",
                "http_user_agent": user_agent,
                "http_status": resp.status,
                "bytes_read": len(data),
                "content_type": resp.headers.get("content-type", ""),
                "main_content_risk": "low_text" if len(strip_tags(text)) < 800 else "unknown",
                "waf_signals": waf_signals,
                "summary": f"HTTP {resp.status}, {len(data)} bytes",
            }
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {"status": "error", "http_user_agent": user_agent, "summary": f"{type(exc).__name__}: {exc}"}


def detect_waf(text: str, headers: Any) -> list[str]:
    haystack = (text + "\n" + "\n".join(f"{k}: {v}" for k, v in headers.items())).lower()
    signals = []
    for needle in ["cloudflare", "captcha", "access denied", "cf-ray", "waf", "bot protection"]:
        if needle in haystack:
            signals.append(needle)
    return signals


def strip_tags(html: str) -> str:
    return re.sub(r"<[^>]+>", " ", html)


def build_accessibility_report(domain: str, network_approved: bool, robots: dict[str, Any], sitemap: dict[str, Any], rows: list[dict[str, Any]]) -> str:
    block_statuses = {401, 403, 407, 429, 503}
    skipped_rows = [row for row in rows if row.get("status") == "skipped"]
    error_rows = [row for row in rows if row.get("status") == "error"]
    blocked_rows = [row for row in rows if row.get("http_status") in block_statuses]
    waf_rows = [row for row in rows if row.get("waf_signals")]
    low_text_rows = [row for row in rows if row.get("main_content_risk") in {"empty", "very_low_text", "low_text"}]

    def status_for(check: str) -> tuple[str, str]:
        if check == "network":
            return ("[OK]", "network approval granted") if network_approved else ("[SKIP]", "live HTTP checks skipped until approval")
        if check == "robots":
            if robots.get("status") == "success":
                return "[OK]", str(robots.get("summary", "robots.txt fetched"))
            return ("[SKIP]" if not network_approved else "[WARN]", str(robots.get("summary", "robots.txt not fetched")))
        if check == "sitemap":
            if sitemap.get("status") == "success":
                return "[OK]", str(sitemap.get("summary", "sitemap fetched"))
            return ("[SKIP]" if not network_approved else "[WARN]", str(sitemap.get("summary", "sitemap not fetched")))
        if check == "bot_http":
            if skipped_rows and len(skipped_rows) == len(rows):
                return "[SKIP]", "bot HTTP probes require network approval"
            if blocked_rows:
                return "[CRIT]", f"{len(blocked_rows)} bot probes returned block statuses"
            if error_rows:
                return "[WARN]", f"{len(error_rows)} bot probes returned network/request errors"
            return "[OK]", "all configured bot probes returned successful HTTP responses"
        if check == "waf":
            if skipped_rows and len(skipped_rows) == len(rows):
                return "[SKIP]", "WAF/security signals require live HTTP"
            if waf_rows:
                return "[WARN]", f"WAF/security markers found in {len(waf_rows)} probe responses"
            return "[OK]", "no WAF/security markers found in fetched probe responses"
        if check == "content":
            if skipped_rows and len(skipped_rows) == len(rows):
                return "[SKIP]", "content volume requires live HTTP"
            if low_text_rows:
                return "[WARN]", f"{len(low_text_rows)} probe responses have low/empty text volume"
            return "[OK]", "main text volume did not trigger low-content warnings"
        return "[WARN]", "unknown check"

    checklist = [
        ("Network approval", *status_for("network")),
        ("robots.txt fetch", *status_for("robots")),
        ("sitemap.xml fetch", *status_for("sitemap")),
        ("Bot HTTP probes with full User-Agent strings", *status_for("bot_http")),
        ("WAF/security markers", *status_for("waf")),
        ("Main content volume", *status_for("content")),
    ]
    critical = [f"{row.get('robots_token')}: {row.get('http_status')} {row.get('summary', '')}" for row in blocked_rows]
    warnings = [f"{row.get('robots_token')}: {row.get('summary', '')}" for row in error_rows + waf_rows + low_text_rows]
    lines = [
        "# ACCESSIBILITY_AUDIT",
        "",
        f"Generated: {utc_now()}",
        f"Domain: {domain or 'not provided'}",
        f"Network approved: {network_approved}",
        "",
        "## Audit Checklist",
        "",
        "| Check | Status | Evidence |",
        "| --- | --- | --- |",
    ]
    for check, status, evidence in checklist:
        lines.append(f"| {escape_md(check)} | {status} | {escape_md(evidence)} |")
    lines.extend([
        "",
        "## Critical Issues",
        "",
    ])
    lines.extend([f"- {escape_md(item)}" for item in critical] or ["- none"])
    lines.extend([
        "",
        "## Warnings",
        "",
    ])
    lines.extend([f"- {escape_md(item)}" for item in warnings] or (["- Live HTTP checks skipped until network approval."] if not network_approved else ["- none"]))
    lines.extend([
        "",
        "## Robots",
        "",
        f"- status: {robots.get('status')}",
        f"- summary: {robots.get('summary')}",
        "",
        "## Sitemap",
        "",
        f"- status: {sitemap.get('status')}",
        f"- summary: {sitemap.get('summary')}",
        "",
        "## User-Agent Matrix",
        "",
        "HTTP probes use the full `http_user_agent` string. The `robots_token` column is only the robots.txt token and must not be used as the HTTP User-Agent for manual curl/PowerShell rechecks.",
        "",
        "| Provider | Role | Robots token | HTTP User-Agent | Status | HTTP | Summary | WAF Signals |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ])
    for row in rows:
        lines.append(
            f"| {escape_md(str(row.get('provider', '')))} | {escape_md(str(row.get('role', '')))} | `{escape_md(str(row.get('robots_token', row.get('user_agent', ''))))}` | `{escape_md(str(row.get('http_user_agent', '')))}` | {row.get('status')} | {row.get('http_status', '')} | "
            f"{escape_md(str(row.get('summary', '')))} | {', '.join(row.get('waf_signals', [])) or 'none'} |"
        )
    lines.extend([
        "",
        "## Manual Recheck Rule",
        "",
        "- For manual rechecks, copy the full `HTTP User-Agent` value from the matrix.",
        "- Do not run `curl -A \"GPTBot\"`, `curl -A \"ClaudeBot\"`, or other short-token probes for server-access conclusions; those are robots tokens, not complete crawler request headers.",
    ])
    return "\n".join(lines) + "\n"

def escape_md(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")


def portable_ref(root: Path, value: str | Path) -> str:
    path = Path(str(value))
    if not path.is_absolute():
        return path.as_posix()
    try:
        return path.resolve(strict=False).relative_to(root.resolve(strict=False)).as_posix()
    except ValueError:
        return str(value)


def portable_text(root: Path, value: str) -> str:
    root_text = str(root.resolve(strict=False))
    root_alt = root_text.replace("\\", "/")
    return value.replace(root_text, ".").replace(root_alt, ".")


def portable_value(root: Path, value: Any) -> Any:
    if isinstance(value, dict):
        return {key: portable_value(root, item) for key, item in value.items()}
    if isinstance(value, list):
        return [portable_value(root, item) for item in value]
    if isinstance(value, str):
        return portable_text(root, value)
    return value


def has_placeholder(value: Any) -> bool:
    if isinstance(value, str):
        stripped = value.strip()
        return (stripped.startswith("<") and stripped.endswith(">")) or "<reviewer" in stripped or "<user" in stripped or "<why" in stripped
    if isinstance(value, list):
        return any(has_placeholder(item) for item in value)
    if isinstance(value, dict):
        return any(has_placeholder(item) for item in value.values())
    return False


def run_topic_workflow(
    project_dir: Path,
    topic: str,
    domain: str = "",
    brand: str = "",
    brand_variants: str = "",
    region: str = "",
    language: str = "",
    engines: str = "",
    goal: str = "",
    seed_queries: str = "",
    cluster_queries: str = "",
    cluster_queries_file: str = "",
    serp_csv: str = "",
    ai_csv: str = "",
    collect_live_serp: bool = False,
    network_approved: bool = False,
    paid_approved: bool = False,
    include_ai: bool = False,
    depth: int = 20,
    provider: str = "xmlriver",
    load_async_ai_overview: bool = False,
) -> dict[str, Any]:
    topic = repair_text_encoding(topic)
    domain = repair_text_encoding(domain)
    brand = repair_text_encoding(brand)
    region = repair_text_encoding(region)
    language = repair_text_encoding(language)
    engines = repair_text_encoding(engines)
    seed_queries = repair_text_encoding(seed_queries)
    cluster_queries = repair_text_encoding(cluster_queries)
    cluster_queries_file = repair_text_encoding(cluster_queries_file)
    root = find_project_root(project_dir)
    ensure_dirs(root)
    if not topic:
        return observation("blocked", "Topic is required.", next_valid_actions=["provide_topic"])

    pre_topic_config = load_config(root)
    pre_topic_context_path = root / DATA_REL / "project_context.json"
    pre_topic_context = read_json(pre_topic_context_path, {})
    not_applicable_evaluation = evaluate_context_not_applicable_decisions(pre_topic_config, pre_topic_context)
    pre_topic_site_context = pre_topic_context.get("site_context", {}) if isinstance(pre_topic_context.get("site_context"), dict) else {}
    pre_topic_site_context = apply_context_not_applicable_decisions(pre_topic_site_context, not_applicable_evaluation)
    pre_topic_site_gate = pre_topic_site_context.get("quality_gate", {}) if isinstance(pre_topic_site_context.get("quality_gate"), dict) else {}
    material_questions = [
        str(question) for question in pre_topic_site_context.get("open_questions", [])
        if question and not str(question).startswith("No major product-context questions")
    ]
    brand_status = pre_topic_config.get("project", {}).get("brand_variants_status", "missing")
    brand_confirmed = brand_status == "confirmed"
    context_ready = (
        pre_topic_site_context.get("status") == "success"
        and pre_topic_site_gate.get("status") == "pass"
        and not material_questions
        and brand_confirmed
    )
    pre_topic_context["site_context"] = pre_topic_site_context
    pre_topic_context["context_quality_gate"] = {
        "status": "pass" if context_ready else "fail",
        "site_context_status": pre_topic_site_context.get("status", "not_collected"),
        "brand_variants_status": brand_status,
        "brand_variants_confirmed": brand_confirmed,
        "brand_variants_waivable": False,
        "material_open_questions": material_questions,
        "missing_context_fields": pre_topic_site_gate.get("missing_context_fields", pre_topic_site_gate.get("blocking_check_ids", [])),
        "accepted_not_applicable_fields": not_applicable_evaluation.get("accepted_fields", []),
        "accepted_not_applicable_decisions": not_applicable_evaluation.get("accepted_decisions", []),
        "rejected_not_applicable_decisions": not_applicable_evaluation.get("rejected_decisions", []),
    }
    if not context_ready:
        write_json(pre_topic_context_path, pre_topic_context)
        return observation(
            "blocked",
            "Topic intake is blocked until deep project context passes and brand variants are confirmed.",
            items=[pre_topic_context["context_quality_gate"]],
            evidence_refs=[str(pre_topic_context_path)],
            next_valid_actions=["resolve_context_quality_gaps", "confirm_brand_variants", "rerun_collect_project_context"],
        )

    audit_gate = evaluate_pre_topic_audit_gate(root, pre_topic_config, pre_topic_context)
    pre_topic_context["audit_decision_gate"] = audit_gate
    write_json(pre_topic_context_path, pre_topic_context)
    if audit_gate.get("status") != "pass":
        return observation(
            "blocked",
            "Topic intake is blocked until both site and target-page audit decisions are completed, explicitly declined, or explicitly blocked.",
            items=[audit_gate],
            evidence_refs=[str(pre_topic_context_path)],
            next_valid_actions=["complete_or_record_site_accessibility_audit_decision", "complete_or_record_target_page_llm_accessibility_audit_decision"],
        )

    # Resolve the supplied cluster before persisting the topic. A bare topic must not
    # become project state when the mandatory semantic cluster is still missing.
    config = load_config(root)
    base_queries = resolve_semantic_cluster_queries(root, topic, cluster_queries=cluster_queries, cluster_queries_file=cluster_queries_file, seed_queries=seed_queries, config=config)
    if not base_queries:
        report_path = root / REPORTS_REL / "SEMANTIC_CLUSTER_REQUIRED.md"
        write_text(
            report_path,
            "# SEMANTIC_CLUSTER_REQUIRED\n\n"
            "Topic workflow was blocked because this agent works with `topic + semantic cluster`, not a bare topic. "
            "Provide the user query cluster with `--cluster-queries` or `--cluster-queries-file`; "
            "`--seed-queries` is accepted only as a legacy alias for the same cluster.\n",
        )
        return observation("blocked", "Topic workflow requires semantic cluster queries for this topic.", evidence_refs=[str(report_path), str(root / DATA_REL / "project_context.json")], next_valid_actions=["provide_cluster_queries", "rerun_init_project_with_cluster", "rerun_run_topic_with_cluster"])
    init_project_context(root, domain=domain, brand=brand, brand_variants=brand_variants, topic=topic, region=region, language=language, engines=engines, goal=goal, cluster_queries=cluster_queries, cluster_queries_file=cluster_queries_file, accept_topic_cluster=True)
    config = load_config(root)
    topic_slug = slugify(topic)
    write_csv(root / PROCESSED_REL / f"{topic_slug}_semantic_cluster_queries.csv", semantic_cluster_rows(topic, base_queries))
    fanout_rows = build_fanout(topic, base_queries, language=language)
    write_csv(root / PROCESSED_REL / f"{topic_slug}_fanout_queries.csv", fanout_rows)
    write_text(root / REPORTS_REL / "FANOUT_MAP.md", build_fanout_report(topic, fanout_rows))

    live_collection_status: dict[str, Any] = {"requested": collect_live_serp, "status": "not_requested"}
    live_serp_rows: list[dict[str, Any]] = []
    live_ai_rows: list[dict[str, Any]] = []
    if collect_live_serp:
        live_obs = collect_serp(
            root,
            topic=topic,
            provider=provider,
            engines=engines,
            region=region,
            language=language,
            seed_queries=seed_queries,
            cluster_queries="\n".join(base_queries),
            depth=depth,
            max_queries=0,
            include_ai=include_ai,
            network_approved=network_approved,
            paid_approved=paid_approved,
        )
        live_collection_status = {"requested": True, "status": live_obs.get("status"), "summary": live_obs.get("summary")}
        if live_obs.get("status") == "success":
            live_serp_rows = load_serp_rows(root, str(root / PROCESSED_REL / f"{topic_slug}_live_serp_rows.csv"), topic, engines)
            live_ai_rows = load_ai_rows(root, str(root / PROCESSED_REL / f"{topic_slug}_live_ai_answers.csv"))
        else:
            blocked_report = root / REPORTS_REL / "LIVE_SERP_COLLECTION_BLOCKED.md"
            write_text(
                blocked_report,
                "# LIVE_SERP_COLLECTION_BLOCKED\n\n"
                "The requested live SERP collection did not complete, so the topic workflow stopped before evidence analysis. "
                "No success claim or downstream content plan was produced from this failed live stage.\n\n"
                f"- provider: {provider}\n- status: {live_obs.get('status')}\n- summary: {live_obs.get('summary')}\n"
            )
            update_state(root, f"Live SERP collection blocked for {topic}", [str(blocked_report)])
            return observation(
                str(live_obs.get("status") or "blocked"),
                "Topic workflow stopped because its requested live SERP collection did not complete.",
                items=[{"topic": topic, "live_collection": live_collection_status}],
                evidence_refs=[str(blocked_report)],
                next_valid_actions=["repair_live_collection_scope_or_provider", "rerun_run_topic_after_live_collection_succeeds"],
            )

    manual_serp_rows = load_serp_rows(root, serp_csv, topic, engines)
    serp_rows = live_serp_rows + manual_serp_rows
    write_csv(root / PROCESSED_REL / f"{topic_slug}_serp_rows.csv", serp_rows)
    manual_ai_rows = load_ai_rows(root, ai_csv)
    ai_rows = live_ai_rows + manual_ai_rows
    write_csv(root / PROCESSED_REL / f"{topic_slug}_ai_answers.csv", ai_rows)
    live_evidence_present = bool(live_serp_rows or live_ai_rows)
    manual_evidence_present = bool(manual_serp_rows or manual_ai_rows)
    evidence_mode = "live_provider" if live_evidence_present else ("manual_import" if manual_evidence_present else "no_serp_ai_evidence")
    lower_assurance = evidence_mode != "live_provider"

    analysis = analyze_serp_ai(topic, domain or config["project"].get("domain", ""), brand or config["project"].get("brand", ""), serp_rows, ai_rows, brand_variants_from_config(config, brand=brand))
    write_json(root / PROCESSED_REL / f"{topic_slug}_serp_ai_analysis.json", analysis)
    write_text(root / REPORTS_REL / "SERP_AI_ANALYSIS.md", build_serp_ai_report(topic, analysis))

    content_plan = build_content_plan(topic, fanout_rows, analysis, domain or config["project"].get("domain", ""))
    write_csv(root / PROCESSED_REL / f"{topic_slug}_content_plan.csv", content_plan)
    write_text(root / REPORTS_REL / "CONTENT_PLAN.md", build_content_plan_report(topic, content_plan))

    handoff = build_handoff_payload(root, topic, topic_slug, config, fanout_rows, serp_rows, ai_rows, analysis, content_plan, base_queries)
    handoff_path = root / HANDOFF_REL / f"semantic_tz_handoff_{topic_slug}.json"
    write_json(handoff_path, handoff)
    write_text(root / REPORTS_REL / "TZ_HANDOFF_REPORT.md", build_tz_handoff_report(handoff_path, config, handoff))

    product_context = ", ".join(config.get("project", {}).get("products_services", [])) or brand or config["project"].get("brand", "")
    placement_rows = build_placement_rows(topic, analysis, cluster_queries=base_queries + [r.get("fanout_query", "") for r in fanout_rows], product=product_context, target_action=goal, geo=region, language=language)
    write_csv(root / PROCESSED_REL / f"{topic_slug}_placement_opportunities.csv", placement_rows)
    write_text(root / REPORTS_REL / "PLACEMENT_STRATEGY.md", build_placement_report(topic, placement_rows, analysis))

    monitoring_rows = build_monitoring_rows(topic, base_queries, fanout_rows, goal, brand_variants_from_config(config, brand=brand))
    write_csv(root / PROCESSED_REL / f"{topic_slug}_monitoring_prompts.csv", monitoring_rows)
    write_text(root / REPORTS_REL / "MONITORING_PLAN.md", build_monitoring_report(topic, monitoring_rows, goal))

    db_path = persist_workflow_sqlite(root, topic, config, fanout_rows, serp_rows, ai_rows, placement_rows)

    write_stage_gates(root, topic_slug, {
        "semantic_cluster": str(root / PROCESSED_REL / f"{topic_slug}_semantic_cluster_queries.csv"),
        "fanout": str(root / REPORTS_REL / "FANOUT_MAP.md"),
        "serp_ai_analysis": str(root / REPORTS_REL / "SERP_AI_ANALYSIS.md"),
        "content_plan": str(root / REPORTS_REL / "CONTENT_PLAN.md"),
        "semantic_tz_handoff": str(handoff_path),
        "placement_strategy": str(root / REPORTS_REL / "PLACEMENT_STRATEGY.md"),
        "monitoring_plan": str(root / REPORTS_REL / "MONITORING_PLAN.md"),
        "sqlite_storage": str(db_path),
    }, lower_assurance=lower_assurance)
    update_state(root, f"Topic workflow completed for {topic}", [str(handoff_path)])

    evidence = [
        str(root / PROCESSED_REL / f"{topic_slug}_semantic_cluster_queries.csv"),
        str(root / REPORTS_REL / "FANOUT_MAP.md"),
        str(root / REPORTS_REL / "SERP_AI_ANALYSIS.md"),
        str(root / REPORTS_REL / "CONTENT_PLAN.md"),
        str(handoff_path),
        str(root / REPORTS_REL / "PLACEMENT_STRATEGY.md"),
        str(root / REPORTS_REL / "MONITORING_PLAN.md"),
        str(db_path),
    ]
    return observation(
        "success",
        "One-topic GEO/AEO workflow completed.",
        items=[
            {"topic": topic},
            {"semantic_cluster_queries": len(base_queries)},
            {"fanout_queries": len(fanout_rows)},
            {"serp_rows": len(serp_rows)},
            {"ai_answer_rows": len(ai_rows)},
            {"content_plan_items": len(content_plan)},
            {"lower_assurance": lower_assurance},
            {"evidence_mode": evidence_mode},
            {"live_collection": live_collection_status},
            {"sqlite_db": str(db_path)},
        ],
        evidence_refs=evidence,
        next_valid_actions=["review_reports", "invoke_semantic_tz_generator_if_approved", "run_monitoring_later"],
    )


def build_fanout(topic: str, seed_queries: list[str], language: str = "ru") -> list[dict[str, Any]]:
    branches = [
        ("core_answer", "what is {topic}"),
        ("comparison", "{topic} comparison"),
        ("cost", "{topic} cost"),
        ("risks", "{topic} risks"),
        ("alternatives", "{topic} alternatives"),
        ("requirements", "{topic} requirements"),
        ("process", "how to choose {topic}"),
        ("mistakes", "{topic} mistakes"),
        ("faq", "{topic} questions"),
        ("local", "{topic} in {region}"),
    ]
    if language.lower().startswith("ru"):
        branches = [
            ("core_answer", "что такое {topic}"),
            ("comparison", "{topic} сравнение"),
            ("cost", "{topic} стоимость"),
            ("risks", "{topic} риски"),
            ("alternatives", "{topic} альтернативы"),
            ("requirements", "{topic} требования"),
            ("process", "как выбрать {topic}"),
            ("mistakes", "{topic} ошибки"),
            ("faq", "{topic} вопросы"),
            ("local", "{topic} в Москве"),
        ]
    rows = []
    seen: set[str] = set()
    order = 0
    for seed in seed_queries:
        for branch, template in branches:
            query = template.format(topic=seed, region="Moscow").strip()
            key = query.lower()
            if key in seen:
                continue
            seen.add(key)
            order += 1
            rows.append({
                "source_order": order,
                "source_query": seed,
                "fanout_query": query,
                "branch": branch,
                "priority": "high" if branch in {"core_answer", "comparison", "process"} else "medium",
                "status": "draft",
            })
    return rows


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding=CSV_ARTIFACT_ENCODING)
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
    serialized_rows = "\n".join("\t".join(str(row.get(field, "")) for field in fields) for row in normalized_rows)
    issues = artifact_encoding_issues(path, serialized_rows)
    if issues:
        raise ValueError(
            f"Refusing to write {path}: possible encoding damage ({', '.join(issues)}). "
            "Use UTF-8 CSV writer and regenerate source rows."
        )
    with path.open("w", encoding=CSV_ARTIFACT_ENCODING, newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(normalized_rows)

def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    csv.field_size_limit(min(sys.maxsize, 2**31 - 1))
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        rows = []
        for row in csv.DictReader(fh):
            if None in row:
                row["_csv_error"] = "extra_unmapped_columns"
                row["_csv_extra_columns"] = " | ".join(str(value) for value in row.get(None, []) if value)
                del row[None]
            rows.append(row)
        return rows


def is_http_url(value: str) -> bool:
    return bool(re.match(r"https?://", normalize_ws(value or ""), flags=re.IGNORECASE))

def load_serp_rows(root: Path, serp_csv: str, topic: str, engines: str) -> list[dict[str, Any]]:
    path = Path(serp_csv) if serp_csv else root / IMPORT_REL / "manual_serp.csv"
    rows = read_csv(path) if path.exists() else []
    normalized = []
    for row in rows:
        if not any(row.values()) or row.get("_csv_error"):
            continue
        url = normalize_ws(row.get("url") or "")
        if url and not is_http_url(url):
            continue
        normalized.append({
            "query": repair_text_encoding(row.get("query") or topic),
            "engine": repair_text_encoding(row.get("engine") or ""),
            "position": safe_int(row.get("position")),
            "url": url,
            "title": repair_text_encoding(row.get("title") or ""),
            "snippet": repair_text_encoding(row.get("snippet") or ""),
            "source_type": row.get("source_type") or "manual",
            "cited_in_ai": truthy(row.get("cited_in_ai")),
        })
    return normalized

def load_ai_rows(root: Path, ai_csv: str) -> list[dict[str, Any]]:
    path = Path(ai_csv) if ai_csv else root / IMPORT_REL / "ai_answers.csv"
    rows = read_csv(path) if path.exists() else []
    normalized = []
    for row in rows:
        if not any(row.values()) or row.get("_csv_error"):
            continue
        answer_text = repair_text_encoding(row.get("answer_text") or row.get("answer_text_clean") or row.get("answer") or "")
        if is_xmlriver_error_payload(answer_text) and not extract_ai_citation_urls(answer_text):
            continue
        citation_url = normalize_ai_citation_url(row.get("citation_url") or "")
        if not citation_url:
            cited_urls = split_csv(row.get("cited_urls") or row.get("citation_urls") or "")
            citation_url = normalize_ai_citation_url(cited_urls[0]) if cited_urls else ""
        normalized.append({
            "answer_id": row.get("answer_id") or sha12(json.dumps(row, ensure_ascii=False)),
            "prompt": repair_text_encoding(row.get("prompt") or row.get("query") or ""),
            "provider": row.get("provider") or "manual",
            "model": row.get("model") or "",
            "target_geo": row.get("target_geo") or "",
            "user_search_geo": row.get("user_search_geo") or "",
            "language": row.get("language") or "",
            "answer_text": answer_text,
            "citation_url": citation_url,
            "citation_title": repair_text_encoding(row.get("citation_title") or row.get("cited_titles") or ""),
            "brand_mentioned": truthy(row.get("brand_mentioned")),
            "project_url_cited": truthy(row.get("project_url_cited")),
            "date": row.get("date") or "",
        })
    return normalized

def truthy(value: Any) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "y", "да"}


def safe_int(value: Any) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return 0


def analyze_serp_ai(topic: str, domain: str, brand: str, serp_rows: list[dict[str, Any]], ai_rows: list[dict[str, Any]], brand_variants: list[str] | None = None) -> dict[str, Any]:
    domain_norm = normalize_domain(domain)
    top_domains: dict[str, int] = {}
    cited_urls: dict[str, int] = {}
    title_terms: dict[str, int] = {}
    project_serp_hits = []
    for row in serp_rows:
        row_domain = normalize_domain(row.get("url", ""))
        if row_domain:
            top_domains[row_domain] = top_domains.get(row_domain, 0) + 1
        if domain_norm and domain_norm in row_domain:
            project_serp_hits.append(row)
        for term in extract_title_terms(row.get("title", "")):
            title_terms[term] = title_terms.get(term, 0) + 1
        if row.get("cited_in_ai") and row.get("url"):
            cited_urls[row["url"]] = cited_urls.get(row["url"], 0) + 1

    tracked_brand_variants = dedupe_terms([brand, *(brand_variants or [])])
    brand_mentions = 0
    project_url_citations = 0
    for row in ai_rows:
        row_urls = []
        for value in split_csv(str(row.get("citation_url") or "")):
            normalized_url = normalize_ai_citation_url(value)
            if normalized_url:
                row_urls.append(normalized_url)
        for value in split_csv(str(row.get("cited_urls") or row.get("citation_urls") or "")):
            normalized_url = normalize_ai_citation_url(value)
            if normalized_url:
                row_urls.append(normalized_url)
        row_urls.extend(extract_ai_citation_urls(str(row.get("answer_text") or row.get("answer_text_clean") or "")))
        for url in unique_nonempty(row_urls):
            cited_urls[url] = cited_urls.get(url, 0) + 1
        answer_body = ai_text_for_matching(str(row.get("answer_text") or ""), str(row.get("answer_text_clean") or ""), str(row.get("answer") or ""))
        if any(text_contains_term(answer_body, term) for term in tracked_brand_variants if term):
            brand_mentions += 1
        if row.get("project_url_cited") or any(domain_norm and domain_norm in normalize_domain(url) for url in row_urls):
            project_url_citations += 1

    return {
        "topic": topic,
        "domain": domain,
        "brand": brand,
        "brand_variants_tracked": tracked_brand_variants,
        "serp_row_count": len(serp_rows),
        "ai_answer_row_count": len(ai_rows),
        "project_serp_hits": project_serp_hits,
        "project_url_citation_count": project_url_citations,
        "answer_body_brand_mentions": brand_mentions,
        "top_domains": sorted_dict(top_domains),
        "cited_urls": sorted_dict(cited_urls),
        "title_term_patterns": sorted_dict(title_terms)[:30],
        "retrieval_citation_brand_split": {
            "ordinary_serp_presence": len(project_serp_hits),
            "final_citation_source_presence": project_url_citations,
            "answer_body_brand_mentions": brand_mentions,
        },
        "limitations": build_analysis_limitations(serp_rows, ai_rows),
    }


def normalize_domain(url_or_domain: str) -> str:
    if not url_or_domain:
        return ""
    value = url_or_domain.strip()
    if not value.startswith(("http://", "https://")):
        value = "https://" + value
    parsed = urllib.parse.urlparse(value)
    return parsed.netloc.lower().removeprefix("www.")


def extract_title_terms(title: str) -> list[str]:
    tokens = re.findall(r"[A-Za-zА-Яа-яЁё0-9]{4,}", title.lower())
    stop = {"http", "https", "www", "com", "html", "what", "with", "this", "that", "для", "как", "что", "или"}
    return [t for t in tokens if t not in stop][:20]


def sorted_dict(values: dict[str, int]) -> list[dict[str, Any]]:
    return [{"value": key, "count": count} for key, count in sorted(values.items(), key=lambda kv: (-kv[1], kv[0]))]


def build_analysis_limitations(serp_rows: list[dict[str, Any]], ai_rows: list[dict[str, Any]]) -> list[str]:
    limits = []
    if not serp_rows:
        limits.append("No SERP rows imported or collected; SERP conclusions are lower-assurance.")
    if not ai_rows:
        limits.append("No AI answer rows imported or collected; citation and brand mention conclusions are lower-assurance.")
    if not limits:
        limits.append("Manual/provider evidence exists; still avoid causal claims from one run.")
    return limits


def build_content_plan(topic: str, fanout_rows: list[dict[str, Any]], analysis: dict[str, Any], domain: str) -> list[dict[str, Any]]:
    rows = []
    rows.append({
        "item_id": "cp-001",
        "action": "update_or_create",
        "topic": topic,
        "intent": "core_answer",
        "target_url": domain or "",
        "suggested_url": f"/{slugify(topic)}/",
        "page_type": "focused_topic_page",
        "priority": "high",
        "evidence": "core topic and fan-out root",
        "recommendation": "Create or update a focused answer page with clear title, H1, intro, short answer, criteria, risks, and FAQ only if useful.",
    })
    for row in fanout_rows:
        if row["branch"] in {"comparison", "cost", "risks", "process", "alternatives"}:
            rows.append({
                "item_id": f"cp-{len(rows)+1:03d}",
                "action": "section_or_separate_page_after_overlap_check",
                "topic": row["fanout_query"],
                "intent": row["branch"],
                "target_url": "",
                "suggested_url": f"/{slugify(row['fanout_query'])}/",
                "page_type": "supporting_qfo_module",
                "priority": "medium" if row["branch"] != "comparison" else "high",
                "evidence": "fan-out branch",
                "recommendation": "Use as a page section unless SERP/AI evidence proves a materially distinct user task.",
            })
    if analysis.get("cited_urls"):
        rows.append({
            "item_id": f"cp-{len(rows)+1:03d}",
            "action": "external_source_alignment",
            "topic": f"{topic} cited-source pattern",
            "intent": "citation_source",
            "target_url": "",
            "suggested_url": "",
            "page_type": "placement_or_reference",
            "priority": "high",
            "evidence": "cited URLs present in imported evidence",
            "recommendation": "Inspect repeated cited URLs and align page modules with useful answer fragments.",
        })
    return rows


def build_handoff_payload(
    root: Path,
    topic: str,
    topic_slug: str,
    config: dict[str, Any],
    fanout_rows: list[dict[str, Any]],
    serp_rows: list[dict[str, Any]],
    ai_rows: list[dict[str, Any]],
    analysis: dict[str, Any],
    content_plan: list[dict[str, Any]],
    semantic_cluster_queries: list[str] | None = None,
) -> dict[str, Any]:
    discovery = config.get("discovery", {})
    return {
        "schema_version": "geo-topic-agent.semantic-tz-handoff.v1",
        "generated_at": utc_now(),
        "topic": topic,
        "topic_slug": topic_slug,
        "semantic_cluster_queries": semantic_cluster_queries or configured_semantic_cluster_queries(config, topic),
        "project": config.get("project", {}),
        "region": config.get("region", {}),
        "search_engines": config.get("search_engines", {}),
        "semantic_tz_generator_candidates": discovery.get("semantic_tz_generators", []),
        "generator_invoked": False,
        "goal": config.get("project", {}).get("target_goal", "both"),
        "fanout_queries": fanout_rows,
        "serp_rows": serp_rows,
        "ai_answer_rows": ai_rows,
        "serp_ai_analysis": analysis,
        "content_plan": content_plan,
        "source_artifacts": {
            "semantic_cluster_csv": portable_ref(root, root / PROCESSED_REL / f"{topic_slug}_semantic_cluster_queries.csv"),
            "fanout_csv": portable_ref(root, root / PROCESSED_REL / f"{topic_slug}_fanout_queries.csv"),
            "serp_csv": portable_ref(root, root / PROCESSED_REL / f"{topic_slug}_serp_rows.csv"),
            "ai_csv": portable_ref(root, root / PROCESSED_REL / f"{topic_slug}_ai_answers.csv"),
            "content_plan_csv": portable_ref(root, root / PROCESSED_REL / f"{topic_slug}_content_plan.csv"),
        },
        "assumptions": analysis.get("limitations", []),
        "next_valid_actions": [
            "Review handoff JSON.",
            "Invoke discovered semantic TZ generator only after checking its own permission contract.",
            "Import generated TZ back into content workflow.",
        ],
    }



def read_query_file(path_value: str) -> list[str]:
    if not path_value:
        return []
    path = Path(path_value)
    if not path.exists():
        return []
    if path.suffix.lower() == ".csv":
        rows = read_csv(path)
        out = []
        for row in rows:
            for key in ["query", "qfo_query", "fanout_query", "keyword", "prompt"]:
                if row.get(key):
                    out.append(repair_text_encoding(row.get(key, "")))
                    break
        return [x for x in out if x]
    return [repair_text_encoding(line.strip()) for line in read_text_lossless(path).splitlines() if line.strip()]


def tokenize_for_fit(value: str) -> list[str]:
    return [t.lower() for t in re.findall(r"[A-Za-zА-Яа-яЁё0-9]+", repair_text_encoding(value or "")) if len(t) > 2]


def infer_cluster_intent(topic: str, cluster_queries: list[str], product: str, target_action: str) -> dict[str, Any]:
    text = " ".join([topic, *cluster_queries]).lower()
    buckets = {
        "comparison_or_choice": ["best", "top", "vs", "compare", "comparison", "review", "reviews", "rating", "лучший", "топ", "сравн", "рейтинг", "отзывы", "выбрать", "альтернатив"],
        "purchase_or_registration": ["buy", "price", "pricing", "cost", "demo", "trial", "register", "купить", "цена", "стоимость", "тариф", "заказать", "регистра", "демо"],
        "risk_reduction": ["risk", "mistake", "avoid", "safe", "security", "problem", "ошиб", "риск", "безопас", "проблем", "как не"],
        "how_to_solution": ["how", "guide", "tutorial", "checklist", "template", "как", "гайд", "инструк", "чеклист", "шаблон"],
        "provider_selection": ["agency", "provider", "service", "software", "tool", "platform", "сервис", "агентство", "провайдер", "услуг", "платформ", "инструмент"],
    }
    matched: dict[str, int] = {name: sum(1 for term in terms if term in text) for name, terms in buckets.items()}
    ordered = sorted(matched.items(), key=lambda item: (-item[1], item[0]))
    main = ordered[0][0] if ordered and ordered[0][1] else "informational_research"
    sub = [name for name, count in ordered if count and name != main][:4]
    commercial = main in {"comparison_or_choice", "purchase_or_registration", "provider_selection", "risk_reduction"} or bool(target_action.strip())
    if main == "purchase_or_registration":
        stage = "purchase_decision"
    elif main in {"comparison_or_choice", "provider_selection"}:
        stage = "solution_selection"
    elif main == "risk_reduction":
        stage = "risk_reduction"
    elif main == "how_to_solution":
        stage = "implementation_research"
    else:
        stage = "early_research"
    product_moment = ""
    if target_action:
        product_moment = f"User can move from the cluster problem to target action: {target_action}."
    elif product:
        product_moment = "User can consider the product when the content compares solution paths or shows how to solve the problem."
    else:
        product_moment = "Product moment is weak until product/service is described."
    return {
        "main_intent": main,
        "subintents": sub,
        "user_stage": stage,
        "commercial_motive": commercial,
        "product_moment": product_moment,
    }


def score_product_fit(topic: str, cluster_queries: list[str], product: str, target_action: str, intent: dict[str, Any]) -> tuple[int, str]:
    if not product.strip():
        return 12, "Product/service description is missing; product fit is lower-assurance."
    query_terms = set(tokenize_for_fit(" ".join([topic, *cluster_queries])))
    product_terms = set(tokenize_for_fit(product))
    action_terms = set(tokenize_for_fit(target_action))
    overlap = len(query_terms & product_terms)
    action_overlap = len(query_terms & action_terms)
    score = min(18, overlap * 5) + min(6, action_overlap * 3)
    if intent.get("commercial_motive"):
        score += 10
    if intent.get("main_intent") in {"comparison_or_choice", "provider_selection", "purchase_or_registration"}:
        score += 7
    elif intent.get("main_intent") in {"risk_reduction", "how_to_solution"}:
        score += 4
    if target_action.strip():
        score += 5
    if not overlap and intent.get("main_intent") == "informational_research":
        score = min(score, 18)
    score = max(0, min(40, score))
    if score >= 32:
        note = "Strong natural product fit."
    elif score >= 22:
        note = "Usable product fit if the angle stays problem-led."
    else:
        note = "Low product fit; downgrade or block ideas that force the product."
    return score, note


def classify_visible_source(url_or_domain: str) -> str:
    low = (url_or_domain or "").lower()
    if any(x in low for x in ["reddit", "forum", "discuss", "community", "pikabu", "vc.ru", "habr"]):
        return "forum_or_discussion"
    if any(x in low for x in ["quora", "stackoverflow", "stackexchange", "otvet", "answers", "question", "qa"]):
        return "qa"
    if any(x in low for x in ["youtube", "youtu.be", "rutube", "vimeo"]):
        return "video"
    if any(x in low for x in ["directory", "catalog", "marketplace", "clutch", "g2", "capterra", "каталог", "справочник"]):
        return "directory"
    if any(x in low for x in ["best", "top", "rating", "review", "compare", "vs", "alternatives", "рейтинг", "лучшие", "обзор", "сравн", "отзывы"]):
        return "review_or_comparison"
    if any(x in low for x in ["docs", "developer", "tool", "app", "software", "saas", "api"]):
        return "saas_or_tools"
    if any(x in low for x in ["gov", "edu", "wikipedia", "law", "regulation", "standard", "support.google", "yandex.ru/support"]):
        return "regulatory_or_reference"
    if any(x in low for x in ["blog", "news", "media", "journal", "magazine", "guide", "article", "стать", "новост", "медиа"]):
        return "media_or_publication"
    return "external_publication"


def infer_placement_type(url: str) -> str:
    mapping = {
        "forum_or_discussion": "discussion",
        "qa": "qa",
        "video": "video",
        "directory": "directory",
        "review_or_comparison": "rating_or_comparison",
        "saas_or_tools": "saas_tools_page",
        "regulatory_or_reference": "reference_source",
        "media_or_publication": "external_publication",
        "external_publication": "external_publication",
    }
    return mapping.get(classify_visible_source(url), "external_publication")


def placement_content_format(source_type: str, strategy_type: str) -> str:
    if strategy_type == "create_owned":
        return source_type
    return {
        "forum_or_discussion": "expert answer or discussion reply",
        "qa": "expert Q&A answer",
        "video": "expert segment, review mention, or creator integration",
        "directory": "profile, sponsored listing, or category inclusion",
        "review_or_comparison": "comparison inclusion or sponsored review block",
        "saas_or_tools": "integration, partner page, or alternatives block",
        "regulatory_or_reference": "usually not suitable for promotion; use only as trust/reference context",
        "media_or_publication": "expert comment, guest material, or article update",
        "external_publication": "guest material, expert quote, or article update",
    }.get(source_type, "external placement")


def placement_angle(topic: str, product: str, target_action: str, intent: dict[str, Any], source_type: str, strategy_type: str) -> str:
    product_label = product.strip() or "the product"
    if intent.get("main_intent") == "comparison_or_choice":
        base = f"Position {product_label} as one of the options when users compare solution paths for {topic}."
    elif intent.get("main_intent") == "purchase_or_registration":
        base = f"Show why {product_label} is a direct next step for users ready to act on {topic}."
    elif intent.get("main_intent") == "risk_reduction":
        base = f"Use {product_label} as a way to reduce the concrete risk behind {topic}."
    elif intent.get("main_intent") == "how_to_solution":
        base = f"Make {product_label} the practical tool/service that helps complete the how-to task."
    else:
        base = f"Keep the asset educational and introduce {product_label} only where the user's problem naturally requires a solution."
    if target_action:
        base += f" Target action: {target_action}."
    if source_type in {"forum_or_discussion", "qa"}:
        base += " Lead with a useful answer; mention the product only after the problem is explained."
    if strategy_type == "create_owned":
        base += " Do not invent an existing URL; create a new external asset."
    return base


def expected_ai_signal(source_type: str, strategy_type: str) -> str:
    if strategy_type == "enter_existing":
        if source_type in {"review_or_comparison", "directory"}:
            return "brand/product mention in comparison lists and possible AI answer body mention"
        if source_type in {"media_or_publication", "external_publication"}:
            return "brand mention in a visible cited article and possible URL/source citation"
        if source_type in {"forum_or_discussion", "qa"}:
            return "problem-solution mention in discussion snippets or AI answer body"
        if source_type == "video":
            return "brand/product mention in video title/description/transcript used as source evidence"
        return "weak or indirect AI signal; use mainly as trust/reference support"
    if source_type in {"comparison page", "checklist", "case study"}:
        return "owned external page can be cited as source if it answers the cluster problem clearly"
    return "brand/product mention and external source footprint for future AI retrieval"


def evidence_strength_score(source_count: int, cluster_query_count: int, qfo_query_count: int, source_kind: str) -> int:
    score = min(18, max(0, source_count) * 5)
    score += min(6, cluster_query_count)
    score += min(6, qfo_query_count)
    if source_kind in {"ai_citation_url", "ai_citation_or_cited_serp"}:
        score += 4
    return max(0, min(30, score))


def platform_value_score(source_type: str, source_count: int, strategy_type: str) -> int:
    base = {
        "review_or_comparison": 18,
        "directory": 16,
        "media_or_publication": 15,
        "external_publication": 14,
        "forum_or_discussion": 14,
        "qa": 13,
        "video": 12,
        "saas_or_tools": 10,
        "regulatory_or_reference": 5,
        "comparison page": 17,
        "expert guide": 15,
        "checklist": 14,
        "case study": 14,
        "discussion seed": 12,
        "video explainer": 12,
        "directory profile": 15,
        "partner roundup": 15,
        "template/tool": 13,
        "research note": 12,
    }.get(source_type, 10)
    if strategy_type == "enter_existing":
        base += min(2, max(0, source_count - 1))
    return max(0, min(20, base))


def feasibility_score(source_type: str, strategy_type: str, platform_or_domain: str, allowed_platforms: list[str]) -> tuple[int, str]:
    low_platform = platform_or_domain.lower()
    allowed_hit = any(item.lower() in low_platform or low_platform in item.lower() for item in allowed_platforms if item)
    if strategy_type == "create_owned":
        return (9 if allowed_hit else 7), "Owned external asset can be created; final URL must not be invented."
    scores = {
        "directory": (8, "Profile/listing inclusion is often feasible."),
        "forum_or_discussion": (7, "Participation is feasible if rules allow disclosure and usefulness."),
        "qa": (7, "Answer is feasible if it directly solves the question and avoids spam."),
        "media_or_publication": (5, "Requires editorial outreach or expert contribution."),
        "external_publication": (5, "Requires outreach or editorial access."),
        "review_or_comparison": (5, "Requires list inclusion, sponsorship, or editorial update."),
        "video": (4, "Requires creator partnership or owned video response."),
        "saas_or_tools": (3, "Usually requires partnership or integration."),
        "regulatory_or_reference": (1, "Promotion is normally not feasible in reference/regulatory sources."),
    }
    score, note = scores.get(source_type, (4, "Feasibility unknown; manual review required."))
    if allowed_hit:
        score = min(10, score + 2)
        note += " Platform/domain is in the allowed/preferred list."
    return score, note


def placement_effort(score: int) -> str:
    if score >= 8:
        return "low"
    if score >= 5:
        return "medium"
    return "high"


def placement_quality_gate(product_fit: int, strategy_type: str, source_type: str, platform: str, language: str, angle_key: str, seen: set[str]) -> tuple[str, list[str]]:
    reasons: list[str] = []
    status = "pass"
    if product_fit < 18:
        status = "downgraded"
        reasons.append("low product fit")
    if source_type == "regulatory_or_reference":
        status = "downgraded"
        reasons.append("reference/regulatory source is not a normal advertising surface")
    low = platform.lower()
    if language.startswith("ru") and any(token in low for token in ["quora", "medium.com"]) and "ru" not in low:
        status = "downgraded"
        reasons.append("language/GEO fit must be manually checked")
    if not platform.strip():
        status = "blocked"
        reasons.append("platform/domain is missing")
    if angle_key in seen:
        status = "blocked"
        reasons.append("duplicate angle")
    if not reasons:
        reasons.append("passes deterministic quality gate")
    return status, reasons


def collect_existing_placement_sources(analysis: dict[str, Any], serp_urls: list[str], ai_urls: list[str]) -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    def add_source(url: str, domain: str, count: int, source_kind: str) -> None:
        clean_url = normalize_ws(url or "")
        clean_domain = normalize_domain(clean_url or domain)
        key = clean_url or clean_domain
        if not key or key in seen_keys:
            return
        seen_keys.add(key)
        sources.append({"url": clean_url, "domain": clean_domain, "count": max(1, count), "source_kind": source_kind})
    for item in analysis.get("cited_urls", [])[:60]:
        add_source(str(item.get("value", "")), "", safe_int(item.get("count")) or 1, "ai_citation_or_cited_serp")
    for url in ai_urls:
        add_source(url, "", 2, "ai_citation_url")
    for url in serp_urls:
        add_source(url, "", 1, "serp_url")
    for item in analysis.get("top_domains", [])[:40]:
        add_source("", str(item.get("value", "")), safe_int(item.get("count")) or 1, "serp_visible_domain")
    return sources


def default_owned_platforms(language: str, allowed_platforms: list[str]) -> list[tuple[str, str]]:
    if allowed_platforms:
        return [(item, "expert guide") for item in allowed_platforms[:12]]
    if language.startswith("ru"):
        return [
            ("external industry media / guest post", "expert guide"),
            ("partner or review site", "comparison page"),
            ("professional community discussion", "discussion seed"),
            ("Q&A/community answer", "checklist"),
            ("YouTube/Rutube", "video explainer"),
            ("directory or marketplace profile", "directory profile"),
            ("partner roundup", "partner roundup"),
            ("public checklist/template page", "template/tool"),
            ("case study on external blog", "case study"),
            ("research note on external platform", "research note"),
        ]
    return [
        ("Medium/Substack", "expert guide"),
        ("LinkedIn article", "expert guide"),
        ("Reddit or niche forum", "discussion seed"),
        ("Quora/Q&A answer", "checklist"),
        ("YouTube", "video explainer"),
        ("directory or marketplace profile", "directory profile"),
        ("partner roundup", "partner roundup"),
        ("public checklist/template page", "template/tool"),
        ("external case study", "case study"),
        ("comparison/review publication", "comparison page"),
    ]


def build_placement_rows(
    topic: str,
    analysis: dict[str, Any],
    cluster_queries: list[str] | None = None,
    product: str = "",
    target_action: str = "",
    geo: str = "",
    language: str = "",
    qfo_queries: list[str] | None = None,
    allowed_platforms: list[str] | None = None,
    serp_urls: list[str] | None = None,
    ai_urls: list[str] | None = None,
    max_ideas: int = 30,
) -> list[dict[str, Any]]:
    cluster_queries = dedupe_queries([q for q in (cluster_queries or []) if q])
    qfo_queries = [q for q in (qfo_queries or []) if q]
    allowed_platforms = [p for p in (allowed_platforms or []) if p]
    serp_urls = [u for u in (serp_urls or []) if u]
    ai_urls = [u for u in (ai_urls or []) if u]
    language = language or ""
    intent = infer_cluster_intent(topic, cluster_queries + qfo_queries, product, target_action)
    product_fit, product_fit_note = score_product_fit(topic, cluster_queries + qfo_queries, product, target_action, intent)
    rows: list[dict[str, Any]] = []
    seen_angles: set[str] = set()

    def add_row(strategy_type: str, platform: str, source_type: str, source_count: int, source_kind: str, url: str = "") -> None:
        nonlocal rows
        content_format = placement_content_format(source_type, strategy_type)
        angle = placement_angle(topic, product, target_action, intent, source_type, strategy_type)
        angle_key = f"{strategy_type}|{platform.lower()}|{content_format.lower()}|{intent.get('main_intent')}"
        quality_status, quality_reasons = placement_quality_gate(product_fit, strategy_type, source_type, platform, language, angle_key, seen_angles)
        if quality_status == "blocked":
            return
        seen_angles.add(angle_key)
        strength = evidence_strength_score(source_count, len(cluster_queries), len(qfo_queries), source_kind)
        platform_value = platform_value_score(source_type, source_count, strategy_type)
        feasibility, feasibility_note = feasibility_score(source_type, strategy_type, platform, allowed_platforms)
        score = product_fit + strength + platform_value + feasibility
        risk = "; ".join([product_fit_note, feasibility_note, *quality_reasons])
        if quality_status == "downgraded":
            score = min(score, 59)
        evidence_bits = [f"source={source_kind}", f"source_count={source_count}", f"cluster_queries={len(cluster_queries)}"]
        if qfo_queries:
            evidence_bits.append(f"qfo_or_fanout_queries={len(qfo_queries)}")
        if url:
            evidence_bits.append(f"url={url}")
        row = {
            "opportunity_id": f"pl-{len(rows)+1:03d}",
            "topic": topic,
            "product": product or "not provided",
            "strategy_type": strategy_type,
            "platform_or_domain": platform,
            "content_format": content_format,
            "placement_angle": angle,
            "why_user_would_need_product": intent.get("product_moment", ""),
            "expected_ai_signal": expected_ai_signal(source_type, strategy_type),
            "evidence": "; ".join(evidence_bits),
            "priority_score": min(100, max(0, score)),
            "product_fit_score": product_fit,
            "signal_strength_score": strength,
            "platform_value_score": platform_value,
            "feasibility_score": feasibility,
            "effort": placement_effort(feasibility),
            "risk_or_limitation": risk,
            "intent": intent.get("main_intent", ""),
            "subintents": ", ".join(intent.get("subintents", [])),
            "user_stage": intent.get("user_stage", ""),
            "commercial_motive": intent.get("commercial_motive", False),
            "source_url": url if strategy_type == "enter_existing" else "",
            "page_type": source_type,
            "quality_status": quality_status,
            "status": "draft" if quality_status == "pass" else "downgraded",
        }
        rows.append(row)

    for source in collect_existing_placement_sources(analysis, serp_urls, ai_urls):
        source_ref = source.get("url") or source.get("domain", "")
        source_type = classify_visible_source(source_ref)
        platform = source.get("domain") or normalize_domain(source_ref)
        add_row("enter_existing", platform, source_type, safe_int(source.get("count")) or 1, source.get("source_kind", "evidence"), source.get("url", ""))
        if len(rows) >= max_ideas:
            break

    if product_fit >= 18 and len(rows) < max_ideas:
        for platform, owned_type in default_owned_platforms(language, allowed_platforms):
            add_row("create_owned", platform, owned_type, 1, "owned_external_asset_hypothesis", "")
            if len(rows) >= max_ideas:
                break

    if not rows:
        rows.append({
            "opportunity_id": "pl-001",
            "topic": topic,
            "product": product or "not provided",
            "strategy_type": "blocked",
            "platform_or_domain": "",
            "content_format": "",
            "placement_angle": "No placement ideas passed the quality gate.",
            "why_user_would_need_product": intent.get("product_moment", ""),
            "expected_ai_signal": "none until product fit and evidence improve",
            "evidence": "No usable SERP/AI/QFO evidence or product fit.",
            "priority_score": 0,
            "product_fit_score": product_fit,
            "signal_strength_score": 0,
            "platform_value_score": 0,
            "feasibility_score": 0,
            "effort": "blocked",
            "risk_or_limitation": product_fit_note,
            "intent": intent.get("main_intent", ""),
            "subintents": ", ".join(intent.get("subintents", [])),
            "user_stage": intent.get("user_stage", ""),
            "commercial_motive": intent.get("commercial_motive", False),
            "source_url": "",
            "page_type": "needs_evidence",
            "quality_status": "blocked",
            "status": "blocked_needs_fit_or_evidence",
        })
    rows = sorted(rows, key=lambda row: (-safe_int(row.get("priority_score")), row.get("strategy_type", ""), row.get("platform_or_domain", "")))
    for idx, row in enumerate(rows[:max_ideas], start=1):
        row["opportunity_id"] = f"pl-{idx:03d}"
    return rows[:max_ideas]

def build_monitoring_rows(topic: str, cluster_queries: list[str], fanout_rows: list[dict[str, Any]], goal: str, brand_variants: list[str] | None = None) -> list[dict[str, Any]]:
    rows = []
    prompts = dedupe_queries([*cluster_queries, *[r["fanout_query"] for r in fanout_rows if r.get("priority") == "high"]])[:12]
    tracked_variants = dedupe_terms(brand_variants or [])
    for idx, prompt in enumerate(prompts, start=1):
        base = {
            "prompt_group_id": f"mon-{idx:03d}",
            "prompt": prompt,
            "target_goal": goal,
            "frequency": "weekly for 4 weeks, then monthly",
            "geo": "match project region and user/search GEO",
            "brand_variants_tracked": " | ".join(tracked_variants),
            "status": "draft",
        }
        rows.append({
            **base,
            "prompt_id": f"mon-{idx:03d}-url",
            "monitoring_layer": "url_citation",
            "kpi": "project URL/domain appears as final citation source",
            "kpi_url_citation": "project URL/domain appears as final citation source",
            "kpi_brand_solution": "tracked separately in brand_mention layer",
        })
        rows.append({
            **base,
            "prompt_id": f"mon-{idx:03d}-brand",
            "monitoring_layer": "brand_mention",
            "kpi": "approved brand/domain/product alias appears in AI answer body",
            "kpi_url_citation": "tracked separately in url_citation layer",
            "kpi_brand_solution": "approved brand/domain/product alias appears in AI answer body",
        })
    return rows


def load_env_values(root: Path, env_path: str = "") -> dict[str, str]:
    env_files = [root / ".env", root / ".env.local", root / ".env.example"]
    if env_path:
        env_files.insert(0, Path(env_path))
    values: dict[str, str] = {}
    for candidate in env_files:
        if candidate.exists():
            merge_env_values(values, parse_env_file(candidate))
    merge_env_values(values, dict(os.environ))
    return values


def xmlriver_accounts(env: dict[str, str]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    packed = (env.get("XMLRIVER_API") or "").strip()
    if packed:
        parts = [part.strip() for part in packed.split(":") if part.strip()]
        for idx in range(0, len(parts) - 1, 2):
            out.append((parts[idx], parts[idx + 1]))
    accounts = (env.get("XMLRIVER_ACCOUNTS") or "").strip()
    if accounts:
        for account in accounts.split(","):
            account = account.strip()
            if ":" in account:
                user_id, key = account.split(":", 1)
                out.append((user_id.strip(), key.strip()))
    user_id = env.get("XML_RIVER_USER_ID") or env.get("XMLRIVER_USER") or env.get("XMLRIVER_LOGIN") or ""
    key = env.get("XMLRIVER_KEY") or env.get("XML_RIVER_KEY") or env.get("XML_RIVER_API_KEY") or env.get("XMLRIVER_API_KEY") or env.get("XMLRIVER_TOKEN") or ""
    if user_id and key:
        out.append((user_id, key))
    seen: set[tuple[str, str]] = set()
    unique = []
    for user_id, key in out:
        pair = (user_id, key)
        if user_id and key and pair not in seen:
            seen.add(pair)
            unique.append(pair)
    return unique


def dataforseo_credentials(env: dict[str, str]) -> tuple[str, str]:
    basic = (env.get("DATAFORSEO_BASIC") or env.get("DataForSEO_Basic") or "").strip()
    if ":" in basic:
        login, password = basic.split(":", 1)
        return login.strip(), password.strip()
    login = env.get("DATA_FOR_SEO_LOGIN") or env.get("DATAFORSEO_LOGIN") or ""
    password = env.get("DATA_FOR_SEO_PASSWORD") or env.get("DATAFORSEO_PASSWORD") or ""
    return login, password


def provider_audit(project_dir: Path, provider: str = "all", env_path: str = "") -> dict[str, Any]:
    root = find_project_root(project_dir)
    ensure_dirs(root)
    env = load_env_values(root, env_path)
    xml_accounts = xmlriver_accounts(env)
    dataforseo_login, dataforseo_password = dataforseo_credentials(env)
    payload = {
        "generated_at": utc_now(),
        "provider_scope": provider,
        "xmlriver": {
            "configured": bool(xml_accounts),
            "account_count": len(xml_accounts),
            "supported_engines": sorted(XMLRIVER_ENDPOINTS.keys()),
            "credential_keys": [key for key in ["XMLRIVER_USER", "XMLRIVER_KEY", "XML_RIVER_USER_ID", "XML_RIVER_KEY", "XMLRIVER_API", "XMLRIVER_ACCOUNTS"] if env.get(key)],
            "network_test": "not_run",
        },
        "dataforseo": {
            "configured": bool(dataforseo_login and dataforseo_password),
            "implemented": True,
            "implemented_scope": "Google Organic Live Advanced parser and approval-gated live adapter",
            "credential_keys": [key for key in ["DATAFORSEO_BASIC", "DataForSEO_Basic", "DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD", "DATA_FOR_SEO_LOGIN", "DATA_FOR_SEO_PASSWORD"] if env.get(key)],
            "network_test": "not_run",
            "limitation": "Live DataForSEO calls require --network-approved, --paid-approved, credentials, query count, requested top URL count (`--depth`, not pagination pages), GEO/language approval, and explicit --load-async-ai-overview when that paid option is needed.",
        },
        "permission_boundary": "Live provider calls require explicit --network-approved and provider credentials. Secrets are masked and not written to reports.",
    }
    json_path = root / PROCESSED_REL / "provider_audit.json"
    report_path = root / REPORTS_REL / "PROVIDER_AUDIT.md"
    write_json(json_path, payload)
    write_text(report_path, build_provider_audit_report(payload))
    update_state(root, "Provider audit completed", [str(report_path), str(json_path)])
    return observation(
        "success",
        "Provider audit completed without live network calls.",
        items=[payload],
        evidence_refs=[str(report_path), str(json_path)],
        next_valid_actions=["collect_serp_dry_run", "collect_serp_with_network_approval"],
    )


def build_provider_audit_report(payload: dict[str, Any]) -> str:
    xmlriver = payload["xmlriver"]
    dataforseo = payload["dataforseo"]
    return f"""# PROVIDER_AUDIT

Generated: {payload['generated_at']}

## XMLRiver

- configured: {xmlriver['configured']}
- account count: {xmlriver['account_count']}
- supported engines: {', '.join(xmlriver['supported_engines'])}
- credential keys present: {', '.join(xmlriver['credential_keys']) or 'none'}
- network test: {xmlriver['network_test']}

## DataForSEO

- configured: {dataforseo['configured']}
- runtime implemented: {dataforseo['implemented']}
- implemented scope: {dataforseo.get('implemented_scope', '')}
- credential keys present: {', '.join(dataforseo['credential_keys']) or 'none'}
- limitation: {dataforseo['limitation']}

## Permission Boundary

{payload['permission_boundary']}
"""


def xmlriver_reference_files() -> dict[str, str]:
    return {
        "geo": XMLRIVER_GEO_FILE_URL,
        "countries": XMLRIVER_COUNTRY_FILE_URL,
        "languages": XMLRIVER_LANGUAGE_FILE_URL,
        "domains": XMLRIVER_DOMAIN_FILE_URL,
    }


def normalize_xmlriver_language(language: str, fallback: str = "en") -> str:
    value = (language or "").strip().lower()
    if not value:
        value = fallback
    return re.sub(r"[^a-z]", "", value)[:2] or fallback


def resolve_xmlriver_region(engine: str, region: str, language: str) -> dict[str, str]:
    raw_region = (region or "").strip()
    if "=" in raw_region:
        engine_regions: dict[str, str] = {}
        for part in raw_region.split(";"):
            if "=" not in part:
                raise ValueError(
                    f"Invalid XMLRiver composite region {region!r}. "
                    "Use google=<loc>;yandex=<lr>."
                )
            region_engine, region_id = (value.strip().lower() for value in part.split("=", 1))
            if region_engine not in {"google", "yandex"} or not re.fullmatch(r"\d+", region_id):
                raise ValueError(
                    f"Invalid XMLRiver composite region component {part!r}. "
                    "Use numeric google loc and yandex lr ids."
                )
            engine_regions[region_engine] = region_id
        if engine not in engine_regions:
            raise ValueError(f"XMLRiver composite region is missing {engine}=<id>.")
        key = engine_regions[engine]
    else:
        key = raw_region.lower().replace("_", "-").replace(",", "-")
        key = re.sub(r"\s+", "-", key)

    alias = XMLRIVER_REGION_MAP.get(key)
    language_code = normalize_xmlriver_language(language, alias.get("language", "en") if alias else "en")
    if engine == "google":
        if alias:
            return {"loc": alias["google_loc"], "lr": language_code}
        if re.fullmatch(r"\d+", key):
            return {"loc": key, "lr": language_code}
        raise ValueError(
            f"Unknown XMLRiver Google region {region!r}. Use a documented alias, a numeric Google loc id, "
            "or google=<loc>;yandex=<lr> for a dual-engine run."
        )
    if engine == "yandex":
        if alias:
            return {"lr": alias["yandex_lr"], "lang": language_code}
        if re.fullmatch(r"\d+", key):
            return {"lr": key, "lang": language_code}
        raise ValueError(
            f"Unknown XMLRiver Yandex region {region!r}. Use a documented alias, a numeric Yandex lr id, "
            "or google=<loc>;yandex=<lr> for a dual-engine run."
        )
    raise ValueError(f"Unsupported XMLRiver engine: {engine}")


def validate_serp_top_url_depth(depth: int, provider: str = "xmlriver") -> tuple[int, list[str]]:
    errors: list[str] = []
    try:
        requested_top_urls = int(depth)
    except (TypeError, ValueError):
        requested_top_urls = XMLRIVER_SERP_URLS_PER_PAGE
        errors.append("--depth must be an integer top-N URL count, not a pagination page count.")
    if requested_top_urls < 1:
        errors.append("--depth must be at least 1 organic URL.")
        requested_top_urls = 1
    if provider == "xmlriver" and requested_top_urls > XMLRIVER_MAX_TOP_URLS:
        errors.append(f"XMLRiver live SERP depth is capped at top-{XMLRIVER_MAX_TOP_URLS} organic URLs. Request a smaller --depth or split the scope explicitly.")
    return requested_top_urls, errors


def xmlriver_serp_page_count(top_urls: int) -> int:
    top_urls = max(1, int(top_urls or XMLRIVER_SERP_URLS_PER_PAGE))
    return (top_urls + XMLRIVER_SERP_URLS_PER_PAGE - 1) // XMLRIVER_SERP_URLS_PER_PAGE


def xmlriver_page_param(engine: str, zero_based_page_index: int) -> int:
    return zero_based_page_index + 1 if engine == "google" else zero_based_page_index


def xmlriver_paid_request_count(query_engine_pairs: int, top_urls: int) -> int:
    return max(0, int(query_engine_pairs)) * xmlriver_serp_page_count(top_urls)


def xmlriver_thread_slots(planned_paid_requests: int) -> int:
    return min(XMLRIVER_MAX_THREADS, max(0, int(planned_paid_requests or 0)))


def xmlriver_thread_scope(planned_paid_requests: int) -> dict[str, Any]:
    return {
        "xmlriver_max_threads": XMLRIVER_MAX_THREADS,
        "xmlriver_thread_slots_planned": xmlriver_thread_slots(planned_paid_requests),
        "xmlriver_thread_policy": "Use the maximum 10 XMLRiver live collection threads for the paid page-request queue; if fewer than 10 requests are pending, unused slots stay idle.",
    }


def xmlriver_paid_request_plan(plan: list[dict[str, Any]], top_urls: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    pages = xmlriver_serp_page_count(top_urls)
    for pair_index, item in enumerate(plan, start=1):
        engine = item.get("engine", "")
        for page_index in range(pages):
            rows.append({
                "paid_request_id": f"xmlriver_paid_{len(rows) + 1:04d}",
                "query_engine_pair_id": pair_index,
                "query": item.get("query", ""),
                "engine": engine,
                "requested_top_urls": top_urls,
                "xmlriver_results_per_page": XMLRIVER_SERP_URLS_PER_PAGE,
                "serp_page_index": page_index + 1,
                "page_param": xmlriver_page_param(engine, page_index),
                "page_param_note": "Google first page is 1; Yandex first page is 0",
                "xmlriver_max_threads": XMLRIVER_MAX_THREADS,
                "planned_thread_slot": ((len(rows)) % XMLRIVER_MAX_THREADS) + 1,
            })
    return rows


def serp_collection_plan(topic: str, cluster_query_values: list[str], language: str, engines: str, max_queries: int = 0) -> list[dict[str, Any]]:
    topic = repair_text_encoding(topic)
    language = repair_text_encoding(language)
    engines = repair_text_encoding(engines)
    query_values = dedupe_queries(cluster_query_values)
    if max_queries and max_queries > 0:
        query_values = query_values[:max_queries]
    engine_values = split_csv(engines) or ["google", "yandex"]
    return [
        {"query": query, "engine": engine, "source": "semantic_cluster_query", "topic": topic}
        for query in query_values
        for engine in engine_values
    ]


def collect_serp(
    project_dir: Path,
    topic: str,
    provider: str = "xmlriver",
    engines: str = "google,yandex",
    region: str = "RU-Moscow",
    language: str = "ru",
    seed_queries: str = "",
    cluster_queries: str = "",
    cluster_queries_file: str = "",
    depth: int = 20,
    max_queries: int = 0,
    include_ai: bool = False,
    network_approved: bool = False,
    paid_approved: bool = False,
    dry_run: bool = False,
    timeout: int = 60,
    env_path: str = "",
    load_async_ai_overview: bool = False,
    quick_cluster_mode: bool = False,
) -> dict[str, Any]:
    topic = repair_text_encoding(topic)
    engines = repair_text_encoding(engines)
    region = repair_text_encoding(region)
    language = repair_text_encoding(language)
    seed_queries = repair_text_encoding(seed_queries)
    cluster_queries = repair_text_encoding(cluster_queries)
    cluster_queries_file = repair_text_encoding(cluster_queries_file)
    root = find_project_root(project_dir)
    ensure_dirs(root)
    if not topic:
        return observation("blocked", "Topic is required for SERP collection.", next_valid_actions=["provide_topic"])
    topic_slug = slugify(topic)
    provider = provider.strip().lower()
    run_id = f"serp_{provider}_{sha12(topic + utc_now())}"
    config = load_config(root)
    semantic_queries = resolve_semantic_cluster_queries(root, topic, cluster_queries=cluster_queries, cluster_queries_file=cluster_queries_file, seed_queries=seed_queries, config=config)
    workflow_gate = full_workflow_prerequisite_gate(root)
    if workflow_gate.get("status") != "pass" and not quick_cluster_mode:
        report_path = root / REPORTS_REL / "SERP_COLLECTION.md"
        write_text(report_path, "# SERP_COLLECTION_BLOCKED\n\nFull SERP collection is blocked until project context, confirmed brand variants, and both audit decisions pass. Use explicit quick-cluster mode only for isolated QFO research with a user-supplied cluster.\n")
        return observation("blocked", "Full SERP collection requires completed context and audit gates; use --quick-cluster-mode only for isolated QFO research.", items=[workflow_gate], evidence_refs=[str(report_path)], next_valid_actions=workflow_gate.get("next_valid_actions", []))
    cluster_meta = semantic_cluster_meta(config.get("project", {}), topic)
    plan = serp_collection_plan(topic, semantic_queries, language, engines, max_queries)
    requested_top_urls, depth_errors = validate_serp_top_url_depth(depth, provider)
    region_errors: list[str] = []
    planned_engines = sorted({item["engine"] for item in plan})
    if provider == "xmlriver":
        normalized_region = (region or "").strip()
        if re.fullmatch(r"\d+", normalized_region) and len(planned_engines) > 1:
            region_errors.append(
                "A bare numeric XMLRiver region is ambiguous for a dual-engine run. "
                "Use a documented alias or google=<loc>;yandex=<lr>."
            )
        else:
            for engine_name in planned_engines:
                try:
                    resolve_xmlriver_region(engine_name, region, language)
                except ValueError as exc:
                    region_errors.append(str(exc))
    request_validation_errors = [*depth_errors, *region_errors]
    xmlriver_pages_per_pair = xmlriver_serp_page_count(requested_top_urls) if provider == "xmlriver" else 1
    planned_paid_requests = xmlriver_paid_request_count(len(plan), requested_top_urls) if provider == "xmlriver" else len(plan)
    paid_request_rows = xmlriver_paid_request_plan(plan, requested_top_urls) if provider == "xmlriver" else []
    xmlriver_thread_info = xmlriver_thread_scope(planned_paid_requests) if provider == "xmlriver" else {
        "xmlriver_max_threads": None,
        "xmlriver_thread_slots_planned": None,
        "xmlriver_thread_policy": "not_applicable",
    }
    plan_path = root / PROCESSED_REL / f"{topic_slug}_serp_collection_plan.json"
    plan_payload = {
        "run_id": run_id,
        "provider": provider,
        "topic": topic,
        "semantic_cluster_queries": semantic_queries,
        "cluster_query_count": len(semantic_queries),
        "semantic_cluster_topic": cluster_meta.get("semantic_cluster_topic") or topic,
        "semantic_cluster_status": cluster_meta.get("semantic_cluster_status"),
        "semantic_cluster_source": cluster_meta.get("semantic_cluster_source"),
        "semantic_cluster_confirmed": cluster_meta.get("semantic_cluster_confirmed"),
        "semantic_cluster_confirmation_required": not bool(semantic_queries),
        "max_queries_applied": max_queries if max_queries and max_queries > 0 else "all_cluster_queries",
        "depth": requested_top_urls,
        "requested_top_urls": requested_top_urls,
        "depth_semantics": "--depth is the requested organic URL count/top-N, not a pagination page count",
        "planned_query_engine_pairs": len(plan),
        "planned_paid_requests": planned_paid_requests,
        "paid_request_count": planned_paid_requests,
        "xmlriver_results_per_page": XMLRIVER_SERP_URLS_PER_PAGE if provider == "xmlriver" else None,
        "xmlriver_serp_pages_per_query_engine": xmlriver_pages_per_pair if provider == "xmlriver" else None,
        "xmlriver_paid_requests": paid_request_rows,
        **xmlriver_thread_info,
        "include_ai": include_ai,
        "ai_request_scope": "XMLRiver ai=1 is sent only on the first SERP page for each query-engine pair" if provider == "xmlriver" and include_ai else "not requested",
        "load_async_ai_overview": load_async_ai_overview,
        "region": region,
        "language": language,
        "xmlriver_reference_files": xmlriver_reference_files() if provider == "xmlriver" else {},
        "queries": plan,
        "depth_errors": depth_errors,
        "region_errors": region_errors,
        "request_validation_errors": request_validation_errors,
        "workflow_mode": "quick_cluster" if quick_cluster_mode else "full",
        "approval": {
            "approved_by": "cli_operator" if network_approved and paid_approved else "",
            "network_approved": bool(network_approved),
            "paid_approved": bool(paid_approved),
            "scope": {
                "provider": provider,
                "query_engine_pairs": len(plan),
                "planned_paid_requests": planned_paid_requests,
                "requested_top_urls": requested_top_urls,
                "engines": planned_engines,
                "region": region,
                "language": language,
                "include_ai": bool(include_ai),
            },
        },
        "max_async_ai_overview_extra_cost_usd": round(len(plan) * DATAFORSEO_ASYNC_AI_OVERVIEW_EXTRA_COST_USD, 6) if provider == "dataforseo" and include_ai and load_async_ai_overview else 0,
    }
    write_json(plan_path, plan_payload)
    if not semantic_queries:
        report_path = root / REPORTS_REL / "SERP_COLLECTION.md"
        write_text(report_path, build_serp_collection_report(topic, provider, plan, [], [], ["Semantic cluster queries are required. This agent collects SERP/AI evidence per user query in the topic cluster, not from the bare topic name."], region, language, plan_payload))
        return observation("blocked", "SERP collection requires semantic cluster queries for this topic.", items=[{"topic": topic, "cluster_query_count": 0}], evidence_refs=[str(report_path), str(plan_path)], next_valid_actions=["provide_cluster_queries", "rerun_collect_serp_with_cluster_queries", "run_init_project_with_cluster"])

    if provider not in {"xmlriver", "dataforseo"}:
        report_path = root / REPORTS_REL / "SERP_COLLECTION.md"
        write_text(report_path, build_serp_collection_report(topic, provider, plan, [], [], [f"Unsupported provider: {provider}. Supported: xmlriver, dataforseo."], region, language, plan_payload))
        return observation("blocked", "Unsupported SERP provider.", evidence_refs=[str(report_path), str(plan_path)], next_valid_actions=["use_xmlriver", "use_dataforseo", "manual_import"])

    if provider == "dataforseo":
        unsupported_engines = sorted({item["engine"] for item in plan if item["engine"] != "google"})
        if unsupported_engines:
            report_path = root / REPORTS_REL / "SERP_COLLECTION.md"
            write_text(report_path, build_serp_collection_report(topic, provider, plan, [], [], [f"DataForSEO adapter currently supports google only; unsupported engines: {', '.join(unsupported_engines)}."], region, language, plan_payload))
            return observation("blocked", "DataForSEO adapter currently supports google only.", evidence_refs=[str(report_path), str(plan_path)], next_valid_actions=["use_engines_google", "use_xmlriver_for_yandex"])

    if request_validation_errors:
        report_path = root / REPORTS_REL / "SERP_COLLECTION.md"
        write_text(report_path, build_serp_collection_report(topic, provider, plan, [], [], request_validation_errors, region, language, plan_payload))
        return observation(
            "invalid_args",
            "SERP collection request failed deterministic depth/region validation before any provider call.",
            items=[{"requested_top_urls": requested_top_urls, "errors": len(request_validation_errors)}],
            evidence_refs=[str(report_path), str(plan_path)],
            next_valid_actions=["fix_region_or_depth", "use_documented_region_alias", "use_depth_10_20_50_or_100"],
        )

    if dry_run or not network_approved or not paid_approved:
        report_path = root / REPORTS_REL / "SERP_COLLECTION.md"
        if dry_run:
            reason = "dry run"
        else:
            missing = []
            if not network_approved:
                missing.append("--network-approved")
            if not paid_approved:
                missing.append("--paid-approved")
            reason = "missing " + " and ".join(missing)
        write_text(report_path, build_serp_collection_report(topic, provider, plan, [], [], [f"Live collection not run: {reason}."], region, language, plan_payload))
        return observation(
            "success" if dry_run else "blocked",
            "SERP collection plan created." if dry_run else "Live SERP collection requires --network-approved and --paid-approved.",
            items=[{
                "provider": provider,
                "planned_query_engine_pairs": len(plan),
                "planned_requests": planned_paid_requests,
                "planned_paid_requests": planned_paid_requests,
                "cluster_queries": len(semantic_queries),
                "depth": requested_top_urls,
                "requested_top_urls": requested_top_urls,
                "xmlriver_serp_pages_per_query_engine": xmlriver_pages_per_pair if provider == "xmlriver" else None,
                "include_ai": include_ai,
                "load_async_ai_overview": load_async_ai_overview,
                "max_async_ai_overview_extra_cost_usd": round(len(plan) * DATAFORSEO_ASYNC_AI_OVERVIEW_EXTRA_COST_USD, 6) if provider == "dataforseo" and include_ai and load_async_ai_overview else 0,
                "xmlriver_max_threads": xmlriver_thread_info.get("xmlriver_max_threads"),
                "xmlriver_thread_slots_planned": xmlriver_thread_info.get("xmlriver_thread_slots_planned"),
            }],
            evidence_refs=[str(report_path), str(plan_path)],
            next_valid_actions=["review_plan", "rerun_with_network_and_paid_approved", "manual_import"],
        )

    env = load_env_values(root, env_path)
    raw_dir = root / RAW_REL / "serp" / run_id
    serp_rows: list[dict[str, Any]] = []
    ai_rows: list[dict[str, Any]] = []
    errors: list[str] = []
    provider_request_stats = {
        "paid_request_count": planned_paid_requests,
        "paid_requests_succeeded": 0,
        "paid_requests_failed": 0,
        "request_meta_refs": [],
    }

    if provider == "xmlriver":
        accounts = xmlriver_accounts(env)
        if not accounts:
            report_path = root / REPORTS_REL / "SERP_COLLECTION.md"
            write_text(report_path, build_serp_collection_report(topic, provider, plan, [], [], ["XMLRiver credentials not found."], region, language, plan_payload))
            return observation("blocked", "XMLRiver credentials are required.", evidence_refs=[str(report_path), str(plan_path)], next_valid_actions=["add_xmlriver_credentials", "manual_import"])
        try:
            collected = collect_xmlriver_plan_parallel(plan, requested_top_urls, region, language, include_ai, accounts, raw_dir, timeout)
            serp_rows.extend(collected.get("serp_rows", []))
            ai_rows.extend(collected.get("ai_rows", []))
            errors.extend(collected.get("errors", []))
            xmlriver_thread_info = {
                **xmlriver_thread_info,
                "xmlriver_thread_slots_used": collected.get("xmlriver_thread_slots_planned", xmlriver_thread_info.get("xmlriver_thread_slots_planned")),
            }
            provider_request_stats = {
                "paid_request_count": collected.get("paid_request_count", planned_paid_requests),
                "paid_requests_succeeded": collected.get("paid_requests_succeeded", 0),
                "paid_requests_failed": collected.get("paid_requests_failed", len(collected.get("errors", []))),
                "request_meta_refs": collected.get("request_meta_refs", []),
            }
        except Exception as exc:  # noqa: BLE001
            provider_request_stats["paid_requests_failed"] = planned_paid_requests
            provider_request_stats["request_meta_refs"] = [str(path) for path in sorted(raw_dir.glob("*.request.json"))]
            errors.append(f"xmlriver_parallel_collection: {type(exc).__name__}: {exc}")
    else:
        login, password = dataforseo_credentials(env)
        if not login or not password:
            report_path = root / REPORTS_REL / "SERP_COLLECTION.md"
            write_text(report_path, build_serp_collection_report(topic, provider, plan, [], [], ["DataForSEO credentials not found."], region, language, plan_payload))
            return observation("blocked", "DataForSEO credentials are required.", evidence_refs=[str(report_path), str(plan_path)], next_valid_actions=["add_dataforseo_credentials", "manual_import"])
        for item in plan:
            try:
                collected = collect_dataforseo_query(item["query"], requested_top_urls, region, language, include_ai, load_async_ai_overview, (login, password), raw_dir, timeout)
                serp_rows.extend(collected["serp_rows"])
                ai_rows.extend(collected["ai_rows"])
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{item['engine']} / {item['query']}: {type(exc).__name__}: {exc}")

    provider_slug = slugify(provider)
    provider_serp_path = root / PROCESSED_REL / f"{topic_slug}_{provider_slug}_live_serp_rows.csv"
    provider_ai_path = root / PROCESSED_REL / f"{topic_slug}_{provider_slug}_live_ai_answers.csv"
    legacy_serp_path = root / PROCESSED_REL / f"{topic_slug}_live_serp_rows.csv"
    legacy_ai_path = root / PROCESSED_REL / f"{topic_slug}_live_ai_answers.csv"
    source_type = f"{provider}_live"
    legacy_serp_rows = [row for row in read_csv(legacy_serp_path) if row.get("source_type") != source_type]
    legacy_ai_rows = [row for row in read_csv(legacy_ai_path) if row.get("provider") != provider]
    write_csv(provider_serp_path, serp_rows)
    write_csv(provider_ai_path, ai_rows)
    write_csv(legacy_serp_path, [*legacy_serp_rows, *serp_rows])
    write_csv(legacy_ai_path, [*legacy_ai_rows, *ai_rows])
    report_path = root / REPORTS_REL / "SERP_COLLECTION.md"
    execution_scope = {**plan_payload, **xmlriver_thread_info, **provider_request_stats}
    write_text(report_path, build_serp_collection_report(topic, provider, plan, serp_rows, ai_rows, errors, region, language, execution_scope))
    write_json(raw_dir / "collection_summary.json", {
        "run_id": run_id,
        "provider": provider,
        "topic": topic,
        "topic_slug": topic_slug,
        "network_approved": True,
        "paid_approved": True,
        "approved_by": "cli_operator",
        "approval_scope": plan_payload.get("approval", {}).get("scope", {}),
        "region": region,
        "language": language,
        "engines": sorted({item["engine"] for item in plan}),
        "semantic_cluster_queries": semantic_queries,
        "cluster_query_count": len(semantic_queries),
        "semantic_cluster_topic": cluster_meta.get("semantic_cluster_topic") or topic,
        "semantic_cluster_status": cluster_meta.get("semantic_cluster_status"),
        "semantic_cluster_source": cluster_meta.get("semantic_cluster_source"),
        "semantic_cluster_confirmed": cluster_meta.get("semantic_cluster_confirmed"),
        "semantic_cluster_confirmation_required": not bool(semantic_queries),
        "depth": requested_top_urls,
        "requested_top_urls": requested_top_urls,
        "depth_semantics": "--depth is the requested organic URL count/top-N, not a pagination page count",
        "planned_query_engine_pairs": len(plan),
        "planned_paid_requests": planned_paid_requests,
        "paid_request_count": planned_paid_requests,
        "xmlriver_results_per_page": XMLRIVER_SERP_URLS_PER_PAGE if provider == "xmlriver" else None,
        "xmlriver_serp_pages_per_query_engine": xmlriver_pages_per_pair if provider == "xmlriver" else None,
        "include_ai": include_ai,
        "load_async_ai_overview": load_async_ai_overview,
        "xmlriver_reference_files": xmlriver_reference_files() if provider == "xmlriver" else {},
        **xmlriver_thread_info,
        "planned_requests": planned_paid_requests,
        **provider_request_stats,
        "serp_rows": len(serp_rows),
        "ai_answer_rows": len(ai_rows),
        "errors": errors,
        "generated_at": utc_now(),
    })
    if errors:
        # Any failed page is a failed requested live run. Preserve partial rows for
        # diagnosis, but never advertise them as downstream-ready evidence.
        status = "error"
        summary = f"Live {provider} collection failed with provider errors; partial rows are quarantined for diagnosis only."
    elif serp_rows or ai_rows:
        status = "success"
        summary = f"Live {provider} collection completed."
    else:
        status = "error"
        summary = f"Live {provider} collection returned no usable SERP or AI rows."
    return observation(
        status,
        summary,
        items=[{"run_id": run_id, "provider": provider, "planned_query_engine_pairs": len(plan), "planned_requests": planned_paid_requests, "planned_paid_requests": planned_paid_requests, "requested_top_urls": requested_top_urls, "xmlriver_max_threads": xmlriver_thread_info.get("xmlriver_max_threads"), "xmlriver_thread_slots_used": xmlriver_thread_info.get("xmlriver_thread_slots_used", xmlriver_thread_info.get("xmlriver_thread_slots_planned")), "paid_requests_succeeded": provider_request_stats.get("paid_requests_succeeded"), "paid_requests_failed": provider_request_stats.get("paid_requests_failed"), "serp_rows": len(serp_rows), "ai_answer_rows": len(ai_rows), "errors": len(errors)}],
        evidence_refs=[str(report_path), str(provider_serp_path), str(provider_ai_path), str(legacy_serp_path), str(legacy_ai_path), str(raw_dir / "collection_summary.json")],
        next_valid_actions=["review_errors", "repair_live_collection_scope_or_provider", "rerun_collect_serp"] if errors else ["run_topic_with_collected_csv", "enrich_urls"],
    )


def collect_dataforseo_query(
    query: str,
    depth: int,
    region: str,
    language: str,
    include_ai: bool,
    load_async_ai_overview: bool,
    credentials: tuple[str, str],
    raw_dir: Path,
    timeout: int,
) -> dict[str, list[dict[str, Any]]]:
    login, password = credentials
    task: dict[str, Any] = {
        "keyword": query,
        "language_code": (language[:2] or "en").lower(),
        "depth": depth,
    }
    task.update(dataforseo_location_payload(region))
    if include_ai:
        task["include_ai_overview"] = True
    if load_async_ai_overview:
        task["load_async_ai_overview"] = True
    payload = [task]
    auth = base64.b64encode(f"{login}:{password}".encode("utf-8")).decode("ascii")
    req = urllib.request.Request(
        DATAFORSEO_ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Basic {auth}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = decode_text_bytes(resp.read(), resp.headers.get("content-type", ""), source=DATAFORSEO_ENDPOINT)[0]
    query_slug = slugify(f"dataforseo-google-{query}")[:90]
    raw_path = raw_dir / f"{query_slug}.json"
    meta_path = raw_dir / f"{query_slug}.request.json"
    write_text(raw_path, raw)
    write_json(meta_path, {"query": query, "provider": "dataforseo", "engine": "google", "depth": depth, "region": region, "language": language, "include_ai": include_ai, "load_async_ai_overview": load_async_ai_overview, "endpoint": DATAFORSEO_ENDPOINT})
    return parse_dataforseo_response(raw, query, "google", depth, str(raw_path))


def dataforseo_location_payload(region: str) -> dict[str, Any]:
    value = (region or "").strip()
    if not value:
        return {}
    if re.fullmatch(r"\d+", value):
        return {"location_code": int(value)}
    key = value.lower()
    normalized = value.replace("-", ", ").lower()
    code = DATAFORSEO_LOCATION_CODES.get(key) or DATAFORSEO_LOCATION_CODES.get(normalized)
    if code:
        return {"location_code": code}
    # DataForSEO Google Organic Live Advanced rejects location_name; omit unknown aliases instead of sending an invalid field.
    return {}


def parse_dataforseo_response(raw: str, query: str, engine: str, depth: int, raw_ref: str) -> dict[str, list[dict[str, Any]]]:
    response = json.loads(raw)
    serp_rows: list[dict[str, Any]] = []
    ai_rows: list[dict[str, Any]] = []
    for task in response.get("tasks") or []:
        for result in task.get("result") or []:
            for item in result.get("items") or []:
                if not isinstance(item, dict):
                    continue
                item_type = str(item.get("type") or "")
                if item_type == "organic" and item.get("url"):
                    rank = safe_int(item.get("rank_absolute") or item.get("rank_group") or len(serp_rows) + 1)
                    serp_rows.append({
                        "query": query,
                        "engine": engine,
                        "position": rank,
                        "url": item.get("url") or "",
                        "title": item.get("title") or "",
                        "snippet": item.get("description") or item.get("snippet") or "",
                        "source_type": "dataforseo_live",
                        "cited_in_ai": False,
                        "raw_ref": raw_ref,
                    })
                    if len(serp_rows) >= depth:
                        continue
                if "ai_overview" not in item_type:
                    continue
                references: list[dict[str, Any]] = []
                collect_dataforseo_ai_references(item, references)
                answer_text = "\n".join(dataforseo_text_fragments(item))[:12000]
                if not references:
                    ai_rows.append({
                        "answer_id": sha12(f"dataforseo:{engine}:{query}:{answer_text}"),
                        "prompt": query,
                        "provider": "dataforseo",
                        "model": item_type,
                        "target_geo": "",
                        "user_search_geo": "",
                        "language": "",
                        "answer_text": answer_text,
                        "citation_url": "",
                        "citation_title": "",
                        "brand_mentioned": False,
                        "project_url_cited": False,
                        "date": utc_now(),
                        "raw_ref": raw_ref,
                    })
                for idx, ref in enumerate(references, start=1):
                    ai_rows.append({
                        "answer_id": sha12(f"dataforseo:{engine}:{query}:{idx}:{ref.get('cited_url', '')}"),
                        "prompt": query,
                        "provider": "dataforseo",
                        "model": item_type,
                        "target_geo": "",
                        "user_search_geo": "",
                        "language": "",
                        "answer_text": answer_text,
                        "citation_url": ref.get("cited_url") or "",
                        "citation_title": ref.get("title") or ref.get("source") or "",
                        "brand_mentioned": False,
                        "project_url_cited": False,
                        "date": utc_now(),
                        "raw_ref": raw_ref,
                    })
    return {"serp_rows": serp_rows[:depth], "ai_rows": ai_rows}


def collect_dataforseo_ai_references(value: Any, out: list[dict[str, Any]]) -> None:
    if isinstance(value, list):
        for item in value:
            collect_dataforseo_ai_references(item, out)
        return
    if not isinstance(value, dict):
        return
    if value.get("type") == "ai_overview_reference" or (value.get("url") and any(value.get(key) for key in ("title", "text", "source", "domain"))):
        out.append({
            "source": value.get("source") or "",
            "domain": value.get("domain") or "",
            "cited_url": value.get("url") or "",
            "title": value.get("title") or "",
            "reference_text": value.get("text") or "",
            "citation_context": value.get("snippet") or value.get("description") or "",
        })
    for nested_key in ("items", "components", "expanded_element", "references", "top_sights", "about_this_result"):
        if nested_key in value:
            collect_dataforseo_ai_references(value[nested_key], out)


def dataforseo_text_fragments(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, list):
        out: list[str] = []
        for item in value:
            out.extend(dataforseo_text_fragments(item))
        return out
    if isinstance(value, dict):
        out = []
        for key in ("markdown", "text", "title", "snippet", "description"):
            if isinstance(value.get(key), str) and value.get(key).strip():
                out.append(value[key].strip())
        for key in ("items", "components", "expanded_element", "references"):
            if key in value:
                out.extend(dataforseo_text_fragments(value[key]))
        return out
    return []

def collect_xmlriver_page_request(
    request_row: dict[str, Any],
    depth: int,
    region: str,
    language: str,
    include_ai: bool,
    account: tuple[str, str],
    raw_dir: Path,
    timeout: int,
) -> dict[str, Any]:
    query = repair_text_encoding(str(request_row.get("query", "")))
    engine = repair_text_encoding(str(request_row.get("engine", ""))).strip().lower()
    region = repair_text_encoding(region)
    language = repair_text_encoding(language)
    requested_top_urls, depth_errors = validate_serp_top_url_depth(depth, "xmlriver")
    if depth_errors:
        raise ValueError(" ".join(depth_errors))
    if engine not in XMLRIVER_ENDPOINTS:
        raise ValueError(f"Unsupported XMLRiver engine: {engine}")
    page_index = int(request_row.get("serp_page_index") or 1) - 1
    if page_index < 0:
        raise ValueError("XMLRiver SERP page index must be 1-based in request rows.")
    top_for_page = max(0, min(XMLRIVER_SERP_URLS_PER_PAGE, requested_top_urls - (page_index * XMLRIVER_SERP_URLS_PER_PAGE)))
    if top_for_page <= 0:
        return {"serp_rows": [], "ai_rows": [], "request_meta": []}
    page_param = xmlriver_page_param(engine, page_index)
    request_includes_ai = bool(include_ai and page_index == 0)
    user_id, key = account
    region_params = resolve_xmlriver_region(engine, region, language)
    params: dict[str, Any] = {
        "user": user_id,
        "key": key,
        "query": query,
        **region_params,
        "groupby": XMLRIVER_SERP_URLS_PER_PAGE,
        "page": page_param,
    }
    if request_includes_ai:
        params["ai"] = 1
    paid_request_id = str(request_row.get("paid_request_id") or f"xmlriver_page_{page_index + 1:04d}")
    query_slug = slugify(f"{engine}-{query}")[:80]
    raw_path = raw_dir / f"{paid_request_id}_{query_slug}_page-{page_param}.xml"
    meta_path = raw_dir / f"{paid_request_id}_{query_slug}_page-{page_param}.request.json"
    safe_params = {name: value for name, value in params.items() if name not in {"user", "key"}}
    request_meta = {
        "paid_request_id": paid_request_id,
        "query_engine_pair_id": request_row.get("query_engine_pair_id"),
        "planned_thread_slot": request_row.get("planned_thread_slot"),
        "credential_slot": request_row.get("credential_slot"),
        "xmlriver_max_threads": XMLRIVER_MAX_THREADS,
        "query": query,
        "engine": engine,
        "depth": requested_top_urls,
        "requested_top_urls": requested_top_urls,
        "depth_semantics": "--depth is the requested organic URL count/top-N, not a pagination page count",
        "xmlriver_results_per_page": XMLRIVER_SERP_URLS_PER_PAGE,
        "serp_pages_per_query_engine": xmlriver_serp_page_count(requested_top_urls),
        "serp_page_index": page_index + 1,
        "page_param": page_param,
        "page_param_note": "Google first page is 1; Yandex first page is 0",
        "region": region,
        "language": language,
        "include_ai": request_includes_ai,
        "endpoint": XMLRIVER_ENDPOINTS[engine],
        "params": safe_params,
        "xmlriver_reference_files": xmlriver_reference_files(),
        "status": "planned",
        "started_at": utc_now(),
    }
    write_json(meta_path, request_meta)
    raw_bytes = b""
    try:
        url = f"{XMLRIVER_ENDPOINTS[engine]}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"User-Agent": f"geo-topic-agent/{PACKAGE_VERSION}"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw_bytes = resp.read()
            http_status = int(getattr(resp, "status", 200) or 200)
            content_type = str(resp.headers.get("Content-Type", ""))
        write_raw_bytes(raw_path, raw_bytes)
        xml_text, decoded_with = decode_xmlriver_response_bytes(raw_bytes, content_type)
        serp_rows = parse_xmlriver_organic(
            xml_text,
            query,
            engine,
            top_for_page,
            str(raw_path),
            start_position=(page_index * XMLRIVER_SERP_URLS_PER_PAGE) + 1,
        )
        ai_rows = parse_xmlriver_ai_sources(xml_text, query, engine, str(raw_path)) if request_includes_ai else []
        write_json(meta_path, {
            **request_meta,
            "status": "success",
            "completed_at": utc_now(),
            "http_status": http_status,
            "content_type": content_type,
            "decoded_with": decoded_with,
            "raw_bytes": len(raw_bytes),
            "raw_sha256": hashlib.sha256(raw_bytes).hexdigest(),
            "serp_rows": len(serp_rows),
            "ai_rows": len(ai_rows),
        })
        return {"serp_rows": serp_rows, "ai_rows": ai_rows, "request_meta": [str(meta_path)]}
    except Exception as exc:
        if raw_bytes and not raw_path.exists():
            write_raw_bytes(raw_path, raw_bytes)
        write_json(meta_path, {
            **request_meta,
            "status": "error",
            "completed_at": utc_now(),
            "raw_bytes": len(raw_bytes),
            "raw_sha256": hashlib.sha256(raw_bytes).hexdigest() if raw_bytes else "",
            "error_type": type(exc).__name__,
            "error_summary": bounded_text(str(exc), 1000),
        })
        raise

def collect_xmlriver_plan_parallel(
    plan: list[dict[str, Any]],
    depth: int,
    region: str,
    language: str,
    include_ai: bool,
    accounts: list[tuple[str, str]],
    raw_dir: Path,
    timeout: int,
) -> dict[str, Any]:
    requested_top_urls, depth_errors = validate_serp_top_url_depth(depth, "xmlriver")
    if depth_errors:
        raise ValueError(" ".join(depth_errors))
    if not accounts:
        raise ValueError("XMLRiver credentials are required.")
    paid_requests = xmlriver_paid_request_plan(plan, requested_top_urls)
    serp_results: list[tuple[int, list[dict[str, Any]]]] = []
    ai_results: list[tuple[int, list[dict[str, Any]]]] = []
    request_meta_refs: list[str] = []
    completed_requests = 0
    errors: list[str] = []
    if not paid_requests:
        return {"serp_rows": [], "ai_rows": [], "errors": [], **xmlriver_thread_scope(0)}
    with ThreadPoolExecutor(max_workers=XMLRIVER_MAX_THREADS) as executor:
        futures = {}
        engine_account_counters: dict[str, int] = {}
        for order, request_row in enumerate(paid_requests):
            engine = str(request_row.get("engine") or "").casefold()
            account_index = engine_account_counters.get(engine, 0) % len(accounts)
            engine_account_counters[engine] = engine_account_counters.get(engine, 0) + 1
            scheduled_row = {**request_row, "credential_slot": account_index + 1}
            account = accounts[account_index]
            futures[executor.submit(collect_xmlriver_page_request, scheduled_row, requested_top_urls, region, language, include_ai, account, raw_dir, timeout)] = (order, scheduled_row)
        for future in as_completed(futures):
            order, request_row = futures[future]
            try:
                collected = future.result()
                completed_requests += 1
                serp_results.append((order, collected.get("serp_rows", [])))
                ai_results.append((order, collected.get("ai_rows", [])))
                request_meta_refs.extend(collected.get("request_meta", []))
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{request_row.get('engine')} / {request_row.get('query')} / page={request_row.get('page_param')}: {type(exc).__name__}: {exc}")
    serp_rows: list[dict[str, Any]] = []
    ai_rows: list[dict[str, Any]] = []
    for _, rows in sorted(serp_results, key=lambda item: item[0]):
        serp_rows.extend(rows)
    for _, rows in sorted(ai_results, key=lambda item: item[0]):
        ai_rows.extend(rows)
    request_meta_refs = [str(path) for path in sorted(raw_dir.glob("*.request.json"))]
    return {
        "serp_rows": serp_rows,
        "ai_rows": ai_rows,
        "errors": errors,
        "paid_request_count": len(paid_requests),
        "paid_requests_succeeded": completed_requests,
        "paid_requests_failed": len(errors),
        "request_meta_refs": request_meta_refs,
        **xmlriver_thread_scope(len(paid_requests)),
    }


def collect_xmlriver_query(
    query: str,
    engine: str,
    depth: int,
    region: str,
    language: str,
    include_ai: bool,
    account: tuple[str, str],
    raw_dir: Path,
    timeout: int,
) -> dict[str, list[dict[str, Any]]]:
    query = repair_text_encoding(query)
    engine = repair_text_encoding(engine).strip().lower()
    collected = collect_xmlriver_plan_parallel(
        [{"query": query, "engine": engine, "source": "direct_xmlriver_query", "topic": query}],
        depth,
        region,
        language,
        include_ai,
        [account],
        raw_dir,
        timeout,
    )
    if collected.get("errors"):
        raise RuntimeError("; ".join(collected["errors"]))
    return {"serp_rows": collected.get("serp_rows", [])[:depth], "ai_rows": collected.get("ai_rows", [])}

def xml_local_name(tag: Any) -> str:
    return str(tag or "").rsplit("}", 1)[-1].casefold()


def iter_xml_local(parent: ET.Element, name: str) -> list[ET.Element]:
    expected = name.casefold()
    return [element for element in parent.iter() if xml_local_name(element.tag) == expected]


def child_xml_text(parent: ET.Element, *names: str) -> str:
    expected = {name.casefold() for name in names}
    for child in list(parent):
        if xml_local_name(child.tag) in expected:
            return "".join(child.itertext())
    return ""


def parse_xmlriver_organic(xml_text: str, query: str, engine: str, top: int, raw_ref: str, start_position: int = 1) -> list[dict[str, Any]]:
    root = parse_xmlriver_root_or_raise(xml_text)
    rows = []
    for doc in iter_xml_local(root, "doc"):
        url = normalize_ws(child_xml_text(doc, "url"))
        ctype = normalize_ws(child_xml_text(doc, "contenttype") or "organic")
        if not url or ctype != "organic":
            continue
        rows.append({
            "query": repair_text_encoding(query),
            "engine": repair_text_encoding(engine),
            "position": start_position + len(rows),
            "url": html.unescape(url),
            "title": normalize_ws(repair_text_encoding(child_xml_text(doc, "title"))),
            "snippet": normalize_ws(repair_text_encoding(child_xml_text(doc, "passages") or child_xml_text(doc, "snippet"))),
            "source_type": "xmlriver_live",
            "cited_in_ai": False,
            "raw_ref": raw_ref,
        })
        if len(rows) >= top:
            break
    return rows


def parse_xmlriver_ai_sources(xml_text: str, query: str, engine: str, raw_ref: str) -> list[dict[str, Any]]:
    root = parse_xmlriver_root_or_raise(xml_text)
    ai_elements = iter_xml_local(root, "ai")
    if not ai_elements:
        return []

    answer_parts: list[str] = []
    presence_only = False
    for ai_el in ai_elements:
        presence_only = presence_only or normalize_ws(child_xml_text(ai_el, "present")) == "1"
        for node in [*iter_xml_local(ai_el, "answer"), *iter_xml_local(ai_el, "content")]:
            encoded = normalize_ws("".join(node.itertext()))
            if not encoded:
                continue
            decoded = repair_text_encoding(decode_maybe_base64(encoded))
            if decoded and decoded not in answer_parts:
                answer_parts.append(decoded)
    answer_text = "\n".join(answer_parts)
    if answer_text and is_xmlriver_error_payload(answer_text):
        raise RuntimeError("XMLRiver AI block contains an error payload; response excluded from processed evidence.")

    candidates: list[dict[str, str]] = []
    for ai_el in ai_elements:
        source_nodes = [element for element in ai_el.iter() if xml_local_name(element.tag) in {"item", "source", "doc"}]
        for item in source_nodes:
            citation_url = normalize_ai_citation_url(child_xml_text(item, "url", "link", "href"))
            citation_title = normalize_ws(repair_text_encoding(child_xml_text(item, "title", "name", "source")))
            if citation_url:
                candidates.append({"url": citation_url, "title": citation_title, "source": "xmlriver_source_item"})
        for element in ai_el.iter():
            for attr_name in ("href", "data-url", "data-href"):
                citation_url = normalize_ai_citation_url(str(element.attrib.get(attr_name, "")))
                if citation_url:
                    candidates.append({"url": citation_url, "title": "", "source": "xmlriver_source_attribute"})
    for url in extract_ai_citation_urls(answer_text):
        candidates.append({"url": url, "title": "", "source": "answer_html"})

    seen: set[str] = set()
    deduped: list[dict[str, str]] = []
    for item in candidates:
        key = item.get("url", "").casefold()
        if key and key not in seen:
            seen.add(key)
            deduped.append(item)

    content_status = "expanded" if answer_text else ("sources_only" if deduped else "presence_only")
    if not deduped and (answer_text or presence_only or any(iter_xml_local(ai_el, "item") for ai_el in ai_elements)):
        return [{
            "answer_id": sha12(f"{engine}:{query}:{answer_text}:{content_status}"),
            "prompt": repair_text_encoding(query),
            "provider": "xmlriver",
            "model": f"{engine}_ai_block",
            "target_geo": "",
            "user_search_geo": "",
            "language": "",
            "answer_text": answer_text,
            "citation_url": "",
            "citation_title": "",
            "brand_mentioned": False,
            "project_url_cited": False,
            "date": utc_now(),
            "raw_ref": raw_ref,
            "citation_source": "answer_only" if answer_text else "presence_only",
            "ai_content_status": content_status,
        }]

    rows: list[dict[str, Any]] = []
    for idx, item in enumerate(deduped, start=1):
        citation_url = item.get("url", "")
        citation_title = item.get("title", "")
        rows.append({
            "answer_id": sha12(f"{engine}:{query}:{idx}:{citation_url}:{citation_title}"),
            "prompt": repair_text_encoding(query),
            "provider": "xmlriver",
            "model": f"{engine}_ai_block",
            "target_geo": "",
            "user_search_geo": "",
            "language": "",
            "answer_text": answer_text,
            "citation_url": citation_url,
            "citation_title": citation_title,
            "brand_mentioned": False,
            "project_url_cited": False,
            "date": utc_now(),
            "raw_ref": raw_ref,
            "citation_source": item.get("source", "answer_html"),
            "ai_content_status": content_status,
        })
    return rows


def text_of(parent: ET.Element, tag: str) -> str:
    return child_xml_text(parent, tag)

def decode_maybe_base64(value: str) -> str:
    text = normalize_ws(value)
    if not text:
        return ""
    try:
        payload = base64.b64decode(text, validate=True)
    except (ValueError, base64.binascii.Error):
        return html.unescape(text)
    failures: list[str] = []
    for encoding in ("utf-8", "cp1251"):
        try:
            decoded = payload.decode(encoding)
            if decoded.strip():
                return normalize_ws(decoded)
        except UnicodeDecodeError:
            failures.append(encoding)
    raise UnicodeError(f"Valid base64 AI content could not be decoded without data loss using {', '.join(failures)}.")


def decode_escaped_url_text(value: str) -> str:
    text = repair_text_encoding(html.unescape(value or ""))
    return (
        text.replace("\\u003d", "=")
        .replace("\\u0026", "&")
        .replace("\\u002f", "/")
        .replace("\\/", "/")
    )


def normalize_ai_citation_url(value: str) -> str:
    raw = decode_escaped_url_text(value).strip().strip("'\".,;)]}")
    if not raw:
        return ""
    if raw.startswith("//"):
        raw = "https:" + raw
    if raw.startswith("/url?") or raw.startswith("/search?"):
        raw = "https://www.google.com" + raw
    if not re.match(r"(?i)^https?://", raw):
        return ""
    raw = decode_escaped_url_text(urllib.parse.unquote(raw))
    parsed = urllib.parse.urlparse(raw)
    host = parsed.netloc.lower().removeprefix("www.")
    query = urllib.parse.parse_qs(parsed.query)
    redirect_values = query.get("url") or query.get("q")
    if (host in {"google.com", "www.google.com"} or parsed.netloc.lower() in _AI_GOOGLE_HOSTS) and redirect_values:
        return normalize_ai_citation_url(redirect_values[0])
    if host.endswith("gstatic.com") and query.get("url"):
        return normalize_ai_citation_url(query["url"][0])
    if host in _AI_SKIP_HOSTS or any(host.endswith(suffix) for suffix in _AI_SKIP_HOST_SUFFIXES):
        return ""
    if raw.startswith("data:") or parsed.scheme not in {"http", "https"}:
        return ""
    for marker in ["&ved=", "?ved=", "&opi=", "?opi=", "&cd", "&psig=", "&ust="]:
        if marker in raw:
            raw = raw.split(marker, 1)[0]
    raw = raw.rstrip("\\.,;)]}'\"")
    return html.unescape(raw)


def strip_ai_ui_control_lines(value: str) -> str:
    control_lines = {
        "\u0440\u0430\u0437\u0432\u0435\u0440\u043d\u0443\u0442\u044c",
        "\u0441\u0432\u0435\u0440\u043d\u0443\u0442\u044c",
        "\u043f\u043e\u043a\u0430\u0437\u0430\u0442\u044c \u0435\u0449\u0451",
        "\u043f\u043e\u043a\u0430\u0437\u0430\u0442\u044c \u0435\u0449\u0435",
        "\u0435\u0449\u0451",
        "\u0435\u0449\u0435",
        "show more",
        "more",
        "expand",
        "collapse",
    }
    cleaned: list[str] = []
    for line in str(value or "").splitlines():
        item = normalize_ws(line)
        folded = item.casefold()
        if not item:
            continue
        if folded in control_lines:
            continue
        if re.fullmatch(r"\d+\s+(?:sites?|sources?)", folded):
            continue
        if re.fullmatch(r"\d+\s+(?:\u0441\u0430\u0439\u0442|\u0441\u0430\u0439\u0442\u0430|\u0441\u0430\u0439\u0442\u043e\u0432|\u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a|\u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0430|\u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u043e\u0432)", folded):
            continue
        cleaned.append(item)
    return "\n".join(cleaned)

def strip_html_for_text(value: str) -> str:
    text = decode_escaped_url_text(value)
    text = re.sub(r"(?is)<script\b.*?</script>", " ", text)
    text = re.sub(r"(?is)<style\b.*?</style>", " ", text)
    text = re.sub(r"(?is)<!--.*?-->", " ", text)
    text = re.sub(r"(?is)<br\s*/?>", "\n", text)
    text = re.sub(r"(?is)</(p|div|li|h[1-6]|tr|section|article|button)>", "\n", text)
    text = re.sub(r"(?is)<[^>]+>", " ", text)
    return normalize_ws(strip_ai_ui_control_lines(repair_text_encoding(html.unescape(text))))


def ai_text_for_matching(*values: str) -> str:
    parts = []
    for value in values:
        if value:
            parts.append(strip_html_for_text(str(value)))
    return normalize_ws("\n".join(parts))


def unique_nonempty(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        item = str(value or "").strip()
        if not item:
            continue
        key = item.casefold()
        if key not in seen:
            seen.add(key)
            out.append(item)
    return out

def compact_match_text(value: str) -> str:
    value = repair_text_encoding(value or "").casefold()
    return re.sub(r"[\W_]+", "", value, flags=re.UNICODE)


def text_contains_term(haystack: str, term: str) -> bool:
    if not term:
        return False
    hay = repair_text_encoding(haystack or "").casefold()
    needle = repair_text_encoding(term or "").casefold().strip()
    if not needle:
        return False
    if re.search(rf"(?<!\w){re.escape(needle)}(?!\w)", hay, flags=re.UNICODE):
        return True
    compact_needle = compact_match_text(needle)
    return bool(len(compact_needle) >= 6 and compact_needle in compact_match_text(hay))


def extract_ai_citation_urls(answer_text: str) -> list[str]:
    text = decode_escaped_url_text(answer_text)
    candidates: list[str] = []
    for href, _label in _AI_HREF_RE.findall(text):
        candidates.append(href)
    candidates.extend(_AI_URL_PARAM_RE.findall(text))
    candidates.extend(_AI_URL_RE.findall(text))
    out: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        url = normalize_ai_citation_url(candidate)
        if not url:
            continue
        key = url.casefold()
        if key not in seen:
            seen.add(key)
            out.append(url)
    return out


def xmlriver_error_message(root: ET.Element) -> str:
    errors = [root] if xml_local_name(root.tag) == "error" else iter_xml_local(root, "error")
    if not errors:
        return ""
    err = errors[0]
    code = err.get("code") or err.get("type") or "unknown"
    message = normalize_ws(" ".join(err.itertext()))
    return f"XMLRiver error {code}: {message}".strip()


def parse_xmlriver_root_or_raise(xml_text: str | bytes) -> ET.Element:
    root = ET.fromstring(xml_text)
    error_message = xmlriver_error_message(root)
    if error_message:
        raise RuntimeError(error_message)
    return root


def is_xmlriver_error_payload(value: str) -> bool:
    text = normalize_ws(strip_html_for_text(value or "")).casefold()
    if not text:
        return False
    if "xmlriver" in text and "error" in text:
        return True
    if "\u043e\u0448\u0438\u0431\u043a" in text and ("xmlriver" in text or "\u043a\u043e\u0434" in text):
        return True
    return bool(re.search(r"\berror\s*(?:code)?\s*[:=#-]?\s*\d+", text, flags=re.IGNORECASE))


def normalize_ws(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(str(value or ""))).strip()


def build_serp_collection_report(topic: str, provider: str, plan: list[dict[str, Any]], serp_rows: list[dict[str, Any]], ai_rows: list[dict[str, Any]], errors: list[str], region: str = "", language: str = "", scope: dict[str, Any] | None = None) -> str:
    scope = scope or {}
    requested_top_urls = scope.get("requested_top_urls") or scope.get("depth") or "not set"
    planned_query_engine_pairs = scope.get("planned_query_engine_pairs", len(plan))
    planned_paid_requests = scope.get("planned_paid_requests", len(plan))
    xmlriver_pages = scope.get("xmlriver_serp_pages_per_query_engine")
    xmlriver_max_threads = scope.get("xmlriver_max_threads")
    xmlriver_thread_slots = scope.get("xmlriver_thread_slots_used", scope.get("xmlriver_thread_slots_planned"))
    paid_requests_succeeded = scope.get("paid_requests_succeeded")
    paid_requests_failed = scope.get("paid_requests_failed")
    lines = [
        "# SERP_COLLECTION",
        "",
        f"Generated: {utc_now()}",
        f"Topic: {topic}",
        f"Provider: {provider}",
        "",
        "## Scope",
        "",
        f"- query x engine pairs: {planned_query_engine_pairs}",
        f"- requested top URLs per query/engine (`--depth`): {requested_top_urls}",
        f"- planned paid provider requests: {planned_paid_requests}",
        f"- paid requests succeeded: {paid_requests_succeeded if paid_requests_succeeded is not None else 'not run'}",
        f"- paid requests failed: {paid_requests_failed if paid_requests_failed is not None else 'not run'}",
        f"- XMLRiver SERP pages per query/engine: {xmlriver_pages if xmlriver_pages is not None else 'n/a'}",
        f"- XMLRiver max live threads: {xmlriver_max_threads if xmlriver_max_threads is not None else 'n/a'}",
        f"- XMLRiver planned/used thread slots: {xmlriver_thread_slots if xmlriver_thread_slots is not None else 'n/a'}",
        f"- region: {region or 'not set'}",
        f"- language: {language or 'not set'}",
        f"- SERP rows collected: {len(serp_rows)}",
        f"- AI answer/citation rows collected: {len(ai_rows)}",
        "",
        "## Request Plan",
        "",
        "| Engine | Query | Source |",
        "| --- | --- | --- |",
    ]
    for row in plan:
        lines.append(f"| {row['engine']} | {escape_md(row['query'])} | {row['source']} |")
    if provider == "xmlriver":
        refs = xmlriver_reference_files()
        lines.extend([
            "",
            "## XMLRiver Region And Language",
            "",
            "- Google endpoint: `search/xml`; request must include `query`, numeric `loc` from `geo.csv`, and `lr` language code from `langs.xlsx`.",
            "- Yandex endpoint: `search_yandex/xml`; request must include `query`, numeric Yandex `lr` region id, and `lang` language code.",
            f"- Region file: {refs['geo']}",
            f"- Language file: {refs['languages']}",
            f"- Country file: {refs['countries']}",
            f"- Domain file: {refs['domains']}",
            "- Do not rely on XMLRiver account defaults for GEO/language; pass the run scope explicitly.",
            "- `--depth` means requested organic URL count/top-N, not number of pagination pages.",
            f"- XMLRiver returns {XMLRIVER_SERP_URLS_PER_PAGE} organic URLs per SERP page; top-100 means 10 paid page requests per query x engine.",
            "- Google `page` starts at 1; Yandex `page` starts at 0.",
            "- `groupby` is fixed at 10 for Google/Yandex SERP collection in current XMLRiver docs; do not treat it as a way to fetch top-100 in one paid request.",
            f"- Approved live XMLRiver collection uses the maximum {XMLRIVER_MAX_THREADS} standard-account threads for the paid page-request queue.",
        ])
    lines.extend(["", "## Errors / Limits", ""])
    lines.extend([f"- {escape_md(err)}" for err in errors] or ["- none"])
    return "\n".join(lines) + "\n"


def enrich_urls(project_dir: Path, topic: str = "", urls: str = "", network_approved: bool = False, max_urls: int = 20, timeout: int = 12) -> dict[str, Any]:
    root = find_project_root(project_dir)
    ensure_dirs(root)
    config = load_config(root)
    if not topic:
        topic = (config.get("project", {}).get("priority_topics", [""]) or [""])[0]
    topic_slug = slugify(topic or "topic")
    selected = split_csv(urls)
    if not selected and topic:
        analysis = read_json(root / PROCESSED_REL / f"{topic_slug}_serp_ai_analysis.json", {})
        selected.extend([item["value"] for item in analysis.get("cited_urls", [])[:max_urls] if item.get("value")])
        serp_rows = read_csv(root / PROCESSED_REL / f"{topic_slug}_serp_rows.csv")
        selected.extend([row.get("url", "") for row in serp_rows[:max_urls] if row.get("url")])
    selected = dedupe(selected)[:max_urls]
    if not selected:
        return observation("blocked", "No URLs available for enrichment.", next_valid_actions=["collect_serp", "manual_import_urls"])
    if not network_approved:
        report_path = root / REPORTS_REL / "URL_ENRICHMENT.md"
        write_text(report_path, build_url_enrichment_report(topic, [], ["Network approval not provided; URL enrichment was planned but not fetched."]))
        return observation("blocked", "URL enrichment requires --network-approved.", items=[{"planned_urls": len(selected)}], evidence_refs=[str(report_path)], next_valid_actions=["rerun_with_network_approved"])
    rows = []
    errors = []
    raw_dir = root / RAW_REL / "pages" / f"enrich_{sha12(topic + utc_now())}"
    for url in selected:
        try:
            fetched = fetch_page_snapshot(url, timeout)
            if fetched["status"] == "success":
                raw_path = raw_dir / f"{sha12(url)}.html"
                write_text(raw_path, fetched.pop("html"))
                rows.append({**fetched, "raw_ref": str(raw_path), **extract_page_features(url, fetched.get("text", ""), fetched.get("head_html", ""), topic, config.get("project", {}).get("brand", ""))})
            else:
                errors.append(f"{url}: {fetched['summary']}")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{url}: {type(exc).__name__}: {exc}")
    csv_path = root / PROCESSED_REL / f"{topic_slug}_url_enrichment.csv"
    write_csv(csv_path, rows)
    summary_path = root / QUALITY_REL / f"{topic_slug}_url_enrichment_summary.json"
    write_json(summary_path, {
        "topic": topic,
        "topic_slug": topic_slug,
        "network_approved": True,
        "selected_urls": selected,
        "max_urls": max_urls,
        "timeout": timeout,
        "enriched_rows": len(rows),
        "errors": errors,
        "raw_dir": str(raw_dir),
        "generated_at": utc_now(),
    })
    report_path = root / REPORTS_REL / "URL_ENRICHMENT.md"
    write_text(report_path, build_url_enrichment_report(topic, rows, errors))
    return observation("success" if rows else "error", "URL enrichment completed." if rows else "URL enrichment failed.", items=[{"urls": len(selected), "enriched": len(rows), "errors": len(errors)}], evidence_refs=[str(report_path), str(csv_path), str(summary_path)], next_valid_actions=["rerun_topic", "review_chunks"])


def fetch_page_snapshot(url: str, timeout: int) -> dict[str, Any]:
    req = urllib.request.Request(normalize_url(url), headers={"User-Agent": "Googlebot"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body, decoded_with = decode_text_bytes(resp.read(800000), resp.headers.get("content-type", ""), source=url)
    head_match = re.search(r"<head[^>]*>(.*?)</head>", body, re.IGNORECASE | re.DOTALL)
    text = strip_tags(body)
    return {
        "status": "success",
        "url": url,
        "http_status": resp.status,
        "content_type": resp.headers.get("content-type", ""),
        "bytes_read": len(body.encode("utf-8")),
        "html": body,
        "head_html": head_match.group(1) if head_match else "",
        "text": normalize_ws(text)[:20000],
        "summary": f"HTTP {resp.status}",
    }


def extract_page_features(url: str, text: str, head_html: str, topic: str, brand: str) -> dict[str, Any]:
    title = first_regex(head_html, r"<title[^>]*>(.*?)</title>")
    description = first_regex(head_html, r"<meta[^>]+name=[\"']description[\"'][^>]+content=[\"'](.*?)[\"']")
    word_count = len(re.findall(r"[A-Za-zА-Яа-яЁё0-9]+", text))
    topic_terms = [term for term in extract_title_terms(topic) if len(term) > 3]
    lower = text.lower()
    matched_terms = [term for term in topic_terms if term.lower() in lower]
    return {
        "domain": normalize_domain(url),
        "title": normalize_ws(title),
        "description": normalize_ws(description),
        "word_count": word_count,
        "topic_term_matches": len(matched_terms),
        "brand_above_fold_hint": bool(brand and brand.lower() in lower[:2500]),
        "json_ld_blocks": len(re.findall(r"application/ld\+json", head_html, re.IGNORECASE)),
        "tables_hint": len(re.findall(r"<table", head_html, re.IGNORECASE)),
        "main_content_risk": "low_text" if word_count < 250 else "unknown",
    }


def first_regex(text: str, pattern: str) -> str:
    match = re.search(pattern, text or "", re.IGNORECASE | re.DOTALL)
    return html.unescape(match.group(1)) if match else ""


def dedupe(values: list[str]) -> list[str]:
    out = []
    seen = set()
    for value in values:
        item = value.strip()
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out


def build_url_enrichment_report(topic: str, rows: list[dict[str, Any]], errors: list[str]) -> str:
    lines = [
        "# URL_ENRICHMENT",
        "",
        f"Generated: {utc_now()}",
        f"Topic: {topic or 'not provided'}",
        "",
        "| URL | HTTP | Words | Topic Matches | Brand High | Main Content Risk |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for row in rows:
        lines.append(f"| {escape_md(row.get('url', ''))} | {row.get('http_status', '')} | {row.get('word_count', '')} | {row.get('topic_term_matches', '')} | {row.get('brand_above_fold_hint', '')} | {row.get('main_content_risk', '')} |")
    lines.extend(["", "## Errors / Limits", ""])
    lines.extend([f"- {escape_md(err)}" for err in errors] or ["- none"])
    return "\n".join(lines) + "\n"


def init_database(root: Path) -> Path:
    ensure_dirs(root)
    db_path = root / DB_REL
    schema_path = RUNTIME_ROOT / "schemas" / "geo_topic_agent.schema.sql"
    with sqlite3.connect(db_path) as conn:
        conn.executescript(schema_path.read_text(encoding="utf-8"))
    return db_path


def persist_workflow_sqlite(root: Path, topic: str, config: dict[str, Any], fanout_rows: list[dict[str, Any]], serp_rows: list[dict[str, Any]], ai_rows: list[dict[str, Any]], placement_rows: list[dict[str, Any]]) -> Path:
    db_path = init_database(root)
    with sqlite3.connect(db_path) as conn:
        cur = conn.execute(
            "INSERT INTO projects(domain, brand, language, target_goal, created_at) VALUES (?, ?, ?, ?, ?)",
            (config.get("project", {}).get("domain", ""), config.get("project", {}).get("brand", ""), config.get("region", {}).get("language", ""), config.get("project", {}).get("target_goal", "both"), utc_now()),
        )
        project_id = int(cur.lastrowid)
        cur = conn.execute("INSERT INTO topics(project_id, topic, slug, status, created_at) VALUES (?, ?, ?, ?, ?)", (project_id, topic, slugify(topic), "completed", utc_now()))
        topic_id = int(cur.lastrowid)
        conn.executemany(
            "INSERT INTO fanout_queries(topic_id, source_query, fanout_query, branch, priority, evidence_ref) VALUES (?, ?, ?, ?, ?, ?)",
            [(topic_id, row.get("source_query", ""), row.get("fanout_query", ""), row.get("branch", ""), row.get("priority", ""), "processed/fanout_queries.csv") for row in fanout_rows],
        )
        conn.executemany(
            "INSERT INTO serp_results(topic_id, query, engine, position, url, title, snippet, cited_in_ai, evidence_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(topic_id, row.get("query", ""), row.get("engine", ""), safe_int(row.get("position")), row.get("url", ""), row.get("title", ""), row.get("snippet", ""), 1 if row.get("cited_in_ai") else 0, row.get("raw_ref", "")) for row in serp_rows],
        )
        conn.executemany(
            "INSERT INTO ai_answers(topic_id, prompt, provider, model, answer_text, citation_url, citation_title, brand_mentioned, project_url_cited, evidence_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(topic_id, row.get("prompt", ""), row.get("provider", ""), row.get("model", ""), row.get("answer_text", ""), row.get("citation_url", ""), row.get("citation_title", ""), 1 if row.get("brand_mentioned") else 0, 1 if row.get("project_url_cited") else 0, row.get("raw_ref", "")) for row in ai_rows],
        )
        conn.executemany(
            "INSERT INTO placement_opportunities(topic_id, url, domain, opportunity_type, rationale, priority, evidence_ref) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(topic_id, row.get("url", ""), row.get("domain", ""), row.get("opportunity_type", ""), row.get("rationale", ""), row.get("priority", ""), "processed/placement_opportunities.csv") for row in placement_rows],
        )
    return db_path



def final_evidence_audit(project_dir: Path, topic: str = "") -> dict[str, Any]:
    root = find_project_root(project_dir)
    ensure_dirs(root)
    config = load_config(root)
    if not topic:
        topic = (config.get("project", {}).get("priority_topics", [""]) or [""])[0]
    topic_slug = slugify(topic or "topic")
    contract_path = RUNTIME_ROOT / "references" / "final-evidence-contract.json"
    contract = read_json(contract_path, {})
    decision_path, decisions = load_final_evidence_decisions(root)
    rows = [
        apply_final_evidence_decision(
            evaluate_external_evidence_item(root, topic_slug, item),
            decisions.get(item.get("id", "")),
            decision_path,
        )
        for item in contract.get("required_external_evidence", [])
    ]
    rows = [portable_value(root, row) for row in rows]
    external_pass = sum(1 for row in rows if row["status"] == "external_pass")
    external_pending = sum(1 for row in rows if row["status"] == "external_pending")
    descoped = sum(1 for row in rows if row["status"] == "descoped")
    if rows and external_pending == 0 and descoped == 0:
        final_status = "external_pass"
    elif rows and external_pending == 0 and descoped:
        final_status = "ready_with_descopes"
    else:
        final_status = "external_pending"
    payload = {
        "topic": topic,
        "status": final_status,
        "external_pass": external_pass,
        "external_pending": external_pending,
        "descoped": descoped,
        "rows": rows,
        "decision_record_path": portable_ref(root, decision_path),
        "final_claim_rule": contract.get("final_claim_rule", ""),
        "forbidden_global_claims_until_external_pass": contract.get("forbidden_global_claims_until_external_pass", []),
        "generated_at": utc_now(),
    }
    report_path = root / REPORTS_REL / "FINAL_EVIDENCE_AUDIT.md"
    json_path = root / QUALITY_REL / f"{topic_slug}_final_evidence_audit.json"
    write_json(json_path, payload)
    write_text(report_path, build_final_evidence_audit_report(payload))
    return observation(
        "success",
        "Final evidence audit created.",
        items=[{"external_pass": external_pass, "external_pending": external_pending, "descoped": descoped, "status": payload["status"]}],
        evidence_refs=[str(report_path), str(json_path)],
        next_valid_actions=["close_external_evidence", "request_approval", "record_descope_decision", "keep_claim_boundary"] if external_pending else ["review_descopes", "keep_claim_boundary"] if descoped else ["review_final_claim"],
    )


def independent_audit_pack(project_dir: Path, topic: str = "") -> dict[str, Any]:
    root = find_project_root(project_dir)
    ensure_dirs(root)
    config = load_config(root)
    if not topic:
        topic = (config.get("project", {}).get("priority_topics", [""]) or [""])[0]
    topic_slug = slugify(topic or "topic")
    pack_dir = root / QUALITY_REL / "independent-audit-pack"
    prompts_dir = pack_dir / "prompts"
    prompts_dir.mkdir(parents=True, exist_ok=True)
    packs = build_independent_audit_packs(topic)
    prompt_refs = []
    for pack in packs:
        prompt_path = prompts_dir / f"{pack['id']}.md"
        write_text(prompt_path, render_independent_audit_prompt(pack))
        prompt_refs.append(str(prompt_path))
        pack["prompt_ref"] = portable_ref(root, prompt_path)
    payload = {
        "topic": topic,
        "status": "ready_for_independent_review",
        "independent_execution": False,
        "pack_count": len(packs),
        "scenario_packs": sum(1 for pack in packs if pack["kind"] == "scenario"),
        "auditor_packs": sum(1 for pack in packs if pack["kind"] == "auditor"),
        "raw_load_policy": "Do not load whole workspaces, raw provider responses, secrets, shell history, prompts, transcripts, or temporary/generated run folders by default.",
        "packs": packs,
        "generated_at": utc_now(),
    }
    json_path = root / QUALITY_REL / f"{topic_slug}_independent_audit_pack.json"
    report_path = root / REPORTS_REL / "INDEPENDENT_AUDIT_PACK.md"
    write_json(json_path, payload)
    write_text(report_path, build_independent_audit_pack_report(payload))
    return observation(
        "success",
        "Independent audit pack created without running reviewers.",
        items=[{
            "status": payload["status"],
            "independent_execution": False,
            "pack_count": payload["pack_count"],
            "scenario_packs": payload["scenario_packs"],
            "auditor_packs": payload["auditor_packs"],
        }],
        evidence_refs=[str(report_path), str(json_path), *prompt_refs[:10]],
        next_valid_actions=["request_reviewer_approval", "run_independent_reviewers", "record_findings", "final_evidence_audit"],
    )


def build_independent_audit_packs(topic: str) -> list[dict[str, Any]]:
    common_runtime_refs = [
        "AGENTS.md",
        "geo-topic-contract.json",
        "references/tool-registry.json",
        "references/final-evidence-contract.json",
        "references/final-evidence-runbook.md",
        "references/context-and-quality-gates.md",
        "skills/geo-topic-workflow/SKILL.md",
        "skills/semantic-tz-handoff/SKILL.md",
    ]
    common_project_refs = [
        "geo_agent/reports/ADAPTATION_REPORT.md",
        "geo_agent/reports/PROJECT_CONTEXT.md",
        "geo_agent/reports/ACCESSIBILITY_AUDIT.md",
        "geo_agent/reports/FANOUT_MAP.md",
        "geo_agent/reports/SERP_AI_ANALYSIS.md",
        "geo_agent/reports/CONTENT_PLAN.md",
        "geo_agent/reports/TZ_HANDOFF_REPORT.md",
        "geo_agent/reports/PLACEMENT_STRATEGY.md",
        "geo_agent/reports/MONITORING_PLAN.md",
        "geo_agent/reports/COMPLETION_AUDIT.md",
        "geo_agent/reports/FINAL_EVIDENCE_AUDIT.md",
        "geo_agent/reports/FINAL_EVIDENCE_READINESS.md",
    ]
    scenario_specs = [
        ("first-run-onboarding", "First-run onboarding", "Start from a clean target project and verify environment adaptation, missing credentials behavior, and next-step clarity."),
        ("happy-path-full-run", "Happy-path full topic run", "Simulate a user-provided domain/topic with manual SERP/AI evidence and verify all required one-topic artifacts are produced."),
        ("missing-permission", "Missing permission or input", "Verify blocked network/provider/independent-review work is recorded as a limitation with next valid actions, not as success."),
        ("direct-skill", "Direct skill or narrow workflow", "Invoke only semantic TZ handoff/provider/readiness paths and verify they do not require unrelated full-run context."),
        ("semantic-tz-handoff-delivery", "Semantic TZ handoff delivery", "Verify semantic handoff JSON, TZ_HANDOFF_REPORT, generator invocation approval gate, and generated TZ boundary."),
        ("memory-state", "Memory/state continuity", "Verify state, memory, SQLite, and proposal-only adaptation rules survive context loss without storing secrets or temporary setup notes as memory."),
    ]
    auditor_specs = [
        ("consistency-routing-auditor", "Consistency and routing auditor", "Find contradictions between router, IR, skills, CLI, trigger lab, and near-neighbor boundaries."),
        ("geo-workflow-design-auditor", "GEO workflow design auditor", "Evaluate tool contracts, permission gates, loops, budgets, context packaging, and evidence claim guard for GEO/AEO topic work."),
        ("evidence-quality-auditor", "Evidence quality auditor", "Inspect source coverage, raw_ref linkage, skipped evidence visibility, handoff completeness, and final evidence readiness assumptions."),
        ("claim-boundary-auditor", "Claim boundary and final evidence auditor", "Check that fixtures, self-review, readiness packets, descopes, and metadata fallback are not counted as live or independent evidence."),
    ]
    packs = []
    for pack_id, title, objective in scenario_specs:
        packs.append(independent_audit_pack_row(pack_id, "scenario", title, objective, topic, common_runtime_refs, common_project_refs))
    for pack_id, title, objective in auditor_specs:
        packs.append(independent_audit_pack_row(pack_id, "auditor", title, objective, topic, common_runtime_refs, common_project_refs))
    return packs


def independent_audit_pack_row(pack_id: str, kind: str, title: str, objective: str, topic: str, runtime_refs: list[str], project_refs: list[str]) -> dict[str, Any]:
    return {
        "id": pack_id,
        "kind": kind,
        "title": title,
        "objective": objective,
        "topic": topic,
        "allowed_runtime_refs": runtime_refs,
        "allowed_project_refs": project_refs,
        "forbidden_context": [
            "whole workspace dumps",
            "raw provider responses unless explicitly needed and justified",
            "secrets, credentials, cookies, tokens, shell history, private logs, prompts, transcripts",
            "agent-created summaries as proof of independent execution",
        ],
        "required_response_sections": [
            "files inspected",
            "steps attempted",
            "work trace",
            "confusion points",
            "illogical or duplicated behavior",
            "missing files or contracts",
            "unsafe assumptions",
            "findings with severity",
            "tests that should exist next",
        ],
        "acceptance_boundary": "This prompt pack is preparation only. It becomes independent evidence only after a separate approved reviewer returns a trace and findings, and real findings are fixed or dispositioned.",
    }


def render_independent_audit_prompt(pack: dict[str, Any]) -> str:
    lines = [
        f"# {pack['title']}",
        "",
        "You are an independent evaluator for a GEO Topic Agent run.",
        "Do not assume the run artifacts are correct. Report exact work trace, confusion points, contradictions, missing files, unsafe assumptions, and suggested tests.",
        "",
        f"Kind: {pack['kind']}",
        f"Objective: {pack['objective']}",
        f"Topic: {pack.get('topic') or 'not provided'}",
        "",
        "## Allowed Agent References",
    ]
    lines.extend([f"- `{ref}`" for ref in pack.get("allowed_runtime_refs", [])])
    lines.extend(["", "## Allowed Project References"])
    lines.extend([f"- `{ref}`" for ref in pack.get("allowed_project_refs", [])])
    lines.extend(["", "## Forbidden Context"])
    lines.extend([f"- {item}" for item in pack.get("forbidden_context", [])])
    lines.extend(["", "## Required Response Sections"])
    lines.extend([f"- {item}" for item in pack.get("required_response_sections", [])])
    lines.extend(["", "## Acceptance Boundary", "", pack.get("acceptance_boundary", "")])
    return "\n".join(lines) + "\n"


def build_independent_audit_pack_report(payload: dict[str, Any]) -> str:
    lines = [
        "# INDEPENDENT_AUDIT_PACK",
        "",
        f"Generated: {payload['generated_at']}",
        f"Topic: {payload.get('topic') or 'not provided'}",
        f"Status: {payload['status']}",
        f"Independent execution: {payload['independent_execution']}",
        f"Pack count: {payload['pack_count']}",
        f"Scenario packs: {payload['scenario_packs']}",
        f"Auditor packs: {payload['auditor_packs']}",
        "",
        "This pack prepares independent validation. It is not independent evidence until approved external reviewers/subagents return traces and findings.",
        "",
        "| Pack | Kind | Prompt |",
        "| --- | --- | --- |",
    ]
    for pack in payload.get("packs", []):
        lines.append(f"| {pack['id']} | {pack['kind']} | {escape_md(pack.get('prompt_ref', ''))} |")
    lines.extend([
        "",
        "## Raw Load Policy",
        "",
        payload.get("raw_load_policy", "not recorded"),
    ])
    return "\n".join(lines) + "\n"


def final_evidence_readiness(project_dir: Path, topic: str = "", max_queries: int = 2, depth: int = 20, max_urls: int = 10, env_path: str = "") -> dict[str, Any]:
    root = find_project_root(project_dir)
    ensure_dirs(root)
    config = load_config(root)
    if not topic:
        topic = (config.get("project", {}).get("priority_topics", [""]) or [""])[0]
    topic_slug = slugify(topic or "topic")
    contract_path = RUNTIME_ROOT / "references" / "final-evidence-contract.json"
    contract = read_json(contract_path, {})
    env = load_env_values(root, env_path)
    decision_path, decisions = load_final_evidence_decisions(root)
    rows = []
    for item in contract.get("required_external_evidence", []):
        evidence_row = apply_final_evidence_decision(
            evaluate_external_evidence_item(root, topic_slug, item),
            decisions.get(item.get("id", "")),
            decision_path,
        )
        rows.append(build_final_evidence_readiness_row(root, topic, item, evidence_row, env, max_queries, depth, max_urls))
    needs_approval = sum(1 for row in rows if row["readiness_status"] == "needs_approval_or_evidence")
    evidence_ready = sum(1 for row in rows if row["readiness_status"] == "evidence_ready")
    descoped = sum(1 for row in rows if row["readiness_status"] == "descoped_limitation")
    payload = {
        "topic": topic,
        "status": "ready_to_claim" if rows and needs_approval == 0 and descoped == 0 else "ready_with_descopes" if rows and needs_approval == 0 else "needs_external_approval",
        "needs_approval_or_evidence": needs_approval,
        "evidence_ready": evidence_ready,
        "descoped": descoped,
        "approval_packets": sum(1 for row in rows if row.get("approval_packet_required")),
        "decision_record_path": str(decision_path),
        "template_paths": final_evidence_template_paths(root),
        "rows": rows,
        "generated_at": utc_now(),
    }
    report_path = root / REPORTS_REL / "FINAL_EVIDENCE_READINESS.md"
    json_path = root / QUALITY_REL / f"{topic_slug}_final_evidence_readiness.json"
    write_json(json_path, payload)
    write_text(report_path, build_final_evidence_readiness_report(payload))
    return observation(
        "success",
        "Final evidence readiness packet created.",
        items=[{
            "status": payload["status"],
            "needs_approval_or_evidence": needs_approval,
            "approval_packets": payload["approval_packets"],
            "descoped": descoped,
        }],
        evidence_refs=[str(report_path), str(json_path)],
        next_valid_actions=["request_approval", "run_approved_live_commands", "record_descope_decision", "final_evidence_audit"] if needs_approval else ["final_evidence_audit"],
    )


def final_evidence_template_paths(root: Path) -> dict[str, str]:
    base = root / IMPORT_REL / "final_evidence"
    return {
        "decisions": str(base / "final_evidence_decisions_template.json"),
        "independent_review_summary": str(base / "independent_review_summary_template.json"),
        "provider_collection_summary": str(base / "provider_collection_summary_template.json"),
        "url_enrichment_summary": str(base / "url_enrichment_summary_template.json"),
    }


def build_final_evidence_readiness_row(
    root: Path,
    topic: str,
    item: dict[str, Any],
    evidence_row: dict[str, Any],
    env: dict[str, str],
    max_queries: int,
    depth: int,
    max_urls: int,
) -> dict[str, Any]:
    evidence_id = item.get("id", "unknown")
    evidence_status = evidence_row.get("status", "external_pending")
    if evidence_status == "external_pass":
        readiness_status = "evidence_ready"
    elif evidence_status == "descoped":
        readiness_status = "descoped_limitation"
    else:
        readiness_status = "needs_approval_or_evidence"
    approval = item.get("approval_required", {}) if isinstance(item.get("approval_required", {}), dict) else {}
    credential_status = final_evidence_credential_status(item, env)
    commands = [render_required_command_pattern(pattern, root, topic, max_queries, depth, max_urls) for pattern in item.get("required_command_patterns", [])]
    return {
        "id": evidence_id,
        "evidence_status": evidence_status,
        "readiness_status": readiness_status,
        "approval_packet_required": readiness_status == "needs_approval_or_evidence",
        "approval_required": approval,
        "credential_status": credential_status,
        "commands_to_run_after_approval": commands,
        "descope_command": f"{cli_command_prefix(root)} record-descope --project-dir <target> --evidence-id {evidence_id} --approved-by \"<user-or-reviewer>\" --reason \"<why descoped>\" --date YYYY-MM-DD",
        "required_evidence_artifacts": item.get("required_evidence_artifacts", []),
        "missing_evidence": evidence_row.get("missing", []),
        "pass_condition": item.get("pass_condition", ""),
        "forbidden_claim_until_pass": item.get("forbidden_claim_until_pass", ""),
    }


def final_evidence_credential_status(item: dict[str, Any], env: dict[str, str]) -> list[dict[str, Any]]:
    approval = item.get("approval_required", {}) if isinstance(item.get("approval_required", {}), dict) else {}
    groups = approval.get("credentials", []) if isinstance(approval.get("credentials", []), list) else []
    status = []
    for group in groups:
        group_text = str(group)
        keys = [part.strip() for part in re.split(r"\s*\+\s*", group_text) if part.strip()]
        present_keys = [key for key in keys if bool(env.get(key))]
        status.append({
            "group": group_text,
            "keys": keys,
            "present": bool(keys) and len(present_keys) == len(keys),
            "present_keys": present_keys,
            "missing_keys": [key for key in keys if key not in present_keys],
        })
    return status


def render_required_command_pattern(pattern: str, root: Path, topic: str, max_queries: int, depth: int, max_urls: int) -> str:
    return (
        pattern.replace("<target>", str(root))
        .replace("<topic>", topic or "<topic>")
        .replace("<n>", str(max_queries))
        .replace("<d>", str(depth))
        .replace("<comma-separated-urls>", "<approved-url-list>")
        .replace("<url1>,<url2>", "<approved-url-list>")
        .replace("<max-urls>", str(max_urls))
    )


def build_final_evidence_readiness_report(payload: dict[str, Any]) -> str:
    lines = [
        "# FINAL_EVIDENCE_READINESS",
        "",
        f"Generated: {payload['generated_at']}",
        f"Topic: {payload.get('topic') or 'not provided'}",
        f"Status: {payload['status']}",
        f"Needs approval or evidence: {payload['needs_approval_or_evidence']}",
        f"Evidence ready: {payload['evidence_ready']}",
        f"Descoped: {payload['descoped']}",
        f"Decision record: {payload.get('decision_record_path', '')}",
        "",
        "## Templates",
        "",
    ]
    for template_id, template_path in payload.get("template_paths", {}).items():
        lines.append(f"- {template_id}: `{escape_md(template_path)}`")
    lines.extend([
        "",
        "| Evidence ID | Evidence Status | Readiness | Missing Evidence |",
        "| --- | --- | --- | --- |",
    ])
    for row in payload.get("rows", []):
        missing = "; ".join(row.get("missing_evidence", [])) or "none"
        lines.append(f"| {row['id']} | {row['evidence_status']} | {row['readiness_status']} | {escape_md(missing)} |")
    lines.extend(["", "## Approval Packets", ""])
    for row in payload.get("rows", []):
        if not row.get("approval_packet_required"):
            continue
        lines.extend([
            f"### {row['id']}",
            "",
            f"- forbidden claim until pass: {row.get('forbidden_claim_until_pass') or 'none'}",
            f"- pass condition: {row.get('pass_condition') or 'not recorded'}",
            "- credential groups:",
        ])
        credentials = row.get("credential_status", [])
        if credentials:
            for cred in credentials:
                marker = "present" if cred.get("present") else "missing"
                lines.append(f"  - {escape_md(cred.get('group', ''))}: {marker}; missing keys: {', '.join(cred.get('missing_keys', [])) or 'none'}")
        else:
            lines.append("  - none")
        lines.extend(["- commands after approval:"])
        for command in row.get("commands_to_run_after_approval", []):
            lines.append(f"  - `{escape_md(command)}`")
        lines.extend(["- required evidence artifacts:"])
        for artifact in row.get("required_evidence_artifacts", []):
            lines.append(f"  - `{escape_md(artifact)}`")
        lines.extend([
            "- if explicitly descoped:",
            f"  - `{escape_md(row.get('descope_command', ''))}`",
            "",
        ])
    lines.extend([
        "## Claim Boundary",
        "",
        "This readiness packet is not live evidence. It is an approval and execution checklist. Run approved commands, then run `completion-audit` and `final-evidence-audit` before changing the final claim.",
    ])
    return "\n".join(lines) + "\n"


def record_final_evidence_descope(
    project_dir: Path,
    evidence_id: str,
    approved_by: str,
    reason: str,
    date: str = "",
    scope: str = "",
) -> dict[str, Any]:
    root = find_project_root(project_dir)
    ensure_dirs(root)
    evidence_id = evidence_id.strip()
    approved_by = approved_by.strip()
    reason = reason.strip()
    contract_path = RUNTIME_ROOT / "references" / "final-evidence-contract.json"
    contract = read_json(contract_path, {})
    valid_ids = [item.get("id", "") for item in contract.get("required_external_evidence", [])]
    if evidence_id not in valid_ids:
        return observation(
            "invalid_args",
            "Unknown final evidence id.",
            items=[{"evidence_id": evidence_id, "valid_ids": valid_ids}],
            next_valid_actions=["choose_valid_evidence_id"],
        )
    if not approved_by or not reason:
        return observation(
            "invalid_args",
            "approved_by and reason are required to record a descope decision.",
            items=[{"evidence_id": evidence_id, "approved_by_present": bool(approved_by), "reason_present": bool(reason)}],
            next_valid_actions=["provide_approval_metadata"],
        )
    decision_path, decisions = load_final_evidence_decisions(root)
    decisions[evidence_id] = {
        "id": evidence_id,
        "decision": "descoped",
        "approved_by": approved_by,
        "reason": reason,
        "date": date.strip() or utc_now()[:10],
        "scope": scope.strip(),
    }
    ordered = [decisions[item_id] for item_id in valid_ids if item_id in decisions]
    ordered.extend(decisions[item_id] for item_id in sorted(decisions) if item_id not in valid_ids)
    payload = {"schema_version": 1, "updated_at": utc_now(), "decisions": ordered}
    write_json(decision_path, payload)
    return observation(
        "success",
        "Final evidence descope decision recorded.",
        items=[{"evidence_id": evidence_id, "decision": "descoped", "date": decisions[evidence_id]["date"]}],
        evidence_refs=[str(decision_path)],
        next_valid_actions=["final_evidence_audit", "review_claim_boundary"],
    )


def load_final_evidence_decisions(root: Path) -> tuple[Path, dict[str, dict[str, Any]]]:
    path = root / QUALITY_REL / "final_evidence_decisions.json"
    if not path.exists():
        return path, {}
    payload = read_json(path, {})
    raw_items: Any
    if isinstance(payload, dict) and isinstance(payload.get("decisions"), list):
        raw_items = payload["decisions"]
    elif isinstance(payload, list):
        raw_items = payload
    elif isinstance(payload, dict):
        raw_items = [{"id": key, **value} for key, value in payload.items() if isinstance(value, dict)]
    else:
        raw_items = []
    decisions: dict[str, dict[str, Any]] = {}
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        evidence_id = str(item.get("id", "")).strip()
        if evidence_id:
            decisions[evidence_id] = item
    return path, decisions


def apply_final_evidence_decision(row: dict[str, Any], decision: dict[str, Any] | None, decision_path: Path) -> dict[str, Any]:
    if not decision:
        return row
    if decision.get("decision") != "descoped":
        row.setdefault("notes", []).append(f"Decision record ignored: unsupported decision={decision.get('decision')!r}.")
        row.setdefault("evidence_refs", []).append(str(decision_path))
        return row
    required = ["approved_by", "reason", "date"]
    missing = [field for field in required if not str(decision.get(field, "")).strip()]
    row.setdefault("evidence_refs", []).append(str(decision_path))
    if missing:
        row.setdefault("notes", []).append(f"Descope decision ignored because required fields are missing: {', '.join(missing)}.")
        row.setdefault("missing", []).append(f"incomplete descope decision in {decision_path}")
        return row
    row["status"] = "descoped"
    row["missing"] = []
    row["decision"] = {
        "decision": "descoped",
        "approved_by": decision.get("approved_by", ""),
        "reason": decision.get("reason", ""),
        "date": decision.get("date", ""),
        "scope": decision.get("scope", ""),
    }
    row.setdefault("notes", []).append("User-approved descope; this is not counted as external_pass or live evidence.")
    return row


def evaluate_external_evidence_item(root: Path, topic_slug: str, item: dict[str, Any]) -> dict[str, Any]:
    evidence_id = item.get("id", "unknown")
    if evidence_id == "xmlriver_live_run":
        return evaluate_provider_live_evidence(root, topic_slug, item, "xmlriver", "xmlriver_live")
    if evidence_id == "dataforseo_live_run":
        return evaluate_provider_live_evidence(root, topic_slug, item, "dataforseo", "dataforseo_live")
    if evidence_id == "url_enrichment_live_fetch":
        return evaluate_url_enrichment_evidence(root, topic_slug, item)
    if evidence_id == "independent_geo_workflow_review":
        return evaluate_independent_audit_evidence(root, item)
    return final_evidence_row(item, "external_pending", [], ["No deterministic evaluator exists for this evidence id."])


def external_approval_ledger_path(root: Path) -> Path:
    return root / QUALITY_REL / "external_approval_ledger.json"


def load_external_approval_records(root: Path) -> tuple[Path, list[dict[str, Any]]]:
    path = external_approval_ledger_path(root)
    payload = read_json(path, {}) if path.exists() else {}
    if isinstance(payload, list):
        records = payload
    elif isinstance(payload, dict) and isinstance(payload.get("approvals"), list):
        records = payload.get("approvals", [])
    else:
        records = []
    return path, [record for record in records if isinstance(record, dict)]


def external_approval_errors(root: Path, evidence_id: str, topic_slug: str, required_scope: list[str]) -> tuple[list[str], list[str]]:
    path, records = load_external_approval_records(root)
    refs = [str(path)] if path.exists() else []
    matching = [record for record in records if record.get("evidence_id") == evidence_id and record.get("status", "approved") == "approved" and record.get("topic_slug") in {topic_slug, "*"}]
    if not matching:
        return [f"missing approval ledger record for {evidence_id} topic_slug={topic_slug}"], refs
    errors: list[str] = []
    for record in matching:
        record_errors = []
        for field in ["approved_by", "approval_ref", "approved_at"]:
            if not str(record.get(field, "")).strip() or has_placeholder(record.get(field)):
                record_errors.append(f"approval {field} is missing or placeholder")
        scope = record.get("scope")
        if not isinstance(scope, dict):
            record_errors.append("approval scope must be an object")
            scope = {}
        for field in required_scope:
            if not scope.get(field) or has_placeholder(scope.get(field)):
                record_errors.append(f"approval scope.{field} is missing or placeholder")
        if not record_errors:
            return [], refs
        errors.extend(record_errors)
    return errors[:10], refs


def evaluate_provider_live_evidence(root: Path, topic_slug: str, item: dict[str, Any], provider: str, source_type: str) -> dict[str, Any]:
    provider_slug = slugify(provider)
    provider_serp_path = root / PROCESSED_REL / f"{topic_slug}_{provider_slug}_live_serp_rows.csv"
    provider_ai_path = root / PROCESSED_REL / f"{topic_slug}_{provider_slug}_live_ai_answers.csv"
    live_serp_path = root / PROCESSED_REL / f"{topic_slug}_live_serp_rows.csv"
    live_ai_path = root / PROCESSED_REL / f"{topic_slug}_live_ai_answers.csv"
    serp_source_paths = [provider_serp_path] if provider_serp_path.exists() else [live_serp_path]
    ai_source_paths = [provider_ai_path] if provider_ai_path.exists() else [live_ai_path]
    live_serp = [row for path in serp_source_paths for row in read_csv(path) if row.get("source_type") == source_type]
    live_ai = [row for path in ai_source_paths for row in read_csv(path) if row.get("provider") == provider]
    summaries = provider_collection_summaries(root, provider)
    valid_summaries, summary_errors = validate_provider_collection_summaries(summaries, provider, topic_slug)
    blocking_summary_errors = [] if valid_summaries else summary_errors
    summary_dirs = {path.parent for path in valid_summaries}
    provider_raw_files = provider_raw_artifacts(root, provider, summary_dirs)
    raw_ref_errors = missing_raw_refs(root, [*live_serp, *live_ai], f"{provider} live evidence", allowed_dirs=summary_dirs)
    completion_path, completion_ok, completion_note = completion_audit_external_status(root, topic_slug)
    approval_errors, approval_refs = external_approval_errors(root, item.get("id", ""), topic_slug, ["provider", "topic", "engines", "max_queries", "depth", "region", "language", "budget_or_cost_limit"])
    evidence_refs = []
    for candidate in [provider_serp_path, provider_ai_path, live_serp_path, live_ai_path, completion_path]:
        if candidate.exists():
            evidence_refs.append(str(candidate))
    evidence_refs.extend(approval_refs)
    evidence_refs.extend([str(path) for path in valid_summaries[:5]])
    evidence_refs.extend([str(path) for path in provider_raw_files[:5]])
    missing = []
    if not live_serp:
        missing.append(f"no {source_type} rows in {live_serp_path}")
    if not summaries:
        missing.append(f"no collection_summary.json with provider={provider}")
    if summaries and not valid_summaries:
        missing.append(f"no valid collection_summary.json for provider={provider} topic_slug={topic_slug}")
    missing.extend(blocking_summary_errors)
    if not provider_raw_files:
        missing.append(f"no raw {provider} response files in the approved run directory")
    missing.extend(raw_ref_errors)
    missing.extend(approval_errors)
    if not completion_ok:
        missing.append(completion_note)
    status = "external_pass" if live_serp and valid_summaries and provider_raw_files and not raw_ref_errors and not blocking_summary_errors and not approval_errors and completion_ok else "external_pending"
    notes = [f"live_serp_rows={len(live_serp)}", f"live_ai_rows={len(live_ai)}", f"valid_summaries={len(valid_summaries)}", f"raw_files={len(provider_raw_files)}", f"approval_ledger={'pass' if not approval_errors else 'missing_or_invalid'}", f"ignored_invalid_summaries={len(summary_errors) if valid_summaries else 0}", completion_note]
    return final_evidence_row(item, status, evidence_refs, missing, notes)


def provider_collection_summaries(root: Path, provider: str) -> list[Path]:
    base = root / RAW_REL / "serp"
    if not base.exists():
        return []
    out = []
    for path in sorted(base.glob("*/collection_summary.json")):
        payload = read_json(path, {})
        if payload.get("provider") == provider:
            out.append(path)
    return out


def validate_provider_collection_summaries(paths: list[Path], provider: str, topic_slug: str) -> tuple[list[Path], list[str]]:
    valid: list[Path] = []
    errors: list[str] = []
    for path in paths:
        payload = read_json(path, {})
        path_errors = []
        if payload.get("provider") != provider:
            path_errors.append(f"provider={payload.get('provider')!r}")
        if payload.get("topic_slug") != topic_slug:
            path_errors.append(f"topic_slug={payload.get('topic_slug')!r}")
        if payload.get("network_approved") is not True:
            path_errors.append("network_approved is not true")
        if safe_int(payload.get("serp_rows")) <= 0:
            path_errors.append("serp_rows must be > 0")
        if payload.get("errors"):
            path_errors.append("collection_summary has errors")
        if path_errors:
            errors.append(f"invalid provider collection summary {path}: {', '.join(path_errors)}")
        else:
            valid.append(path)
    return valid, errors[:10]


def provider_raw_artifacts(root: Path, provider: str, summary_dirs: set[Path]) -> list[Path]:
    suffixes = {"xmlriver": ".xml", "dataforseo": ".json"}
    suffix = suffixes.get(provider, "")
    out = []
    for summary_dir in sorted(summary_dirs):
        if not summary_dir.exists():
            continue
        for path in sorted(summary_dir.rglob("*")):
            if not path.is_file() or path.name == "collection_summary.json" or path.name.endswith(".request.json"):
                continue
            if suffix and path.suffix.lower() != suffix:
                continue
            out.append(path)
    return out


def evaluate_url_enrichment_evidence(root: Path, topic_slug: str, item: dict[str, Any]) -> dict[str, Any]:
    report_path = root / REPORTS_REL / "URL_ENRICHMENT.md"
    csv_path = root / PROCESSED_REL / f"{topic_slug}_url_enrichment.csv"
    summary_path = root / QUALITY_REL / f"{topic_slug}_url_enrichment_summary.json"
    rows = read_csv(csv_path)
    successful_rows = [row for row in rows if row.get("status") == "success"]
    summary_payload = read_json(summary_path, {}) if summary_path.exists() else {}
    summary_errors = validate_url_enrichment_summary(summary_payload, topic_slug)
    raw_ref_errors = missing_raw_refs(root, successful_rows, "url enrichment", allowed_dirs={root / RAW_REL / "pages"})
    raw_files = existing_raw_ref_paths(root, successful_rows)
    completion_path, completion_ok, completion_note = completion_audit_external_status(root, topic_slug)
    approval_errors, approval_refs = external_approval_errors(root, item.get("id", ""), topic_slug, ["topic", "urls", "max_urls", "timeout", "budget_or_request_limit"])
    evidence_refs = [str(path) for path in [report_path, csv_path, summary_path] if path.exists()]
    evidence_refs.extend(approval_refs)
    if completion_path.exists():
        evidence_refs.append(str(completion_path))
    evidence_refs.extend([str(path) for path in raw_files[:5]])
    missing = []
    if not report_path.exists():
        missing.append(str(report_path))
    if not csv_path.exists():
        missing.append(str(csv_path))
    if not summary_path.exists():
        missing.append(str(summary_path))
    if not rows:
        missing.append(f"no rows in {csv_path}")
    if not successful_rows:
        missing.append(f"no successful URL enrichment rows in {csv_path}")
    missing.extend(summary_errors)
    if not raw_files:
        missing.append("no existing raw page files referenced by url enrichment rows")
    missing.extend(raw_ref_errors)
    missing.extend(approval_errors)
    if not completion_ok:
        missing.append(completion_note)
    status = "external_pass" if report_path.exists() and successful_rows and summary_path.exists() and not summary_errors and raw_files and not raw_ref_errors and not approval_errors and completion_ok else "external_pending"
    notes = [f"url_rows={len(rows)}", f"successful_url_rows={len(successful_rows)}", f"referenced_raw_page_files={len(raw_files)}", f"approval_ledger={'pass' if not approval_errors else 'missing_or_invalid'}", completion_note]
    return final_evidence_row(item, status, evidence_refs, missing, notes)


def validate_url_enrichment_summary(payload: dict[str, Any], topic_slug: str) -> list[str]:
    if not payload:
        return ["missing or empty URL enrichment summary"]
    errors = []
    if payload.get("topic_slug") != topic_slug:
        errors.append(f"url enrichment summary topic_slug={payload.get('topic_slug')!r}")
    if payload.get("network_approved") is not True:
        errors.append("url enrichment summary network_approved is not true")
    if safe_int(payload.get("enriched_rows")) <= 0:
        errors.append("url enrichment summary enriched_rows must be > 0")
    return errors


def existing_raw_ref_paths(root: Path, rows: list[dict[str, Any]]) -> list[Path]:
    out = []
    for row in rows:
        path = resolve_artifact_ref(root, row.get("raw_ref", ""))
        if path and path.exists():
            out.append(path)
    return out


def missing_raw_refs(root: Path, rows: list[dict[str, Any]], label: str, allowed_dirs: set[Path] | None = None) -> list[str]:
    errors: list[str] = []
    resolved_allowed = [resolve_existing_or_candidate(path) for path in (allowed_dirs or set())]
    for index, row in enumerate(rows, start=1):
        raw_ref = str(row.get("raw_ref", "")).strip()
        if not raw_ref:
            errors.append(f"{label} row {index} missing raw_ref")
            continue
        path = resolve_artifact_ref(root, raw_ref)
        if path is None:
            errors.append(f"{label} row {index} raw_ref cannot be resolved: {raw_ref}")
            continue
        resolved_path = resolve_existing_or_candidate(path)
        if not path_is_within(resolved_path, resolve_existing_or_candidate(root)):
            errors.append(f"{label} row {index} raw_ref is outside project root: {raw_ref}")
            continue
        if resolved_allowed and not any(path_is_within(resolved_path, allowed) for allowed in resolved_allowed):
            errors.append(f"{label} row {index} raw_ref is outside approved raw directory: {raw_ref}")
            continue
        if not path.exists():
            errors.append(f"{label} row {index} raw_ref does not exist: {raw_ref}")
    return errors[:10]


def resolve_artifact_ref(root: Path, raw_ref: str) -> Path | None:
    raw_ref = raw_ref.strip()
    if not raw_ref:
        return None
    path = Path(raw_ref)
    if not path.is_absolute():
        path = root / path
    return path


def resolve_existing_or_candidate(path: Path) -> Path:
    return path.resolve(strict=False)


def path_is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def evaluate_independent_audit_evidence(root: Path, item: dict[str, Any]) -> dict[str, Any]:
    candidates = [
        root / "geo_agent" / "reports" / "INDEPENDENT_SCENARIO_VALIDATION.md",
        root / "geo_agent" / "reports" / "INDEPENDENT_CLEAN_AUDIT.md",
    ]
    existing = [path for path in candidates if path.exists()]
    summary_path, summary_payload = load_independent_review_summary(root)
    evidence_refs = [str(path) for path in existing]
    if summary_path:
        evidence_refs.insert(0, str(summary_path))
    ok, validation_errors, metrics = validate_independent_review_summary(summary_payload)
    status = "external_pass" if ok else "external_pending"
    missing = [] if ok else validation_errors
    notes = [
        f"independent_audit_artifacts={len(existing)}",
        f"scenario_reviews={metrics.get('scenario_reviews', 0)}",
        f"auditor_reviews={metrics.get('auditor_reviews', 0)}",
        f"open_findings={metrics.get('open_findings', 0)}",
        "markdown reports alone do not satisfy independent audit evidence",
        "self-review reports do not satisfy this check",
    ]
    return final_evidence_row(item, status, evidence_refs, missing, notes)


def load_independent_review_summary(root: Path) -> tuple[Path | None, dict[str, Any]]:
    candidates = [
        root / QUALITY_REL / "independent-review-summary.json",
    ]
    for path in candidates:
        if path.exists():
            payload = read_json(path, {})
            return path, payload if isinstance(payload, dict) else {}
    return None, {}


def validate_independent_review_summary(payload: dict[str, Any]) -> tuple[bool, list[str], dict[str, int]]:
    required_scenarios = {
        "first-run-onboarding",
        "happy-path-full-run",
        "missing-permission",
        "direct-skill",
        "semantic-tz-handoff-delivery",
        "memory-state",
    }
    required_auditors = {
        "consistency-routing-auditor",
        "geo-workflow-design-auditor",
        "evidence-quality-auditor",
        "claim-boundary-auditor",
    }
    closed_finding_statuses = {"fixed", "rejected_with_reason", "known_limitation", "not_applicable"}
    errors: list[str] = []
    if not payload:
        return False, ["missing independent-review-summary.json"], {"scenario_reviews": 0, "auditor_reviews": 0, "open_findings": 0}
    if payload.get("independent_execution") is not True:
        errors.append("independent_execution must be true")
    if payload.get("self_review_only") is True:
        errors.append("self_review_only summaries cannot satisfy independent evidence")
    reviews = payload.get("reviews")
    if not isinstance(reviews, list):
        reviews = []
    scenario_reviews = payload.get("scenario_reviews")
    auditor_reviews = payload.get("auditor_reviews")
    if isinstance(scenario_reviews, list) or isinstance(auditor_reviews, list):
        reviews = [
            *(scenario_reviews if isinstance(scenario_reviews, list) else []),
            *(auditor_reviews if isinstance(auditor_reviews, list) else []),
        ]
    scenario_ids = {str(row.get("id", "")) for row in reviews if row.get("kind") == "scenario"}
    auditor_ids = {str(row.get("id", "")) for row in reviews if row.get("kind") == "auditor"}
    missing_scenarios = sorted(required_scenarios - scenario_ids)
    missing_auditors = sorted(required_auditors - auditor_ids)
    if missing_scenarios:
        errors.append("missing scenario reviews: " + ", ".join(missing_scenarios))
    if missing_auditors:
        errors.append("missing auditor reviews: " + ", ".join(missing_auditors))
    for row in reviews:
        review_id = str(row.get("id", "unknown"))
        if review_id not in required_scenarios and review_id not in required_auditors:
            continue
        if row.get("independent") is not True:
            errors.append(f"{review_id}: independent must be true")
        if not str(row.get("reviewer_id", "")).strip() or has_placeholder(row.get("reviewer_id")):
            errors.append(f"{review_id}: reviewer_id is required and must not be a placeholder")
        if not nonempty_sequence_or_text(row.get("inspected_files")) or has_placeholder(row.get("inspected_files")):
            errors.append(f"{review_id}: inspected_files are required and must not contain placeholders")
        if not nonempty_sequence_or_text(row.get("work_trace")) or has_placeholder(row.get("work_trace")):
            errors.append(f"{review_id}: work_trace is required and must not contain placeholders")
        review_status = str(row.get("status", "")).strip().lower()
        if review_status not in {"pass", "warn", "fail"}:
            errors.append(f"{review_id}: status must be pass, warn, or fail")
    findings = payload.get("findings", [])
    if not isinstance(findings, list):
        findings = []
        errors.append("findings must be a list")
    open_findings = []
    for index, finding in enumerate(findings, start=1):
        if not isinstance(finding, dict):
            open_findings.append(f"finding-{index}")
            continue
        finding_id = str(finding.get("id") or f"finding-{index}")
        status = str(finding.get("status", "")).strip()
        if status not in closed_finding_statuses:
            open_findings.append(finding_id)
        if status in {"rejected_with_reason", "known_limitation"} and (not str(finding.get("reason", "")).strip() or has_placeholder(finding.get("reason"))):
            open_findings.append(f"{finding_id}:missing_reason")
        if status == "fixed" and (not nonempty_sequence_or_text(finding.get("evidence_refs")) or has_placeholder(finding.get("evidence_refs"))):
            open_findings.append(f"{finding_id}:missing_fix_evidence")
    if payload.get("all_findings_dispositioned") is not True:
        errors.append("all_findings_dispositioned must be true")
    if open_findings:
        errors.append("open or under-evidenced findings: " + ", ".join(open_findings))
    metrics = {
        "scenario_reviews": len(scenario_ids & required_scenarios),
        "auditor_reviews": len(auditor_ids & required_auditors),
        "open_findings": len(open_findings),
    }
    return not errors, errors, metrics


def nonempty_sequence_or_text(value: Any) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, list):
        return any(nonempty_sequence_or_text(item) for item in value)
    return value is not None


def final_evidence_row(item: dict[str, Any], status: str, evidence_refs: list[str], missing: list[str], notes: list[str] | None = None) -> dict[str, Any]:
    return {
        "id": item.get("id", "unknown"),
        "status": status,
        "requirement_refs": item.get("requirement_refs", []),
        "pass_condition": item.get("pass_condition", ""),
        "evidence_refs": evidence_refs,
        "missing": missing,
        "notes": notes or [],
        "forbidden_claim_until_pass": item.get("forbidden_claim_until_pass", ""),
    }


def completion_audit_external_status(root: Path, topic_slug: str) -> tuple[Path, bool, str]:
    path = root / QUALITY_REL / f"{topic_slug}_completion_audit.json"
    if not path.exists():
        return path, False, f"missing completion audit {path}"
    payload = read_json(path, {})
    blocks = safe_int(payload.get("blocks"))
    warnings = safe_int(payload.get("warnings"))
    status = payload.get("status")
    ok = status == "pass" and blocks == 0 and warnings == 0
    return path, ok, f"completion_audit status={status} blocks={blocks} warnings={warnings}"


def build_final_evidence_audit_report(payload: dict[str, Any]) -> str:
    lines = [
        "# FINAL_EVIDENCE_AUDIT",
        "",
        f"Generated: {payload['generated_at']}",
        f"Topic: {payload.get('topic') or 'not provided'}",
        f"Status: {payload['status']}",
        f"External pass: {payload['external_pass']}",
        f"External pending: {payload['external_pending']}",
        f"Descoped: {payload.get('descoped', 0)}",
        f"Decision record: {payload.get('decision_record_path', '')}",
        "",
        "| Evidence ID | Status | Missing | Evidence |",
        "| --- | --- | --- | --- |",
    ]
    for row in payload.get("rows", []):
        missing = "; ".join(row.get("missing", [])) or "none"
        evidence = "; ".join(row.get("evidence_refs", [])) or "none"
        lines.append(f"| {row['id']} | {row['status']} | {escape_md(missing)} | {escape_md(evidence)} |")
    lines.extend([
        "",
        "## Claim Rule",
        "",
        payload.get("final_claim_rule") or "No final claim rule recorded.",
        "",
        "A `descoped` row means the user accepted a limitation for this release. It is not live evidence and must not be counted as `external_pass`.",
        "",
        "## Forbidden Claims Until External Pass",
        "",
    ])
    forbidden = payload.get("forbidden_global_claims_until_external_pass", [])
    lines.extend([f"- {claim}" for claim in forbidden] or ["- none"])
    return "\n".join(lines) + "\n"

def completion_url_enrichment_status(root: Path, topic_slug: str) -> tuple[str, str]:
    report_path = root / REPORTS_REL / "URL_ENRICHMENT.md"
    csv_path = root / PROCESSED_REL / f"{topic_slug}_url_enrichment.csv"
    summary_path = root / QUALITY_REL / f"{topic_slug}_url_enrichment_summary.json"
    rows = read_csv(csv_path)
    successful_rows = [row for row in rows if row.get("status") == "success"]
    summary_payload = read_json(summary_path, {}) if summary_path.exists() else {}
    summary_errors = validate_url_enrichment_summary(summary_payload, topic_slug)
    raw_ref_errors = missing_raw_refs(root, successful_rows, "url enrichment", allowed_dirs={root / RAW_REL / "pages"}) if successful_rows else []
    raw_files = existing_raw_ref_paths(root, successful_rows) if successful_rows else []
    evidence = {"report": portable_ref(root, report_path) if report_path.exists() else "missing", "csv": portable_ref(root, csv_path) if csv_path.exists() else "missing", "summary": portable_ref(root, summary_path) if summary_path.exists() else "missing", "successful_rows": len(successful_rows), "raw_files": len(raw_files), "summary_errors": summary_errors[:3], "raw_ref_errors": raw_ref_errors[:3]}
    ok = report_path.exists() and summary_path.exists() and bool(successful_rows) and not summary_errors and bool(raw_files) and not raw_ref_errors
    return ("pass" if ok else "warn", json.dumps(evidence, ensure_ascii=False, sort_keys=True))


def completion_audit(project_dir: Path, topic: str = "") -> dict[str, Any]:
    root = find_project_root(project_dir)
    ensure_dirs(root)
    config = load_config(root)
    if not topic:
        topic = (config.get("project", {}).get("priority_topics", [""]) or [""])[0]
    topic_slug = slugify(topic or "topic")
    required_reports = [
        "ADAPTATION_REPORT.md",
        "PROJECT_CONTEXT.md",
        "ACCESSIBILITY_AUDIT.md",
        "SERP_AI_ANALYSIS.md",
        "QFO_QUERY_ANALYSIS.md",
        "PAGE_TZ.md",
        "MONITORING_PLAN.md",
        "CITATION_VISIBILITY.md",
    ]
    rows = []
    for report in required_reports:
        report_path = root / REPORTS_REL / report
        rows.append({
            "requirement": report,
            "status": "pass" if report_path.exists() else "block",
            "evidence": str(report_path) if report_path.exists() else "missing",
        })

    context_payload = read_json(root / DATA_REL / "project_context.json", {})
    context_gate = context_payload.get("context_quality_gate", {})
    if not context_gate:
        context_gate = context_payload.get("site_context", {}).get("quality_gate", {})
    rows.append({
        "requirement": "deep_project_context_quality_gate",
        "status": "pass" if context_gate.get("status") == "pass" else "block",
        "evidence": json.dumps(context_gate, ensure_ascii=False, sort_keys=True),
    })

    qfo_path = root / PROCESSED_REL / f"{topic_slug}_qfo_analysis.json"
    qfo_payload = read_json(qfo_path, {})
    qfo_approval = qfo_payload.get("content_plan_approval", {})
    rows.append({
        "requirement": "qfo_agent_clustered_user_approved_content_plan",
        "status": "pass" if qfo_payload.get("status") == "success" and qfo_approval.get("status") == "approved" else "block",
        "evidence": json.dumps({
            "path": portable_ref(root, qfo_path),
            "status": qfo_payload.get("status"),
            "content_plan_approval": qfo_approval,
        }, ensure_ascii=False, sort_keys=True),
    })

    page_tz_gate_path = root / QUALITY_REL / f"{topic_slug}_page_tz_quality.json"
    page_tz_gate = read_json(page_tz_gate_path, {})
    rows.append({
        "requirement": "page_tz_quality_gate",
        "status": "pass" if page_tz_gate.get("status") == "success" else "block",
        "evidence": json.dumps({"path": portable_ref(root, page_tz_gate_path), **page_tz_gate}, ensure_ascii=False, sort_keys=True),
    })

    visibility_path = root / PROCESSED_REL / f"{topic_slug}_citation_visibility_latest.json"
    visibility = read_json(visibility_path, {})
    visibility_totals = visibility.get("totals", {})
    measured_checks = safe_int(visibility_totals.get("measured_checks"))
    provider_error_checks = safe_int(visibility_totals.get("provider_error_checks"))
    visibility_status = "pass" if measured_checks > 0 else "block"
    rows.append({
        "requirement": "citation_visibility_measured_log",
        "status": visibility_status,
        "evidence": json.dumps({
            "path": portable_ref(root, visibility_path),
            "measured_checks": measured_checks,
            "provider_error_checks": provider_error_checks,
        }, ensure_ascii=False, sort_keys=True),
    })
    if measured_checks > 0 and provider_error_checks > 0:
        rows.append({
            "requirement": "citation_visibility_provider_errors",
            "status": "warn",
            "evidence": f"provider_error_checks={provider_error_checks}; excluded from metric denominators",
        })

    serp_rows = read_csv(root / PROCESSED_REL / f"{topic_slug}_serp_rows.csv")
    ai_rows = read_csv(root / PROCESSED_REL / f"{topic_slug}_ai_answers.csv")
    live_serp = read_csv(root / PROCESSED_REL / f"{topic_slug}_live_serp_rows.csv")
    live_ai = read_csv(root / PROCESSED_REL / f"{topic_slug}_live_ai_answers.csv")
    db_path = root / DB_REL
    url_enrichment_status, url_enrichment_evidence = completion_url_enrichment_status(root, topic_slug)
    rows.extend([
        {"requirement": "manual_or_live_serp_evidence", "status": "pass" if serp_rows or live_serp else "block", "evidence": f"serp_rows={len(serp_rows)}, live_serp_rows={len(live_serp)}"},
        {"requirement": "manual_or_live_ai_answer_evidence", "status": "pass" if ai_rows or live_ai else "warn", "evidence": f"ai_rows={len(ai_rows)}, live_ai_rows={len(live_ai)}"},
        {"requirement": "sqlite_storage", "status": "pass" if db_path.exists() else "warn", "evidence": str(db_path) if db_path.exists() else "missing"},
        {"requirement": "xmlriver_provider_audit", "status": "pass" if (root / PROCESSED_REL / "provider_audit.json").exists() else "warn", "evidence": str(root / PROCESSED_REL / "provider_audit.json")},
        {"requirement": "url_enrichment", "status": url_enrichment_status, "evidence": url_enrichment_evidence},
        {"requirement": "placement_strategy_optional", "status": "pass" if (root / REPORTS_REL / "PLACEMENT_STRATEGY.md").exists() else "warn", "evidence": str(root / REPORTS_REL / "PLACEMENT_STRATEGY.md")},
    ])
    block_count = sum(1 for row in rows if row["status"] == "block")
    warn_count = sum(1 for row in rows if row["status"] == "warn")
    report_path = root / REPORTS_REL / "COMPLETION_AUDIT.md"
    json_path = root / QUALITY_REL / f"{topic_slug}_completion_audit.json"
    payload = {
        "topic": topic,
        "status": "pass" if block_count == 0 else "block",
        "warnings": warn_count,
        "blocks": block_count,
        "final_claim_guard": "pass" if block_count == 0 else "fail",
        "rows": rows,
        "generated_at": utc_now(),
    }
    write_json(json_path, payload)
    write_text(report_path, build_completion_audit_report(payload))
    return observation(
        "success" if block_count == 0 else "quality_fail",
        "Completion audit created.",
        items=[{"blocks": block_count, "warnings": warn_count, "final_claim_guard": payload["final_claim_guard"]}],
        evidence_refs=[str(report_path), str(json_path)],
        next_valid_actions=["review_warnings", "run_final_evidence_audit"] if block_count == 0 else ["fix_blocks", "rerun_completion_audit"],
    )

def build_completion_audit_report(payload: dict[str, Any]) -> str:
    lines = [
        "# COMPLETION_AUDIT",
        "",
        f"Generated: {payload['generated_at']}",
        f"Topic: {payload.get('topic') or 'not provided'}",
        f"Status: {payload['status']}",
        f"Blocks: {payload['blocks']}",
        f"Warnings: {payload['warnings']}",
        "",
        "| Requirement | Status | Evidence |",
        "| --- | --- | --- |",
    ]
    for row in payload["rows"]:
        lines.append(f"| {row['requirement']} | {row['status']} | {escape_md(row['evidence'])} |")
    lines.extend([
        "",
        "## Claim Boundary",
        "",
        "A pass here proves local runtime artifacts and storage exist. Live provider evidence is a separate warning/pass signal and must not be claimed when rows are zero.",
    ])
    return "\n".join(lines) + "\n"
def generate_tz_handoff(project_dir: Path, topic: str = "") -> dict[str, Any]:
    root = find_project_root(project_dir)
    ensure_dirs(root)
    if not topic:
        config = load_config(root)
        topics = config.get("project", {}).get("priority_topics", [])
        topic = topics[0] if topics else ""
    if not topic:
        return observation("blocked", "Topic is required for TZ handoff.", next_valid_actions=["run_topic_workflow"])
    topic_slug = slugify(topic)
    path = root / HANDOFF_REL / f"semantic_tz_handoff_{topic_slug}.json"
    if not path.exists():
        return observation("blocked", "Semantic TZ handoff is missing; run-topic must create the prerequisite evidence artifact first.", items=[{"topic": topic, "missing_handoff": portable_ref(root, path)}], next_valid_actions=["run_topic_workflow"])
    config = load_config(root)
    handoff = read_json(path, {})
    report_path = root / REPORTS_REL / "TZ_HANDOFF_REPORT.md"
    write_text(report_path, build_tz_handoff_report(path, config, handoff))
    update_state(root, f"TZ handoff refreshed for {topic}", [str(path), str(report_path)])
    return observation("success", "Semantic TZ handoff refreshed.", items=[{"topic": topic, "handoff": str(path), "generator_invoked": False}], evidence_refs=[str(path), str(report_path)], next_valid_actions=["review_handoff", "invoke_existing_generator_if_approved"])


def invoke_tz_generator(
    project_dir: Path,
    topic: str = "",
    generator_command: str = "",
    invoke_approved: bool = False,
    timeout: int = 300,
    generator_contract_ref: str = "",
) -> dict[str, Any]:
    root = find_project_root(project_dir)
    ensure_dirs(root)
    config = load_config(root)
    topic = topic or (config.get("project", {}).get("priority_topics", [""]) or [""])[0]
    if not topic:
        return observation("blocked", "Topic is required for semantic TZ generator invocation.", next_valid_actions=["run_topic_workflow"])
    topic_slug = slugify(topic)
    handoff_path = root / HANDOFF_REL / f"semantic_tz_handoff_{topic_slug}.json"
    if not handoff_path.exists():
        handoff_obs = generate_tz_handoff(root, topic=topic)
        if handoff_obs.get("status") != "success":
            return handoff_obs
    output_dir = root / DATA_REL / "generated-tz" / topic_slug
    output_dir.mkdir(parents=True, exist_ok=True)
    report_path = root / REPORTS_REL / "TZ_GENERATOR_INVOCATION.md"
    invocation_path = root / PROCESSED_REL / f"{topic_slug}_tz_generator_invocation.json"
    candidates = config.get("discovery", {}).get("semantic_tz_generators", [])
    if not generator_command:
        payload = {"status": "blocked", "summary": "No generator command template provided.", "topic": topic, "handoff": portable_ref(root, handoff_path), "generator_candidates": candidates, "output_dir": portable_ref(root, output_dir), "next_valid_actions": ["provide_generator_command_template"]}
        write_json(invocation_path, payload)
        write_text(report_path, build_tz_generator_invocation_report(payload))
        return observation("blocked", "Generator command template is required.", items=[payload], evidence_refs=[str(report_path), str(invocation_path)], next_valid_actions=["provide_generator_command_template"])
    rendered = render_generator_command(generator_command, root, handoff_path, output_dir, topic)
    if not invoke_approved:
        payload = {"status": "blocked", "summary": "Invocation not approved; command was rendered but not executed.", "topic": topic, "handoff": portable_ref(root, handoff_path), "command_template": generator_command, "rendered_command": rendered, "generator_contract_ref": generator_contract_ref, "output_dir": portable_ref(root, output_dir), "next_valid_actions": ["rerun_with_invoke_approved"]}
        write_json(invocation_path, payload)
        write_text(report_path, build_tz_generator_invocation_report(payload))
        return observation("blocked", "Semantic TZ generator invocation requires --invoke-approved.", items=[payload], evidence_refs=[str(report_path), str(invocation_path)], next_valid_actions=["rerun_with_invoke_approved"])
    if not generator_contract_ref or has_placeholder(generator_contract_ref):
        payload = {"status": "blocked", "summary": "Generator contract review reference is required before execution.", "topic": topic, "handoff": portable_ref(root, handoff_path), "command_template": generator_command, "rendered_command": rendered, "output_dir": portable_ref(root, output_dir), "next_valid_actions": ["provide_generator_contract_ref"]}
        write_json(invocation_path, payload)
        write_text(report_path, build_tz_generator_invocation_report(payload))
        return observation("blocked", "Provide --generator-contract-ref before invoking a semantic TZ generator.", items=[payload], evidence_refs=[str(report_path), str(invocation_path)], next_valid_actions=["provide_generator_contract_ref"])
    try:
        argv = parse_generator_command(rendered)
        timeout_seconds = max(1, timeout)
        child_env = os.environ.copy()
        child_env.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
        try:
            proc = subprocess.run(
                argv,
                cwd=root,
                env=child_env,
                shell=False,
                text=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            stdout_text = decode_text_bytes(exc.stdout or b"", source="timed-out generator stdout")[0]
            stderr_text = decode_text_bytes(exc.stderr or b"", source="timed-out generator stderr")[0]
            output_files = [portable_ref(root, path) for path in sorted(output_dir.rglob("*")) if path.is_file()]
            payload = {"status": "error", "summary": f"Generator command timed out after {timeout_seconds} seconds.", "timed_out": True, "timeout_seconds": timeout_seconds, "topic": topic, "handoff": portable_ref(root, handoff_path), "command_template": generator_command, "rendered_command": rendered, "generator_contract_ref": generator_contract_ref, "argv": argv, "stdout": bounded_text(stdout_text, 4000), "stderr": bounded_text(stderr_text, 4000), "output_dir": portable_ref(root, output_dir), "output_files": output_files}
        else:
            stdout_text = decode_text_bytes(proc.stdout or b"", source="generator stdout")[0]
            stderr_text = decode_text_bytes(proc.stderr or b"", source="generator stderr")[0]
            output_files = [portable_ref(root, path) for path in sorted(output_dir.rglob("*")) if path.is_file()]
            payload = {"status": "success" if proc.returncode == 0 else "error", "summary": "Generator command executed." if proc.returncode == 0 else "Generator command returned non-zero status.", "topic": topic, "handoff": portable_ref(root, handoff_path), "command_template": generator_command, "rendered_command": rendered, "generator_contract_ref": generator_contract_ref, "argv": argv, "returncode": proc.returncode, "stdout": bounded_text(stdout_text, 4000), "stderr": bounded_text(stderr_text, 4000), "output_dir": portable_ref(root, output_dir), "output_files": output_files}
    except Exception as exc:  # noqa: BLE001
        payload = {"status": "error", "summary": f"{type(exc).__name__}: {exc}", "topic": topic, "handoff": portable_ref(root, handoff_path), "command_template": generator_command, "rendered_command": rendered, "generator_contract_ref": generator_contract_ref, "output_dir": portable_ref(root, output_dir), "output_files": []}
    write_json(invocation_path, payload)
    write_text(report_path, build_tz_generator_invocation_report(payload))
    output_refs = [str(root / path) if not Path(path).is_absolute() else path for path in payload.get("output_files", [])[:10]]
    update_state(root, f"Semantic TZ generator invocation {payload['status']} for {topic}", [str(report_path), str(invocation_path), *output_refs])
    return observation("success" if payload["status"] == "success" else "error", payload["summary"], items=[{"topic": topic, "status": payload["status"], "output_files": len(payload.get("output_files", []))}], evidence_refs=[str(report_path), str(invocation_path), *output_refs], next_valid_actions=["review_generated_tz", "run_completion_audit"] if payload["status"] == "success" else ["fix_generator_command", "review_stderr"])


def render_generator_command(template: str, root: Path, handoff_path: Path, output_dir: Path, topic: str) -> str:
    return template.replace("{handoff}", portable_ref(root, handoff_path)).replace("{output_dir}", portable_ref(root, output_dir)).replace("{topic}", topic).replace("{topic_slug}", slugify(topic))


def parse_generator_command(command: str) -> list[str]:
    try:
        parsed = json.loads(command)
        if isinstance(parsed, list) and all(isinstance(item, str) for item in parsed):
            return parsed
    except json.JSONDecodeError:
        pass
    return [part.strip('"') for part in shlex.split(command, posix=os.name != "nt")]


def build_tz_generator_invocation_report(payload: dict[str, Any]) -> str:
    lines = [
        "# TZ_GENERATOR_INVOCATION",
        "",
        f"Generated: {utc_now()}",
        f"Status: {payload.get('status')}",
        f"Topic: {payload.get('topic') or 'not provided'}",
        f"Handoff: {payload.get('handoff')}",
        f"Output dir: {payload.get('output_dir')}",
        f"Generator contract ref: {payload.get('generator_contract_ref') or 'missing'}",
        "",
        "## Summary",
        "",
        f"- {payload.get('summary')}",
    ]
    if payload.get("rendered_command"):
        lines.extend(["", "## Command", "", f"`{escape_md(payload.get('rendered_command', ''))}`"])
    if "returncode" in payload:
        lines.extend(["", "## Execution", "", f"- return code: {payload.get('returncode')}"])
    if payload.get("output_files"):
        lines.extend(["", "## Output Files", ""])
        lines.extend([f"- {path}" for path in payload.get("output_files", [])[:30]])
    if payload.get("stderr"):
        lines.extend(["", "## Stderr", "", "```", payload.get("stderr", ""), "```"])
    return "\n".join(lines) + "\n"


def bounded_text(value: str, limit: int) -> str:
    value = value or ""
    return value if len(value) <= limit else value[:limit] + "..."



def approved_placement_qfo_queries(qfo_queries_file: str, qfo_analysis: dict[str, Any]) -> list[str]:
    """Accept explicit user QFO or only approved QFO content-plan rows."""
    values: list[str] = []
    path = Path(qfo_queries_file) if qfo_queries_file else None
    if path and path.exists():
        if path.suffix.lower() == ".csv":
            for row in read_csv(path):
                status = str(row.get("approval_status") or row.get("status") or "").strip().lower()
                if status not in {"approved", "externally_approved"}:
                    continue
                for field in ["query", "qfo_query", "semantic_title", "included_queries", "included_titles"]:
                    for value in re.split(r"\s+\|\s+|[\n;]+", str(row.get(field) or "")):
                        if normalize_ws(value):
                            values.append(normalize_ws(value))
        else:
            values.extend(read_query_file(str(path)))
    if values:
        return dedupe_queries(values)
    content_plan = qfo_analysis.get("content_plan", []) if isinstance(qfo_analysis, dict) else []
    if not isinstance(content_plan, list):
        return []
    for row in content_plan:
        if not isinstance(row, dict):
            continue
        status = str(row.get("approval_status") or row.get("status") or "").strip().lower()
        if status not in {"approved", "externally_approved"}:
            continue
        for field in ["included_queries", "included_titles", "target_title"]:
            for value in re.split(r"\s+\|\s+|[\n;]+", str(row.get(field) or "")):
                if normalize_ws(value):
                    values.append(normalize_ws(value))
    return dedupe_queries(values)


def find_placements(
    project_dir: Path,
    topic: str = "",
    cluster_name: str = "",
    queries: str = "",
    queries_file: str = "",
    product: str = "",
    target_action: str = "",
    geo: str = "",
    language: str = "",
    serp_urls: str = "",
    ai_urls: str = "",
    qfo_queries: str = "",
    qfo_queries_file: str = "",
    allowed_platforms: str = "",
    max_ideas: int = 30,
) -> dict[str, Any]:
    root = find_project_root(project_dir)
    ensure_dirs(root)
    config = load_config(root)
    workflow_gate = full_workflow_prerequisite_gate(root)
    if workflow_gate.get("status") != "pass":
        return observation("blocked", "Product placement opportunities require completed project context and audit gates.", items=[workflow_gate], next_valid_actions=workflow_gate.get("next_valid_actions", []))
    topic = repair_text_encoding(cluster_name or topic or (config.get("project", {}).get("priority_topics", [""]) or [""])[0])
    if not topic:
        return observation("blocked", "Topic or cluster name is required for product placement opportunities.", next_valid_actions=["provide_cluster_name", "run_topic_workflow"])
    topic_slug = slugify(topic)
    product = repair_text_encoding(product or ", ".join(config.get("project", {}).get("products_services", [])) or config.get("project", {}).get("brand", ""))
    target_action = repair_text_encoding(target_action or config.get("project", {}).get("target_goal", ""))
    geo = repair_text_encoding(geo or config.get("region", {}).get("city", "") or config.get("region", {}).get("country", ""))
    language = repair_text_encoding(language or config.get("region", {}).get("language", ""))

    cluster_queries = dedupe_queries(split_csv(queries) + read_query_file(queries_file))
    fanout_rows = read_csv(root / PROCESSED_REL / f"{topic_slug}_fanout_queries.csv")
    if not cluster_queries:
        cluster_queries = configured_semantic_cluster_queries(config, topic) or project_context_semantic_cluster_queries(root, topic)
    if not cluster_queries:
        cluster_queries = dedupe_queries([row.get("source_query", "") for row in fanout_rows if row.get("source_query")])
    if not cluster_queries:
        return observation("blocked", "Product placement opportunities require semantic cluster queries for this topic.", next_valid_actions=["provide_cluster_queries", "run_init_project_with_cluster", "rerun_find_placements_with_queries"])

    qfo_json = read_json(root / PROCESSED_REL / f"{topic_slug}_qfo_analysis.json", {})
    # Pending QFO research is not placement evidence. Direct --qfo-queries is explicit user input.
    qfo_query_values = dedupe_queries(split_csv(qfo_queries) + approved_placement_qfo_queries(qfo_queries_file, qfo_json))

    analysis = read_json(root / PROCESSED_REL / f"{topic_slug}_serp_ai_analysis.json", {})
    serp_url_values = split_csv(serp_urls)
    ai_url_values = split_csv(ai_urls)
    if not serp_url_values:
        serp_rows = read_csv(root / PROCESSED_REL / f"{topic_slug}_serp_rows.csv")
        serp_url_values = [row.get("url", "") for row in serp_rows if row.get("url")]
    if not ai_url_values:
        ai_rows = read_csv(root / PROCESSED_REL / f"{topic_slug}_ai_answers.csv")
        ai_url_values = [row.get("citation_url", "") for row in ai_rows if row.get("citation_url")]
    platform_values = split_csv(allowed_platforms)
    max_ideas = max(1, min(30, int(max_ideas or 30)))

    rows = build_placement_rows(
        topic,
        analysis,
        cluster_queries=cluster_queries,
        product=product,
        target_action=target_action,
        geo=geo,
        language=language,
        qfo_queries=qfo_query_values,
        allowed_platforms=platform_values,
        serp_urls=serp_url_values,
        ai_urls=ai_url_values,
        max_ideas=max_ideas,
    )
    csv_path = root / PROCESSED_REL / f"{topic_slug}_placement_opportunities.csv"
    write_csv(csv_path, rows)
    summary_path = root / QUALITY_REL / f"{topic_slug}_placement_opportunities_summary.json"
    summary = {
        "topic": topic,
        "topic_slug": topic_slug,
        "product": product,
        "target_action": target_action,
        "geo": geo,
        "language": language,
        "cluster_query_count": len(cluster_queries),
        "qfo_query_count": len(qfo_query_values),
        "qfo_evidence_policy": "explicit_user_input_or_approved_content_plan_only",
        "serp_url_count": len(serp_url_values),
        "ai_url_count": len(ai_url_values),
        "allowed_platform_count": len(platform_values),
        "ideas": len(rows),
        "enter_existing": sum(1 for row in rows if row.get("strategy_type") == "enter_existing"),
        "create_owned": sum(1 for row in rows if row.get("strategy_type") == "create_owned"),
        "blocked_or_downgraded": sum(1 for row in rows if row.get("quality_status") != "pass"),
        "score_formula": {"product_fit": 40, "qfo_ai_serp_strength": 30, "platform_domain_value": 20, "feasibility": 10},
        "quality_gate": ["natural product fit", "not only domain popularity", "language/GEO fit", "plausible AI signal", "no invented published URL", "no duplicate angle"],
        "generated_at": utc_now(),
    }
    write_json(summary_path, summary)
    report_path = root / REPORTS_REL / "PLACEMENT_STRATEGY.md"
    write_text(report_path, build_placement_report(topic, rows, analysis, summary))
    update_state(root, f"Product placement opportunities refreshed for {topic}", [str(report_path), str(csv_path)])
    return observation(
        "success" if rows and rows[0].get("strategy_type") != "blocked" else "blocked",
        "Product placement opportunities created." if rows and rows[0].get("strategy_type") != "blocked" else "No product placement opportunities passed the quality gate.",
        items=[{"topic": topic, "ideas": len(rows), "enter_existing": summary["enter_existing"], "create_owned": summary["create_owned"], "downgraded": summary["blocked_or_downgraded"]}],
        evidence_refs=[str(csv_path), str(report_path), str(summary_path)],
        next_valid_actions=["review_opportunities", "enrich_urls", "import_more_citation_evidence"],
    )

def monitor_plan(project_dir: Path, topic: str = "", goal: str = "both") -> dict[str, Any]:
    root = find_project_root(project_dir)
    config = load_config(root)
    workflow_gate = full_workflow_prerequisite_gate(root)
    if workflow_gate.get("status") != "pass":
        return observation("blocked", "Monitoring plan requires completed project context and audit gates.", items=[workflow_gate], next_valid_actions=workflow_gate.get("next_valid_actions", []))
    topic = topic or (config.get("project", {}).get("priority_topics", [""]) or [""])[0]
    if not topic:
        return observation("blocked", "Topic is required for monitoring plan.", next_valid_actions=["run_topic_workflow"])
    topic_slug = slugify(topic)
    cluster_queries = configured_semantic_cluster_queries(config, topic) or project_context_semantic_cluster_queries(root, topic)
    if not cluster_queries:
        return observation("blocked", "Monitoring plan requires semantic cluster queries for this topic.", next_valid_actions=["provide_cluster_queries", "run_init_project_with_cluster"])
    fanout = read_csv(root / PROCESSED_REL / f"{topic_slug}_fanout_queries.csv")
    if not fanout:
        fanout = build_fanout(topic, cluster_queries, language=config.get("region", {}).get("language", "ru"))
    rows = build_monitoring_rows(topic, cluster_queries, fanout, goal or config.get("project", {}).get("target_goal", "both"), brand_variants_from_config(config))
    csv_path = root / PROCESSED_REL / f"{topic_slug}_monitoring_prompts.csv"
    write_csv(csv_path, rows)
    report_path = root / REPORTS_REL / "MONITORING_PLAN.md"
    write_text(report_path, build_monitoring_report(topic, rows, goal))
    update_state(root, f"Monitoring plan refreshed for {topic}", [str(report_path)])
    return observation(
        "success",
        "Monitoring plan created.",
        items=[{"topic": topic, "prompts": len(rows)}],
        evidence_refs=[str(csv_path), str(report_path)],
        next_valid_actions=["schedule_manual_monitoring", "run_same_prompts_after_page_updates"],
    )


def build_fanout_report(topic: str, rows: list[dict[str, Any]]) -> str:
    lines = [
        "# FANOUT_MAP",
        "",
        f"Generated: {utc_now()}",
        f"Topic: {topic}",
        "",
        "| Branch | Priority | Query | Source |",
        "| --- | --- | --- | --- |",
    ]
    for row in rows:
        lines.append(f"| {row['branch']} | {row['priority']} | {escape_md(row['fanout_query'])} | {escape_md(row['source_query'])} |")
    lines.extend([
        "",
        "## Quality Notes",
        "",
        "- These are draft fan-out hypotheses until validated by SERP, AI-answer, or demand evidence.",
        "- Do not create separate pages before checking intent overlap.",
    ])
    return "\n".join(lines) + "\n"


def build_serp_ai_report(topic: str, analysis: dict[str, Any]) -> str:
    split = analysis.get("retrieval_citation_brand_split", {})
    lines = [
        "# SERP_AI_ANALYSIS",
        "",
        f"Generated: {utc_now()}",
        f"Topic: {topic}",
        "",
        "## Signal Split",
        "",
        f"- Ordinary SERP project presence: {split.get('ordinary_serp_presence', 0)}",
        f"- Final citation-source project presence: {split.get('final_citation_source_presence', 0)}",
        f"- Answer-body brand mentions: {split.get('answer_body_brand_mentions', 0)}",
        "",
        "## Top Domains",
        "",
    ]
    lines.extend([f"- {x['value']}: {x['count']}" for x in analysis.get("top_domains", [])[:20]] or ["- none"])
    lines.extend(["", "## Cited URLs", ""])
    lines.extend([f"- {x['value']}: {x['count']}" for x in analysis.get("cited_urls", [])[:20]] or ["- none"])
    lines.extend(["", "## Title Term Patterns", ""])
    lines.extend([f"- {x['value']}: {x['count']}" for x in analysis.get("title_term_patterns", [])[:20]] or ["- none"])
    lines.extend(["", "## Limitations", ""])
    lines.extend([f"- {x}" for x in analysis.get("limitations", [])])
    return "\n".join(lines) + "\n"


def build_content_plan_report(topic: str, rows: list[dict[str, Any]]) -> str:
    lines = [
        "# CONTENT_PLAN",
        "",
        f"Generated: {utc_now()}",
        f"Topic: {topic}",
        "",
        "| ID | Priority | Action | Intent | Topic | Recommendation |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for row in rows:
        lines.append(
            f"| {row['item_id']} | {row['priority']} | {row['action']} | {row['intent']} | "
            f"{escape_md(row['topic'])} | {escape_md(row['recommendation'])} |"
        )
    lines.extend([
        "",
        "## Guardrails",
        "",
        "- Add tables only when they help the answer.",
        "- Add schema only when it matches the real page type and content.",
        "- Create separate QFO pages only for materially different user tasks.",
    ])
    return "\n".join(lines) + "\n"


def build_tz_handoff_report(handoff_path: Path, config: dict[str, Any], handoff: dict[str, Any]) -> str:
    generators = config.get("discovery", {}).get("semantic_tz_generators", [])
    root = handoff_path.parents[3] if len(handoff_path.parents) >= 4 else Path.cwd()
    return f"""# TZ_HANDOFF_REPORT

Generated: {utc_now()}

## Handoff

- JSON: {portable_ref(root, handoff_path)}
- Topic: {handoff.get('topic', 'unknown')}
- Generator invoked: {handoff.get('generator_invoked', False)}
- Existing generator candidates: {format_list(generators)}

## Included Evidence

- Fan-out queries: {len(handoff.get('fanout_queries', []))}
- SERP rows: {len(handoff.get('serp_rows', []))}
- AI answer rows: {len(handoff.get('ai_answer_rows', []))}
- Content plan items: {len(handoff.get('content_plan', []))}

## Boundary

This report is a handoff to the semantic SEO TZ generator. It is not a generated TZ unless a discovered generator was actually invoked and its output artifact exists.
"""



def build_placement_report(topic: str, rows: list[dict[str, Any]], analysis: dict[str, Any], summary: dict[str, Any] | None = None) -> str:
    summary = summary or {}
    first = rows[0] if rows else {}
    lines = [
        "# PLACEMENT_STRATEGY",
        "",
        f"Generated: {utc_now()}",
        f"Cluster/topic: {topic}",
        f"Product: {summary.get('product') or first.get('product', 'not provided')}",
        f"Target action: {summary.get('target_action', '')}",
        f"GEO/language: {summary.get('geo', '')} / {summary.get('language', '')}",
        "",
        "## Cluster Intent",
        "",
        f"- Main intent: {first.get('intent', 'unknown')}",
        f"- Subintents: {first.get('subintents', '') or 'none'}",
        f"- User stage: {first.get('user_stage', 'unknown')}",
        f"- Commercial motive: {first.get('commercial_motive', False)}",
        "",
        "## Evidence Summary",
        "",
        f"- Cluster queries: {summary.get('cluster_query_count', 0)}",
        f"- QFO/fan-out queries: {summary.get('qfo_query_count', 0)}",
        f"- SERP URLs: {summary.get('serp_url_count', 0)}",
        f"- AI citation/source URLs: {summary.get('ai_url_count', 0)}",
        f"- Ideas: {len(rows)}",
        f"- enter_existing: {summary.get('enter_existing', sum(1 for row in rows if row.get('strategy_type') == 'enter_existing'))}",
        f"- create_owned: {summary.get('create_owned', sum(1 for row in rows if row.get('strategy_type') == 'create_owned'))}",
        "",
        "## Scoring Formula",
        "",
        "- Product fit: 0-40",
        "- QFO/AI/SERP strength: 0-30",
        "- Platform/domain value: 0-20",
        "- Feasibility: 0-10",
        "",
        "## Ideas",
        "",
        "| ID | Score | Strategy | Platform/domain | Format | Angle | User need | Expected AI signal | Evidence | Effort | Risk/limitation |",
        "| --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for row in rows:
        score = row.get("priority_score", 0)
        lines.append(
            f"| {row.get('opportunity_id', '')} | {score}/100 | {escape_md(row.get('strategy_type', ''))} | "
            f"{escape_md(row.get('platform_or_domain', ''))} | {escape_md(row.get('content_format', ''))} | "
            f"{escape_md(bounded_text(row.get('placement_angle', ''), 180))} | {escape_md(bounded_text(row.get('why_user_would_need_product', ''), 140))} | "
            f"{escape_md(bounded_text(row.get('expected_ai_signal', ''), 130))} | {escape_md(bounded_text(row.get('evidence', ''), 150))} | "
            f"{escape_md(row.get('effort', ''))} | {escape_md(bounded_text(row.get('risk_or_limitation', ''), 160))} |"
        )
    lines.extend([
        "",
        "## Quality Gate",
        "",
        "- Downgrade or remove ideas where the product is inserted artificially.",
        "- Do not use a platform only because the domain is popular.",
        "- Check language and GEO fit before outreach or publishing.",
        "- The format must plausibly create an AI signal: brand in answer, URL as source, product mention, or comparison inclusion.",
        "- Do not invent a published URL for `create_owned`; create-owned rows describe assets to publish.",
        "- Duplicate angles without a new user problem are blocked.",
        "",
        "## Source Signal Boundary",
        "",
        "- `enter_existing` rows are based on cited/SERP-visible URLs or domains when evidence is available.",
        "- `create_owned` rows are external asset ideas, not claims that a URL already exists.",
        "- Draft only; no outreach, payment, publishing, or account action is performed by this agent.",
    ])
    return "\n".join(lines) + "\n"

def build_monitoring_report(topic: str, rows: list[dict[str, Any]], goal: str) -> str:
    lines = [
        "# MONITORING_PLAN",
        "",
        f"Generated: {utc_now()}",
        f"Topic: {topic}",
        f"Goal: {goal}",
        "",
        "## Two-Layer Monitoring",
        "",
        "Each prompt is tracked twice: `url_citation` checks whether the user URL/domain is cited; `brand_mention` checks whether approved brand/product aliases appear in the AI answer body.",
        "",
        "| Prompt ID | Layer | Prompt | Frequency | KPI | Brand Variants |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for row in rows:
        lines.append(
            f"| {row['prompt_id']} | {escape_md(row.get('monitoring_layer', ''))} | {escape_md(row['prompt'])} | {row['frequency']} | "
            f"{escape_md(row.get('kpi', ''))} | {escape_md(row.get('brand_variants_tracked', ''))} |"
        )
    lines.extend([
        "",
        "## Measurement Notes",
        "",
        "- Keep target GEO and user/search GEO explicit.",
        "- Repeat the same prompt slices after content or placement updates.",
        "- Evaluate URL citation and brand mention independently; do not merge them into one visibility score.",
        "- Brand mention must be checked against confirmed brand variants in the AI answer body.",
        "- One answer is not proof; look for repeated signals across prompts, dates, regions, and systems.",
    ])
    return "\n".join(lines) + "\n"


def write_stage_gates(root: Path, topic_slug: str, evidence: dict[str, str], lower_assurance: bool) -> None:
    required = [
        ("adaptation", root / REPORTS_REL / "ADAPTATION_REPORT.md"),
        ("project_context", root / REPORTS_REL / "PROJECT_CONTEXT.md"),
        ("accessibility", root / REPORTS_REL / "ACCESSIBILITY_AUDIT.md"),
    ]
    required.extend((stage, Path(ref)) for stage, ref in evidence.items())
    rows = []
    for stage, ref_path in required:
        exists = ref_path.exists()
        rows.append({
            "stage": stage,
            "required_by_scope": True,
            "input_universe_count": 1,
            "processed_count": 1 if exists else 0,
            "status": "done" if exists else "blocked",
            "quality_verdict": "pass" if exists else "fail",
            "evidence_refs": [portable_ref(root, ref_path)] if exists else [],
            "next_valid_action": "review_report" if exists else f"create_{stage}_artifact",
            "human_visible_note": "lower-assurance due missing provider evidence" if lower_assurance and stage == "serp_ai_analysis" else "",
        })
    completed_count = sum(1 for _, ref in required if ref.exists())
    final_guard_pass = completed_count == len(required) and not lower_assurance
    rows.append({
        "stage": "final_claim_guard",
        "required_by_scope": True,
        "input_universe_count": len(required),
        "processed_count": completed_count,
        "status": "done" if final_guard_pass else "blocked",
        "quality_verdict": "pass" if final_guard_pass else "fail",
        "evidence_refs": [portable_ref(root, ref) for _, ref in required if ref.exists()],
        "next_valid_action": "run_completion_audit_then_final_evidence_audit" if final_guard_pass else "complete_missing_or_lower_assurance_evidence",
        "human_visible_note": "Offline stage files alone do not prove completion; lower-assurance or missing evidence keeps the final claim blocked.",
    })
    write_json(root / DATA_REL / "quality-gates" / f"{topic_slug}_stage_quality_gates.json", rows)


def update_state(
    root: Path,
    action: str,
    evidence_refs: list[str],
    status: str = "completed",
    blockers: list[str] | None = None,
    next_valid_actions: list[str] | None = None,
) -> None:
    state_path = runtime_state_path(root)
    blockers = blockers if blockers is not None else ["not evaluated by this action; inspect the latest structured CLI observation"]
    next_valid_actions = next_valid_actions or ["review the latest structured CLI observation before starting another stage"]
    text = f"""# STATE

Last action: {action}

Updated: {utc_now()}

Last action status: {status}

Blockers:
{markdown_list(blockers)}

Evidence refs:
{markdown_list([portable_ref(root, ref) for ref in evidence_refs])}

Next valid actions:
{markdown_list(next_valid_actions)}
"""
    write_text(state_path, text)


def observation(
    status: str,
    summary: str,
    items: list[Any] | None = None,
    evidence_refs: list[str] | None = None,
    next_valid_actions: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "status": status,
        "summary": summary,
        "items": items or [],
        "evidence_refs": evidence_refs or [],
        "next_valid_actions": next_valid_actions or [],
    }
