from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CREDENTIAL_KEYS = {
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
}


def copy_file(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    root.mkdir()
    shutil.copytree(
        REPO / ".geo-topic-agent-runtime",
        root / ".geo-topic-agent-runtime",
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    for relative in (
        "scripts/geo_agent_launcher.py",
        "geo_agent/PROJECT_PROFILE.md",
        "geo_agent/config/geo_agent_config.json",
        "AGENTS.md",
        "CLAUDE.md",
        "package.json",
    ):
        copy_file(REPO / relative, root / relative)

    # Sentinels represent tracked shared artifacts. Launcher-driven setup must
    # not touch them; provider-audit may only change copies in this tmp project.
    (root / "geo_agent" / "reports").mkdir(parents=True, exist_ok=True)
    (root / "geo_agent" / "data" / "processed").mkdir(parents=True, exist_ok=True)
    (root / "geo_agent" / "reports" / "PROVIDER_AUDIT.md").write_text("tracked-report-sentinel\n", encoding="utf-8")
    (root / "geo_agent" / "data" / "processed" / "provider_audit.json").write_text(
        '{"sentinel": true}\n', encoding="utf-8"
    )
    return root


def run_launcher(project: Path, runtime: str, *args: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    for key in CREDENTIAL_KEYS | {"GEO_AGENT_RUNTIME", "GEO_AGENT_RUNTIME_LOCAL_ROOT"}:
        env.pop(key, None)
    launcher = project / "scripts" / "geo_agent_launcher.py"
    return subprocess.run(
        [sys.executable, str(launcher), "--runtime", runtime, *args],
        cwd=project,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        check=False,
    )


def test_launcher_resolves_same_canonical_runtime_for_codex_and_claude(project: Path) -> None:
    runtime_cli = project / ".geo-topic-agent-runtime" / "geo_agent_cli.py"
    assert runtime_cli.is_file()
    codex = run_launcher(project, "codex", "--", "--help")
    claude = run_launcher(project, "claude", "--", "--help")
    assert codex.returncode == 0
    assert claude.returncode == 0
    assert "One-topic GEO/AEO workflow agent" in codex.stdout
    assert "One-topic GEO/AEO workflow agent" in claude.stdout


def test_shared_project_profile_is_single_source(project: Path) -> None:
    profile = (project / "geo_agent" / "PROJECT_PROFILE.md").read_text(encoding="utf-8")
    config = json.loads((project / "geo_agent" / "config" / "geo_agent_config.json").read_text(encoding="utf-8"))
    assert "Vladimir Vishar" in profile
    assert "No Regrets Studios" in profile
    assert config["project"]["domain"] == "https://vishartattoo.com/"
    assert "vishar tattoo" in [value.lower() for value in config["project"]["brand_variants"]]


def test_setup_is_runtime_local_and_does_not_rewrite_shared_files(project: Path) -> None:
    shared_config = project / "geo_agent" / "config" / "geo_agent_config.json"
    tracked_report = project / "geo_agent" / "reports" / "PROVIDER_AUDIT.md"
    tracked_json = project / "geo_agent" / "data" / "processed" / "provider_audit.json"
    before = {
        "config": shared_config.read_bytes(),
        "report": tracked_report.read_bytes(),
        "json": tracked_json.read_bytes(),
    }

    codex = run_launcher(project, "codex", "setup", "--project-dir", ".")
    claude = run_launcher(project, "claude", "setup", "--project-dir=.")
    assert codex.returncode == 0, codex.stderr
    assert claude.returncode == 0, claude.stderr

    assert shared_config.read_bytes() == before["config"]
    assert tracked_report.read_bytes() == before["report"]
    assert tracked_json.read_bytes() == before["json"]

    for runtime in ("codex", "claude"):
        local_root = project / ".geo-agent-local" / runtime
        profile_path = local_root / "runtime" / "runtime-profile.json"
        plan_path = local_root / "runtime" / "birth-plan.json"
        state_path = local_root / "STATE.md"
        report_path = local_root / "setup-project" / "geo_agent" / "reports" / "ADAPTATION_REPORT.md"
        assert profile_path.is_file()
        assert plan_path.is_file()
        assert state_path.is_file()
        assert report_path.is_file()
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
        assert profile["active_runtime"] == runtime

    claude_profile = (project / ".geo-agent-local" / "claude" / "runtime" / "runtime-profile.json").read_bytes()
    rerun_codex = run_launcher(project, "codex", "setup", "--project-dir", ".")
    assert rerun_codex.returncode == 0, rerun_codex.stderr
    assert (project / ".geo-agent-local" / "claude" / "runtime" / "runtime-profile.json").read_bytes() == claude_profile


def test_runtime_local_state_roots_are_isolated_for_harmless_audit(project: Path) -> None:
    codex = run_launcher(project, "codex", "provider-audit", "--project-dir", ".")
    claude = run_launcher(project, "claude", "provider-audit", "--project-dir", ".")
    assert codex.returncode == 0, codex.stderr
    assert claude.returncode == 0, claude.stderr
    codex_state = project / ".geo-agent-local" / "codex" / "STATE.md"
    claude_state = project / ".geo-agent-local" / "claude" / "STATE.md"
    assert codex_state.is_file()
    assert claude_state.is_file()
    assert codex_state != claude_state
    assert "Provider audit completed" in codex_state.read_text(encoding="utf-8")
    assert "Provider audit completed" in claude_state.read_text(encoding="utf-8")


def test_setup_runtime_argument_validation(project: Path) -> None:
    matching_pair = run_launcher(project, "claude", "setup", "--project-dir", ".", "--runtime", "claude")
    matching_equals = run_launcher(project, "claude", "setup", "--project-dir", ".", "--runtime=claude")
    conflict = run_launcher(project, "codex", "setup", "--project-dir", ".", "--runtime", "claude")
    conflict_equals = run_launcher(project, "codex", "setup", "--project-dir", ".", "--runtime=claude")
    assert matching_pair.returncode == 0, matching_pair.stderr
    assert matching_equals.returncode == 0, matching_equals.stderr
    assert conflict.returncode == 2
    assert conflict_equals.returncode == 2
    assert "conflicts" in conflict.stderr
    assert "conflicts" in conflict_equals.stderr


def test_missing_command_after_separator_is_rejected(project: Path) -> None:
    result = run_launcher(project, "codex", "--")
    assert result.returncode == 2
    assert "missing GEO agent command" in result.stderr


def test_no_secrets_or_paid_network_flags_in_help(project: Path) -> None:
    result = run_launcher(project, "codex", "collect-serp", "--help")
    assert result.returncode == 0
    combined = result.stdout + result.stderr
    assert "XMLRIVER_API_KEY=" not in combined
    assert "XMLRIVER_USER=" not in combined
    assert "XMLRIVER_KEY=" not in combined
    assert "--network-approved" in combined
    assert "--paid-approved" in combined
